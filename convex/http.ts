import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { EMBER_SYSTEM_PROMPT, EMBER_GATEWAY_PROMPT } from "./emberPrompt";
import { verifyCloverWebhookSignature } from "./lib/cloverSig";
import { specForPlan } from "./lib/plans";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

const http = httpRouter();

http.route({
  path: "/reserve",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});

http.route({
  path: "/reserve",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }

    // Honeypot. Silently accept so a bot sees success and does not retry.
    if (str(body.bot_field)) return json(200, { ok: true });

    const partner_a_first = str(body.partnerA_first, 80);
    const partner_a_last = str(body.partnerA_last, 80);
    const partner_a_email = str(body.partnerA_email, 160);
    const partner_a_phone = str(body.partnerA_phone, 40);
    if (!partner_a_first || !partner_a_last || !partner_a_email || !partner_a_phone) {
      return json(400, { ok: false, error: "Partner A first name, last name, email, and phone are required." });
    }

    const id = await ctx.runMutation(internal.reserve.create, {
      partner_a_first, partner_a_last, partner_a_email, partner_a_phone,
      partner_b_first: str(body.partnerB_first, 80) || undefined,
      partner_b_last: str(body.partnerB_last, 80) || undefined,
      partner_b_email: str(body.partnerB_email, 160) || undefined,
      partner_b_phone: str(body.partnerB_phone, 40) || undefined,
      raising_children: str(body.raising_children, 20) || undefined,
      years_together: str(body.years_together, 40) || undefined,
      preferred_cohort: str(body.preferred_cohort, 60) || undefined,
      focus: str(body.focus, 2000) || undefined,
      how_heard: str(body.how_heard, 60) || undefined,
      payment_plan: str(body.payment_plan, 30) || undefined,
      contact_just_me: body.contact_just_me === true || str(body.contact_mode, 20) === "just_me",
      consent: Boolean(body.consent),
      source: str(body.source, 40) || "website",
    });

    const isTest = partner_a_first.startsWith("ZZTest");
    const plan = str(body.payment_plan, 30);
    const spec = specForPlan(plan, isTest);

    let amountCents: number | null = null;
    let orderRef: string | null = null;

    if (spec) {
      orderRef = "rk_" + String(id);
      amountCents = spec.amountCents;
      await ctx.runMutation(internal.enrollments.createPending, {
        lead_id: id,
        order_ref: orderRef,
        plan,
        amount_due_cents: spec.amountCents,
        total_cents: spec.totalCents,
        payments_cap: spec.cap,
        email: partner_a_email,
        test_mode: isTest,
      });
    }

    // Same ZZTest convention as the phone path: write is real, outbound is silent.
    // Test charges $1 on the on-page Clover iframe, not a hosted clover.com redirect.
    if (isTest) {
      return json(200, {
        ok: true,
        id,
        email: "suppressed-test",
        orderRef,
        amountCents,
        plan,
        itemName: spec?.itemName || null,
        testMode: true,
      });
    }

    // Sent inline rather than fire-and-forget so the caller learns the truth. The reservation is
    // already saved at this point, so a failure here degrades to "we have you, the email did not
    // go" instead of losing the couple.
    const lead = await ctx.runQuery(internal.reserve.get, { id });
    const status: any = await ctx.runAction(internal.mailer.sendReservationEmails, { lead_id: id, lead });
    await ctx.runMutation(internal.reserve.recordEmailOutcome, { id, couple: status.couple, team: status.team });

    return json(200, {
      ok: true,
      id,
      email: status,
      orderRef,
      amountCents,
      plan,
      itemName: spec?.itemName || null,
    });
  }),
});

http.route({
  path: "/pay",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});
http.route({
  path: "/pay",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }
    const orderRef = str(body.order_ref, 80);
    const source = str(body.source, 120);
    if (!orderRef.startsWith("rk_") || !source.startsWith("clv_")) {
      return json(400, { ok: false, error: "Payment is missing the reservation or the card token." });
    }
    const result: any = await ctx.runAction(internal.enrollments.payWithToken, {
      order_ref: orderRef,
      source,
    });
    if (!result?.ok) return json(402, { ok: false, error: result?.error || "Payment could not be completed." });
    return json(200, result);
  }),
});

http.route({
  path: "/payment-status",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});
