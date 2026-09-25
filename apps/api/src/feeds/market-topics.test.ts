import { describe, expect, it } from "vitest";

import {
  MARKET_SECTOR_LABELS,
  MAX_TOPICS_PER_ETF,
  deriveMarketTopics,
  mentionsTopic,
  type MarketTopic,
} from "./market-topics";

function topicKeys(topics: MarketTopic[]): string[] {
  return topics.map((t) => t.topicKey);
}

describe("deriveMarketTopics — static overrides", () => {
  it("maps a Nasdaq-100 ETF to the US tech market topic", () => {
    const topics = deriveMarketTopics({
      ticker: "PUST.PA",
      isin: "LU1681038243",
      name: "Amundi PEA NASDAQ-100 UCITS ETF",
    });
    expect(topicKeys(topics)).toEqual(["us-tech-market"]);
    expect(topics[0].countries).toEqual(["US"]);
    expect(topics[0].sectors).toEqual(["Technology"]);
    expect(topics[0].query.toLowerCase()).toContain("nasdaq");
  });

  it("maps an S&P 500 ETF to the US economy & broad market topic", () => {
    const topics = deriveMarketTopics({
      ticker: "ESE.PA",
      isin: "FR0011550185",
      name: "BNP Paribas Easy S&P 500 UCITS ETF",
    });
    expect(topicKeys(topics)).toEqual(["us-economy"]);
    expect(topics[0].countries).toEqual(["US"]);
  });

  it("maps an EM Asia ETF to the China & South Korea markets topic", () => {
    const topics = deriveMarketTopics({
      ticker: "PAASI.PA",
      isin: "LU1681044480",
      name: "Amundi PEA MSCI Emerging Asia UCITS ETF",
    });
    expect(topicKeys(topics)).toEqual(["china-south-korea-markets"]);
    expect(topics[0].countries).toEqual(["CN", "KR"]);
  });

  it("maps a Japan/Topix ETF to the Japan macro topic", () => {
    const topics = deriveMarketTopics({
      ticker: "PTPXH.PA",
      isin: "LU1681037781",
      name: "Amundi PEA Japan Topix UCITS ETF",
    });
    expect(topicKeys(topics)).toEqual(["japan-macro"]);
    expect(topics[0].countries).toEqual(["JP"]);
    expect(topics[0].query.toLowerCase()).toContain("bank of japan");
  });

  it("matches the static table by bare ticker when the name is opaque", () => {
    const topics = deriveMarketTopics({ ticker: "PAASI", isin: null, name: "Some Fund" });
    expect(topicKeys(topics)).toEqual(["china-south-korea-markets"]);
  });

  it("works with no constituents/geography data at all (best-effort seed)", () => {
    const topics = deriveMarketTopics(
      { ticker: "XYZ.PA", isin: null, name: "Xtrackers Nasdaq 100 UCITS ETF" },
      { topSectors: null, countryWeights: null, topConstituents: null },
    );
    expect(topicKeys(topics)).toEqual(["us-tech-market"]);
  });
});

