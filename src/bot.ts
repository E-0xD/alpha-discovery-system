import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';
import WebSocket from 'ws';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { OnChainPatternRecognition } from './intelligence';
import { CapitalRiskEngine } from './risk';
import * as http from 'http';
import { LowLatencyExecutionEngine } from './execution';
import { TradeGateway, TradeResult } from './trading';
import { getDemoBalance, ensureDemoAccount, adjustDemoBalance, resetDemoAccount } from './demo';
import { recordEntry, recordExit, getClosedTrades } from './trades';
import { renderPnlChart } from './chart';
import { helpIndex, helpTopic, chunk, TOPICS } from './help';
import { TokenSignal } from './types';
import { saveEncryptedWallet, loadDecryptedWallet } from './wallet';
import { saveSetting, loadSettings, BotSettings, DEFAULT_SETTINGS } from './settings';
import Redis from 'ioredis';
import { prisma, initDatabaseSchema } from './db';
import { renderExitCard, renderMilestoneCard, renderRecapCard, renderCallResultCard } from './cards';
// import { startPonsFactoryListener, runPonsScan, stopPonsFactoryListener } from './robinhood';

// Redis is an optional accelerator, not a dependency. SQLite is the source of
// truth for history, and the cross-instance dedup it used to provide is moot
// now that SQLite pins this to a single container.
//
// `new Redis('')` does NOT mean "disabled" — ioredis falls back to
// localhost:6379 and then retries forever, flooding the log with ECONNREFUSED
// on any host without Redis. So when REDIS_URL is unset we substitute a no-op
// that satisfies the two call sites and never opens a socket.
const redis: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<unknown> } =
  process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL)
    : {
        async get() { return null; },
        async set() { return null; },
      };

if (!process.env.REDIS_URL) {
  console.log('Redis not configured — using SQLite alone (expected on a single-container deploy).');
}

dotenv.config();

// ── Finding 4: fail fast at startup instead of failing silently minutes later ──
const REQUIRED_ENV_VARS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DATABASE_URL'];
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]?.trim()) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT) || 10000;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');
// ── Security: only respond in authorized chat ──
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id?.toString();
  if (chatId !== CHAT_ID) {
    console.log(`🚫 Unauthorized access attempt from chat: ${chatId}`);
    return; // silently ignore — don't respond at all
  }
  return next();
});
const intelligence = new OnChainPatternRecognition();
const riskEngine = new CapitalRiskEngine();
const executor = new LowLatencyExecutionEngine();
// Every buy and sell routes through the gateway so LIVE and DEMO share one
// code path -- see src/trading.ts.
const gateway = new TradeGateway(executor);

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const DENGINE_NAME = 'Dengine';
const TRADER_NAME = 'ChrisOG';

// ── SOL/USD, cached — used to show $ amounts on exit cards ──
let cachedSolUsd = 0;
let cachedSolUsdAt = 0;
const SOL_PRICE_TTL_MS = 60_000;
async function getSolUsd(): Promise<number> {
  const now = Date.now();
  if (cachedSolUsd > 0 && now - cachedSolUsdAt < SOL_PRICE_TTL_MS) return cachedSolUsd;
  try {
    const res = await axios.get('https://coins.llama.fi/prices/current/coingecko:solana', { timeout: 5000 });
    const price = res.data?.coins?.['coingecko:solana']?.price;
    if (price > 0) {
      cachedSolUsd = price;
      cachedSolUsdAt = now;
    }
  } catch (e: any) {
    console.log(`⚠️ SOL/USD fetch failed, using last cached value: ${e.message}`);
  }
  return cachedSolUsd;
}

// ── Token logo, pulled from DexScreener — cached per address for an hour
// since a token's image doesn't change often, and this avoids a repeat
// lookup every time the same token gets a card generated. ──
const logoCache = new Map<string, { url: string | undefined; cachedAt: number }>();
const LOGO_CACHE_TTL_MS = 60 * 60 * 1000;
async function getTokenLogoUrl(address: string): Promise<string | undefined> {
  const cached = logoCache.get(address);
  if (cached && Date.now() - cached.cachedAt < LOGO_CACHE_TTL_MS) return cached.url;
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 5000 });
    const url = data?.pairs?.[0]?.info?.imageUrl || undefined;
    logoCache.set(address, { url, cachedAt: Date.now() });
    return url;
  } catch {
    logoCache.set(address, { url: undefined, cachedAt: Date.now() });
    return undefined;
  }
}
// Public HTTPS origin Telegram will POST webhook updates to.
//
// This used to fall back to a hard-coded Render URL. On any other host that
// silently registered the webhook against someone else's domain, so the bot
// came up "healthy" and simply never received a single update. Failing loudly
// is far better than that, so an unset domain is fatal.
const DOMAIN =
  process.env.PUBLIC_URL ||
  process.env.APP_URL ||
  process.env.WEBHOOK_URL ||
  process.env.RAILWAY_STATIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  '';

// Transport: webhook or long polling.
//
// Polling needs no public URL at all — the bot opens an outbound connection to
// Telegram and pulls updates, so it works behind NAT, on a laptop, with no
// tunnel and no TLS. It is the right default for local development.
//
// Webhook is lower latency and cheaper at scale, and is what you want on a VPS
// with a real domain. Auto-selected when a public URL is present; override
// either way with BOT_MODE=polling|webhook.
const BOT_MODE: 'polling' | 'webhook' =
  process.env.BOT_MODE === 'polling' ? 'polling'
  : process.env.BOT_MODE === 'webhook' ? 'webhook'
  : DOMAIN ? 'webhook' : 'polling';

if (BOT_MODE === 'webhook' && !DOMAIN) {
  console.error(
    'FATAL: BOT_MODE=webhook but no public URL set. Either set PUBLIC_URL to a ' +
    'public HTTPS origin, or use BOT_MODE=polling which needs no URL at all.'
  );
  process.exit(1);
}
const seenTokens = new Set<string>();
const seenTokensQueue: string[] = [];
const wssPumpTokensQueue: any[] = [];
type AwaitingType = 'privateKey' | 'tradeSize' | 'tp' | 'sl' | 'delayedEntryMcap' | 'slippage';
const awaitingInput = new Map<string, AwaitingType>();
const awaitingTimers = new Map<string, NodeJS.Timeout>();
const AWAITING_TIMEOUT_MS = 5 * 60 * 1000;
let botSettings: BotSettings = { ...DEFAULT_SETTINGS };

// ── Finding 2: FIFO-bounded dedup — evicts only the oldest entry instead of wiping the whole set ──
function markSeen(address: string) {
  if (seenTokens.has(address)) return;
  seenTokens.add(address);
  seenTokensQueue.push(address);
  if (seenTokensQueue.length > 500) {
    const oldest = seenTokensQueue.shift()!;
    seenTokens.delete(oldest);
  }
}

// ── Finding 8: settings prompts auto-expire and can be cancelled ──
function setAwaiting(chatId: string, type: AwaitingType) {
  const existing = awaitingTimers.get(chatId);
  if (existing) clearTimeout(existing);
  awaitingInput.set(chatId, type);
  const timer = setTimeout(async () => {
    awaitingInput.delete(chatId);
    awaitingTimers.delete(chatId);
    try {
      await bot.telegram.sendMessage(chatId, '⌛ Settings input timed out — use /settings to try again.');
    } catch {}
  }, AWAITING_TIMEOUT_MS);
  awaitingTimers.set(chatId, timer);
}

function clearAwaiting(chatId: string) {
  const existing = awaitingTimers.get(chatId);
  if (existing) clearTimeout(existing);
  awaitingTimers.delete(chatId);
  awaitingInput.delete(chatId);
}

interface Position {
  ticker: string;
  address: string;
  entryPrice: number;
  peakPrice: number;
  sizeSol: number;
  entryTime: number;
  // ── Dynamic trailing stop loss state ──
  stopLossLevel: 'initial' | 'breakeven' | 'trailing';
  stopLossPct: number; // current stop loss % relative to entry (negative = below entry)
  remainingPct: number; // remaining position size (starts at 100)
}
const openPositions = new Map<string, Position>();

// ── Delayed entry: alert fires immediately, auto-buy waits for botSettings.delayedEntryMcap ──
interface PendingEntry {
  ticker: string;
  address: string;
}
const pendingEntries = new Map<string, PendingEntry>();

interface AlertRecord {
  ticker: string;
  address: string;
  alertTime: number;
  alertMcap: number;
  alertPrice: number;
  peakMcap: number;
  peakPrice: number;
  peakTime: number;
  currentMcap: number;
  currentPrice: number;
  lastUpdated: number;
  exitReason?: 'TP' | 'SL' | 'OPEN';
  exitPrice?: number;
  exitMcap?: number;
  exitTime?: number;
  milestonesHit: number[];
}

// ── Milestone thresholds as multiples of alert price, with their announcement text ──
const MILESTONE_THRESHOLDS: { multiple: number; label: string }[] = [
  { multiple: 1.5, label: '🚀 is now +50%' },
  { multiple: 2, label: '🚀 just crossed 2X' },
  { multiple: 3, label: '🔥 reached 3X' },
  { multiple: 5, label: '🔥 reached 5X' },
  { multiple: 10, label: '💎 reached 10X' },
  { multiple: 20, label: '👑 reached 20X' },
  { multiple: 30, label: '👑 reached 30X' },
  { multiple: 50, label: '👑 reached 50X' },
  { multiple: 100, label: '🏆 reached 100X' },
];
let alertHistory = new Map<string, AlertRecord>();
// ── Finding 6: only addresses touched since the last save get upserted to Postgres ──
const dirtyAddresses = new Set<string>();

function setAlert(address: string, rec: AlertRecord) {
  alertHistory.set(address, rec);
  dirtyAddresses.add(address);
}

const EXIT_REASONS = ['TP', 'SL', 'OPEN'] as const;

// ── History persistence: Redis (hot cache) -> SQLite via Prisma (durable) ──
// Redis stays an optional accelerator; SQLite is the source of truth. If no
// REDIS_URL is configured the bot runs perfectly well on SQLite alone, which
// is the expected single-container setup on a VPS.
async function loadHistory() {
  try {
    const data = await redis.get('bot_history');
    if (data) {
      alertHistory = new Map(JSON.parse(data));
      console.log(`✅ History loaded from Redis: ${alertHistory.size} records`);
      return;
    }
  } catch (e) {
    console.log('⚠️ Redis load failed, falling back to SQLite...');
  }

  try {
    const rows = await prisma.alertHistory.findMany({
      orderBy: { alertTime: 'desc' },
      take: 500,
    });
    for (const row of rows) {
      let milestones: number[] = [];
      try {
        // Stored as a JSON string: SQLite has no native JSON column type.
        const parsed = JSON.parse(row.milestonesHit || '[]');
        if (Array.isArray(parsed)) milestones = parsed;
      } catch {}

      alertHistory.set(row.address, {
        ticker: row.ticker || '',
        address: row.address,
        alertTime: Number(row.alertTime),
        alertMcap: Number(row.alertMcap),
        alertPrice: Number(row.alertPrice),
        peakMcap: Number(row.peakMcap),
        // NULL peak_price falls back to alert_price, not 0.
        peakPrice: Number(row.peakPrice) || Number(row.alertPrice) || 0,
        peakTime: Number(row.peakTime),
        currentMcap: Number(row.currentMcap),
        currentPrice: Number(row.currentPrice),
        lastUpdated: Number(row.lastUpdated),
        // SQLite hands back a plain string; validate it against the union
        // rather than casting, so a corrupt/legacy value degrades to undefined
        // instead of silently typing as a valid exit reason.
        exitReason: EXIT_REASONS.includes(row.exitReason as any)
          ? (row.exitReason as 'TP' | 'SL' | 'OPEN')
          : undefined,
        exitPrice: row.exitPrice != null ? Number(row.exitPrice) : undefined,
        exitMcap: row.exitMcap != null ? Number(row.exitMcap) : undefined,
        exitTime: row.exitTime != null ? Number(row.exitTime) : undefined,
        milestonesHit: milestones,
      });
    }
    console.log(`✅ History loaded from SQLite: ${alertHistory.size} records`);
  } catch (e: any) {
    console.log(`⚠️ SQLite history load failed: ${e.message}`);
  }
}

