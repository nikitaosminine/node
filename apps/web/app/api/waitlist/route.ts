import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://sfqowvpuzsqgmwlecgdx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_xcYBQwzQm7_Cv8eoqAI8rw_eFVLZiGp";

// `Node <hello@updates.trynode.app>` — sender on the verified Resend subdomain.
const FROM_EMAIL = process.env.WAITLIST_FROM_EMAIL ?? "Node <hello@updates.trynode.app>";

// Honeypot field name — kept in sync with the hidden input in WaitlistForm.
const HONEYPOT_FIELD = "company";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  // Honeypot: real users never fill this; bots that auto-complete every field will.
  [HONEYPOT_FIELD]: z.string().optional(),
});

async function sendConfirmationEmail(email: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Pre-domain-verification / local dev: don't block the signup on email.
    console.warn("[waitlist] RESEND_API_KEY not set — skipping confirmation email");
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: email,
      subject: "You're on the Node waitlist",
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:440px;margin:0 auto;color:#0a0a0a;line-height:1.55">
          <h1 style="font-size:18px;font-weight:600;margin:0 0 12px">You're on the list.</h1>
          <p style="font-size:14px;margin:0 0 12px">
            Thanks for joining the Node waitlist. We're building a clean, high-density
            workspace for tracking what you own and understanding why you own it.
          </p>
          <p style="font-size:14px;margin:0 0 12px">
            We'll email you the moment early access opens — no spam in between.
          </p>
          <p style="font-size:12px;color:#6b7280;margin:20px 0 0">— The Node team</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[waitlist] Resend send failed:", res.status, detail);
  }
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Please enter a valid email." }, { status: 400 });
  }

  // Bot caught by the honeypot: pretend success, write nothing.
  if (parsed.data[HONEYPOT_FIELD]) {
    return Response.json({ ok: true });
  }

  const { email } = parsed.data;
  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });

  const { error } = await supabase.from("waitlist").insert({ email });

  if (error) {
    // 23505 = unique_violation → already on the list. Treat as success and never
    // leak whether the email pre-existed.
    if (error.code !== "23505") {
      console.error("[waitlist] insert failed:", error);
      return Response.json(
        { ok: false, error: "Something went wrong. Please try again." },
        { status: 500 },
      );
    }
  }

  // Only send a fresh confirmation to brand-new signups (skip duplicates).
  if (!error) {
    try {
      await sendConfirmationEmail(email);
    } catch (err) {
      // Never fail the signup because the email provider hiccuped.
      console.error("[waitlist] confirmation email error:", err);
    }
  }

  return Response.json({ ok: true });
}
