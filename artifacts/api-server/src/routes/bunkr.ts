import { Router, type IRouter } from "express";
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import * as cheerio from "cheerio";
import { resolveUrl, resolveDownload, CDN_HEADERS, type BunkrFile } from "../lib/bunkr.js";
import { ResolveUrlBody, CreateJobBody, GetJobParams } from "@workspace/api-zod";
import { logger } from "../lib/logger.js";
import { pool } from "@workspace/db";

// ─── balbums.st search scraper ───────────────────────────────────────────────
// Note: the site was previously known as "bunkr-albums.io" and redirects there
// under the hood; the live domain is balbums.st (NOT "balalbums.st").

interface SearchItem {
  title: string;
  url: string;
  thumbnailUrl: string | null;
  totalFiles: number | null;
  source: string;
}

async function searchBalalbums(query: string, mode = "broad", page = 1): Promise<SearchItem[]> {
  const searchUrl = `https://balbums.st/?search=${encodeURIComponent(query)}&mode=${encodeURIComponent(mode)}&page=${page}`;
  const html = await fetch(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html",
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`balbums.st returned ${r.status}`);
    return r.text();
  });

  const $ = cheerio.load(html);
  const results: SearchItem[] = [];

  $("a.card[href^='https://bunkr.'][target='_blank']").each((_, el) => {
    const $card = $(el);
    const href = $card.attr("href");
    if (!href || !href.includes("/a/")) return;

    // Real thumbnail is the second <img> (first is a placeholder svg icon)
    const thumb = $card.find("img.thumb-img").first().attr("src") ?? null;

    const title =
      $card.find("h3").first().text().trim() ||
      $card.find("img.thumb-img").first().attr("alt")?.trim() ||
      href.split("/a/").pop() ||
      "Unknown";

    const filesText = $card.find("span").filter((_, s) => /files?$/i.test($(s).text().trim())).first().text().trim();
    const filesMatch = filesText.match(/(\d+)/);
    const totalFiles = filesMatch ? parseInt(filesMatch[1], 10) : null;

    results.push({
      title,
      url: href,
      thumbnailUrl: thumb,
      totalFiles,
      source: "balbums.st",
    });
  });

  return results;
}

// archiver has no bundled TS types — minimal interface for what we use
type ArchiverInstance = {
  pipe: (dest: NodeJS.WritableStream) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  append: (src: any, opts: { name: string }) => ArchiverInstance;
  finalize: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => ArchiverInstance;
  once: (event: string, cb: (...args: unknown[]) => void) => ArchiverInstance;
};
type ArchiverFactory = (format: string, options?: object) => ArchiverInstance;

async function getArchiver(): Promise<ArchiverFactory> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((await import("archiver")) as any).default as ArchiverFactory;
}

const router: IRouter = Router();

interface Job {
  id: string;
  status: "pending" | "processing" | "done" | "error";
  totalFiles: number;
  processedFiles: number;
  archiveName: string;
  error: string | null;
  downloadUrl: string | null;
  zipPath: string | null;
  files: BunkrFile[];
  sseClients: Set<NodeJS.WritableStream>;
}

const jobs = new Map<string, Job>();

function sendSseEvent(job: Job, eventName: string, data: unknown): void {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of job.sseClients) {
    try {
      client.write(payload);
    } catch {
      job.sseClients.delete(client);
    }
  }
}

