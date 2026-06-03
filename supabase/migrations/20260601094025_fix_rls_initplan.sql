-- Fix auth_rls_initplan: replace auth.uid() with (select auth.uid()) in all RLS policies
-- This prevents per-row re-evaluation of the user ID, converting it to a cached init plan.

-- ===== profiles (dashboard-created policies, col = id) =====
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT
  USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE
  USING ((select auth.uid()) = id);

-- ===== portfolios =====
DROP POLICY IF EXISTS "Users can view their own portfolios" ON public.portfolios;
CREATE POLICY "Users can view their own portfolios" ON public.portfolios FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create their own portfolios" ON public.portfolios;
CREATE POLICY "Users can create their own portfolios" ON public.portfolios FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update their own portfolios" ON public.portfolios;
CREATE POLICY "Users can update their own portfolios" ON public.portfolios FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete their own portfolios" ON public.portfolios;
CREATE POLICY "Users can delete their own portfolios" ON public.portfolios FOR DELETE
  USING ((select auth.uid()) = user_id);

-- ===== watchlist_items =====
DROP POLICY IF EXISTS "Users manage own watchlist" ON public.watchlist_items;
CREATE POLICY "Users manage own watchlist" ON public.watchlist_items FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ===== feed_items (dashboard-created) =====
DROP POLICY IF EXISTS "Users manage own feed items" ON public.feed_items;
CREATE POLICY "Users manage own feed items" ON public.feed_items FOR ALL
  USING ((select auth.uid()) = user_id);

-- ===== theses =====
DROP POLICY IF EXISTS "Users manage own theses" ON public.theses;
CREATE POLICY "Users manage own theses" ON public.theses FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ===== thesis_versions (dashboard-created) =====
DROP POLICY IF EXISTS "Users manage thesis versions via theses" ON public.thesis_versions;
CREATE POLICY "Users manage thesis versions via theses" ON public.thesis_versions FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.theses t
    WHERE t.id = thesis_versions.thesis_id AND t.user_id = (select auth.uid())
  ));

-- ===== thesis_stock_links (dashboard-created) =====
DROP POLICY IF EXISTS "Users manage thesis stock links via theses" ON public.thesis_stock_links;
CREATE POLICY "Users manage thesis stock links via theses" ON public.thesis_stock_links FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.theses t
    WHERE t.id = thesis_stock_links.thesis_id AND t.user_id = (select auth.uid())
  ));

-- ===== agent_outputs (dashboard-created) =====
DROP POLICY IF EXISTS "Users manage agent outputs via thesis or holding" ON public.agent_outputs;
CREATE POLICY "Users manage agent outputs via thesis or holding" ON public.agent_outputs FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.theses t WHERE t.id = agent_outputs.thesis_id AND t.user_id = (select auth.uid()))
    OR
    EXISTS (SELECT 1 FROM public.holdings h JOIN public.portfolios p ON h.portfolio_id = p.id
            WHERE h.id = agent_outputs.holding_id AND p.user_id = (select auth.uid()))
  );

-- ===== holdings =====
DROP POLICY IF EXISTS "Users manage holdings via portfolio" ON public.holdings;
DROP POLICY IF EXISTS "Users can view holdings of their portfolios" ON public.holdings;
DROP POLICY IF EXISTS "Users can insert holdings into their portfolios" ON public.holdings;
DROP POLICY IF EXISTS "Users can update holdings in their portfolios" ON public.holdings;
DROP POLICY IF EXISTS "Users can delete holdings from their portfolios" ON public.holdings;
CREATE POLICY "Users can view holdings of their portfolios" ON public.holdings FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));
CREATE POLICY "Users can insert holdings into their portfolios" ON public.holdings FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));
CREATE POLICY "Users can update holdings in their portfolios" ON public.holdings FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));
CREATE POLICY "Users can delete holdings from their portfolios" ON public.holdings FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));

-- ===== agent_runs =====
DROP POLICY IF EXISTS "Users can view own agent runs" ON public.agent_runs;
CREATE POLICY "Users can view own agent runs" ON public.agent_runs FOR SELECT
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own agent runs" ON public.agent_runs;
CREATE POLICY "Users can create own agent runs" ON public.agent_runs FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own agent runs" ON public.agent_runs;
CREATE POLICY "Users can update own agent runs" ON public.agent_runs FOR UPDATE
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own agent runs" ON public.agent_runs;
CREATE POLICY "Users can delete own agent runs" ON public.agent_runs FOR DELETE
  USING ((select auth.uid()) = user_id);

-- ===== agent_user_settings =====
DROP POLICY IF EXISTS "Users can view own agent settings" ON public.agent_user_settings;
CREATE POLICY "Users can view own agent settings" ON public.agent_user_settings FOR SELECT
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own agent settings" ON public.agent_user_settings;
CREATE POLICY "Users can create own agent settings" ON public.agent_user_settings FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own agent settings" ON public.agent_user_settings;
CREATE POLICY "Users can update own agent settings" ON public.agent_user_settings FOR UPDATE
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own agent settings" ON public.agent_user_settings;
CREATE POLICY "Users can delete own agent settings" ON public.agent_user_settings FOR DELETE
  USING ((select auth.uid()) = user_id);

