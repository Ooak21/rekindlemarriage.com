// Mints a short-lived xAI realtime ephemeral token so the browser can connect
// directly to the Grok voice agent without ever seeing the real API key. Also
// returns Ember's instructions + voice so the prompt stays server-side as the
// single source of truth (the client passes them in session.update).
import { EMBER_SYSTEM_PROMPT } from "../_shared/ember-prompt.ts";

const EMBER_VOICE = "Ara";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  const apiKey = Deno.env.get("REKINDLE_XAI_API_KEY") ?? Deno.env.get("XAI_API_KEY");
  if (!apiKey) return new Response("Voice is not configured yet.", { status: 500, headers: cors });

  try {
    const r = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { seconds: 600 } }),
    });
    if (!r.ok) return new Response("Could not start voice session.", { status: 502, headers: cors });

    const data = await r.json();
    return new Response(
      JSON.stringify({
        token: data.value,
        expires_at: data.expires_at,
        voice: EMBER_VOICE,
        instructions: EMBER_SYSTEM_PROMPT,
      }),
      { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  } catch {
    return new Response("Voice session error.", { status: 502, headers: cors });
  }
});
