# Design System

The single canonical reference for colors, typography, icons, and UI conventions
in the web app.

## Overview

- **This document** is the canonical, human-readable spec.
- **Runtime source of truth** is `src/styles.css` (Tailwind v4 CSS-first: tokens live
  in `@theme inline`, `:root`, and `.dark`) plus the `next/font` loaders in
  `app/layout.tsx`. There is no `tailwind.config.js` and no separate token module.
- **Keep them in sync:** when you change a token in `src/styles.css` or a font weight
  in `app/layout.tsx`, update the matching table here in the same change.
- Stack: Tailwind v4 (`@import "tailwindcss"`), `tw-animate-css`, shadcn/ui
  primitives (New York style), `class-variance-authority` for variants.

## Color tokens

All theme colors are defined as CSS custom properties in `src/styles.css` and exposed
as Tailwind utilities via the `@theme inline` block (e.g. `--color-background` →
`bg-background` / `text-background`). Theme colors use `oklch`; fixed categorical
palettes (allocation, benchmark) use hex. Dark mode is the `.dark` class
(`@custom-variant dark`).

### Color philosophy — the app is monochrome

The UI is intentionally **monochrome**: white, black, and neutral grays
(`background`, `foreground`, `surface*`, `hairline`). The shadcn primitives were
recolored away from their stock palette — e.g. the default `Button` is
`bg-foreground text-background`, **not** `bg-primary`. `--primary` is teal but it
surfaces in exactly one primitive: the selected radio-group dot
(`ui/radio-group.tsx:29`, `fill-primary`).

**Teal (`--accent-teal`) is the single chromatic accent**, and it renders in only
four places: the portfolio chart (series + positive-return bars,
`portfolio-chart.tsx:106,1254`), the selected radio dot (above), the sidebar
keyboard-focus ring (`--sidebar-ring`, focus-only), and a near-transparent radial
glow on the auth screen (`--accent-teal-soft`, `lightswind/fall-beam-background.tsx`).
There is no broad teal branding — do not introduce `bg-primary`/colored surfaces
expecting an established accent system.

### Core / semantic

| Token                      | Utility                         | Light                     | Dark                      |
| -------------------------- | ------------------------------- | ------------------------- | ------------------------- |
| `--background`             | `bg-background`                 | `oklch(1 0 0)`            | `oklch(0.09 0 0)`         |
| `--foreground`             | `text-foreground`               | `oklch(0.16 0.004 260)`   | `oklch(0.96 0 0)`         |
| `--foreground-muted`       | `text-foreground-muted`         | `oklch(0.5 0.01 260)`     | `oklch(0.72 0 0)`         |
| `--primary`                | `fill-primary` (radio dot only) | `var(--accent-teal)`      | `var(--accent-teal)`      |
| `--primary-foreground`     | `*-primary-foreground`          | `oklch(0.99 0 0)`         | `oklch(0.09 0 0)`         |
| `--secondary`              | `bg-secondary`                  | `var(--surface-2)`        | `var(--surface-2)`        |
| `--secondary-foreground`   | —                               | `var(--foreground)`       | `var(--foreground)`       |
| `--muted`                  | `bg-muted`                      | `var(--surface-2)`        | `var(--surface-2)`        |
| `--muted-foreground`       | `text-muted-foreground`         | `var(--foreground-muted)` | `var(--foreground-muted)` |
| `--accent`                 | `bg-accent`                     | `var(--surface-2)`        | `var(--surface-2)`        |
| `--accent-foreground`      | —                               | `var(--foreground)`       | `var(--foreground)`       |
| `--card`                   | `bg-card`                       | `var(--surface)`          | `var(--surface)`          |
| `--popover`                | `bg-popover`                    | `var(--surface-elevated)` | `var(--surface-elevated)` |
| `--destructive`            | `bg-destructive`                | `var(--negative)`         | `var(--negative)`         |
| `--destructive-foreground` | —                               | `oklch(0.98 0 0)`         | `oklch(0.98 0 0)`         |
| `--border`                 | `border-border`                 | `var(--hairline)`         | `var(--hairline)`         |
| `--input`                  | `border-input`                  | `var(--hairline)`         | `var(--hairline)`         |
| `--ring`                   | `ring-ring`                     | `oklch(0.36 0 0 / 40%)`   | `oklch(1 0 0 / 32%)`      |

### Surfaces

