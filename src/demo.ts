import { prisma } from './db';

/**
 * Simulated wallet backing DEMO mode.
 *
 * Balance movements are written inside a transaction together with their
 * ledger entry, so the balance and its audit trail can never disagree. The
 * demo equity curve is rebuilt from the ledger, not from the balance, which
 * means a corrupted balance can always be recomputed from history.
 */

const DEFAULT_START_SOL = Number(process.env.DEMO_STARTING_BALANCE_SOL || '10');

// Friction applied to simulated fills. A demo that fills at the exact mid
// price teaches the wrong lesson -- it makes every strategy look profitable
// and hides the fact that slippage on a thin memecoin pool is often the
// difference between edge and no edge. These default to realistic values for
// pump.fun-size liquidity and are env-tunable.
const SIM_SLIPPAGE_BPS = Number(process.env.DEMO_SLIPPAGE_BPS || '150');   // 1.5% each way
const SIM_FEE_SOL      = Number(process.env.DEMO_FEE_SOL || '0.00035');    // base + priority fee

export type LedgerKind = 'FILL_BUY' | 'FILL_SELL' | 'MANUAL_ADD' | 'MANUAL_SUB' | 'RESET';

export interface DemoBalance {
  balanceSol: number;
  startingBalance: number;
}

export async function ensureDemoAccount(chatId: string): Promise<DemoBalance> {
  const acct = await prisma.demoAccount.upsert({
    where: { chatId },
    create: { chatId, balanceSol: DEFAULT_START_SOL, startingBalance: DEFAULT_START_SOL },
    update: {},
  });
  return { balanceSol: acct.balanceSol, startingBalance: acct.startingBalance };
}

export async function getDemoBalance(chatId: string): Promise<DemoBalance> {
  return ensureDemoAccount(chatId);
}

/**
 * Move the demo balance and record why, atomically.
 * `amountSol` is signed: negative debits, positive credits.
 * Returns the new balance, or null if the move would overdraw.
 */
export async function moveDemoBalance(
  chatId: string,
  kind: LedgerKind,
  amountSol: number,
  opts: { address?: string; ticker?: string; note?: string; allowOverdraw?: boolean } = {}
): Promise<{ balanceAfter: number } | null> {
  await ensureDemoAccount(chatId);

  return prisma.$transaction(async (tx) => {
    const acct = await tx.demoAccount.findUniqueOrThrow({ where: { chatId } });
    const next = acct.balanceSol + amountSol;

    // A demo wallet that can go negative would silently invent capital you
    // never had and make the equity curve a lie.
    if (next < 0 && !opts.allowOverdraw) return null;

    const updated = await tx.demoAccount.update({
      where: { chatId },
      data: { balanceSol: next },
    });

    await tx.demoLedger.create({
      data: {
        chatId,
        kind,
        amountSol,
        balanceAfter: updated.balanceSol,
        address: opts.address ?? null,
        ticker: opts.ticker ?? null,
        note: opts.note ?? null,
        timestamp: Date.now(),
      },
    });

    return { balanceAfter: updated.balanceSol };
  });
}

/** Manual top-up / draw-down: `/demo add 5`, `/demo sub 2`. */
export async function adjustDemoBalance(
  chatId: string,
  deltaSol: number
): Promise<{ balanceAfter: number } | null> {
  const kind: LedgerKind = deltaSol >= 0 ? 'MANUAL_ADD' : 'MANUAL_SUB';
  return moveDemoBalance(chatId, kind, deltaSol, { note: 'manual adjustment' });
}

/** Wipe the demo account back to a clean starting balance. */
export async function resetDemoAccount(chatId: string, startSol?: number): Promise<DemoBalance> {
  const start = startSol ?? DEFAULT_START_SOL;
  const acct = await prisma.demoAccount.upsert({
    where: { chatId },
    create: { chatId, balanceSol: start, startingBalance: start },
    update: { balanceSol: start, startingBalance: start },
  });
  await prisma.demoLedger.create({
    data: {
      chatId, kind: 'RESET', amountSol: 0, balanceAfter: start,
      note: `reset to ${start} SOL`, timestamp: Date.now(),
    },
  });
  // Demo trade history is cleared too, otherwise the chart would show a P&L
  // curve that no longer reconciles against the balance.
  await prisma.tradeLog.deleteMany({ where: { mode: 'DEMO' } });
  await prisma.activePosition.deleteMany({ where: { mode: 'DEMO' } });
  return { balanceSol: start, startingBalance: start };
}

/**
 * Price a simulated fill the way the real market would: you buy above mid and
 * sell below it, and you pay network fees either way.
 */
export function applySimulatedSlippage(price: number, side: 'BUY' | 'SELL'): number {
  const factor = SIM_SLIPPAGE_BPS / 10_000;
  return side === 'BUY' ? price * (1 + factor) : price * (1 - factor);
}

export function simulatedFeeSol(): number {
  return SIM_FEE_SOL;
}

export async function getDemoLedger(chatId: string, sinceMs?: number) {
  return prisma.demoLedger.findMany({
    where: { chatId, ...(sinceMs ? { timestamp: { gte: sinceMs } } : {}) },
    orderBy: { timestamp: 'asc' },
  });
}
