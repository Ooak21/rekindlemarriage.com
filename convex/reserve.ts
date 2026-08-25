import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const create = internalMutation({
  args: {
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
    payment_plan: v.optional(v.string()),   // 'pay_in_full' | 'easypay'
    consent: v.boolean(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("rekindle_leads", {
      ...args,
      created_at: Date.now(),
      status: "reserved",
    });
    return id;
  },
});

export const get = internalQuery({
  args: { id: v.id("rekindle_leads") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

/**
 * Stamp what actually happened to the two emails. Deliberately separate from the insert: the lead
 * is saved before anything is sent, so a mail failure can never cost us the reservation. Absent
 * fields mean the sends were never recorded, not that they succeeded.
 */
export const recordEmailOutcome = internalMutation({
  args: { id: v.id("rekindle_leads"), couple: v.string(), team: v.string() },
  handler: async (ctx, { id, couple, team }) => {
    await ctx.db.patch(id, {
      confirmation_sent_at: couple === "sent" ? Date.now() : undefined,
      email_status: `couple: ${couple} | team: ${team}`,
    });
  },
});
