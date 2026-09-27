// CloudBox dashboard — folders, files, trash, search/filter/sort, bulk ops.
// State: allFiles (active + trash, loaded once), allFolders, currentFolderId,
// trashMode (from #trash hash), selection Set. Search/sort/filter/breakdown/
// recents are local; file CONTENTS only download on preview/thumbnail/download.
// Storage + files.metadata are changed together via moveObjectWithDbSync;
// file_path always equals the real object path.
import { getClient, isConfigured, requireAuth } from "./supabase.js";
import { initUpload } from "./upload.js";
import { openPreview, closePreview, initPreview, downloadPrivateFile } from "./preview.js";
import {
  buildDir, childFolders, filesInFolder, folderChain, isRoot, listFolders,
  createFolderRow, renameFolderRow, deleteFolderRow, moveObjectWithDbSync,
  subtreeIds, validateFolderName,
} from "./folders.js";
import {
  formatBytes, formatDate, formatDateTime, relativeTime, escapeHtml, sanitizeFileName,
  fileKind, fileCategory, CATEGORY_LABEL, isPreviewable, splitName, mimeForExt,
  uniqueDisplayName, uniqueRestoreName, toast, debounce, QUOTA_BYTES,
} from "./utils.js";

const BUCKET = "user-files";
const THUMB_MAX_BYTES = 5 * 1024 * 1024;
const BULK_CONCURRENCY = 2;
const SORTS = {
  "modified-desc": "Newest first",
  "modified-asc": "Oldest first",
  "name-asc": "Name A–Z",
  "name-desc": "Name Z–A",
  "size-desc": "Largest first",
  "size-asc": "Smallest first",
  "type-asc": "Type A–Z",
  "type-desc": "Type Z–A",
};

let allFiles = [];
let allFolders = [];
let sessionUser = null;
let currentFolderId = null; // null = My Files root
let trashMode = false;
let searchQuery = "";
let typeFilter = "all";
let sortKey = "modified-desc";
let viewMode = "list";
try { viewMode = localStorage.getItem("cloudbox-view") === "grid" ? "grid" : "list"; } catch { /* private mode */ }
let selectedId = null;
let drawerReturnEl = null;
let selection = new Set();
let foldersAvailable = true;
const thumbUrls = new Map();

const $ = (id) => document.getElementById(id);
const activeFiles = () => allFiles.filter((f) => !f.deleted_at);
const trashFiles = () => allFiles.filter((f) => f.deleted_at);

function showConfig() {
  document.querySelectorAll(".config-banner").forEach((el) => el.classList.add("show"));
}

function displayName(user) {
  return user?.user_metadata?.full_name || user?.email?.split("@")[0] || "there";
}

/* ---------- view states ---------- */
function setState(name) {
  ["files-loading", "files-empty", "files-error", "files-noresults"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = true;
  });
  for (const id of ["files-table-wrap", "mobile-list", "files-grid"]) {
    const el = $(id);
    if (el) el.style.display = "none";
  }
  const map = { loading: "files-loading", empty: "files-empty", error: "files-error", noresults: "files-noresults" };
  if (map[name]) {
    const el = $(map[name]);
    if (el) el.hidden = false;
  } else {
    showActiveView();
  }
}

function showActiveView() {
  const isGrid = viewMode === "grid";
  const table = $("files-table-wrap");
  const mobile = $("mobile-list");
  const grid = $("files-grid");
  if (grid) grid.style.display = isGrid ? "" : "none";
  if (table) table.style.display = isGrid ? "none" : "";
  if (mobile) mobile.style.display = isGrid ? "none" : "";
}

/* ---------- filter + sort (local) ---------- */
function baseFiles() {
  if (trashMode) return trashFiles();
  return filesInFolder(activeFiles(), currentFolderId);
}

function visibleFiles() {
  const q = searchQuery;
  let list = baseFiles().filter((f) => {
    if (typeFilter !== "all" && fileCategory(f.file_type, f.file_name) !== typeFilter) return false;
    if (q && !f.file_name.toLowerCase().includes(q)) return false;
    return true;
  });
  const byName = (a, b) => a.file_name.localeCompare(b.file_name, undefined, { sensitivity: "base", numeric: true });
  switch (sortKey) {
    case "name-asc": list = [...list].sort(byName); break;
    case "name-desc": list = [...list].sort((a, b) => byName(b, a)); break;
    case "modified-asc": list = [...list].sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at)); break;
    case "size-desc": list = [...list].sort((a, b) => (b.file_size || 0) - (a.file_size || 0)); break;
    case "size-asc": list = [...list].sort((a, b) => (a.file_size || 0) - (b.file_size || 0)); break;
    case "type-asc": list = [...list].sort((a, b) => (CATEGORY_LABEL[fileCategory(a.file_type, a.file_name)] + a.file_name).localeCompare(CATEGORY_LABEL[fileCategory(b.file_type, b.file_name)] + b.file_name, undefined, { sensitivity: "base" })); break;
    case "type-desc": list = [...list].sort((a, b) => (CATEGORY_LABEL[fileCategory(b.file_type, b.file_name)] + b.file_name).localeCompare(CATEGORY_LABEL[fileCategory(a.file_type, a.file_name)] + a.file_name, undefined, { sensitivity: "base" })); break;
    default: list = trashMode
      ? [...list].sort((a, b) => new Date(b.deleted_at || b.uploaded_at) - new Date(a.deleted_at || a.uploaded_at))
      : [...list].sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
  }
  return list;
}

function visibleFolders() {
  if (trashMode) return [];
  let list = childFolders(allFolders, currentFolderId);
  if (searchQuery) list = list.filter((f) => f.name.toLowerCase().includes(searchQuery));
  return list;
}

