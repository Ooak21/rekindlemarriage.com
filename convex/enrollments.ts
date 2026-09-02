import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { EASYPAY_CENTS } from "./lib/plans";

const DAY = 24 * 3600 * 1000;

function addMonth(ts: number): number {
  const d = new Date(ts);
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

export const createPending = internalMutation({
  args: {
    lead_id: v.id("rekindle_leads"),
    order_ref: v.string(),
    plan: v.string(),
    amount_due_cents: v.number(),
    total_cents: v.number(),
    payments_cap: v.number(),
    email: v.string(),
    test_mode: v.boolean(),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query("rekindle_enrollments")
      .withIndex("by_order_ref", (q) => q.eq("order_ref", a.order_ref))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("rekindle_enrollments", {
      lead_id: a.lead_id,
      order_ref: a.order_ref,
      plan: a.plan,
      status: "pending_payment",
      total_cents: a.total_cents,
      amount_due_cents: a.amount_due_cents,
      paid_cents: 0,
      payments_made: 0,
      payments_cap: a.payments_cap,
      email: a.email,
      test_mode: a.test_mode,
      created_at: Date.now(),
    });
  },
});

export const attachCheckout = internalMutation({
  args: { order_ref: v.string(), checkout_id: v.string() },
  handler: async (ctx, { order_ref, checkout_id }) => {
    const row = await ctx.db
      .query("rekindle_enrollments")
      .withIndex("by_order_ref", (q) => q.eq("order_ref", order_ref))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, { clover_checkout_id: checkout_id });
  },
});

export const getByOrderRef = internalQuery({
  args: { order_ref: v.string() },
  handler: async (ctx, { order_ref }) =>
    await ctx.db
      .query("rekindle_enrollments")
      .withIndex("by_order_ref", (q) => q.eq("order_ref", order_ref))
      .unique(),
});

export const getByCheckout = internalQuery({
  args: { checkout_id: v.string() },
  handler: async (ctx, { checkout_id }) =>
    await ctx.db
      .query("rekindle_enrollments")
      .withIndex("by_checkout", (q) => q.eq("clover_checkout_id", checkout_id))
      .unique(),
});

export const listPending = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const rows = await ctx.db
      .query("rekindle_enrollments")
      .withIndex("by_status", (q) => q.eq("status", "pending_payment"))
      .collect();
    return rows.filter((r) => r.created_at >= cutoff).map((r) => ({
      order_ref: r.order_ref,
      checkout_id: r.clover_checkout_id,
      plan: r.plan,
      email: r.email,
      created_at: r.created_at,
      test_mode: r.test_mode,
    }));
  },
});

export const markPaid = internalMutation({
  args: {
    order_ref: v.string(),
    payment_id: v.optional(v.string()),
    amount_cents: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("rekindle_enrollments")
      .withIndex("by_order_ref", (q) => q.eq("order_ref", a.order_ref))
      .unique();
    if (!row) return { ok: false as const, reason: "missing" };
    if (row.status === "paid" || row.status === "active" || row.status === "complete") {
      return { ok: true as const, already: true as const, status: row.status };
    }
    const now = Date.now();
    const charged = a.amount_cents ?? row.amount_due_cents;
    const paidCents = row.paid_cents + charged;
    const made = row.payments_made + 1;
    const done = row.plan === "pay_in_full" || made >= row.payments_cap || paidCents >= row.total_cents;
    const nextStatus = done ? "complete" : "active";
    await ctx.db.patch(row._id, {
      status: nextStatus,
      paid_cents: paidCents,
      payments_made: made,
      clover_payment_id: a.payment_id || row.clover_payment_id,
      paid_at: now,
      next_bill_at: done || row.test_mode ? undefined : addMonth(now),
      last_error: undefined,
    });
    const lead = await ctx.db.get(row.lead_id);
    if (lead && lead.status === "reserved") {
      await ctx.db.patch(row.lead_id, { status: "paid", paid_at: now });
    } else if (lead) {
      await ctx.db.patch(row.lead_id, { paid_at: now });
    }
    if (!row.test_mode) {
      await ctx.scheduler.runAfter(0, internal.mailer.sendPaidEmails, {
        lead_id: String(row.lead_id),
        plan: row.plan,
        amount_cents: charged,
        complete: done,
      });
    }
    return { ok: true as const, already: false as const, status: nextStatus, lead_id: row.lead_id };
  },
});