describe("deriveMarketTopics — data-driven fallback", () => {
  it("derives country + sector topics from geography and constituents", () => {
    const topics = deriveMarketTopics(
      { ticker: "INDA.PA", isin: "IE00INDIA", name: "iShares MSCI India UCITS ETF" },
      {
        countryWeights: [{ country_code: "IN", country_name: "India", weight_pct: 95 }],
        topSectors: [{ sector: "Financials", weight_pct: 32 }],
      },
    );
    expect(topicKeys(topics)).toEqual(["country-in", "sector-financials"]);
    expect(topics[0].countries).toEqual(["IN"]);
    expect(topics[1].sectors).toEqual(["Financials"]);
    expect(topics.length).toBeLessThanOrEqual(MAX_TOPICS_PER_ETF);
  });

  it("caps at two topics, countries first", () => {
    const topics = deriveMarketTopics(
      { ticker: "WLD.PA", isin: "IE00WORLD", name: "iShares Some World Equity UCITS ETF" },
      {
        countryWeights: [
          { country_code: "US", country_name: "United States", weight_pct: 60 },
          { country_code: "JP", country_name: "Japan", weight_pct: 30 },
        ],
        topSectors: [{ sector: "Technology", weight_pct: 40 }],
      },
    );
    expect(topicKeys(topics)).toEqual(["country-us", "country-jp"]);
  });

  it("ignores low-weight countries and sectors", () => {
    const topics = deriveMarketTopics(
      { ticker: "MIX.PA", isin: "IE00MIX", name: "Some Diversified UCITS ETF" },
      {
        countryWeights: [{ country_code: "US", country_name: "United States", weight_pct: 10 }],
        topSectors: [{ sector: "Technology", weight_pct: 12 }],
      },
    );
    expect(topics).toEqual([]);
  });

  it("skips countries and sectors without a curated term list", () => {
    const topics = deriveMarketTopics(
      { ticker: "BRZ.PA", isin: "IE00BRAZIL", name: "Some Brazil Equity UCITS ETF" },
      {
        countryWeights: [{ country_code: "BR", country_name: "Brazil", weight_pct: 90 }],
        topSectors: [{ sector: "Real Estate", weight_pct: 55 }],
      },
    );
    expect(topics).toEqual([]);
  });

  it("returns no topics for an unknown ETF with no data", () => {
    expect(deriveMarketTopics({ ticker: "ZZZ.PA", isin: null, name: "Mystery Fund" })).toEqual([]);
  });

  it("derives a curated sector topic for every label in MARKET_SECTOR_LABELS", () => {
    expect(MARKET_SECTOR_LABELS).toEqual([
      "Technology",
      "Financials",
      "Energy",
      "Healthcare",
      "Industrials",
      "Consumer Discretionary",
      "Consumer Staples",
      "Utilities",
      "Materials",
      "Communication Services",
    ]);
    for (const label of MARKET_SECTOR_LABELS) {
      const topics = deriveMarketTopics(
        { ticker: "ZZZ.PA", isin: null, name: "Mystery Fund" },
        { topSectors: [{ sector: label, weight_pct: 60 }] },
      );
      expect(topicKeys(topics)).toEqual([
        `sector-${label.toLowerCase().replace(/\s+/g, "-")}`,
      ]);
      expect(topics[0].sectors).toEqual([label]);
    }
  });
});

describe("deriveMarketTopics — constituent relevance terms", () => {
  it("folds provided constituent names into relevance terms", () => {
    const [topic] = deriveMarketTopics(
      { ticker: "AASI.DE", isin: "LU00EMASIA", name: "Amundi MSCI EM Asia UCITS ETF" },
      { topConstituents: ["Samsung Electronics Co Ltd", "Tencent Holdings (700.HK)"] },
    );
    expect(mentionsTopic("Samsung Electronics posts record chip profit", topic)).toBe(true);
    expect(mentionsTopic("Tencent Holdings beats revenue estimates", topic)).toBe(true);
  });

  it("falls back to the static top-5 labels when constituents are missing", () => {
    const [topic] = deriveMarketTopics({
      ticker: "PUST.PA",
      isin: null,
      name: "Amundi PEA NASDAQ-100 UCITS ETF",
    });
    expect(mentionsTopic("NVDA jumps on record data-center revenue", topic)).toBe(true);
  });
});

describe("mentionsTopic — market drift filter", () => {
  const usTech = deriveMarketTopics({
    ticker: "PUST.PA",
    isin: null,
    name: "Amundi PEA NASDAQ-100 UCITS ETF",
  })[0];
  const usEconomy = deriveMarketTopics({
    ticker: "SP5.PA",
    isin: null,
    name: "BNP Paribas Easy S&P 500 UCITS ETF",
  })[0];
  const japan = deriveMarketTopics({
    ticker: "PTPXH.PA",
    isin: null,
    name: "Amundi PEA Japan Topix UCITS ETF",
  })[0];

  it("accepts on-topic headlines", () => {
    expect(mentionsTopic("Nasdaq rallies as tech stocks extend gains", usTech)).toBe(true);
    expect(mentionsTopic("Semiconductor stocks slide on export curbs", usTech)).toBe(true);
    expect(mentionsTopic("Federal Reserve holds rates steady", usEconomy)).toBe(true);
    expect(mentionsTopic("S&P 500 closes at a record high", usEconomy)).toBe(true);
    expect(mentionsTopic("Bank of Japan signals policy shift as yen weakens", japan)).toBe(true);
  });

  it("rejects off-topic headlines", () => {
    expect(mentionsTopic("Local bakery wins pastry award", usTech)).toBe(false);
    expect(mentionsTopic("Ligue 1 title race heats up", usEconomy)).toBe(false);
    expect(mentionsTopic("New Marvel movie tops box office", japan)).toBe(false);
  });

  it("respects word boundaries (no substring drift)", () => {
    // "fed" must not match inside "federated"
    expect(mentionsTopic("Federated Hermes launches new fund", usEconomy)).toBe(false);
    expect(mentionsTopic("Fed signals two more cuts", usEconomy)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(mentionsTopic("NASDAQ FUTURES POINT HIGHER", usTech)).toBe(true);
  });
});