function folderItemCount(folderId) {
  const sub = subtreeIds(allFolders, folderId);
  const files = activeFiles().filter((f) => !isRoot(f.folder_id) && sub.has(f.folder_id)).length;
  const folders = [...sub].length - 1;
  const parts = [];
  if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  parts.push(`${files} file${files === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function applyView() {
  const folders = visibleFolders();
  const files = visibleFiles();
  updateBulkBar();
  updateUsage();
  const searching = searchQuery || typeFilter !== "all";
  if (!folders.length && !files.length) {
    if (!searching) {
      setState("empty");
      setEmptyText(trashMode ? "trash" : (!activeFiles().length && !allFolders.length ? "root" : "folder"));
    } else {
      setState("noresults");
    }
    renderBreadcrumbs();
    renderRecentPanel();
    return;
  }
  setState("list");
  renderFolders(folders);
  renderRows(files);
  if (viewMode === "grid") void renderGrid(folders, files);
  syncSelectAll();
  renderBreadcrumbs();
}

function setEmptyText(kind) {
  const h = document.querySelector("#files-empty h3");
  const p = document.querySelector("#files-empty p");
  const btn = $("empty-upload-btn");
  if (kind === "trash") {
    if (h) h.textContent = "Trash is empty";
    if (p) p.textContent = "Deleted files appear here until permanently removed.";
    if (btn) btn.hidden = true;
  } else if (kind === "root") {
    if (h) h.textContent = "No files yet";
    if (p) p.textContent = "Upload your first file to get started.";
    if (btn) btn.hidden = trashMode;
  } else {
    if (h) h.textContent = "This folder is empty";
    if (p) p.textContent = "Upload files or create a folder to get started.";
    if (btn) btn.hidden = trashMode;
  }
}

/* ---------- breadcrumbs ---------- */
function renderBreadcrumbs() {
  const nav = $("breadcrumbs");
  if (!nav) return;
  nav.innerHTML = "";
  if (trashMode) { nav.hidden = true; return; }
  nav.hidden = false;
  const mk = (label, id, current) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "crumb-link" + (current ? " current" : "");
    b.textContent = label;
    if (current) b.setAttribute("aria-current", "page");
    else b.addEventListener("click", () => navigateTo(id));
    return b;
  };
  nav.appendChild(mk("My Files", null, isRoot(currentFolderId)));
  for (const f of folderChain(allFolders, currentFolderId)) {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "›";
    sep.setAttribute("aria-hidden", "true");
    nav.appendChild(sep);
    nav.appendChild(mk(f.name, f.id, f.id === currentFolderId));
  }
}

function navigateTo(folderId) {
  currentFolderId = isRoot(folderId) ? null : folderId;
  selection.clear();
  applyView();
}

/* ---------- usage + breakdown + recents (trash INCLUDED in usage) ---------- */
function categorySums() {
  const sums = { pdf: 0, image: 0, document: 0, text: 0, archive: 0, other: 0 };
  for (const f of allFiles) sums[fileCategory(f.file_type, f.file_name)] += Number(f.file_size) || 0;
  return sums;
}

function updateUsage() {
  const used = allFiles.reduce((s, f) => s + (Number(f.file_size) || 0), 0);
  const pct = Math.min(100, (used / QUOTA_BYTES) * 100);
  const bar = $("usage-bar");
  if (bar) { bar.style.width = pct.toFixed(1) + "%"; bar.setAttribute("aria-valuenow", String(Math.round(pct))); }
  const usedEl = $("usage-used");
  if (usedEl) {
    usedEl.innerHTML = `<strong>${escapeHtml(formatBytes(used))}</strong> used of 1 GB`;
    if (used > QUOTA_BYTES) usedEl.innerHTML += ` <span class="over-quota">over quota</span>`;
  }
  const availEl = $("usage-avail");
  if (availEl) availEl.textContent = used > QUOTA_BYTES ? "0 B available" : `${formatBytes(QUOTA_BYTES - used)} available`;

  const sums = categorySums();
  const seg = $("usage-segments");
  if (seg) {
    seg.innerHTML = "";
    for (const c of ["pdf", "image", "document", "text", "archive", "other"]) {
      if (!sums[c] || !used) continue;
      const i = document.createElement("i");
      i.className = "seg seg-" + c;
      i.style.width = ((sums[c] / used) * 100).toFixed(2) + "%";
      i.title = `${CATEGORY_LABEL[c]}: ${formatBytes(sums[c])}`;
      seg.appendChild(i);
    }
  }
  const legend = $("usage-legend");
  if (legend) {
    legend.innerHTML = "";
    for (const c of ["pdf", "image", "document", "text", "archive", "other"]) {
      if (!sums[c]) continue;
      const li = document.createElement("li");
      li.innerHTML = `<span class="dot-seg seg-${c}" aria-hidden="true"></span><span>${CATEGORY_LABEL[c]}</span><span class="leg-bytes">${escapeHtml(formatBytes(sums[c]))}</span>`;
      legend.appendChild(li);
    }
  }
  const n = trashMode ? trashFiles().length : visibleFolders().length + visibleFiles().length;
  const count = $("file-count");
  if (count) count.textContent = trashMode ? `${n} file${n === 1 ? "" : "s"}` : `${n} item${n === 1 ? "" : "s"}`;
  const tc = $("trash-count");
  const tn = trashFiles().length;
  if (tc) { tc.hidden = tn === 0; tc.textContent = String(tn); }
}

function renderRecents() {
  renderRecentPanel();
}

function renderRecentPanel() {
  const panel = $("recent-panel");
  const box = $("recent-list");
  const empty = $("recent-empty");
  if (!box || !panel) return;
  if (trashMode) { panel.hidden = true; return; }
  panel.hidden = false;
  box.innerHTML = "";
  const recents = [...activeFiles()].sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at)).slice(0, 5);
  if (empty) empty.hidden = recents.length > 0;
  for (const f of recents) {
    const k = fileKind(f.file_type, f.file_name);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-item";
    btn.dataset.id = f.id;
    btn.innerHTML = `<span class="ftype-icon ${k.cls}" aria-hidden="true">${k.short}</span>
      <span class="rinfo"><span class="rname">${escapeHtml(f.file_name)}</span><br>
      <span class="rmeta">${k.label} · ${escapeHtml(formatBytes(f.file_size))} · ${escapeHtml(relativeTime(f.uploaded_at))}</span></span>`;
    btn.addEventListener("click", () => {
      if (isPreviewable(f.file_type, f.file_name)) void openPreview(f);
      else openDetails(f.id);
    });
    box.appendChild(btn);
  }
}

/* ---------- rows / grid (folders first, then files) ---------- */
function actionIcons() {
  return {
    view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
    dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>',
    del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-9 0l1 13h10l1-13"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8v.1"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12a9 9 0 109-9 9.5 9.5 0 00-7 3.3L3 8"/><path d="M3 3v5h5"/></svg>',
    rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 9l-3 3 3 3m14-6l3 3-3 3M2 12h20"/></svg>',
  };
}

function fileRowActions(f, icons) {
  const safeName = escapeHtml(f.file_name);
  if (trashMode) {
    const canView = isPreviewable(f.file_type, f.file_name);
    return `<span class="row-actions">
      ${canView ? `<button class="icon-btn" data-act="view" data-id="${f.id}">${icons.view}View</button>` : ""}
      <button class="icon-btn" data-act="download" data-id="${f.id}">${icons.dl}Download</button>
      <button class="icon-btn" data-act="restore" data-id="${f.id}">${icons.restore}Restore</button>
      <button class="icon-btn danger" data-act="purge" data-id="${f.id}">${icons.del}Delete</button>
    </span>`;
  }
  const canView = isPreviewable(f.file_type, f.file_name);
  return `<span class="row-actions">
    ${canView ? `<button class="icon-btn" data-act="view" data-id="${f.id}">${icons.view}View</button>` : ""}
    <button class="icon-btn" data-act="rename" data-id="${f.id}">${icons.rename}Rename</button>
    <button class="icon-btn" data-act="move" data-id="${f.id}">${icons.move}Move</button>
    <button class="icon-btn" data-act="details" data-id="${f.id}">${icons.info}Details</button>
    <button class="icon-btn" data-act="download" data-id="${f.id}">${icons.dl}Download</button>
    <button class="icon-btn danger" data-act="delete" data-id="${f.id}">${icons.del}Delete</button>
  </span>`;
}

function renderFolders(folders) {
  const tbody = $("files-tbody");
  const mobile = $("mobile-list");
  if (!tbody || !mobile) return;
  // Folders render into the same containers BEFORE files (renderRows appends).
  const icons = actionIcons();
  for (const fd of folders) {
    const safeName = escapeHtml(fd.name);
    const meta = escapeHtml(folderItemCount(fd.id));
    const tr = document.createElement("tr");
    tr.className = "folder-row";
    tr.innerHTML = `
      <td></td>
      <td colspan="1"><span class="fcell"><span class="ftype-icon folder-ic" aria-hidden="true">${icons.folder}</span>
        <span><button class="linklike fname" data-folder="${fd.id}" title="${safeName}">${safeName}</button><br><span class="fsub">Folder · ${meta}</span></span></span></td>
      <td class="mono">—</td>
      <td class="mono">${escapeHtml(formatDate(fd.updated_at || fd.created_at))}</td>
      <td><span class="row-actions">
        <button class="icon-btn" data-folder-rename="${fd.id}">${icons.rename}Rename</button>
        <button class="icon-btn danger" data-folder-delete="${fd.id}">${icons.del}Delete</button>
      </span></td>`;
    // NOTE: table has 5 cols now (checkbox + 4). Folder row: empty checkbox cell + name + size + modified + actions.
    tbody.appendChild(tr);
    const div = document.createElement("div");
    div.className = "mrow folder-row";
    div.innerHTML = `
      <span class="ftype-icon folder-ic" aria-hidden="true">${icons.folder}</span>
      <span class="minfo"><button class="linklike mname" data-folder="${fd.id}" title="${safeName}">${safeName}</button><br>
      <span class="mmeta">Folder · ${meta}</span></span>
      <span class="row-actions">
        <button class="icon-btn" data-folder-rename="${fd.id}" aria-label="Rename ${safeName}">${icons.rename}</button>
        <button class="icon-btn danger" data-folder-delete="${fd.id}" aria-label="Delete ${safeName}">${icons.del}</button>
      </span>`;
    mobile.appendChild(div);
  }
}

function renderRows(list) {
  const tbody = $("files-tbody");
  const mobile = $("mobile-list");
  if (tbody) {
    // Keep folder rows rendered by renderFolders; clear only file rows.
    tbody.querySelectorAll("tr:not(.folder-row)").forEach((r) => r.remove());
    mobile?.querySelectorAll(".mrow:not(.folder-row)").forEach((r) => r.remove());
  } else if (mobile) {
    mobile.querySelectorAll(".mrow:not(.folder-row)").forEach((r) => r.remove());
  }
  const icons = actionIcons();
  for (const f of list) {
    const k = fileKind(f.file_type, f.file_name);
    const safeName = escapeHtml(f.file_name);
    const checked = selection.has(f.id) ? " checked" : "";
    if (tbody) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="check-cell"><input type="checkbox" data-select="${f.id}" aria-label="Select ${safeName}"${checked}></td>
        <td><span class="fcell"><span class="ftype-icon ${k.cls}" aria-hidden="true">${k.short}</span>
          <span><button class="linklike fname" data-act="details" data-id="${f.id}" title="${safeName}">${safeName}</button><br><span class="fsub">${k.label}</span></span></span></td>
        <td class="mono">${escapeHtml(formatBytes(f.file_size))}</td>
        <td class="mono">${escapeHtml(trashMode ? relativeTime(f.deleted_at || f.uploaded_at) : formatDate(f.uploaded_at))}</td>
        <td>${fileRowActions(f, icons)}</td>`;
      tbody.appendChild(tr);
    }
    if (mobile) {
      const div = document.createElement("div");
      div.className = "mrow";
      div.innerHTML = `
        <input type="checkbox" data-select="${f.id}" aria-label="Select ${safeName}"${checked}>
        <span class="ftype-icon ${k.cls}" aria-hidden="true">${k.short}</span>
        <span class="minfo"><button class="linklike mname" data-act="details" data-id="${f.id}" title="${safeName}">${safeName}</button><br>
        <span class="mmeta">${k.label} · ${escapeHtml(formatBytes(f.file_size))} · ${escapeHtml(formatDate(f.uploaded_at))}</span></span>
        <span class="row-actions">
          ${trashMode
            ? `<button class="icon-btn" data-act="restore" data-id="${f.id}" aria-label="Restore ${safeName}">${icons.restore}</button>
               <button class="icon-btn danger" data-act="purge" data-id="${f.id}" aria-label="Delete ${safeName} permanently">${icons.del}</button>`
            : `<button class="icon-btn" data-act="download" data-id="${f.id}" aria-label="Download ${safeName}">${icons.dl}</button>
               <button class="icon-btn danger" data-act="delete" data-id="${f.id}" aria-label="Delete ${safeName}">${icons.del}</button>`}
        </span>`;
      mobile.appendChild(div);
    }
  }
}

