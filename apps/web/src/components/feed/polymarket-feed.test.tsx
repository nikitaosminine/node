import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MarketRow, PolymarketFeed } from "@/components/feed/polymarket-feed";
import { isFallbackMatch } from "@/lib/polymarket-freshness";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
const TEST_NOW = Date.parse("2026-08-16T12:00:00.000Z");

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: getSessionMock },
  },
}));

type MarketInput = {
  condition_id: string;
  question: string;
  fetched_at: string;
  end_date: string;
};

function market(input: MarketInput) {
  return {
    condition_id: input.condition_id,
    event_id: null,
    event_slug: input.condition_id,
    event_title: null,
    market_slug: null,
    question: input.question,
    tags: [],
    outcomes: ["Yes", "No"],
    outcome_prices: [0.6, 0.4],
    liquidity: 100,
    volume_24hr: 1000,
    end_date: input.end_date,
    image: null,
    active: true,
    fetched_at: input.fetched_at,
  };
}

function match(
  polymarket_market: ReturnType<typeof market>,
  score: number | null,
  reason: string | null,
) {
  return {
    is_pinned: false,
    score,
    reason,
    polymarket_markets: polymarket_market,
  };
}

function mockFeedResponse(rotating: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pinned: [], rotating }),
    }),
  );
}

describe("PolymarketFeed", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(TEST_NOW);
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows honest mixed fallback treatment and never renders the retired resolved label", async () => {
    const fallback = market({
      condition_id: "fallback",
      question: "Fallback market",
      fetched_at: "2026-08-16T11:55:00.000Z",
      end_date: "2026-08-16T11:00:00.000Z",
    });
    const curated = market({
      condition_id: "curated",
      question: "Curated market",
      fetched_at: "2026-08-16T11:55:00.000Z",
      end_date: "2026-08-16T11:00:00.000Z",
    });
    mockFeedResponse([match(fallback, 0, null), match(curated, 0.8, "Relevant to your holdings")]);

    render(<PolymarketFeed portfolioId="portfolio-1" />);

    expect(
      await screen.findByText("Trending on Polymarket — personalization is catching up"),
    ).toBeInTheDocument();

    const fallbackRow = screen.getByText("Fallback market").closest("a");
    expect(fallbackRow).not.toBeNull();
    expect(fallbackRow).toHaveClass("opacity-70");

    const curatedRow = screen.getByText("Curated market").closest("a");
    expect(curatedRow).not.toBeNull();
    expect(within(curatedRow as HTMLElement).getByText("Relevant to your holdings")).toBeVisible();
    expect(screen.queryByText("Resolved")).toBeNull();
  });

  it("suppresses a non-null reason when the real fallback predicate marks the row", () => {
    const fallbackFixture = match(
      market({
        condition_id: "fallback-reason",
        question: "Fallback reason market",
        fetched_at: "2026-08-16T11:55:00.000Z",
        end_date: "2026-08-17T12:00:00.000Z",
      }),
      0,
      null,
    );
    const fallbackReason = "Volume fallback";

    expect(isFallbackMatch(fallbackFixture)).toBe(true);
    render(
      <MarketRow
        market={fallbackFixture.polymarket_markets}
        isPinned={false}
        reason={fallbackReason}
        muted={isFallbackMatch(fallbackFixture)}
      />,
    );

    const fallbackRow = screen.getByText("Fallback reason market").closest("a");
    expect(fallbackRow).not.toBeNull();
    expect(within(fallbackRow as HTMLElement).queryByText(fallbackReason)).toBeNull();
  });

  it("changes an expiring row from Ends to Ended after rerendering across its end date", () => {
    const expiring = market({
      condition_id: "expiring",
      question: "Expiring market",
      fetched_at: "2026-08-16T11:55:00.000Z",
      end_date: "2026-08-16T12:00:10.000Z",
    });

    const { rerender } = render(
      <MarketRow market={expiring} isPinned={false} reason="Relevant to your holdings" />,
    );

    const rowLink = screen.getByText("Expiring market").closest("a");
    expect(rowLink).not.toBeNull();
    expect(within(rowLink as HTMLElement).getByText(/Ends in/)).toBeInTheDocument();

    vi.mocked(Date.now).mockReturnValue(TEST_NOW + 15_000);
    rerender(<MarketRow market={expiring} isPinned={false} reason="Relevant to your holdings" />);

    expect(within(rowLink as HTMLElement).queryByText(/Ends in/)).toBeNull();
    expect(within(rowLink as HTMLElement).getByText(/Ended .* ago/)).toBeInTheDocument();
  });

  it("derives freshness from the visible rows after search filtering", async () => {
    const visibleStale = market({
      condition_id: "visible-stale",
      question: "Visible stale market",
      fetched_at: "2026-08-16T08:00:00.000Z",
      end_date: "2026-08-17T12:00:00.000Z",
    });
    const hiddenFresh = market({
      condition_id: "hidden-fresh",
      question: "Hidden fresh market",
      fetched_at: "2026-08-16T11:59:00.000Z",
      end_date: "2026-08-17T12:00:00.000Z",
    });
    mockFeedResponse([
      match(visibleStale, 0.8, "Visible reason"),
      match(hiddenFresh, 0.8, "Hidden reason"),
    ]);

    render(<PolymarketFeed portfolioId="portfolio-1" />);
    expect(await screen.findByText("Visible stale market")).toBeInTheDocument();
    expect(screen.getByText(/prices as of 1m ago/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(screen.getByPlaceholderText("Search markets…"), {
      target: { value: "Visible stale" },
    });

    await waitFor(() => expect(screen.getByText(/data may be stale/)).toBeInTheDocument());
    expect(screen.queryByText(/prices as of/)).toBeNull();
  });
});
