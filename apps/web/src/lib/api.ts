import { supabase } from "@/integrations/supabase/client";

// Returns the Authorization header for the current Supabase session, or an empty
// object when signed out. The Worker API derives the user identity from this bearer
// token — never trust a user_id passed in the URL or body.
export async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
