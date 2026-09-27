# CloudBox — implementation record

## Goal
Local-working vanilla HTML/CSS/JS cloud file-storage app: Auth + PostgreSQL metadata + Storage, user-isolated, Drive-dense UI.

## Design stance
Industrial-utilitarian productivity. Differentiation anchor: dense file table with mono size/date + compact topbar — memorable through craft, not decoration. Tokens: `#2563EB/#1D4ED8`, `#F8FAFC/#FFFFFF/#0F172A/#64748B/#E2E8F0`, Inter. Flat surfaces; the single `linear-gradient(135deg,#2563EB,#4F46E5)` accent lives only on the landing preview strip.

## Tasks
- [x] Scaffold: `index/login/register/dashboard.html`, `css/{style,auth,dashboard}.css`, `js/{supabase,auth,dashboard,upload,utils}.js`, `supabase-config.example.js`, `.env.example`, `.gitignore`, `supabase-setup.sql`
- [x] Supabase kit prepared (`supabase-setup.sql`): `files` table + RLS (select/insert/update/delete own via `auth.uid()=user_id`) + private `user-files` bucket + 4 storage policies on `{uid}/…` prefix
- [x] Client: `supabase.js` (anon key only, missing-config mode), `auth.js` (register/login/logout/guards, human errors)
- [x] Landing + auth UI with normal/focus/loading/validation/auth-error states
- [x] Dashboard: 220px sidebar, topbar (Hello/search/upload), real storage bar (SUM of metadata, 1 GB app assumption), table + mobile rows, drawer
- [x] Upload (browse + drag-drop, type/size validation, storage→metadata with orphan cleanup, honest indeterminate `Uploading…` — no fake %)
- [x] List/search (client filter)/download (authenticated `storage.download` blob, no public URLs)/delete (confirm → storage.remove → db delete, no optimistic removal)
- [x] QA + docs (this file + README)

## Expansion pass (8 features, same architecture, no new deps)
- Preview (`js/preview.js`): private `storage.download()` blob → embed/img/text modal; ZIP/DOCX show "Preview unavailable" + Download; object URLs revoked on close/replace; Escape/backdrop close; focus returned to trigger.
- Sort: 8 options (name/modified/size/type × asc/desc), default newest-first; `localeCompare` base+numeric; local only.
- Type filter: All/PDF/Images/Documents/Text/Archives via single `fileCategory()` (MIME first, extension fallback); combines with search + sort, zero extra queries.
- Details: right drawer (bottom sheet mobile) with real metadata + View/Download/Delete; shows own storage path, no tokens/IDs beyond row id already in DOM.
- List/Grid: toggle persisted in localStorage; grid 4→2 cols; image thumbnails only ≤5 MB, cached per session, revoked on reload; docs use icons.
- Upload queue: multi-select, Waiting/Uploading/Uploaded/Failed/Skipped per file, concurrency 2, partial failures isolated, per-file orphan cleanup, unique `{uid}/{ts}-{name}` paths (no silent overwrite, display name preserved), no fake %.
- Storage breakdown: sidebar segmented bar + legend from real category sums; over-quota warning past 1 GB assumption.
- Recent files: 5 newest by `uploaded_at` with relative time; click opens preview (or details if unsupported).

## Folders / rename / move / bulk / trash (same architecture, no new deps)
- DB: `folders(id, user_id, name, parent_id, created_at, updated_at)` + RLS own-only; `files` gains `folder_id` (ON DELETE SET NULL), `deleted_at`, `original_folder_id`, `original_file_path`. Existing `files_*_own` + storage policies already cover the new flows (`move()` needs SELECT+UPDATE, both present) — no policy weakening, no `storage.objects` SQL. Fresh installs: `supabase-setup.sql`; existing DBs: run `supabase-migrate-folders-trash.sql` (idempotent).
- Paths stay `{uid}/{Folder/Sub/…}/{ts}-{name}`; `file_path` always equals the real object. Rename/move = `storage.move()` + metadata update, with move-back rollback on DB failure. Folder rename moves descendants one-by-one (retry-safe). Uploads target the open folder with display-name uniquifying.
- Trash = Option A soft-delete (objects stay, still count toward quota). Delete→Trash; restore returns to original folder (fallback My Files + note; collisions get ` (restored)` names); permanent delete removes object then metadata; empty trash with ok/failed counts. Non-empty folders cannot be deleted. Recents/search exclude trash; breakdown includes it.
- Headless tests (24/24): folder validation, chains, dirs, subtrees, scoping, split/mime/uniquify. All pages + new SQL serve 200; `node --check` clean; 33/33 dashboard IDs; no `storage.objects` SQL / `getPublicUrl` / privileged keys in code.
- NOT headless-verifiable: browser flows (create/navigate/rename/move/bulk/trash/restore), two-user isolation (A-vs-B folders/files/rename/move/delete/restore), responsive + a11y passes — needs human browser test. Also requires running the migration SQL first (app degrades gracefully with a notice until then).

