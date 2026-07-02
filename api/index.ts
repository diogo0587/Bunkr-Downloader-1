/**
 * Vercel serverless function — Bunkr Downloader API
 *
 * Self-contained Express handler:
 *   POST /api/resolve  — resolve Bunkr album or file URL to a file list
 *   GET  /api/download — proxy a single file from Bunkr CDN
 *   POST /api/zip      — stream a ZIP archive of selected files
 */
import express, { type Request, type Response } from "express";
import cors from "cors";
import * as cheerio from "cheerio";

// ─── Archiver (no bundled TypeScript types) ──────────────────────────────────

type ArchiverInstance = {
  pipe(dest: NodeJS.WritableStream): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  append(src: any, opts: { name: string }): ArchiverInstance;
  finalize(): void;
  on(event: string, cb: (...args: unknown[]) => void): ArchiverInstance;
};
type ArchiverFactory = (format: string, opts?: object) => ArchiverInstance;

let _archiverFactory: ArchiverFactory | null = null;
async function getArchiverFactory(): Promise<ArchiverFactory> {
  if (!_archiverFactory) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _archiverFactory = ((await import("archiver")) as any).default as ArchiverFactory;
  }
  return _archiverFactory;
}

// ─── Bunkr scraping ───────────────────────────────────────────────────────────

const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://bunkr.site/",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Cache-Control": "no-cache",
};

const CDN_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://bunkr.site/",
};

type FileType = "image" | "video" | "other";

interface BunkrFile {
  name: string;
  url: string;
  size: number | null;
  type: FileType;
  thumbnailUrl: string | null;
  cdnUrl: string | null;
}

interface ResolveResult {
  albumName: string | null;
  totalFiles: number;
  files: BunkrFile[];
}

const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "heic", "heif",
]);
const VIDEO_EXTS = new Set([
  "mp4", "webm", "mov", "avi", "mkv", "m4v", "ts", "flv", "wmv",
]);
const FILE_PATH_TYPES: Record<string, FileType> = { "/i/": "image", "/v/": "video" };

function getFileType(pathname: string): FileType {
  for (const [prefix, type] of Object.entries(FILE_PATH_TYPES)) {
    if (pathname.startsWith(prefix)) return type;
  }
  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "other";
}

function isBunkrFilePathname(p: string): boolean {
  return ["/v/", "/i/", "/d/", "/f/", "/e/"].some((prefix) => p.startsWith(prefix));
}

function parseSize(text: string): number | null {
  const match = text.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) return null;
  const units: Record<string, number> = {
    B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4,
  };
  return Math.round(parseFloat(match[1]) * (units[match[2].toUpperCase()] ?? 1));
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { headers: REQUEST_HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function extractCdnUrl($: cheerio.CheerioAPI): string | null {
  const src = $("source[src]").first().attr("src");
  if (src) return src;
  const videoSrc = $("video[src]").first().attr("src");
  if (videoSrc) return videoSrc;

  let dlHref: string | null = null;
  $("a[download]").each((_, el) => {
    const h = $(el).attr("href");
    if (h && !dlHref) dlHref = h;
  });
  if (dlHref) return dlHref;

  let cdnHref: string | null = null;
  $("a[href]").each((_, el) => {
    const h = $(el).attr("href") ?? "";
    if (!cdnHref && /cdn\d*\./i.test(h)) cdnHref = h;
  });
  if (cdnHref) return cdnHref;

  const ogVideo = $('meta[property="og:video"]').attr("content");
  if (ogVideo) return ogVideo;

  let scriptUrl: string | null = null;
  $("script:not([src])").each((_, el) => {
    if (scriptUrl) return;
    const text = $(el).html() ?? "";
    for (const re of [
      /"(?:src|url|file|download|link)"\s*:\s*"(https?:\/\/[^"]+)"/g,
      /(?:src|url|href)\s*=\s*["'](https?:\/\/cdn[^"']+)["']/g,
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!scriptUrl) scriptUrl = m[1];
      }
    }
  });
  return scriptUrl;
}

function extractFileName($: cheerio.CheerioAPI, pageUrl: string): string {
  const h1 = $("h1").first().text().trim();
  if (h1) return h1;
  const ogTitle = $('meta[property="og:title"]').attr("content");
  if (ogTitle) return ogTitle.split("|")[0].trim();
  return new URL(pageUrl).pathname.split("/").pop() ?? "file";
}

async function resolveFilePage(pageUrl: string): Promise<BunkrFile> {
  const $ = cheerio.load(await fetchPage(pageUrl));
  const name = extractFileName($, pageUrl);
  const cdnUrl = extractCdnUrl($);
  const type = getFileType(new URL(pageUrl).pathname);
  const sizeText = $('[class*="size"], [class*="filesize"]').first().text().trim();
  const size = sizeText ? parseSize(sizeText) : null;
  const thumbnailUrl =
    type === "image"
      ? cdnUrl ?? $('meta[property="og:image"]').attr("content") ?? null
      : type === "video"
        ? $('meta[property="og:image"]').attr("content") ?? null
        : null;
  return { name, url: pageUrl, size, type, thumbnailUrl, cdnUrl };
}

