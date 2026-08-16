-- Records whether the reservation emails actually went out.
--
-- Why: rekindle-reserve sent the couple's confirmation and the team notification inside bare
-- try/catch blocks that only wrote to console, so a rejected sender (Resend 403 on
-- luisocadiz.online, the entire time this form has been live) still returned ok:true and showed
-- the couple "Your spot is reserved." There was no way, from the CRM or the data, to tell a
-- confirmed reservation from a silently dropped one.
--
-- Both columns are nullable and additive. Existing rows keep NULL, which correctly reads as
-- "we do not know", because for those reservations we genuinely do not.

alter table public.rekindle_leads
  add column if not exists confirmation_sent_at timestamptz,
  add column if not exists email_status text;

comment on column public.rekindle_leads.confirmation_sent_at is
  'When the couple''s confirmation email was accepted by Resend. NULL means it was never delivered.';
comment on column public.rekindle_leads.email_status is
  'Per-send outcome for the couple and team emails, including the provider error when one fails.';