## DOCX preview (no backend, no public bucket)
- Pinned browser builds, lazy-loaded on first DOCX View only: `mammoth@1.13.0/mammoth.browser.min.js`, `dompurify@3.4.16/dist/purify.min.js` (jsdelivr). Listing/search/grid never fetch them.
- Flow: authenticated `storage.download()` → `arrayBuffer` → `mammoth.convertToHtml` (custom `convertImage` mints tracked `blob:` URLs; no `data:` URIs) → `sanitizeDocxHtml()` (DOMPurify + strict tag/attr allowlist + `SAFE_URL` scheme policy + link/img hardening hooks) → document-styled `.docx-doc` surface. Raw Mammoth HTML never touches `innerHTML`.
- Why the dependency: hand-rolled regex sanitizers are unsafe; DOMPurify is the established browser sanitizer. Sanitizer module (`js/docx-sanitize.js`) is import-free so the exact production config is unit-tested.
- Cleanup: all blob/object URLs revoked on close or when another preview opens; failures show "Unable to preview this Word document" + Download, raw errors only in console; >15 MB skipped to Download.
- Headless tests (33/33, temp `cb-docx-test`, fixtures built as minimal valid OOXML): headings/bold/italic/lists/tables/hyperlinks/images convert; sanitizer audited attribute-level against evil docx + hostile-HTML gauntlet (script/handlers/iframes/forms/svg, javascript:/data:/vbscript: URLs all dead; safe https: link kept + hardened); malformed bytes reject; 300-para doc converts; `isDocx`/`isPreviewable` flags correct; ZIP/`.doc` still unsupported.
- NOT headless-verifiable: real browser render, repeated open/close soak, mobile viewport, and User-A-vs-B DOCX denial — needs human browser test. Denial relies on the unchanged authenticated `storage.download()` + RLS path (same as Download); no policy was weakened.

## Manual Supabase setup (required, ~5 min)
1. Create project at supabase.com → copy Project URL + `anon` key.
2. Put them in `.env` (copy of `.env.example`), then run `.\sync-config.ps1` — this generates gitignored `js/supabase-config.js` from `.env`. Re-run after any `.env` edit.
3. SQL Editor → paste + run `supabase-setup.sql`. If you set up before folders/trash existed, also run `supabase-migrate-folders-trash.sql` (idempotent).
4. Authentication → Email provider ON. For class demo, confirm-email OFF gives instant sign-in.
5. `npx serve .` → register → upload → search → download → delete.

## Git safety
`.env` + `js/supabase-config.js` are gitignored. Verified: no committable file contains real `.env` values. Only placeholders ship in `.env.example` / `supabase-config.example.js`.

## Verification status (honest)
- Local static: 4 pages + all CSS/JS (incl. `preview.js`) serve HTTP 200; `node --check` passes on all 6 JS files; `fileCategory` unit-tested in node (7/7 + previewable flags + relative time); all 29 dashboard element IDs cross-checked present.
- Supabase reachability (verified via REST, values redacted): `files` table HTTP 200 `[]`, `user-files` bucket HTTP 200 — table + bucket exist.
- Security static checks: 0 `service_role` / `getPublicUrl` / `upsert:true` in code; 0 fabricated `%` in upload/preview/dashboard; no committable file contains real `.env` values.
- Still needs human browser test (register → upload → preview/sort/filter/details/grid/queue/breakdown/recents → download → delete) and the two-user A-vs-B isolation test — cannot be done headless from here.

## Decisions
- Browser → Supabase directly; no custom backend (spec §5).
- `storage.download()` blobs over public URLs (private bucket stays private).
- Delete order: storage first, then metadata; upload order: storage then metadata with orphan cleanup.
- Client search over loaded metadata (no search infra for this scale).
- 1 GB quota is an app-level demo assumption, labeled as such in UI footer + README.