http.route({
  path: "/payment-status",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const ref = new URL(req.url).searchParams.get("ref") || "";
    if (!ref) return json(400, { error: "ref required" });
    const row = await ctx.runQuery(internal.enrollments.getByOrderRef, { order_ref: ref });
    if (!row) return json(200, { ok: true, processed: false, status: "unknown" });
    if (row.status === "pending_payment") {
      const confirmed = await ctx.runAction(internal.enrollments.confirmByRef, { order_ref: ref });
      return json(200, {
        ok: true,
        processed: confirmed.status !== "pending_payment",
        status: confirmed.status || "pending_payment",
      });
    }
    return json(200, { ok: true, processed: true, status: row.status });
  }),
});

function parseCloverWebhook(body: any) {
  const checkoutId =
    body.Data || body.data || body.checkoutSessionId || body?.checkout?.id || body?.object?.checkoutSessionId || null;
  const paymentId = body.Id || body.id || body.paymentId || null;
  const status = String(body.Status || body.status || "").toUpperCase();
  const type = String(body.Type || body.type || "").toUpperCase();
  const paid =
    body.paid === true ||
    status === "APPROVED" ||
    (type === "PAYMENT" && status === "APPROVED") ||
    /\b(APPROVED|PAID|SUCCEEDED|SUCCESS)\b/.test(status);
  return {
    checkoutId: checkoutId ? String(checkoutId) : null,
    paymentId: paymentId ? String(paymentId) : null,
    paid,
    type,
    status,
  };
}

const cloverWebhook = httpAction(async (ctx, req) => {
  const raw = await req.text();
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* keep {} */
  }
  if (body.verificationCode) {
    return json(200, { verificationCode: body.verificationCode });
  }

  const pathToken = new URL(req.url).pathname.split("/clover-webhook/")[1] || "";
  const expectedToken = process.env.CLOVER_WEBHOOK_TOKEN || "";
  if (expectedToken && pathToken !== expectedToken) {
    console.warn("[clover-webhook] path token mismatch");
    return json(401, { error: "unauthorized" });
  }

  const sig = req.headers.get("Clover-Signature") || req.headers.get("clover-signature");
  if (process.env.CLOVER_WEBHOOK_SIGNING_SECRET && !(await verifyCloverWebhookSignature(raw, sig))) {
    return json(401, { error: "invalid clover signature" });
  }

  const parsed = parseCloverWebhook(body);
  if (!parsed.paid) return json(200, { ok: true, ignored: "not a paid event", type: parsed.type, status: parsed.status });

  const noteRef = String(body.orderRef || body.reference || "");
  const rkRef = noteRef.startsWith("rk_") ? noteRef : "";
  const result = await ctx.runAction(internal.enrollments.confirmFromWebhook, {
    checkout_id: parsed.checkoutId || undefined,
    payment_id: parsed.paymentId || undefined,
    order_ref: rkRef || undefined,
  });
  return json(200, { ok: true, ...result });
});
http.route({ pathPrefix: "/clover-webhook/", method: "POST", handler: cloverWebhook });
http.route({ pathPrefix: "/clover-webhook/", method: "OPTIONS", handler: httpAction(async () => new Response(null, { status: 204, headers: cors })) });


// ---------------------------------------------------------------------------
// EMBER. Two brains sharing one prompt, exactly as on the previous backend:
// typed text runs on Claude, hands-free voice runs on xAI's realtime Grok agent.
// The prompt is single-sourced in emberPrompt.ts on purpose. Two copies drift,
// and the safety language is the whole point of it.
// ---------------------------------------------------------------------------
const emberCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};
const EMBER_VOICE = "Ara";
const xaiKey = () => process.env.REKINDLE_XAI_API_KEY || "";
const preflight = httpAction(async () => new Response(null, { status: 204, headers: emberCors }));

["/ember-chat", "/ember-token", "/ember-tts", "/ember-stt"].forEach((path) => {
  http.route({ path, method: "OPTIONS", handler: preflight });
});

