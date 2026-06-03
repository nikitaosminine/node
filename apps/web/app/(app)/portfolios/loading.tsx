import { PortfoliosSkeleton } from "@/components/skeletons/portfolios-skeleton";

// Route-level loading UI: streamed by the server before the /portfolios client
// bundle loads, so first paint shows the layout skeleton instead of a blank
// shell (improves FCP/LCP).
export default function Loading() {
  return <PortfoliosSkeleton />;
}
