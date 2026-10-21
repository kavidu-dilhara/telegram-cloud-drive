-- Telegram Cloud Drive - database schema.
-- Run this file once in Supabase -> SQL Editor.
--
-- Safe to run again: every statement is "if not exists" / "create or replace", and the whole script runs as ONE
-- transaction, so if anything fails nothing is half-created.
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
  password_iterations integer,                         -- NULL = hashed with the original 210,000 iterations
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
-- Deleted folders waiting in Trash. A deleted folder is removed from "folders" and kept here as one snapshot of its
-- whole tree (ids, names, structure), so restoring it rebuilds everything exactly. Its files stay in "files" as
-- trashed rows tagged with trash_entry_id.
create table if not exists trashed_folders (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null,                       -- id of the deleted folder (reused when it is restored)
  parent_id uuid,                                -- its original parent (that folder may be gone or in Trash too)
  name text not null,
  path text not null,                            -- original location, e.g. "Photos/Trips/k"
  tree jsonb not null,                           -- the deleted folder and every subfolder: id, parent_id, name, created_at, depth
  folder_count integer not null default 1,
  file_count integer not null default 0,
  deleted_at timestamptz not null default now()
);
create index if not exists trashed_folders_deleted_idx on trashed_folders (deleted_at);

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
-- One share link per file. Older duplicates (from simultaneous requests) are removed, keeping the oldest link,
-- and a unique index keeps it that way.
delete from shares s using shares k
  where s.file_id = k.file_id and (s.created_at, s.id) > (k.created_at, k.id);
drop index if exists shares_file_idx;
create unique index if not exists shares_file_uq on shares (file_id);

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
-- No default on purpose: rows hashed before this column existed must stay NULL (= 210,000 iterations). Every new
-- hash stores its own count, and a successful login upgrades older hashes.
alter table users add column if not exists password_iterations integer;
-- Databases that already ran an earlier version of this script got "not null default 600000": relax that too.
alter table users alter column password_iterations drop not null;
alter table users alter column password_iterations drop default;
alter table users add column if not exists session_version integer not null default 1;
alter table shares add column if not exists share_token_enc text;
-- Where a trashed file came from. trashed_folder_id has no foreign key on purpose: that folder may be deleted.
alter table files add column if not exists trashed_folder_id uuid;
alter table files add column if not exists trash_entry_id uuid references trashed_folders (id) on delete set null;
create index if not exists files_trash_entry_idx on files (trash_entry_id) where trash_entry_id is not null;

alter table users enable row level security;
alter table folders enable row level security;
alter table files enable row level security;
alter table shares enable row level security;
alter table favorites enable row level security;
alter table activity_logs enable row level security;
alter table settings enable row level security;
alter table login_attempts enable row level security;
alter table trashed_folders enable row level security;

-- --------------------------------------------------------------- functions
-- Multi-step operations run inside one transaction so a failure never leaves half-finished data.

create or replace function cloud_drive_dashboard()
returns table (active_files bigint, active_bytes numeric, folder_count bigint, trash_count bigint)
language sql stable security definer set search_path = public as $$
  select
    (select count(*) from files where status = 'active'),
    coalesce((select sum(file_size) from files where status = 'active'), 0),
    (select count(*) from folders),
    (select count(*) from files where status = 'trashed' and trash_entry_id is null)
      + (select count(*) from trashed_folders);
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