async function processJob(job: Job): Promise<void> {
  const createArchiver = await getArchiver();

  job.status = "processing";
  sendSseEvent(job, "progress", {
    processedFiles: 0,
    totalFiles: job.totalFiles,
    status: "processing",
  });

  const tmpDir = os.tmpdir();
  const zipPath = path.join(tmpDir, `bunkr-${job.id}.zip`);
  job.zipPath = zipPath;

  const output = fs.createWriteStream(zipPath);
  const archive = createArchiver("zip", { zlib: { level: 6 } });

  const archiveFinished = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
  });

  archive.pipe(output);

  for (const file of job.files) {
    try {
      const { cdnUrl, filename } = await resolveDownload(file.url);
      const res = await fetch(cdnUrl, { headers: CDN_HEADERS });

      if (!res.ok || !res.body) {
        logger.warn({ url: file.url, status: res.status }, "Failed to fetch file for ZIP");
      } else {
        archive.append(res.body, { name: filename });
        // Wait briefly to let archiver process the entry before next fetch
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    } catch (err) {
      logger.warn({ err, url: file.url }, "Error processing file for ZIP");
    }

    job.processedFiles++;
    sendSseEvent(job, "progress", {
      processedFiles: job.processedFiles,
      totalFiles: job.totalFiles,
      status: "processing",
    });
  }

  archive.finalize();
  await archiveFinished;

  job.status = "done";
  job.downloadUrl = `/api/jobs/${job.id}/download`;
  sendSseEvent(job, "progress", {
    processedFiles: job.totalFiles,
    totalFiles: job.totalFiles,
    status: "done",
    downloadUrl: job.downloadUrl,
  });

  for (const client of job.sseClients) {
    try { client.end(); } catch {}
  }
  job.sseClients.clear();

  // Auto-cleanup after 30 minutes
  setTimeout(() => {
    try { if (job.zipPath) fs.unlinkSync(job.zipPath); } catch {}
    jobs.delete(job.id);
  }, 30 * 60 * 1000);
}

// POST /resolve (with DB cache)
router.post("/resolve", async (req, res): Promise<void> => {
  const parsed = ResolveUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { url } = parsed.data;
  req.log.info({ url }, "Resolving Bunkr URL");

  // Try DB cache
  try {
    const cached = await pool.query(
      "SELECT album_name, total_files, files FROM resolved_albums WHERE url = $1 LIMIT 1",
      [url],
    );
    if (cached.rows.length > 0) {
      const c = cached.rows[0];
      req.log.info({ url }, "Resolved from DB cache");
      res.json({ albumName: c.album_name, totalFiles: c.total_files, files: c.files });
      return;
    }
  } catch (err) {
    req.log.warn({ err }, "DB cache read failed, falling back to live resolve");
  }

  try {
    const result = await resolveUrl(url);

    // Store in DB
    try {
      await pool.query(
        "INSERT INTO resolved_albums (url, album_name, total_files, files) VALUES ($1, $2, $3, $4) ON CONFLICT (url) DO NOTHING",
        [url, result.albumName, result.totalFiles, JSON.stringify(result.files)],
      );
    } catch (err) {
      req.log.warn({ err }, "DB cache write failed");
    }

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.warn({ err, url }, "Failed to resolve URL");
    res.status(422).json({ error: message });
  }
});

// POST /search
router.post("/search", async (req, res): Promise<void> => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : null;
  const mode = typeof req.body?.mode === "string" ? req.body.mode : "broad";
  const page = typeof req.body?.page === "number" ? Math.max(1, req.body.page) : 1;

  if (!query || query.length < 2) {
    res.status(400).json({ error: "query must be at least 2 characters" });
    return;
  }

  // Try DB cache (5 min)
  try {
    const cached = await pool.query(
      "SELECT results, fetched_at FROM search_results WHERE query = $1 AND mode = $2 AND page = $3 ORDER BY fetched_at DESC LIMIT 1",
      [query, mode, page],
    );
    if (cached.rows.length > 0) {
      const c = cached.rows[0];
      const ageMs = Date.now() - new Date(c.fetched_at).getTime();
      if (ageMs < 5 * 60 * 1000) {
        res.json({ results: c.results, query, mode, page });
        return;
      }
    }
  } catch {}

  try {
    const results = await searchBalalbums(query, mode, page);

    try {
      await pool.query(
        "INSERT INTO search_results (query, mode, page, results) VALUES ($1, $2, $3, $4)",
        [query, mode, page, JSON.stringify(results)],
      );
    } catch {}

    res.json({ results, query, mode, page });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.warn({ err, query }, "Search failed");
    res.status(502).json({ error: message });
  }
});

