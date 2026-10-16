-- Telegram Cloud Drive - database schema.
-- Run this file once in Supabase -> SQL Editor.
--
-- Safe to run again: every statement is "if not exists" / "create or replace", and the whole script runs as ONE
-- transaction, so if anything fails nothing is half-created. Running it twice never gives "already exists" errors.
-- Updating a database created by an older release? Use supabase/upgrade_existing.sql instead.
--
-- All access goes through the Deno backend with the service-role key.
-- Row-level security is enabled on every table and no policies exist, so the public (anon) key can read nothing.

begin;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ------------------------------------------------------------------ tables

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  username text,
  first_name text,
  login_username text,
  password_hash text,
  password_salt text,
  password_iterations integer not null default 600000,
  password_enabled boolean not null default false,
  session_version integer not null default 1,        -- bump to sign out every device
  created_at timestamptz not null default now()
);
create unique index if not exists users_login_username_uq on users (lower(login_username)) where login_username is not null;

create table if not exists folders (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references folders (id) on delete set null,
  name text not null check (length(name) between 1 and 100),
  copied_from_folder_id uuid references folders (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists folders_root_name_uq on folders (lower(name)) where parent_id is null;
create unique index if not exists folders_nested_name_uq on folders (parent_id, lower(name)) where parent_id is not null;

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references folders (id) on delete set null,
  file_name text not null,
  file_size bigint not null default 0,
  mime_type text,
  extension text,
  media_type text not null,
  telegram_chat_id bigint not null,                  -- storage channel
  telegram_message_id bigint not null,               -- message inside the storage channel
  telegram_file_id text not null,
  telegram_file_unique_id text,
  source_chat_id bigint not null,                    -- where the file was originally sent from
  source_message_id bigint not null,
  media_group_id text,
  caption text,
  copy_of_file_id uuid references files (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'trashed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- A logical copy shares the Telegram message of its original, so only originals are unique per source message.
create unique index if not exists files_original_source_uq on files (source_chat_id, source_message_id) where copy_of_file_id is null;
create index if not exists files_name_trgm_idx on files using gin (file_name gin_trgm_ops);
create index if not exists files_created_idx on files (created_at desc);
create index if not exists files_folder_status_idx on files (folder_id, status);
create index if not exists files_status_folder_created_idx on files (status, folder_id, created_at desc);
create index if not exists files_media_type_idx on files (media_type);
create index if not exists files_mime_idx on files (mime_type text_pattern_ops);
create index if not exists files_extension_idx on files (extension);
create index if not exists files_size_idx on files (file_size);
create index if not exists files_deleted_idx on files (deleted_at) where status = 'trashed';
create index if not exists files_copy_of_idx on files (copy_of_file_id) where copy_of_file_id is not null;
create index if not exists files_message_idx on files (telegram_chat_id, telegram_message_id);
create index if not exists files_unique_id_idx on files (telegram_file_unique_id) where copy_of_file_id is null;

-- Share links: only the hash is searchable; the token itself is stored AES-GCM encrypted by the backend.
create table if not exists shares (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files (id) on delete cascade,
  token_hash text not null unique,
  share_token_enc text,
  created_at timestamptz not null default now()
);
create index if not exists shares_file_idx on shares (file_id);

create table if not exists favorites (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (file_id)
);

create table if not exists activity_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  file_id uuid references files (id) on delete set null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists activity_logs_created_idx on activity_logs (created_at desc);

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Failed sign-in counters (per account, per address, global). Shared by every backend instance.
create table if not exists login_attempts (
  key text primary key,
  failures integer not null default 0,
  window_ends_at timestamptz not null
);

-- If a previous attempt left older copies of these tables behind, make sure the newer columns exist.
alter table users add column if not exists password_iterations integer not null default 600000;
alter table users add column if not exists session_version integer not null default 1;
alter table shares add column if not exists share_token_enc text;

alter table users enable row level security;
alter table folders enable row level security;
alter table files enable row level security;
alter table shares enable row level security;
alter table favorites enable row level security;
alter table activity_logs enable row level security;
alter table settings enable row level security;
alter table login_attempts enable row level security;

-- --------------------------------------------------------------- functions
-- Multi-step operations run inside one transaction so a failure never leaves half-finished data.

create or replace function cloud_drive_dashboard()
returns table (active_files bigint, active_bytes numeric, folder_count bigint, trash_count bigint)
language sql stable security definer set search_path = public as $$
  select
    (select count(*) from files where status = 'active'),
    coalesce((select sum(file_size) from files where status = 'active'), 0),
    (select count(*) from folders),
    (select count(*) from files where status = 'trashed');
$$;

create or replace function register_login_failure(p_key text, p_window_seconds integer)
returns integer
language sql security definer set search_path = public as $$
  insert into login_attempts as la (key, failures, window_ends_at)
  values (p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (key) do update set
    failures = case when la.window_ends_at < now() then 1 else la.failures + 1 end,
    window_ends_at = case when la.window_ends_at < now() then now() + make_interval(secs => p_window_seconds) else la.window_ends_at end
  returning failures;
$$;

-- Deletes a folder: its files and subfolders move up one level and the "incoming folder" setting is reset if needed.
create or replace function delete_folder(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_parent uuid;
begin
  select parent_id into v_parent from folders where id = p_id;
  if not found then
    raise exception 'folder_not_found' using errcode = 'P0002';
  end if;
  update files set folder_id = v_parent, updated_at = now() where folder_id = p_id;
  update folders set parent_id = v_parent, updated_at = now() where parent_id = p_id;
  delete from settings where key = 'incoming_folder_id' and value = to_jsonb(p_id::text);
  delete from folders where id = p_id;
end;
$$;

-- Copies a folder with all subfolders and (logical) copies of the active files inside.
create or replace function copy_folder(p_id uuid, p_parent uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_src folders%rowtype;
  v_name text;
  v_suffix integer := 2;
  v_row record;
  v_new uuid;
  v_root uuid;
begin
  select * into v_src from folders where id = p_id;
  if not found then
    raise exception 'folder_not_found' using errcode = 'P0002';
  end if;
  if p_parent is not null and not exists (select 1 from folders where id = p_parent) then
    raise exception 'destination_not_found' using errcode = 'P0002';
  end if;

  v_name := v_src.name || ' (copy)';
  while exists (select 1 from folders where parent_id is not distinct from p_parent and lower(name) = lower(v_name)) loop
    v_name := v_src.name || ' (copy ' || v_suffix || ')';
    v_suffix := v_suffix + 1;
  end loop;

  create temporary table _folder_map (old_id uuid primary key, new_id uuid not null) on commit drop;

  for v_row in
    with recursive tree as (
      select id, parent_id, name, 0 as depth from folders where id = p_id
      union all
      select f.id, f.parent_id, f.name, tree.depth + 1 from folders f join tree on f.parent_id = tree.id
    )
    select * from tree order by depth
  loop
    insert into folders (name, parent_id, copied_from_folder_id)
    values (
      case when v_row.depth = 0 then v_name else v_row.name end,
      case when v_row.depth = 0 then p_parent else (select new_id from _folder_map where old_id = v_row.parent_id) end,
      v_row.id
    )
    returning id into v_new;
    insert into _folder_map values (v_row.id, v_new);
  end loop;

  insert into files (folder_id, file_name, file_size, mime_type, extension, media_type, telegram_chat_id, telegram_message_id,
                     telegram_file_id, telegram_file_unique_id, source_chat_id, source_message_id, media_group_id, caption, copy_of_file_id, status)
  select m.new_id, f.file_name, f.file_size, f.mime_type, f.extension, f.media_type, f.telegram_chat_id, f.telegram_message_id,
         f.telegram_file_id, f.telegram_file_unique_id, f.source_chat_id, f.source_message_id, f.media_group_id, f.caption, f.id, 'active'
  from files f join _folder_map m on m.old_id = f.folder_id
  where f.status = 'active';

  select new_id into v_root from _folder_map where old_id = p_id;
  return v_root;
end;
$$;

-- Permanently deletes one file row. Copies share the original's Telegram message, so the message may only be removed
-- from the channel when no other row still points at it ("orphaned").
create or replace function purge_file(p_id uuid)
returns table (tg_chat_id bigint, tg_message_id bigint, orphaned boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_file files%rowtype;
  v_heir uuid;
begin
  select * into v_file from files where id = p_id for update;
  if not found then
    return;
  end if;

  if v_file.copy_of_file_id is null then
    -- The oldest copy becomes the new original, so the rest keep pointing at a real row.
    select id into v_heir from files where copy_of_file_id = p_id order by created_at, id limit 1;
    if v_heir is not null then
      update files set copy_of_file_id = v_heir where id = p_id;
      update files set copy_of_file_id = null where id = v_heir;
      update files set copy_of_file_id = v_heir where copy_of_file_id = p_id;
    end if;
  else
    update files set copy_of_file_id = v_file.copy_of_file_id where copy_of_file_id = p_id;
  end if;

  delete from files where id = p_id;

  tg_chat_id := v_file.telegram_chat_id;
  tg_message_id := v_file.telegram_message_id;
  orphaned := not exists (
    select 1 from files where telegram_chat_id = v_file.telegram_chat_id and telegram_message_id = v_file.telegram_message_id
  );
  return next;
end;
$$;

-- Permanently deletes trashed files (all, or only those trashed before p_older_than).
create or replace function purge_trashed_files(p_older_than timestamptz default null)
returns table (tg_chat_id bigint, tg_message_id bigint, orphaned boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  for v_id in
    select id from files where status = 'trashed' and (p_older_than is null or deleted_at < p_older_than) order by deleted_at, id
  loop
    return query select * from purge_file(v_id);
  end loop;
end;
$$;

-- Only the backend (service role) may call these functions; the public API keys may not.
revoke execute on function cloud_drive_dashboard() from public, anon, authenticated;
revoke execute on function register_login_failure(text, integer) from public, anon, authenticated;
revoke execute on function delete_folder(uuid) from public, anon, authenticated;
revoke execute on function copy_folder(uuid, uuid) from public, anon, authenticated;
revoke execute on function purge_file(uuid) from public, anon, authenticated;
revoke execute on function purge_trashed_files(timestamptz) from public, anon, authenticated;
grant execute on function cloud_drive_dashboard() to service_role;
grant execute on function register_login_failure(text, integer) to service_role;
grant execute on function delete_folder(uuid) to service_role;
grant execute on function copy_folder(uuid, uuid) to service_role;
grant execute on function purge_file(uuid) to service_role;
grant execute on function purge_trashed_files(timestamptz) to service_role;

commit;
