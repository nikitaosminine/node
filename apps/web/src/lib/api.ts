import { supabase } from "@/integrations/supabase/client";

// Production origin of the Cloudflare Worker API. Single source of truth — used
// as the resolved fallback below and as the explicit fallback target in
// settings' fetchApiWithFallback. If the Worker moves (e.g. behind a custom
// domain), change it here only.
export const DEPLOYED_API_BASE_URL = "https://binturong-api.nikita-osminine.workers.dev";

// Base origin for every Worker API call. NEXT_PUBLIC_API_URL always wins (set in
// .env.production for prod and .env.local for dev); otherwise prod falls back to
// the deployed Worker and dev to the local wrangler port (127.0.0.1:8787, matching
// .env.example and CLAUDE.md). Import this instead of redeclaring it per file.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "production" ? DEPLOYED_API_BASE_URL : "http://127.0.0.1:8787");

// Returns the Authorization header for the current Supabase session, or an empty
// object when signed out. The Worker API derives the user identity from this bearer
// token — never trust a user_id passed in the URL or body.
export async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
