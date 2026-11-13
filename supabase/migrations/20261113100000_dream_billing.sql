-- Dreameri: subscriptions (Stripe) + free-plan allowances.
-- Run once in the SQL Editor (New query -> paste -> Run). Safe to re-run.
--
-- * dream_profiles gets the Stripe customer and subscription status. As
--   with "plan", the app can READ these but never write them: only the
--   dream-stripe-webhook function (service role) sets them.
-- * dream_reading_usage counts free readings per day, and dream_story_usage
--   counts free sleep stories per rolling week. RLS is on with no policies,
--   so only the edge functions (service role) can touch them, through the
--   two functions below.

alter table public.dream_profiles add column if not exists stripe_customer_id text;
alter table public.dream_profiles add column if not exists sub_status text;
alter table public.dream_profiles add column if not exists sub_interval text;
alter table public.dream_profiles add column if not exists sub_period_end timestamptz;
create index if not exists dream_profiles_stripe_customer on public.dream_profiles (stripe_customer_id);

-- ——— Free readings: one row per subject (user id or hashed IP) per day ———
create table if not exists public.dream_reading_usage (
  subject text not null,
  day     date not null,
  used    integer not null default 0,
  primary key (subject, day)
);
alter table public.dream_reading_usage enable row level security;

-- Takes one reading if the subject is under p_limit today.
-- Returns the readings left AFTER this one, or -1 if none were left.
-- p_take = false only reports what is left, without taking one.
create or replace function public.dream_reading_take(p_subject text, p_limit integer, p_take boolean default true)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
  v_day  date := (now() at time zone 'America/Los_Angeles')::date;
begin
  select used into v_used from public.dream_reading_usage where subject = p_subject and day = v_day for update;
  v_used := coalesce(v_used, 0);
  if not p_take then
    return greatest(p_limit - v_used, 0);
  end if;
  if v_used >= p_limit then
    return -1;
  end if;
  insert into public.dream_reading_usage as t (subject, day, used) values (p_subject, v_day, 1)
  on conflict (subject, day) do update set used = t.used + 1;
  delete from public.dream_reading_usage where day < v_day - 7;
  return p_limit - v_used - 1;
end;
$$;

-- ——— Free sleep stories: one row per story, counted over the last 7 days ———
create table if not exists public.dream_story_usage (
  subject    text not null,
  story_id   text not null,
  created_at timestamptz not null default now(),
  primary key (subject, story_id)
);
alter table public.dream_story_usage enable row level security;

-- A story is counted once, by its id (its later chapters and retries are free).
-- Returns the stories left AFTER this one, or -1 if none were left.
-- p_story_id = '' only reports what is left.
create or replace function public.dream_story_take(p_subject text, p_story_id text, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  select count(*) into v_used from public.dream_story_usage
    where subject = p_subject and created_at > now() - interval '7 days';
  if p_story_id = '' then
    return greatest(p_limit - v_used, 0);
  end if;
  if exists (select 1 from public.dream_story_usage where subject = p_subject and story_id = p_story_id) then
    return greatest(p_limit - v_used, 0);
  end if;
  if v_used >= p_limit then
    return -1;
  end if;
  insert into public.dream_story_usage (subject, story_id) values (p_subject, p_story_id);
  delete from public.dream_story_usage where created_at < now() - interval '30 days';
  return p_limit - v_used - 1;
end;
$$;

revoke all on function public.dream_reading_take(text, integer, boolean) from public, anon, authenticated;
revoke all on function public.dream_story_take(text, text, integer) from public, anon, authenticated;