async function resolveAlbumPage(albumUrl: string): Promise<ResolveResult> {
  const $ = cheerio.load(await fetchPage(albumUrl));
  const base = new URL(albumUrl);

  const albumName =
    $("h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    null;

  const seen = new Set<string>();
  const fileUrls: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    try {
      const full = href.startsWith("http") ? href : `${base.origin}${href}`;
      const u = new URL(full);
      if (!isBunkrFilePathname(u.pathname) || seen.has(full)) return;
      seen.add(full);
      fileUrls.push(full);
    } catch {}
  });

  const extraPages = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (href.includes("page=")) {
      const full = href.startsWith("http") ? href : `${base.origin}${href}`;
      if (full !== albumUrl) extraPages.add(full);
    }
  });

  for (const pageUrl of [...extraPages].slice(0, 20)) {
    try {
      const $p = cheerio.load(await fetchPage(pageUrl));
      $p("a[href]").each((_, el) => {
        const href = $p(el).attr("href") ?? "";
        try {
          const full = href.startsWith("http") ? href : `${base.origin}${href}`;
          const u = new URL(full);
          if (!isBunkrFilePathname(u.pathname) || seen.has(full)) return;
          seen.add(full);
          fileUrls.push(full);
        } catch {}
      });
    } catch {}
  }

  const quickMeta = new Map<string, { name: string; thumbnailUrl: string | null; size: number | null }>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    try {
      const full = href.startsWith("http") ? href : `${base.origin}${href}`;
      if (!fileUrls.includes(full)) return;
      const $a = $(el);
      const parent = $a.closest("[class]");
      const imgSrc =
        parent.find("img[src]").first().attr("src") ??
        parent.find("img[data-src]").first().attr("data-src") ??
        null;
      const nameText =
        parent.find("p, span, [class*='name'], [class*='title']").first().text().trim() ||
        $a.text().trim() ||
        full.split("/").pop() ||
        "file";
      const sizeText = parent.find("[class*='size']").first().text().trim();
      quickMeta.set(full, { name: nameText, thumbnailUrl: imgSrc, size: sizeText ? parseSize(sizeText) : null });
    } catch {}
  });

  const files: BunkrFile[] = fileUrls.map((url) => {
    const meta = quickMeta.get(url);
    return {
      name: meta?.name ?? url.split("/").pop() ?? "file",
      url,
      size: meta?.size ?? null,
      type: getFileType(new URL(url).pathname),
      thumbnailUrl: meta?.thumbnailUrl ?? null,
      cdnUrl: null,
    };
  });

  return { albumName, totalFiles: files.length, files };
}

function detectUrlType(url: string): "album" | "file" | "unknown" {
  try {
    const { pathname } = new URL(url);
    if (pathname.startsWith("/a/")) return "album";
    if (isBunkrFilePathname(pathname)) return "file";
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function resolveUrl(url: string): Promise<ResolveResult> {
  const kind = detectUrlType(url);
  if (kind === "album") return resolveAlbumPage(url);
  if (kind === "file") {
    const file = await resolveFilePage(url);
    return { albumName: null, totalFiles: 1, files: [file] };
  }
  throw new Error(
    "Unsupported URL. Please provide a Bunkr album (/a/) or file URL (/v/, /i/, /d/, etc.).",
  );
}

async function resolveDownload(
  filePageUrl: string,
): Promise<{ cdnUrl: string; filename: string; contentType: string }> {
  const file = await resolveFilePage(filePageUrl);
  if (!file.cdnUrl) throw new Error(`Could not resolve CDN URL for: ${filePageUrl}`);
  const filename = file.name || new URL(filePageUrl).pathname.split("/").pop() || "download";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mimeTypes: Record<string, string> = {
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp",
  };
  return { cdnUrl: file.cdnUrl, filename, contentType: mimeTypes[ext] ?? "application/octet-stream" };
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// POST /api/resolve
app.post("/api/resolve", async (req: Request, res: Response): Promise<void> => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : null;
  if (!url) { res.status(400).json({ error: "url is required" }); return; }
  try {
    res.json(await resolveUrl(url));
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/download
app.get("/api/download", async (req: Request, res: Response): Promise<void> => {
  const fileUrl = typeof req.query["url"] === "string" ? req.query["url"] : null;
  const overrideName = typeof req.query["filename"] === "string" ? req.query["filename"] : null;
  if (!fileUrl) { res.status(400).json({ error: "Missing url" }); return; }
  try {
    const { cdnUrl, filename, contentType } = await resolveDownload(fileUrl);
    const upstream = await fetch(cdnUrl, { headers: CDN_HEADERS });
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: `Upstream ${upstream.status}` }); return;
    }
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(overrideName ?? filename)}"`);
    res.setHeader("Content-Type", contentType);
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      if (!res.write(Buffer.from(value))) await new Promise<void>((r) => res.once("drain", r));
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/zip — stream a ZIP archive of all requested files
app.post("/api/zip", async (req: Request, res: Response): Promise<void> => {
  const { files, archiveName } = req.body as {
    files?: { url: string; name?: string }[];
    archiveName?: string;
  };

  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "files array is required" }); return;
  }

  const safeName = (archiveName ?? "bunkr_download").replace(/[^a-z0-9_\-. ]/gi, "_");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeName)}.zip"`);
  res.setHeader("Cache-Control", "no-store");

  const createArchiver = await getArchiverFactory();
  const archive = createArchiver("zip", { zlib: { level: 6 } });

  archive.on("error", (err: unknown) => {
    console.error("Archive error:", err);
    if (!res.headersSent) res.status(500).json({ error: "ZIP creation failed" });
    else res.end();
  });

  archive.pipe(res as unknown as NodeJS.WritableStream);

  for (const file of files) {
    if (!file.url || typeof file.url !== "string") continue;
    try {
      const { cdnUrl, filename } = await resolveDownload(file.url);
      const upstream = await fetch(cdnUrl, { headers: CDN_HEADERS });
      if (!upstream.ok || !upstream.body) {
        console.warn(`Skipping ${file.url}: upstream ${upstream.status}`); continue;
      }
      archive.append(upstream.body, { name: file.name ?? filename });
    } catch (err) {
      console.warn(`Skipping ${file.url}:`, err);
    }
  }

  archive.finalize();
});

export default app;
