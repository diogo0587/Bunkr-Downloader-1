import * as cheerio from "cheerio";
import { logger } from "./logger.js";

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://bunkr.site/",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Cache-Control": "no-cache",
};

const CDN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://bunkr.site/",
};

export type FileType = "image" | "video" | "other";

export interface BunkrFile {
  name: string;
  url: string;
  size: number | null;
  type: FileType;
  thumbnailUrl: string | null;
  cdnUrl: string | null;
}

export interface ResolveResult {
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
const FILE_PREFIXES: Record<string, FileType> = {
  "/i/": "image",
  "/v/": "video",
};

function getFileType(pathname: string): FileType {
  for (const [prefix, type] of Object.entries(FILE_PREFIXES)) {
    if (pathname.startsWith(prefix)) return type;
  }
  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "other";
}

function isBunkrFilePathname(pathname: string): boolean {
  return ["/v/", "/i/", "/d/", "/f/", "/e/"].some((p) =>
    pathname.startsWith(p),
  );
}

export function detectUrlType(url: string): "album" | "file" | "unknown" {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/a/")) return "album";
    if (isBunkrFilePathname(parsed.pathname)) return "file";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function parseSize(text: string): number | null {
  const match = text.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };
  return Math.round(value * (multipliers[unit] ?? 1));
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: REQUEST_HEADERS,
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }
  return res.text();
}

function extractCdnUrl($: cheerio.CheerioAPI, pageUrl: string): string | null {
  const origin = new URL(pageUrl).origin;

  // <source src="..."> — video
  const src = $("source[src]").first().attr("src");
  if (src) return src;

  // <video src="...">
  const videoSrc = $("video[src]").first().attr("src");
  if (videoSrc) return videoSrc;

  // <a download href="...">
  let downloadHref: string | null = null;
  $("a[download]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && !downloadHref) downloadHref = href;
  });
  if (downloadHref) return downloadHref;

  // <a href="...cdn...">
  let cdnHref: string | null = null;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!cdnHref && /cdn\d*\./i.test(href)) cdnHref = href;
  });
  if (cdnHref) return cdnHref;

  // og:video or og:image
  const ogVideo = $('meta[property="og:video"]').attr("content");
  if (ogVideo) return ogVideo;

  // Inline <script> — look for JSON with url/src/file fields
  let scriptUrl: string | null = null;
  $("script:not([src])").each((_, el) => {
    if (scriptUrl) return;
    const text = $(el).html() ?? "";

    // JSON blob with "src", "url", or "file" key pointing to a cdn URL
    const patterns = [
      /"(?:src|url|file|download|link)"\s*:\s*"(https?:\/\/[^"]+)"/g,
      /(?:src|url|href)\s*=\s*["'](https?:\/\/cdn[^"']+)["']/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!scriptUrl) scriptUrl = m[1];
      }
    }
  });
  if (scriptUrl) return scriptUrl;

  return null;
}

function extractFileName($: cheerio.CheerioAPI, pageUrl: string): string {
  const h1 = $("h1").first().text().trim();
  if (h1) return h1;

  const ogTitle = $('meta[property="og:title"]').attr("content");
  if (ogTitle) return ogTitle.split("|")[0].trim();

  return new URL(pageUrl).pathname.split("/").pop() ?? "file";
}

async function resolveFilePage(pageUrl: string): Promise<BunkrFile> {
  const html = await fetchPage(pageUrl);
  const $ = cheerio.load(html);
  const parsed = new URL(pageUrl);

  const name = extractFileName($, pageUrl);
  const cdnUrl = extractCdnUrl($, pageUrl);
  const type = getFileType(parsed.pathname);

  let size: number | null = null;
  const sizeEl = $('[class*="size"], [class*="filesize"]').first().text().trim();
  if (sizeEl) size = parseSize(sizeEl);

  let thumbnailUrl: string | null = null;
  if (type === "image") {
    thumbnailUrl = cdnUrl ?? $('meta[property="og:image"]').attr("content") ?? null;
  } else if (type === "video") {
    thumbnailUrl = $('meta[property="og:image"]').attr("content") ?? null;
  }

  return { name, url: pageUrl, size, type, thumbnailUrl, cdnUrl };
}

async function resolveAlbumPage(albumUrl: string): Promise<ResolveResult> {
  const html = await fetchPage(albumUrl);
  const $ = cheerio.load(html);
  const base = new URL(albumUrl);

  const albumName =
    $("h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    null;

  // Collect file page URLs from album
  const seen = new Set<string>();
  const fileUrls: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    let full: string;
    try {
      full = href.startsWith("http") ? href : `${base.origin}${href}`;
      const u = new URL(full);
      if (!isBunkrFilePathname(u.pathname)) return;
      if (seen.has(full)) return;
      seen.add(full);
      fileUrls.push(full);
    } catch {
      // skip invalid
    }
  });

  // Handle pagination — detect additional pages
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
      const pageHtml = await fetchPage(pageUrl);
      const $p = cheerio.load(pageHtml);
      $p("a[href]").each((_, el) => {
        const href = $p(el).attr("href") ?? "";
        let full: string;
        try {
          full = href.startsWith("http") ? href : `${base.origin}${href}`;
          const u = new URL(full);
          if (!isBunkrFilePathname(u.pathname) || seen.has(full)) return;
          seen.add(full);
          fileUrls.push(full);
        } catch {}
      });
    } catch (err) {
      logger.warn({ err, pageUrl }, "Failed to fetch pagination page");
    }
  }

  // Build quick file list from album page metadata
  const quickMeta = new Map<string, { name: string; thumbnailUrl: string | null; size: number | null }>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    let full: string;
    try {
      full = href.startsWith("http") ? href : `${base.origin}${href}`;
      if (!fileUrls.includes(full)) return;
    } catch {
      return;
    }
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
    const size = sizeText ? parseSize(sizeText) : null;
    quickMeta.set(full, { name: nameText, thumbnailUrl: imgSrc, size });
  });

  const files: BunkrFile[] = fileUrls.map((url) => {
    const meta = quickMeta.get(url);
    const type = getFileType(new URL(url).pathname);
    return {
      name: meta?.name ?? url.split("/").pop() ?? "file",
      url,
      size: meta?.size ?? null,
      type,
      thumbnailUrl: meta?.thumbnailUrl ?? null,
      cdnUrl: null,
    };
  });

  return { albumName, totalFiles: files.length, files };
}

export async function resolveUrl(url: string): Promise<ResolveResult> {
  const kind = detectUrlType(url);
  if (kind === "album") return resolveAlbumPage(url);
  if (kind === "file") {
    const file = await resolveFilePage(url);
    return { albumName: null, totalFiles: 1, files: [file] };
  }
  throw new Error(
    "Unsupported URL. Please provide a Bunkr album URL (bunkr.*/a/*) or file URL (bunkr.*/v/*, /i/*, /d/*, etc.).",
  );
}

export async function resolveDownload(
  filePageUrl: string,
): Promise<{ cdnUrl: string; filename: string; contentType: string }> {
  const file = await resolveFilePage(filePageUrl);
  const cdnUrl = file.cdnUrl;
  if (!cdnUrl) {
    throw new Error(`Could not resolve download URL for: ${filePageUrl}`);
  }
  const filename = file.name || new URL(filePageUrl).pathname.split("/").pop() || "download";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mimeTypes: Record<string, string> = {
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp",
  };
  const contentType = mimeTypes[ext] ?? "application/octet-stream";
  return { cdnUrl, filename, contentType };
}

export { CDN_HEADERS };
