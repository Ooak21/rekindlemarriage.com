// Rekindle CRM auth — Convex-native, vanilla JS (no React).
//
// Replaces the shared-Supabase client. Rekindle now has its own Convex deployment, so its users,
// its JWT signing keys and its reset flow belong to this product alone. Nothing here is shared
// with another client's backend.
//
// Access is decided SERVER-SIDE in convex/crm.ts (role must be in the allowed set). The guard
// below is a courtesy redirect so nobody stares at an empty dashboard; it is not the security
// boundary, and a tampered browser gets nothing back from the queries either way.

const CONVEX_CLOUD = 'https://calculating-poodle-798.convex.cloud';
const STORE = 'rk-crm-session';
const LOGIN_PATH = './login.html';

let _Ctor = null;
async function newClient(){
  if(!_Ctor){ const m = await import('https://esm.sh/convex@1.44.0/browser'); _Ctor = m.ConvexHttpClient; }
  return new _Ctor(CONVEX_CLOUD);
}

function read(){ try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch(_){ return null; } }
function write(t){ localStorage.setItem(STORE, JSON.stringify({ token: t.token, refreshToken: t.refreshToken })); }
function clear(){ localStorage.removeItem(STORE); }

// True if the JWT is missing or within 60s of expiry.
function nearExpiry(token){
  try {
    const p = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return (JSON.parse(atob(p)).exp * 1000 - Date.now()) < 60000;
  } catch(_){ return true; }
}

/** Valid access token, refreshing if needed. Null when there is no usable session. */
export async function getToken(){
  const s = read();
  if(!s || !s.token) return null;
  if(!nearExpiry(s.token)) return s.token;
  if(!s.refreshToken){ clear(); return null; }
  try {
    const c = await newClient();
    const res = await c.action('auth:signIn', { refreshToken: s.refreshToken });
    const t = res && res.tokens;
    if(t && t.token){ write(t); return t.token; }
  } catch(_){ }
  clear(); return null;
}

/** Authed client, or null if there is no session. */
async function authedClient(){
  const token = await getToken();
  if(!token) return null;
  const c = await newClient(); c.setAuth(token); return c;
}

export async function rekindleSignIn(email, password){
  try {
    const c = await newClient();
    const res = await c.action('auth:signIn', { provider:'password', params:{ email: String(email).trim().toLowerCase(), password, flow:'signIn' } });
    const t = res && res.tokens;
    if(!t || !t.token) return { ok:false, error:'Sign in failed.' };
    write(t);
    // Confirm the role server-side before letting them through, so a valid account without CRM
    // access is told plainly instead of landing on a dashboard that returns nothing.
    const c2 = await newClient(); c2.setAuth(t.token);
    const who = await c2.query('crm:whoami', {});
    if(!who || !who.ok){ clear(); return { ok:false, error: (who && who.error) || 'This account does not have access to the Rekindle CRM.' }; }
    return { ok:true, user: who };
  } catch(e){
    // Convex returns a generic server error for bad credentials; never echo it raw at a login box.
    return { ok:false, error:'Invalid email or password.' };
  }
}

/** Step 1 of reset: email a one-time code. Never reveals whether the account exists. */
export async function rekindleSendReset(email){
  try {
    const c = await newClient();
    await c.action('auth:signIn', { provider:'password', params:{ email: String(email).trim().toLowerCase(), flow:'reset' } });
  } catch(e){ console.warn('[rekindle] reset request failed:', e && e.message); }
  return { ok:true };
}

/** Step 2 of reset: code + new password. Signs them in on success. */
export async function rekindleConfirmReset(email, code, newPassword){
  try {
    const c = await newClient();
    const res = await c.action('auth:signIn', { provider:'password', params:{ email: String(email).trim().toLowerCase(), code, newPassword, flow:'reset-verification' } });
    const t = res && res.tokens;
    if(!t || !t.token) return { ok:false, error:'That code was not valid. Request a new one and try again.' };
    write(t);
    return { ok:true };
  } catch(e){
    return { ok:false, error:'That code was not valid or it has expired. Request a new one.' };
  }
}

export async function rekindleSignOut(){
  try { const c = await authedClient(); if(c) await c.action('auth:signOut', {}); } catch(_){ }
  clear();
  window.location.replace(LOGIN_PATH);
}

/** Guard a gated page. Returns the user, or null after redirecting. Callers MUST return on null. */
export async function rekindleAuthGuard(){
  const c = await authedClient();
  if(!c){ window.location.replace(LOGIN_PATH); return null; }
  let who = null;
  try { who = await c.query('crm:whoami', {}); } catch(_){ }
  if(!who || !who.ok){ clear(); window.location.replace(LOGIN_PATH + '?denied=1'); return null; }
  if(typeof document !== 'undefined') document.documentElement.style.visibility = 'visible';
  return who;
}

/** Leads for the board. Returns { ok, leads, error }. */
export async function rekindleListLeads(){
  const c = await authedClient();
  if(!c) return { ok:false, error:'Not signed in.', leads:[] };
  try { return await c.query('crm:listLeads', {}); }
  catch(e){ return { ok:false, error:'Could not load reservations.', leads:[] }; }
}

/** Update a lead's status (and optionally cohort/notes). */
export async function rekindleSetLeadStatus(id, patch){
  const c = await authedClient();
  if(!c) return { ok:false, error:'Not signed in.' };
  try { return await c.mutation('crm:setLeadStatus', { id, ...patch }); }
  catch(e){ return { ok:false, error:'Could not save that change.' }; }
}
