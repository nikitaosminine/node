// Loading skeleton for the /portfolios route. Pure markup (no client hooks) so
// it can render from the server (route-level loading.tsx). Mirrors the loaded
// layout: header, 5-up stat row, and a responsive grid of portfolio cards.

export function PortfoliosSkeleton() {
  return (
    <div className="@container mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      {/* Header: title + actions */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-6 w-32 animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-64 animate-pulse rounded bg-surface-2" />
        </div>
        <div className="flex gap-2">
          <div className="h-8 w-28 animate-pulse rounded-md bg-surface-2" />
          <div className="h-8 w-32 animate-pulse rounded-md bg-surface-2" />
        </div>
      </div>

      {/* Stat strip (5-up) */}
      <div className="grid grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border/50 bg-card p-4">
            <div className="h-[10px] w-16 animate-pulse rounded bg-surface-2" />
            <div className="mt-2.5 h-5 w-24 animate-pulse rounded bg-surface-2" />
          </div>
        ))}
      </div>

      {/* Portfolio cards grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-[168px] animate-pulse rounded-lg border border-border/50 bg-card"
          />
        ))}
      </div>
    </div>
  );
}
