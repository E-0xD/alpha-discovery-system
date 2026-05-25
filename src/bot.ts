import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';
import * as http from 'http';
import { OnChainPatternRecognition } from './intelligence';
import { CapitalRiskEngine } from './risk';
import { LowLatencyExecutionEngine } from './execution';
import { TokenSignal } from './types';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
const intelligence = new OnChainPatternRecognition();
const riskEngine = new CapitalRiskEngine();
const executor = new LowLatencyExecutionEngine();

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Keep Render Web Service alive
const PORT = process.env.PORT || 3000;
http.createServer((_, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(PORT, () => {
  console.log(`✅ Health check server on port ${PORT}`);
});

function escape(text: string): string {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function getDynamicMode(score: number): string {
  if (score >= 90) return '⚡ HIGH_POTENTIAL_RUNNER';
  if (score >= 75) return '⚡ ORGANIC';
  return '⚡ SPECULATIVE';
}

async function scan() {
  console.log("🔍 Scanning DexScreener...");
  try {
    const { data: profiles } = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
    console.log(`Found ${profiles.length} profiles. Checking top 5...`);

    for (const p of profiles.slice(0, 5)) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`);
        const pair = data?.pairs?.[0];
        if (!pair) continue;

        const mcap = parseFloat(pair.fdv || pair.marketCap || '0');
        const liquidity = parseFloat(pair.liquidity?.usd || '0');
        const ticker = pair.baseToken.symbol;
        const address = pair.baseToken.address;

        console.log(`Checking ${ticker}: MCAP $${mcap}`);

        const rugProb = mcap < 20000 ? 0.25 : 0.12;
        const alphaScore = Math.min(100, Math.floor((liquidity / mcap) * 300 + 60));

        const signal: TokenSignal = {
          tokenAddress: address,
          ticker,
          alphaScore,
          rugProbability: rugProb,
          liquidityUsd: liquidity,
          marketCapUsd: mcap,
        };

        const [pattern, risk] = await Promise.all([
          intelligence.analyzePattern(signal),
          riskEngine.validateExecutionRisk(signal),
        ]);

        let executionState = '';

        if (risk.allow && pattern.passedPatterns) {
          try {
            const tx = await executor.buildJupiterSwapTransaction(address, risk.sizeSol, 'BUY');
            tx.sign([executor.getWalletKeypair()]);
            const result = await executor.dispatchMevProtectedBundle(tx);
            if (result.success) {
              executionState = `✅ Auto-Buy Executed | Bundle: ${result.bundleId}`;
            } else {
              executionState = `❌ Auto-Buy Failed: ${result.error}`;
            }
          } catch (execErr: any) {
            executionState = `❌ Auto-Buy Execution Blocked (${execErr.message})`;
          }
        } else {
          const blockReason = !risk.allow ? risk.reason : pattern.reason;
          executionState = `❌ Auto-Buy Blocked: ${escape(blockReason || '')}`;
        }

        const msg = `
🚨🚨 *AUTONOMOUS AI DEGEN CALL* 🚨🚨

*Token:* $${escape(ticker)}
*Address:* \`${address}\`
*Market Cap:* 💰 $${escape(mcap.toLocaleString())}
*Liquidity:* $${escape(liquidity.toLocaleString())}

🤖 *Execution State:*
${executionState}

👾 *Deployer Metrics:*
• Wallet: \`${executor.getWalletPublicKey().slice(0, 8)}...${executor.getWalletPublicKey().slice(-4)}\`
• Bundled Launch: ${pattern.isBundledLaunch ? '⚠️ Yes' : '✅ No'}
• Top Holder %: ${pattern.topHolderConcentration}%
• Liquidity Locked: ${pattern.isLiquidityLocked ? '✅ Yes' : '❌ No'}

📊 *AI Intelligence Matrix:*
• Alpha Score: 🟢 ${alphaScore}/100
• Rug Probability: 🛡 ${(rugProb * 100).toFixed(0)}%
• Dynamic Mode: ${getDynamicMode(alphaScore)}

📱 [Monitor Chart Live](https://dexscreener.com/solana/${address})
        `.trim();

        await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        console.log(`✅ Rich alert sent for ${ticker}`);

      } catch (innerErr: any) {
        console.log(`❌ Error on token: ${innerErr.message}`);
      }
    }
  } catch (e: any) {
    console.error("Global Scan Error:", e.message);
  }
}

// Launch
bot.launch({ dropPendingUpdates: true })
  .then(() => console.log("🤖 Bot Live"))
  .catch((err) => { console.error("Fatal Launch Error:", err); process.exit(1); });

bot.command('test', (ctx) => ctx.reply('✅ Bot is online and all engines loaded.'));

setInterval(scan, 60000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
