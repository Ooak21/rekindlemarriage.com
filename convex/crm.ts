import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { auth } from "./auth";

// The single source of truth for who may see couples' contact details. There is no second
// allowlist in the frontend to fall out of sync with this one; the browser copy is a courtesy
// redirect, and this is the gate that actually holds.
const ALLOWED = new Set(["rekindle", "luis", "support", "miguel"]);

async function requireStaff(ctx: any) {
  const userId = await auth.getUserId(ctx);
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const user = await ctx.db.get(userId);
  if (!user || !ALLOWED.has(String(user.role || ""))) {
    return { ok: false as const, error: "This account does not have access to the Rekindle CRM." };
  }
  return { ok: true as const, user };
}

/** Cheap probe the login page uses to decide whether to let someone through. */
export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const gate = await requireStaff(ctx);
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return { ok: true as const, email: gate.user.email ?? null, name: gate.user.name ?? null, role: gate.user.role ?? null };
  },
});

export const listLeads = query({
  args: {},
  handler: async (ctx) => {
    const gate = await requireStaff(ctx);
    if (!gate.ok) return { ok: false as const, error: gate.error, leads: [] };
    const rows = await ctx.db.query("rekindle_leads").withIndex("by_created").order("desc").collect();
    // Field names deliberately mirror the old Supabase row shape so the dashboard's rendering
    // code did not have to be rewritten during the migration. created_at is returned as an ISO
    // string for the same reason: the frontend already formats it that way.
    return {
      ok: true as const,
      leads: rows.map((r: any) => ({
        id: r._id,
        created_at: new Date(r.created_at).toISOString(),
        partner_a_first: r.partner_a_first,
        partner_a_last: r.partner_a_last,
        partner_a_email: r.partner_a_email,
        partner_a_phone: r.partner_a_phone,
        partner_b_first: r.partner_b_first || "",
        partner_b_last: r.partner_b_last || "",
        partner_b_email: r.partner_b_email || "",
        partner_b_phone: r.partner_b_phone || "",
        raising_children: r.raising_children || "",
        years_together: r.years_together || "",
        preferred_cohort: r.preferred_cohort || "",
        focus: r.focus || "",
        how_heard: r.how_heard || "",
        payment_plan: r.payment_plan || "",
        contact_just_me: !!r.contact_just_me,
        paid_at: r.paid_at ?? null,
        status: r.status,
        cohort: r.cohort || "",
        notes: r.notes || "",
        confirmation_sent_at: r.confirmation_sent_at ?? null,
        email_status: r.email_status || "",
      })),
    };
  },
});

export const setLeadStatus = mutation({
  args: { id: v.id("rekindle_leads"), status: v.string(), notes: v.optional(v.string()), cohort: v.optional(v.string()) },
  handler: async (ctx, { id, status, notes, cohort }) => {
    const gate = await requireStaff(ctx);
    if (!gate.ok) return { ok: false as const, error: gate.error };
    const patch: Record<string, unknown> = { status };
    if (notes !== undefined) patch.notes = notes;
    if (cohort !== undefined) patch.cohort = cohort;
    await ctx.db.patch(id, patch);
    return { ok: true as const };
  },
});
