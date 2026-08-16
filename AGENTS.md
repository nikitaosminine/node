# AGENTS.md

This file provides guidance to coding agents (Claude Code and others) when working with code in
this repository. It is the single source of truth; `CLAUDE.md` points here.

## Architecture

Three independent deployables in a monorepo (no workspace manager — each app has its own `node_modules`):

| Piece | Folder | Runs on | Deployed by |
|-------|--------|---------|-------------|
| Frontend | `apps/web` | Vercel | Auto on merge to `main` |
| API | `apps/api` | Cloudflare Worker | Manual: `npm run deploy` |
| Database | `supabase/migrations/` | Supabase | Manual: apply migrations |

Production URL: **https://trynode.app** (`main` branch = live)

## Commands

Run each app from its own directory — not from the repo root.

```powershell
# Frontend (Next.js 16, React 19)
cd apps/web
npm run dev      # → localhost:3000
npm run build
npm run lint
npm test         # Vitest, single run (also runs in CI on every PR)
npm run test:watch

# API (Cloudflare Worker)
cd apps/api
npm run dev      # → localhost:8787
npm run deploy   # manual deploy to Cloudflare
npx wrangler secret put NAME   # add/update a secret
npm run cf-typegen             # regenerate Cloudflare bindings types
```

No monorepo-level build or test command exists; lint/build/test per-app.

CI (`.github/workflows/ci.yml`) runs on every PR to `main`: `check-web` does lint + `tsc --noEmit`
+ `npm test` in `apps/web`; `check-api` does `npm run typecheck` + `npm test` (vitest) in `apps/api`.

## Deployment rules

- **Frontend only changed** → Vercel deploys automatically after merge, nothing else needed.
- **`apps/api/` changed** → must run `cd apps/api && npm run deploy` after merging.
- **New migration added** → apply to Supabase **before** deploying API code that depends on it.

## API architecture (`apps/api/src/index.ts`)

Single Cloudflare Worker file (~6000 lines) handling all routing, business logic, and queue consumers.

**Auth model:**
- Worker connects to Supabase with `service_role` key (bypasses RLS).
- Every user-facing route must call `getAuthenticatedUserId()` to extract the user from the bearer token, then `requirePortfolioAccess()` or `requireAdmin()` to gate access.
- Never trust client-supplied user IDs.

**Queue consumers (async tasks):**
- `agent-runs` — thesis AI analysis
- `snapshot-rebuild-queue` — portfolio performance snapshots
- `geography-queue` — ETF geographic allocation enrichment via LLM
- `recap-queue` — weekly/daily brief generation

**Scheduled crons:** 5 triggers daily for market-hours fanout, news, polymarket, and recaps.

**Never call `getPortfolioGeography()` inside a POST endpoint response** — it triggers Yahoo Finance requests that cause rate limiting. Geography is always enqueued as a background job.

## Frontend architecture (`apps/web`)

Next.js 16 App Router. All authenticated pages live under `app/(app)/` layout which handles session loading.

Key route segments:
- `/portfolios` — portfolio list + create
- `/portfolios/[id]` — portfolio detail with holdings, benchmarks, geography
- `/the-take` — thesis editor (Tiptap) + AI agent runs
- `/overview` — cross-portfolio summary
- `/settings` — profile, allowed emails management

**Data fetching pattern:** server components fetch initial data; client components (`"use client"`) handle interactivity and real-time price updates.

**Responsive shell** (`src/components/app-sidebar.tsx` — hand-rolled; `ui/sidebar.tsx` is unused):
the desktop `<aside>` is `hidden md:flex` and a `md:hidden` top bar opens the same nav in a
`Sheet`. Drive that switch with CSS, never `useIsMobile` — it returns `false` on first render, so a
JS branch causes a hydration flash. Collapse state persists under `binturong.sidebar-collapsed`
(the `binturong.` key prefix is the convention).

Page-wrapper padding and the `@container` containment rule live in `apps/web/DESIGN_SYSTEM.md`
→ "Layout".

## Database

Supabase PostgreSQL. RLS is enabled on all tables — queries from the frontend use the anon key and are row-restricted by policy. The Worker uses the service key to perform cross-user operations (snapshots, fanout).

Key tables: `profiles`, `portfolios`, `holdings`, `theses`, `agent_runs`, `transactions`, `holdings_geography`, `news_feed`, `polymarket_feed`, `recaps`, `allowed_emails`.

Migration files: `supabase/migrations/` — timestamped SQL, applied in order.

## Tech stack

**Frontend:** Next.js 16, React 19, Tailwind CSS 4, Radix UI, Recharts, Framer Motion, Tiptap, Supabase SSR client, Mixpanel, Zod + React Hook Form.

**Backend:** Cloudflare Workers, Supabase (PostgreSQL + Auth), Cloudflare Queues.

**AI models (xAI Grok):** `grok-4.20-0309-reasoning` for thesis agent and benchmarks; `grok-4-1-fast-non-reasoning` for sub-agent and broker-CSV normalization; `grok-4.3` for expense-CSV normalization (`GROK_NORMALIZATION_MODEL`; `reasoning_effort` via `GROK_NORMALIZATION_EFFORT`, default `none` — reasoning over a whole CSV in one call exceeds the 90s timeout); `grok-4.6` with medium reasoning for Polymarket curation (`POLYMARKET_GROK_MODEL`, `POLYMARKET_GROK_REASONING_EFFORT`); Gemini for recaps.

**Market data:** Yahoo Finance (quotes/search), FRED (economic indicators), Exa Search (web), Polymarket Gamma (prediction markets).

## Environment variables

Frontend `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787   # local dev
NEXT_PUBLIC_MIXPANEL_TOKEN=                  # optional
```

API secrets (set via `npx wrangler secret put`):
`SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `GROK_MAIN_API_KEY`, `GROK_SUB_API_KEY`, `GROK_NORMALIZATION_API_KEY`, `FRED_API_KEY`, `EXA_SEARCH`, `GEMINI_API_KEY`, `ADMIN_SECRET`

## Beta access

To add a new tester, insert into `allowed_emails` via the Supabase SQL editor:
```sql
INSERT INTO public.allowed_emails (email, note)
VALUES ('email@example.com', 'beta tester')
ON CONFLICT DO NOTHING;
```

## Docs & Standards
- Design system: `apps/web/DESIGN_SYSTEM.md` — consult for all UI work that touches colors, typography and other UI rules
- Product vision: `docs/PRODUCT_VISION.md` — consult when making important product decisions


## gstack (recommended)

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted workflows. Install it for the best experience:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`, `/retro`, `/investigate`, `/document-release`, `/document-generate`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
