/** Extension → category maps used by previews and kind labels. */

export const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg", "bmp", "tiff", "tif", "ico", "avif",
]);

export const VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "webm"]);

export const AUDIO_EXTS = new Set(["mp3", "m4a", "wav", "aac", "flac", "ogg", "aiff", "aif"]);

export const CODE_EXTS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "jsonc",
  "rs", "py", "rb", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cc", "m", "mm",
  "cs", "php", "pl", "lua", "sh", "zsh", "bash", "fish", "ps1",
  "html", "htm", "css", "scss", "less", "vue", "svelte",
  "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env",
  "sql", "graphql", "proto", "cmake", "make", "dockerfile", "gradle",
]);

export const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "rtf", "tex", "org", "rst", "plist",
  "gitignore", "gitattributes", "editorconfig", "lock", "license", "readme",
]);

export const ARCHIVE_EXTS = new Set([
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "dmg", "iso", "pkg", "tgz",
]);

/**
 * True when Fazi can extract this file: .zip (ditto) and the tar family
 * (bsdtar). `entry.ext` for "x.tar.gz" is "gz", so the compound suffixes need
 * the name check. Lone .gz / 7z / rar / dmg stay display-only.
 */
export function isExtractableArchive(name: string, ext: string): boolean {
  if (ext === "zip" || ext === "tar" || ext === "tgz") return true;
  const lower = name.toLowerCase();
  return lower.endsWith(".tar.gz") || lower.endsWith(".tar.bz2") || lower.endsWith(".tar.xz");
}

export type PreviewMode = "image" | "video" | "audio" | "text" | "thumbnail";

export function previewModeFor(ext: string, kind: string): PreviewMode {
  if (kind === "dir") return "thumbnail";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (CODE_EXTS.has(ext) || TEXT_EXTS.has(ext)) return "text";
  return "thumbnail";
}

/** Human kind label for the Kind column, derived from ext + flags. */
const KIND_LABELS: Record<string, string> = {
  pdf: "PDF Document",
  png: "PNG Image", jpg: "JPEG Image", jpeg: "JPEG Image", gif: "GIF Image",
  webp: "WebP Image", heic: "HEIC Image", svg: "SVG Image", bmp: "BMP Image",
  tiff: "TIFF Image", tif: "TIFF Image", avif: "AVIF Image", ico: "Icon Image",
  mp4: "MPEG-4 Video", mov: "QuickTime Movie", m4v: "Video", webm: "WebM Video",
  mp3: "MP3 Audio", m4a: "Audio", wav: "WAV Audio", aac: "AAC Audio",
  flac: "FLAC Audio", ogg: "Ogg Audio", aiff: "AIFF Audio",
  txt: "Plain Text", md: "Markdown Document", rtf: "Rich Text Document",
  csv: "CSV Document", log: "Log File",
  zip: "ZIP Archive", tar: "Tar Archive", gz: "Gzip Archive", "7z": "7-Zip Archive",
  rar: "RAR Archive", dmg: "Disk Image", iso: "Disk Image", pkg: "Installer Package",
  app: "Application",
  doc: "Word Document", docx: "Word Document",
  xls: "Spreadsheet", xlsx: "Spreadsheet", numbers: "Numbers Spreadsheet",
  ppt: "Presentation", pptx: "Presentation", key: "Keynote Presentation",
  pages: "Pages Document",
  ttf: "Font", otf: "Font", woff: "Web Font", woff2: "Web Font",
};

export function kindLabel(opts: {
  kind: string;
  ext: string;
  isPackage?: boolean;
  isAlias?: boolean;
}): string {
  const { kind, ext, isPackage, isAlias } = opts;
  if (isAlias) return "Alias";
  if (kind === "symlink") return "Symbolic Link";
  if (ext === "app") return "Application";
  if (kind === "dir" && !isPackage) return "Folder";
  if (ext !== "" && KIND_LABELS[ext]) return KIND_LABELS[ext];
  if (CODE_EXTS.has(ext)) return `${ext.toUpperCase()} Source`;
  if (isPackage) return "Package";
  if (kind === "dir") return "Folder";
  if (ext !== "") return `${ext.toUpperCase()} File`;
  if (kind === "unknown") return "—";
  return "Document";
}
