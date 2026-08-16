// Emailed one-time code for password reset, via Rekindle's own Resend sender.
//
// WHY A CODE AND NOT A LINK. The Supabase version sent a magic link, and that link had to be on a
// project-wide redirect allowlist we did not control. It silently rewrote our destination to
// another product's site, so a reset would have dropped Tim on the Eternal Echoes app. A code
// carries no redirect, so nothing outside Rekindle can break it.
//
// Client flow (see crm/auth.js):
//   1. signIn("password", { email, flow: "reset" })                                -> sends the code
//   2. signIn("password", { email, code, newPassword, flow: "reset-verification" }) -> resets + signs in
import { Email } from "@convex-dev/auth/providers/Email";

export const ResendOTPPasswordReset = Email({
  id: "resend-otp-password-reset",
  maxAge: 60 * 20, // 20 minutes
  async generateVerificationToken() {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => (b % 10).toString()).join("");
  },
  async sendVerificationRequest({ identifier: email, token }) {
    const key = process.env.REKINDLE_RESEND_KEY;
    if (!key) throw new Error("REKINDLE_RESEND_KEY not set");
    const from = process.env.REKINDLE_FROM || "Rekindle <hello@rekindlemarriage.com>";
    const html = `<div style="font-family:Georgia,'Times New Roman',serif;color:#17120E;font-size:16px;line-height:1.6;max-width:480px">
      <p style="font-family:system-ui,-apple-system,sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#C1440E;margin:0 0 10px">Rekindle CRM</p>
      <p style="margin:0 0 8px">Use this code to set a new password:</p>
      <p style="font-size:30px;font-weight:700;letter-spacing:7px;color:#C1440E;margin:16px 0;font-family:'IBM Plex Mono',Menlo,monospace">${token}</p>
      <p style="color:#6A5A4B;font-size:13px;margin:0">This code expires in 20 minutes. If you did not ask to reset your password, you can ignore this email and nothing changes.</p>
    </div>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject: "Your Rekindle CRM reset code", html }),
    });
    if (!res.ok) throw new Error("Could not send reset email: " + (await res.text()).slice(0, 200));
  },
});
