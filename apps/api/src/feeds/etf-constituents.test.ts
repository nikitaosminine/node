import { describe, expect, it } from "vitest";

import { etfConstituentsPromptExtension } from "./etf-constituents";
import { MARKET_SECTOR_LABELS } from "./market-topics";

// The prompt extension is an intentional generated interface — the exact text
// delivered to the research LLM. It must constrain constituent sectors to the
// curated vocabulary so every emitted label resolves in deriveMarketTopics.
describe("etfConstituentsPromptExtension — generated LLM interface", () => {
  it("constrains constituent sectors to the exact curated vocabulary", () => {
    const prompt = etfConstituentsPromptExtension();
    expect(prompt).toContain(
      `sector chosen from exactly this list: ${MARKET_SECTOR_LABELS.join(", ")}`,
    );
  });

  it("keeps the top_constituents JSON contract unchanged", () => {
    const prompt = etfConstituentsPromptExtension();
    expect(prompt).toContain(
      '"top_constituents": [{ "ticker": "AAPL", "name": "Apple Inc.", "weight_pct": 8.2, "country_code": "US", "sector": "Technology" }]',
    );
    expect(prompt).toContain(
      "do not let missing constituent data affect the allocations or confidence fields",
    );
  });
});
