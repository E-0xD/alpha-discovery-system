import { TokenSignal } from './types';

export class CapitalRiskEngine {
  private MAX_SOL_ALLOCATION_PER_TRADE = 0.02;
  private MAX_PORTFOLIO_EXPOSURE_SOL = 5.0;
  private GLOBAL_KILL_SWITCH = false;

  public async validateExecutionRisk(signal: TokenSignal): Promise<{ allow: boolean; sizeSol: number; sizeMultiplier?: number; reason?: string }> {
    if (this.GLOBAL_KILL_SWITCH) return { allow: false, sizeSol: 0, reason: 'GLOBAL_RISK_KILL_SWITCH_ACTIVE' };
    if (signal.marketCapUsd < 1000) return { allow: false, sizeSol: 0, reason: 'MCAP_BELOW_1K_LIMIT' };
    if (signal.marketCapUsd > 70000) return { allow: false, sizeSol: 0, reason: 'MCAP_ABOVE_70K_LIMIT' };
    if (signal.alphaScore < 70) return { allow: false, sizeSol: 0, reason: 'ALPHA_SCORE_BELOW_MINIMUM' };
    if (signal.rugProbability > 0.30) return { allow: false, sizeSol: 0, reason: 'RUG_PROBABILITY_TOO_HIGH' };
    if (signal.liquidityUsd < 6000) return { allow: false, sizeSol: 0, reason: 'LIQUIDITY_POOL_UNSAFE' };

        // Double up on A+ setups. This is returned as a MULTIPLIER, not an
    // absolute size: the previous version returned a size derived from a
    // hard-coded 0.02 constant, which the caller ignored in favour of the
    // configured trade size -- so conviction sizing silently did nothing.
    // As a multiplier it composes with whatever size is set in /settings.
    const sizeMultiplier = (signal.alphaScore > 85 && signal.rugProbability < 0.15) ? 2 : 1;

    return {
      allow: true,
      sizeSol: this.MAX_SOL_ALLOCATION_PER_TRADE * sizeMultiplier,
      sizeMultiplier,
    };
  }
}
