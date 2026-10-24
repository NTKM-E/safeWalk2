-- SafeWalk database schema (Postgres + PostGIS).
-- Supabase: Dashboard → SQL Editor → paste → Run. Local: docker compose loads it automatically.
-- Safe to run again; every step checks whether it was already done.

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------- 1. San Jose Police Calls for Service (filled by backend/ingest) ----------
-- One row per call. Only call types that matter for pedestrian safety are ingested
-- (see backend/app/call_types.py). geom is null when the address couldn't be geocoded.
create table if not exists public.police_calls (
  call_number    text primary key,
  call_type_code text not null,
  call_type      text not null,
  category       text not null,            -- violent | weapons | disorder | property
  priority       int,
  offense_at     timestamptz not null,
  address        text,
  final_dispo    text,
  geom           geography(Point, 4326),
  ingested_at    timestamptz not null default now()
);
create index if not exists police_calls_geom_idx on public.police_calls using gist (geom);
create index if not exists police_calls_offense_at_idx on public.police_calls (offense_at);

-- Block-level addresses repeat a lot, so each one is geocoded once and cached.
-- lat/lng null = the geocoder couldn't match it (don't retry every night).
create table if not exists public.geocode_cache (
  address     text primary key,
  lat         double precision,
  lng         double precision,
  score       double precision,
  addr_type   text,
  geocoded_at timestamptz not null default now()
);

-- ---------- 2. Community reports (photo + AI-classified hazard) ----------
-- Keep the type list identical to REPORT_TYPES in backend/app/report_types.py.
create table if not exists public.reports (
  id             uuid primary key default gen_random_uuid(),
  type           text not null check (type in (
                   'obstruction', 'pedestrian_signal_issue', 'construction', 'lighting',
                   'damaged_sidewalk', 'unpaved_surface', 'trash', 'other')),
  notes          text not null default '',
  photo_url      text not null,
  reporter_id    uuid not null,
  live_photo     boolean not null default false,
  ai_type        text,
  ai_confidence  double precision,
  ai_description text,
  status         text not null default 'unverified'
                   check (status in ('unverified', 'verified', 'resolved')),
  confirm_count  int not null default 0,
  deny_count     int not null default 0,
  created_at     timestamptz not null default now(),
  geom           geography(Point, 4326) not null
);
create index if not exists reports_geom_idx on public.reports using gist (geom);

-- New reports are ALWAYS unverified with zero votes.
create or replace function public.reports_start_unverified()
returns trigger language plpgsql as $$
begin
  new.status        := 'unverified';
  new.confirm_count := 0;
  new.deny_count    := 0;
  return new;
end $$;

drop trigger if exists reports_start_unverified on public.reports;
create trigger reports_start_unverified
  before insert on public.reports
  for each row execute function public.reports_start_unverified();

-- ---------- 3. Verifications: "Is this hazard still here?" ----------
-- One answer per device per report.
create table if not exists public.verifications (
  report_id  uuid    not null references public.reports(id) on delete cascade,
  device_id  uuid    not null,
  is_present boolean not null,
  created_at timestamptz not null default now(),
  primary key (report_id, device_id)
);

-- Prevent users from verifying their own reports.
create or replace function public.verifications_not_reporter()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from public.reports
    where id = new.report_id and reporter_id = new.device_id
  ) then
    raise exception 'You cannot verify your own report';
  end if;
  return new;
end $$;

drop trigger if exists verifications_not_reporter on public.verifications;
create trigger verifications_not_reporter
  before insert on public.verifications
  for each row execute function public.verifications_not_reporter();

-- After each answer, recount and update the report status:
--   ≥1 confirmation and confirmations ≥ denials  → 'verified'
--   ≥2 denials and denials > confirmations        → 'resolved' (removed from the map)
--   otherwise                                     → 'unverified'
create or replace function public.verifications_recount()
returns trigger language plpgsql as $$
declare
  confirms int;
  denies   int;
begin
  select
    count(*) filter (where is_present),
    count(*) filter (where not is_present)
  into confirms, denies
  from public.verifications
  where report_id = new.report_id;

  update public.reports set
    confirm_count = confirms,
    deny_count    = denies,
    status = case
      when denies >= 2 and denies > confirms then 'resolved'
      when confirms >= 1 and confirms >= denies then 'verified'
      else 'unverified'
    end
  where id = new.report_id;
  return null;
end $$;

drop trigger if exists verifications_recount on public.verifications;
create trigger verifications_recount
  after insert on public.verifications
  for each row execute function public.verifications_recount();

-- ---------- 4. Lock tables to the backend ----------
-- The FastAPI backend connects as the database owner, which bypasses RLS.
-- Enabling RLS with no policies keeps Supabase's public anon key from reading or writing.
alter table public.police_calls  enable row level security;
alter table public.geocode_cache enable row level security;
alter table public.reports       enable row level security;
alter table public.verifications enable row level security;
