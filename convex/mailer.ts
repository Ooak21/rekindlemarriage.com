"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

// Rekindle's own Resend key, scoped to rekindlemarriage.com. Nothing here shares a key with
// another product, which is what broke this in the first place: the shared key was not authorized
// for our sender and every confirmation 403'd for weeks without anyone seeing it.
const FROM = process.env.REKINDLE_FROM || "Rekindle <hello@rekindlemarriage.com>";

// hello@ is not a monitored mailbox. Replies must reach the people who run the workshop.
const REPLY_TO = (process.env.REKINDLE_REPLY_TO || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const TEAM = (process.env.REKINDLE_TEAM_EMAILS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
const orEmpty = (s: unknown) => {
  const t = String(s ?? "").trim();
  return t ? esc(t) : "(not provided)";
};

async function send(opts: { to: string[]; subject: string; html: string }) {
  const key = process.env.REKINDLE_RESEND_KEY;
  if (!key) throw new Error("REKINDLE_RESEND_KEY is not set");
  if (!opts.to.length) throw new Error("no recipients");
  const body: Record<string, unknown> = { from: FROM, to: opts.to, subject: opts.subject, html: opts.html };
  if (REPLY_TO.length) body.reply_to = REPLY_TO;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

const coupleHtml = (names: string) => `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:0;background-color:#FBF8F4;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FBF8F4;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #EDE6DC;">
        <tr><td style="background-color:#C1440E;padding:20px 28px;">
          <p style="margin:0;color:#FBF8F4;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;font-family:system-ui,-apple-system,sans-serif;">Rekindle Marriage Enrichment Workshop</p>
        </td></tr>
        <tr><td style="padding:32px 28px 12px;">
          <h1 style="margin:0 0 16px;font-size:28px;line-height:1.25;color:#1a1410;font-weight:normal;">Your Rekindle spot is reserved</h1>
          <p style="margin:0 0 16px;font-size:17px;line-height:1.6;color:#3a322c;">Dear ${names},</p>
          <p style="margin:0 0 16px;font-size:17px;line-height:1.6;color:#3a322c;">
            Thank you for taking this step. We have reserved a seat for you at the Rekindle Marriage Enrichment Workshop with Nellie Reedy.
          </p>
          <p style="margin:0 0 16px;font-size:17px;line-height:1.6;color:#3a322c;">
            Your seat is held for <strong>48 hours</strong>. Our team will follow up shortly with your cohort schedule and a secure payment link.
          </p>
          <p style="margin:0 0 16px;font-size:17px;line-height:1.6;color:#3a322c;">
            The investment is <strong>$600 per couple</strong>. If you have any questions in the meantime, simply reply to this email. We are glad you are here.
          </p>
          <p style="margin:24px 0 0;font-size:17px;line-height:1.6;color:#3a322c;">
            With care,<br />
            <span style="color:#C1440E;">The Rekindle Team</span><br />
            <span style="font-size:14px;color:#6b635c;font-family:system-ui,-apple-system,sans-serif;">A division of Vitality Academies</span>
          </p>
        </td></tr>
        <tr><td style="padding:20px 28px 28px;border-top:1px solid #EDE6DC;">
          <p style="margin:0;font-size:12px;line-height:1.5;color:#8a8178;font-family:system-ui,-apple-system,sans-serif;">
            Rekindle Marriage Enrichment Workshop &middot; Nellie Reedy &middot; Vitality Academies
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

export const sendReservationEmails = internalAction({
  args: {
    lead_id: v.string(),
    lead: v.any(),
  },
  handler: async (_ctx, { lead_id, lead: L }) => {
    const names = L.partner_b_first
      ? `${esc(L.partner_a_first)} and ${esc(L.partner_b_first)}`
      : esc(L.partner_a_first);

    const coupleTo = [L.partner_a_email, L.partner_b_email].filter(Boolean) as string[];

    const status = { couple: "not attempted", team: "not attempted" };

    try {
      await send({ to: coupleTo, subject: "Your Rekindle spot is reserved", html: coupleHtml(names) });
      status.couple = "sent";
    } catch (e) {
      status.couple = `failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[rekindle] couple confirmation failed:", e);
    }

    const partnerB = (L.partner_b_first || L.partner_b_last)
      ? `${esc(L.partner_b_first || "")} ${esc(L.partner_b_last || "")}`.trim()
      : "(not provided)";
    const teamHtml = `<!DOCTYPE html><html><head><meta charset="utf-8" /></head>
<body style="font-family:system-ui,-apple-system,sans-serif;color:#1a1410;line-height:1.5;">
  <h2 style="color:#C1440E;margin:0 0 12px;">New Rekindle reservation</h2>
  <p style="margin:0 0 16px;">Lead ID: <code>${esc(lead_id)}</code></p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
    <tr><td style="font-weight:600;padding-right:12px;">Partner A</td><td>${esc(L.partner_a_first)} ${esc(L.partner_a_last)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner A email</td><td>${esc(L.partner_a_email)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner A phone</td><td>${esc(L.partner_a_phone)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner B</td><td>${partnerB}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner B email</td><td>${orEmpty(L.partner_b_email)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner B phone</td><td>${orEmpty(L.partner_b_phone)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Raising children</td><td>${orEmpty(L.raising_children)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Years together</td><td>${orEmpty(L.years_together)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Preferred cohort</td><td>${orEmpty(L.preferred_cohort)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Focus</td><td>${orEmpty(L.focus)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">How heard</td><td>${orEmpty(L.how_heard)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Consent</td><td>${L.consent ? "yes" : "no"}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Source</td><td>${orEmpty(L.source)}</td></tr>
  </table>
</body></html>`;

    const bName = L.partner_b_first || "Partner";
    try {
      await send({ to: TEAM, subject: `New Rekindle reservation: ${L.partner_a_first} and ${bName}`, html: teamHtml });
      status.team = "sent";
    } catch (e) {
      status.team = `failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[rekindle] team notification failed:", e);
    }

    return status;
  },
});

/**
 * A call came in and Ruby took it. The registration form has always emailed the team; the phone had
 * no equivalent, so a caller who rang instead of filling in the form landed in the CRM silently and
 * nobody knew to call them back. This closes that gap so both doors ring the same bell.
 *
 * Deliberately carries the CALLER's number and never anyone on the Rekindle side: Nellie's number is
 * not published and is not forwarded, here or anywhere else.
 */
export const sendPhoneLeadEmail = internalAction({
  args: { lead_id: v.string(), lead: v.any(), deduped: v.boolean() },
  handler: async (_ctx, { lead_id, lead: L, deduped }) => {
    const name = [L.partner_a_first, L.partner_a_last].filter(Boolean).join(" ") || "Caller";
    const heading = deduped ? "Returning caller" : "New call to Rekindle";

    const row = (label: string, value: unknown) =>
      `<tr><td style="font-weight:600;padding-right:12px;white-space:nowrap;">${esc(label)}</td><td>${orEmpty(value)}</td></tr>`;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8" /></head>
<body style="font-family:system-ui,-apple-system,sans-serif;color:#1a1410;line-height:1.5;">
  <h2 style="color:#C1440E;margin:0 0 4px;">${esc(heading)}</h2>
  <p style="margin:0 0 16px;color:#6b5f54;">Ruby answered the workshop line and took this down. Lead ID: <code>${esc(lead_id)}</code></p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
    ${row("Caller", name)}
    ${row("Call back on", L.partner_a_phone)}
    ${row("Email", L.partner_a_email)}
    ${row("Partner", L.partner_b_first)}
    ${row("Together", L.years_together)}
    ${row("Children", L.raising_children)}
    ${row("Prefers", L.preferred_cohort)}
    ${row("What they want help with", L.focus)}
    ${row("How they heard", L.how_heard)}
    <tr><td style="font-weight:600;padding-right:12px;">Okay to contact</td><td>${L.consent ? "yes" : "<b>no, do not contact</b>"}</td></tr>
  </table>
  ${L.notes ? `<p style="margin:18px 0 6px;font-weight:600;">Notes from the call</p><p style="margin:0;white-space:pre-wrap;">${esc(L.notes)}</p>` : ""}
</body></html>`;

    try {
      await send({ to: TEAM, subject: `${heading}: ${name}`, html });
      return { team: "sent" };
    } catch (e) {
      console.error("[rekindle] phone lead notification failed:", e);
      return { team: `failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