// Only addresses touched since the last save are written back.
async function saveHistory() {
  try {
    await redis.set('bot_history', JSON.stringify(Array.from(alertHistory.entries())));
  } catch (e: any) {
    console.log(`⚠️ Redis save failed: ${e.message}`);
  }

  if (dirtyAddresses.size === 0) return;

  for (const address of Array.from(dirtyAddresses)) {
    const rec = alertHistory.get(address);
    if (!rec) {
      dirtyAddresses.delete(address);
      continue;
    }
    try {
      // The old raw SQL used GREATEST(...) / CASE in an ON CONFLICT clause to
      // make peaks monotonic. Prisma has no portable equivalent, so the same
      // guarantee is enforced here: read the stored row and never let a peak
      // move backwards, and only advance peak_time when the peak price itself
      // actually improved.
      const existing = await prisma.alertHistory.findUnique({ where: { address } });

      const peakPrice = Math.max(Number(rec.peakPrice) || 0, Number(existing?.peakPrice) || 0);
      const peakMcap = Math.max(Number(rec.peakMcap) || 0, Number(existing?.peakMcap) || 0);
      const peakTime =
        (Number(rec.peakPrice) || 0) > (Number(existing?.peakPrice) || 0)
          ? rec.peakTime
          : existing?.peakTime ?? rec.peakTime;

      const data = {
        ticker: rec.ticker,
        alertTime: rec.alertTime,
        alertMcap: rec.alertMcap,
        alertPrice: rec.alertPrice,
        peakMcap,
        peakPrice,
        peakTime,
        currentMcap: rec.currentMcap,
        currentPrice: rec.currentPrice,
        lastUpdated: rec.lastUpdated,
        exitReason: rec.exitReason ?? null,
        exitPrice: rec.exitPrice ?? null,
        exitMcap: rec.exitMcap ?? null,
        exitTime: rec.exitTime ?? null,
        milestonesHit: JSON.stringify(rec.milestonesHit || []),
      };

      await prisma.alertHistory.upsert({
        where: { address },
        create: { address, ...data },
        update: data,
      });
      dirtyAddresses.delete(address);
    } catch (e: any) {
      console.log(`⚠️ SQLite history save failed for ${address}: ${e.message}`);
    }
  }
}

function escapeText(text: string): string {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function getDynamicMode(score: number): string {
  if (score >= 90) return '⚡ HIGH\\_POTENTIAL\\_RUNNER';
  if (score >= 80) return '⚡ STRONG\\_SIGNAL';
  return '⚡ ORGANIC';
}

// AFTER
function computeAlphaScore(mcap: number, liquidity: number, rugProb: number): number {
  let score = 0;
  const ratio = liquidity / mcap;
  if (ratio >= 0.30) score += 40;
  else if (ratio >= 0.20) score += 30;
  else if (ratio >= 0.10) score += 20;
  else if (ratio >= 0.05) score += 10;
  if (mcap >= 1000 && mcap <= 50000) score += 25;

  // ── Liquidity scoring: ratio bonus for $10k–$17k range, raw otherwise ──
  if (mcap >= 10000 && mcap <= 17000) {
    if (ratio >= 0.30) score += 20;
    else if (ratio >= 0.20) score += 14;
    else if (ratio >= 0.10) score += 7;
  } else {
    if (liquidity >= 25000) score += 20;
    else if (liquidity >= 10000) score += 12;
    else if (liquidity >= 5000) score += 6;
  }

  if (rugProb <= 0.10) score += 15;
  else if (rugProb <= 0.20) score += 8;
  else if (rugProb >= 0.30) score -= 10;
  return Math.min(100, Math.max(0, score));
}

function computeRugProbability(mcap: number, liquidity: number): number {
  const ratio = liquidity / mcap;
  if (ratio < 0.05) return 0.65;
  if (ratio < 0.10) return 0.40;
  if (ratio < 0.20) return 0.25;
  if (mcap < 5000) return 0.35;
  return 0.12;
}

// ─────────────────────────────────────────────────────────────────────────
// Lore/story-strength scoring — some tokens have a genuine, specific,
// shareable narrative (real people, real events, a distinct concept)
// instead of generic copy-paste PvP-relaunch language. That's a real
// signal worth boosting, but judging it is a language task, not something
// a keyword list can do reliably. Two-stage approach: a free heuristic
// filters out anything too short/empty to even be a real story, THEN an
// AI call judges only the survivors — keeps API usage cheap and bounded.
// ─────────────────────────────────────────────────────────────────────────

function hasLorePotential(description: string | undefined): boolean {
  if (!description) return false;
  const trimmed = description.trim();
  if (trimmed.length < 60) return false; // too short to be a real story
  const wordCount = trimmed.split(/\s+/).length;
  return wordCount >= 12;
}

async function scoreLoreWithAI(ticker: string, description: string): Promise<number> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return 0;
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `Rate how compelling and shareable this crypto token's story/lore is, on a scale of 0-100. A high score means a genuine, specific, unique narrative (real people, real events, a distinct concept) that could realistically go viral. A low score means generic, vague, templated, or copy-paste marketing language with no real story.\n\nToken: $${ticker}\nDescription: "${description}"\n\nRespond with ONLY a number from 0 to 100, nothing else.`
      }]
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 8000
    });
    const text = res.data?.choices?.[0]?.message?.content?.trim() || '0';
    const score = parseInt(text, 10);
    return isNaN(score) ? 0 : Math.min(100, Math.max(0, score));
  } catch (e: any) {
    console.log(`⚠️ Lore scoring failed for ${ticker}: ${e.message}`);
    return 0;
  }
}

function isReversalCandidate(pair: any): boolean {
  const h24 = parseFloat(pair.priceChange?.h24 || '0');
  const h6 = parseFloat(pair.priceChange?.h6 || '0');
  const h1 = parseFloat(pair.priceChange?.h1 || '0');
  const volH24 = parseFloat(pair.volume?.h24 || '0');
  const volH6 = parseFloat(pair.volume?.h6 || '0');
  // AFTER
const recoveringH1 = h1 > 0;
const stillDownH6 = h6 < 0;
const volumeReturning = volH6 > 0 && volH24 > 0 && (volH6 / volH24) > 0.3;
const dumpedHard = h24 <= -40;
return dumpedHard && recoveringH1 && stillDownH6 && volumeReturning;
}

function startPumpPortalStream() {
  console.log("🔗 Connecting to PumpPortal WSS...");
  const ws = new WebSocket('wss://pumpportal.fun/api/data');
  ws.on('open', () => {
    console.log("🟢 WSS Connected!");
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });
  ws.on('message', (data: any) => {
    try {
      const token = JSON.parse(data.toString());
      if (token.mint && token.symbol) {
        wssPumpTokensQueue.push({
          tokenAddress: token.mint,
          source: 'pumpfun-new',
          cachedMcap: token.vSolInBondingCurve || 26000,
          cachedName: token.symbol,
          createdAt: Date.now()
        });
      }
    } catch (e) {}
  });
  ws.on('close', () => {
    console.log("🔴 WSS Disconnected. Reconnecting...");
    setTimeout(startPumpPortalStream, 5000);
  });
  ws.on('error', (err: any) => console.error("⚠️ WSS Error:", err.message));
}

// ── Price micro-cache ─────────────────────────────────────────────────────────
// The fast risk loop polls the same handful of tokens every second, and the
// slow loop often asks for the same price moments later. A short TTL collapses
// those into a single upstream call without meaningfully staling the risk
// check, and keeps us well inside Jupiter/pump.fun rate limits.
const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS || '600');
const PRICE_TIMEOUT_MS = Number(process.env.PRICE_TIMEOUT_MS || '2500');
const priceCache = new Map<string, { price: number; mcap: number; at: number }>();

const PRICE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36';

async function getLivePrice(address: string): Promise<{ price: number; mcap: number }> {
  const cached = priceCache.get(address);
  if (cached && Date.now() - cached.at < PRICE_CACHE_TTL_MS) {
    return { price: cached.price, mcap: cached.mcap };
  }

  // Jupiter and pump.fun are fired together rather than in sequence. The old
  // path awaited Jupiter, then pump.fun for the mcap, so a slow Jupiter
  // response was added directly onto stop-loss latency; with every fallback
  // timing out the worst case was 4s + 3s + 4s + 5s = 16 seconds.
  const [jup, pump] = await Promise.allSettled([
    axios.get(`https://api.jup.ag/price/v2?ids=${address}`, { timeout: PRICE_TIMEOUT_MS }),
    axios.get(`https://frontend-api.pump.fun/coins/${address}`, {
      timeout: PRICE_TIMEOUT_MS,
      headers: { 'User-Agent': PRICE_UA },
    }),
  ]);

  const jupPrice = jup.status === 'fulfilled'
    ? parseFloat(jup.value.data?.data?.[address]?.price || '0')
    : 0;
  const pumpData = pump.status === 'fulfilled' ? pump.value.data : null;
  const pumpPrice = parseFloat(pumpData?.price || pumpData?.sol_price || '0');
  const pumpMcap = parseFloat(pumpData?.usd_market_cap || '0');

  // Jupiter is the more reliable price; pump.fun supplies the market cap.
  const price = jupPrice > 0 ? jupPrice : pumpPrice;
  if (price > 0) {
    const out = { price, mcap: pumpMcap > 0 ? pumpMcap : 0 };
    priceCache.set(address, { ...out, at: Date.now() });
    return out;
  }

  // DexScreener only when both primaries gave nothing -- it is the slowest of
  // the three and must never sit in the hot path.
  try {
    const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 5000 });
    const pair = dexRes.data?.pairs?.[0];
    const dexPrice = parseFloat(pair?.priceUsd || '0');
    const dexMcap = parseFloat(pair?.fdv || pair?.marketCap || '0');
    if (dexPrice > 0) {
      const out = { price: dexPrice, mcap: dexMcap };
      priceCache.set(address, { ...out, at: Date.now() });
      return out;
    }
  } catch {}

  return { price: 0, mcap: 0 };
}

/**
 * Take-profit / stop-loss evaluation for a single open position.
 *
 * Extracted out of monitorPositions() so the fast risk loop can own it. This
 * used to run on the same 30s timer as milestone cards and alert tracking,
 * which meant a stop-loss could fire up to 30 seconds late -- and ~29s of
 * that was purely the polling gap, not the chain.
 */
