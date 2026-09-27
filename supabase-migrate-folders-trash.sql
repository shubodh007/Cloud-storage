-- CloudBox migration: folders + trash — run in Supabase Dashboard > SQL Editor.
-- MANUAL STEP. Run AFTER supabase-setup.sql has been applied once.
-- Safe to re-run (all statements are idempotent).

-- 1) Folders table -----------------------------------------------------------
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade not null,
  name text not null check (char_length(name) between 1 and 80),
  parent_id uuid references public.folders (id) on delete cascade,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index if not exists folders_user_parent_idx on public.folders (user_id, parent_id);
alter table public.folders enable row level security;

drop policy if exists "folders_select_own" on public.folders;
create policy "folders_select_own" on public.folders
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "folders_insert_own" on public.folders;
create policy "folders_insert_own" on public.folders
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "folders_update_own" on public.folders;
create policy "folders_update_own" on public.folders
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "folders_delete_own" on public.folders;
create policy "folders_delete_own" on public.folders
  for delete to authenticated using (auth.uid() = user_id);

-- 2) Files: folder link + soft-delete (trash) --------------------------------
-- Option A trash: the Storage object stays in place; deleted_at marks Trash.
-- Trashed files keep counting toward quota until permanently deleted.
alter table public.files
  add column if not exists folder_id uuid references public.folders (id) on delete set null,
  add column if not exists deleted_at timestamptz,
  add column if not exists original_folder_id uuid,
  add column if not exists original_file_path text;

create index if not exists files_user_folder_idx on public.files (user_id, folder_id);
create index if not exists files_deleted_idx on public.files (user_id, deleted_at);

-- Existing files_*_own policies (auth.uid() = user_id on all ops) already
-- cover the new columns — no files policy change needed.

-- 3) Storage policies (re-asserted idempotently) ------------------------------
-- Paths stay {uid}/... (folders add deeper segments; [1] is still the uid).
-- move() needs SELECT + UPDATE, both present below. No new ownership system.
drop policy if exists "storage_select_own" on storage.objects;
create policy "storage_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'user-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "storage_insert_own" on storage.objects;
create policy "storage_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'user-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "storage_update_own" on storage.objects;
create policy "storage_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'user-files' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'user-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "storage_delete_own" on storage.objects;
create policy "storage_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'user-files' and (storage.foldername(name))[1] = auth.uid()::text);
