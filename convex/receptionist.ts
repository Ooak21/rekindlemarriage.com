// receptionist.ts — "Ruby", the Rekindle phone receptionist -> rekindle_leads.
//
// WHY THIS EXISTS. Rekindle had a landing page and a demo-call playbook but no way to catch a phone
// call. Someone hearing about the workshop from a friend had nowhere to ring, and Nellie cannot sit
// on a phone. This answers (702) 867-9804 around the clock, captures the couple, and drops them into
// the same CRM the registration form feeds, so the pipeline is one list rather than two.
//
// DELIBERATELY STANDALONE FROM VITALITY. Different Convex deployment (confident-falcon-598 vs
// quixotic-cat-492), different Telnyx assistant, different webhook secret. Nothing is shared, and
// nothing here should ever import or call across to the clinic. Rekindle is marriage education,
// Vitality is a medical practice, and mixing their data would be wrong on both sides.
//
// THE LINE THAT MATTERS MOST. Rekindle is marriage EDUCATION and guided skill building. It is NOT
// therapy, counseling, diagnosis, or clinical treatment, and Nellie is a Marriage Education
// Facilitator and a Master's Candidate, NOT a therapist and NOT a "coach" (Tim Reedy, 2026-08-06).
// Those rails live in the assistant prompt, and this file keeps the same discipline: it stores what
// the caller said, and never infers a clinical anything.
import { internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** Match a caller regardless of formatting, last 10 digits. */
const digits10 = (s?: string | null) => (s || "").replace(/\D/g, "").slice(-10);
const str = (s: unknown, max = 300) => String(s ?? "").trim().slice(0, max);

/**
 * Call start. Recognize a couple who already reserved so Ruby can greet them by name instead of
 * asking a returning caller to re-introduce themselves. Read only, fast, no writes.
 */
export const lookup = internalQuery({
  args: { from: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const d = digits10(a.from);
    if (d.length !== 10) return { is_known: false, first_name: "", status: "" };
    const rows = await ctx.db.query("rekindle_leads").collect();
    const hit = rows.find(
      (r: any) => digits10(r.partner_a_phone) === d || digits10(r.partner_b_phone) === d,
    );
    if (!hit) return { is_known: false, first_name: "", status: "" };
    const isB = digits10((hit as any).partner_b_phone) === d;
    return {
      is_known: true,
      first_name: str(isB ? (hit as any).partner_b_first : (hit as any).partner_a_first, 60),
      status: str((hit as any).status, 40),
    };
  },
});

/**
 * End of call. Write the caller into rekindle_leads.
 *
 * Idempotent on phone: a caller who rings twice updates their record rather than creating a second
 * one. The registration form and the phone both land in the same table, so the CRM stays one list.
 *
 * `consent` is FALSE unless the caller actually said yes to being contacted. It is a real permission,
 * not a formality, and defaulting it to true would put words in their mouth.
 */
export const persist = internalMutation({
  args: {
    call_id: v.string(),
    from_number: v.optional(v.string()),
    partner_a_first: v.optional(v.string()),
    partner_a_last: v.optional(v.string()),
    partner_a_email: v.optional(v.string()),
    partner_a_phone: v.optional(v.string()),
    partner_b_first: v.optional(v.string()),
    years_together: v.optional(v.string()),
    raising_children: v.optional(v.string()),
    preferred_cohort: v.optional(v.string()),
    focus: v.optional(v.string()),
    how_heard: v.optional(v.string()),
    consent: v.optional(v.boolean()),
    intent: v.optional(v.string()),      // register | question | callback | other
    message: v.optional(v.string()),
    duration_sec: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const phone = str(a.partner_a_phone || a.from_number, 40);
    // A smoke test against this endpoint used to email the whole team, because the notification
    // fires on write and the write is the thing you want to test. Test rows are named ZZTest by
    // convention (purgeTestLead enforces the same prefix), so they save to the CRM but stay silent.
    const isTest = str(a.partner_a_first, 80).startsWith("ZZTest");
    const d = digits10(phone);
    const first = str(a.partner_a_first, 80);
    const last = str(a.partner_a_last, 80);

    const noteBits = [
      `Inbound call handled by Ruby. Intent: ${str(a.intent || "other", 40)}.`,
      a.partner_b_first ? `Partner: ${str(a.partner_b_first, 80)}.` : "",
      a.years_together ? `Together: ${str(a.years_together, 60)}.` : "",
      a.raising_children ? `Children: ${str(a.raising_children, 60)}.` : "",
      a.preferred_cohort ? `Prefers: ${str(a.preferred_cohort, 80)}.` : "",
      a.how_heard ? `Heard via: ${str(a.how_heard, 120)}.` : "",
      a.message ? `Message: ${str(a.message, 900)}` : "",
      a.consent === true ? "Consented to follow-up on the call." : "Did NOT give follow-up consent.",
    ].filter(Boolean);
    const note = noteBits.join(" ");

    // Same couple ringing back: update, never duplicate.
    if (d.length === 10) {
      const rows = await ctx.db.query("rekindle_leads").collect();
      const existing = rows.find(
        (r: any) => digits10(r.partner_a_phone) === d || digits10(r.partner_b_phone) === d,
      );
      if (existing) {
        await ctx.db.patch(existing._id, {
          partner_a_first: first || (existing as any).partner_a_first,
          partner_a_last: last || (existing as any).partner_a_last,
          partner_a_email: str(a.partner_a_email, 200) || (existing as any).partner_a_email,
          partner_b_first: str(a.partner_b_first, 80) || (existing as any).partner_b_first,
          years_together: str(a.years_together, 60) || (existing as any).years_together,
          raising_children: str(a.raising_children, 60) || (existing as any).raising_children,
          preferred_cohort: str(a.preferred_cohort, 80) || (existing as any).preferred_cohort,
          focus: str(a.focus, 400) || (existing as any).focus,
          how_heard: str(a.how_heard, 200) || (existing as any).how_heard,
          notes: [(existing as any).notes, note].filter(Boolean).join("\n\n").slice(0, 4000),
        });
        const updated = await ctx.db.get(existing._id);
        if (!isTest) await ctx.scheduler.runAfter(0, internal.mailer.sendPhoneLeadEmail, {
          lead_id: String(existing._id),
          lead: updated,
          deduped: true,
        });
        return { ok: true as const, deduped: true, lead_id: existing._id };
      }
    }

    const id = await ctx.db.insert("rekindle_leads", {
      created_at: Date.now(),
      partner_a_first: first || "Caller",
      partner_a_last: last,
      partner_a_email: str(a.partner_a_email, 200),
      partner_a_phone: phone,
      partner_b_first: str(a.partner_b_first, 80) || undefined,
      years_together: str(a.years_together, 60) || undefined,
      raising_children: str(a.raising_children, 60) || undefined,
      preferred_cohort: str(a.preferred_cohort, 80) || undefined,
      focus: str(a.focus, 400) || undefined,
      how_heard: str(a.how_heard, 200) || undefined,
      consent: a.consent === true,
      status: "reserved",
      notes: note,
      source: "phone",
    });
    const created = await ctx.db.get(id);
    if (!isTest) await ctx.scheduler.runAfter(0, internal.mailer.sendPhoneLeadEmail, {
      lead_id: String(id),
      lead: created,
      deduped: false,
    });
    return { ok: true as const, deduped: false, lead_id: id };
  },
});

/**
 * Remove a lead created by a phone-path TEST. Guarded the same way the Vitality fax helper is:
 * it refuses anything not obviously test data, so it can never be aimed at a real couple.
 */
export const purgeTestLead = internalMutation({
  args: { lead_id: v.id("rekindle_leads") },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.lead_id);
    if (!row) return { ok: false as const, error: "not found" };
    const first = String((row as any).partner_a_first || "");
    if (!first.startsWith("ZZTest")) {
      throw new Error("refusing to purge a lead whose first name does not start with 'ZZTest' — test-only helper");
    }
    await ctx.db.delete(a.lead_id);
    return { ok: true as const };
  },
});
