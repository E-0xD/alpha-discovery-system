import { RPCManager } from './execution/RPCManager';
import { PositionManager } from './state/PositionManager';
import { RiskEngine } from './risk/RiskEngine';
import { JupiterClient } from './execution/JupiterClient';
import { JitoBundler } from './execution/JitoBundler';
import { TokenSignal, Position } from './types/execution';
import { Keypair } from '@solana/web3.solana';
import * as bs58 from 'bs58';

export class AlphaExecutionSystem {
  private rpc = new RPCManager([(process.env.SOLANA_RPC_URL || '')]);
  private posManager = PositionManager.getInstance();
  private risk = new RiskEngine();
  private jupiter = new JupiterClient();
  private jito = new JitoBundler();
  private executionWallet: Keypair;

  constructor() {
    const privateKey = process.env.WALLET_PRIVATE_KEY || '';
    this.executionWallet = Keypair.fromSecretKey(bs58.decode(privateKey));
  }

  // Master entrypoint triggered instantly via Ingestion/PubSub Stream Engine
  public async handleIncomingSignal(signal: TokenSignal): Promise<void> {
    console.log(`📡 Ingestion signal caught for asset: $${signal.ticker} | MCAP: $${signal.marketCapUsd}`);

    const riskEvaluation = this.risk.validateSignal(signal);
    if (!riskEvaluation.passed) {
      console.log(`🛑 Trade aborted by Risk Engine. Vector: [${riskEvaluation.reason}]`);
      return;
    }

    const tokenAddress = signal.tokenAddress;
    const sizeSol = riskEvaluation.allocatedSizeSol || 0.5;

    // Concurrency Lock Check to eliminate multi-trigger double buying
    if (!this.posManager.acquireLock(tokenAddress)) {
      console.warn(`🔒 Mutex locked for ${tokenAddress}. Drop operation.`);
      return;
    }

    try {
      console.log(`🎯 Risk cleared. Building execution route payload for $${signal.ticker}...`);
      
      // Build transaction payload from Jupiter
      const versionedTx = await this.jupiter.getBuyTransaction(
        this.executionWallet.publicKey.toBase58(),
        tokenAddress,
        sizeSol
      );

      // Sign the transaction
      const latestBlockhash = await this.rpc.getClient().getLatestBlockhash();
      versionedTx.message.recentBlockhash = latestBlockhash.blockhash;
      versionedTx.sign([this.executionWallet]);

      // Route via Jito MEV protection layer
      console.log(`✈️ Dispatching signed bundle payload to Jito Block Engine...`);
      const bundleResult = await this.jito.compileAndSendBundle([versionedTx]);

      if (bundleResult.success) {
        console.log(`🚀 Swap Bundle dispatched cleanly! ID: ${bundleResult.bundleId}`);
        
        // Push provisional tracked position into internal thread-safe memory state
        const initialPosition: Position = {
          tokenAddress,
          ticker: signal.ticker,
          entryPriceUsd: signal.marketCapUsd / 100000000, // Normalized baseline valuation tracker
          currentPriceUsd: signal.marketCapUsd / 100000000,
          sizeSol,
          tokensHeld: '0', // Populated upon block tracking confirm loop
          status: 'OPEN',
          highestPriceUsd: signal.marketCapUsd / 100000000,
          timestamp: Date.now()
        };
        this.posManager.updatePosition(initialPosition);
      } else {
        console.error(`❌ Jito Execution Rejected Bundle: ${bundleResult.error}`);
      }

    } catch (err) {
      console.error(`💥 Critical execution fault handled on entry route:`, err);
    } finally {
      this.posManager.releaseLock(tokenAddress);
    }
  }
}
