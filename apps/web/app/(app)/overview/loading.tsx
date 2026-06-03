import { OverviewSkeleton } from "@/components/skeletons/overview-skeleton";

// Route-level loading UI: streamed by the server before the client bundle for
// /overview loads, so the first paint already shows the full layout skeleton
// (improves FCP/LCP and avoids a blank shell while JS hydrates).
export default function Loading() {
  return <OverviewSkeleton />;
}
