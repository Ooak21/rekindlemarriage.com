import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// Rekindle's own backend. Previously these records lived in the shared Supabase project
// (jtifhcvbgxqwlywugvjv) alongside twelve other products, sharing one auth user pool and one set
// of auth settings. Standalone as of 2026-08-16 so Rekindle owns its own users, its own redirect
// URLs, and its own keys.
export default defineSchema({
  // Convex Auth's own tables, plus a role on users. Role is what gates the CRM; there is no
  // second allowlist to drift out of sync with it.
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    image: v.optional(v.string()),
    role: v.optional(v.string()),   // "rekindle" = full CRM access
  }).index("email", ["email"]),

  rekindle_leads: defineTable({
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
    // Enrollment option chosen on the payment cards: 'pay_in_full' | 'easypay'.
    payment_plan: v.optional(v.string()),
    contact_just_me: v.optional(v.boolean()),
    consent: v.boolean(),

    status: v.string(),               // reserved | contacted | paid | enrolled | archived
    cohort: v.optional(v.string()),
    notes: v.optional(v.string()),
    source: v.string(),

    // Whether the couple's confirmation actually left the building. NULL-equivalent (absent) means
    // we do not know, which is the honest answer for anything reserved before 2026-08-16, when both
    // sends were failing silently against an unverified sender.
    confirmation_sent_at: v.optional(v.number()),
    email_status: v.optional(v.string()),
    paid_at: v.optional(v.number()),
  })
    .index("by_created", ["created_at"])
    .index("by_email", ["partner_a_email"]),

  rekindle_enrollments: defineTable({
    lead_id: v.id("rekindle_leads"),
    order_ref: v.string(),
    plan: v.string(),                  // pay_in_full | easypay
    status: v.string(),                // pending_payment | active | complete | past_due
    total_cents: v.number(),           // 60000
    amount_due_cents: v.number(),      // first charge
    paid_cents: v.number(),
    payments_made: v.number(),
    payments_cap: v.number(),          // 1 or 12
    email: v.string(),
    test_mode: v.boolean(),
    clover_checkout_id: v.optional(v.string()),
    clover_payment_id: v.optional(v.string()),
    clover_customer_id: v.optional(v.string()),
    last_charge_id: v.optional(v.string()),
    last_charge_at: v.optional(v.number()),
    next_bill_at: v.optional(v.number()),
    fail_count: v.optional(v.number()),
    last_error: v.optional(v.string()),
    created_at: v.number(),
    paid_at: v.optional(v.number()),
  })
    .index("by_order_ref", ["order_ref"])
    .index("by_checkout", ["clover_checkout_id"])
    .index("by_lead", ["lead_id"])
    .index("by_status", ["status"]),
});
