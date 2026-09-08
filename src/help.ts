import { BotSettings } from './settings';

/**
 * /help content.
 *
 * Deliberately PLAIN TEXT — no parse_mode. Setting names and env vars are full
 * of underscores, which Telegram's Markdown parser treats as italics markers;
 * a single unbalanced one makes the whole send fail with a 400. Escaping every
 * one of them would be unreadable in source and easy to break later.
 *
 * Telegram caps a message at 4096 characters, so /help is split into topics
 * rather than one wall of text. `chunk()` is a backstop in case a topic grows
 * past the limit.
 */

export const TOPICS = ['commands', 'modes', 'settings', 'trading', 'speed', 'data', 'env'] as const;
export type Topic = (typeof TOPICS)[number];

const TELEGRAM_LIMIT = 4000; // a little under 4096 for safety

/** Split on paragraph boundaries so a topic never truncates mid-sentence. */
export function chunk(text: string): string[] {
  if (text.length <= TELEGRAM_LIMIT) return [text];
  const out: string[] = [];
  let cur = '';
  for (const para of text.split('\n\n')) {
    if ((cur + '\n\n' + para).length > TELEGRAM_LIMIT && cur) {
      out.push(cur);
      cur = para;
    } else {
      cur = cur ? cur + '\n\n' + para : para;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function helpIndex(s: BotSettings): string {
  return [
    'ALPHA DISCOVERY BOT — HELP',
    '',
    'Currently in ' + s.tradingMode + ' mode.',
    s.tradingMode === 'DEMO'
      ? 'No real money moves. Fills are simulated with realistic slippage and fees.'
      : 'REAL MONEY. Trades execute on-chain against your wallet.',
    '',
    'Pick a topic:',
    '',
    '  /help commands   every command, what it does',
    '  /help modes      demo vs live, and how demo stays honest',
    '  /help settings   every setting and what it changes',
    '  /help trading    what it buys, and when it sells',
    '  /help speed      how fast stop-loss actually reacts',
    '  /help data       where your data lives, backups',
    '  /help env        environment variables (server config)',
    '',
    '  /help all        send all of the above',
    '',
    'Quick start: /mode to check demo vs live, /settings to set size and',
    'TP/SL, /positions for what is open, /chart for your P&L curve.',
  ].join('\n');
}

function commands(): string {
  return [
    'COMMANDS',
    '',
    '/test',
    '  Confirms the bot is alive and lists which scanners are running.',
    '',
    '/mode',
    '  Shows the current trading mode. /mode demo or /mode live to switch.',
    '  Switching to live is refused if no wallet is loaded, rather than',
    '  failing later at the first buy.',
    '',
    '/demo',
    '  Simulated wallet status: balance, starting balance, P&L, open and',
    '  closed counts.',
    '    /demo add 5        credit 5 SOL to the simulated wallet',
    '    /demo sub 2        debit 2 SOL',
    '    /demo reset        wipe back to the starting balance',
    '    /demo reset 25     wipe and set the starting balance to 25 SOL',
    '  reset also clears demo trade history and open demo positions, so the',
    '  chart always reconciles against the balance.',
    '',
    '/chart',
    '  Cumulative P&L curve as an image, for whichever mode is active.',
    '  Demo and live never mix.',
    '    /chart day | week | month | all   (default: all)',
    '',
    '/positions',
    '  Open positions and any delayed entries waiting on their trigger.',
    '',
    '/pnl',
    '  Performance of the ALERTS (how the signals did), by period. This is',
    '  signal quality, not your wallet — use /chart for your own P&L.',
    '',
    '/winrate',
    '  Hit rate across tracked alerts.',
    '',
    '/report',
    '  CSV export of alert history.',
    '',
    '/settings',
    '  Interactive menu: trade size, take profit, stop loss, slippage,',
    '  delayed entry, and wallet setup.',
    '',
    '/cancel',
    '  Aborts whatever input the bot is currently waiting for.',
    '',
    '/help',
    '  This.',
  ].join('\n');
}

function modes(): string {
  return [
    'DEMO vs LIVE',
    '',
    'Both modes run the SAME code. Scanning, filtering, alerts, entry logic,',
    'take-profit, stop-loss, position tracking and logging are identical.',
    'The only difference is the final step: live signs and broadcasts a',
    'transaction, demo debits a simulated balance.',
    '',
    'That is deliberate. If demo took a shortcut anywhere else, its results',
    'would not predict live results, which would make it worse than useless.',
    '',
    'DEMO IS NOT FRICTIONLESS',
    '',
    'Simulated fills charge you slippage in the direction that hurts — you',
    'buy above mid and sell below it — plus a per-trade fee. A +50% move on',
    'a 1 SOL position returns about +1.455 SOL, not +1.50.',
    '',
    'This matters: on thin memecoin pools slippage is often the entire',
    'difference between an edge and no edge. A demo that filled at mid price',
    'would make almost any strategy look profitable.',
    '',
    'Tune with DEMO_SLIPPAGE_BPS (default 150 = 1.5% each way) and',
    'DEMO_FEE_SOL (default 0.00035). Setting them to zero is lying to',
    'yourself.',
    '',
    'OTHER DIFFERENCES',
    '',
    '  - Demo needs no wallet at all.',
    '  - Demo fills get a DEMO- prefixed reference and no Solscan link,',
    '    so they can never be mistaken for real trades.',
    '  - A fresh install starts in DEMO. Real buys never fire until you',
    '    explicitly run /mode live.',
    '  - Demo balance is adjustable (/demo add, /demo sub). Live balance is',
    '    whatever is actually in your wallet.',
  ].join('\n');
}

function settings(s: BotSettings): string {
  return [
    'SETTINGS  (change via /settings)',
    '',
    'Trade size — currently ' + s.tradeSizeSol + ' SOL',
    '  How much SOL goes into each position. Applies to demo and live',
    '  identically.',
    '',
    'Take profit — currently +' + s.takeProfitPct + '%',
    '  Sells the whole position once it is this far above entry. Checked',
    '  roughly once a second.',
    '',
    'Stop loss — currently -' + s.stopLossPct + '%',
    '  Sells once the position falls this far below entry. Same cadence.',
    '',
    'Slippage — currently ' + s.slippageBps + ' bps (' + (s.slippageBps / 100) + '%)',
    '  Maximum price movement tolerated when swapping. Too low and buys',
    '  fail on fast movers; too high and you get filled at a bad price.',
    '  1000 bps = 10%.',
    '',
    'Delayed entry — currently ' + (s.delayedEntryEnabled ? 'ON' : 'OFF'),
    '  When on, an alert does not buy immediately. The token is watched and',
    '  bought only if it reaches the market cap below. Useful for avoiding',
    '  the first spike, at the cost of missing tokens that never come back.',
    '',
    'Delayed entry market cap — currently $' + s.delayedEntryMcap.toLocaleString('en-US'),
    '  The trigger for the above. Ignored when delayed entry is off.',
    '',
    'Trading mode — currently ' + s.tradingMode,
    '  DEMO or LIVE. See /help modes. Changed with /mode, not /settings.',
    '',
    'Robinhood chain — currently ' + (s.robinhoodEnabled ? 'ON' : 'OFF'),
    '  The pons launchpad listener. Currently disabled in code regardless',
    '  of this flag.',
    '',
    'Settings persist in the database and survive restarts and redeploys',
    '(as long as the data volume is mounted).',
  ].join('\n');
}

function trading(): string {
  return [
    'WHAT IT BUYS, AND WHEN IT SELLS',
    '',
    'DISCOVERY',
    '  Live pump.fun stream plus periodic scans. A candidate must be:',
    '    - market cap between $5,000 and $50,000',
    '    - at least 40 minutes old (filters the instant-rug window)',
    '',
    'SCORING',
    '  Each candidate gets an alpha score and a rug probability from',
    '  on-chain signals: holder distribution, deployer history, bundled',
    '  launch detection, buyer velocity, liquidity depth.',
    '',
    'RISK GATE  (all must pass, or no buy)',
    '    - market cap between $1,000 and $70,000',
    '    - alpha score at least 70',
    '    - rug probability at most 30%',
    '    - liquidity at least $6,000',
    '',
    'ENTRY',
    '  Buys immediately at your configured trade size — or, with delayed',
    '  entry on, waits for the market cap trigger first.',
    '',
    'EXIT',
    '  Whichever comes first:',
    '    - take profit hit, sells the whole position',
    '    - stop loss hit, sells the whole position',
    '  Open positions are checked about once a second. A failed sell keeps',
    '  the position open and retries on the next cycle, rather than marking',
    '  it closed while you still hold the bag.',
    '',
    'ALERTS ARE NOT TRADES',
    '  Alerts are tracked for every token that passes discovery, whether or',
    '  not it was bought. /pnl and /winrate describe alert quality. /chart',
    '  describes your actual money.',
  ].join('\n');
}

function speed(): string {
  return [
    'EXECUTION SPEED',
    '',
    'Stop-loss reaction is about 1 second from the price moving to the sell',
    'being submitted, and typically another 0.4 to 2 seconds for the chain',
    'to confirm.',
    '',
    'It used to be up to 30 seconds, because open positions were checked on',
    'the same 30-second timer as milestone cards and alert tracking. That',
    'polling gap, not the blockchain, was almost all of the delay.',
    '',
    'How it works now:',
    '  - a fast loop (1s) checks ONLY open positions, usually a handful',
    '  - a slow loop (30s) handles alerts, milestones and delayed entries',
    '  - price sources are queried in parallel, not one after another',
    '  - a re-entrancy guard stops a slow cycle from firing duplicate sells',
    '',
    'Tunable with RISK_LOOP_MS (default 1000). Going below ~500ms starts',
    'tripping upstream rate limits once several positions are open, which',
    'makes things slower, not faster.',
    '',
    'SUB-MILLISECOND IS NOT POSSIBLE',
    '  Solana produces a block roughly every 400ms, and network round-trip',
    '  to any RPC is several milliseconds at best. Nothing trading on-chain',
    '  fills in under a millisecond. The chain was always the fastest part',
    '  of this system; the polling gap was the slow part, and that is what',
    '  got fixed.',
    '',
    'The largest remaining gain would be pre-signing exit transactions so a',
    'trigger only has to broadcast. Not done yet — a stale pre-signed sell',
    'can execute the wrong size, so it needs care.',
  ].join('\n');
}

function data(): string {
  return [
    'YOUR DATA',
    '',
    'Everything lives in one SQLite file: settings, encrypted wallet, alert',
    'history, positions, trade log and the demo ledger.',
    '',
    'IN DOCKER THIS MUST BE ON A MOUNTED VOLUME. If DATABASE_URL points',
    'anywhere else, every redeploy silently wipes all of it.',
    '',
    'The trade log tags every row with its mode, which is what keeps the',
    'demo and live charts completely separate.',
    '',
    'The demo balance is written together with its ledger entry in one',
    'transaction, so the two can never disagree, and the demo curve can be',
    'rebuilt from the ledger if a balance is ever corrupted.',
    '',
    'YOUR WALLET KEY',
    '  Stored encrypted with AES-256-GCM under WALLET_ENCRYPTION_KEY. If',
    '  that key is not set it is derived from the bot token — which means',
    '  rotating the bot token would make the stored wallet permanently',
    '  undecryptable. Set it explicitly and back it up.',
    '',
    'BACKUPS',
    '  Copy the database with sqlite3 .backup, not a plain file copy — WAL',
    '  mode means a naive copy can miss recent writes. See DEPLOY.md.',
  ].join('\n');
}

function env(): string {
  return [
    'ENVIRONMENT VARIABLES  (server config, not changeable from Telegram)',
    '',
    'REQUIRED',
    '  TELEGRAM_BOT_TOKEN     from @BotFather',
    '  TELEGRAM_CHAT_ID       from @userinfobot',
    '  DATABASE_URL           file:/data/bot.db in Docker, on the volume',
    '',
    'TRANSPORT',
    '  BOT_MODE               polling or webhook. Auto-picks webhook when a',
    '                         public URL is set, otherwise polling.',
    '  PUBLIC_URL             public HTTPS origin, webhook mode only.',
    '                         WEBHOOK_URL and APP_URL also accepted.',
    '  PORT                   default 10000',
    '',
    '  Polling needs no public URL, no TLS and no tunnel — it connects out',
    '  to Telegram. Best for local use. Webhook is better on a real server.',
    '',
    'TRADING',
    '  WALLET_PRIVATE_KEY     base58, Phantom export format. Live only.',
    '  WALLET_ENCRYPTION_KEY  64 hex chars. Generate with npm run setup.',
    '  QUICKNODE_RPC_URL      paid RPC strongly recommended',
    '  SOLANA_RPC_URL         fallback',
    '  HELIUS_API_KEY         on-chain holder and deployer analysis',
    '',
    'DEMO',
    '  DEMO_STARTING_BALANCE_SOL   default 10',
    '  DEMO_SLIPPAGE_BPS           default 150 (1.5% each way)',
    '  DEMO_FEE_SOL                default 0.00035',
    '',
    'SPEED',
    '  RISK_LOOP_MS           default 1000, TP/SL check cadence',
    '  MONITOR_LOOP_MS        default 30000, alerts and milestones',
    '  PRICE_CACHE_TTL_MS     default 600',
    '  PRICE_TIMEOUT_MS       default 2500',
    '',
    'OTHER',
    '  PNL_CLASSIC_COLORS     true for green/red charts instead of the',
    '                         colourblind-safe blue/orange default',
    '  REDIS_URL              optional cache; blank is correct for one',
    '                         container',
    '  PRISMA_DEBUG           true logs every SQL query',
    '',
    'Note: PUMPPORTAL_API_KEY is NOT used — the stream is the public',
    'unauthenticated feed.',
  ].join('\n');
}

export function helpTopic(topic: string, s: BotSettings): string | null {
  switch (topic) {
    case 'commands': return commands();
    case 'modes':    return modes();
    case 'settings': return settings(s);
    case 'trading':  return trading();
    case 'speed':    return speed();
    case 'data':     return data();
    case 'env':      return env();
    default:         return null;
  }
}