async function thumbFor(f) {
  if (fileCategory(f.file_type, f.file_name) !== "image") return null;
  if ((Number(f.file_size) || 0) > THUMB_MAX_BYTES) return null;
  if (thumbUrls.has(f.id)) return thumbUrls.get(f.id);
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(f.file_path);
    if (error || !data) return null;
    const url = URL.createObjectURL(data);
    thumbUrls.set(f.id, url);
    return url;
  } catch { return null; }
}

function revokeThumbs() {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
}

async function renderGrid(folders, files) {
  const grid = $("files-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const icons = actionIcons();
  for (const fd of folders) {
    const safeName = escapeHtml(fd.name);
    const tile = document.createElement("div");
    tile.className = "tile folder-tile";
    tile.innerHTML = `
      <button class="tile-visual" data-folder="${fd.id}" aria-label="Open ${safeName}">
        <span class="ftype-icon folder-ic tile-icon" aria-hidden="true">${icons.folder}</span>
      </button>
      <div class="tile-name" title="${safeName}">${safeName}</div>
      <div class="tile-meta">${escapeHtml(folderItemCount(fd.id))}</div>
      <div class="tile-actions">
        <button class="icon-btn" data-folder-rename="${fd.id}" aria-label="Rename ${safeName}">${icons.rename}</button>
        <button class="icon-btn danger" data-folder-delete="${fd.id}" aria-label="Delete ${safeName}">${icons.del}</button>
      </div>`;
    grid.appendChild(tile);
  }
  for (const f of files) {
    const k = fileKind(f.file_type, f.file_name);
    const safeName = escapeHtml(f.file_name);
    const checked = selection.has(f.id) ? " checked" : "";
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.innerHTML = `
      <label class="tile-check"><input type="checkbox" data-select="${f.id}" aria-label="Select ${safeName}"${checked}></label>
      <button class="tile-visual" data-act="details" data-id="${f.id}" aria-label="Details for ${safeName}">
        <span class="ftype-icon ${k.cls} tile-icon" aria-hidden="true">${k.short}</span>
      </button>
      <div class="tile-name" title="${safeName}">${safeName}</div>
      <div class="tile-meta">${k.label} · ${escapeHtml(formatBytes(f.file_size))}</div>
      <div class="tile-meta">${escapeHtml(formatDate(f.uploaded_at))}</div>
      <div class="tile-actions">${fileRowActions(f, icons).replace(/<span class="row-actions">|<\/span>/g, "")}</div>`;
    // In trash, details action is noise — drop it (restore/purge/view/download remain).
    if (trashMode) tile.querySelectorAll('[data-act="details"]').forEach((b) => b.remove());
    grid.appendChild(tile);
    if (fileCategory(f.file_type, f.file_name) === "image" && (Number(f.file_size) || 0) <= THUMB_MAX_BYTES) {
      const visual = tile.querySelector(".tile-visual");
      thumbFor(f).then((url) => {
        if (url && visual?.isConnected) {
          visual.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
        }
      });
    }
  }
}

/* ---------- selection + bulk bar ---------- */
function updateBulkBar() {
  const bar = $("bulk-bar");
  const n = selection.size;
  if (bar) bar.hidden = n === 0;
  const c = $("bulk-count");
  if (c) c.textContent = `${n} selected`;
  // Move makes no sense inside Trash; Delete there purges instead of trashing.
  const mv = $("bulk-move");
  if (mv) mv.hidden = trashMode;
  const del = $("bulk-delete");
  if (del) del.textContent = trashMode ? "Delete permanently" : "Delete";
}

function syncSelectAll() {
  const all = $("select-all");
  if (!all) return;
  const ids = visibleFiles().map((f) => f.id);
  const sel = ids.filter((id) => selection.has(id));
  all.checked = ids.length > 0 && sel.length === ids.length;
  all.indeterminate = sel.length > 0 && sel.length < ids.length;
}

function clearSelection() {
  selection.clear();
  document.querySelectorAll("[data-select]").forEach((c) => { c.checked = false; });
  updateBulkBar();
  syncSelectAll();
}

/* ---------- details drawer ---------- */
function folderPathLabel(folderId) {
  const names = folderChain(allFolders, folderId).map((f) => f.name);
  return ["My Files", ...names].join(" / ");
}

function openDetails(id) {
  const f = allFiles.find((x) => x.id === id);
  if (!f) return;
  selectedId = id;
  drawerReturnEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const k = fileKind(f.file_type, f.file_name);
  const cat = fileCategory(f.file_type, f.file_name);
  $("details-icon").className = `ftype-icon ${k.cls} details-icon`;
  $("details-icon").textContent = k.short;
  $("details-name").textContent = f.file_name;
  $("details-name").title = f.file_name;
  $("details-kind").textContent = `${k.label} ${cat === "document" ? "Document" : cat === "image" ? "Image" : cat === "text" ? "File" : cat === "archive" ? "Archive" : cat === "pdf" ? "Document" : "File"}`;
  const loc = f.deleted_at ? "Trash" : folderPathLabel(f.folder_id);
  $("details-rows").innerHTML = `
    <div class="drow"><span>Name</span><strong>${escapeHtml(f.file_name)}</strong></div>
    <div class="drow"><span>Type</span><strong>${k.label} (${escapeHtml(f.file_type || "unknown")})</strong></div>
    <div class="drow"><span>Size</span><strong>${escapeHtml(formatBytes(f.file_size))}</strong></div>
    <div class="drow"><span>Uploaded</span><strong>${escapeHtml(formatDateTime(f.uploaded_at))}</strong></div>
    ${f.deleted_at ? `<div class="drow"><span>Deleted</span><strong>${escapeHtml(relativeTime(f.deleted_at))}</strong></div>` : ""}
    <div class="drow"><span>Location</span><strong>${escapeHtml(loc)}</strong></div>
    <div class="drow"><span>Path</span><strong class="mono" title="${escapeHtml(f.file_path)}">${escapeHtml(f.file_path)}</strong></div>`;
  $("details-view").hidden = !isPreviewable(f.file_type, f.file_name);
  const acts = document.querySelector(".details-actions");
  if (acts) {
    acts.innerHTML = f.deleted_at
      ? `<button class="btn btn-secondary btn-sm" id="details-restore" type="button">Restore</button>
         <button class="btn btn-secondary btn-sm" id="details-download" type="button">Download</button>
         <button class="btn btn-danger btn-sm" id="details-purge" type="button">Delete permanently</button>`
      : `<button class="btn btn-secondary btn-sm" id="details-view" type="button">View</button>
         <button class="btn btn-secondary btn-sm" id="details-download" type="button">Download</button>
         <button class="btn btn-danger btn-sm" id="details-delete" type="button">Delete</button>`;
    wireDetailsActions();
  }
  const dd = $("details-drawer");
  dd?.classList.add("open");
  dd?.setAttribute("aria-hidden", "false");
  $("details-backdrop")?.classList.add("open");
  $("details-close")?.focus();
}

function wireDetailsActions() {
  $("details-view")?.addEventListener("click", () => {
    const f = allFiles.find((x) => x.id === selectedId);
    if (f) { closeDetails(); void openPreview(f); }
  });
  $("details-download")?.addEventListener("click", () => {
    const f = allFiles.find((x) => x.id === selectedId);
    if (f) void downloadPrivateFile(f);
  });
  $("details-delete")?.addEventListener("click", () => {
    if (selectedId) { const id = selectedId; closeDetails(); askDelete(id); }
  });
  $("details-restore")?.addEventListener("click", () => {
    if (selectedId) { const id = selectedId; closeDetails(); void restoreFiles([id]); }
  });
  $("details-purge")?.addEventListener("click", () => {
    if (selectedId) { const id = selectedId; closeDetails(); askPurge([id]); }
  });
}

function closeDetails() {
  selectedId = null;
  const dd = $("details-drawer");
  dd?.classList.remove("open");
  dd?.setAttribute("aria-hidden", "true");
  $("details-backdrop")?.classList.remove("open");
  if (drawerReturnEl && document.contains(drawerReturnEl)) drawerReturnEl.focus();
  drawerReturnEl = null;
}

/* ---------- load ---------- */
async function loadAll() {
  const sb = getClient();
  if (!sb || !sessionUser) return;
  setState("loading");
  const FULL_COLS = "id, file_name, file_path, file_size, file_type, uploaded_at, folder_id, deleted_at, original_folder_id, original_file_path";
  const LEGACY_COLS = "id, file_name, file_path, file_size, file_type, uploaded_at";
  let filesR = await sb.from("files").select(FULL_COLS).order("uploaded_at", { ascending: false });
  let foldR = { data: [], error: null };
  if (filesR.error && /column|schema cache/i.test(filesR.error.message || "")) {
    // Migration not run yet — fall back to legacy columns, folders disabled.
    filesR = await sb.from("files").select(LEGACY_COLS).order("uploaded_at", { ascending: false });
    foldR = { data: [], error: new Error("migration pending") };
  } else if (!filesR.error) {
    foldR = await sb.from("folders").select("id, name, parent_id, created_at, updated_at").order("name", { ascending: true });
  }
  if (filesR.error) {
    setState("error");
    const m = $("files-error-msg");
    if (m) m.textContent = "Couldn’t load files: " + filesR.error.message;
    return;
  }
  if (foldR.error) {
    foldersAvailable = false;
    toast("Folders unavailable — run supabase-migrate-folders-trash.sql in the Supabase SQL editor.", "error", 6000);
    allFolders = [];
  } else {
    foldersAvailable = true;
    allFolders = foldR.data || [];
  }
  // Drop stale folder selection (folder deleted elsewhere).
  if (!isRoot(currentFolderId) && !allFolders.some((f) => f.id === currentFolderId)) currentFolderId = null;
  revokeThumbs();
  closePreview();
  selection.clear();
  allFiles = filesR.data || [];
  // Older rows may lack new columns if migration wasn't run — normalize.
  for (const f of allFiles) {
    if (!("folder_id" in f)) f.folder_id = null;
    if (!("deleted_at" in f)) f.deleted_at = null;
  }
  updateUsage();
  renderRecents();
  applyView();
}

/* ---------- trash (soft delete) ---------- */
function setDeleteModal(title, nameText, subText, confirmLabel) {
  $("delete-title").textContent = title;
  $("delete-name").textContent = nameText;
  const ps = document.querySelectorAll("#delete-modal .modal p");
  if (ps[1]) ps[1].textContent = subText;
  const btn = $("delete-confirm");
  btn.textContent = confirmLabel;
  btn.className = confirmLabel === "Move to Trash" ? "btn btn-primary" : "btn btn-danger";
}

let pendingTrashIds = [];
let pendingPurgeIds = [];
let deleteMode = null; // "trash" | "purge" | "empty"

function askDelete(id) {
  const f = allFiles.find((x) => x.id === id);
  if (!f) return;
  pendingTrashIds = [id];
  deleteMode = "trash";
  setDeleteModal("Move to Trash?", f.file_name, "You can restore it from Trash later.", "Move to Trash");
  $("delete-modal")?.classList.add("open");
  $("delete-confirm")?.focus();
}

function askBulkTrash(ids) {
  pendingTrashIds = [...ids];
  deleteMode = "trash";
  setDeleteModal(`Move ${ids.length} files to Trash?`, `${ids.length} files`, "You can restore them from Trash later.", "Move to Trash");
  $("delete-modal")?.classList.add("open");
  $("delete-confirm")?.focus();
}

function askPurge(ids) {
  pendingPurgeIds = [...ids];
  deleteMode = ids.length > 1 ? "purge-bulk" : "purge";
  const f = allFiles.find((x) => x.id === ids[0]);
  setDeleteModal(
    ids.length > 1 ? `Permanently delete ${ids.length} files?` : `Permanently delete “${f?.file_name || "file"}”?`,
    ids.length > 1 ? `${ids.length} files` : (f?.file_name || ""),
    "This cannot be undone.",
    ids.length > 1 ? "Delete permanently" : "Delete permanently"
  );
  $("delete-modal")?.classList.add("open");
  $("delete-confirm")?.focus();
}

function askEmptyTrash() {
  deleteMode = "empty";
  const n = trashFiles().length;
  setDeleteModal("Empty Trash?", `${n} file${n === 1 ? "" : "s"}`, "This permanently deletes everything in Trash. This cannot be undone.", "Empty Trash");
  $("delete-modal")?.classList.add("open");
  $("delete-confirm")?.focus();
}

async function confirmDeleteModal() {
  const btn = $("delete-confirm");
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Working…'; }
  try {
    if (deleteMode === "trash") await trashFilesByIds(pendingTrashIds);
    else if (deleteMode === "purge" || deleteMode === "purge-bulk") await purgeFilesByIds(pendingPurgeIds);
    else if (deleteMode === "empty") await emptyTrash();
  } finally {
    if (btn) { btn.disabled = false; }
    $("delete-modal")?.classList.remove("open");
    pendingTrashIds = [];
    pendingPurgeIds = [];
    deleteMode = null;
  }
}

async function trashFilesByIds(ids) {
  const sb = getClient();
  if (!sb) return;
  let ok = 0;
  const failed = [];
  for (const id of ids) {
    const f = allFiles.find((x) => x.id === id);
    if (!f || f.deleted_at) continue;
    const { error } = await sb.from("files").update({
      deleted_at: new Date().toISOString(),
      original_folder_id: f.folder_id || null,
      original_file_path: f.file_path,
    }).eq("id", id);
    if (error) failed.push(f.file_name);
    else ok += 1;
  }
  if (ok) toast(ids.length > 1 ? `${ok} file${ok === 1 ? "" : "s"} moved to Trash.` : "Moved to Trash. You can restore it from Trash.", "success");
  if (failed.length) toast(`Couldn’t trash: ${failed.join(", ")}`, "error");
  await loadAll();
}

async function purgeFilesByIds(ids) {
  const sb = getClient();
  if (!sb) return;
  let ok = 0;
  const failed = [];
  const queue = [...ids];
  const workers = Array.from({ length: Math.min(BULK_CONCURRENCY, queue.length) || 1 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      const f = allFiles.find((x) => x.id === id);
      if (!f) continue;
      const { error: sErr } = await sb.storage.from(BUCKET).remove([f.file_path]);
      if (sErr) { failed.push(`${f.file_name} (storage)`); continue; }
      const { error: dErr } = await sb.from("files").delete().eq("id", id);
      if (dErr) failed.push(`${f.file_name} (metadata: storage object already removed — ${dErr.message})`);
      else ok += 1;
    }
  });
  await Promise.all(workers);
  if (ok) toast(ids.length > 1 ? `${ok} permanently deleted.` : "Permanently deleted.", "success");
  if (failed.length) toast(`Failed: ${failed.join("; ")}`, "error", 6000);
  await loadAll();
}

