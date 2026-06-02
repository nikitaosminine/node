-- The enforce_email_allowlist() trigger function is SECURITY DEFINER (runs with
-- owner privileges so it can read public.allowed_emails during signup). Because it
-- lives in the public schema, Postgres grants EXECUTE to PUBLIC by default, which
-- exposes it as a callable PostgREST RPC to the anon and authenticated roles.
--
-- It only ever needs to run as a BEFORE INSERT trigger on auth.users (which does
-- NOT require the session role to hold EXECUTE). Revoke EXECUTE from the API roles
-- so it can no longer be invoked directly via /rest/v1/rpc/. The signup trigger is
-- unaffected.

REVOKE EXECUTE ON FUNCTION public.enforce_email_allowlist() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_email_allowlist() FROM anon;
REVOKE EXECUTE ON FUNCTION public.enforce_email_allowlist() FROM authenticated;