async function evaluateOpenPosition(
  address: string,
  currentPrice: number,
  currentMcap: number,
  now: number
): Promise<void> {
      if (openPositions.has(address)) {
        const pos = openPositions.get(address)!;
        const updated = { ...pos };
        if (currentPrice > pos.peakPrice) updated.peakPrice = currentPrice;

        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const holdingMins = Math.floor((now - pos.entryTime) / 60000);

        const tp = botSettings.takeProfitPct;
        const sl = botSettings.stopLossPct;

        // ── TAKE PROFIT ──
        if (pnlPct >= tp) {
          const pnlSol = pos.sizeSol * (pnlPct / 100);

          // ── Actually sell the position on-chain before treating it as
          // closed — this is the fix for the bug where TP/SL only updated
          // tracking and never sold anything for real. ──
          let sellResult: TradeResult;
          try {
            sellResult = await gateway.sell({
              address,
              ticker: pos.ticker,
              sizeSol: pos.sizeSol,
              slippageBps: botSettings.slippageBps,
              price: currentPrice,
              entryPrice: pos.entryPrice,
              mode: botSettings.tradingMode,
              chatId: CHAT_ID,
            });
          } catch (e: any) {
            sellResult = { success: false, error: e.message, simulated: botSettings.tradingMode === 'DEMO' };
          }

          if (!sellResult.success) {
            console.log(`❌ TP sell failed for ${pos.ticker}, keeping position open to retry next cycle: ${sellResult.error}`);
            return;
          }

          const solUsd = await getSolUsd();
          const rec = alertHistory.get(address);
          try {
            const logoUrl = await getTokenLogoUrl(address);
            const card = await renderExitCard({
              type: 'TP',
              botName: DENGINE_NAME,
              traderName: TRADER_NAME,
              ticker: pos.ticker,
              investedSol: pos.sizeSol,
              investedUsd: pos.sizeSol * solUsd,
              pnlSol,
              pnlUsd: pnlSol * solUsd,
              pnlPct,
              entryMcap: rec?.alertMcap || 0,
              exitMcap: currentMcap,
              heldMinutes: holdingMins,
              logoUrl,
            });
            await bot.telegram.sendPhoto(CHAT_ID, { source: card });
          } catch (e: any) {
            console.log(`⚠️ Failed to send TP card: ${e.message}`);
          }
          // ── Finding 7: persist the exit before mutating in-memory state, so a crash never loses the trade ──
          if (alertHistory.has(address)) {
            setAlert(address, {
              ...rec!,
              exitReason: 'TP',
              exitPrice: currentPrice,
              exitMcap: currentMcap,
              exitTime: Date.now()
            });
            await saveHistory();
          }
          // Record the closed trade for this mode so the P&L chart has real fills.
          await recordExit({
            address,
            mode: botSettings.tradingMode,
            exitPrice: sellResult.fillPrice ?? currentPrice,
            exitType: 'TP',
            pnlPct,
            pnlSol,
            heldMinutes: holdingMins,
            peakPrice: pos.peakPrice,
          });
          openPositions.delete(address);
          console.log(`✅ TP hit + sold: ${pos.ticker} +${pnlPct.toFixed(1)}% — tx: ${sellResult.signature}`);
          return;
        }

        // ── STOP LOSS ──
        if (pnlPct <= -sl) {
          const pnlSol = pos.sizeSol * (pnlPct / 100);
          const peakGainPct = ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100;
          const everPumped = peakGainPct >= 40;

          // ── Actually sell the position on-chain before treating it as
          // closed — same fix as the TP side. This happens regardless of
          // whether the card below gets announced, since the real money
          // needs to be closed either way. ──
          let sellResult: TradeResult;
          try {
            sellResult = await gateway.sell({
              address,
              ticker: pos.ticker,
              sizeSol: pos.sizeSol,
              slippageBps: botSettings.slippageBps,
              price: currentPrice,
              entryPrice: pos.entryPrice,
              mode: botSettings.tradingMode,
              chatId: CHAT_ID,
            });
          } catch (e: any) {
            sellResult = { success: false, error: e.message, simulated: botSettings.tradingMode === 'DEMO' };
          }

          if (!sellResult.success) {
            console.log(`❌ SL sell failed for ${pos.ticker}, keeping position open to retry next cycle: ${sellResult.error}`);
            return;
          }

          const rec = alertHistory.get(address);

          // ── Finding 7: persist the exit before mutating in-memory state, so a crash never loses the trade ──
          if (alertHistory.has(address)) {
            setAlert(address, {
              ...rec!,
              exitReason: 'SL',
              exitPrice: currentPrice,
              exitMcap: currentMcap,
              exitTime: Date.now()
            });
            await saveHistory();
          }
          // Record the closed trade for this mode so the P&L chart has real fills.
          await recordExit({
            address,
            mode: botSettings.tradingMode,
            exitPrice: sellResult.fillPrice ?? currentPrice,
            exitType: 'SL',
            pnlPct,
            pnlSol,
            heldMinutes: holdingMins,
            peakPrice: pos.peakPrice,
          });
          openPositions.delete(address);

          // ── Only announce stop-loss for tokens that never gained real traction.
          // A token that pumped 40%+ first already got milestone cards —
          // a stop-loss card on top of that is noise, not signal. ──
          if (!everPumped) {
            try {
              const solUsd = await getSolUsd();
              const logoUrl = await getTokenLogoUrl(address);
              const card = await renderExitCard({
                type: 'SL',
                botName: DENGINE_NAME,
                traderName: TRADER_NAME,
                ticker: pos.ticker,
                investedSol: pos.sizeSol,
                investedUsd: pos.sizeSol * solUsd,
                pnlSol,
                pnlUsd: pnlSol * solUsd,
                pnlPct,
                entryMcap: rec?.alertMcap || 0,
                exitMcap: currentMcap,
                heldMinutes: holdingMins,
                logoUrl,
              });
              await bot.telegram.sendPhoto(CHAT_ID, { source: card });
            } catch (e: any) {
              console.log(`⚠️ Failed to send SL card: ${e.message}`);
            }
            console.log(`✅ SL hit + sold (announced): ${pos.ticker} ${pnlPct.toFixed(1)}% — tx: ${sellResult.signature}`);
          } else {
            console.log(`✅ SL hit + sold (silent — peaked +${peakGainPct.toFixed(0)}% first): ${pos.ticker} ${pnlPct.toFixed(1)}% — tx: ${sellResult.signature}`);
          }
          return;
        }

        openPositions.set(address, updated);
      }
}

// Guards against a slow cycle overlapping the next tick. Without this a
// 1s interval over a stalled RPC would pile up concurrent sells for the
// same position.
// Loop cadences. RISK_LOOP_MS is the dominant term in stop-loss latency:
// it is how long a position can sit un-checked after a price move. Sub-second
// values are allowed but hit upstream rate limits with several open
// positions -- 1s is the sweet spot.
const RISK_LOOP_MS = Number(process.env.RISK_LOOP_MS || '1000');
const MONITOR_LOOP_MS = Number(process.env.MONITOR_LOOP_MS || '30000');

let riskLoopRunning = false;

/**
 * Fast risk loop: open positions only.
 *
 * Deliberately does NOT touch alertHistory (up to 500 tokens) or render
 * milestone cards -- those stay on the slow 30s loop. Open positions are
 * typically a handful of tokens, which is what makes a ~1s poll affordable
 * without tripping Jupiter/pump.fun rate limits.
 */
async function monitorRisk(): Promise<void> {
  if (riskLoopRunning) return;
  riskLoopRunning = true;
  try {
    const addresses = Array.from(openPositions.keys());
    if (addresses.length === 0) return;
    const now = Date.now();
    await Promise.all(addresses.map(async (address) => {
      try {
        const { price, mcap } = await getLivePrice(address);
        if (!price) return;
        await evaluateOpenPosition(address, price, mcap, now);
      } catch (e: any) {
        console.log(`Risk loop error ${address}: ${e.message}`);
      }
    }));
  } finally {
    riskLoopRunning = false;
  }
}

