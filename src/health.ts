import * as fs from 'fs';
import * as path from 'path';
import { prisma } from './db';

/**
 * Database liveness and persistence reporting.
 *
 * "Is the database live?" has two different answers and only one of them is
 * obvious. Connecting is easy to check and rarely the problem. The failure
 * that actually costs you money is a database that connects perfectly and is
 * silently recreated on every deploy, because DATABASE_URL points somewhere
 * that is not the mounted volume. Trades, settings and the encrypted wallet
 * all vanish, and nothing logs an error because nothing went wrong from
 * SQLite's point of view.
 *
 * The boot counter below is what settles it. If the count keeps climbing and
 * firstBootAt stays fixed across redeploys, the volume is persisting. If the
 * count resets to 1 every deploy, it is not.
 */

const KEY_BOOT_COUNT = 'boot_count';
const KEY_FIRST_BOOT = 'first_boot_at';

export interface BootInfo {
  bootCount: number;
  firstBootAt: number;
  /** True when this is the very first boot against this database file. */
  isFirstBoot: boolean;
}

async function getState(key: string): Promise<string | null> {
  const row = await prisma.appState.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function setState(key: string, value: string): Promise<void> {
  await prisma.appState.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/** Called once at startup. Increments the boot counter and stamps first boot. */
export async function recordBoot(): Promise<BootInfo> {
  const now = Date.now();

  const existingFirst = await getState(KEY_FIRST_BOOT);
  const isFirstBoot = existingFirst === null;
  const firstBootAt = isFirstBoot ? now : Number(existingFirst) || now;
  if (isFirstBoot) await setState(KEY_FIRST_BOOT, String(now));

  const prev = Number(await getState(KEY_BOOT_COUNT)) || 0;
  const bootCount = prev + 1;
  await setState(KEY_BOOT_COUNT, String(bootCount));

  return { bootCount, firstBootAt, isFirstBoot };
}

/** Absolute path of the SQLite file, or null if not a file: URL. */
export function resolveDbPath(): string | null {
  const url = process.env.DATABASE_URL || '';
  if (!url.startsWith('file:')) return null;
  const raw = url.slice('file:'.length).split('?')[0].replace(/^"|"$/g, '');
  return path.resolve(process.cwd(), raw);
}

export interface DbHealth {
  ok: boolean;
  path: string | null;
  exists: boolean;
  sizeBytes: number;
  journalMode: string;
  /** True when the file sits on a path that looks like a mounted volume. */
  looksMounted: boolean;
  bootCount: number;
  firstBootAt: number;
  openPositions: number;
  pendingEntries: number;
  closedTradesDemo: number;
  closedTradesLive: number;
  alertsTracked: number;
  writeOk: boolean;
  error?: string;
}

export async function getDbHealth(): Promise<DbHealth> {
  const dbPath = resolveDbPath();

  const health: DbHealth = {
    ok: false,
    path: dbPath,
    exists: false,
    sizeBytes: 0,
    journalMode: '?',
    // In a container the database must live on a mounted volume. A path under
    // the app directory is the classic mistake -- it works until the first
    // redeploy, then everything is gone.
    looksMounted: !!dbPath && !dbPath.replace(/\\/g, '/').includes('/app/dist'),
    bootCount: 0,
    firstBootAt: 0,
    openPositions: 0,
    pendingEntries: 0,
    closedTradesDemo: 0,
    closedTradesLive: 0,
    alertsTracked: 0,
    writeOk: false,
  };

  try {
    if (dbPath && fs.existsSync(dbPath)) {
      health.exists = true;
      health.sizeBytes = fs.statSync(dbPath).size;
    }

    const jm = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode;');
    health.journalMode = jm?.[0]?.journal_mode ?? '?';

    health.bootCount = Number(await getState(KEY_BOOT_COUNT)) || 0;
    health.firstBootAt = Number(await getState(KEY_FIRST_BOOT)) || 0;

    const [open, pending, demo, live, alerts] = await Promise.all([
      prisma.activePosition.count({ where: { status: 'OPEN' } }),
      prisma.activePosition.count({ where: { status: 'PENDING' } }),
      prisma.tradeLog.count({ where: { mode: 'DEMO', status: 'CLOSED' } }),
      prisma.tradeLog.count({ where: { mode: 'LIVE', status: 'CLOSED' } }),
      prisma.alertHistory.count(),
    ]);
    health.openPositions = open;
    health.pendingEntries = pending;
    health.closedTradesDemo = demo;
    health.closedTradesLive = live;
    health.alertsTracked = alerts;

    // Prove writes actually land, not just that reads work. A read-only mount
    // or a full disk both present as a perfectly healthy-looking connection
    // until the first trade needs saving.
    await setState('health_probe', String(Date.now()));
    health.writeOk = true;

    health.ok = true;
  } catch (e: any) {
    health.error = e.message;
  }

  return health;
}

function ago(ms: number): string {
  if (!ms) return 'unknown';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Plain-text report for /status. No Markdown: paths contain underscores. */
export function formatDbHealth(h: DbHealth): string {
  if (!h.ok) {
    return [
      'DATABASE: NOT WORKING',
      '',
      'Error: ' + (h.error || 'unknown'),
      'Path:  ' + (h.path || '(not a file database)'),
    ].join('\n');
  }

  const lines: string[] = [
    'DATABASE',
    '',
    'Status      connected, ' + (h.writeOk ? 'reads and writes OK' : 'READ ONLY - writes failing'),
    'File        ' + (h.path || '?'),
    'Size        ' + formatSize(h.sizeBytes) + (h.exists ? '' : '  (file not found!)'),
    'Mode        ' + h.journalMode + (h.journalMode === 'wal' ? '' : '  (expected wal)'),
    '',
    'PERSISTENCE',
    '',
    'Started     ' + h.bootCount + (h.bootCount === 1 ? ' time' : ' times'),
    'First seen  ' + ago(h.firstBootAt),
  ];

  // The actual answer to "is my data safe across deploys".
  if (h.bootCount <= 1) {
    lines.push(
      '',
      'This is the first boot against this database, so persistence is not',
      'proven yet. Redeploy and run /status again: if it still says 1, the',
      'volume is NOT mounted and every deploy is wiping your data.'
    );
  } else {
    lines.push(
      '',
      'Data is surviving restarts. The database has been reused across ' +
      h.bootCount + ' starts,',
      'so the volume is mounted correctly.'
    );
  }

  lines.push(
    '',
    'CONTENTS',
    '',
    'Open positions   ' + h.openPositions,
    'Pending entries  ' + h.pendingEntries,
    'Closed trades    ' + h.closedTradesDemo + ' demo, ' + h.closedTradesLive + ' live',
    'Alerts tracked   ' + h.alertsTracked
  );

  return lines.join('\n');
}
