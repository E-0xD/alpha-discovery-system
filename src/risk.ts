import { TokenSignal } from './types';
import { db } from './db';

export class CapitalRiskEngine {
  private MAX_SOL_ALLOCATION_PER_TRADE = 1.0; 
  private MAX_PORTFOLIO_EXPOSURE_SOL = 5.0;
  private GLOBAL_KILL_SWITCH = false;

  public async validateExecutionRisk(signal: TokenSignal): Promise<{ allow: boolean; sizeSol: number; reason?: string }> {
    if (this.GLOBAL_KILL_SWITCH) return { allow: false, sizeSol: 0, reason: 'GLOBAL_RISK_KILL_SWITCH_ACTIVE' };

    // STRICT IN-PROMPT MARKET CAP BOUNDARIES
    if (signal.marketCapUsd < 7000) return { allow: false, sizeSol: 0, reason: 'MCAP_BELOW_7K_LIMIT' };
    if (signal.marketCapUsd > 500000) return { allow: false, sizeSol: 0, reason: 'MCAP_ABOVE_500K_LIMIT' };

    // Structural Filter Gatekeeping
    if (signal.alphaScore < 70) return { allow: false, sizeSol: 0, reason: 'ALPHA_SCORE_BELOW_MINIMUM' };
    if (signal.rugProbability > 0.30) return { allow: false, sizeSol: 0, reason: 'RUG_PROBABILITY_TOO_HIGH' };
    if (signal.liquidityUsd < 6000) return { allow: false, sizeSol: 0, reason: 'LIQUIDITY_POOL_UNSAFE' };

    // Verify Active Exposure Metrics
    try {
      const activePositionsRes = await db.query(`SELECT SUM(size_sol) as active_sol FROM active_positions WHERE status = 'OPEN'`);
      const totalActiveSol = parseFloat(activePositionsRes.rows[0]?.active_sol || '0');

      if (totalActiveSol + this.MAX_SOL_ALLOCATION_PER_TRADE > this.MAX_PORTFOLIO_EXPOSURE_SOL) {
        return { allow: false, sizeSol: 0, reason: 'MAX_PORTFOLIO_EXPOSURE_REACHED' };
      }
    } catch {
      return { allow: false, sizeSol: 0, reason: 'EXPOSURE_CHECK_DATABASE_OFFLINE' };
    }

    // Dynamic Sizing based on Score Confidence Matrix
    let finalSize = this.MAX_SOL_ALLOCATION_PER_TRADE;
    if (signal.alphaScore > 85 && signal.rugProbability < 0.15) {
      finalSize = this.MAX_SOL_ALLOCATION_PER_TRADE; // Conviction Play
    } else {
      finalSize = this.MAX_SOL_ALLOCATION_PER_TRADE * 0.5; // Scale risk down 50%
    }

    return { allow: true, sizeSol: finalSize };
  }
}