| Token                | Utility               | Light                    | Dark                 |
| -------------------- | --------------------- | ------------------------ | -------------------- |
| `--surface`          | `bg-surface`          | `oklch(0.985 0.002 260)` | `oklch(0.13 0 0)`    |
| `--surface-2`        | `bg-surface-2`        | `oklch(0.96 0.003 260)`  | `oklch(0.18 0 0)`    |
| `--surface-elevated` | `bg-surface-elevated` | `oklch(1 0 0)`           | `oklch(0.22 0 0)`    |
| `--hairline`         | `border-hairline`     | `oklch(0.88 0.006 260)`  | `oklch(1 0 0 / 10%)` |

### Signal

`--accent-teal` and `--accent-teal-soft` have **no Tailwind utility** — they are
consumed only as raw `var()`: `var(--accent-teal)` in the portfolio chart
(`portfolio-chart.tsx:106` series color, `:1254` positive-return bar fill) and
`var(--accent-teal-soft)` in the auth radial glow
(`lightswind/fall-beam-background.tsx:61`). They also back `--primary` and
`--sidebar-ring`. See "Color philosophy" above.

| Token                | Utility              | Light                        | Dark                         |
| -------------------- | -------------------- | ---------------------------- | ---------------------------- |
| `--accent-teal`      | — (raw `var()` only) | `oklch(0.66 0.13 180)`       | `oklch(0.78 0.14 180)`       |
| `--accent-teal-soft` | — (raw `var()` only) | `oklch(0.66 0.13 180 / 12%)` | `oklch(0.78 0.14 180 / 18%)` |
| `--positive`         | `text-positive`      | `oklch(0.58 0.14 155)`       | `oklch(0.78 0.15 155)`       |
| `--negative`         | `text-negative`      | `oklch(0.58 0.2 25)`         | `oklch(0.7 0.2 25)`          |
| `--chart-accent`     | —                    | `#0a0a0a`                    | `#ffffff`                    |

### Heatmap ramp (`--heat-empty`, `--heat-1..5`)

The **second sanctioned chromatic exception** (after the allocation strip): the Expenses
spending heatmap. A single-hue intensity ramp, **warm orange in light mode, indigo blue in
dark mode** (the mockup is the source of truth for this element — it is intentionally *not*
teal). Consumed as raw `var(--heat-*)` only (no Tailwind utility); `--heat-empty` is a
no-spend cell, visually distinct from a low-but-nonzero `--heat-1`. Used in
`components/expenses/spending-heatmap.tsx`.

| Token         | Light (orange)            | Dark (indigo)             |
| ------------- | ------------------------- | ------------------------- |
| `--heat-empty`| `oklch(0.965 0.004 70)`   | `oklch(0.17 0.012 275)`   |
| `--heat-1`    | `oklch(0.93 0.05 72)`     | `oklch(0.3 0.07 278)`     |
| `--heat-2`    | `oklch(0.87 0.09 64)`     | `oklch(0.38 0.11 274)`    |
| `--heat-3`    | `oklch(0.8 0.13 56)`      | `oklch(0.47 0.145 270)`   |
| `--heat-4`    | `oklch(0.72 0.16 48)`     | `oklch(0.57 0.17 267)`    |
| `--heat-5`    | `oklch(0.63 0.185 42)`    | `oklch(0.67 0.19 265)`    |
| `--heat-foreground` | `oklch(1 0 0)`      | `oklch(1 0 0)`            |

Cell text is `--foreground` on `--heat-1..3` and `--heat-foreground` (white, both modes)
on the saturated `--heat-4/5` steps. Never hardcode `#fff` — use the token.

### Chart series (`--chart-1..5`)

| Token       | Light                  | Dark                   |
| ----------- | ---------------------- | ---------------------- |
| `--chart-1` | `oklch(0.66 0.13 180)` | `oklch(0.78 0.14 180)` |
| `--chart-2` | `oklch(0.6 0.14 225)`  | `oklch(0.72 0.15 225)` |
| `--chart-3` | `oklch(0.66 0.15 75)`  | `oklch(0.78 0.15 75)`  |
| `--chart-4` | `oklch(0.62 0.16 310)` | `oklch(0.74 0.17 310)` |
| `--chart-5` | `oklch(0.62 0.17 35)`  | `oklch(0.72 0.18 35)`  |

### Benchmark series

