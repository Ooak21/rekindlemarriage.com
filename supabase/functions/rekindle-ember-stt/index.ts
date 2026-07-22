// Transcribes recorded mic audio via xAI Grok speech-to-text (the record ->
// transcribe fallback path). Uses the dedicated XAI_STT_API_KEY when present.
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

  const audioB64 = body && typeof body.audio === "string" ? body.audio : "";
  const mimeType = (body && typeof body.mimeType === "string" && body.mimeType) || "audio/webm";
  if (!audioB64) return new Response("Missing audio", { status: 400, headers: cors });

  const apiKey = Deno.env.get("REKINDLE_XAI_API_KEY") ?? Deno.env.get("XAI_STT_API_KEY") ?? Deno.env.get("XAI_API_KEY");
  if (!apiKey) return new Response("Voice is not configured yet.", { status: 500, headers: cors });

  // Name the file by container so xAI auto-detects it (webm on Chrome, mp4 on Safari).
  const ext = mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a"
    : mimeType.includes("ogg") ? "ogg"
    : mimeType.includes("wav") ? "wav"
    : "webm";

  try {
    const bytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("language", "en"); // all params must come before `file`
    form.append("file", new Blob([bytes], { type: mimeType }), "audio." + ext);

    const r = await fetch("https://api.x.ai/v1/stt", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!r.ok) return new Response("Transcription failed.", { status: 502, headers: cors });

    const data = await r.json();
    return new Response(JSON.stringify({ text: (data && data.text) || "" }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch {
    return new Response("Transcription error.", { status: 502, headers: cors });
  }
});
