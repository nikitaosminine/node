import { describe, expect, it } from "vitest";
import { getExaIncludeDomains } from "./recaps";

describe("recap Exa news domains", () => {
  it("keeps Firecrawl-only publishers out of Exa requests", () => {
    const domains = getExaIncludeDomains("en");

    expect(domains).toContain("ft.com");
    expect(domains).not.toEqual(
      expect.arrayContaining(["wsj.com", "bloomberg.com", "reuters.com", "apnews.com"]),
    );
  });

  it("adds the French secondary domains only for French recaps", () => {
    const englishDomains = getExaIncludeDomains("en");
    const frenchDomains = getExaIncludeDomains("fr");

    expect(englishDomains).not.toContain("investir.lesechos.fr");
    expect(frenchDomains).toContain("investir.lesechos.fr");
    expect(frenchDomains).toContain("capital.fr");
  });
});
