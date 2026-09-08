#!/usr/bin/env node
/**
 * One-command bootstrap: `npm run setup`
 *
 * Idempotent by design — safe to run repeatedly. It:
 *   1. creates .env from .env.example if missing
 *   2. generates WALLET_ENCRYPTION_KEY if (and only if) it is blank
 *   3. creates the SQLite directory
 *   4. generates the Prisma client and applies migrations
 *   5. reports which required settings are still missing
 *
 * The key generation NEVER overwrites an existing key. That key decrypts the
 * wallet stored in the database, so regenerating it would permanently orphan
 * those funds.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

const ok = (m) => console.log('  ok    ' + m);
const info = (m) => console.log('  ..    ' + m);
const warn = (m) => console.log('  WARN  ' + m);
const bad = (m) => console.log('  MISS  ' + m);

let missing = 0;

console.log('\nSetting up the bot\n');

// ── 1. .env ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(ENV_PATH)) {
  if (fs.existsSync(EXAMPLE_PATH)) {
    fs.copyFileSync(EXAMPLE_PATH, ENV_PATH);
    ok('created .env from .env.example');
  } else {
    fs.writeFileSync(ENV_PATH, '');
    ok('created empty .env');
  }
} else {
  ok('.env present');
}

require('dotenv').config({ path: ENV_PATH });

/** Set or replace a single key in .env, preserving every other line. */
function writeEnvValue(key, value) {
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const lines = raw.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim().startsWith(key + '='));
  if (idx >= 0) lines[idx] = key + '=' + value;
  else lines.push(key + '=' + value);
  fs.writeFileSync(ENV_PATH, lines.join('\n'));
  process.env[key] = value;
}

// ── 2. Encryption key ────────────────────────────────────────────────────────
const existingKey = (process.env.WALLET_ENCRYPTION_KEY || '').trim();
if (existingKey.length === 64) {
  ok('WALLET_ENCRYPTION_KEY already set (left untouched)');
} else if (existingKey.length > 0) {
  // Wrong length is worse than blank: aes-256-gcm needs exactly 32 bytes, so
  // this would throw at the first wallet operation.
  warn('WALLET_ENCRYPTION_KEY is set but is not 64 hex chars — refusing to');
  warn('replace it in case a wallet was encrypted with it. Fix it by hand.');
} else {
  writeEnvValue('WALLET_ENCRYPTION_KEY', crypto.randomBytes(32).toString('hex'));
  ok('generated WALLET_ENCRYPTION_KEY (32 bytes) and wrote it to .env');
  info('back this up — losing it orphans any wallet stored in the database');
}

// ── 3. SQLite directory ──────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  writeEnvValue('DATABASE_URL', '"file:./data/bot.db"');
  ok('DATABASE_URL defaulted to file:./data/bot.db');
}
const dbUrl = (process.env.DATABASE_URL || '').replace(/^"|"$/g, '');
if (dbUrl.startsWith('file:')) {
  const dbFile = dbUrl.slice('file:'.length).split('?')[0];
  const dir = path.dirname(path.resolve(ROOT, dbFile));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ok('created ' + dir);
  } else {
    ok('database directory exists');
  }
}

// ── 4. Prisma ────────────────────────────────────────────────────────────────
// Invoke Prisma's JS entry point with the current node binary rather than
// shelling out to `npx`. On Windows the npx shim is a .cmd, and Node 20+
// refuses to execFile .cmd/.bat without a shell (EINVAL); going through a
// shell instead would mean quoting paths that contain spaces. This sidesteps
// both and is faster, since npx does no resolution work.
const PRISMA_BIN = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');

function prisma(args) {
  if (!fs.existsSync(PRISMA_BIN)) {
    throw new Error(
      'Prisma CLI not found at ' + PRISMA_BIN + '\nRun `npm install` first.'
    );
  }
  execFileSync(process.execPath, [PRISMA_BIN, ...args], { cwd: ROOT, stdio: 'pipe' });
}

try {
  info('generating Prisma client...');
  prisma(['generate']);
  ok('Prisma client generated');
} catch (e) {
  console.error('\nFAILED: prisma generate\n' + (e.stdout || e.message || '').toString());
  process.exit(1);
}

try {
  info('applying migrations...');
  prisma(['migrate', 'deploy']);
  ok('migrations applied');
} catch (e) {
  console.error('\nFAILED: prisma migrate deploy\n' + (e.stdout || e.message || '').toString());
  process.exit(1);
}

// ── 5. Required settings ─────────────────────────────────────────────────────
console.log('\nRequired settings\n');

const req = [
  ['TELEGRAM_BOT_TOKEN', 'from @BotFather'],
  ['TELEGRAM_CHAT_ID', 'from @userinfobot'],
];
for (const [key, hint] of req) {
  if ((process.env[key] || '').trim()) ok(key);
  else { bad(key + ' — ' + hint); missing++; }
}

const publicUrl =
  process.env.PUBLIC_URL || process.env.APP_URL || process.env.WEBHOOK_URL || '';
if (publicUrl.trim()) {
  ok('PUBLIC_URL -> ' + publicUrl);
  if (!publicUrl.startsWith('https://')) {
    warn('Telegram requires HTTPS for webhooks — this will be rejected');
  }
} else {
  bad('PUBLIC_URL — public HTTPS origin for the Telegram webhook');
  missing++;
}

// ── Optional, but worth knowing about ────────────────────────────────────────
console.log('\nOptional\n');

const wallet = (process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_WALLET_PRIVATE_KEY || '').trim();
if (wallet) ok('wallet configured — LIVE mode available');
else info('no wallet — DEMO mode only (which needs none)');

const rpc = (process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL || '').trim();
if (rpc) ok('RPC configured');
else warn('no RPC — falls back to the public endpoint, which is heavily rate limited');

if ((process.env.REDIS_URL || '').trim()) ok('Redis configured');
else info('no Redis — running on SQLite alone (correct for one container)');

// ── Result ───────────────────────────────────────────────────────────────────
console.log('');
if (missing > 0) {
  console.log(`Not ready: ${missing} required setting(s) missing. Fill them in .env, then re-run.`);
  process.exit(1);
}

console.log('Ready. Start the bot with:  npm run dev');
if (publicUrl.includes('ngrok')) {
  const host = publicUrl.replace(/^https?:\/\//, '');
  console.log('Make sure the tunnel is up first:');
  console.log(`  ngrok http ${process.env.PORT || 10000} --domain=${host}`);
}
console.log('');
