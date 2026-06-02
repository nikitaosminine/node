-- Waitlist: capture emails from the public landing page (/).
-- Unlike public.allowed_emails (the signup gate, fully locked down), this table
-- accepts inserts from the anon role so the public form can write to it — but it
-- exposes no SELECT/UPDATE/DELETE policy, so the list is readable only by
-- service_role and the Supabase dashboard. Emails are stored lower-cased/trimmed
-- by the route handler; the UNIQUE constraint dedupes at the DB level.

CREATE TABLE IF NOT EXISTS public.waitlist (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL DEFAULT 'waitlist_landing',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- Anyone (including logged-out visitors) may add themselves to the waitlist.
-- No SELECT policy → rows are never readable through the anon/auth API.
DROP POLICY IF EXISTS "Anyone can join the waitlist" ON public.waitlist;
CREATE POLICY "Anyone can join the waitlist"
  ON public.waitlist
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
