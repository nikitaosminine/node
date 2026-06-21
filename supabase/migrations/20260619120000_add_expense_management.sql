-- Expense management foundation (Linear 1A-107).
-- Net-new personal-finance surface. Node has no expense data today (only portfolio
-- holdings/transactions). Source-agnostic by design: manual + CSV now, Plaid later, so the
-- schema never churns when a new source is added.
--
-- Money model (shared across the expense views):
--   * discretionary = is_recurring false  → heatmap + category mix operate on these
--   * fixed         = is_recurring true   → shown only as the "committed" figure / allocation strip
--   * disposable    = income − fixed      → denominator for income-relative comparisons

-- ---------------------------------------------------------------------------
-- 1. Categories (Plaid PFCv2 taxonomy). System rows have user_id = null and are
--    readable by every authenticated user; users may add their own categories.
-- ---------------------------------------------------------------------------
create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  pfc_primary text not null,
  pfc_detailed text,
  display_name text not null,
  parent_id uuid references public.expense_categories(id) on delete set null,
  is_fixed_default boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.expense_categories enable row level security;

drop policy if exists "Read system and own expense categories" on public.expense_categories;
create policy "Read system and own expense categories"
  on public.expense_categories for select
  using (user_id is null or user_id = (select auth.uid()));

drop policy if exists "Users can insert own expense categories" on public.expense_categories;
create policy "Users can insert own expense categories"
  on public.expense_categories for insert
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can update own expense categories" on public.expense_categories;
create policy "Users can update own expense categories"
  on public.expense_categories for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete own expense categories" on public.expense_categories;
create policy "Users can delete own expense categories"
  on public.expense_categories for delete
  using (user_id = (select auth.uid()));

create index if not exists expense_categories_user_idx
  on public.expense_categories (user_id);
create index if not exists expense_categories_parent_idx
  on public.expense_categories (parent_id);

-- ---------------------------------------------------------------------------
-- 2. Transactions (the record). source-agnostic; external_id enables idempotent
--    CSV re-import / Plaid dedup later.
-- ---------------------------------------------------------------------------
create table if not exists public.expense_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  posted_at date not null,
  merchant_name text not null,
  amount numeric(18, 2) not null,
  currency text not null default 'EUR',
  category_id uuid references public.expense_categories(id) on delete set null,
  is_recurring boolean not null default false,
  source text not null default 'manual' check (source in ('manual', 'csv', 'plaid')),
  external_id text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.expense_transactions enable row level security;

drop policy if exists "Users can view own expense transactions" on public.expense_transactions;
create policy "Users can view own expense transactions"
  on public.expense_transactions for select
  using (user_id = (select auth.uid()));

drop policy if exists "Users can insert own expense transactions" on public.expense_transactions;
create policy "Users can insert own expense transactions"
  on public.expense_transactions for insert
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can update own expense transactions" on public.expense_transactions;
create policy "Users can update own expense transactions"
  on public.expense_transactions for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete own expense transactions" on public.expense_transactions;
create policy "Users can delete own expense transactions"
  on public.expense_transactions for delete
  using (user_id = (select auth.uid()));

create index if not exists expense_transactions_user_posted_idx
  on public.expense_transactions (user_id, posted_at);
create index if not exists expense_transactions_user_category_idx
  on public.expense_transactions (user_id, category_id);

-- Dedup for imported rows: a (user, source, external_id) tuple is unique when an
-- external id is present. Manual rows (external_id null) are never constrained.
create unique index if not exists expense_transactions_source_external_idx
  on public.expense_transactions (user_id, source, external_id)
  where external_id is not null;

drop trigger if exists update_expense_transactions_updated_at on public.expense_transactions;
create trigger update_expense_transactions_updated_at
  before update on public.expense_transactions
  for each row execute function public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 3. Income (manual monthly income → disposable-income denominator + allocation strip).
-- ---------------------------------------------------------------------------
create table if not exists public.expense_income (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  month date not null,
  amount numeric(18, 2) not null,
  currency text not null default 'EUR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month)
);

alter table public.expense_income enable row level security;

drop policy if exists "Users can manage own expense income" on public.expense_income;
create policy "Users can manage own expense income"
  on public.expense_income for all
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop trigger if exists update_expense_income_updated_at on public.expense_income;
create trigger update_expense_income_updated_at
  before update on public.expense_income
  for each row execute function public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 4. Budgets (opt-in per-category caps; 1A-111). Empty by default: with no rows the
--    calm disposable-income default holds and no cap UI appears.
-- ---------------------------------------------------------------------------
create table if not exists public.expense_budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  category_id uuid references public.expense_categories(id) on delete cascade,
  period text not null default 'monthly' check (period in ('monthly')),
  amount numeric(18, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category_id, period)
);

alter table public.expense_budgets enable row level security;

drop policy if exists "Users can manage own expense budgets" on public.expense_budgets;
create policy "Users can manage own expense budgets"
  on public.expense_budgets for all
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create index if not exists expense_budgets_user_idx
  on public.expense_budgets (user_id);

drop trigger if exists update_expense_budgets_updated_at on public.expense_budgets;
create trigger update_expense_budgets_updated_at
  before update on public.expense_budgets
  for each row execute function public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 5. Seed Plaid PFCv2 primary categories (system rows). Idempotent: only seeds
--    when no system categories exist yet. Detailed subcategories are deferred.
-- ---------------------------------------------------------------------------
insert into public.expense_categories (pfc_primary, display_name, is_fixed_default)
select v.pfc_primary, v.display_name, v.is_fixed_default
from (
  values
    ('INCOME',                    'Income',                  false),
    ('TRANSFER_IN',               'Transfer in',             false),
    ('TRANSFER_OUT',              'Transfer out',            false),
    ('LOAN_PAYMENTS',             'Loan payments',           true),
    ('BANK_FEES',                 'Bank fees',               false),
    ('ENTERTAINMENT',             'Entertainment',           false),
    ('FOOD_AND_DRINK',           'Food & drink',            false),
    ('GENERAL_MERCHANDISE',       'Shopping',                false),
    ('HOME_IMPROVEMENT',          'Home improvement',        false),
    ('MEDICAL',                   'Medical',                 false),
    ('PERSONAL_CARE',             'Personal care',           false),
    ('GENERAL_SERVICES',          'Services',                false),
    ('GOVERNMENT_AND_NON_PROFIT', 'Government & non-profit', false),
    ('TRANSPORTATION',            'Transport',               false),
    ('TRAVEL',                    'Travel',                  false),
    ('RENT_AND_UTILITIES',        'Rent & utilities',        true)
) as v(pfc_primary, display_name, is_fixed_default)
where not exists (
  select 1 from public.expense_categories where user_id is null
);