-- ===== agent_portfolio_settings =====
DROP POLICY IF EXISTS "Users can view own agent portfolio settings" ON public.agent_portfolio_settings;
CREATE POLICY "Users can view own agent portfolio settings" ON public.agent_portfolio_settings FOR SELECT
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own agent portfolio settings" ON public.agent_portfolio_settings;
CREATE POLICY "Users can create own agent portfolio settings" ON public.agent_portfolio_settings FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own agent portfolio settings" ON public.agent_portfolio_settings;
CREATE POLICY "Users can update own agent portfolio settings" ON public.agent_portfolio_settings FOR UPDATE
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own agent portfolio settings" ON public.agent_portfolio_settings;
CREATE POLICY "Users can delete own agent portfolio settings" ON public.agent_portfolio_settings FOR DELETE
  USING ((select auth.uid()) = user_id);

-- ===== transactions =====
DROP POLICY IF EXISTS "Users can view transactions of their portfolios" ON public.transactions;
CREATE POLICY "Users can view transactions of their portfolios" ON public.transactions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));
DROP POLICY IF EXISTS "Users can insert transactions into their portfolios" ON public.transactions;
CREATE POLICY "Users can insert transactions into their portfolios" ON public.transactions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));
DROP POLICY IF EXISTS "Users can delete transactions from their portfolios" ON public.transactions;
CREATE POLICY "Users can delete transactions from their portfolios" ON public.transactions FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));

-- ===== portfolio_snapshots =====
DROP POLICY IF EXISTS "Users can view snapshots of their portfolios" ON public.portfolio_snapshots;
CREATE POLICY "Users can view snapshots of their portfolios" ON public.portfolio_snapshots FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));

-- ===== holding_geography_allocations =====
DROP POLICY IF EXISTS "Users can view geography allocations of their portfolios" ON public.holding_geography_allocations;
CREATE POLICY "Users can view geography allocations of their portfolios" ON public.holding_geography_allocations FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));

-- ===== geography_research_jobs =====
DROP POLICY IF EXISTS "Users can view geography research jobs of their portfolios" ON public.geography_research_jobs;
CREATE POLICY "Users can view geography research jobs of their portfolios" ON public.geography_research_jobs FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));

-- ===== saved_benchmarks =====
DROP POLICY IF EXISTS "Users can view saved benchmarks of their portfolios" ON public.saved_benchmarks;
CREATE POLICY "Users can view saved benchmarks of their portfolios" ON public.saved_benchmarks FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));
DROP POLICY IF EXISTS "Users can insert saved benchmarks into their portfolios" ON public.saved_benchmarks;
CREATE POLICY "Users can insert saved benchmarks into their portfolios" ON public.saved_benchmarks FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));
DROP POLICY IF EXISTS "Users can delete saved benchmarks from their portfolios" ON public.saved_benchmarks;
CREATE POLICY "Users can delete saved benchmarks from their portfolios" ON public.saved_benchmarks FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));

-- ===== portfolio_news_matches =====
DROP POLICY IF EXISTS "Users can view news matches of their portfolios" ON public.portfolio_news_matches;
CREATE POLICY "Users can view news matches of their portfolios" ON public.portfolio_news_matches FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));

-- ===== portfolio_polymarket_matches =====
DROP POLICY IF EXISTS "Users can view polymarket matches of their portfolios" ON public.portfolio_polymarket_matches;
CREATE POLICY "Users can view polymarket matches of their portfolios" ON public.portfolio_polymarket_matches FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));

-- ===== recaps =====
DROP POLICY IF EXISTS "Users can view recaps of their portfolios" ON public.recaps;
CREATE POLICY "Users can view recaps of their portfolios" ON public.recaps FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.portfolios WHERE id = portfolio_id AND user_id = (select auth.uid())));

-- ===== portfolio_feed_cache (dashboard-created) =====
DROP POLICY IF EXISTS "Owner can read own feed cache" ON public.portfolio_feed_cache;
CREATE POLICY "Owner can read own feed cache" ON public.portfolio_feed_cache FOR SELECT
  USING (portfolio_id IN (SELECT id FROM public.portfolios WHERE user_id = (select auth.uid())));

-- ===== portfolio_holdings_cache (dashboard-created) =====
DROP POLICY IF EXISTS "owner_select" ON public.portfolio_holdings_cache;
CREATE POLICY "owner_select" ON public.portfolio_holdings_cache FOR SELECT
  USING (portfolio_id IN (SELECT id FROM public.portfolios WHERE user_id = (select auth.uid())));
DROP POLICY IF EXISTS "owner_insert" ON public.portfolio_holdings_cache;
CREATE POLICY "owner_insert" ON public.portfolio_holdings_cache FOR INSERT
  WITH CHECK (portfolio_id IN (SELECT id FROM public.portfolios WHERE user_id = (select auth.uid())));
DROP POLICY IF EXISTS "owner_update" ON public.portfolio_holdings_cache;
CREATE POLICY "owner_update" ON public.portfolio_holdings_cache FOR UPDATE
  USING (portfolio_id IN (SELECT id FROM public.portfolios WHERE user_id = (select auth.uid())));
