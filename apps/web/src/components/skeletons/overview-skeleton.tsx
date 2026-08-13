// Loading skeleton for the /overview route. Pure markup (no client hooks) so
// it can be rendered from a server component (route-level loading.tsx) AND
// reused inside the client page for its Suspense fallback / loading state.
// Mirrors the loaded layout so first paint reserves the same vertical space,
// preventing CLS as content swaps in.

export function OverviewSkeleton() {
  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-4 pb-8 pt-4 sm:px-6">
      {/* Portfolio name */}
      <div className="h-8 w-48 animate-pulse rounded bg-surface-2" />

      {/* KPI strip — same container + grid as the real strip so its height
          matches exactly at every breakpoint */}
      <div className="rounded-2xl border border-hairline bg-surface px-4 py-3">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-3 @3xl:grid-cols-4 @6xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className={`min-w-0 ${i > 0 ? "@6xl:[&:not(:nth-child(7n+1))]:border-l @6xl:[&:not(:nth-child(7n+1))]:border-hairline @6xl:[&:not(:nth-child(7n+1))]:pl-4" : ""}`}
            >
              <div className="h-[14px] w-20 animate-pulse rounded bg-surface-2" />
              <div className="mt-1 h-[42px] w-28 animate-pulse rounded bg-surface-2" />
            </div>
          ))}
        </dl>
      </div>

      {/* Chart card */}
      <div className="h-[480px] animate-pulse rounded-2xl bg-surface-2" />

      {/* Recap & insights row (two cards) */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="h-44 animate-pulse rounded-2xl bg-surface-2" />
        <div className="h-44 animate-pulse rounded-2xl bg-surface-2" />
      </div>

      {/* News + Polymarket feeds */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="h-64 animate-pulse rounded-xl bg-surface-2" />
        <div className="h-64 animate-pulse rounded-xl bg-surface-2" />
      </div>
    </div>
  );
}