async function emptyTrash() {
  await purgeFilesByIds(trashFiles().map((f) => f.id));
}

async function restoreFiles(ids) {
  const sb = getClient();
  if (!sb) return;
  let ok = 0;
  const failed = [];
  for (const id of ids) {
    const f = allFiles.find((x) => x.id === id);
    if (!f || !f.deleted_at) continue;
    // Target: original folder if it still exists, else My Files.
    let targetId = !isRoot(f.original_folder_id) && allFolders.some((fd) => fd.id === f.original_folder_id)
      ? f.original_folder_id
      : null;
    let fellBack = !isRoot(f.original_folder_id) && targetId === null;
    const siblings = filesInFolder(activeFiles(), targetId).map((x) => x.file_name);
    let name = f.file_name;
    if (siblings.some((n) => n.toLowerCase() === name.toLowerCase())) {
      name = uniqueRestoreName(name, siblings);
    }
    const dir = buildDir(sessionUser.id, allFolders, targetId);
    const stored = f.file_path.split("/").pop();
    const wantPath = name === f.file_name
      ? f.file_path
      : `${dir}/${Date.now()}-${sanitizeFileName(name)}`;
    if (wantPath === f.file_path) {
      // Same object path — just clear the trash state (and fix folder link).
      const { error } = await sb.from("files").update({
        folder_id: targetId, deleted_at: null, original_folder_id: null, original_file_path: null,
      }).eq("id", id);
      if (error) { failed.push(`${f.file_name}`); continue; }
      ok += 1;
      if (fellBack) toast(`Original folder is gone — “${name}” restored to My Files.`, "info");
      continue;
    }
    const res = await moveObjectWithDbSync(sb, BUCKET, id, f.file_path, wantPath, {
      file_name: name,
      folder_id: targetId,
      deleted_at: null,
      original_folder_id: null,
      original_file_path: null,
    });
    if (res.ok) {
      ok += 1;
      if (fellBack) toast(`Original folder is gone — “${name}” restored to My Files.`, "info");
    } else {
      failed.push(`${f.file_name}${res.rolledBack ? "" : " (metadata out of sync — retry restore)"}`);
    }
  }
  if (ok) toast(ids.length > 1 ? `${ok} file${ok === 1 ? "" : "s"} restored.` : "File restored.", "success");
  if (failed.length) toast(`Restore failed: ${failed.join("; ")}`, "error", 6000);
  await loadAll();
}

