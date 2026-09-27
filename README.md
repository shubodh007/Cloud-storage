# CloudBox

Cloud-based file storage & management: register, log in, upload, list, search, download, delete — with per-user isolation enforced by Supabase, not by UI checks.

Vanilla **HTML + CSS + JavaScript** → **Supabase** (Auth, PostgreSQL, Storage). No custom backend. No AI features. Local-working phase (no GitHub/Vercel deployment in this phase).

## Architecture

```
Browser → CloudBox UI → Supabase Auth / PostgreSQL / Storage
```

- **Auth** → identity + sessions.
- **PostgreSQL (`files`)** → metadata only (name, path, size, type, timestamp).
- **Storage (`user-files`, private)** → actual bytes at `{user_id}/{timestamp}-{filename}`.

## Features

Register · Login · Logout · Session guards · Folders (create/open/rename/delete, breadcrumbs, upload-into-folder) · Rename + Move (storage+metadata sync with rollback) · Bulk select + bulk move/delete/download (partial-failure honest) · Trash (soft-delete, restore-to-original, permanent delete, empty trash) · Upload queue (multi-file, concurrency 2, per-file Waiting/Uploading/Success/Failed) · File list + grid views (preference in localStorage) · Instant filename search · Type filter (PDF/Images/Documents/Text/Archives) · 8-way sort · File preview (PDF, Word/DOCX, images, text via private-blob modal; honest "Preview unavailable" for ZIP etc.) · File details drawer · Download (authenticated) · Real storage bar + category breakdown (trash included) · Recent files (5 newest, trash excluded) · Loading/empty/error/success states · Responsive + keyboard accessible.

Out of scope: sharing, public links, folders, versioning, encryption layer, analytics, AI.

## Tech stack

| Piece | Why |
|---|---|
| Vanilla HTML/CSS/JS | Zero build, explainable in viva, fastest load |
| Supabase Auth | Email/password sessions without storing passwords |
| Supabase PostgreSQL + RLS | Metadata with row-level ownership (`auth.uid() = user_id`) |
| Supabase Storage + policies | Private bytes under `{uid}/…`, same ownership check |
| Inter, flat blue/neutral UI | Dense Drive-like utility, no AI-slop decoration |

Why cloud instead of local disk? Remote access from any browser, managed availability/scaling, and server-enforced access control.

## Database schema

`public.files(id UUID PK, user_id UUID → auth.users, file_name TEXT, file_path TEXT, file_size BIGINT, file_type TEXT, uploaded_at TIMESTAMPTZ)`, indexed on `(user_id, uploaded_at desc)`.

## Storage structure

Private bucket `user-files`: `8e1f…/169…-resume.pdf`. Frontend never guesses another user's path; policies deny it anyway.

## Security model

- RLS on `files`: SELECT/INSERT/UPDATE/DELETE own rows only.
- Storage policies on `storage.objects` (`bucket_id='user-files'`): path prefix must equal `auth.uid()`.
- Browser holds **anon key only**. `service_role`, passwords, secrets never appear in frontend (grep-verified).
- Frontend ownership checks are UX; PostgreSQL + Storage are the boundary.

## Environment variables

`.env` is the single source of truth. It is gitignored and never pushed to git.
The static frontend cannot read `.env` at runtime (no build step), so sync it
into the gitignored runtime config the app actually loads:

```powershell
Copy-Item .env.example .env
# edit SUPABASE_URL + SUPABASE_ANON_KEY inside .env, then:
powershell -ExecutionPolicy Bypass -File .\sync-config.ps1
npx serve .
```

Safe to commit: `.env.example`, `js/supabase-config.example.js` (placeholders only).
Never committed: `.env`, `js/supabase-config.js` (both in `.gitignore`).
Deploying elsewhere later? Recreate the same two values as env/config on the host —
never copy a real key into a committed file.

## Supabase setup (manual, ~5 min)

1. Create a project at supabase.com.
2. **SQL Editor** → run `supabase-setup.sql` (table + RLS + bucket + storage policies).
3. **Authentication** → enable Email provider. Class demo: turn confirm-email OFF for instant sign-in.
4. Verify: Table Editor shows `files` with RLS enabled; Storage shows private `user-files`.

