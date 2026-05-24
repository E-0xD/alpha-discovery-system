import { Connection } from '@solana/web3.js';

export class RPCClusterManager {
  private connections: Connection[];
  private currentIndex: number = 0;

  constructor() {
    const urls = [
      process.env.SOLANA_RPC_URL,
      process.env.SOLANA_BACKUP_RPC_URL,
      'https://api.mainnet-beta.solana.com'
    ].filter((url): url is string => !!url);

    this.connections = urls.map(url => new Connection(url, 'confirmed'));
    console.log(`📡 RPC Pooler tracking [${this.connections.length}] unique endpoints.`);
  }

  public getActiveClient(): Connection {
    return this.connections[this.currentIndex];
  }

  public triggerFailover(): void {
    this.currentIndex = (this.currentIndex + 1) % this.connections.length;
    console.warn(`🔄 RPC connection lost. Re-routing cluster to Index: [${this.currentIndex}]`);
  }
}