// --- Text brain. TWO MODES, decided by the request, not by the prompt.
//
// Public visitors get gateway Ember: a short, genuinely useful exchange that moves toward the
// workshop. Signed-in members get the full depth. The limit is enforced HERE rather than asked for
// in the prompt, because "please stay shallow" is exactly the kind of instruction a long
// conversation erodes, and anyone can retype a system prompt into a chat box.
//
// Turn cap: gateway Ember answers GATEWAY_FREE_TURNS user messages. After that the server returns
// a fixed close and never calls the model at all, so there is nothing to talk around.
//
// Honest limit: the browser sends its own history, so someone who clears it starts over. This
// shapes the default experience rather than enforcing DRM, which is the right goal for a public
// marketing page. Per-visitor server-side counting is the next step if it ever matters.
const GATEWAY_FREE_TURNS = 2;
// A crisis disclosure must never hit the turn cap. Without this, someone who says on their third
// message that they were choked gets a warm pitch for the workshop instead of a hotline. Verified
// as a real failure before this existed.
//
// This regex decides ROUTING ONLY, never wording: if it matches, we skip the cap and let Ember
// answer with her full safety instructions. That makes a false positive nearly harmless (someone
// venting simply gets another real reply) while a false negative is the thing we cannot afford,
// so it is deliberately tuned to fire easily.
const CRISIS_PATTERNS = [
  /\b(kill|hurt|harm)ing? (myself|me)\b/i,
  /\b(end|ending|take|taking) (my|her|his) (own )?life\b/i,
  /\b(want|wanted|wish|wishes|wishing) (to|i were|i was) (die|dead|gone)\b/i,
  /\bwant to die\b/i,
  /\bbetter off (without me|if i was(n't| not) here|dead)\b/i,
  /\bsuicid(e|al)\b/i,
  /\bno (point|reason) (in )?(living|going on)\b/i,
  /\b(chok|strangl)(e|ed|ing)\b/i,
  /\b(hit|hits|hitting|punch|punched|punches|shove|shoved|slap|slapped|grabb?ed|beat) (me|her|him)\b/i,
  /\bthrew (something|things|it) at me\b/i,
  /\b(afraid|scared|terrified) (of|for) (him|her|them|my (husband|wife|partner)|my safety|my life)\b/i,
  /\b(threaten|threatened|threatens|threatening)\b/i,
  /\b(wont|won't|would ?n't|does ?n't|doesnt) let me (leave|go|work|see)\b/i,
  /\b(locked|trapped) me\b/i,
  /\bforced me\b/i,
  /\bpunche?s? (the |a )?wall/i,
  /\bhide (in|from)\b.*\b(him|her|them|bathroom|car|closet)\b/i,
];
function looksLikeCrisis(text: string): boolean {
  return CRISIS_PATTERNS.some((re) => re.test(text));
}

const GATEWAY_CLOSE =
  "I would rather not half-answer something this important. What you are describing is exactly " +
  "the kind of thing the six-week workshop is built for, with Nellie and a small group of couples " +
  "working through it properly rather than in a chat window.\n\n" +
  "You can hold a seat right on this page. If you would like a lighter first step, the free " +
  "Relationship Check-in takes about two minutes and gives you a real read on where things stand.";

http.route({
  path: "/ember-chat",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let body: any = null;
    try { body = await req.json(); } catch { body = null; }
    const { messages, quiz } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response("Missing messages", { status: 400, headers: emberCors });
    }

    // A member is someone with a real session on this deployment. Anyone else is a visitor.
    const identity = await ctx.auth.getUserIdentity();
    const isMember = identity !== null;

    const trimmed = messages.slice(-20).map((m: any) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, isMember ? 4000 : 1200),
    }));
    // Claude requires the conversation to open on a user turn.
    while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
    if (trimmed.length === 0) return new Response("Missing user message", { status: 400, headers: emberCors });

    if (!isMember) {
      const userTurns = trimmed.filter((m: any) => m.role === "user").length;
      const lastUser = [...trimmed].reverse().find((m: any) => m.role === "user");
      const crisis = looksLikeCrisis(String(lastUser?.content || ""));
      if (userTurns > GATEWAY_FREE_TURNS && !crisis) {
        // Deliberately not a refusal and not an upsell. She sounds like someone who thinks the
        // real work belongs in the room, which is also true.
        return new Response(GATEWAY_CLOSE, {
          headers: { ...emberCors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    }

    let system = isMember ? EMBER_SYSTEM_PROMPT : EMBER_GATEWAY_PROMPT;
    if (quiz && Number.isFinite(quiz.score)) {
      const focus = typeof quiz.focus === "string" && quiz.focus.trim() ? quiz.focus.trim() : null;
      system +=
        `\n\n<context>The person just took the Marriage Health Score check-up. ` +
        `Their overall score is ${Math.round(quiz.score)} out of 100` +
        (focus ? `, and their weakest area is "${focus}".` : ".") +
        ` If this is the start of the conversation, open warmly with light awareness of where they are, ` +
        `without fixating on the number or sounding clinical.</context>`;
    }

    const apiKey = process.env.REKINDLE_ANTHROPIC_KEY || "";
    if (!apiKey) return new Response("Server is not configured yet.", { status: 500, headers: emberCors });

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        // Gateway replies are meant to be a few sentences. Capping tokens keeps them that way even
        // when the model feels chatty, and keeps public traffic cheap.
        max_tokens: isMember ? 1024 : 320,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        thinking: { type: "disabled" },
        messages: trimmed,
        stream: true,
      }),
    });
    if (!upstream.ok || !upstream.body) {
      return new Response("Ember could not start. Please try again.", { status: 502, headers: emberCors });
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buf = "";
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const ev = JSON.parse(payload);
                if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                  controller.enqueue(encoder.encode(ev.delta.text));
                }
              } catch { /* keep-alive lines are not JSON */ }
            }
          }
        } catch {
          try { controller.enqueue(encoder.encode("\n\nSorry, something interrupted me. Could you say that again?")); } catch { /* noop */ }
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { ...emberCors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }),
});

