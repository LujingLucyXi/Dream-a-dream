-- Dreameri: the Dream Bank — sleep stories dreamers chose to leave for others.
-- Run once in the SQL Editor (New query -> paste -> Run). Safe to re-run.
--
-- * Stories are anonymous: the author is kept only so they can remove their
--   own story; it is never exposed (the app reads the dream_bank_public view).
-- * Each story lives for 30 days (expires_at), then disappears from the bank.
-- * Writes happen only through the dream-bank edge function (service role).
-- * Audio lives in the public storage bucket "dream-bank".

create table if not exists public.dream_bank (
  id           uuid primary key default gen_random_uuid(),
  author       uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',
  title        text not null,
  sign         text,
  mood         text,
  lens         text,
  lang         text not null default 'en',
  voice        text,
  minutes      integer,
  story        text not null,
  audio_path   text,
  listens      integer not null default 0,
  reports      integer not null default 0,
  hidden       boolean not null default false
);
create index if not exists dream_bank_live on public.dream_bank (expires_at desc) where not hidden;
alter table public.dream_bank enable row level security;
-- no policies: the app never touches the table directly

create or replace view public.dream_bank_public
with (security_invoker = false) as
  select id, created_at, expires_at, title, sign, mood, lens, lang, voice, minutes, story, audio_path, listens
  from public.dream_bank
  where not hidden and expires_at > now();
grant select on public.dream_bank_public to anon, authenticated;

create or replace function public.dream_bank_listen(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.dream_bank set listens = listens + 1 where id = p_id;
$$;
create or replace function public.dream_bank_report(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.dream_bank set reports = reports + 1, hidden = (reports + 1 >= 3) where id = p_id;
$$;
revoke all on function public.dream_bank_listen(uuid) from public, anon, authenticated;
revoke all on function public.dream_bank_report(uuid) from public, anon, authenticated;

-- Public audio bucket (read-only for everyone; the edge function uploads).
insert into storage.buckets (id, name, public) values ('dream-bank', 'dream-bank', true)
on conflict (id) do update set public = true;
