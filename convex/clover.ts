"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

// Hosted Checkout + card-on-file, same Vitality merchant (Luis 8/25: Rekindle money
// runs on the family Clover rail). Do not default the success URL to the GLP-1 page.
// Env:
//   CLOVER_ENV, CLOVER_MERCHANT_ID, CLOVER_API_TOKEN
//   CLOVER_SUCCESS_URL = https://rekindlemarriage.com/marriageworkshop/?paid=1
//   CLOVER_WEBHOOK_SIGNING_SECRET, CLOVER_WEBHOOK_TOKEN
function env() {
  const e = process.env.CLOVER_ENV || "production";
  const base = e === "sandbox" ? "https://apisandbox.dev.clover.com" : "https://api.clover.com";
  return {
    base,
    mid: process.env.CLOVER_MERCHANT_ID || "",
    token: process.env.CLOVER_API_TOKEN || "",
    successUrl:
      process.env.CLOVER_SUCCESS_URL ||
      "https://rekindlemarriage.com/marriageworkshop/?paid=1",
  };
}

function sclBase() {
  const e = process.env.CLOVER_ENV || "production";
  return e === "sandbox" ? "https://scl-sandbox.dev.clover.com" : "https://scl.clover.com";
}

async function platformGet(path: string): Promise<any | null> {
  const { base, mid, token } = env();
  if (!mid || !token) return null;
  try {
    const res = await fetch(base + path, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-Clover-Merchant-Id": mid,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      console.log("[clover] platformGet", res.status, path.slice(0, 80), text.slice(0, 200));
      return null;
    }
    return JSON.parse(text);
  } catch (e) {
    console.warn("[clover] platformGet error", path, (e as Error).message);
    return null;
  }
}

