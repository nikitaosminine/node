-- Allow authenticated users to perform writes the Worker API exposes via userDb (RLS).
-- Without these, those routes would silently fail or require the service role key.

-- transactions: PATCH /api/portfolios/:id/transactions/:txnId
drop policy if exists "Users can update transactions in their portfolios" on public.transactions;
create policy "Users can update transactions in their portfolios"
  on public.transactions for update
  using (
    exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = (select auth.uid())
    )
  );

-- saved_benchmarks: PATCH color swap
drop policy if exists "Users can update saved benchmarks in their portfolios" on public.saved_benchmarks;
create policy "Users can update saved benchmarks in their portfolios"
  on public.saved_benchmarks for update
  using (
    exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = (select auth.uid())
    )
  );

-- recaps: POST /api/recaps/:id/seen (seen_at)
drop policy if exists "Users can update recaps of their portfolios" on public.recaps;
create policy "Users can update recaps of their portfolios"
  on public.recaps for update
  using (
    exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = (select auth.uid())
    )
  );

-- recap_slide_feedback: POST /api/recaps/:id/feedback (user-scoped upsert)
drop policy if exists "Service role can manage slide feedback" on public.recap_slide_feedback;
drop policy if exists "Users can manage their own slide feedback" on public.recap_slide_feedback;
create policy "Users can manage their own slide feedback"
  on public.recap_slide_feedback for all
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = (select auth.uid())
    )
  );
