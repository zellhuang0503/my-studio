begin;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint settings_shape check (
    jsonb_typeof(data) = 'object' and octet_length(data::text) <= 200000
    and data - array['spec','check','imgSpec','model','modelOther','think','gmodel','order','imgModel','imgOther']::text[] = '{}'::jsonb
    and not jsonb_path_exists(data, '$.* ? (@.type() != "string")')
  )
);
alter table public.user_settings enable row level security;
revoke all on public.user_settings from anon, authenticated;
grant select, insert, update on public.user_settings to authenticated;
drop policy if exists settings_read_own on public.user_settings;
create policy settings_read_own on public.user_settings for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists settings_insert_own on public.user_settings;
create policy settings_insert_own on public.user_settings for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists settings_update_own on public.user_settings;
create policy settings_update_own on public.user_settings for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create or replace function public.stamp_settings() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists settings_updated on public.user_settings;
create trigger settings_updated before update on public.user_settings for each row execute function public.stamp_settings();

-- Only administrators (SQL Editor) manage membership. An empty list denies all AI calls.
create table if not exists public.ai_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  daily_requests integer not null default 50 check (daily_requests between 1 and 1000),
  daily_images integer not null default 5 check (daily_images between 0 and 100),
  minute_requests integer not null default 5 check (minute_requests between 1 and 60)
);
create table if not exists public.ai_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  usage_day date not null,
  requests integer not null default 0,
  images integer not null default 0,
  minute_start timestamptz not null,
  minute_count integer not null default 0
);
alter table public.ai_members enable row level security;
alter table public.ai_usage enable row level security;
revoke all on public.ai_members, public.ai_usage from public, anon, authenticated;
grant all on public.ai_members, public.ai_usage to service_role;

-- A locked membership row serializes concurrent calls across all function instances.
-- Attempts consume quota even when the provider fails; retries cannot bypass limits.
create or replace function public.reserve_ai_request(p_user_id uuid, p_image boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  member public.ai_members%rowtype;
  used public.ai_usage%rowtype;
  day_now date := (now() at time zone 'Asia/Taipei')::date;
  minute_now timestamptz := date_trunc('minute', now());
begin
  select * into member from public.ai_members where user_id = p_user_id for update;
  if not found or not member.enabled then return 'forbidden'; end if;
  insert into public.ai_usage(user_id, usage_day, minute_start) values (p_user_id, day_now, minute_now) on conflict do nothing;
  select * into used from public.ai_usage where user_id = p_user_id for update;
  if used.usage_day <> day_now then used.requests := 0; used.images := 0; end if;
  if used.minute_start <> minute_now then used.minute_count := 0; end if;
  if used.requests >= member.daily_requests then return 'daily'; end if;
  if p_image and used.images >= member.daily_images then return 'images'; end if;
  if used.minute_count >= member.minute_requests then return 'minute'; end if;
  update public.ai_usage set usage_day = day_now, requests = used.requests + 1,
    images = used.images + case when p_image then 1 else 0 end,
    minute_start = minute_now, minute_count = used.minute_count + 1 where user_id = p_user_id;
  return 'ok';
end;
$$;
revoke all on function public.reserve_ai_request(uuid, boolean) from public, anon, authenticated;
grant execute on function public.reserve_ai_request(uuid, boolean) to service_role;
commit;
