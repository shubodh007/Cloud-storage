// CloudBox preview — private-bucket blob preview for PDF / image / text / DOCX.
// Security: uses the authenticated session's storage.download(); never public URLs.
// Object URLs are revoked on close/replace to avoid memory leaks.
import { getClient } from "./supabase.js";
import { sanitizeDocxHtml } from "./docx-sanitize.js";
import { escapeHtml, fileCategory, fileKind, formatBytes, isDocx, isPreviewable, toast } from "./utils.js";

const BUCKET = "user-files";
const MAX_TEXT_BYTES = 200 * 1024;
// Pinned browser builds, lazy-loaded ONLY on first DOCX preview (never on
// listing/search/grid — ~500KB total, no cost until explicitly requested).
const MAMMOTH_URL = "https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js";
const PURIFY_URL = "https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.min.js";
const MAX_DOCX_BYTES = 15 * 1024 * 1024;
let activeUrl = null;
let docxUrls = [];
let libsPromise = null;
let activeFileId = null;
let returnFocusEl = null;

const $ = (id) => document.getElementById(id);

function revokeActive() {
  if (activeUrl) { URL.revokeObjectURL(activeUrl); activeUrl = null; }
  for (const u of docxUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
  docxUrls = [];
  activeFileId = null;
}

function setBody(html) {
  const body = $("preview-body");
  if (body) body.innerHTML = html;
}

function showLoading(message) {
  setBody(`<div class="preview-loading"><span class="spinner dark" aria-hidden="true"></span><span>${escapeHtml(message || "Loading preview…")}</span></div>`);
}

function showError(msg) {
  setBody(`<div class="state-block"><h3>Unable to preview this file</h3><p>${escapeHtml(msg)}</p></div>`);
}

function showUnsupported(file) {
  setBody(`<div class="state-block"><h3>Preview unavailable</h3><p>CloudBox can preview PDF, Word, images and text files.</p>
    <button class="btn btn-primary btn-sm" id="preview-dl" type="button">Download</button></div>`);
  $("preview-dl")?.addEventListener("click", () => void downloadPrivateFile(file));
}

function showDocxError(file) {
  setBody(`<div class="state-block"><h3>Unable to preview this Word document</h3><p>The file itself is still available.</p>
    <button class="btn btn-primary btn-sm" id="preview-dl2" type="button">Download</button></div>`);
  $("preview-dl2")?.addEventListener("click", () => void downloadPrivateFile(file));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("preview libraries failed to load"));
    document.head.appendChild(s);
  });
}

function ensureDocxLibs() {
  if (window.mammoth && window.DOMPurify) return Promise.resolve();
  if (!libsPromise) {
    libsPromise = Promise.all([loadScript(MAMMOTH_URL), loadScript(PURIFY_URL)]).then(() => {
      if (!window.mammoth?.convertToHtml || !window.DOMPurify?.sanitize) {
        throw new Error("preview libraries unavailable");
      }
    }).catch((e) => { libsPromise = null; throw e; });
  }
  return libsPromise;
}

/** Render a private DOCX blob as sanitized document HTML. Never throws to UI. */
async function renderDocx(file, blob) {
  if ((blob.size || 0) > MAX_DOCX_BYTES) {
    showDocxError(file);
    return;
  }
  showLoading("Preparing document preview…");
  try {
    await ensureDocxLibs();
  } catch (e) {
    console.error("docx libs failed", e);
    showDocxError(file);
    return;
  }
  if (activeFileId !== file.id) return; // user moved on
  let result;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    if (activeFileId !== file.id) return;
    result = await window.mammoth.convertToHtml({ arrayBuffer }, {
      convertImage: window.mammoth.images.imgElement((image) =>
        image.read("base64").then((b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: image.contentType || "image/png" }));
          docxUrls.push(url);
          return { src: url };
        }).catch(() => ({}))
      ),
    });
  } catch (e) {
    console.error("docx conversion failed", e);
    if (activeFileId === file.id) showDocxError(file);
    return;
  }
  if (activeFileId !== file.id) return;
  const html = (result?.value || "").trim();
  if (!html) { showDocxError(file); return; }
  let clean;
  try {
    clean = sanitizeDocxHtml(window.DOMPurify, html);
  } catch (e) {
    console.error("docx sanitize failed", e);
    showDocxError(file);
    return;
  }
  const body = $("preview-body");
  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "preview-doc-wrap";
  const doc = document.createElement("div");
  doc.className = "docx-doc";
  doc.innerHTML = clean; // sanitized allowlist HTML only — never raw Mammoth output
  wrap.appendChild(doc);
  if (result.messages && result.messages.length) {
    const n = document.createElement("div");
    n.className = "preview-doc-note";
    n.textContent = "Some Word formatting may not appear exactly as in Microsoft Word.";
    wrap.appendChild(n);
  }
  body.appendChild(wrap);
}

