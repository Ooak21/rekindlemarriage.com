import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * One-time import of the reservations that were taken while Rekindle lived on the shared Supabase
 * project. Idempotent by (email + created_at) so re-running cannot duplicate a couple.
 *
 * confirmation_sent_at is deliberately left unset on every imported row. Those confirmations were
 * never delivered (the sender 403'd for the whole period), and recording a time we cannot support
 * would be worse than recording nothing.
 */
export const importLegacyLead = internalMutation({
  args: {
    created_at: v.number(),
    partner_a_first: v.string(),
    partner_a_last: v.string(),
    partner_a_email: v.string(),
    partner_a_phone: v.string(),
    partner_b_first: v.optional(v.string()),
    partner_b_last: v.optional(v.string()),
    partner_b_email: v.optional(v.string()),
    partner_b_phone: v.optional(v.string()),
    raising_children: v.optional(v.string()),
    years_together: v.optional(v.string()),
    preferred_cohort: v.optional(v.string()),
    focus: v.optional(v.string()),
    how_heard: v.optional(v.string()),
    consent: v.boolean(),
    status: v.string(),
    source: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("rekindle_leads")
      .withIndex("by_email", (q) => q.eq("partner_a_email", args.partner_a_email))
      .collect();
    if (existing.some((r) => r.created_at === args.created_at)) {
      return { ok: true as const, skipped: "already imported" };
    }
    const id = await ctx.db.insert("rekindle_leads", {
      ...args,
      email_status: "imported from the previous backend; confirmation was never delivered",
    });
    return { ok: true as const, id };
  },
});