/* ---------- rename file ---------- */
let pendingRenameId = null;
let pendingRenameExt = "";

function askRenameFile(id) {
  const f = allFiles.find((x) => x.id === id);
  if (!f || f.deleted_at) return;
  pendingRenameId = id;
  pendingRenameExt = (splitName(f.file_name).ext || "").toLowerCase();
  const input = $("rename-input");
  input.value = f.file_name;
  $("rename-title").textContent = "Rename file";
  $("rename-ext-note").hidden = true;
  const box = document.querySelector("#rename-form .form-error");
  box?.classList.remove("show");
  $("rename-modal")?.classList.add("open");
  input.focus();
  input.select();
}

async function confirmRenameFile() {
  const f = allFiles.find((x) => x.id === pendingRenameId);
  if (!f) return;
  const input = $("rename-input");
  const raw = input.value;
  const name = sanitizeFileName(raw).trim();
  const box = document.querySelector("#rename-form .form-error");
  const fail = (msg) => {
    input.setAttribute("aria-invalid", "true");
    $("rename-err").textContent = msg;
    if (box) { box.textContent = msg; box.classList.add("show"); }
  };
  $("rename-err").textContent = "";
  input.removeAttribute("aria-invalid");
  box?.classList.remove("show");
  if (!name || name === "." || name === "..") { fail("File name is required."); return; }
  const siblings = filesInFolder(activeFiles(), f.folder_id).filter((x) => x.id !== f.id).map((x) => x.file_name);
  if (siblings.some((n) => n.toLowerCase() === name.toLowerCase())) { fail("A file with this name already exists in this folder."); return; }
  if (name === f.file_name) { closeModal("rename-modal"); return; }
  const newExt = (splitName(name).ext || "").toLowerCase();
  const sb = getClient();
  const dir = f.file_path.includes("/") ? f.file_path.slice(0, f.file_path.lastIndexOf("/")) : sessionUser.id;
  const stored = f.file_path.split("/").pop();
  const prefix = stored.includes("-") ? stored.slice(0, stored.indexOf("-") + 1) : `${Date.now()}-`;
  const newPath = `${dir}/${prefix}${sanitizeFileName(name)}`;
  const btn = $("rename-confirm");
  btn.disabled = true;
  const res = await moveObjectWithDbSync(sb, BUCKET, f.id, f.file_path, newPath, {
    file_name: name,
    ...(newExt !== pendingRenameExt ? { file_type: mimeForExt(newExt) } : {}),
  });
  btn.disabled = false;
  if (res.ok) {
    toast(`Renamed to “${name}”.`, "success");
    closeModal("rename-modal");
    pendingRenameId = null;
    await loadAll();
  } else {
    fail(res.rolledBack ? `Rename failed: ${res.error}` : `Rename failed and rollback did not complete: ${res.error} — retry the rename.`);
  }
}

