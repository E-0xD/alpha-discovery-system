import { prisma } from './db';

export type TradingMode = 'LIVE' | 'DEMO';
/** FIXED sells at takeProfitPct. TRAILING lets winners run behind a
 *  ratcheting stop instead of capping them. */
export type ExitMode = 'FIXED' | 'TRAILING';

export interface BotSettings {
  tradeSizeSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  delayedEntryEnabled: boolean;
  delayedEntryMcap: number;
  robinhoodEnabled: boolean;
  slippageBps: number;
  tradingMode: TradingMode;
  exitMode: ExitMode;
  maxPortfolioSol: number;
}

export const DEFAULT_SETTINGS: BotSettings = {
  tradeSizeSol: 0.02,
  takeProfitPct: 50,
  stopLossPct: 35,
  delayedEntryEnabled: false,
  delayedEntryMcap: 15000,
  robinhoodEnabled: true,
  slippageBps: 1000,
  // Deliberately defaults to DEMO. A fresh install (or a wiped volume) must
  // never start firing real buys before the operator has explicitly opted in.
  tradingMode: 'DEMO',
  // Defaults to the existing behaviour; switch with /exitmode.
  exitMode: 'FIXED',
  maxPortfolioSol: 5.0,
};

export async function saveSetting(
  chatId: string,
  key: keyof BotSettings,
  value: number | boolean | string
): Promise<void> {
  await prisma.botSetting.upsert({
    where: { chatId },
    create: { chatId, [key]: value } as any,
    update: { [key]: value } as any,
  });
}

export async function loadSettings(chatId: string): Promise<BotSettings> {
  try {
    const r = await prisma.botSetting.findUnique({ where: { chatId } });
    if (!r) return { ...DEFAULT_SETTINGS };
    return {
      tradeSizeSol: Number(r.tradeSizeSol) || DEFAULT_SETTINGS.tradeSizeSol,
      takeProfitPct: Number(r.takeProfitPct) || DEFAULT_SETTINGS.takeProfitPct,
      stopLossPct: Number(r.stopLossPct) || DEFAULT_SETTINGS.stopLossPct,
      delayedEntryEnabled: r.delayedEntryEnabled ?? DEFAULT_SETTINGS.delayedEntryEnabled,
      delayedEntryMcap: Number(r.delayedEntryMcap) || DEFAULT_SETTINGS.delayedEntryMcap,
      robinhoodEnabled: r.robinhoodEnabled ?? DEFAULT_SETTINGS.robinhoodEnabled,
      slippageBps: Number(r.slippageBps) || DEFAULT_SETTINGS.slippageBps,
      tradingMode: r.tradingMode === 'LIVE' ? 'LIVE' : 'DEMO',
      exitMode: r.exitMode === 'TRAILING' ? 'TRAILING' : 'FIXED',
      maxPortfolioSol: Number(r.maxPortfolioSol) || DEFAULT_SETTINGS.maxPortfolioSol,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
