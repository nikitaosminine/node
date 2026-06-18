-- Tighten the recap_slide_feedback policy: mirror the portfolio-ownership check
-- from `with check` into `using` so SELECT/UPDATE/DELETE are gated consistently,
-- not just by user_id. Defense-in-depth follow-up to 20260618120000.

drop policy if exists "Users can manage their own slide feedback" on public.recap_slide_feedback;
create policy "Users can manage their own slide feedback"
  on public.recap_slide_feedback for all
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = (select auth.uid())
    )
  );
