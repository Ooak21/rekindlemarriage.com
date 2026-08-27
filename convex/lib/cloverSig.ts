// Clover webhook HMAC verification using Web Crypto (Convex isolate — not node crypto).
/** Validate Clover-Signature header (t=timestamp,v1=hmac). True if valid; true if secret unset. */
export async function verifyCloverWebhookSignature(
  raw: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = process.env.CLOVER_WEBHOOK_SIGNING_SECRET || "";
  if (!secret || !signatureHeader) return !secret;
  const parts: Record<string, string> = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, v] = p.trim().split("=");
      return [k, v];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