/** Download a private file through the authenticated session. No public URLs. */
export async function downloadPrivateFile(file) {
  const sb = getClient();
  if (!sb || !file) return false;
  toast(`Downloading “${file.file_name}”…`, "info", 1800);
  const { data, error } = await sb.storage.from(BUCKET).download(file.file_path);
  if (error || !data) { toast("Download failed: " + (error?.message || "unknown error"), "error"); return false; }
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url; a.download = file.file_name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

/** Open preview for a file object from the already-loaded own-metadata list. */
export async function openPreview(file) {
  const sb = getClient();
  if (!sb || !file) return;
  const modal = $("preview-modal");
  if (!modal) return;
  returnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  $("preview-title").textContent = file.file_name;
  $("preview-title").title = file.file_name;
  $("preview-meta").textContent = `${fileKind(file.file_type, file.file_name).label.toUpperCase()} · ${formatBytes(file.file_size)}`;
  modal.classList.add("open");
  revokeActive();
  activeFileId = file.id;

  if (!isPreviewable(file.file_type, file.file_name)) { showUnsupported(file); $("preview-close-x")?.focus(); return; }
  showLoading();

  try {
    const { data, error } = await sb.storage.from(BUCKET).download(file.file_path);
    if (error || !data) throw new Error(error?.message || "Download failed.");
    if (activeFileId !== file.id) return; // user moved on; drop stale result
    const url = URL.createObjectURL(data);
    activeUrl = url;
    const cat = fileCategory(file.file_type, file.file_name);
    if (cat === "pdf") {
      setBody(`<embed class="preview-pdf" src="${url}" type="application/pdf" aria-label="PDF preview of ${escapeHtml(file.file_name)}">`);
    } else if (cat === "image") {
      setBody(`<div class="preview-img-wrap"><img class="preview-img" src="${url}" alt="Preview of ${escapeHtml(file.file_name)}"></div>`);
    } else if (isDocx(file.file_type, file.file_name)) {
      await renderDocx(file, data);
    } else {
      const text = await data.text();
      const shown = text.length > MAX_TEXT_BYTES
        ? text.slice(0, MAX_TEXT_BYTES) + "\n… (truncated, file is larger)"
        : text;
      const pre = document.createElement("pre");
      pre.className = "preview-text";
      pre.textContent = shown || "(empty file)";
      $("preview-body").innerHTML = "";
      $("preview-body").appendChild(pre);
    }
  } catch (e) {
    console.error("preview failed", e);
    showError(e?.message || "Something went wrong.");
  }
  $("preview-close-x")?.focus();
}

export function closePreview() {
  revokeActive();
  $("preview-modal")?.classList.remove("open");
  setBody("");
  if (returnFocusEl && document.contains(returnFocusEl)) returnFocusEl.focus();
  returnFocusEl = null;
}

export function initPreview({ onDownloadFallback } = {}) {
  $("preview-close-x")?.addEventListener("click", closePreview);
  $("preview-close-btn")?.addEventListener("click", closePreview);
  $("preview-download-btn")?.addEventListener("click", () => {
    const id = activeFileId;
    if (id) onDownloadFallback?.(id);
  });
  $("preview-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "preview-modal") closePreview();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("preview-modal")?.classList.contains("open")) closePreview();
  });
}
