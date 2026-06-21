-- Enforce the invariant the app already relies on: expense_income.month is always the
-- first day of the month. The app writes `${YYYY-MM}-01` everywhere, and the allocation
-- strip looks income up with `.eq("month", first_of_month)`. Without this guard a stray
-- mid-month value (e.g. a direct write) would (a) slip past the (user_id, month) unique
-- constraint as a second "June" row and (b) be invisible to the strip's lookup.
alter table public.expense_income
  add constraint expense_income_month_is_first_of_month
  check (extract(day from month) = 1);
