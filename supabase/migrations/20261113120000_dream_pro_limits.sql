-- Dreameri: Pro limits (10 readings a day, 2 sleep stories a day).
-- Run once in the SQL Editor after 20261113100000_dream_billing.sql. Safe to re-run.
-- dream_story_take gains p_days: free counts stories over 7 days, Pro over 1.

drop function if exists public.dream_story_take(text, text, integer);
create or replace function public.dream_story_take(p_subject text, p_story_id text, p_limit integer, p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
  v_since timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  select count(*) into v_used from public.dream_story_usage
    where subject = p_subject and created_at > v_since;
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
revoke all on function public.dream_story_take(text, text, integer, integer) from public, anon, authenticated;
