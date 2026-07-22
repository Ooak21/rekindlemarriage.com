import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function escapeHtml(value: unknown): string {
  const s = value == null ? "" : String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayOrEmpty(value: unknown): string {
  const s = value == null ? "" : String(value).trim();
  return s ? escapeHtml(s) : "(not provided)";
}

async function sendResendEmail(payload: {
  from: string;
  to: string[];
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not set");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend error ${res.status}: ${text}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const botField = body.bot_field;
    if (typeof botField === "string" && botField.trim() !== "") {
      return jsonResponse({ ok: true });
    }

    const partnerA_first = String(body.partnerA_first ?? "").trim();
    const partnerA_last = String(body.partnerA_last ?? "").trim();
    const partnerA_email = String(body.partnerA_email ?? "").trim();
    const partnerA_phone = String(body.partnerA_phone ?? "").trim();

    if (!partnerA_first || !partnerA_last || !partnerA_email || !partnerA_phone) {
      return jsonResponse(
        {
          error:
            "Partner A first name, last name, email, and phone are required.",
        },
        400,
      );
    }

    const partnerB_first = String(body.partnerB_first ?? "").trim() || null;
    const partnerB_last = String(body.partnerB_last ?? "").trim() || null;
    const partnerB_email = String(body.partnerB_email ?? "").trim() || null;
    const partnerB_phone = String(body.partnerB_phone ?? "").trim() || null;
    const raising_children =
      String(body.raising_children ?? "").trim() || null;
    const years_together = String(body.years_together ?? "").trim() || null;
    const preferred_cohort =
      String(body.preferred_cohort ?? "").trim() || null;
    const focus = String(body.focus ?? "").trim() || null;
    const how_heard = String(body.how_heard ?? "").trim() || null;
    const consent = Boolean(body.consent);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return jsonResponse({ error: "Server configuration error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data, error } = await supabase
      .from("rekindle_leads")
      .insert({
        partner_a_first: partnerA_first,
        partner_a_last: partnerA_last,
        partner_a_email: partnerA_email,
        partner_a_phone: partnerA_phone,
        partner_b_first: partnerB_first,
        partner_b_last: partnerB_last,
        partner_b_email: partnerB_email,
        partner_b_phone: partnerB_phone,
        raising_children,
        years_together,
        preferred_cohort,
        focus,
        how_heard,
        consent,
        source: "website",
      })
      .select("id")
      .single();

    if (error) {
      console.error("Insert error:", error);
      return jsonResponse({ error: "Failed to save reservation" }, 500);
    }

    const leadId = data?.id as string;

    const from =
      Deno.env.get("REKINDLE_FROM")?.trim() ||
      "Rekindle <hello@luisocadiz.online>";
    const teamEmailsRaw =
      Deno.env.get("REKINDLE_TEAM_EMAILS")?.trim() ||
      "miguel@innovativeblockchainsolutions.live";
    const teamEmails = teamEmailsRaw
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);

    const coupleTo = [partnerA_email];
    if (partnerB_email) {
      coupleTo.push(partnerB_email);
    }

    const coupleNames = partnerB_first
      ? `${escapeHtml(partnerA_first)} and ${escapeHtml(partnerB_first)}`
      : escapeHtml(partnerA_first);

    const confirmationHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background-color:#FBF8F4;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FBF8F4;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #EDE6DC;">
          <tr>
            <td style="background-color:#C1440E;padding:20px 28px;">
              <p style="margin:0;color:#FBF8F4;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;font-family:system-ui,-apple-system,sans-serif;">Rekindle Marriage Bootcamp</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 12px;">
              <h1 style="margin:0 0 16px;font-size:28px;line-height:1.25;color:#1a1410;font-weight:normal;">Your Rekindle spot is reserved</h1>
              <p style="margin:0 0 16px;font-size:17px;line-height:1.6;color:#3a322c;">Dear ${coupleNames},</p>
              <p style="margin:0 0 16px;font-size:17px;line-height:1.6;color:#3a322c;">
                Thank you for taking this step. We have reserved a seat for you at the Rekindle Marriage Bootcamp with Dr. Peter DeBry.
              </p>
              <p style="margin:0 0 16px;font-size:17px;line-height:1.6;color:#3a322c;">
                Your seat is held for <strong>48 hours</strong>. Our team will follow up shortly with your cohort schedule and a secure payment link.
              </p>
              <p style="margin:0 0 16px;font-size:17px;line-height:1.6;color:#3a322c;">
                The investment is <strong>$600 per couple</strong>. If you have any questions in the meantime, simply reply to this email. We are glad you are here.
              </p>
              <p style="margin:24px 0 0;font-size:17px;line-height:1.6;color:#3a322c;">
                With care,<br />
                <span style="color:#C1440E;">The Rekindle Team</span><br />
                <span style="font-size:14px;color:#6b635c;font-family:system-ui,-apple-system,sans-serif;">A division of Vitality Academies</span>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;border-top:1px solid #EDE6DC;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#8a8178;font-family:system-ui,-apple-system,sans-serif;">
                Rekindle Marriage Bootcamp · Dr. Peter DeBry · Vitality Academies
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const partnerBName =
      partnerB_first || partnerB_last
        ? `${escapeHtml(partnerB_first || "")} ${escapeHtml(partnerB_last || "")}`.trim()
        : "(not provided)";

    const teamHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:system-ui,-apple-system,sans-serif;color:#1a1410;line-height:1.5;">
  <h2 style="color:#C1440E;margin:0 0 12px;">New Rekindle reservation</h2>
  <p style="margin:0 0 16px;">Lead ID: <code>${escapeHtml(leadId)}</code></p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
    <tr><td style="font-weight:600;padding-right:12px;">Partner A</td><td>${escapeHtml(partnerA_first)} ${escapeHtml(partnerA_last)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner A email</td><td>${escapeHtml(partnerA_email)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner A phone</td><td>${escapeHtml(partnerA_phone)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner B</td><td>${partnerBName}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner B email</td><td>${displayOrEmpty(partnerB_email)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Partner B phone</td><td>${displayOrEmpty(partnerB_phone)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Raising children</td><td>${displayOrEmpty(raising_children)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Years together</td><td>${displayOrEmpty(years_together)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Preferred cohort</td><td>${displayOrEmpty(preferred_cohort)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Focus</td><td>${displayOrEmpty(focus)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">How heard</td><td>${displayOrEmpty(how_heard)}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Consent</td><td>${consent ? "yes" : "no"}</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Source</td><td>website</td></tr>
    <tr><td style="font-weight:600;padding-right:12px;">Status</td><td>reserved</td></tr>
  </table>
</body>
</html>`;

    const bName = partnerB_first || "Partner";
    const teamSubject = `New Rekindle reservation: ${partnerA_first} and ${bName}`;

    try {
      await sendResendEmail({
        from,
        to: coupleTo,
        subject: "Your Rekindle spot is reserved",
        html: confirmationHtml,
      });
    } catch (emailErr) {
      console.error("Couple confirmation email failed:", emailErr);
    }

    try {
      await sendResendEmail({
        from,
        to: teamEmails,
        subject: teamSubject,
        html: teamHtml,
      });
    } catch (emailErr) {
      console.error("Team notification email failed:", emailErr);
    }

    return jsonResponse({ ok: true, id: leadId });
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ error: "Unexpected server error" }, 500);
  }
});
