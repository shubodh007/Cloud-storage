// CloudBox utils — formatting, escaping, toast. No dependencies.
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + " " + units[u];
}

export function formatDate(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  } catch { return "—"; }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function fileKind(mime, name) {
  const cat = fileCategory(mime, name);
  switch (cat) {
    case "image": return { label: "Image", cls: "img", short: "IMG" };
    case "pdf": return { label: "PDF", cls: "doc", short: "PDF" };
    case "document": return { label: "DOCX", cls: "doc", short: "DOC" };
    case "text": return { label: "TXT", cls: "doc", short: "TXT" };
    case "archive": return { label: "ZIP", cls: "zip", short: "ZIP" };
    default: return { label: "File", cls: "", short: "FILE" };
  }
}

// Single source of truth for file-type normalization. MIME first, extension fallback.
// Categories: pdf | image | document | text | archive | other
export function fileCategory(mime, name) {
  const n = String(name || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|svg)$/.test(n)) return "image";
  if (m.includes("word") || m.includes("officedocument") || /\.(doc|docx|odt|rtf)$/.test(n)) return "document";
  if (m.startsWith("text/") || /\.(txt|md|csv)$/.test(n)) return "text";
  if (m.includes("zip") || m.includes("compressed") || /\.(zip|rar|7z|tar|gz)$/.test(n)) return "archive";
  return "other";
}

export const CATEGORY_LABEL = { pdf: "PDF", image: "Image", document: "Document", text: "Text", archive: "Archive", other: "Other" };

// Previewable inside CloudBox without any backend: PDF, images, plain text, DOCX.
export function isDocx(mime, name) {
  const n = String(name || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  return m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || n.endsWith(".docx");
}

export function isPreviewable(mime, name) {
  const cat = fileCategory(mime, name);
  if (cat === "pdf" || cat === "image") return true;
  if (isDocx(mime, name)) return true;
  if (cat !== "text") return false;
  const n = String(name || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  return m.startsWith("text/") || /\.(txt|md|csv)$/.test(n) || m === "application/octet-stream";
}

export function formatDateTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return "—"; }
}

export function relativeTime(iso) {
  try {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 0) return "Just now";
    const min = Math.floor(diff / 60000);
    if (min < 1) return "Just now";
    if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.floor(h / 24);
    if (d === 1) return "Yesterday";
    if (d < 7) return `${d} days ago`;
    return formatDate(iso);
  } catch { return "—"; }
}

export function toast(message, type = "info", ms = 3400) {
  let root = document.getElementById("toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    root.setAttribute("aria-live", "polite");
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => { el.remove(); }, ms);
}

export function debounce(fn, ms = 120) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function sanitizeFileName(name) {
  // Keep human-readable names; strip path separators + control chars.
  return String(name || "file").split("/").pop().split("\\").pop().replace(/[\0-\x1F\x7F]/g, "").slice(0, 180) || "file";
}

// Split "report.v2.pdf" -> { base: "report.v2", ext: "pdf" }. No dot -> ext "".
export function splitName(name) {
  const s = String(name || "");
  const i = s.lastIndexOf(".");
  if (i <= 0) return { base: s || "file", ext: "" };
  return { base: s.slice(0, i) || "file", ext: s.slice(i + 1).toLowerCase() };
}

const EXT_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain", md: "text/markdown", csv: "text/csv",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  zip: "application/zip",
};

export function mimeForExt(ext) {
  return EXT_MIME[String(ext || "").toLowerCase()] || "application/octet-stream";
}

// Unique display name inside a folder: "a.pdf" -> "a (1).pdf" -> "a (2).pdf".
// existingNames: iterable of names already taken (case-insensitive).
export function uniqueDisplayName(wanted, existingNames) {
  const taken = new Set(Array.from(existingNames || []).map((n) => String(n).toLowerCase()));
  const { base, ext } = splitName(wanted);
  const suffix = ext ? `.${ext}` : "";
  let candidate = `${base}${suffix}`;
  let i = 1;
  while (taken.has(candidate.toLowerCase())) {
    i += 1;
    candidate = `${base} (${i})${suffix}`;
  }
  return candidate;
}

// Unique restore name: "a.pdf" -> "a (restored).pdf" -> "a (restored 2).pdf".
export function uniqueRestoreName(wanted, existingNames) {
  const taken = new Set(Array.from(existingNames || []).map((n) => String(n).toLowerCase()));
  const { base, ext } = splitName(wanted);
  const suffix = ext ? `.${ext}` : "";
  let candidate = `${base} (restored)${suffix}`;
  let i = 1;
  while (taken.has(candidate.toLowerCase())) {
    i += 1;
    candidate = `${base} (restored ${i})${suffix}`;
  }
  return candidate;
}

export const ALLOWED_EXT = ["pdf", "docx", "txt", "jpg", "jpeg", "png", "zip"];
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per-file app guard
export const QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GB app assumption (NOT a Supabase claim)

export function validateFile(file) {
  if (!file) return "No file selected.";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return `“${file.name}” is not allowed. Use PDF, DOCX, TXT, JPG, PNG or ZIP.`;
  if (file.size <= 0) return `“${file.name}” is empty.`;
  if (file.size > MAX_FILE_BYTES) return `“${file.name}” is ${formatBytes(file.size)} — limit is ${formatBytes(MAX_FILE_BYTES)} per file.`;
  return null;
}