-- Counts one sign-in attempt against every key in ONE atomic step, BEFORE the slow password check, so a burst of
-- parallel requests cannot all slip past the limit. Returns false (and counts nothing) when any key is already at its
-- limit. p_maxes[i] is the limit for p_keys[i].
create or replace function reserve_login_attempt(p_keys text[], p_maxes integer[], p_window_seconds integer)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_over boolean;
begin
  if array_length(p_keys, 1) is null or array_length(p_keys, 1) <> coalesce(array_length(p_maxes, 1), 0) then
    raise exception 'keys and limits must match' using errcode = '22023';
  end if;
  insert into login_attempts (key, failures, window_ends_at)
    select k, 0, now() + make_interval(secs => p_window_seconds) from unnest(p_keys) as k
    on conflict (key) do nothing;
  -- Lock the rows in a fixed order: concurrent callers queue up one after another (and cannot deadlock).
  perform 1 from login_attempts where key = any (p_keys) order by key for update;
  update login_attempts set failures = 0, window_ends_at = now() + make_interval(secs => p_window_seconds)
    where key = any (p_keys) and window_ends_at <= now();
  select exists (
    select 1 from unnest(p_keys, p_maxes) as t (k, m) join login_attempts la on la.key = t.k where la.failures >= t.m
  ) into v_over;
  if v_over then
    return false;
  end if;
  update login_attempts set failures = failures + 1 where key = any (p_keys);
  return true;
end;
$$;

-- Gives back one reserved attempt (used for the shared counter after a successful sign-in).
create or replace function refund_login_attempt(p_keys text[])
returns void
language sql security definer set search_path = public as $$
  update login_attempts set failures = greatest(failures - 1, 0) where key = any (p_keys);
$$;

-- One page of favorites, counting and paging ONLY favorites whose file is active (favorites of trashed files stay
-- saved but are neither listed nor counted). The page number is clamped into range and returned.
create or replace function favorites_page(p_page integer, p_size integer)
returns table (o_total bigint, o_page integer, o_id uuid, o_name text, o_size bigint)
language plpgsql stable security definer set search_path = public as $$
declare
  v_size integer := least(greatest(coalesce(p_size, 8), 1), 100);
  v_total bigint;
  v_page integer;
begin
  select count(*) into v_total from favorites fav join files f on f.id = fav.file_id where f.status = 'active';
  v_page := least(greatest(coalesce(p_page, 1), 1), greatest(1, ceil(v_total::numeric / v_size)::integer));
  return query
    select v_total, v_page, f.id, f.file_name, f.file_size
    from favorites fav join files f on f.id = fav.file_id
    where f.status = 'active'
    order by fav.created_at desc, fav.id
    offset (v_page - 1) * v_size limit v_size;
end;
$$;

-- Moves a folder and everything inside it to Trash as ONE Trash item. The tree is saved in trashed_folders (ids, names,
-- structure); active files inside become trashed rows tagged with that item; files that were already in Trash keep their
-- own Trash entry but remember their folder. The "incoming folder" setting is reset if it pointed into the tree.
drop function if exists delete_folder(uuid);
create or replace function delete_folder(p_id uuid)
returns table (o_entry uuid, o_files integer, o_folders integer)
language plpgsql security definer set search_path = public as $$
declare
  v_root folders%rowtype;
  v_ids uuid[];
  v_tree jsonb;
  v_path text;
  v_files integer;
  v_entry uuid;
  v_deleted_at timestamptz := now();
begin
  select * into v_root from folders where id = p_id for update;
  if not found then
    raise exception 'folder_not_found' using errcode = 'P0002';
  end if;

  -- The folder and every folder below it ("path" stops the walk if a damaged hierarchy ever contains a loop).
  with recursive tree as (
    select id, parent_id, name, created_at, 0 as depth, array[id] as path from folders where id = p_id
    union all
    select f.id, f.parent_id, f.name, f.created_at, tree.depth + 1, tree.path || f.id
    from folders f join tree on f.parent_id = tree.id where not f.id = any (tree.path)
  )
  select array_agg(id),
         jsonb_agg(jsonb_build_object('id', id, 'parent_id', parent_id, 'name', name, 'created_at', created_at, 'depth', depth)
                   order by depth, lower(name), id)
    into v_ids, v_tree from tree;

  -- Where it used to live, for display ("Photos/Trips/k").
  with recursive up as (
    select id, parent_id, name, 0 as depth, array[id] as seen from folders where id = p_id
    union all
    select f.id, f.parent_id, f.name, up.depth + 1, up.seen || f.id
    from folders f join up on f.id = up.parent_id where not f.id = any (up.seen)
  )
  select string_agg(name, '/' order by depth desc) into v_path from up;

  select count(*) into v_files from files where folder_id = any (v_ids) and status = 'active';
  insert into trashed_folders (folder_id, parent_id, name, path, tree, folder_count, file_count, deleted_at)
    values (p_id, v_root.parent_id, v_root.name, v_path, v_tree, cardinality(v_ids), v_files, v_deleted_at)
    returning id into v_entry;

  update files set trashed_folder_id = folder_id where folder_id = any (v_ids);
  update files set status = 'trashed', deleted_at = v_deleted_at, updated_at = now(), trash_entry_id = v_entry, folder_id = null
    where folder_id = any (v_ids) and status = 'active';
  update files set folder_id = null where folder_id = any (v_ids);
  delete from settings where key = 'incoming_folder_id'
    and exists (select 1 from unnest(v_ids) as x where settings.value = to_jsonb(x::text));
  delete from folders where id = any (v_ids);

  return query select v_entry, v_files, cardinality(v_ids);
