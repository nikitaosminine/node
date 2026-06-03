-- Add missing FK indexes (speeds up RLS EXISTS subqueries and JOINs)
CREATE INDEX IF NOT EXISTS agent_outputs_thesis_id_idx ON public.agent_outputs (thesis_id);
CREATE INDEX IF NOT EXISTS agent_outputs_holding_id_idx ON public.agent_outputs (holding_id);
CREATE INDEX IF NOT EXISTS feed_items_agent_output_id_idx ON public.feed_items (agent_output_id);
CREATE INDEX IF NOT EXISTS feed_items_user_id_idx ON public.feed_items (user_id);
CREATE INDEX IF NOT EXISTS holdings_portfolio_id_idx ON public.holdings (portfolio_id);
CREATE INDEX IF NOT EXISTS portfolios_user_id_idx ON public.portfolios (user_id);
CREATE INDEX IF NOT EXISTS theses_user_id_idx ON public.theses (user_id);
CREATE INDEX IF NOT EXISTS thesis_stock_links_holding_id_idx ON public.thesis_stock_links (holding_id);
CREATE INDEX IF NOT EXISTS thesis_versions_thesis_id_idx ON public.thesis_versions (thesis_id);
CREATE INDEX IF NOT EXISTS watchlist_items_user_id_idx ON public.watchlist_items (user_id);

-- Drop unused indexes (verified: no DB queries filter/sort these columns)
-- geography_research_jobs queries filter by holding_id, not status
-- polymarket_markets volume_24hr sorting happens in application code, not DB queries
DROP INDEX IF EXISTS public.geography_research_jobs_status_idx;
DROP INDEX IF EXISTS public.polymarket_markets_volume_24hr_idx;
