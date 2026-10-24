-- SafeWalk: report verification schema
-- Run this ONCE in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- It is safe to run again; every step checks whether it was already done.
--
-- What this script adds / ensures:
--   1. A "lighting" incident type is allowed.
--   2. incidents.status: every new row starts as 'unverified'.
--   3. incidents.confirm_count / deny_count: community votes.
--   4. incidents.reporter_id / live_photo: who reported it and whether it used the camera.
--   5. A verifications table: one answer per device per incident.
--   6. Triggers that keep counts and status up to date automatically.

-- ---------- 1. Update allowed incident types ----------
-- Drops whatever the old type constraint was called and replaces it with the new list.
-- Keep this list identical to INCIDENT_TYPES in incidents.js.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.incidents'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '\mtype\M'
  loop
    execute format('alter table public.incidents drop constraint %I', c);
  end loop;
end $$;

alter table public.incidents add constraint incidents_type_check check (type in (
  'obstruction', 'pedestrian_signal_issue', 'construction', 'lighting',
  'unpaved_surface', 'trash', 'other'
));

-- ---------- 2. New columns on incidents ----------
alter table public.incidents
  add column if not exists status text not null default 'unverified',
  add column if not exists confirm_count int not null default 0,
  add column if not exists deny_count int not null default 0,
  add column if not exists reporter_id uuid,
  add column if not exists live_photo boolean not null default false;

alter table public.incidents drop constraint if exists incidents_status_check;
alter table public.incidents add constraint incidents_status_check
  check (status in ('unverified', 'verified', 'resolved'));

-- New reports are ALWAYS unverified with zero votes.
create or replace function public.incidents_start_unverified()
returns trigger language plpgsql as $$
begin
  new.status        := 'unverified';
  new.confirm_count := 0;
  new.deny_count    := 0;
  return new;
end $$;

drop trigger if exists incidents_start_unverified on public.incidents;
create trigger incidents_start_unverified
  before insert on public.incidents
  for each row execute function public.incidents_start_unverified();

-- ---------- 3. Verifications table ----------
create table if not exists public.verifications (
  incident_id uuid    not null references public.incidents(id) on delete cascade,
  device_id   uuid    not null,
  is_present  boolean not null,
  created_at  timestamptz not null default now(),
  primary key (incident_id, device_id)
);

alter table public.verifications enable row level security;

drop policy if exists "Anyone can read verifications"  on public.verifications;
create policy "Anyone can read verifications" on public.verifications
  for select to anon, authenticated using (true);

drop policy if exists "Anyone can add a verification" on public.verifications;
create policy "Anyone can add a verification" on public.verifications
  for insert to anon, authenticated with check (true);

grant select, insert on public.verifications to anon, authenticated;

-- Prevent users from verifying their own reports.
create or replace function public.verifications_not_reporter()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from incidents
    where id = new.incident_id and reporter_id = new.device_id
  ) then
    raise exception 'You cannot verify your own report';
  end if;
  return new;
end $$;

drop trigger if exists verifications_not_reporter on public.verifications;
create trigger verifications_not_reporter
  before insert on public.verifications
  for each row execute function public.verifications_not_reporter();

-- After each answer, recount and update the incident status:
--   ≥1 confirmation and confirmations ≥ denials  → 'verified'
--   ≥2 denials and denials > confirmations        → 'resolved' (removed from the map)
--   otherwise                                     → 'unverified'
create or replace function public.verifications_recount()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  confirms int;
  denies   int;
begin
  select
    count(*) filter (where is_present),
    count(*) filter (where not is_present)
  into confirms, denies
  from verifications
  where incident_id = new.incident_id;

  update incidents set
    confirm_count = confirms,
    deny_count    = denies,
    status = case
      when denies >= 2 and denies > confirms then 'resolved'
      when confirms >= 1 and confirms >= denies then 'verified'
      else 'unverified'
    end
  where id = new.incident_id;
  return null;
end $$;

drop trigger if exists verifications_recount on public.verifications;
create trigger verifications_recount
  after insert on public.verifications
  for each row execute function public.verifications_recount();