Portfolio comparison lines (`portfolio-chart.tsx`). Hex categorical palette,
brightened in dark mode for legibility on dark backgrounds.

| Token                | Utility                 | Light     | Dark      |
| -------------------- | ----------------------- | --------- | --------- |
| `--benchmark-amber`  | `text-benchmark-amber`  | `#f5a524` | `#f7b94e` |
| `--benchmark-violet` | `text-benchmark-violet` | `#b978f2` | `#cb98f6` |
| `--benchmark-rose`   | `text-benchmark-rose`   | `#f75f85` | `#fa83a0` |
| `--benchmark-sky`    | `text-benchmark-sky`    | `#14b8e6` | `#3cc6ef` |

### Allocation palette (`--alloc-1..6`)

Treemaps and chips. Each step has a paired `-text` color for contrast. The ramp
inverts between light and dark.

| Token       | Light bg / text       | Dark bg / text        |
| ----------- | --------------------- | --------------------- |
| `--alloc-1` | `#050505` / `#ffffff` | `#f5f5f5` / `#000000` |
| `--alloc-2` | `#2f2f2f` / `#ffffff` | `#b8b8b8` / `#000000` |
| `--alloc-3` | `#676767` / `#ffffff` | `#7a7a7a` / `#000000` |
| `--alloc-4` | `#a6a6a6` / `#000000` | `#4f4f4f` / `#ffffff` |
| `--alloc-5` | `#d2d2d2` / `#000000` | `#2d2d2d` / `#ffffff` |
| `--alloc-6` | `#f2f2f2` / `#000000` | `#121212` / `#ffffff` |

### Sidebar

`--sidebar`, `--sidebar-foreground`, `--sidebar-accent(-foreground)`,
`--sidebar-border`, `--sidebar-ring` (utilities `bg-sidebar`, etc.). Sidebar
surface: `oklch(0.985 0.002 260)` light / `oklch(0.11 0 0)` dark; accent
`oklch(0.95 0.004 260)` / `oklch(0.18 0 0)`. `--sidebar-ring` tracks
`--accent-teal` (teal, **keyboard-focus only**).

There is no `--sidebar-primary` — the unused `--sidebar-primary` /
`--sidebar-primary-foreground` tokens and their `@theme` mappings were pruned (no
component ever referenced `bg-sidebar-primary`).

### Scrollbar

`--scrollbar` / `--scrollbar-hover` — `oklch(0.78 0.006 260)` /
`oklch(0.68 0.008 260)` light, `oklch(0.34 0 0)` / `oklch(0.46 0 0)` dark.
Applied globally (6px thin) in `src/styles.css`.

## Typography

Fonts are loaded via `next/font/google` in `app/layout.tsx` and exposed as
`--font-sans` / `--font-mono` (utilities `font-sans`, `font-mono`). `font-sans` is
the body default (`@layer base`), with antialiased smoothing.

