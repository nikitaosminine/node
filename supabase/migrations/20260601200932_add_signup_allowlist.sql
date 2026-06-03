-- Signup allowlist: restrict new account creation to a curated set of invited testers.
-- A BEFORE INSERT trigger on auth.users rejects any email not present in
-- public.allowed_emails. Existing users are unaffected (the trigger only fires on
-- new signups). Pair this with the Cloudflare Access perimeter for defense in depth.

CREATE TABLE IF NOT EXISTS public.allowed_emails (
  email TEXT PRIMARY KEY,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Lock the table down: RLS on, no policies → unreachable via the anon/auth API.
-- Only service_role and SECURITY DEFINER functions (the gate below) can read it.
ALTER TABLE public.allowed_emails ENABLE ROW LEVEL SECURITY;

-- Reject signups whose (lower-cased) email is not on the allowlist.
CREATE OR REPLACE FUNCTION public.enforce_email_allowlist()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.allowed_emails
    WHERE email = lower(NEW.email)
  ) THEN
    RAISE EXCEPTION 'Signups are restricted. % is not on the invite list.', NEW.email
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_email_allowlist ON auth.users;
CREATE TRIGGER enforce_email_allowlist
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_email_allowlist();

-- Seed the owner + any already-registered users so nobody is locked out, and add
-- invited testers here (or `INSERT ... ON CONFLICT DO NOTHING` in a later migration).
INSERT INTO public.allowed_emails (email, note)
VALUES ('nikita.osminine@gmail.com', 'owner')
ON CONFLICT (email) DO NOTHING;

INSERT INTO public.allowed_emails (email, note)
SELECT lower(email), 'pre-existing user (auto-seeded)'
FROM auth.users
WHERE email IS NOT NULL
ON CONFLICT (email) DO NOTHING;