/* ---------- move files ---------- */
let pendingMoveIds = [];
let moveDestId = null; // null = My Files root

function folderTree() {
  // Depth-first list of {id, name, depth} for the picker.
  const out = [];
  const walk = (parentId, depth) => {
    for (const fd of childFolders(allFolders, parentId)) {
      out.push({ id: fd.id, name: fd.name, depth });
      walk(fd.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function askMove(ids) {
  const files = ids.map((id) => allFiles.find((x) => x.id === id)).filter((f) => f && !f.deleted_at);
  if (!files.length) return;
  pendingMoveIds = files.map((f) => f.id);
  moveDestId = null;
  $("move-title").textContent = files.length > 1 ? `Move ${files.length} files` : `Move “${files[0].file_name}”`;
  $("move-sub").textContent = files.length > 1 ? "Choose a destination folder." : `Choose a destination for “${files[0].file_name}”.`;
  renderMovePicker(files);
  document.querySelector("#move-modal .form-error")?.classList.remove("show");
  $("move-modal")?.classList.add("open");
  $("move-confirm")?.focus();
}

function renderMovePicker(files) {
  const box = $("folder-picker");
  box.innerHTML = "";
  const currentIds = new Set(files.map((f) => (isRoot(f.folder_id) ? null : f.folder_id)));
  const mk = (id, label, depth, disabled, note) => {
    const lab = document.createElement("label");
    lab.className = "pick-row" + (disabled ? " disabled" : "");
    lab.style.paddingLeft = `${10 + depth * 18}px`;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "move-dest";
    radio.value = id === null ? "__root__" : id;
    radio.disabled = !!disabled;
    radio.checked = !disabled && ((moveDestId === null && id === null) || moveDestId === id);
    radio.addEventListener("change", () => { moveDestId = id; });
    const span = document.createElement("span");
    span.textContent = label + (note ? ` — ${note}` : "");
    lab.appendChild(radio);
    lab.appendChild(span);
    box.appendChild(lab);
  };
  mk(null, "My Files", 0, currentIds.size === 1 && currentIds.has(null), currentIds.has(null) ? "current" : "");
  for (const t of folderTree()) {
    const isCur = currentIds.size === 1 && currentIds.has(t.id);
    mk(t.id, t.name, t.depth + 1, isCur, isCur ? "current" : "");
  }
  // Default selection: first enabled option.
  const first = box.querySelector('input:not(:disabled)');
  if (first && !box.querySelector('input:checked:not(:disabled)')) {
    first.checked = true;
    moveDestId = first.value === "__root__" ? null : first.value;
  }
}

async function confirmMove() {
  const sb = getClient();
  if (!sb || !pendingMoveIds.length) return;
  const destId = moveDestId;
  const dir = buildDir(sessionUser.id, allFolders, destId);
  const btn = $("move-confirm");
  btn.disabled = true;
  let ok = 0;
  const failed = [];
  for (const id of pendingMoveIds) {
    const f = allFiles.find((x) => x.id === id);
    if (!f || f.deleted_at) continue;
    const sameFolder = (isRoot(f.folder_id) ? null : f.folder_id) === (destId || null);
    if (sameFolder) { failed.push(`${f.file_name} (already here)`); continue; }
    const siblings = filesInFolder(activeFiles(), destId).filter((x) => x.id !== id).map((x) => x.file_name);
    if (siblings.some((n) => n.toLowerCase() === f.file_name.toLowerCase())) {
      failed.push(`${f.file_name} (a file with this name already exists there)`);
      continue;
    }
    const stored = f.file_path.split("/").pop();
    const res = await moveObjectWithDbSync(sb, BUCKET, id, f.file_path, `${dir}/${stored}`, { folder_id: destId || null });
    if (res.ok) ok += 1;
    else failed.push(`${f.file_name}${res.rolledBack ? "" : " (out of sync — retry)"}`);
  }
  btn.disabled = false;
  closeModal("move-modal");
  if (ok) toast(pendingMoveIds.length > 1 ? `${ok} moved.` : "File moved.", "success");
  if (failed.length) toast(`Not moved: ${failed.join("; ")}`, "error", 6000);
  pendingMoveIds = [];
  await loadAll();
}

/* ---------- folders: create / rename / delete / open ---------- */
let folderModalMode = "create"; // "create" | "rename"
let pendingFolderId = null;

function askNewFolder() {
  if (!foldersAvailable) { toast("Folders unavailable — run the database migration first.", "error"); return; }
  folderModalMode = "create";
  pendingFolderId = null;
  $("folder-title").textContent = "New folder";
  $("folder-confirm").textContent = "Create folder";
  $("folder-name").value = "";
  $("folder-name-err").textContent = "";
  document.querySelector("#folder-form .form-error")?.classList.remove("show");
  $("folder-modal")?.classList.add("open");
  $("folder-name")?.focus();
}

function askRenameFolder(id) {
  const fd = allFolders.find((x) => x.id === id);
  if (!fd) return;
  folderModalMode = "rename";
  pendingFolderId = id;
  $("folder-title").textContent = "Rename folder";
  $("folder-confirm").textContent = "Rename";
  $("folder-name").value = fd.name;
  $("folder-name-err").textContent = "";
  document.querySelector("#folder-form .form-error")?.classList.remove("show");
  $("folder-modal")?.classList.add("open");
  const input = $("folder-name");
  input.focus();
  input.select();
}

async function confirmFolderModal() {
  const sb = getClient();
  if (!sb) return;
  const input = $("folder-name");
  const box = document.querySelector("#folder-form .form-error");
  const fail = (msg) => {
    input.setAttribute("aria-invalid", "true");
    $("folder-name-err").textContent = msg;
    if (box) { box.textContent = msg; box.classList.add("show"); }
  };
  $("folder-name-err").textContent = "";
  input.removeAttribute("aria-invalid");
  box?.classList.remove("show");
  const btn = $("folder-confirm");
  btn.disabled = true;
  try {
    if (folderModalMode === "create") {
      const siblings = childFolders(allFolders, currentFolderId).map((f) => f.name);
      const err = validateFolderName(input.value, siblings);
      if (err) { fail(err); return; }
      const name = input.value.trim().replace(/\s+/g, " ");
      await createFolderRow(sb, sessionUser.id, name, currentFolderId);
      toast(`Folder “${name}” created.`, "success");
      closeModal("folder-modal");
      await loadAll();
    } else {
      const fd = allFolders.find((x) => x.id === pendingFolderId);
      if (!fd) return;
      const siblings = childFolders(allFolders, fd.parent_id).filter((x) => x.id !== fd.id).map((x) => x.name);
      const err = validateFolderName(input.value, siblings);
      if (err) { fail(err); return; }
      const name = input.value.trim().replace(/\s+/g, " ");
      if (name === fd.name) { closeModal("folder-modal"); return; }
      await renameFolderDeep(name, fd);
    }
  } catch (e) {
    fail(e?.message || "Something went wrong.");
  } finally {
    btn.disabled = false;
  }
}

// Folder rename: update the folder row first, then move every descendant
// file's object to the rebuilt path. Retry-safe: only mismatched paths move.
async function renameFolderDeep(newName, fd) {
  const sb = getClient();
  await renameFolderRow(sb, fd.id, newName);
  const foldersNow = allFolders.map((x) => (x.id === fd.id ? { ...x, name: newName } : x));
  const sub = subtreeIds(allFolders, fd.id);
  const affected = allFiles.filter((f) => !isRoot(f.folder_id) && sub.has(f.folder_id));
  let moved = 0;
  const failed = [];
  const dirOf = (file) => buildDir(sessionUser.id, foldersNow, file.folder_id);
  for (const f of affected) {
    const stored = f.file_path.split("/").pop();
    const want = `${dirOf(f)}/${stored}`;
    if (want === f.file_path) continue;
    const res = await moveObjectWithDbSync(sb, BUCKET, f.id, f.file_path, want, {});
    if (res.ok) { moved += 1; f.file_path = want; }
    else failed.push(`${f.file_name}${res.rolledBack ? "" : " (out of sync)"}`);
  }
  closeModal("folder-modal");
  toast(`Folder renamed to “${newName}”.` + (moved ? ` ${moved} file${moved === 1 ? "" : "s"} moved.` : ""), "success");
  if (failed.length) toast(`Still on old paths (retry the rename): ${failed.join("; ")}`, "error", 8000);
  await loadAll();
}

async function askDeleteFolder(id) {
  const fd = allFolders.find((x) => x.id === id);
  if (!fd) return;
  const sub = subtreeIds(allFolders, id);
  const kidCount = [...sub].length - 1;
  const fileCount = activeFiles().filter((f) => !isRoot(f.folder_id) && sub.has(f.folder_id)).length;
  if (kidCount > 0 || fileCount > 0) {
    toast("This folder isn’t empty. Move or delete its contents before deleting the folder.", "error", 5000);
    return;
  }
  pendingTrashIds = [];
  pendingPurgeIds = [];
  deleteMode = "folder";
  window.__pendingFolderDelete = id;
  setDeleteModal(`Delete folder “${fd.name}”?`, fd.name, "Only empty folders can be deleted. This cannot be undone.", "Delete");
  $("delete-modal")?.classList.add("open");
  $("delete-confirm")?.focus();
}

async function confirmFolderDelete() {
  const sb = getClient();
  const id = window.__pendingFolderDelete;
  try {
    await deleteFolderRow(sb, id);
    toast("Folder deleted.", "success");
    if (currentFolderId === id) {
      const fd = allFolders.find((x) => x.id === id);
      currentFolderId = fd && !isRoot(fd.parent_id) ? fd.parent_id : null;
    }
    await loadAll();
  } catch (e) {
    toast("Delete failed: " + (e?.message || "unknown error"), "error");
  } finally {
    window.__pendingFolderDelete = null;
  }
}

/* ---------- modal helpers ---------- */
function closeModal(id) {
  $(id)?.classList.remove("open");
}

/* ---------- init ---------- */
function applyHashMode() {
  const was = trashMode;
  trashMode = location.hash === "#trash";
  if (was !== trashMode) {
    selection.clear();
    closeDetails();
  }
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const on = (a.dataset.nav === "trash") === trashMode;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const title = $("panel-title");
  if (title) title.textContent = trashMode ? "Trash" : "My Files";
  const panel = $("files");
  if (panel) panel.setAttribute("aria-label", trashMode ? "Trash" : "My files");
  if ($("new-folder-btn")) $("new-folder-btn").hidden = trashMode;
  if ($("empty-trash-btn")) $("empty-trash-btn").hidden = !trashMode || trashFiles().length === 0;
  const dz = $("dropzone");
  if (dz) dz.hidden = trashMode;
}

async function init() {
  const drawer = $("drawer"), backdrop = $("drawer-backdrop");
  $("nav-toggle")?.addEventListener("click", () => { drawer?.classList.add("open"); backdrop?.classList.add("open"); });
  const closeDrawer = () => { drawer?.classList.remove("open"); backdrop?.classList.remove("open"); };
  backdrop?.addEventListener("click", closeDrawer);
  drawer?.querySelectorAll("button, a").forEach((el) => el.addEventListener("click", closeDrawer));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeDrawer();
    if ($("preview-modal")?.classList.contains("open")) return;
    if ($("details-drawer")?.classList.contains("open")) { closeDetails(); return; }
    for (const id of ["move-modal", "rename-modal", "folder-modal", "delete-modal"]) {
      if ($(id)?.classList.contains("open")) { $(id).classList.remove("open"); pendingMoveIds = []; pendingRenameId = null; return; }
    }
  });

  if (!isConfigured()) {
    showConfig();
    setState("empty");
    const hello = $("hello");
    if (hello) hello.textContent = "Hello";
    initUpload({ onDone: () => toast("Configure Supabase first — upload skipped.", "error") });
    document.querySelectorAll("[data-logout]").forEach((b) => b.addEventListener("click", () => (location.href = "login.html")));
    return;
  }

  let session = null;
  try {
    session = await requireAuth();
  } catch {
    setState("error");
    const m = $("files-error-msg");
    if (m) m.textContent = "Unable to connect to Supabase. Check your internet and project URL.";
    return;
  }
  if (!session) return;
  sessionUser = session.user;
  const hello = $("hello");
  if (hello) hello.textContent = `Hello, ${displayName(sessionUser)}`;

  // Controls
  $("search")?.addEventListener("input", debounce((e) => { searchQuery = e.target.value.trim().toLowerCase(); applyView(); }, 120));
  document.querySelectorAll("#type-filters button").forEach((btn) => {
    btn.addEventListener("click", () => {
      typeFilter = btn.dataset.filter || "all";
      document.querySelectorAll("#type-filters button").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      applyView();
    });
  });
  const sortSel = $("sort-select");
  if (sortSel && !sortSel.options.length) {
    for (const [v, label] of Object.entries(SORTS)) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      sortSel.appendChild(o);
    }
    sortSel.value = sortKey;
    sortSel.addEventListener("change", () => { sortKey = sortSel.value; applyView(); updateUsage(); });
  }
  const syncViewBtns = () => {
    document.querySelectorAll("#view-toggle button").forEach((b) => {
      const on = b.dataset.view === viewMode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  };
  document.querySelectorAll("#view-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      viewMode = btn.dataset.view;
      try { localStorage.setItem("cloudbox-view", viewMode); } catch { /* ignore */ }
      syncViewBtns();
      applyView();
    });
  });
  syncViewBtns();

  // Selection (delegated: rows re-render often)
  document.querySelector(".content")?.addEventListener("change", (e) => {
    const c = e.target.closest("[data-select]");
    if (!c) return;
    if (c.checked) selection.add(c.dataset.select);
    else selection.delete(c.dataset.select);
    updateBulkBar();
    syncSelectAll();
  });
  $("select-all")?.addEventListener("change", (e) => {
    const ids = visibleFiles().map((f) => f.id);
    if (e.target.checked) ids.forEach((id) => selection.add(id));
    else ids.forEach((id) => selection.delete(id));
    applyView();
  });

  // Delegated actions
  document.querySelector(".content")?.addEventListener("click", (e) => {
    const folderBtn = e.target.closest("[data-folder]");
    if (folderBtn) { navigateTo(folderBtn.dataset.folder); return; }
    const fr = e.target.closest("[data-folder-rename]");
    if (fr) { askRenameFolder(fr.dataset.folderRename); return; }
    const fdel = e.target.closest("[data-folder-delete]");
    if (fdel) { void askDeleteFolder(fdel.dataset.folderDelete); return; }
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.classList.contains("recent-item")) return;
    const { act, id } = btn.dataset;
    const f = allFiles.find((x) => x.id === id);
    if (!f) return;
    if (act === "view") void openPreview(f);
    else if (act === "details") openDetails(id);
    else if (act === "download") void downloadPrivateFile(f);
    else if (act === "delete") askDelete(id);
    else if (act === "rename") askRenameFile(id);
    else if (act === "move") askMove([id]);
    else if (act === "restore") void restoreFiles([id]);
    else if (act === "purge") askPurge([id]);
  });

  // Bulk bar
  $("bulk-clear")?.addEventListener("click", clearSelection);
  $("bulk-delete")?.addEventListener("click", () => {
    const ids = [...selection];
    if (!ids.length) return;
    if (trashMode) askPurge(ids.filter((id) => allFiles.some((x) => x.id === id && x.deleted_at)));
    else {
      const active = ids.filter((id) => allFiles.some((x) => x.id === id && !x.deleted_at));
      if (active.length) askBulkTrash(active);
    }
  });
  $("bulk-move")?.addEventListener("click", () => {
    const ids = [...selection].filter((id) => allFiles.some((x) => x.id === id && !x.deleted_at));
    if (ids.length) askMove(ids);
  });
  $("bulk-download")?.addEventListener("click", () => void bulkDownload([...selection]));

  // Folder + rename + move modals
  $("new-folder-btn")?.addEventListener("click", askNewFolder);
  $("folder-cancel")?.addEventListener("click", () => closeModal("folder-modal"));
  $("folder-form")?.addEventListener("submit", (e) => { e.preventDefault(); void confirmFolderModal(); });
  $("rename-cancel")?.addEventListener("click", () => { closeModal("rename-modal"); pendingRenameId = null; });
  $("rename-form")?.addEventListener("submit", (e) => { e.preventDefault(); void confirmRenameFile(); });
  $("rename-input")?.addEventListener("input", () => {
    const note = $("rename-ext-note");
    if (!note || !pendingRenameId) return;
    const f = allFiles.find((x) => x.id === pendingRenameId);
    const cur = (splitName($("rename-input").value.trim()).ext || "").toLowerCase();
    note.hidden = !f || !cur || cur === pendingRenameExt;
  });
  $("move-cancel")?.addEventListener("click", () => { closeModal("move-modal"); pendingMoveIds = []; });
  $("move-confirm")?.addEventListener("click", () => void confirmMove());
  $("empty-trash-btn")?.addEventListener("click", askEmptyTrash);

  // Details drawer
  $("details-close")?.addEventListener("click", closeDetails);
  $("details-backdrop")?.addEventListener("click", closeDetails);

  initPreview({ onDownloadFallback: (id) => {
    const f = allFiles.find((x) => x.id === id);
    if (f) void downloadPrivateFile(f);
  } });

  // Unified delete modal
  $("delete-cancel")?.addEventListener("click", () => {
    $("delete-modal")?.classList.remove("open");
    pendingTrashIds = []; pendingPurgeIds = []; deleteMode = null; window.__pendingFolderDelete = null;
  });
  $("delete-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "delete-modal") {
      $("delete-modal").classList.remove("open");
      pendingTrashIds = []; pendingPurgeIds = []; deleteMode = null; window.__pendingFolderDelete = null;
    }
  });
  $("delete-confirm")?.addEventListener("click", () => {
    if (deleteMode === "folder") { $("delete-modal")?.classList.remove("open"); deleteMode = null; void confirmFolderDelete(); }
    else void confirmDeleteModal();
  });

  document.querySelectorAll("[data-logout]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sb = getClient();
      if (sb) { try { await sb.auth.signOut(); } catch { /* ignore */ } }
      location.href = "login.html";
    });
  });

  window.addEventListener("hashchange", () => {
    applyHashMode();
    clearSelection();
    applyView();
    updateUsage();
  });

  initUpload({
    onDone: loadAll,
    getTarget: () => {
      if (!sessionUser) return null;
      return { folderId: currentFolderId, dir: buildDir(sessionUser.id, allFolders, currentFolderId) };
    },
    resolveName: (name, folderId) => {
      const siblings = filesInFolder(activeFiles(), folderId).map((x) => x.file_name);
      return uniqueDisplayName(name, siblings);
    },
  });

  $("retry-btn")?.addEventListener("click", loadAll);
  $("empty-upload-btn")?.addEventListener("click", () => $("file-input")?.click());
  $("upload-btn")?.addEventListener("click", () => $("file-input")?.click());
  $("upload-btn-mobile")?.addEventListener("click", () => $("file-input")?.click());

  applyHashMode();
  await loadAll();
  applyHashMode();
  applyView();
  updateUsage();
}

async function bulkDownload(ids) {
  const sb = getClient();
  if (!sb || !ids.length) return;
  const files = ids.map((id) => allFiles.find((x) => x.id === id)).filter(Boolean);
  if (files.length === 1) { void downloadPrivateFile(files[0]); return; }
  toast(`Downloading ${files.length} files one by one…`, "info");
  const queue = [...files];
  let done = 0;
  const workers = Array.from({ length: Math.min(BULK_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const f = queue.shift();
      const { data, error } = await sb.storage.from(BUCKET).download(f.file_path);
      if (error || !data) { toast(`Skipped “${f.file_name}”: ${error?.message || "download failed"}`, "error"); continue; }
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url; a.download = f.file_name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      done += 1;
    }
  });
  await Promise.all(workers);
  toast(`Downloaded ${done} of ${files.length} files.`, done === files.length ? "success" : "info");
}

document.addEventListener("DOMContentLoaded", init);