// GET /download — proxy a single file download through the server
router.get("/download", async (req, res): Promise<void> => {
  const fileUrl = typeof req.query["url"] === "string" ? req.query["url"] : null;
  const overrideName = typeof req.query["filename"] === "string" ? req.query["filename"] : null;

  if (!fileUrl) {
    res.status(400).json({ error: "Missing url query parameter" });
    return;
  }

  req.log.info({ fileUrl }, "Proxying file download");

  try {
    const { cdnUrl, filename, contentType } = await resolveDownload(fileUrl);
    const finalName = overrideName ?? filename;

    const upstream = await fetch(cdnUrl, { headers: CDN_HEADERS });
    if (!upstream.ok) {
      res.status(502).json({ error: `Upstream returned ${upstream.status}` });
      return;
    }

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(finalName)}"`,
    );
    res.setHeader("Content-Type", contentType);

    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    if (!upstream.body) {
      res.status(502).json({ error: "No response body from upstream" });
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((r) => res.once("drain", r));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.warn({ err, fileUrl }, "Download proxy failed");
    if (!res.headersSent) res.status(500).json({ error: message });
  }
});

// POST /jobs — create a batch download job
router.post("/jobs", async (req, res): Promise<void> => {
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { files, archiveName } = parsed.data;
  if (!files || files.length === 0) {
    res.status(400).json({ error: "No files provided" });
    return;
  }

  const job: Job = {
    id: randomUUID(),
    status: "pending",
    totalFiles: files.length,
    processedFiles: 0,
    archiveName,
    error: null,
    downloadUrl: null,
    zipPath: null,
    files: files as BunkrFile[],
    sseClients: new Set(),
  };

  jobs.set(job.id, job);
  req.log.info({ jobId: job.id, fileCount: files.length }, "Created download job");

  processJob(job).catch((err) => {
    logger.error({ err, jobId: job.id }, "Job failed");
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
    sendSseEvent(job, "progress", {
      processedFiles: job.processedFiles,
      totalFiles: job.totalFiles,
      status: "error",
      error: job.error,
    });
    for (const client of job.sseClients) { try { client.end(); } catch {} }
    job.sseClients.clear();
  });

  res.status(201).json({
    id: job.id,
    status: job.status,
    totalFiles: job.totalFiles,
    processedFiles: job.processedFiles,
    archiveName: job.archiveName,
    error: null,
    downloadUrl: null,
  });
});

// GET /jobs/:jobId — get job status
router.get("/jobs/:jobId", async (req, res): Promise<void> => {
  const params = GetJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const job = jobs.get(params.data.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({
    id: job.id,
    status: job.status,
    totalFiles: job.totalFiles,
    processedFiles: job.processedFiles,
    archiveName: job.archiveName,
    error: job.error,
    downloadUrl: job.downloadUrl,
  });
});

// GET /jobs/:jobId/events — SSE progress stream
router.get("/jobs/:jobId/events", (req, res): void => {
  const raw = req.params["jobId"];
  const jobId = Array.isArray(raw) ? raw[0] : raw;

  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(
    `event: progress\ndata: ${JSON.stringify({
      processedFiles: job.processedFiles,
      totalFiles: job.totalFiles,
      status: job.status,
      downloadUrl: job.downloadUrl,
    })}\n\n`,
  );

  if (job.status === "done" || job.status === "error") {
    res.end();
    return;
  }

  job.sseClients.add(res as unknown as NodeJS.WritableStream);
  req.on("close", () => {
    job.sseClients.delete(res as unknown as NodeJS.WritableStream);
  });
});

// GET /jobs/:jobId/download — stream the finished ZIP
router.get("/jobs/:jobId/download", (req, res): void => {
  const raw = req.params["jobId"];
  const jobId = Array.isArray(raw) ? raw[0] : raw;

  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status !== "done" || !job.zipPath) {
    res.status(400).json({ error: "ZIP not ready yet" });
    return;
  }

  const safeName = job.archiveName.replace(/[^a-z0-9_\-. ]/gi, "_");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(safeName)}.zip"`,
  );
  res.setHeader("Content-Type", "application/zip");

  const stream = fs.createReadStream(job.zipPath);
  stream.pipe(res);
  stream.on("error", (err) => {
    logger.error({ err, jobId }, "Error streaming ZIP");
    if (!res.headersSent) res.status(500).end();
  });
});

export default router;
