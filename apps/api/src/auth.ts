import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export interface AuthEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  SUPABASE_ANON_KEY: string;
}

export type AuthContext = {
  userId: string;
  token: string;
  db: SupabaseClient;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization") ?? "";
  return auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

/** Service role — bypasses RLS. Use only in crons, queues, and admin routes. */
export function adminDb(env: AuthEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
}

/** User-scoped client — RLS enforced via the caller's JWT. */
export function userDb(env: AuthEnv, accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export async function requireAuth(
  request: Request,
  env: AuthEnv,
): Promise<AuthContext | Response> {
  const token = extractBearerToken(request);
  if (!token || !env.SUPABASE_ANON_KEY) return json({ error: "Unauthorized" }, 401);

  const db = userDb(env, token);
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return json({ error: "Unauthorized" }, 401);

  return { userId: data.user.id, token, db };
}

/** RLS-backed ownership check — returns 404 when the portfolio is not visible to the user. */
export async function assertPortfolioAccess(
  client: SupabaseClient,
  portfolioId: string,
): Promise<Response | null> {
  const { data, error } = await client
    .from("portfolios")
    .select("id")
    .eq("id", portfolioId)
    .single();
  if (error || !data) return json({ error: "Portfolio not found" }, 404);
  return null;
}

export async function requirePortfolioAccess(
  request: Request,
  env: AuthEnv,
  portfolioId: string,
): Promise<AuthContext | Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const accessError = await assertPortfolioAccess(auth.db, portfolioId);
  if (accessError) return accessError;

  return auth;
}