| Family                      | Variable         | Stack                                                                            | Weights loaded |
| --------------------------- | ---------------- | -------------------------------------------------------------------------------- | -------------- |
| **DM Sans** (body/UI)       | `--font-dm-sans` | `var(--font-dm-sans), -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | 400, 500, 600  |
| **DM Mono** (numerals/code) | `--font-dm-mono` | `var(--font-dm-mono), ui-monospace, monospace`                                   | 400, 500       |

### Weights — only three exist

| Tailwind class  | Weight | Use                                       |
| --------------- | ------ | ----------------------------------------- |
| `font-normal`   | 400    | Body text                                 |
| `font-medium`   | 500    | Default for buttons, labels, most UI text |
| `font-semibold` | 600    | Headings, badges, emphasis                |

**Do not use `font-bold`, `font-light`, or any weight outside 400/500/600** — those
weights are not loaded and will render as a faux/synthetic weight. If you need a new
weight, add it to the `weight` arrays in `app/layout.tsx` **and** update this table.

### Rich text (`.thesis-prose`)

Output of the thesis rich-text editor. Base 0.875rem / line-height 1.55; `h1`–`h2`
1rem/600; `h3` uppercase muted with letter-spacing; links `oklch(0.75 0.16 250)`
underlined; `strong` 600. Defined in `src/styles.css`.

## Radius

Base `--radius: 0.75rem`. Scale (utilities `rounded-sm` … `rounded-4xl`):

| Token          | Value                        |
| -------------- | ---------------------------- |
| `--radius-sm`  | `calc(var(--radius) - 4px)`  |
| `--radius-md`  | `calc(var(--radius) - 2px)`  |
| `--radius-lg`  | `var(--radius)` (0.75rem)    |
| `--radius-xl`  | `calc(var(--radius) + 4px)`  |
| `--radius-2xl` | `calc(var(--radius) + 8px)`  |
| `--radius-3xl` | `calc(var(--radius) + 12px)` |
| `--radius-4xl` | `calc(var(--radius) + 16px)` |

## Layout

Mobile-first: the small-screen value is the base class and larger sizes are `sm:` / `md:` /
`lg:` overrides. The app shell swaps the desktop sidebar for the mobile drawer at `md`
(768px) — see `AGENTS.md` → "Frontend architecture" for the shell itself.

**Page wrappers.** A top-level page wrapper is a centered column (`mx-auto w-full max-w-*`)
with fluid padding `px-4 sm:px-6` and an `@container` context, so layouts inside a page can
use `@`-prefixed variants (`@lg:`, `@3xl:`) that track the real content width instead of the
viewport. Tailwind v4 ships container queries natively (no plugin, no config).

**Always pair `@container` with an explicit `w-full`.** `@container` sets
`container-type: inline-size`, which applies inline-size containment: the element can no
longer be sized by its own contents. On a shrink-to-fit wrapper (`mx-auto` with no `w-full`,
inside a flex column) that collapses it to zero content width.

## Icons

**`lucide-react` is the sole icon library.** Browse the full set at
<https://lucide.dev/icons/>. Import per file directly from `lucide-react` (no central
registry). Conventions for new code:

- Default size: `h-4 w-4` (16px). Small/inline: `h-3 w-3`. Icon buttons: `h-9 w-9`
  container (matches `Button` `size="icon"`).
- Color via `currentColor` / Tailwind text utilities — don't hardcode icon colors.
- `Button` automatically sizes nested SVGs to `size-4` (see `buttonVariants`).

## UI primitives

~47 shadcn/ui components in `src/components/ui/` (New York style, configured in
`components.json`): accordion, alert, alert-dialog, aspect-ratio, avatar, badge,
breadcrumb, button, calendar, card, carousel, chart, checkbox, collapsible, command,
context-menu, dialog, drawer, dropdown-menu, field, form, hover-card, input,
input-otp, label, menubar, navigation-menu, pagination, popover, progress,
radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton,
slider, sonner, switch, table, tabs, textarea, toggle, toggle-group, tooltip.

### Conventions

- **`cn()`** (`src/lib/utils.ts`) — `twMerge(clsx(...))`. Always compose classes with
  it so caller `className` overrides win without conflicts.
- **Variants** use `class-variance-authority` (`cva`). Follow this pattern for any new
  variant-bearing component.

**`Button`** (`buttonVariants`) — base includes `text-sm font-medium`, focus ring,
auto `size-4` SVGs.

- variants: `default` (foreground/background), `destructive`, `outline`, `secondary`,
  `ghost`, `link`
- sizes: `default` (h-9), `sm` (h-8, text-xs), `lg` (h-10), `icon` (h-9 w-9)

**`Badge`** (`badgeVariants`) — base `text-xs font-semibold`, rounded-md.

- variants: `default`, `secondary`, `destructive`, `outline`

## Motion & variants

- **Custom Tailwind variants** (`src/styles.css`): `dark` (`&:is(.dark *)`),
  `data-checked` (`&[data-state="checked"]`), `data-unchecked`.
- **`fall-beam`** keyframes + `.fall-beam-line::after` — animated falling-beam accent
  (driven by `--fall-beam-color/-duration/-delay`).
- **View transitions** — root view-transition animation is disabled (instant theme
  swap), see `::view-transition-old/new(root)`.
- **`PILL_TRANSITION`** (`portfolio-chart.tsx`) — shared spring for pill/tab motion:
  `{ type: "spring", stiffness: 420, damping: 34, mass: 0.7 }`.

## Intentional exceptions

These hardcoded values are **deliberate** — do not "fix" them into tokens:

- **Google brand colors** in `src/routes/login.tsx` (`#4285F4`, `#34A853`,
  `#FBBC05`, `#EA4335`) — third-party brand marks must stay literal.
- **Recharts integration selectors** in `src/components/ui/chart.tsx`
  (`[stroke='#ccc']`, `[stroke='#fff']`) — target the chart library's own defaults.
