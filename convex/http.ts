import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { EMBER_SYSTEM_PROMPT } from "./emberPrompt";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
      consent: Boolean(body.consent),
      source: str(body.source, 40) || "website",
    });

    // Sent inline rather than fire-and-forget so the caller learns the truth. The reservation is
    // already saved at this point, so a failure here degrades to "we have you, the email did not
    // go" instead of losing the couple.
    const lead = await ctx.runQuery(internal.reserve.get, { id });
    const status: any = await ctx.runAction(internal.mailer.sendReservationEmails, { lead_id: id, lead });
    await ctx.runMutation(internal.reserve.recordEmailOutcome, { id, couple: status.couple, team: status.team });

    return json(200, { ok: true, id, email: status });
  }),
});


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

// --- Text brain: streams Claude's reply as plain text (same contract the UI expects).
http.route({
  path: "/ember-chat",
  method: "POST",
  handler: httpAction(async (_ctx, req) => {
    let body: any = null;
    try { body = await req.json(); } catch { body = null; }
    const { messages, quiz } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response("Missing messages", { status: 400, headers: emberCors });
    }

    const trimmed = messages.slice(-20).map((m: any) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000),
    }));
    // Claude requires the conversation to open on a user turn.
    while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
    if (trimmed.length === 0) return new Response("Missing user message", { status: 400, headers: emberCors });

    let system = EMBER_SYSTEM_PROMPT;
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
        max_tokens: 1024,
        // The system prompt is long and static, so caching it cuts time to first token on
        // every turn after the first.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        thinking: { type: "disabled" },
        messages: trimmed,
        stream: true,
      }),
    });
    if (!upstream.ok || !upstream.body) {
      return new Response("Ember could not start. Please try again.", { status: 502, headers: emberCors });
    }

    // Re-emit only the text deltas, so the browser receives plain text rather than SSE.
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

export default http;
