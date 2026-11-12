-- Dream a Dream: per-visitor hourly allowance for the three edge functions.
-- Run once in the Glomere project (SQL Editor -> New query -> paste -> Run).
-- Safe to re-run. Touches nothing else in the project.
--
-- Keys look like "reading:<sha256 of IP>", so no raw IP address is stored.
-- RLS is on with no policies, so only the service role (the edge functions)
-- can read or write it, through dream_rate_hit().

create table if not exists public.dream_rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         integer     not null default 0
);

alter table public.dream_rate_limits enable row level security;

create or replace function public.dream_rate_hit(p_key text, p_max integer, p_window_s integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits integer;
begin
  insert into public.dream_rate_limits as t (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case
             when t.window_start < now() - make_interval(secs => p_window_s) then 1
             else t.hits + 1
           end,
    window_start = case
             when t.window_start < now() - make_interval(secs => p_window_s) then now()
             else t.window_start
           end
  returning hits into v_hits;

  -- Light housekeeping: occasionally drop rows idle for more than a day.
  if random() < 0.01 then
    delete from public.dream_rate_limits where window_start < now() - interval '1 day';
  end if;

  return v_hits <= p_max;
end;
$$;

revoke all on function public.dream_rate_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.dream_rate_hit(text, integer, integer) to service_role;