// --- Voice: mint a short-lived xAI token so the real key never reaches the browser.
const emberToken = httpAction(async () => {
  const apiKey = xaiKey();
  if (!apiKey) return new Response("Voice is not configured yet.", { status: 500, headers: emberCors });
  try {
    const r = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { seconds: 600 } }),
    });
    if (!r.ok) return new Response("Could not start voice session.", { status: 502, headers: emberCors });
    const data = await r.json();
    return new Response(
      JSON.stringify({ token: data.value, expires_at: data.expires_at, voice: EMBER_VOICE, instructions: EMBER_SYSTEM_PROMPT }),
      { headers: { ...emberCors, "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  } catch {
    return new Response("Voice session error.", { status: 502, headers: emberCors });
  }
});
http.route({ path: "/ember-token", method: "POST", handler: emberToken });
http.route({ path: "/ember-token", method: "GET", handler: emberToken });

// --- Read aloud: Ember's text to speech.
http.route({
  path: "/ember-tts",
  method: "POST",
  handler: httpAction(async (_ctx, req) => {
    let body: any = null;
    try { body = await req.json(); } catch { body = null; }
    const text = body && typeof body.text === "string" ? body.text.trim().slice(0, 15000) : "";
    if (!text) return new Response("Missing text", { status: 400, headers: emberCors });
    const voice = body && typeof body.voice === "string" && body.voice.trim() ? body.voice.trim() : EMBER_VOICE;
    const apiKey = xaiKey();
    if (!apiKey) return new Response("Voice is not configured yet.", { status: 500, headers: emberCors });
    try {
      const r = await fetch("https://api.x.ai/v1/tts", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          text, voice_id: voice, language: "en",
          output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
          speed: 1.0, optimize_streaming_latency: 2,
        }),
      });
      if (!r.ok) return new Response("Voice generation failed.", { status: 502, headers: emberCors });
      return new Response(await r.arrayBuffer(), {
        headers: { ...emberCors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      });
    } catch {
      return new Response("Voice error.", { status: 502, headers: emberCors });
    }
  }),
});

// --- Record then transcribe fallback for browsers that cannot hold the realtime socket.
http.route({
  path: "/ember-stt",
  method: "POST",
  handler: httpAction(async (_ctx, req) => {
    let body: any = null;
    try { body = await req.json(); } catch { body = null; }
    const audioB64 = body && typeof body.audio === "string" ? body.audio : "";
    const mimeType = (body && typeof body.mimeType === "string" && body.mimeType) || "audio/webm";
    if (!audioB64) return new Response("Missing audio", { status: 400, headers: emberCors });
    const apiKey = xaiKey();
    if (!apiKey) return new Response("Voice is not configured yet.", { status: 500, headers: emberCors });

    // Name the file by container so xAI auto-detects it: webm on Chrome, mp4 on Safari.
    const ext = mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a"
      : mimeType.includes("ogg") ? "ogg"
      : mimeType.includes("wav") ? "wav"
      : "webm";
    try {
      const bytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append("language", "en"); // every param must precede `file`
      form.append("file", new Blob([bytes], { type: mimeType }), "audio." + ext);
      const r = await fetch("https://api.x.ai/v1/stt", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!r.ok) return new Response("Transcription failed.", { status: 502, headers: emberCors });
      const data = await r.json();
      return new Response(JSON.stringify({ text: (data && data.text) || "" }), {
        headers: { ...emberCors, "Content-Type": "application/json" },
      });
    } catch {
      return new Response("Transcription error.", { status: 502, headers: emberCors });
    }
  }),
});