async function monitorPositions() {
  const now = Date.now();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  const recentAlerts = [...alertHistory.keys()].filter(addr => {
    const rec = alertHistory.get(addr);
    return rec && (now - rec.alertTime) < TWENTY_FOUR_HOURS;
  });

  // Drop pending entries whose alert has aged out of the 24h tracking window
  for (const addr of pendingEntries.keys()) {
    if (!recentAlerts.includes(addr)) pendingEntries.delete(addr);
  }

  const allAddresses = new Set([...openPositions.keys(), ...recentAlerts, ...pendingEntries.keys()]);
  if (allAddresses.size === 0) return;

  await Promise.all(Array.from(allAddresses).map(async (address) => {
    try {
      const { price: currentPrice, mcap: currentMcap } = await getLivePrice(address);
      if (!currentPrice) return;

      if (pendingEntries.has(address) && currentMcap >= botSettings.delayedEntryMcap) {
        const pending = pendingEntries.get(address)!;
        pendingEntries.delete(address);
        if (executor.hasWallet() || botSettings.tradingMode === 'DEMO') {
          try {
            const tradeSol = botSettings.tradeSizeSol;
            const result = await gateway.buy({
              address,
              ticker: pending.ticker,
              sizeSol: tradeSol,
              slippageBps: botSettings.slippageBps,
              price: currentPrice,
              mode: botSettings.tradingMode,
              chatId: CHAT_ID,
            });
            if (result.success && currentPrice > 0) {
              openPositions.set(address, {
                ticker: pending.ticker, address,
                entryPrice: currentPrice,
                peakPrice: currentPrice,
                sizeSol: tradeSol,
                entryTime: now,
                stopLossLevel: 'initial',
                stopLossPct: -35,
                remainingPct: 100,
              });
              await recordEntry({
                address,
                ticker: pending.ticker,
                mode: botSettings.tradingMode,
                entryPrice: result.fillPrice ?? currentPrice,
                sizeSol: tradeSol,
              });
              const txLink = result.signature ? ` — [Solscan](https://solscan.io/tx/${result.signature})` : '';
              await bot.telegram.sendMessage(CHAT_ID, [
                `⏳➡️✅ *DELAYED ENTRY EXECUTED*`, ``,
                `*Token:* $${escapeText(pending.ticker)}`,
                `*Entry:* $${currentPrice.toFixed(8)} — MCAP $${currentMcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
                `*Size:* ${tradeSol} SOL${txLink}`,
              ].join('\n'), { parse_mode: 'Markdown' });
              console.log(`📌 Delayed entry executed: ${pending.ticker} @ $${currentPrice} (mcap $${currentMcap})`);
            } else {
              console.log(`❌ Delayed entry buy failed for ${pending.ticker}: ${result.error || 'unknown error'}`);
            }
          } catch (e: any) {
            console.log(`❌ Delayed entry error for ${pending.ticker}: ${e.message}`);
          }
        }
      }

      if (alertHistory.has(address)) {
        const rec = alertHistory.get(address)!;
        const updated: AlertRecord = { ...rec, currentPrice, currentMcap, lastUpdated: now, milestonesHit: rec.milestonesHit || [] };
        if (currentPrice > rec.peakPrice) {
          updated.peakPrice = currentPrice;
          updated.peakMcap = currentMcap;
          updated.peakTime = now;
          console.log(`📈 New peak ${rec.ticker}: $${currentPrice.toFixed(8)} (+${(((currentPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(1)}%)`);
        }

        // ── Milestone announcements — fire once per threshold, based on peak reached ──
        if (rec.alertPrice > 0) {
          const gainMultiple = updated.peakPrice / rec.alertPrice;
          for (const { multiple } of MILESTONE_THRESHOLDS) {
            if (gainMultiple >= multiple && !updated.milestonesHit.includes(multiple)) {
              updated.milestonesHit = [...updated.milestonesHit, multiple];

              // ── +50% stays plain text — only 2x and above get an image card ──
              if (multiple < 2) {
                try {
                  await bot.telegram.sendMessage(
                    CHAT_ID,
                    `🚀 *$${escapeText(rec.ticker)}* is now \\+50%`,
                    { parse_mode: 'Markdown' }
                  );
                  console.log(`📢 Milestone (text): ${rec.ticker} hit ${multiple}x`);
                } catch (e: any) {
                  console.log(`⚠️ Failed to send milestone text: ${e.message}`);
                }
                continue;
              }

              try {
                const logoUrl = await getTokenLogoUrl(address);
                const card = await renderMilestoneCard({
                  botName: DENGINE_NAME,
                  ticker: rec.ticker,
                  multiple,
                  alertMcap: rec.alertMcap,
                  peakMcap: updated.peakMcap,
                  pnlPct: ((updated.peakPrice - rec.alertPrice) / rec.alertPrice) * 100,
                  heldMinutes: Math.floor((now - rec.alertTime) / 60000),
                  logoUrl,
                });
                await bot.telegram.sendPhoto(CHAT_ID, { source: card });
                console.log(`📢 Milestone (card): ${rec.ticker} hit ${multiple}x`);
              } catch (e: any) {
                console.log(`⚠️ Failed to send milestone card: ${e.message}`);
              }
            }
          }
        }

        setAlert(address, updated);
      }

    } catch (err: any) {
      console.log(`❌ Monitor error ${address}: ${err.message}`);
    }
  }));

  await saveHistory();
}

// ─────────────────────────────────────────────────────────────────────────
// Auto-posted digests — no command needed, fire on their own timers and
// drop into the same chat as everything else. Skip posting if there's
// nothing to show (no calls in the window) rather than send an empty digest.
// ─────────────────────────────────────────────────────────────────────────

function gainMultiple(rec: AlertRecord): number {
  return rec.alertPrice > 0 ? rec.peakPrice / rec.alertPrice : 0;
}

// ── Human-readable date/date-range for the recap cards ──
function formatCardDateLine(windowMs: number): string {
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const end = new Date();
  if (windowMs <= 24 * 60 * 60 * 1000) return fmt(end);
  const start = new Date(Date.now() - windowMs);
  return `${fmt(start)} - ${fmt(end)}`;
}

async function postTopGainers(windowMs: number, title: string): Promise<void> {
  const cutoff = Date.now() - windowMs;
  const inWindow = Array.from(alertHistory.values()).filter(r => r.alertTime >= cutoff && r.alertPrice > 0);
  if (inWindow.length === 0) return;

  // ── Show every token from the window on the card, not just a top-10 slice ──
  const ranked = [...inWindow].sort((a, b) => gainMultiple(b) - gainMultiple(a));
  const hero = ranked[0];

  try {
    const card = await renderRecapCard({
      botName: DENGINE_NAME,
      periodTitle: `Top Gainers — ${title}`,
      dateLine: formatCardDateLine(windowMs),
      heroTicker: hero.ticker,
      heroMultiple: gainMultiple(hero),
      gainers: ranked.map(r => ({ ticker: r.ticker, multiple: gainMultiple(r) })),
      statsLine: `${inWindow.length} calls in this window`,
    });
    await bot.telegram.sendPhoto(CHAT_ID, { source: card });
    console.log(`📢 Posted top gainers digest: ${title}`);
  } catch (e: any) {
    console.log(`⚠️ Failed to post top gainers digest: ${e.message}`);
  }
}

async function postRecap(windowMs: number, periodTitle: string): Promise<void> {
  const cutoff = Date.now() - windowMs;
  const inWindow = Array.from(alertHistory.values()).filter(r => r.alertTime >= cutoff && r.alertPrice > 0);
  if (inWindow.length === 0) return;

  // ── Winner: peaked at +40% or more. Loser: never got above +30%.
  // Anything in between (30-40%) counts as neither. ──
  const wins = inWindow.filter(r => gainMultiple(r) >= 1.4).length;
  const losses = inWindow.filter(r => gainMultiple(r) < 1.3).length;

  // ── Show every token from the window on the card, not just a top-10 slice ──
  const gainersRanked = [...inWindow].sort((a, b) => gainMultiple(b) - gainMultiple(a));
  const hero = gainersRanked[0];
  if (!hero) return;

  try {
    const card = await renderRecapCard({
      botName: DENGINE_NAME,
      periodTitle,
      dateLine: formatCardDateLine(windowMs),
      heroTicker: hero.ticker,
      heroMultiple: gainMultiple(hero),
      gainers: gainersRanked.map(r => ({ ticker: r.ticker, multiple: gainMultiple(r) })),
      statsLine: `${inWindow.length} calls · ${wins} wins · ${losses} losses`,
    });
    await bot.telegram.sendPhoto(CHAT_ID, { source: card });
    console.log(`📢 Posted ${periodTitle}`);
  } catch (e: any) {
    console.log(`⚠️ Failed to post ${periodTitle}: ${e.message}`);
  }
}

// ── Calendar-aligned scheduling — these fire at real clock boundaries
// ── Node's setTimeout silently overflows past ~24.8 days (2^31-1 ms) and
// fires almost immediately instead of erroring — this is exactly what
// caused the monthly recap to spam repeatedly. This wrapper chunks any
// longer delay into safe pieces instead of one raw setTimeout call. ──
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;
function safeSetTimeout(fn: () => void, delayMs: number): void {
  if (delayMs > MAX_SAFE_TIMEOUT_MS) {
    setTimeout(() => safeSetTimeout(fn, delayMs - MAX_SAFE_TIMEOUT_MS), MAX_SAFE_TIMEOUT_MS);
  } else {
    setTimeout(fn, Math.max(delayMs, 0));
  }
}

// (UTC midnight, noon, Sunday midnight), not "24h after the bot last
// restarted" ──
function scheduleDaily(fn: () => void, hourUTC: number): void {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  safeSetTimeout(() => {
    fn();
    setInterval(fn, 24 * 60 * 60 * 1000);
  }, next.getTime() - now.getTime());
}

function scheduleTwiceDaily(fn: () => void): void {
  const now = new Date();
  const candidates = [0, 12].map(h => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0, 0, 0));
    if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  });
  const next = Math.min(...candidates);
  safeSetTimeout(() => {
    fn();
    setInterval(fn, 12 * 60 * 60 * 1000);
  }, next - now.getTime());
}

function scheduleWeekly(fn: () => void, dayOfWeekUTC: number, hourUTC: number): void {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, 0, 0, 0));
  let daysUntil = (dayOfWeekUTC - next.getUTCDay() + 7) % 7;
  if (daysUntil === 0 && next.getTime() <= now.getTime()) daysUntil = 7;
  next.setUTCDate(next.getUTCDate() + daysUntil);
  safeSetTimeout(() => {
    fn();
    setInterval(fn, 7 * 24 * 60 * 60 * 1000);
  }, next.getTime() - now.getTime());
}

// ── Months vary in length, so this recalculates the next 1st-of-month
// boundary each time rather than using a fixed-interval setInterval.
// The gap between months can exceed setTimeout's safe limit (e.g. a
// 31-day July→September gap), so this always goes through safeSetTimeout. ──
function scheduleMonthly(fn: () => void, hourUTC: number): void {
  const runAndReschedule = () => {
    fn();
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, hourUTC, 0, 0, 0));
    safeSetTimeout(runAndReschedule, next.getTime() - now.getTime());
  };
  const now = new Date();
  const firstRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, hourUTC, 0, 0, 0));
  safeSetTimeout(runAndReschedule, firstRun.getTime() - now.getTime());
}

async function scan() {
  console.log("🔍 Scanning pump.fun + PumpSwap + Early Detection + Reversals...");
  try {

    const profilesRes = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 10000 });
    const profiles = profilesRes.data || [];
    const pumpProfiles = profiles
      .filter((p: any) => typeof p.tokenAddress === 'string' && p.tokenAddress.endsWith('pump'))
      .map((p: any) => ({ tokenAddress: p.tokenAddress, source: 'profiles', description: p.description }));

    let pumpSwapProfiles: any[] = [];
    try {
      const pumpSwapRes = await axios.get('https://api.dexscreener.com/latest/dex/pairs/solana/pumpfun', { timeout: 10000 });
      pumpSwapProfiles = (pumpSwapRes.data?.pairs || [])
        .filter((p: any) => p.baseToken?.address && p.chainId === 'solana')
        .map((p: any) => ({ tokenAddress: p.baseToken.address, source: 'pumpswap', cachedPair: p }));
      console.log(`PumpSwap: ${pumpSwapProfiles.length} pairs`);
    } catch (psErr: any) { console.log(`⚠️ PumpSwap failed: ${psErr.message}`); }

    let newPumpTokens: any[] = [];
    try {
      newPumpTokens = [...wssPumpTokensQueue];
      wssPumpTokensQueue.length = 0;
      console.log(`Pump.fun new (via WSS): ${newPumpTokens.length} tokens`);
    } catch (nErr: any) { console.log(`⚠️ WSS queue error: ${nErr.message}`); }

    let newDexPairs: any[] = [];
    try {
      const newPairsRes = await axios.get('https://api.dexscreener.com/latest/dex/search?q=pump.fun&chainIds=solana', { timeout: 10000 });
      newDexPairs = (newPairsRes.data?.pairs || [])
        .filter((p: any) =>
          p.baseToken?.address?.endsWith('pump') &&
          p.chainId === 'solana' &&
          p.pairCreatedAt && (Date.now() - p.pairCreatedAt) < 2 * 60 * 60 * 1000
        )
        .map((p: any) => ({ tokenAddress: p.baseToken.address, source: 'dex-new', cachedPair: p }));
      console.log(`New DEX pairs: ${newDexPairs.length}`);
    } catch (dErr: any) { console.log(`⚠️ New DEX pairs failed: ${dErr.message}`); }

    let reversalTokens: any[] = [];
    try {
      const reversalRes = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana&chainIds=solana', { timeout: 10000 });
      reversalTokens = (reversalRes.data?.pairs || [])
        .filter((p: any) =>
          p.baseToken?.address?.endsWith('pump') &&
          p.chainId === 'solana' &&
          isReversalCandidate(p) &&
          parseFloat(p.fdv || p.marketCap || '0') >= 5000 &&
          parseFloat(p.fdv || p.marketCap || '0') <= 50000
        )
        .map((p: any) => ({ tokenAddress: p.baseToken.address, source: 'reversal', cachedPair: p }));
      console.log(`Reversals: ${reversalTokens.length}`);
    } catch (rErr: any) { console.log(`⚠️ Reversal scan failed: ${rErr.message}`); }

    // ── FIX 2: Prioritize WSS new tokens first before slicing to 40 ──
    const prioritized = [
      ...newPumpTokens,
      ...newDexPairs,
      ...reversalTokens,
      ...pumpSwapProfiles,
      ...pumpProfiles
    ].filter((p, i, arr) => arr.findIndex(x => x.tokenAddress === p.tokenAddress) === i);

    console.log(`Total candidates: ${prioritized.length} across 5 sources`);

    for (const p of prioritized.slice(0, 40)) {
      try {
        if (seenTokens.has(p.tokenAddress)) continue;

        let pair = p.cachedPair || null;
        if (!pair) {
          // ── Finding 9: rate-limit delay only applies to tokens that actually hit the DexScreener API ──
          await new Promise(resolve => setTimeout(resolve, 800));
          try {
            const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`, { timeout: 8000 });
            pair = data?.pairs?.[0];
          } catch {
            markSeen(p.tokenAddress);
            continue;
          }
        }

        let mcap = pair ? parseFloat(pair.fdv || pair.marketCap || '0') : (p.cachedMcap || 0);
        let liquidity = pair ? parseFloat(pair.liquidity?.usd || '0') : 0;
        const ticker = pair?.baseToken?.symbol || p.cachedName || 'UNKNOWN';
        const address = pair?.baseToken?.address || p.tokenAddress;
        const creatorAddress = pair?.info?.deployer || undefined;
        const currentPrice = parseFloat(pair?.priceUsd || '0');

        if (!liquidity && mcap > 0) liquidity = mcap * 0.15;
        if (!mcap) { markSeen(p.tokenAddress); continue; }

        // ── Duplicate-alert fix: seenTokens is a 500-entry FIFO cache that
        // can evict an address well before it's actually done being tracked,
        // letting it re-qualify and get alerted (and spammed to Telegram) a
        // second time. alertHistory is the durable, DB-backed source of
        // truth for "has this token already been alerted" — check that too. ──
        if (alertHistory.has(address)) { markSeen(p.tokenAddress); continue; }

        const isNew = p.source === 'pumpfun-new' || p.source === 'dex-new';
        const isReversal = p.source === 'reversal';
        const mcapMin = isNew ? 5000 : 10000;

        // ── FIX 1: Soft skips do NOT add to seenTokens — token stays eligible for re-scan ──
        if (mcap < mcapMin || mcap > 50000) continue;

        // ── Number 4: Time-alive filter — skip tokens under 7 minutes old (non-WSS only) ──
        if (!isNew && pair?.pairCreatedAt) {
          const ageMinutes = (Date.now() - pair.pairCreatedAt) / 60000;
          if (ageMinutes < 40) {
            console.log(`⏭ ${ticker} too young: ${ageMinutes.toFixed(1)} mins old, skipping`);
            // ── FIX 1: Soft skip — do NOT add to seenTokens ──
            continue;
          }
        }

        const rugProb = computeRugProbability(mcap, liquidity);
        let alphaScore = computeAlphaScore(mcap, liquidity, rugProb);
        const scoreMin = isNew ? 70 : 75;

        // ── Lore bonus: only tokens with an actual profile description
        // (currently just the 'profiles' source) are eligible, and only
        // ones that already pass the free heuristic filter get the AI call ──
        if (p.description && hasLorePotential(p.description)) {
          const loreScore = await scoreLoreWithAI(ticker, p.description);
          if (loreScore >= 70) {
            alphaScore = Math.min(100, alphaScore + 15);
            console.log(`📖 Strong lore detected: ${ticker} (lore score ${loreScore}/100) — +15 alpha boost`);
          }
        }

        console.log(`[${p.source}] ${ticker}: MCAP $${mcap} | Liq $${liquidity} | Score ${alphaScore}/100`);

        // ── FIX 1: Low score is a soft skip — do NOT add to seenTokens ──
        if (alphaScore < scoreMin) continue;

        const signal: TokenSignal = {
          tokenAddress: address, ticker, alphaScore,
          rugProbability: rugProb, liquidityUsd: liquidity, marketCapUsd: mcap,
        };

        const [pattern, risk] = await Promise.all([
          // ── FIX 3: Pass isNew to analyzePattern so new tokens skip LOW_BUYER_VELOCITY gate ──
          intelligence.analyzePattern(signal, creatorAddress, isNew),
          riskEngine.validateExecutionRisk(signal),
        ]);

        if (!pattern.passedPatterns) {
          console.log(`⏭ ${ticker} failed: ${pattern.reason}`);
          markSeen(p.tokenAddress);
          continue;
        }

        const h24 = pair ? parseFloat(pair.priceChange?.h24 || '0') : 0;
        const h1 = pair ? parseFloat(pair.priceChange?.h1 || '0') : 0;

        let executionState = '';
        let executedSizeSol = 0;
        let executedPrice = 0;

        if (!executor.hasWallet() && botSettings.tradingMode !== 'DEMO') {
          executionState = `⚙️ No wallet — use /settings to enable auto\\-buy`;
        } else if (risk.allow) {
          // ── Delayed entry: alert now, but hold the auto-buy until mcap reaches the threshold ──
          if (botSettings.delayedEntryEnabled && mcap < botSettings.delayedEntryMcap) {
            pendingEntries.set(address, { ticker, address });
            executionState = `⏳ Delayed Entry Armed — waiting for $${botSettings.delayedEntryMcap.toLocaleString('en-US')} MCAP \\(currently $${mcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}\\)`;
          } else {
            try {
              const tradeSol = botSettings.tradeSizeSol;
              const result = await gateway.buy({
                address,
                ticker,
                sizeSol: tradeSol,
                slippageBps: botSettings.slippageBps,
                price: currentPrice,
                mode: botSettings.tradingMode,
                chatId: CHAT_ID,
              });
              if (result.success) {
                // A simulated fill has no on-chain tx, so no Solscan link.
                const txLink = result.simulated
                  ? ' — 🧪 _simulated_'
                  : (result.signature ? ` — [Solscan](https://solscan.io/tx/${result.signature})` : '');
                executionState = result.simulated
                  ? `🧪 DEMO Buy Executed${txLink}`
                  : `✅ Auto\\-Buy Executed${txLink}`;
                executedSizeSol = tradeSol;
                // Book the slippage-adjusted simulated fill, not the mid price.
                executedPrice = result.fillPrice ?? currentPrice;
                if (executedPrice > 0) {
                  openPositions.set(address, {
                    ticker, address,
                    entryPrice: executedPrice,
                    peakPrice: executedPrice,
                    sizeSol: executedSizeSol,
                    entryTime: Date.now(),
                    stopLossLevel: 'initial',
                    stopLossPct: -35,
                    remainingPct: 100,
                  });
                  await recordEntry({
                    address,
                    ticker: ticker,
                    mode: botSettings.tradingMode,
                    entryPrice: result.fillPrice ?? currentPrice,
                    sizeSol: tradeSol,
                  });
                  console.log(`📌 Position opened: ${ticker} @ $${executedPrice}`);
                }
              } else {
                executionState = `❌ Auto\\-Buy Failed: ${escapeText(result.error || '')}`;
              }
            } catch (execErr: any) {
              console.log("🔥 AUTO-BUY REJECTION REASON:", JSON.stringify(execErr.response?.data || execErr.message));
              const isNetworkErr = execErr.message?.includes('ENOTFOUND') || execErr.message?.includes('ECONNREFUSED');
              executionState = isNetworkErr
                ? `⏸ Execution Paused: Jupiter unreachable on free tier`
                : `❌ Execution Blocked: ${escapeText(execErr.message)}`;
            }
          }
        } else {
          executionState = `❌ Auto\\-Buy Blocked: ${escapeText(risk.reason || '')}`;
        }

        // ✅ Only set alert record if NOT already tracked — preserve original alertTime
        if (!alertHistory.has(address)) {
          setAlert(address, {
            ticker, address,
            alertTime: Date.now(),
            alertMcap: mcap,
            alertPrice: currentPrice,
            peakMcap: mcap,
            peakPrice: currentPrice,
            peakTime: Date.now(),
            currentMcap: mcap,
            currentPrice,
            lastUpdated: Date.now(),
            milestonesHit: []
          });
          await saveHistory();
        }

        const walletShort = executor.hasWallet()
          ? `${executor.getWalletPublicKey().slice(0, 8)}...${executor.getWalletPublicKey().slice(-4)}`
          : 'Not set — use /settings';
        const sourceLabel: Record<string, string> = {
          'pumpfun-new': '🆕 Pump\\.fun \\(Just Launched\\)',
          'dex-new': '⚡ New DEX Pair',
          'pumpswap': '🔄 PumpSwap',
          'profiles': '📈 Trending',
          'reversal': '🔄 Reversal \\(Retraced & Building\\)'
        };

        const reversalLine = isReversal
          ? [``, `📉 *Reversal Signal:* 24h: ${h24.toFixed(1)}% | 1h: +${h1.toFixed(1)}% recovering`]
          : [];

        const msg = [
          `🚨🚨 *AUTONOMOUS AI DEGEN CALL* 🚨🚨`, ``,
          `*Token:* $${escapeText(ticker)}`,
          `*Address:* \`${address}\``,
          `*Market Cap:* 💰 $${mcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          `*Liquidity:* $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          `*Source:* ${sourceLabel[p.source] || '📈 Trending'}`,
          ...reversalLine, ``,
          `🤖 *Execution State:*`,
          executionState, ``,
          `👾 *Deployer Metrics:*`,
          `• Wallet: \`${walletShort}\``,
          `• Bundled Launch: ${pattern.isBundledLaunch ? '⚠️ Yes' : '✅ No'}`,
          `• Top Holder %: ${pattern.topHolderConcentration}%`,
          `• Liquidity Locked: ${pattern.isLiquidityLocked ? '✅ Yes' : '❌ No'}`,
          `• Wash Trading: ${pattern.washTradingDetected ? '⚠️ Detected' : '✅ Clean'}`,
          `• Unique Buyers: ${pattern.uniqueBuyers} \\(${pattern.buyerVelocity} velocity\\)`,
          `• Smart Money: ${pattern.smartCohortPresence ? '✅ Present' : '➖ None'}`,
          `• Pump\\.fun: ${pattern.isPumpFun ? '✅ Verified' : '✅ Confirmed'}`, ``,
          `📊 *AI Intelligence Matrix:*`,
          `• Alpha Score: 🟢 ${alphaScore}/100 — ${alphaScore === 100 ? '🔥 PERFECT SCORE' : '✅ HIGH CONVICTION'}`,
          `• Rug Probability: 🛡 ${(rugProb * 100).toFixed(0)}%`,
          `• Dev Rug History: ${pattern.devRugHistoryCount} prior rugs`,
          `• Dynamic Mode: ${getDynamicMode(alphaScore)}`, ``,
          `📱 [Monitor Chart Live](https://dexscreener.com/solana/${address})`,
        ].join('\n');

        await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        console.log(`✅ Alert sent: ${ticker} — Score: ${alphaScore}/100 — Source: ${p.source}`);

        markSeen(p.tokenAddress);

      } catch (innerErr: any) {
        console.log(`❌ Error on token: ${innerErr.message}`);
      }
    }

    console.log('⏭️ Robinhood scans disabled (temporarily off in code)');
  } catch (e: any) {
    console.error("Global Scan Error:", e.message);
  }
}

// ✅ Initialize DB schema + load history before launching
async function init() {
  await initDatabaseSchema();

  // Schema (alert_history included) is owned by Prisma migrations, applied by
  // `prisma migrate deploy` on container start — no runtime DDL any more.

  // ✅ Load encrypted wallet + bot settings from DB
  if (CHAT_ID) {
    try {
      const storedKey = await loadDecryptedWallet(CHAT_ID);
      if (storedKey) {
        const keypair = Keypair.fromSecretKey(bs58.decode(storedKey));
        executor.setWallet(keypair);
        console.log(`✅ Wallet loaded from DB: ${keypair.publicKey.toBase58().slice(0, 8)}...`);
      }
    } catch (e: any) {
      console.log(`⚠️ Could not load wallet from DB: ${e.message}`);
    }

    try {
      botSettings = await loadSettings(CHAT_ID);
      console.log(`✅ Settings loaded — size: ${botSettings.tradeSizeSol} SOL | TP: ${botSettings.takeProfitPct}% | SL: ${botSettings.stopLossPct}%`);
    } catch (e: any) {
      console.log(`⚠️ Could not load settings from DB: ${e.message}`);
    }
  }

  await loadHistory();
}

// In polling mode Telegraf starts no HTTP server, but the container
// healthcheck (and Coolify) still expect the port to answer. This tiny server
// fills that gap; in webhook mode Telegraf owns the port instead.
function startHealthServer() {
  http
    .createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    })
    .listen(PORT, () => console.log(`🩺 Health server listening on ${PORT}`));
}

/**
 * Startup.
 *
 * The bookkeeping runs BEFORE the transport starts, for two reasons. It means
 * the bot never accepts an update while settings, wallet and history are still
 * loading — and, critically, Telegraf's launch() in POLLING mode does not
 * resolve until the bot stops. The old `bot.launch(...).then(startup)` shape
 * silently never ran any of this once polling was an option.
 */
async function startBot(): Promise<void> {
  await init();

  startPumpPortalStream();
  // Robinhood Chain temporarily disabled — re-enable by uncommenting the import
  // at the top of this file and restoring this block.
  // if (botSettings.robinhoodEnabled) {
  // startPonsFactoryListener();
  // }

  scan();
  setInterval(scan, 60000);
  // Slow loop: alert tracking, milestone cards, delayed entries.
  setInterval(monitorPositions, MONITOR_LOOP_MS);
  // Fast loop: open-position TP/SL only. The single biggest latency win —
  // stop-loss detection drops from a worst case of ~30s to ~1s.
  setInterval(monitorRisk, RISK_LOOP_MS);

  // Calendar-aligned: 12h digest at 00:00 & 12:00 UTC, daily recap at midnight
  // UTC, weekly on Sunday — not rolling from restart time.
  scheduleTwiceDaily(() => postTopGainers(12 * 60 * 60 * 1000, 'Last 12 Hours'));
  scheduleWeekly(() => postRecap(7 * 24 * 60 * 60 * 1000, 'Weekly Recap'), 0, 0);
  scheduleDaily(() => postRecap(24 * 60 * 60 * 1000, 'Daily Recap'), 0);
  scheduleMonthly(() => postRecap(30 * 24 * 60 * 60 * 1000, 'Monthly Recap'), 0);

  if (BOT_MODE === 'webhook') {
    await bot.launch({ webhook: { domain: DOMAIN, port: PORT } });
    console.log(`🤖 Bot live via webhook on ${DOMAIN} (port ${PORT})`);

    // Keep-alive ping for free tiers that sleep idle services. Pointless
    // without a public URL, so it is webhook-only.
    setInterval(async () => {
      try {
        await axios.get(DOMAIN, { timeout: 5000 });
      } catch {}
    }, 5 * 60 * 1000);
  } else {
    startHealthServer();
    // Long polling opens an outbound connection to Telegram, so it needs no
    // public URL, no TLS and no tunnel. launch() here only settles once the
    // bot stops, so it must NOT be awaited.
    bot.launch({ dropPendingUpdates: true }).catch((err) => {
      console.error('Polling stopped:', err);
      process.exit(1);
    });
    console.log('🤖 Bot live via long polling — no public URL needed');
  }

  console.log(
    `Risk loop ${RISK_LOOP_MS}ms | monitor loop ${MONITOR_LOOP_MS}ms | trading mode ${botSettings.tradingMode}`
  );
}

startBot().catch((err) => {
  console.error('Fatal launch error:', err);
  process.exit(1);
});

bot.command('test', (ctx) => ctx.reply('✅ Bot online. Scanning pump.fun (via WSS) + PumpSwap + Early Detection + Reversals — plus Robinhood Chain (pons launchpad).'));
// ── Mode switching ─────────────────────────────────────────────────────────────
// DEMO and LIVE run the identical pipeline; only the fill differs. See
// src/trading.ts for where the two paths diverge.
bot.command('mode', async (ctx) => {
  const parts = ((ctx.message as any)?.text || '').trim().split(/ +/);
  const arg = (parts[1] || '').toUpperCase();

  if (!arg) {
    const bal = await getDemoBalance(CHAT_ID);
    const detail = botSettings.tradingMode === 'DEMO'
      ? `🧪 Simulated wallet: ${bal.balanceSol.toFixed(4)} SOL (started ${bal.startingBalance} SOL)`
      : '💰 Real wallet — trades execute on-chain.';
    return ctx.reply(`⚙️ Trading mode: ${botSettings.tradingMode}

${detail}

Switch with:  /mode live   |   /mode demo`);
  }

  if (arg !== 'LIVE' && arg !== 'DEMO') {
    return ctx.reply('Usage: /mode live   or   /mode demo');
  }

  // Refuse to arm live trading with no wallet, rather than failing later at
  // the first buy.
  if (arg === 'LIVE' && !executor.hasWallet()) {
    return ctx.reply('⚠️ No wallet loaded — set one via /settings before switching to live.');
  }

  botSettings.tradingMode = arg;
  await saveSetting(CHAT_ID, 'tradingMode', arg);

  if (arg === 'DEMO') {
    const bal = await ensureDemoAccount(CHAT_ID);
    return ctx.reply(`🧪 Switched to DEMO. Simulated balance: ${bal.balanceSol.toFixed(4)} SOL.

Everything runs identically — alerts, entries, TP/SL — but no real SOL moves.`);
  }
  return ctx.reply('💰 Switched to LIVE. Trades will now execute on-chain with real funds.');
});

// ── Demo wallet management ─────────────────────────────────────────────────────
bot.command('demo', async (ctx) => {
  const parts = ((ctx.message as any)?.text || '').trim().split(/ +/);
  const sub = (parts[1] || '').toLowerCase();
  const amount = parseFloat(parts[2]);

  if (!sub || sub === 'status') {
    const bal = await getDemoBalance(CHAT_ID);
    const pnl = bal.balanceSol - bal.startingBalance;
    const pct = bal.startingBalance > 0 ? (pnl / bal.startingBalance) * 100 : 0;
    const open = await prisma.activePosition.count({ where: { mode: 'DEMO', status: 'OPEN' } });
    const closed = await prisma.tradeLog.count({ where: { mode: 'DEMO', status: 'CLOSED' } });
    const sign = pnl >= 0 ? '+' : '';
    return ctx.reply(`🧪 Demo Account

Balance: ${bal.balanceSol.toFixed(4)} SOL
Started: ${bal.startingBalance.toFixed(4)} SOL
P&L: ${sign}${pnl.toFixed(4)} SOL (${sign}${pct.toFixed(2)}%)
Open: ${open}   Closed: ${closed}

/demo add 5 | /demo sub 2 | /demo reset [balance]`);
  }

  if (sub === 'add' || sub === 'sub') {
    if (!isFinite(amount) || amount <= 0) {
      return ctx.reply('Usage: /demo add 5   (a positive number of SOL)');
    }
    const delta = sub === 'add' ? amount : -amount;
    const moved = await adjustDemoBalance(CHAT_ID, delta);
    if (!moved) {
      const bal = await getDemoBalance(CHAT_ID);
      return ctx.reply(`❌ That would overdraw the demo wallet. Balance is ${bal.balanceSol.toFixed(4)} SOL.`);
    }
    const verb = sub === 'add' ? 'Added' : 'Removed';
    return ctx.reply(`✅ ${verb} ${amount} SOL. New balance: ${moved.balanceAfter.toFixed(4)} SOL.`);
  }

  if (sub === 'reset') {
    const start = isFinite(amount) && amount > 0 ? amount : undefined;
    const bal = await resetDemoAccount(CHAT_ID, start);
    return ctx.reply(`♻️ Demo account reset to ${bal.balanceSol.toFixed(4)} SOL. Demo trade history and open demo positions cleared.`);
  }

  return ctx.reply('Usage: /demo [status | add <sol> | sub <sol> | reset [balance]]');
});

// ── Help ──────────────────────────────────────────────────────────────────────
// Sent as plain text on purpose: setting names and env vars are full of
// underscores, and Telegram's Markdown parser reads those as italics markers —
// one unbalanced underscore fails the whole send with a 400.
bot.command('help', async (ctx) => {
  const parts = ((ctx.message as any)?.text || '').trim().split(/ +/);
  const topic = (parts[1] || '').toLowerCase();

  if (!topic) {
    return ctx.reply(helpIndex(botSettings));
  }

  if (topic === 'all') {
    for (const t of TOPICS) {
      const body = helpTopic(t, botSettings);
      if (!body) continue;
      for (const part of chunk(body)) {
        await ctx.reply(part);
      }
    }
    return;
  }

  const body = helpTopic(topic, botSettings);
  if (!body) {
    return ctx.reply(
      'Unknown help topic: ' + topic + '\n\nTry one of: ' + TOPICS.join(', ') + ', all'
    );
  }
  for (const part of chunk(body)) {
    await ctx.reply(part);
  }
});

// ── P&L chart ─────────────────────────────────────────────────────────────────
// Always follows the CURRENT trading mode: in demo you get the demo curve, in
// live the live one. The two never mix, because trades_log rows are tagged by
// mode at write time.
bot.command('chart', async (ctx) => {
  const parts = ((ctx.message as any)?.text || '').trim().split(/ +/);
  const arg = (parts[1] || '').toLowerCase();

  const DAY = 24 * 60 * 60 * 1000;
  const periods: Record<string, [number | undefined, string]> = {
    day: [DAY, 'Last 24 hours'],
    week: [7 * DAY, 'Last 7 days'],
    month: [30 * DAY, 'Last 30 days'],
    all: [undefined, 'All time'],
  };
  const [windowMs, label] = periods[arg] || periods.all;
  const since = windowMs ? Date.now() - windowMs : undefined;

  const mode = botSettings.tradingMode;

  try {
    const trades = await getClosedTrades(mode, since);
    const balanceSol = mode === 'DEMO' ? (await getDemoBalance(CHAT_ID)).balanceSol : undefined;

    const png = await renderPnlChart({ mode, trades, balanceSol, periodLabel: label });
    const total = trades.reduce((a, t) => a + t.pnlSol, 0);
    const arrow = total >= 0 ? '📈' : '📉';

    await ctx.replyWithPhoto(
      { source: png },
      {
        caption:
          arrow + ' ' + mode + ' P&L — ' + label + '  ·  ' + trades.length + ' closed trade(s)' +
          '\n\n/chart day | week | month | all',
      }
    );
  } catch (e: any) {
    console.log(`Chart render failed: ${e.message}`);
    await ctx.reply(`⚠️ Could not render the chart: ${e.message}`);
  }
});

bot.command('positions', async (ctx) => {
  if (openPositions.size === 0 && pendingEntries.size === 0) return ctx.reply('📭 No open positions.');
  const lines = ['📊 *Open Positions:*', ''];
  for (const [address, pos] of openPositions.entries()) {
    const mins = Math.floor((Date.now() - pos.entryTime) / 60000);
    lines.push(`• $${escapeText(pos.ticker)} — ${pos.sizeSol} SOL — ${mins}m held`);
    lines.push(` Entry: $${pos.entryPrice.toFixed(8)}`);
    lines.push(` Peak: $${pos.peakPrice.toFixed(8)}`);
    lines.push(` Stop Loss: -${botSettings.stopLossPct}% | Take Profit: +${botSettings.takeProfitPct}%`);
    lines.push('');
  }
  if (pendingEntries.size > 0) {
    lines.push(`⏳ *Waiting for $${botSettings.delayedEntryMcap.toLocaleString('en-US')} MCAP:*`, '');
    for (const pending of pendingEntries.values()) {
      lines.push(`• $${escapeText(pending.ticker)}`);
    }
    lines.push('');
  }
  ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// ── Helper: build collective PnL token list for a period ──
function getPeriodDateString(period: string): string {
  const today = new Date();
  const formatDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const todayStr = formatDate(today);

  let dateString = '';

  if (period === 'daily') {
    dateString = todayStr;
  } else if (period === 'weekly') {
    const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    dateString = `${formatDate(lastWeek)} - ${todayStr}`;
  } else if (period === 'monthly') {
    const lastMonth = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    dateString = `${formatDate(lastMonth)} - ${todayStr}`;
  } else if (period === 'lifetime') {
    let firstDate = new Date();
    if (alertHistory.size > 0) {
      // Memory-safe loop to find the oldest alert date without exceeding the call stack
      let earliest = Date.now();
      for (const r of alertHistory.values()) {
        if (r.alertTime < earliest) earliest = r.alertTime;
      }
      firstDate = new Date(earliest);
    }
    dateString = `${formatDate(firstDate)} - ${todayStr}`;
  }
  
  // Safely escape the generated string (specifically hyphens) for Telegram Markdown
  return escapeText(dateString);
}

async function buildPeriodPnlMessage(period: string): Promise<{ text: string; buttons: any[] }> {
  const now = Date.now();
  let cutoff: number;
if (period === 'daily') {
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  cutoff = todayUTC.getTime();
} else if (period === 'weekly') {
  cutoff = now - 7 * 24 * 60 * 60 * 1000;
} else if (period === 'monthly') {
  cutoff = now - 30 * 24 * 60 * 60 * 1000;
} else {
  cutoff = 0;
}
  // ── Show every token in the period — only capped at 100, which is
  // Telegram's actual hard limit on inline keyboard buttons, not an
  // arbitrary product limit. ──
  const filtered = Array.from(alertHistory.entries())
    .filter(([, rec]) => rec.alertTime >= cutoff)
    .sort((a, b) => b[1].alertTime - a[1].alertTime)
    .slice(0, 100);

  const periodLabel: Record<string, string> = {
    daily: '📅 Daily', weekly: '📆 Weekly',
    monthly: '🗓 Monthly', lifetime: '🏆 Lifetime'
  };

  const buttons = filtered.map(([address, rec]) => {
    const pnlPct = rec.peakPrice > rec.alertPrice
      ? (((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(1)
      : '0';
    const label = `$${rec.ticker} | Peak: +${pnlPct}%`;
    return [Markup.button.callback(label, `pnl_${address}`)];
  });

  // Add refresh button at the bottom
  buttons.push([Markup.button.callback('🔄 Refresh', `period_${period}`)]);

  const dateInterval = getPeriodDateString(period);

  return {
    text: `📊 *${periodLabel[period]} Calls \\(${dateInterval}\\) \\(${filtered.length} tokens\\):*`,
    buttons
  };
}

// ✅ /pnl — period selector first, then token list
bot.command('pnl', async (ctx) => {
  if (alertHistory.size === 0) {
    return ctx.reply('📭 No alerts recorded yet.');
  }
  await ctx.reply(
    '📊 *Select a time period:*',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📅 Daily', 'period_daily')],
        [Markup.button.callback('📆 Weekly', 'period_weekly')],
        [Markup.button.callback('🗓 Monthly', 'period_monthly')],
        [Markup.button.callback('🏆 Lifetime', 'period_lifetime')],
      ])
    }
  );
});

// ✅ Period selector handler — also handles Refresh button on collective PnL
bot.action(/^period_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Refreshing...");
  const period = ctx.match[1];
  const { text, buttons } = await buildPeriodPnlMessage(period);
  // buttons.length === 1 means only the refresh button, no tokens found
  if (buttons.length <= 1) {
    try { await ctx.editMessageText("📭 No alerts found for the selected period."); } catch {}
    return;
  }
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
  } catch {}
});

bot.command('winrate', async (ctx) => {
  if (alertHistory.size === 0) return ctx.reply('📭 No data to analyze yet.');

  let totalCalls = 0, hitsPeak = 0, hitsStopLoss = 0;
  let totalGainPct = 0, totalLossPct = 0;

  for (const rec of alertHistory.values()) {
    totalCalls++;
    if (rec.peakPrice > rec.alertPrice) {
      hitsPeak++;
      totalGainPct += ((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100;
    }
    if (rec.currentPrice <= (rec.alertPrice * 0.7)) {
      hitsStopLoss++;
      totalLossPct += 30;
    }
  }

  const neutrals = Math.max(0, totalCalls - hitsPeak - hitsStopLoss);
  const hitRate = ((hitsPeak / totalCalls) * 100).toFixed(1);
  const netPnl = totalGainPct - totalLossPct;
  const avgPerTrade = (netPnl / totalCalls).toFixed(1);
  const winRate = totalGainPct + totalLossPct > 0
    ? ((totalGainPct / (totalGainPct + totalLossPct)) * 100).toFixed(1)
    : '0.0';

  const netEmoji = netPnl >= 0 ? '🟢' : '🔴';
  const winEmoji = parseFloat(winRate) >= 50 ? '🟢' : '🔴';
  const avgEmoji = parseFloat(avgPerTrade) >= 0 ? '🟢' : '🔴';

  const lines = [
    `📊 *Bot Performance Summary*`, ``,
    `• *Total Tokens Called:* ${totalCalls}`,
    `• *Pumped Above Entry:* ${hitsPeak}`,
    `• *Hit 30% Stop Loss:* ${hitsStopLoss}`,
    `• *Neutral (no move):* ${neutrals}`,
    `• *Hit Rate:* ${hitsPeak}/${totalCalls} (${hitRate}%)`, ``,
    `💹 *Net Gain:* 🟢 +${totalGainPct.toFixed(1)}%`,
    `🔻 *Net Loss:* 🔴 -${totalLossPct.toFixed(1)}%`,
    `📉 *Net PnL:* ${netEmoji} ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(1)}%`,
    `🎯 *Avg Per Trade:* ${avgEmoji} ${parseFloat(avgPerTrade) >= 0 ? '+' : ''}${avgPerTrade}%`,
    `📈 *Win Rate:* ${winEmoji} ${winRate}%`,
  ];

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// ── Helper: build single token PnL message + buttons ──
async function buildTokenPnlMessage(address: string): Promise<{ text: string; buttons: any[] } | null> {
  const rec = alertHistory.get(address);
  if (!rec) return null;

  const alertDate = new Date(rec.alertTime).toUTCString();
  const peakDate = new Date(rec.peakTime).toUTCString();
  const peakPnlPct = rec.peakPrice > 0 && rec.alertPrice > 0
    ? ((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100 : 0;
  const currentPnlPct = rec.currentPrice > 0 && rec.alertPrice > 0
    ? ((rec.currentPrice - rec.alertPrice) / rec.alertPrice) * 100 : 0;
  const peakMcapGain = rec.alertMcap > 0
    ? ((rec.peakMcap - rec.alertMcap) / rec.alertMcap) * 100 : 0;
  const neverPumped = rec.peakPrice <= rec.alertPrice;

  const lines = [
    `📊 *PnL Report: $${escapeText(rec.ticker)}*`, ``,
    `*Address:* \`${address}\``,
    `*Alerted:* ${escapeText(alertDate)}`, ``,
    `*MCAP at Alert:* $${rec.alertMcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `*Price at Alert:* $${rec.alertPrice.toFixed(8)}`, ``,
  ];

  if (neverPumped) {
    lines.push(`❌ *Did not pump above alert price*`);
    lines.push(`*Current Price:* $${rec.currentPrice.toFixed(8)}`);
    lines.push(`*Current PnL:* 🔴 ${currentPnlPct.toFixed(2)}%`);
  } else {
    lines.push(`🚀 *Peak Performance:*`);
    lines.push(`• Peak Price: $${rec.peakPrice.toFixed(8)}`);
    lines.push(`• Peak MCAP: $${rec.peakMcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
    lines.push(`• Peak Gain: 🟢 +${peakPnlPct.toFixed(2)}%`);
    lines.push(`• MCAP Gain: +${peakMcapGain.toFixed(1)}%`);
    lines.push(`• Peak Time: ${escapeText(peakDate)}`);
    lines.push(``);
    lines.push(`📍 *Current:*`);
    lines.push(`• Price: $${rec.currentPrice.toFixed(8)}`);
    lines.push(`• PnL vs Alert: ${currentPnlPct >= 0 ? '🟢 +' : '🔴 '}${currentPnlPct.toFixed(2)}%`);
  }

  lines.push(``);
  lines.push(`📱 [Monitor Chart Live](https://dexscreener.com/solana/${address})`);

  const buttons = [
    [Markup.button.callback('🔄 Refresh', `refresh_pnl_${address}`)]
  ];

  return { text: lines.join('\n'), buttons };
}

bot.action(/^pnl_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  const result = await buildTokenPnlMessage(address);
  if (!result) return ctx.answerCbQuery('Token not found in history.');
  await ctx.answerCbQuery();

  await ctx.reply(result.text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(result.buttons)
  });

  // ── Also send a peak/stop-loss card — same text report as always, this
  // just adds the visual on top of it ──
  const rec = alertHistory.get(address);
  if (rec && rec.alertPrice > 0) {
    const peakPct = ((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100;
    try {
      const logoUrl = await getTokenLogoUrl(address);
      const card = await renderCallResultCard({
        botName: DENGINE_NAME,
        ticker: rec.ticker,
        alertMcap: rec.alertMcap,
        peakMcap: rec.peakMcap,
        peakPct,
        multiple: rec.peakPrice / rec.alertPrice,
        neverPumped: peakPct < 30,
        logoUrl,
      });
      await bot.telegram.sendPhoto(ctx.chat!.id, { source: card });
    } catch (e: any) {
      console.log(`⚠️ Failed to send PnL card: ${e.message}`);
    }
  }
});

// ✅ Refresh handler for individual token PnL
bot.action(/^refresh_pnl_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery('Refreshing...');

  // Fetch latest price before rebuilding
  try {
    const { price: currentPrice, mcap: currentMcap } = await getLivePrice(address);
    if (currentPrice && alertHistory.has(address)) {
      const rec = alertHistory.get(address)!;
      const updated = { ...rec, currentPrice, currentMcap, lastUpdated: Date.now() };
      if (currentPrice > rec.peakPrice) {
        updated.peakPrice = currentPrice;
        updated.peakMcap = currentMcap;
        updated.peakTime = Date.now();
      }
      setAlert(address, updated);
      await saveHistory();
    }
  } catch {}

  const result = await buildTokenPnlMessage(address);
  if (!result) return;

  await ctx.editMessageText(result.text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(result.buttons)
  });
});

// ✅ /report — exports full trade history as a downloadable CSV
bot.command('report', async (ctx) => {
  if (alertHistory.size === 0) return ctx.reply('📭 No trade history to export.');

  const headers = 'Ticker,Address,Alert Time,Alert MCAP,Alert Price,Peak MCAP,Peak Price,Peak Gain %,Current Price,Current PnL %,Exit Reason,Exit Price,Exit MCAP,Exit Time\n';

  const rows = Array.from(alertHistory.values())
    .sort((a, b) => b.alertTime - a.alertTime)
    .map(rec => {
      const peakGain = rec.alertPrice > 0
        ? (((rec.peakPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(2)
        : '0';
      const currentPnl = rec.alertPrice > 0
        ? (((rec.currentPrice - rec.alertPrice) / rec.alertPrice) * 100).toFixed(2)
        : '0';
      const alertDate = new Date(rec.alertTime).toUTCString();
      const exitReason = rec.exitReason || 'OPEN';
      const exitPrice = rec.exitPrice ? rec.exitPrice.toFixed(8) : '-';
      const exitMcap = rec.exitMcap ? rec.exitMcap.toFixed(0) : '-';
      const exitTime = rec.exitTime ? new Date(rec.exitTime).toUTCString() : '-';
      return `${rec.ticker},${rec.address},"${alertDate}",${rec.alertMcap.toFixed(0)},${rec.alertPrice.toFixed(8)},${rec.peakMcap.toFixed(0)},${rec.peakPrice.toFixed(8)},${peakGain}%,${rec.currentPrice.toFixed(8)},${currentPnl}%,${exitReason},${exitPrice},${exitMcap},"${exitTime}"`;
    })
    .join('\n');

  const csv = headers + rows;
  const buffer = Buffer.from(csv, 'utf-8');

  await ctx.replyWithDocument({
    source: buffer,
    filename: `alpha-report-${new Date().toISOString().slice(0, 10)}.csv`
  });
  console.log(`📤 Report exported: ${alertHistory.size} trades`);
});

async function getWalletBalanceDisplay(): Promise<string> {
  if (!executor.hasWallet()) return 'Not configured';

  try {
    const publicKey = executor.getWalletPublicKey();
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || process.env.QUICKNODE_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    const balanceLamports = await connection.getBalance(new PublicKey(publicKey));
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    const formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
    return `${formatter.format(balanceSol)} SOL`;
  } catch (e: any) {
    console.log(`⚠️ Could not fetch wallet balance: ${e.message}`);
    return 'Unavailable';
  }
}

// ── Helper: build settings panel message + keyboard ──
async function buildSettingsMessage() {
  const walletPublicKey = executor.hasWallet() ? executor.getWalletPublicKey() : null;
  const walletLine = walletPublicKey
    ? `🟢 *Wallet:* \`${walletPublicKey.slice(0, 8)}...${walletPublicKey.slice(-4)}\``
    : `🔴 *Wallet:* Not configured — auto\\-buy is disabled`;
  const balanceDisplay = await getWalletBalanceDisplay();

  const text = [
    `⚙️ *Bot Settings*`, ``,
    walletLine,
    `💵 *Balance:* ${balanceDisplay}`,
    `💰 *Trade Size:* ${botSettings.tradeSizeSol} SOL per trade`,
    `🎯 *Take Profit:* +${botSettings.takeProfitPct}%`,
    `🛑 *Stop Loss:* \\-${botSettings.stopLossPct}%`,
    `⏳ *Delayed Entry:* ${botSettings.delayedEntryEnabled ? '✅ ON' : '❌ OFF'} — buy held until $${botSettings.delayedEntryMcap.toLocaleString('en-US')} MCAP`,
    `🪙 *Robinhood:* ${botSettings.robinhoodEnabled ? '✅ ON' : '❌ OFF'} — launchpad scans and listeners are ${botSettings.robinhoodEnabled ? 'active' : 'disabled'}`,
    `📉 *Slippage Tolerance:* ${(botSettings.slippageBps / 100).toFixed(1)}% — tighter reduces sandwich exposure, wider reduces failed trades`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Set Wallet Private Key', 'set_wallet_key')],
    [Markup.button.callback('💰 Set Trade Size (SOL)', 'set_trade_size')],
    [Markup.button.callback('🎯 Set Take Profit %', 'set_tp')],
    [Markup.button.callback('🛑 Set Stop Loss %', 'set_sl')],
    [Markup.button.callback('📉 Set Slippage %', 'set_slippage')],
    [Markup.button.callback(
      botSettings.delayedEntryEnabled ? '⏳ Delayed Entry: ON (tap to disable)' : '⏳ Delayed Entry: OFF (tap to enable)',
      'toggle_delayed_entry'
    )],
    [Markup.button.callback(
      botSettings.robinhoodEnabled ? '🪙 Robinhood: ON (tap to disable)' : '🪙 Robinhood: OFF (tap to enable)',
      'toggle_robinhood'
    )],
    [Markup.button.callback('🎯 Set Delayed Entry MCAP', 'set_delayed_entry_mcap')],
  ]);

  return { text, keyboard };
}

// ── /settings ──
bot.command('settings', async (ctx) => {
  const { text, keyboard } = await buildSettingsMessage();
  await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
});

// ── Finding 8: /cancel aborts a pending settings prompt ──
bot.command('cancel', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  if (!awaitingInput.has(chatId)) {
    return ctx.reply('Nothing to cancel.');
  }
  clearAwaiting(chatId);
  await ctx.reply('❌ Cancelled.');
});

// ── Toggle delayed entry: alert immediately, hold the auto-buy until $15k MCAP ──
bot.action('toggle_delayed_entry', async (ctx) => {
  await ctx.answerCbQuery();
  botSettings.delayedEntryEnabled = !botSettings.delayedEntryEnabled;
  await saveSetting(ctx.chat!.id.toString(), 'delayedEntryEnabled', botSettings.delayedEntryEnabled);
  const { text, keyboard } = await buildSettingsMessage();
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('toggle_robinhood', async (ctx) => {
  await ctx.answerCbQuery('Robinhood Chain is temporarily disabled in code right now.');
});

// ── Callbacks: each button puts the chat into an awaiting state ──
bot.action('set_wallet_key', async (ctx) => {
  await ctx.answerCbQuery();
  setAwaiting(ctx.chat!.id.toString(), 'privateKey');
  await ctx.reply(
    `🔑 *Paste your Solana wallet private key* \\(base58\\) in the next message\\.\n\n` +
    `⚠️ Your message will be deleted immediately after processing\\.\n` +
    `🔒 The key is encrypted with AES\\-256\\-GCM before storage — never plain text\\.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('set_trade_size', async (ctx) => {
  await ctx.answerCbQuery();
  setAwaiting(ctx.chat!.id.toString(), 'tradeSize');
  await ctx.reply(
    `💰 *Enter trade size in SOL*\n\nExample: \`0.15\` or \`0.5\`\n\nCurrent: *${botSettings.tradeSizeSol} SOL*`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('set_tp', async (ctx) => {
  await ctx.answerCbQuery();
  setAwaiting(ctx.chat!.id.toString(), 'tp');
  await ctx.reply(
    `🎯 *Enter Take Profit percentage*\n\nExample: \`50\` closes the trade at \\+50%\n\nCurrent: *${botSettings.takeProfitPct}%*`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('set_sl', async (ctx) => {
  await ctx.answerCbQuery();
  setAwaiting(ctx.chat!.id.toString(), 'sl');
  await ctx.reply(
    `🛑 *Enter Stop Loss percentage*\n\nExample: \`35\` closes the trade if it drops \\-35% from entry\n\nCurrent: *${botSettings.stopLossPct}%*`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('set_slippage', async (ctx) => {
  await ctx.answerCbQuery();
  setAwaiting(ctx.chat!.id.toString(), 'slippage');
  await ctx.reply(
    `📉 *Enter slippage tolerance as a percentage*\n\nExample: \`5\` allows up to 5% price movement before the trade is rejected \\(tighter = less MEV/sandwich exposure, but more failed trades on fast\\-moving tokens\\)\n\nCurrent: *${(botSettings.slippageBps / 100).toFixed(1)}%*`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('set_delayed_entry_mcap', async (ctx) => {
  await ctx.answerCbQuery();
  setAwaiting(ctx.chat!.id.toString(), 'delayedEntryMcap');
  await ctx.reply(
    `🎯 *Enter the MCAP \\(in USD\\) the auto\\-buy should wait for*\n\nExample: \`15000\`\n\nCurrent: *$${botSettings.delayedEntryMcap.toLocaleString('en-US')}*`,
    { parse_mode: 'Markdown' }
  );
});

// ── Text handler: routes input to the correct setting ──
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const waiting = awaitingInput.get(chatId);
  if (!waiting) return;

  clearAwaiting(chatId);
  const input = ctx.message.text.trim();

  if (waiting === 'privateKey') {
    try { await ctx.deleteMessage(); } catch {}
    try {
      const keyBytes = bs58.decode(input);
      if (keyBytes.length !== 64) throw new Error(`Expected 64-byte key, got ${keyBytes.length}`);
      const keypair = Keypair.fromSecretKey(keyBytes);
      const publicKey = keypair.publicKey.toBase58();
      await saveEncryptedWallet(chatId, input);
      executor.setWallet(keypair);
      await ctx.reply(
        `✅ *Wallet Set*\n\n*Public Key:* \`${publicKey}\`\n\nAuto\\-buy is now enabled\\.`,
        { parse_mode: 'Markdown' }
      );
      console.log(`✅ Wallet set via /settings: ${publicKey.slice(0, 8)}...`);
    } catch (e: any) {
      await ctx.reply(`❌ *Invalid private key*\n\n${escapeText(e.message)}\n\nTry again with /settings`, { parse_mode: 'Markdown' });
    }
    return;
  }

  const value = parseFloat(input);
  if (isNaN(value) || value <= 0) {
    await ctx.reply(`❌ Invalid value — enter a positive number\\.`, { parse_mode: 'Markdown' });
    return;
  }

  if (waiting === 'tradeSize') {
    if (value > 10) {
      await ctx.reply(`❌ Trade size capped at 10 SOL for safety\\.`, { parse_mode: 'Markdown' });
      return;
    }
    botSettings.tradeSizeSol = value;
    await saveSetting(chatId, 'tradeSizeSol', value);
    await ctx.reply(`✅ *Trade size set to ${value} SOL per trade*`, { parse_mode: 'Markdown' });
  } else if (waiting === 'tp') {
    if (value > 1000) {
      await ctx.reply(`❌ Take profit capped at 1000%\\.`, { parse_mode: 'Markdown' });
      return;
    }
    botSettings.takeProfitPct = value;
    await saveSetting(chatId, 'takeProfitPct', value);
    await ctx.reply(`✅ *Take profit set to +${value}%*`, { parse_mode: 'Markdown' });
  } else if (waiting === 'sl') {
    if (value > 100) {
      await ctx.reply(`❌ Stop loss capped at 100%\\.`, { parse_mode: 'Markdown' });
      return;
    }
    botSettings.stopLossPct = value;
    await saveSetting(chatId, 'stopLossPct', value);
    await ctx.reply(`✅ *Stop loss set to \\-${value}%*`, { parse_mode: 'Markdown' });
  } else if (waiting === 'delayedEntryMcap') {
    if (value > 26000) {
      await ctx.reply(`❌ MCAP capped at $26,000 — the scanner never alerts tokens above that, so a higher wait target would never trigger\\.`, { parse_mode: 'Markdown' });
      return;
    }
    botSettings.delayedEntryMcap = value;
    await saveSetting(chatId, 'delayedEntryMcap', value);
    await ctx.reply(`✅ *Delayed entry MCAP set to $${value.toLocaleString('en-US')}*`, { parse_mode: 'Markdown' });
  } else if (waiting === 'slippage') {
    if (value > 50) {
      await ctx.reply(`❌ Slippage capped at 50% for safety\\.`, { parse_mode: 'Markdown' });
      return;
    }
    const bps = Math.round(value * 100);
    botSettings.slippageBps = bps;
    await saveSetting(chatId, 'slippageBps', bps);
    await ctx.reply(`✅ *Slippage tolerance set to ${value}%*`, { parse_mode: 'Markdown' });
  }
});

// ✅ Heartbeat — console only, NOT Telegram
setInterval(() => {
  console.log('⏱️ Heartbeat: Bot is awake and monitoring the market...');
}, 15 * 60 * 1000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
