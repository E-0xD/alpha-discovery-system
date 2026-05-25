import axios from 'axios';
import { VersionedTransaction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58'; // ✅ Fixed import

export class LowLatencyExecutionEngine {
  private jupiterUrl = 'https://quote-api.jup.ag/v6';
  private jitoBundleEndpoint = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
  private wallet: Keypair;

  constructor() {
    const keyString = process.env.WALLET_PRIVATE_KEY || '';
    if (!keyString) throw new Error("CRITICAL: WALLET_PRIVATE_KEY environment string is missing.");
    this.wallet = Keypair.fromSecretKey(bs58.decode(keyString));
  }

  public getWalletPublicKey(): string {
    return this.wallet.publicKey.toBase58();
  }

  public getWalletKeypair(): Keypair {
    return this.wallet;
  }

  public async buildJupiterSwapTransaction(outputMint: string, solAmount: number, direction: 'BUY' | 'SELL'): Promise<VersionedTransaction> {
    const wsolMint = 'So11111111111111111111111111111111111111112';
    const inputMint = direction === 'BUY' ? wsolMint : outputMint;
    const targetOutputMint = direction === 'BUY' ? outputMint : wsolMint;
    const computedUnits = Math.floor(solAmount * 1_000_000_000);

    const quoteRes = await axios.get(`${this.jupiterUrl}/quote`, {
      params: {
        inputMint,
        outputMint: targetOutputMint,
        amount: computedUnits,
        slippageBps: 300,
        onlyDirectRoutes: false
      },
      timeout: 8000
    });

    const swapTxRes = await axios.post(`${this.jupiterUrl}/swap`, {
      quoteResponse: quoteRes.data,
      userPublicKey: this.wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: 60000
    }, { timeout: 8000 });

    const swapBuffer = Buffer.from(swapTxRes.data.swapTransaction, 'base64');
    return VersionedTransaction.deserialize(swapBuffer);
  }

  public async dispatchMevProtectedBundle(tx: VersionedTransaction): Promise<{ success: boolean; bundleId?: string; error?: string }> {
    try {
      const serializedTx = bs58.encode(tx.serialize());
      const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [[serializedTx]]
      };

      const res = await axios.post(this.jitoBundleEndpoint, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000
      });

      if (res.data?.result) return { success: true, bundleId: res.data.result };
      return { success: false, error: JSON.stringify(res.data?.error || 'Jito rejected') };
    } catch (e: any) {
      return { success: false, error: e.message || 'Jito transport error' };
    }
  }
}
