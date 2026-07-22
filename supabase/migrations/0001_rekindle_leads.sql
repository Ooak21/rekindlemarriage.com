-- Rekindle Marriage Bootcamp leads
-- Inserts are performed server-side via the service role (bypasses RLS).
-- No anon insert/select policies; staff use authenticated select/update.

create table public.rekindle_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  partner_a_first text not null,
  partner_a_last text not null,
  partner_a_email text not null,
  partner_a_phone text not null,
  partner_b_first text,
  partner_b_last text,
  partner_b_email text,
  partner_b_phone text,
  raising_children text,
  years_together text,
  preferred_cohort text,
  focus text,
  how_heard text,
  consent boolean not null default false,
  status text not null default 'reserved', -- reserved | contacted | paid | enrolled | archived
  cohort text,
  notes text,
  source text not null default 'website'
);

alter table public.rekindle_leads enable row level security;

-- PII table: restrict reads/updates to staff roles only (not every authenticated
-- user in the shared project). Inserts still go through the service role in the
-- edge function, which bypasses RLS entirely.
create policy "staff_read" on public.rekindle_leads
  for select
  to authenticated
  using ( (auth.jwt() -> 'app_metadata' ->> 'role') in ('luis','support','miguel','rekindle') );

create policy "staff_update" on public.rekindle_leads
  for update
  to authenticated
  using ( (auth.jwt() -> 'app_metadata' ->> 'role') in ('luis','support','miguel','rekindle') )
  with check ( (auth.jwt() -> 'app_metadata' ->> 'role') in ('luis','support','miguel','rekindle') );

create index rekindle_leads_created_at_idx on public.rekindle_leads (created_at desc);
create index rekindle_leads_status_idx on public.rekindle_leads (status);