end;
$$;

-- Restores a Trash item: rebuilds the folder tree with the original ids and names, and puts every file back in its
-- original folder. If the original parent is gone (or itself in Trash) the folder returns to the top level; if a folder
-- with the same name already exists there, the restored folder is renamed "name (restored)".
create or replace function restore_folder(p_entry uuid)
returns table (o_folder uuid, o_name text, o_files integer, o_folders integer, o_renamed boolean, o_to_root boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_e trashed_folders%rowtype;
  v_parent uuid;
  v_to_root boolean := false;
  v_name text;
  v_n integer := 1;
  v_suffix text;
  v_files integer;
begin
  select * into v_e from trashed_folders where id = p_entry for update;
  if not found then
    raise exception 'trash_entry_not_found' using errcode = 'P0002';
  end if;

  if v_e.parent_id is not null then
    if exists (select 1 from folders where id = v_e.parent_id) then
      v_parent := v_e.parent_id;
    else
      v_to_root := true;
    end if;
  end if;

  v_name := v_e.name;
  while exists (select 1 from folders where parent_id is not distinct from v_parent and lower(name) = lower(v_name)) loop
    v_n := v_n + 1;
    v_suffix := case when v_n = 2 then ' (restored)' else ' (restored ' || (v_n - 1) || ')' end;
    v_name := left(v_e.name, 100 - length(v_suffix)) || v_suffix;
  end loop;

  insert into folders (id, parent_id, name, created_at, updated_at)
    select (x ->> 'id')::uuid,
           case when (x ->> 'depth')::integer = 0 then v_parent else (x ->> 'parent_id')::uuid end,
           case when (x ->> 'depth')::integer = 0 then v_name else x ->> 'name' end,
           (x ->> 'created_at')::timestamptz,
           now()
    from jsonb_array_elements(v_e.tree) as x;

  update files set status = 'active', deleted_at = null, updated_at = now(),
                   folder_id = trashed_folder_id, trashed_folder_id = null, trash_entry_id = null
    where trash_entry_id = p_entry;
  get diagnostics v_files = row_count;
  delete from trashed_folders where id = p_entry;

  return query select v_e.folder_id, v_name, v_files, v_e.folder_count, v_name <> v_e.name, v_to_root;
end;
$$;

-- Restores files that were trashed on their own, each into its original folder. If that folder is gone (or in Trash)
-- the file goes to the top level and o_to_root says so. Files inside a deleted folder are restored with the folder.
create or replace function restore_files(p_ids uuid[])
returns table (o_id uuid, o_name text, o_to_root boolean)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with picked as (
    select id, trashed_folder_id as wanted from files
    where id = any (p_ids) and status = 'trashed' and trash_entry_id is null
    for update
  ), updated as (
    update files f set status = 'active', deleted_at = null, updated_at = now(),
      folder_id = coalesce(f.folder_id, (select d.id from folders d where d.id = picked.wanted)),
      trashed_folder_id = null
    from picked where f.id = picked.id
    returning f.id, f.file_name, f.folder_id, picked.wanted
  )
  select id, file_name, (wanted is not null and folder_id is null) from updated;
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

  -- A folder cannot be copied into itself or one of its own subfolders (same rule as moving a folder).
  if p_parent is not null and exists (
    with recursive sub as (
      select id, array[id] as path from folders where id = p_id
      union all
      select f.id, sub.path || f.id from folders f join sub on f.parent_id = sub.id where not f.id = any (sub.path)
    )
    select 1 from sub where id = p_parent
  ) then
    raise exception 'invalid_destination' using errcode = '22023';
  end if;

  v_name := v_src.name || ' (copy)';
  while exists (select 1 from folders where parent_id is not distinct from p_parent and lower(name) = lower(v_name)) loop
    v_name := v_src.name || ' (copy ' || v_suffix || ')';
    v_suffix := v_suffix + 1;
  end loop;

  create temporary table _folder_map (old_id uuid primary key, new_id uuid not null) on commit drop;

  for v_row in
    with recursive tree as (
      select id, parent_id, name, 0 as depth, array[id] as path from folders where id = p_id
      union all
      -- "path" stops the walk if a damaged hierarchy ever contains a loop
      select f.id, f.parent_id, f.name, tree.depth + 1, tree.path || f.id
      from folders f join tree on f.parent_id = tree.id
      where not f.id = any (tree.path)
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

-- Permanently deletes a Trash item (a deleted folder): every file inside it, then the saved tree itself.
create or replace function purge_trashed_folder(p_entry uuid)
returns table (tg_chat_id bigint, tg_message_id bigint, orphaned boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform 1 from trashed_folders where id = p_entry for update;
  if not found then
    raise exception 'trash_entry_not_found' using errcode = 'P0002';
  end if;
  for v_id in select id from files where trash_entry_id = p_entry order by created_at, id loop
    return query select * from purge_file(v_id);
  end loop;
  delete from trashed_folders where id = p_entry;
end;
$$;

-- Permanently deletes trashed files and deleted folders (all, or only those trashed before p_older_than).
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
  -- Their files are gone now (they carry the same deleted_at), so the saved folder trees go too.
  delete from trashed_folders where p_older_than is null or deleted_at < p_older_than;
end;
$$;

-- Only the backend (service role) may call these functions; the public API keys may not.
revoke execute on function cloud_drive_dashboard() from public, anon, authenticated;
revoke execute on function register_login_failure(text, integer) from public, anon, authenticated;
revoke execute on function reserve_login_attempt(text[], integer[], integer) from public, anon, authenticated;
revoke execute on function refund_login_attempt(text[]) from public, anon, authenticated;
revoke execute on function favorites_page(integer, integer) from public, anon, authenticated;
revoke execute on function delete_folder(uuid) from public, anon, authenticated;
revoke execute on function copy_folder(uuid, uuid) from public, anon, authenticated;
revoke execute on function restore_folder(uuid) from public, anon, authenticated;
revoke execute on function restore_files(uuid[]) from public, anon, authenticated;
revoke execute on function purge_trashed_folder(uuid) from public, anon, authenticated;
revoke execute on function purge_file(uuid) from public, anon, authenticated;
revoke execute on function purge_trashed_files(timestamptz) from public, anon, authenticated;
grant execute on function cloud_drive_dashboard() to service_role;
grant execute on function register_login_failure(text, integer) to service_role;
grant execute on function reserve_login_attempt(text[], integer[], integer) to service_role;
grant execute on function refund_login_attempt(text[]) to service_role;
grant execute on function favorites_page(integer, integer) to service_role;
grant execute on function delete_folder(uuid) to service_role;
grant execute on function copy_folder(uuid, uuid) to service_role;
grant execute on function restore_folder(uuid) to service_role;
grant execute on function restore_files(uuid[]) to service_role;
grant execute on function purge_trashed_folder(uuid) to service_role;
grant execute on function purge_file(uuid) to service_role;
grant execute on function purge_trashed_files(timestamptz) to service_role;

commit;
