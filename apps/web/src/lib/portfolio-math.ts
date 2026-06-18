// ---------------------------------------------------------------------------
// Shared portfolio calculation utilities
// Used by both the Overview page and the portfolio-detail route.
// ---------------------------------------------------------------------------

export interface TransactionApiRow {
  date: string;
  symbol: string;
  isin: string | null;
  yahoo_ticker: string | null;
  side: string;
  quantity: number | null;
  net_amount: number | null;
  commission: number;
}

export function toFiniteNumber(value: number | null | undefined): number {
  const numericValue = Number(value ?? 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

/**
 * Compute realized P&L from sell transactions using FIFO lot matching.
 * Returns realizedPnL, realizedCostBasis, and realizedPct.
 * realizedCostBasis === 0 means no positions have been sold.
 */
export function computeRealizedSellPnL(transactions: TransactionApiRow[]): {
  realizedPnL: number;
  realizedCostBasis: number;
  realizedPct: number;
} {
  const lots = new Map<string, { quantity: number; cost: number }>();
  let realizedPnL = 0;
  let realizedCostBasis = 0;

  const chronologicalTransactions = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

  for (const transaction of chronologicalTransactions) {
    if (!transaction.isin || (transaction.side !== "BUY" && transaction.side !== "SELL")) continue;

    const quantity = toFiniteNumber(transaction.quantity);
    if (quantity <= 0) continue;

    const lot = lots.get(transaction.isin) ?? { quantity: 0, cost: 0 };
    if (transaction.side === "BUY") {
      lot.quantity += quantity;
      lot.cost += Math.abs(toFiniteNumber(transaction.net_amount));
      lots.set(transaction.isin, lot);
      continue;
    }

    const averageCost = lot.quantity > 0 ? lot.cost / lot.quantity : 0;
    const soldCostBasis = averageCost * quantity;
    realizedPnL += toFiniteNumber(transaction.net_amount) - soldCostBasis;
    realizedCostBasis += soldCostBasis;
    lot.quantity -= quantity;
    lot.cost = Math.max(0, lot.cost - soldCostBasis);

    if (lot.quantity > 0.000001) lots.set(transaction.isin, lot);
    else lots.delete(transaction.isin);
  }

  return {
    realizedPnL,
    realizedCostBasis,
    realizedPct: realizedCostBasis > 0 ? (realizedPnL / realizedCostBasis) * 100 : 0,
  };
}
