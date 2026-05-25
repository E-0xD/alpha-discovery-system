import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';
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
const PORT = Number(process.env.PORT) || 10000;
const DOMAIN = process.env.RENDER_EXTERNAL_URL || 'https://alpha-discovery-system.onrender.com';

// Dedup — never alert same token twice per session
const seenTokens = new Set<string>();

function escapeText(text: string): string {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function getDynamicMode(score: number): string {
  if (score >= 90) return '⚡ HIGH\\_POTENTIAL\\_RUNNER';
  if (score >= 80) return '⚡ STRONG\\_SIGNAL';
  return '⚡ ORGANIC';
}

// ✅ Proper scoring — 0 to 100 based on real signals
function computeAlphaScore(mcap: number, liquidity: number, rugProb: number): number {
  let score = 0;

  // Liquidity/MCAP ratio — most important signal
  const ratio = liquidity / mcap;
  if (ratio >= 0.30) score += 40;
  else if (ratio >= 0.20) score += 30;
  else if (ratio >= 0.10) score += 20;
  else if (ratio >= 0.05) score += 10;
  // ratio < 0.05 = 0 points, likely rug

  // MCAP sweet spot — 10k to 200k is the degen runner zone
  if (mcap >= 10000 && mcap <= 200000) score += 25;
  else if (mcap >= 7000 && mcap <= 500000) score += 15;

  // Raw liquidity depth
  if (liquidity >= 25000) score += 20;
  else if (liquidity >= 10000) score += 12;
  else if (liquidity >= 5000) score += 6;

  // Rug probability penalty/bonus
  if (rugProb <= 0.10) score += 15;
  else if (rugProb <= 0.20) score += 8;
  else if (rugProb >= 0.30) score -= 10;

  return Math.min(100, Math.max(0, score));
}

// ✅ Rug probability based on real signals
function computeRugProbability(mcap: number, liquidity: number): number {
  const ratio = liquidity / mcap;
  if (ratio < 0.05) return 0.65;  // Very low liquidity vs mcap = likely rug
  if (ratio < 0.10) return 0.40;
  if (ratio < 0.20) return 0.25;
  if (mcap < 10000) return 0.35;  // Very small mcap = higher risk
  return 0.12;                     // Healthy ratio = low rug prob
}

async function scan() {
  console.log("🔍 Scanning DexScreener...");
  try {
    const { data: profiles } = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
    console.log(`Found ${profiles.length} profiles. Checking top 10...`);

    for (const p of profiles.slice(0, 10)) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Skip already alerted tokens
        if (seenTokens.has(p.tokenAddress)) {
          console.log(`⏭ Already seen: ${p.tokenAddress}`);
          continue;
        }

        const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`);
        const pair = data?.pairs?.[0];
        if (!pair) continue;

        const mcap = parseFloat(pair.fdv || pair.marketCap || '0');
        const liquidity = parseFloat(pair.liquidity?.usd || '0');
        const ticker = pair.baseToken.symbol;
        const address = pair.baseToken.address;

        // Skip if mcap or liquidity is zero/missing
        if (!mcap || !liquidity) {
          console.log(`⏭ Skipping ${ticker}: missing mcap or liquidity`);
          continue;
        }

        const rugProb = computeRugProbability(mcap, liquidity);
        const alphaScore = computeAlphaScore(mcap, liquidity, rugProb);

        console.log(`Checking ${ticker}: MCAP $${mcap} | Liquidity $${liquidity} | Score ${alphaScore}/100`);

        // ✅ Only alert on 80+ score — real high conviction plays
        if (alphaScore < 80) {
          console.log(`⏭ Score too low (${alphaScore}/100) — skipping ${ticker}`);
          seenTokens.add(p.tokenAddress); // Still mark seen to avoid recheck
          continue;
        }

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
            executionState = result.success
              ? `✅ Auto\\-Buy Executed`
              : `❌ Auto\\-Buy Failed: ${escapeText(result.error || '')}`;
          } catch (execErr: any) {
            const isNetworkErr = execErr.message?.includes('ENOTFOUND') || execErr.message?.includes('ECONNREFUSED');
            executionState = isNetworkErr
              ? `⏸ Execution Paused: Jupiter unreachable on free tier`
              : `❌ Execution Blocked: ${escapeText(execErr.message)}`;
          }
        } else {
          const reason = (!risk.allow ? risk.reason : pattern.reason) || '';
          executionState = `❌ Auto\\-Buy Blocked: ${escapeText(reason)}`;
        }

        const walletShort = `${executor.getWalletPublicKey().slice(0, 8)}...${executor.getWalletPublicKey().slice(-4)}`;

        // Score confidence label
        const confidence = alphaScore >= 90 ? '🔥 VERY HIGH' : '✅ HIGH';

        const msg = [
          `🚨🚨 *AUTONOMOUS AI DEGEN CALL* 🚨🚨`,
          ``,
          `*Token:* $${escapeText(ticker)}`,
          `*Address:* \`${address}\``,
          `*Market Cap:* 💰 $${mcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          `*Liquidity:* $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          ``,
          `🤖 *Execution State:*`,
          executionState,
          ``,
          `👾 *Deployer Metrics:*`,
          `• Wallet: \`${walletShort}\``,
          `• Bundled Launch: ${pattern.isBundledLaunch ? '⚠️ Yes' : '✅ No'}`,
          `• Top Holder %: ${pattern.topHolderConcentration}%`,
          `• Liquidity Locked: ${pattern.isLiquidityLocked ? '✅ Yes' : '❌ No'}`,
          ``,
          `📊 *AI Intelligence Matrix:*`,
          `• Alpha Score: 🟢 ${alphaScore}/100 — ${confidence}`,
          `• Rug Probability: 🛡 ${(rugProb * 100).toFixed(0)}%`,
          `• Dynamic Mode: ${getDynamicMode(alphaScore)}`,
          ``,
          `📱 [Monitor Chart Live](https://dexscreener.com/solana/${address})`,
        ].join('\n');

        await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        console.log(`✅ Alert sent for ${ticker} — Score: ${alphaScore}/100`);

        // Mark seen after successful alert
        seenTokens.add(p.tokenAddress);

        // Clear set after 500 entries to prevent memory bloat
        if (seenTokens.size > 500) seenTokens.clear();

      } catch (innerErr: any) {
        console.log(`❌ Error on token: ${innerErr.message}`);
      }
    }
  } catch (e: any) {
    console.error("Global Scan Error:", e.message);
  }
}

bot.launch({
  webhook: { domain: DOMAIN, port: PORT }
}).then(() => {
  console.log(`🤖 Bot Live via Webhook on port ${PORT}`);
  scan();
  setInterval(scan, 60000);
}).catch((err) => {
  console.error("Fatal Launch Error:", err);
  process.exit(1);
});

bot.command('test', (ctx) => ctx.reply('✅ Bot is online and all engines loaded.'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