## Local run

```powershell
npx serve .
# open http://localhost:3000  (index, login, register, dashboard)
```

Without Supabase configured, pages load with a setup banner and no fake data.

## Folders, rename, move, trash

- **Folders** live in a `folders` table (`id, user_id, name, parent_id`, NULL parent = My Files root), RLS `auth.uid() = user_id` on all ops. Storage path: `{uid}/{Folder/Sub/…}/{ts}-{name}`; `files.file_path` always equals the real object path, `files.folder_id` links the row. Uploads land in the open folder; names auto-uniquify (`a (1).pdf`). Non-empty folders cannot be deleted. Folder rename moves each descendant object one-by-one via the Storage API (retry-safe: only mismatched paths move).
- **Rename/Move** use `storage.move()` then update `files` metadata; on DB failure the object is moved back (compensating rollback) and partial failure is reported, never claimed as success. Collisions block with a message; extensions preserved unless intentionally changed (type label follows).
- **Bulk**: checkboxes + toolbar (count, Download/Move/Delete). Bulk download = individual authenticated downloads, concurrency 2 (no ZIP dependency). Per-file results; partial failures listed.
- **Trash** is soft-delete (`deleted_at`, original folder/path remembered; Option A — objects stay put). Delete → Trash; Trash view (`#trash`) supports search/sort/filter, restore (original folder, or My Files with a note if gone; collisions restore as `name (restored).ext`), permanent delete (storage object then metadata), empty trash with counts. Trashed files still count toward the 1 GB assumption; recents/search exclude trash. No `storage.objects` SQL anywhere — Storage API only.

## File preview

PDF, images and text render directly from the private-storage blob. **Word (.docx)**
is converted in-browser with Mammoth (lazy-loaded only on first DOCX View —
pinned `mammoth@1.13.0` browser build, ~400 KB, zero backend), then sanitized
with DOMPurify (`dompurify@3.4.16`) under a strict allowlist before rendering:
document tags only (headings, paragraphs, lists, tables, images, links, basic
inline styles); scripts, forms, iframes, SVG, event handlers and `style`
attributes are dropped; URLs are restricted to `https:`/`mailto:`/`tel:`/page
anchors plus our own `blob:` image URLs; external links get
`target="_blank" rel="noopener noreferrer"`. DOCX images become tracked
`blob:` URLs (revoked on close); nothing is fetched from the network except the
file itself. View-only — no editing.

Limitations: not pixel-perfect Word rendering (a note says so when Mammoth
reports warnings); `.doc`/`.odt`/`.rtf` and ZIP stay "Preview unavailable";
files over 15 MB are not previewed (Download instead); if the CDN libraries
cannot load, preview degrades to the same Download fallback.

## Testing

With Supabase configured: register → reload (session persists) → login → dashboard guard (unauth redirects) → upload PDF/JPG/DOCX (correct size/date) → search filters instantly → download byte-identical → delete with confirm updates list + usage → logout blocks dashboard. Security: User A/B see only own rows/objects; `grep -r service_role` → 0 hits. Without Supabase: only page-load, layout, banner, and keyboard checks are verifiable.

## Cloud concepts demonstrated

Storage → Supabase Storage · Database → PostgreSQL · Auth → Supabase Auth · Hosting → any static host · Remote access → browser + internet · Access control → RLS + storage policies · Scalability/availability → managed cloud services.

## Viva Q&A (short)

- **Why Supabase?** One managed place for auth + database + storage with policy enforcement.
- **Why PostgreSQL?** Structured metadata + RLS ownership per row.
- **Why Storage, not DB, for files?** Databases store metadata well; object storage stores bytes well.
- **Why RLS?** Rules live in the database so a malicious client can't bypass them.
- **Why 1 GB bar?** App-level demo assumption (labeled in UI), computed from real `SUM(file_size)` — not a Supabase quota claim.
- **Upload if metadata insert fails?** Orphaned object is removed best-effort; UI never claims false success.
- **Progress %?** supabase-js v2 exposes none, so the UI shows honest indeterminate `Uploading…`.

## Future enhancements

Sharing/links, folders, versioning, encryption, multi-provider, duplicate detection, admin, analytics — deliberately excluded for now.
