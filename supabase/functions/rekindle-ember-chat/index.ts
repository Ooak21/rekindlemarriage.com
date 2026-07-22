// Ember's text brain. Streams Claude (Haiku 4.5) replies as plain text.
// Ported from the Vercel Node function to a Supabase Deno edge function.
// Key resolution: prefer a per-client REKINDLE_ANTHROPIC_KEY (billing isolation)
// and fall back to the shared ANTHROPIC_API_KEY so it works out of the box.
import { EMBER_SYSTEM_PROMPT } from "../_shared/ember-prompt.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  let body: any = null;
  try { body = await req.json(); } catch { body = null; }

  const { messages, quiz } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response("Missing messages", { status: 400, headers: cors });
  }

  // Keep the last 20 turns, cap length, force roles.
  const trimmed = messages.slice(-20).map((m: any) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 4000),
  }));
  // Claude requires the first message to be a user turn.
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  if (trimmed.length === 0) return new Response("Missing user message", { status: 400, headers: cors });

  // Fold the quiz result into the system prompt as context.
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

  const apiKey = Deno.env.get("REKINDLE_ANTHROPIC_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return new Response("Server is not configured yet.", { status: 500, headers: cors });

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      // Cache the long static system prompt so turns after the first skip
      // reprocessing it (faster time to first token).
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      thinking: { type: "disabled" },
      messages: trimmed,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("Ember could not start. Please try again.", { status: 502, headers: cors });
  }

  // Re-emit only the text deltas as a plain-text stream (matches the original contract).
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
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
            } catch { /* ignore keep-alive / non-JSON lines */ }
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
    headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
});
