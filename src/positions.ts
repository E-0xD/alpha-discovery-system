import { prisma } from './db';
import { TradingMode } from './settings';

/**
 * Durable open-position storage.
 *
 * openPositions was a plain in-memory Map and nothing ever wrote to the
 * active_positions table — despite that table existing in the original schema
 * labelled "Positions Storage for Fault Tolerance". The consequence was that
 * every restart, redeploy or crash silently abandoned every open trade: the
 * tokens stayed in the wallet, the bot forgot they existed, and no stop-loss
 * or take-profit could ever fire for them again.
 *
 * Positions are keyed on (address, mode) so the same token can be held in
 * live and demo simultaneously without one overwriting the other.
 */

export interface StoredPosition {
  ticker: string;
  address: string;
  entryPrice: number;
  peakPrice: number;
  sizeSol: number;
  entryTime: number;
  /** Ladder stop as % relative to entry; null until a rung is armed. */
  trailingStopPct: number | null;
}

export async function savePosition(mode: TradingMode, p: StoredPosition): Promise<void> {
  try {
    await prisma.activePosition.upsert({
      where: { tokenAddress_mode: { tokenAddress: p.address, mode } },
      create: {
        tokenAddress: p.address,
        mode,
        ticker: p.ticker,
        entryPriceUsd: p.entryPrice,
        highestPriceUsd: p.peakPrice,
        sizeSol: p.sizeSol,
        timestamp: p.entryTime,
        trailingStopPct: p.trailingStopPct,
        status: 'OPEN',
      },
      update: {
        ticker: p.ticker,
        entryPriceUsd: p.entryPrice,
        highestPriceUsd: p.peakPrice,
        sizeSol: p.sizeSol,
        trailingStopPct: p.trailingStopPct,
        status: 'OPEN',
      },
    });
  } catch (e: any) {
    // Bookkeeping must never abort a real trade.
    console.log(`Position save failed for ${p.ticker}: ${e.message}`);
  }
}

export async function deletePosition(mode: TradingMode, address: string): Promise<void> {
  try {
    await prisma.activePosition.deleteMany({ where: { tokenAddress: address, mode } });
  } catch (e: any) {
    console.log(`Position delete failed for ${address}: ${e.message}`);
  }
}

export async function loadPositions(mode: TradingMode): Promise<StoredPosition[]> {
  try {
    const rows = await prisma.activePosition.findMany({ where: { mode, status: 'OPEN' } });
    return rows.map((r) => ({
      ticker: r.ticker || '?',
      address: r.tokenAddress,
      entryPrice: Number(r.entryPriceUsd) || 0,
      // A missing peak falls back to entry, never 0 — a 0 peak would make
      // every profit calculation nonsense.
      peakPrice: Number(r.highestPriceUsd) || Number(r.entryPriceUsd) || 0,
      sizeSol: Number(r.sizeSol) || 0,
      entryTime: Number(r.timestamp) || Date.now(),
      trailingStopPct: r.trailingStopPct == null ? null : Number(r.trailingStopPct),
    }));
  } catch (e: any) {
    console.log(`Position load failed: ${e.message}`);
    return [];
  }
}

/** Total SOL deployed across open positions in this mode — used for the cap. */
export async function openExposureSol(mode: TradingMode): Promise<number> {
  try {
    const agg = await prisma.activePosition.aggregate({
      where: { mode, status: 'OPEN' },
      _sum: { sizeSol: true },
    });
    return Number(agg._sum.sizeSol) || 0;
  } catch {
    return 0;
  }
}
