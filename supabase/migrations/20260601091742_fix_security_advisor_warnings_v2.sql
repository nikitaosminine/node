-- Fix handle_updated_at search path (separate older trigger function, no table refs)
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Revoke explicit anon/authenticated grants on SECURITY DEFINER functions
-- REVOKE FROM PUBLIC in v1 only removed the implicit PUBLIC grant, not explicit role grants
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated;