// Convex Auth's own endpoints (token issue, refresh, revoke). Must be registered or every
// sign-in call 404s.
auth.addHttpRoutes(http);

// ---- Ruby, the phone receptionist (Telnyx AI assistant) -------------------------------------
// Two phases on one route, mirroring the Telnyx lifecycle:
//   call start  -> return { dynamic_variables } so Ruby can greet a known couple by name
//   end of call -> the assistant's webhook tool posts what it gathered, we write the lead
// Auth: a shared secret, sent as a header by the assistant's TOOL, and as ?k= by the call-start
// dynamic-variables webhook, which is a platform webhook and cannot carry custom headers.
// This is Rekindle's own secret on Rekindle's own deployment. Nothing is shared with the clinic.
const receptionist = httpAction(async (ctx, req) => {
  const secret = process.env.REKINDLE_VOICE_SECRET || "";
  const url = new URL(req.url);
  const ok = !secret
    || req.headers.get("x-rekindle-voice-secret") === secret
    || url.searchParams.get("k") === secret;
  if (!ok) return json(401, { ok: false, error: "unauthorized" });

  let body: any = {};
  try { body = await req.json(); } catch { /* Telnyx sometimes posts an empty init */ }
  const d = body?.data?.payload ?? body?.payload ?? body?.arguments ?? body?.tool_call?.arguments ?? body ?? {};
  const pick = (keys: string[]) => {
    for (const k of keys) {
      const v = d?.[k] ?? body?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    return undefined;
  };

  const gathered = pick(["first_name", "partner_a_first", "intent", "message", "focus"]);
  const action = String(pick(["action"]) ?? "").toLowerCase();
  const isLog = action === "log_call_record" || gathered != null;

  // phase 1: recognition
  if (!isLog) {
    const from = pick(["from", "from_number", "caller_id", "telnyx_end_user_target"]);
    const r = await ctx.runQuery(internal.receptionist.lookup, { from: from ? String(from) : undefined });
    return json(200, {
      dynamic_variables: {
        program_name: "the six week Rekindle workshop",
        facilitator: "Nellie Reedy",
        is_known: r.is_known,
        first_name: r.first_name,
        lead_status: r.status,
      },
    });
  }

  // phase 2: write the lead
  const callId = String(pick(["call_control_id", "call_session_id", "conversation_id", "id"]) ?? crypto.randomUUID());
  const consentRaw = pick(["consent", "ok_to_contact"]);
  const res = await ctx.runMutation(internal.receptionist.persist, {
    call_id: callId,
    from_number: str(pick(["from", "from_number", "caller_id"]), 40) || undefined,
    partner_a_first: str(pick(["first_name", "partner_a_first"]), 80) || undefined,
    partner_a_last: str(pick(["last_name", "partner_a_last"]), 80) || undefined,
    partner_a_email: str(pick(["email", "partner_a_email"]), 200) || undefined,
    partner_a_phone: str(pick(["callback_number", "phone", "partner_a_phone"]), 40) || undefined,
    partner_b_first: str(pick(["partner_first_name", "partner_b_first", "spouse_first_name"]), 80) || undefined,
    years_together: str(pick(["years_together"]), 60) || undefined,
    raising_children: str(pick(["raising_children", "children"]), 60) || undefined,
    preferred_cohort: str(pick(["preferred_cohort", "preferred_time"]), 80) || undefined,
    focus: str(pick(["focus", "hoping_for"]), 400) || undefined,
    how_heard: str(pick(["how_heard"]), 200) || undefined,
    consent: consentRaw === true || String(consentRaw ?? "").toLowerCase() === "true" || String(consentRaw ?? "").toLowerCase() === "yes",
    intent: str(pick(["intent"]), 40) || undefined,
    message: str(pick(["message", "summary"]), 900) || undefined,
    duration_sec: Number(pick(["duration_sec"]) ?? 0) || undefined,
  });
  return json(200, { ok: true, lead_id: res.lead_id, deduped: res.deduped });
});
http.route({ path: "/receptionist", method: "POST", handler: receptionist });
http.route({ path: "/receptionist", method: "OPTIONS", handler: httpAction(async () => new Response(null, { status: 204, headers: cors })) });

export default http;
