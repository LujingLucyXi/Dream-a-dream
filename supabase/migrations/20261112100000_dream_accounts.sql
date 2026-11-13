-- Dreameri: accounts — profile + saved collections, one row each per user.
-- Run once in the project's SQL Editor (New query -> paste -> Run). Safe to re-run.
-- Everything is prefixed dream_ so it sits apart from any other tables here.
--
-- Security model (Row Level Security):
--   * A signed-in user can read and write ONLY their own rows.
--   * "plan" (free / full) can never be set from the app: it is not in the
--     columns the app may insert or update. Payments will set it server-side.
--   * Deleting the user (dream-account function) removes both rows (cascade).

-- ——— Profile ———
create table if not exists public.dream_profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 60),
  lang         text not null default 'en' check (lang in ('en', 'zh')),
  plan         text not null default 'free' check (plan in ('free', 'full')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.dream_profiles enable row level security;

drop policy if exists "dream_profiles read own"   on public.dream_profiles;
drop policy if exists "dream_profiles insert own" on public.dream_profiles;
drop policy if exists "dream_profiles update own" on public.dream_profiles;
create policy "dream_profiles read own"   on public.dream_profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy "dream_profiles insert own" on public.dream_profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "dream_profiles update own" on public.dream_profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on table public.dream_profiles from anon, authenticated;
grant select on table public.dream_profiles to authenticated;
grant insert (user_id, display_name, lang) on table public.dream_profiles to authenticated;
grant update (display_name, lang, updated_at) on table public.dream_profiles to authenticated;

-- ——— Saved state: journal (dream journey), souvenir shelf, passport stamps ———
create table if not exists public.dream_user_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint dream_user_state_size check (pg_column_size(data) < 524288)  -- 512 KB per user
);
alter table public.dream_user_state enable row level security;

drop policy if exists "dream_user_state read own"   on public.dream_user_state;
drop policy if exists "dream_user_state insert own" on public.dream_user_state;
drop policy if exists "dream_user_state update own" on public.dream_user_state;
create policy "dream_user_state read own"   on public.dream_user_state for select to authenticated
  using (user_id = (select auth.uid()));
create policy "dream_user_state insert own" on public.dream_user_state for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "dream_user_state update own" on public.dream_user_state for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on table public.dream_user_state from anon, authenticated;
grant select, insert, update on table public.dream_user_state to authenticated;
