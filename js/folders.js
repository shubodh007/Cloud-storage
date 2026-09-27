// CloudBox folders + path-sync helpers.
// Pure helpers are import-free and headless-testable. Data-layer functions
// take the authenticated Supabase client (sb) — RLS stays the authority.
// NEVER touch storage.objects via SQL; all object moves go through the
// Storage API, then files.metadata is updated to match. file_path MUST
// always equal the real object path.
import { sanitizeFileName } from "./utils.js";

export const MAX_FOLDER_LEN = 80;

// null/undefined/"" = root ("My Files").
export function isRoot(id) {
  return id === null || id === undefined || id === "";
}

export function validateFolderName(raw, siblingNames) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  if (!name) return "Folder name is required.";
  if (name.length > MAX_FOLDER_LEN) return `Keep folder names under ${MAX_FOLDER_LEN} characters.`;
  if (name === "." || name === "..") return "That name is reserved.";
  if (/[\\/]/.test(name) || /\.\./.test(name)) return "Names cannot contain slashes or “..”.";
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1F\x7F]/.test(name)) return "That name contains invalid characters.";
  const taken = new Set((siblingNames || []).map((n) => String(n).toLowerCase()));
  if (taken.has(name.toLowerCase())) return "A folder with this name already exists here.";
  return null;
}

// Validate a new FILE display name inside one folder (rename/move targets).
export function validateFileName(raw, siblingNames, originalExt) {
  const name = sanitizeFileName(raw).trim();
  if (!name) return "File name is required.";
  if (name === "." || name === "..") return "That name is reserved.";
  if (name.length > 180) return "Keep file names under 180 characters.";
  const taken = new Set((siblingNames || []).map((n) => String(n).toLowerCase()));
  if (taken.has(name.toLowerCase())) return "A file with this name already exists in this folder.";
  if (originalExt) {
    const cur = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (cur && cur !== originalExt.toLowerCase()) return `Extension changes from .${originalExt} to .${cur} — rename keeps the original extension unless you confirm.`;
  }
  return null;
}

// Chain of folder rows from root to the given id (cycle-guarded).
export function folderChain(folders, folderId) {
  const byId = new Map((folders || []).map((f) => [f.id, f]));
  const chain = [];
  const seen = new Set();
  let cur = isRoot(folderId) ? null : byId.get(folderId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = isRoot(cur.parent_id) ? null : byId.get(cur.parent_id);
  }
  return chain;
}

export function pathSafeSegment(name) {
  return String(name || "").trim().replace(/[\\/]+/g, "-").replace(/\s+/g, " ").slice(0, MAX_FOLDER_LEN);
}

// Storage directory for a folder: "{uid}" or "{uid}/College/Notes".
export function buildDir(userId, folders, folderId) {
  const segs = folderChain(folders, folderId).map((f) => pathSafeSegment(f.name)).filter(Boolean);
  return segs.length ? `${userId}/${segs.join("/")}` : `${userId}`;
}

export function storagePathFor(userId, folders, folderId, storedName) {
  return `${buildDir(userId, folders, folderId)}/${storedName}`;
}

export function breadcrumbNames(folders, folderId) {
  return folderChain(folders, folderId).map((f) => f.name);
}

// All descendant folder ids including self (for renames / emptiness checks).
export function subtreeIds(folders, folderId) {
  const kids = new Map();
  for (const f of folders || []) {
    const p = isRoot(f.parent_id) ? null : f.parent_id;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(f.id);
  }
  const out = new Set();
  const start = isRoot(folderId) ? null : folderId;
  if (start) out.add(start);
  const stack = [start];
  while (stack.length) {
    for (const id of kids.get(stack.pop()) || []) {
      if (!out.has(id)) { out.add(id); stack.push(id); }
    }
  }
  return out;
}

export function childFolders(folders, parentId) {
  const p = isRoot(parentId) ? null : parentId;
  return (folders || [])
    .filter((f) => (isRoot(f.parent_id) ? null : f.parent_id) === p)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base", numeric: true }));
}

// Active (non-deleted) files directly in a folder. deleted-aware.
export function filesInFolder(files, folderId, { includeDeleted = false } = {}) {
  const p = isRoot(folderId) ? null : folderId;
  return (files || []).filter((f) => {
    const fp = isRoot(f.folder_id) ? null : f.folder_id;
    if (fp !== p) return false;
    if (!includeDeleted && f.deleted_at) return false;
    return true;
  });
}

/* ---------- data layer (RLS-enforced via sb) ---------- */
export async function listFolders(sb) {
  const { data, error } = await sb
    .from("folders")
    .select("id, name, parent_id, created_at, updated_at")
    .order("name", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createFolderRow(sb, userId, name, parentId) {
  const { data, error } = await sb
    .from("folders")
    .insert({ user_id: userId, name, parent_id: isRoot(parentId) ? null : parentId })
    .select("id, name, parent_id, created_at, updated_at")
    .single();
  if (error) throw error;
  return data;
}

export async function renameFolderRow(sb, id, name) {
  const { error } = await sb
    .from("folders")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteFolderRow(sb, id) {
  const { error } = await sb.from("folders").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Move one Storage object, then update its files row to match.
 * On DB failure, moves the object back (compensating rollback).
 * Returns { ok:true } or { ok:false, error, rolledBack:boolean }.
 */
export async function moveObjectWithDbSync(sb, bucket, fileId, oldPath, newPath, patch) {
  if (oldPath === newPath) return { ok: true };
  const { error: mvErr } = await sb.storage.from(bucket).move(oldPath, newPath);
  if (mvErr) return { ok: false, error: mvErr.message, rolledBack: true };
  const { error: dbErr } = await sb.from("files").update({ ...patch, file_path: newPath }).eq("id", fileId);
  if (dbErr) {
    const { error: backErr } = await sb.storage.from(bucket).move(newPath, oldPath);
    return { ok: false, error: dbErr.message, rolledBack: !backErr };
  }
  return { ok: true };
}
