create table if not exists public.watch_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null,
  position real not null default 0,
  duration real not null default 0,
  watched boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.watch_progress enable row level security;
drop policy if exists wp_select on public.watch_progress;
drop policy if exists wp_insert on public.watch_progress;
drop policy if exists wp_update on public.watch_progress;
drop policy if exists wp_delete on public.watch_progress;
create policy wp_select on public.watch_progress for select using (auth.uid() = user_id);
create policy wp_insert on public.watch_progress for insert with check (auth.uid() = user_id);
create policy wp_update on public.watch_progress for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy wp_delete on public.watch_progress for delete using (auth.uid() = user_id);
grant select, insert, update, delete on public.watch_progress to authenticated;
notify pgrst, 'reload schema';
