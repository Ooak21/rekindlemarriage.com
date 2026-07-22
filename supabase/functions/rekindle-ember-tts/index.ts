// Turns Ember's reply text into warm speech via xAI Grok text-to-speech.
// Used by the "read aloud" toggle in text mode. Returns audio/mpeg.
const EMBER_VOICE = "Ara";

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

  const text = body && typeof body.text === "string" ? body.text.trim().slice(0, 15000) : "";
  if (!text) return new Response("Missing text", { status: 400, headers: cors });

  // Optional per-request voice override (for A/B sampling). Defaults to EMBER_VOICE.
  const voice = body && typeof body.voice === "string" && body.voice.trim() ? body.voice.trim() : EMBER_VOICE;

  const apiKey = Deno.env.get("REKINDLE_XAI_API_KEY") ?? Deno.env.get("XAI_API_KEY");
  if (!apiKey) return new Response("Voice is not configured yet.", { status: 500, headers: cors });

  try {
    const r = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: voice,
        language: "en",
        output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
        speed: 1.0,
        optimize_streaming_latency: 2,
      }),
    });
    if (!r.ok) return new Response("Voice generation failed.", { status: 502, headers: cors });

    const audio = await r.arrayBuffer();
    return new Response(audio, {
      headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("Voice error.", { status: 502, headers: cors });
  }
});
