// Rekindle CRM auth helper (self-contained — this repo is standalone, not the portfolio).
//
// Gate: only allowed roles reach the dashboard. Internal IBS admins (luis,
// support, miguel) plus a dedicated 'rekindle' role for Dr. DeBry's team.
// RLS on rekindle_leads already scopes data to authenticated users; this guard
// controls WHO may authenticate into this surface.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL      = 'https://jtifhcvbgxqwlywugvjv.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0aWZoY3ZiZ3hxd2x5d3Vndmp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MDc5NTgsImV4cCI6MjA4ODA4Mzk1OH0.UfRVLuvM8_HPvKXUEDXb0cxR50znv16L5Tf99AnSc7g';

const STORAGE_KEY   = 'sb-rekindle-crm';
const LOGIN_PATH    = './login.html';
const ALLOWED_ROLES = new Set(['luis', 'support', 'miguel', 'rekindle']);

export const rekindleSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storageKey: STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

function isAllowed(user) {
  const role = user && user.app_metadata && user.app_metadata.role;
  return ALLOWED_ROLES.has(role);
}

/** Guard a gated page. Returns the user, or null after redirecting. Callers MUST return on null. */
export async function rekindleAuthGuard() {
  const { data: { session } } = await rekindleSupabase.auth.getSession();
  if (!session) { window.location.replace(LOGIN_PATH); return null; }
  if (!isAllowed(session.user)) {
    await rekindleSupabase.auth.signOut();
    window.location.replace(LOGIN_PATH + '?denied=1');
    return null;
  }
  if (typeof document !== 'undefined') document.documentElement.style.visibility = 'visible';
  return session.user;
}

/** Sign in and verify the role before allowing in. */
export async function rekindleSignIn(email, password) {
  const { data, error } = await rekindleSupabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: error.message };
  if (!isAllowed(data.user)) {
    await rekindleSupabase.auth.signOut();
    return { ok: false, error: 'This account does not have access to the Rekindle CRM.' };
  }
  return { ok: true, user: data.user };
}

export async function rekindleSignOut() {
  await rekindleSupabase.auth.signOut();
  window.location.replace(LOGIN_PATH);
}
