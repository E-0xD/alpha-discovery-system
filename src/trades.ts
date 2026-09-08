import { prisma } from './db';
import { TradingMode } from './settings';

/**
 * Per-mode trade ledger.
 *
 * trades_log existed in the original schema but nothing ever wrote to it --
 * the only trade record was alertHistory, which tracks how the *signal*
 * performed (alert price -> peak -> exit) rather than what you actually
 * traded, and has no notion of live vs demo. The P&L chart needs real fills
 * tagged by mode, so entries and exits are recorded here.
 */

export interface EntryRecord {
  address: string;
  ticker: string;
  mode: TradingMode;
  entryPrice: number;
  sizeSol: number;
  alertPrice?: number;
  alertMcap?: number;
  alertTime?: number;
  source?: string;
}

export interface ExitRecord {
  address: string;
  mode: TradingMode;
  exitPrice: number;
  exitType: 'TP' | 'SL' | 'MANUAL';
  pnlPct: number;
  pnlSol: number;
  heldMinutes: number;
  peakPrice?: number;
}

export async function recordEntry(e: EntryRecord): Promise<void> {
  try {
    await prisma.tradeLog.create({
      data: {
        address: e.address,
        mode: e.mode,
        ticker: e.ticker,
        source: e.source ?? null,
        entryPrice: e.entryPrice,
        entrySizeSol: e.sizeSol,
        alertPrice: e.alertPrice ?? null,
        alertMcap: e.alertMcap ?? null,
        alertTime: e.alertTime ?? Date.now(),
        status: 'OPEN',
      },
    });
  } catch (err: any) {
    // Never let bookkeeping failure abort a real trade.
    console.log(`Trade entry log failed for ${e.ticker}: ${err.message}`);
  }
}

export async function recordExit(x: ExitRecord): Promise<void> {
  try {
    // Match the most recent still-open row for this token in this mode. The
    // same token can be open in LIVE and DEMO at once, so mode is part of the
    // match, not an afterthought.
    const open = await prisma.tradeLog.findFirst({
      where: { address: x.address, mode: x.mode, status: 'OPEN' },
      orderBy: { id: 'desc' },
    });

    const data = {
      exitPrice: x.exitPrice,
      exitTime: Date.now(),
      exitType: x.exitType,
      pnlPct: x.pnlPct,
      pnlSol: x.pnlSol,
      heldMinutes: x.heldMinutes,
      peakPrice: x.peakPrice ?? null,
      status: 'CLOSED',
    };

    if (open) {
      await prisma.tradeLog.update({ where: { id: open.id }, data });
    } else {
      // No matching entry (e.g. position restored from memory after a
      // restart). Record the exit anyway so the P&L curve stays complete.
      await prisma.tradeLog.create({
        data: { address: x.address, mode: x.mode, ...data },
      });
    }
  } catch (err: any) {
    console.log(`Trade exit log failed for ${x.address}: ${err.message}`);
  }
}

export interface ClosedTrade {
  ticker: string;
  exitTime: number;
  pnlSol: number;
  pnlPct: number;
  exitType: string;
}

/** Closed trades for one mode, oldest first -- the chart's data source. */
export async function getClosedTrades(mode: TradingMode, sinceMs?: number): Promise<ClosedTrade[]> {
  const rows = await prisma.tradeLog.findMany({
    where: {
      mode,
      status: 'CLOSED',
      ...(sinceMs ? { exitTime: { gte: sinceMs } } : {}),
    },
    orderBy: { exitTime: 'asc' },
  });
  return rows.map((r) => ({
    ticker: r.ticker || '?',
    exitTime: Number(r.exitTime) || 0,
    pnlSol: Number(r.pnlSol) || 0,
    pnlPct: Number(r.pnlPct) || 0,
    exitType: r.exitType || '?',
  }));
}
