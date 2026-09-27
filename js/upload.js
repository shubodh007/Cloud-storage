// CloudBox upload — multi-file queue, concurrency 2, honest indeterminate progress.
// supabase-js upload() exposes no byte-level progress, so status is Waiting /
// Uploading… / Uploaded / Failed — never a fabricated percentage.
// Collision safety: storage path is {uid}/{timestamp}-{name} (unique, no
// silent overwrite); the original filename is preserved in metadata/display.
import { getClient } from "./supabase.js";
import { validateFile, sanitizeFileName, escapeHtml, formatBytes, toast } from "./utils.js";

const BUCKET = "user-files";
const CONCURRENCY = 2;

export function initUpload({ onDone, getTarget, resolveName } = {}) {
  const input = document.getElementById("file-input");
  const drop = document.getElementById("dropzone");
  const browse = document.getElementById("browse-btn");
  if (!input || !drop) return;

  browse?.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    void handleFiles(input.files);
    input.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); })
  );
  drop.addEventListener("drop", (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length) void handleFiles(files);
  });
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  document.getElementById("queue-clear")?.addEventListener("click", clearFinished);

  async function handleFiles(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    const queue = document.getElementById("upload-list");
    document.getElementById("upload-queue")?.removeAttribute("hidden");

    const items = files.map((file) => {
      const err = validateFile(file);
      const row = document.createElement("div");
      row.className = "upload-item" + (err ? " error" : "");
      row.innerHTML = `<span class="uname"></span><span class="umeta"></span><span class="ustatus"></span>`;
      row.querySelector(".uname").textContent = file.name;
      row.querySelector(".umeta").textContent = formatBytes(file.size);
      setStatus(row, err ? "skipped" : "waiting", err || "Waiting");
      queue?.appendChild(row);
      updateClear();
      return { file, row, error: err };
    });

    // Concurrency-limited pool; one file's failure never fails the queue.
    const pending = items.filter((i) => !i.error);
    const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
      while (pending.length) {
        const item = pending.shift();
        // eslint-disable-next-line no-await-in-loop
        await uploadOne(item);
      }
    });
    await Promise.all(workers);
    updateClear();
    onDone?.();
  }

  function setStatus(row, status, text) {
    const el = row.querySelector(".ustatus");
    row.dataset.status = status;
    if (status === "uploading") {
      el.innerHTML = `<span class="spinner dark" aria-hidden="true"></span><span>Uploading…</span>`;
    } else {
      el.textContent = text;
    }
    const label = row.querySelector(".uname")?.textContent || "file";
    row.setAttribute("aria-label", `${label}: ${el.textContent}`);
  }

  function updateClear() {
    const rows = document.querySelectorAll("#upload-list .upload-item");
    const done = document.querySelectorAll('#upload-list .upload-item[data-status="success"], #upload-list .upload-item[data-status="failed"], #upload-list .upload-item[data-status="skipped"]');
    const btn = document.getElementById("queue-clear");
    if (btn) btn.hidden = !(rows.length && done.length);
  }

  function clearFinished() {
    document.querySelectorAll('#upload-list .upload-item[data-status="success"], #upload-list .upload-item[data-status="failed"], #upload-list .upload-item[data-status="skipped"]')
      .forEach((r) => r.remove());
    if (!document.querySelectorAll("#upload-list .upload-item").length) {
      document.getElementById("upload-queue")?.setAttribute("hidden", "");
    }
    updateClear();
  }

  async function uploadOne({ file, row }) {
    const sb = getClient();
    if (!sb) { row.classList.add("error"); setStatus(row, "failed", "Supabase is not configured."); return; }
    let user = null;
    try {
      ({ data: { user } } = await sb.auth.getUser());
    } catch { /* fall through to session check */ }
    if (!user) { toast("Session expired. Please log in again.", "error"); location.href = "login.html"; return; }

    setStatus(row, "uploading");
    // Upload into the current folder; display names auto-uniquified there.
    const target = (typeof getTarget === "function" && getTarget()) || { folderId: null, dir: user.id };
    const display = (typeof resolveName === "function" && resolveName(file.name, target.folderId)) || file.name;
    const safe = sanitizeFileName(display);
    const path = `${target.dir}/${Date.now()}-${safe}`;

    try {
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (upErr) throw upErr;

      const { error: dbErr } = await sb.from("files").insert({
        user_id: user.id,
        file_name: display,
        file_path: path,
        file_size: file.size,
        file_type: file.type || "application/octet-stream",
        folder_id: target.folderId || null,
      });
      if (dbErr) {
        await sb.storage.from(BUCKET).remove([path]).catch(() => {});
        throw dbErr;
      }
      setStatus(row, "success", "Uploaded");
      toast(`“${display}” uploaded.`, "success");
      setTimeout(() => { if (row.isConnected && row.dataset.status === "success") { row.remove(); updateClear(); } }, 6000);
    } catch (e) {
      row.classList.add("error");
      setStatus(row, "failed", e?.message || "Upload failed.");
    }
  }
}