export const attachCustomer = internalMutation({
  args: { order_ref: v.string(), customer_id: v.string() },
  handler: async (ctx, { order_ref, customer_id }) => {
    const row = await ctx.db
      .query("rekindle_enrollments")
      .withIndex("by_order_ref", (q) => q.eq("order_ref", order_ref))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, { clover_customer_id: customer_id });
  },
});

export const markVaultFailed = internalMutation({
  args: { order_ref: v.string(), detail: v.string() },
  handler: async (ctx, { order_ref, detail }) => {
    const row = await ctx.db
      .query("rekindle_enrollments")
      .withIndex("by_order_ref", (q) => q.eq("order_ref", order_ref))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, { last_error: `card-on-file failed: ${detail.slice(0, 240)}` });
  },
});

export const dueRebills = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const rows = await ctx.db
      .query("rekindle_enrollments")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
    return rows
      .filter(
        (s) =>
          !s.test_mode &&
          !!s.clover_customer_id &&
          typeof s.next_bill_at === "number" &&
          s.next_bill_at <= now &&
          s.payments_made < s.payments_cap &&
          s.paid_cents < s.total_cents,
      )
      .map((s) => ({
        _id: s._id,
        order_ref: s.order_ref,
        clover_customer_id: s.clover_customer_id as string,
        remaining: Math.min(EASYPAY_CENTS, s.total_cents - s.paid_cents),
        payments_made: s.payments_made,
        payments_cap: s.payments_cap,
      }));
  },
});

export const recordRebillSuccess = internalMutation({
  args: { id: v.id("rekindle_enrollments"), charge_id: v.string(), amount_cents: v.number() },
  handler: async (ctx, { id, charge_id, amount_cents }) => {
    const s = await ctx.db.get(id);
    if (!s) return;
    const now = Date.now();
    const billed = s.payments_made + 1;
    const paid = s.paid_cents + amount_cents;
    const done = billed >= s.payments_cap || paid >= s.total_cents;
    await ctx.db.patch(id, {
      status: done ? "complete" : "active",
      payments_made: billed,
      paid_cents: paid,
      last_charge_id: charge_id,
      last_charge_at: now,
      fail_count: 0,
      last_error: done ? `complete: ${billed} of ${s.payments_cap}` : undefined,
      next_bill_at: done ? undefined : addMonth(now),
    });
  },
});

