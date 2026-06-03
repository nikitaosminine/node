-- Add index on portfolio_snapshots.date (index_advisor suggestion, SELECT ORDER BY date ASC)
CREATE INDEX IF NOT EXISTS portfolio_snapshots_date_idx
  ON public.portfolio_snapshots (date);

-- Recreate polymarket_markets_volume_24hr_idx — incorrectly dropped in migration 000004.
-- PostgREST executes a DB-level ORDER BY volume_24hr DESC query confirmed in slow query report.
CREATE INDEX IF NOT EXISTS polymarket_markets_volume_24hr_idx
  ON public.polymarket_markets (volume_24hr DESC NULLS LAST);
