export interface TokenSignal {
  tokenAddress: string;
  ticker: string;
  alphaScore: number;
  rugProbability: number;
  liquidityUsd: number;
  marketCapUsd: number;
  callerUsername?: string;
}

export interface PatternMetrics {
  isBundledLaunch: boolean;
  devRugHistoryCount: number;
  topHolderConcentration: number;
  isLiquidityLocked: boolean;
  smartCohortPresence: boolean;
  passedPatterns: boolean;
  reason?: string;
  // ✅ New real fields from Helius
  washTradingDetected: boolean;
  buyerVelocity: 'HIGH' | 'MEDIUM' | 'LOW';
  uniqueBuyers: number;
  isPumpFun: boolean;
}

export interface Position {
  tokenAddress: string;
  ticker: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  sizeSol: number;
  tokensHeld: string;
  status: 'OPEN' | 'CLOSED';
  highestPriceUsd: number;
  timestamp: number;
}
