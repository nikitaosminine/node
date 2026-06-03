-- Drop redundant ALL-policy on portfolios (dashboard-created).
-- The 4 specific SELECT/INSERT/UPDATE/DELETE policies from migration 000002 already cover this.
-- Having both caused multiple_permissive_policies warnings.
DROP POLICY IF EXISTS "Users manage own portfolios" ON public.portfolios;