export const createCheckout = internalAction({
  args: {
    orderRef: v.string(),
    amountCents: v.number(),
    itemName: v.string(),
    customerEmail: v.optional(v.string()),
    customerFirstName: v.optional(v.string()),
    customerLastName: v.optional(v.string()),
  },
  handler: async (_ctx, a) => {
    const { base, mid, token, successUrl } = env();
    if (!mid || !token) return { configured: false, href: null as string | null, checkoutId: null as string | null };
    const note = `orderRef:${a.orderRef}`;
    const customer: Record<string, string> = {};
    if (a.customerEmail) customer.email = a.customerEmail;
    if (a.customerFirstName) customer.firstName = a.customerFirstName;
    if (a.customerLastName) customer.lastName = a.customerLastName;

    const success =
      successUrl + (successUrl.includes("?") ? "&" : "?") + "ref=" + encodeURIComponent(a.orderRef);
    const failure = successUrl.replace("paid=1", "paid=0");

    const body = {
      customer,
      shoppingCart: {
        lineItems: [{ name: a.itemName, note, unitQty: 1, price: a.amountCents }],
      },
      redirectUrls: { success, failure },
    };
    const res = await fetch(base + "/invoicingcheckoutservice/v1/checkouts", {
      method: "POST",
      headers: {
        "X-Clover-Merchant-Id": mid,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Clover createCheckout ${res.status}: ${text}`);
    const data = JSON.parse(text);
    const checkoutId = data.checkoutSessionId || data.checkoutSessionUuid || data.id || null;
    console.log(
      "[clover] createCheckout ok:",
      JSON.stringify({ href: !!data.href, checkoutId, amount: a.amountCents, orderRef: a.orderRef }),
    );
    return { configured: true, href: data.href || null, checkoutId, amountCents: a.amountCents };
  },
});

// Hosted Checkout webhook Data=checkoutSessionId, Id=paymentId. Clover does not hand back a
// clv_ token from hosted checkout, so this walks Platform payment → vaulted Ecommerce customer.
export const getCustomerIdFromHostedPayment = internalAction({
  args: {
    checkoutId: v.optional(v.string()),
    paymentId: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (_ctx, a) => {
    const { mid, token } = env();
    if (!mid || !token) return { customerId: null as string | null, method: "unconfigured" };
    const tried: string[] = [];

    if (a.paymentId) {
      tried.push("platform_payment");
      const payment = await platformGet(
        `/v3/merchants/${mid}/payments/${a.paymentId}?expand=cardTransaction,order`,
      );
      if (payment) {
        const cardToken =
          payment.cardTransaction?.token ||
          payment.cardTransaction?.cardToken ||
          payment.cardTransaction?.vaultedCardToken;
        if (cardToken && typeof cardToken === "string") {
          const cust = await vaultEcommerceCustomer(cardToken, a.email);
          if (cust) return { customerId: cust, method: "cardTransaction_token" };
        }
        const orderId = payment.order?.id;
        if (orderId) {
          tried.push("platform_order");
          const order = await platformGet(
            `/v3/merchants/${mid}/orders/${orderId}?expand=customers,payments`,
          );
          const customers = order?.customers?.elements || [];
          for (const pc of customers) {
            if (!pc?.id) continue;
            const vaulted = await vaultFromPlatformCustomer(pc.id, a.email);
            if (vaulted) return { customerId: vaulted, method: "platform_customer_cards" };
          }
        }
      }
    }

    tried.push("ecommerce_charges_scan");
    try {
      const res = await fetch(sclBase() + "/v1/charges?limit=25", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        const charges: any[] = data?.data || data?.elements || (Array.isArray(data) ? data : []);
        const email = (a.email || "").toLowerCase();
        for (const ch of charges) {
          if (!ch?.paid && ch?.status !== "succeeded") continue;
          const chEmail = (ch.receipt_email || ch.metadata?.email || "").toLowerCase();
          if (email && chEmail && chEmail !== email) continue;
          const src = ch.source?.id || ch.source;
          if (typeof src === "string" && src.startsWith("clv_")) {
            const cust = await vaultEcommerceCustomer(src, a.email);
            if (cust) return { customerId: cust, method: "recent_charge_source" };
          }
          if (typeof ch.customer === "string" && ch.customer.length > 4) {
            return { customerId: ch.customer, method: "recent_charge_customer_field" };
          }
        }
      }
    } catch (e) {
      console.warn("[clover] charges scan:", (e as Error).message);
    }

    if (a.email) {
      tried.push("platform_customer_email");
      const encoded = encodeURIComponent(a.email);
      const list = await platformGet(
        `/v3/merchants/${mid}/customers?filter=emailAddress=${encoded}&expand=cards`,
      );
      const elements = list?.elements || [];
      for (const pc of elements) {
        if (!pc?.id) continue;
        const vaulted = await vaultFromPlatformCustomer(pc.id, a.email);
        if (vaulted) return { customerId: vaulted, method: "platform_email_match" };
      }
    }

    console.log("[clover] getCustomerIdFromHostedPayment miss:", JSON.stringify({ tried, paymentId: a.paymentId, checkoutId: a.checkoutId }));
    return { customerId: null as string | null, method: "not_found", tried };
  },
});

export const createCustomer = internalAction({
  args: { source: v.string(), email: v.optional(v.string()) },
  handler: async (_ctx, a) => {
    const customerId = await vaultEcommerceCustomer(a.source, a.email);
    return { customerId };
  },
});

async function vaultEcommerceCustomer(source: string, email?: string): Promise<string | null> {
  const token = process.env.CLOVER_API_TOKEN || "";
  if (!token || !source) return null;
  const res = await fetch(sclBase() + "/v1/customers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ source, email: email || undefined, ecomind: "ecom" }),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (res.ok && data?.id) {
    console.log("[clover] vaultEcommerceCustomer ok:", data.id);
    return data.id as string;
  }
  console.log("[clover] vaultEcommerceCustomer fail:", res.status, typeof data === "string" ? data.slice(0, 120) : data?.message || data?.error?.message);
  return null;
}

async function vaultFromPlatformCustomer(platformCustomerId: string, email?: string): Promise<string | null> {
  const { mid } = env();
  const cust = await platformGet(`/v3/merchants/${mid}/customers/${platformCustomerId}?expand=cards`);
  const cards = cust?.cards?.elements || cust?.cards || [];
  const cardList = Array.isArray(cards) ? cards : [];
  for (const card of cardList) {
    const cardToken = card?.token || card?.cardToken || card?.source;
    if (typeof cardToken === "string" && (cardToken.startsWith("clv_") || cardToken.length > 8)) {
      const vaulted = await vaultEcommerceCustomer(cardToken, email || cust?.emailAddress);
      if (vaulted) return vaulted;
    }
  }
  return null;
}

// Clover Hosted Checkout webhook lives on the Vitality merchant, so Rekindle cannot steal
// that URL. After redirect we look up the order by the line-item note we stamped.
export const findPaymentForOrderRef = internalAction({
  args: { orderRef: v.string(), sinceMs: v.optional(v.number()) },
  handler: async (_ctx, a) => {
    const { mid } = env();
    if (!mid) return { paid: false as const, reason: "unconfigured" };
    const since = a.sinceMs || Date.now() - 48 * 3600 * 1000;
    const needle = `orderRef:${a.orderRef}`;

    const orders = await platformGet(
      `/v3/merchants/${mid}/orders?filter=clientCreatedTime>=${since}&expand=lineItems,payments&limit=100`,
    );
    const elements = orders?.elements || [];
    for (const o of elements) {
      const items = o.lineItems?.elements || o.lineItems || [];
      const list = Array.isArray(items) ? items : [];
      const hit = list.some(
        (i: any) =>
          String(i.note || "").includes(a.orderRef) ||
          String(i.note || "").includes(needle) ||
          String(o.note || "").includes(a.orderRef),
      );
      if (!hit) continue;
      const payState = String(o.paymentState || o.state || "").toUpperCase();
      const payments = o.payments?.elements || [];
      const payList = Array.isArray(payments) ? payments : [];
      const goodPay = payList.find((p: any) => {
        const r = String(p.result || p.status || "").toUpperCase();
        return r === "SUCCESS" || r === "APPROVED" || r === "PAID";
      });
      const paid = payState === "PAID" || !!goodPay;
      if (paid) {
        return {
          paid: true as const,
          paymentId: (goodPay?.id || payList[0]?.id || null) as string | null,
          orderId: o.id as string,
          paymentState: payState,
        };
      }
    }

    const payments = await platformGet(
      `/v3/merchants/${mid}/payments?filter=createdTime>=${since}&expand=order&limit=50`,
    );
    const pays = payments?.elements || [];
    for (const p of pays) {
      const result = String(p.result || "").toUpperCase();
      if (result && result !== "SUCCESS") continue;
      const note = String(p.note || p.order?.note || "");
      if (note.includes(a.orderRef)) {
        return { paid: true as const, paymentId: p.id as string, orderId: p.order?.id || null, paymentState: result };
      }
    }

    return { paid: false as const, reason: "not_found" };
  },
});

export const chargeCustomer = internalAction({
  args: {
    customerId: v.string(),
    amountCents: v.number(),
    description: v.optional(v.string()),
    recurring: v.optional(v.boolean()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (_ctx, a) => {
    const token = process.env.CLOVER_API_TOKEN || "";
    if (!token) return { ok: false as const, detail: "CLOVER_API_TOKEN not set" };
    const isRecurring = a.recurring !== false;
    const body: Record<string, unknown> = {
      amount: a.amountCents,
      currency: "usd",
      source: a.customerId,
      ecomind: "ecom",
      capture: true,
      description: a.description || "Rekindle EasyPay",
      stored_credentials: isRecurring
        ? { sequence: "SUBSEQUENT", is_scheduled: true, initiator: "MERCHANT" }
        : { sequence: "FIRST", is_scheduled: false, initiator: "CARDHOLDER" },
    };
    const res = await fetch(sclBase() + "/v1/charges", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(a.idempotencyKey ? { "idempotency-key": a.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    console.log(
      "[clover] chargeCustomer",
      res.status,
      JSON.stringify({ id: data?.id, status: data?.status, paid: data?.paid, err: data?.error?.message || data?.message }),
    );
    if (!res.ok || !(data?.paid || data?.status === "succeeded")) {
      return {
        ok: false as const,
        status: res.status,
        detail: typeof data === "string" ? data.slice(0, 300) : data?.error?.message || data?.message || `status ${res.status}`,
      };
    }
    return { ok: true as const, chargeId: data.id as string, status: data.status };
  },
});
