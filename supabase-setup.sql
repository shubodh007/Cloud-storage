-- CloudBox Supabase setup — run in Supabase Dashboard > SQL Editor.
-- MANUAL STEP (cannot be automated from the local project).
-- Run the whole file top-to-bottom, then configure Auth (note at the end).

-- 1) Metadata tables -------------------------------------------------------
-- files.file_path MUST always equal the real Storage object path.
-- folders form a user-owned tree (parent_id NULL = My Files root).
-- Trash is soft-delete: deleted_at IS NULL = active. Trashed Storage
-- objects stay in place (Option A), so trash still counts toward quota.
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade not null,
  file_name text not null,
  file_path text not null,
  file_size bigint not null check (file_size >= 0),
  file_type text,
  uploaded_at timestamptz default now() not null,
  folder_id uuid references public.folders (id) on delete set null,
  deleted_at timestamptz,
  original_folder_id uuid,
  original_file_path text
);

create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade not null,
  name text not null check (char_length(name) between 1 and 80),
  parent_id uuid references public.folders (id) on delete cascade,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index if not exists files_user_id_idx on public.files (user_id);
create index if not exists files_uploaded_at_idx on public.files (uploaded_at desc);
create index if not exists files_user_folder_idx on public.files (user_id, folder_id);
create index if not exists files_deleted_idx on public.files (user_id, deleted_at);
create index if not exists folders_user_parent_idx on public.folders (user_id, parent_id);

alter table public.files enable row level security;
alter table public.folders enable row level security;

-- 2) RLS: users touch only their own rows ----------------------------------
drop policy if exists "files_select_own" on public.files;
create policy "files_select_own" on public.files
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "files_insert_own" on public.files;
create policy "files_insert_own" on public.files
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "files_update_own" on public.files;
create policy "files_update_own" on public.files
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "files_delete_own" on public.files;
create policy "files_delete_own" on public.files
  for delete to authenticated using (auth.uid() = user_id);

-- Folders: same ownership model (auth.uid() = user_id on all ops).
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

-- 3) Private storage bucket -------------------------------------------------
insert into storage.buckets (id, name, public)
values ('user-files', 'user-files', false)
on conflict (id) do nothing;

-- 4) Storage policies: path is {auth.uid()}/{...} ---------------------------
-- storage.foldername(name) returns path segments; [1] is the user-id prefix.
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

-- 5) Auth settings (Dashboard > Authentication > Settings) -------------------
-- Providers > Email: ON. For a class demo, "Confirm email" can be OFF so
-- signUp() signs the user in immediately; keep it ON for real use.
