import { LowLatencyExecutionEngine } from './execution';
import { TradingMode } from './settings';
import {
  moveDemoBalance,
  getDemoBalance,
  applySimulatedSlippage,
  simulatedFeeSol,
} from './demo';

/**
 * Single entry point for every buy and sell in the bot.
 *
 * The point of routing all four execution sites through here is that DEMO and
 * LIVE share one code path. Alerts, cards, TP/SL monitoring, position
 * bookkeeping and trade logging are byte-for-byte identical between modes --
 * the ONLY divergence is the few lines below that decide whether to broadcast
 * a signed transaction or debit a simulated balance. That is what makes demo
 * results actually predictive of live results.
 */

export interface TradeResult {
  success: boolean;
  signature?: string;
  error?: string;
  /** True when no real transaction was broadcast. */
  simulated: boolean;
  /** Price the fill was booked at (slippage-adjusted in demo). */
  fillPrice?: number;
  /** Net SOL movement applied to the wallet (negative = debit). */
  netSol?: number;
}

export interface BuyParams {
  address: string;
  ticker: string;
  sizeSol: number;
  slippageBps: number;
  /** Current price, used to book the simulated fill. */
  price: number;
  mode: TradingMode;
  chatId: string;
}

export interface SellParams {
  address: string;
  ticker: string;
  /** Size of the position being closed, in SOL. */
  sizeSol: number;
  slippageBps: number;
  price: number;
  entryPrice: number;
  mode: TradingMode;
  chatId: string;
}

/** Synthetic, clearly-labelled signature so demo fills are never mistaken for
 *  real ones in logs, cards or Solscan links. */
function demoSignature(): string {
  return `DEMO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TradeGateway {
  constructor(private executor: LowLatencyExecutionEngine) {}

  async buy(p: BuyParams): Promise<TradeResult> {
    if (p.mode === 'DEMO') return this.simulateBuy(p);

    if (!this.executor.hasWallet()) {
      return { success: false, error: 'No wallet loaded', simulated: false };
    }
    try {
      const tx = await this.executor.buildJupiterSwapTransaction(
        p.address, p.sizeSol, 'BUY', p.slippageBps
      );
      tx.sign([this.executor.getWalletKeypair()]);
      const r = await this.executor.executeSwap(tx);
      return {
        success: r.success,
        signature: r.signature,
        error: r.error,
        simulated: false,
        fillPrice: p.price,
        netSol: r.success ? -p.sizeSol : 0,
      };
    } catch (e: any) {
      return { success: false, error: e.message, simulated: false };
    }
  }

  async sell(p: SellParams): Promise<TradeResult> {
    if (p.mode === 'DEMO') return this.simulateSell(p);

    if (!this.executor.hasWallet()) {
      return { success: false, error: 'No wallet loaded', simulated: false };
    }
    try {
      const tx = await this.executor.buildJupiterSellTransaction(p.address, p.slippageBps);
      tx.sign([this.executor.getWalletKeypair()]);
      const r = await this.executor.executeSwap(tx);
      return {
        success: r.success,
        signature: r.signature,
        error: r.error,
        simulated: false,
        fillPrice: p.price,
      };
    } catch (e: any) {
      return { success: false, error: e.message, simulated: false };
    }
  }

  // ── Simulated fills ────────────────────────────────────────────────────────

  private async simulateBuy(p: BuyParams): Promise<TradeResult> {
    const fee = simulatedFeeSol();
    const cost = p.sizeSol + fee;

    const { balanceSol } = await getDemoBalance(p.chatId);
    if (balanceSol < cost) {
      return {
        success: false,
        simulated: true,
        error: `Insufficient demo balance: need ${cost.toFixed(4)} SOL, have ${balanceSol.toFixed(4)} SOL`,
      };
    }

    const moved = await moveDemoBalance(p.chatId, 'FILL_BUY', -cost, {
      address: p.address,
      ticker: p.ticker,
      note: `sim buy ${p.sizeSol} SOL (fee ${fee})`,
    });
    if (!moved) {
      return { success: false, simulated: true, error: 'Demo balance move rejected (overdraw)' };
    }

    return {
      success: true,
      simulated: true,
      signature: demoSignature(),
      fillPrice: applySimulatedSlippage(p.price, 'BUY'),
      netSol: -cost,
    };
  }

  private async simulateSell(p: SellParams): Promise<TradeResult> {
    const fee = simulatedFeeSol();
    const exitFill = applySimulatedSlippage(p.price, 'SELL');

    // Book the exit against the entry actually paid, so the simulated P&L
    // already carries both legs of slippage plus fees rather than the
    // frictionless mid-to-mid number.
    const grossMultiple = p.entryPrice > 0 ? exitFill / p.entryPrice : 1;
    const proceeds = p.sizeSol * grossMultiple;
    const credit = proceeds - fee;

    const moved = await moveDemoBalance(p.chatId, 'FILL_SELL', credit, {
      address: p.address,
      ticker: p.ticker,
      note: `sim sell @ ${exitFill.toFixed(10)} (fee ${fee})`,
      // Proceeds are always >= 0, so this can only ever credit.
      allowOverdraw: true,
    });

    return {
      success: true,
      simulated: true,
      signature: demoSignature(),
      fillPrice: exitFill,
      netSol: moved ? credit : 0,
    };
  }
}