export const recordRebillFailure = internalMutation({
  args: { id: v.id("rekindle_enrollments"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    const s = await ctx.db.get(id);
    if (!s) return;
    const fail = (s.fail_count || 0) + 1;
    await ctx.db.patch(id, {
      status: fail >= 3 ? "past_due" : s.status,
      fail_count: fail,
      last_error: error.slice(0, 300),
      next_bill_at: Date.now() + DAY,
    });
  },
});

async function confirmOne(ctx: any, orderRef: string, checkoutId?: string, paymentId?: string) {
  const row = await ctx.runQuery(internal.enrollments.getByOrderRef, { order_ref: orderRef });
  if (!row) return { ok: false as const, reason: "missing" };
  if (row.status !== "pending_payment") {
    return { ok: true as const, status: row.status, already: true as const };
  }

  let payId = paymentId || null;
  if (!payId) {
    const found = await ctx.runAction(internal.clover.findPaymentForOrderRef, {
      orderRef,
      sinceMs: row.created_at - 60_000,
    });
    if (!found.paid) return { ok: true as const, status: "pending_payment", already: false as const };
    payId = found.paymentId;
  }

  const marked = await ctx.runMutation(internal.enrollments.markPaid, {
    order_ref: orderRef,
    payment_id: payId || undefined,
  });
  if (!marked.ok) return { ok: false as const, reason: marked.reason };

  if (row.plan === "easypay" && !row.test_mode && !marked.already) {
    const looked = await ctx.runAction(internal.clover.getCustomerIdFromHostedPayment, {
      checkoutId,
      paymentId: payId || undefined,
      email: row.email,
    });
    if (looked.customerId) {
      await ctx.runMutation(internal.enrollments.attachCustomer, {
        order_ref: orderRef,
        customer_id: looked.customerId,
      });
    } else {
      await ctx.runMutation(internal.enrollments.markVaultFailed, {
        order_ref: orderRef,
        detail: looked.method || "not_found",
      });
    }
  }
  return { ok: true as const, status: marked.status, already: marked.already };
}

export const confirmByRef = internalAction({
  args: { order_ref: v.string() },
  handler: async (ctx, { order_ref }) => {
    const row = await ctx.runQuery(internal.enrollments.getByOrderRef, { order_ref });
    return await confirmOne(ctx, order_ref, row?.clover_checkout_id, row?.clover_payment_id);
  },
});

// On-page Clover iframe: the browser tokenizes the card (clv_) and we charge here.
// Amount always comes from the enrollment row, never from the client.
export const payWithToken = internalAction({
  args: { order_ref: v.string(), source: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.runQuery(internal.enrollments.getByOrderRef, { order_ref: a.order_ref });
    if (!row) return { ok: false as const, error: "Reservation was not found." };
    if (row.status !== "pending_payment") {
      return { ok: true as const, already: true as const, status: row.status };
    }
    if (!a.source.startsWith("clv_")) {
      return { ok: false as const, error: "Card could not be tokenized. Please try again." };
    }

    let chargeSource = a.source;
    if (row.plan === "easypay") {
      const vaulted = await ctx.runAction(internal.clover.createCustomer, {
        source: a.source,
        email: row.email,
      });
      if (vaulted.customerId) {
        chargeSource = vaulted.customerId;
        await ctx.runMutation(internal.enrollments.attachCustomer, {
          order_ref: a.order_ref,
          customer_id: vaulted.customerId,
        });
      } else {
        await ctx.runMutation(internal.enrollments.markVaultFailed, {
          order_ref: a.order_ref,
          detail: "createCustomer missed on first payment",
        });
      }
    }

    const description =
      row.plan === "easypay"
        ? `Rekindle EasyPay 1 of ${row.payments_cap}`
        : "Rekindle Marriage Workshop — Pay in Full";
    const charged = await ctx.runAction(internal.clover.chargeCustomer, {
      customerId: chargeSource,
      amountCents: row.amount_due_cents,
      description,
      recurring: false,
      idempotencyKey: `rk-pay-${a.order_ref}`,
    });
    if (!charged.ok || !charged.chargeId) {
      return { ok: false as const, error: charged.detail || "Payment could not be completed." };
    }

    const marked = await ctx.runMutation(internal.enrollments.markPaid, {
      order_ref: a.order_ref,
      payment_id: charged.chargeId,
      amount_cents: row.amount_due_cents,
    });
    if (!marked.ok) return { ok: false as const, error: marked.reason || "Could not record payment." };
    return { ok: true as const, already: marked.already, status: marked.status, amountCents: row.amount_due_cents };
  },
});

export const confirmFromWebhook = internalAction({
  args: {
    checkout_id: v.optional(v.string()),
    payment_id: v.optional(v.string()),
    order_ref: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    let orderRef = a.order_ref || "";
    if (!orderRef && a.checkout_id) {
      const byCo = await ctx.runQuery(internal.enrollments.getByCheckout, { checkout_id: a.checkout_id });
      if (byCo) orderRef = byCo.order_ref;
    }
    if (!orderRef) return { ok: false as const, reason: "no_order_ref" };
    return await confirmOne(ctx, orderRef, a.checkout_id, a.payment_id);
  },
});

export const confirmPendingSweep = internalAction({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.runQuery(internal.enrollments.listPending, {});
    let confirmed = 0;
    for (const e of pending) {
      const r = await confirmOne(ctx, e.order_ref, e.checkout_id, undefined);
      if (r.ok && r.status && r.status !== "pending_payment" && !r.already) confirmed++;
    }
    console.log("[rekindle] confirmPendingSweep", pending.length, "pending", confirmed, "confirmed");
    return { pending: pending.length, confirmed };
  },
});

export const runBilling = internalAction({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.runQuery(internal.enrollments.dueRebills, { now: Date.now() });
    let charged = 0, failed = 0;
    for (const s of due) {
      if (s.remaining <= 0) continue;
      const r = await ctx.runAction(internal.clover.chargeCustomer, {
        customerId: s.clover_customer_id,
        amountCents: s.remaining,
        description: `Rekindle EasyPay ${s.payments_made + 1} of ${s.payments_cap}`,
        recurring: true,
        idempotencyKey: `rk-${s.order_ref}-${s.payments_made + 1}`,
      });
      if (r.ok && r.chargeId) {
        await ctx.runMutation(internal.enrollments.recordRebillSuccess, {
          id: s._id as Id<"rekindle_enrollments">,
          charge_id: r.chargeId,
          amount_cents: s.remaining,
        });
        charged++;
      } else {
        await ctx.runMutation(internal.enrollments.recordRebillFailure, {
          id: s._id as Id<"rekindle_enrollments">,
          error: r.detail || "charge failed",
        });
        failed++;
      }
    }
    console.log("[rekindle] runBilling due", due.length, "charged", charged, "failed", failed);
    return { due: due.length, charged, failed };
  },
});
