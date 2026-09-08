import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// ── SQLite location ───────────────────────────────────────────────────────────
// Default is a file under ./data so a bare `npm start` works with no config.
// In Docker/Coolify this is overridden to a path on a mounted volume
// (file:/data/bot.db) — see DEPLOY.md. Getting that wrong is the one mistake
// that silently loses every trade on redeploy, so the resolved path is logged
// at startup.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./data/bot.db?connection_limit=1';
}

/**
 * Make sure the directory holding the SQLite file exists.
 *
 * SQLite creates the database file but NOT its parent directory, so pointing
 * DATABASE_URL at a path whose directory is missing (a volume mounted at
 * /app/data when the image only created /data, say) fails at startup with an
 * opaque error. Creating it here means any mount path works.
 */
function ensureSqliteDir(): void {
  const url = process.env.DATABASE_URL || '';
  if (!url.startsWith('file:')) return;
  const filePath = url.slice('file:'.length).split('?')[0];
  if (!filePath) return;
  const dir = path.dirname(path.resolve(filePath));
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created SQLite directory ${dir}`);
    }
  } catch (err: any) {
    console.error(`Could not create SQLite directory ${dir}: ${err.message}`);
  }
}

ensureSqliteDir();

export const prisma = new PrismaClient({
  log: process.env.PRISMA_DEBUG === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

/**
 * SQLite defaults are wrong for this workload. The bot writes from several
 * timers at once (risk loop, scanner, digests), and stock SQLite serialises
 * readers against a writer and fails instantly on contention.
 *
 *   journal_mode=WAL  — readers no longer block on the writer, which matters
 *                       because the risk loop must never stall behind a slow
 *                       digest write.
 *   busy_timeout      — wait for a held lock instead of throwing SQLITE_BUSY.
 *   synchronous=NORMAL— fsync per checkpoint rather than per commit. Safe under
 *                       WAL (survives process crash; a host power-cut could lose
 *                       the last commits, an acceptable trade for a bot that
 *                       reconciles open positions from chain state on restart).
 */
async function applyPragmas(): Promise<void> {
  // $queryRawUnsafe, NOT $executeRawUnsafe: several PRAGMA assignments echo
  // the new value back as a result row, and Prisma's execute path rejects any
  // statement that returns rows on SQLite ("Execute returned results, which is
  // not allowed in SQLite"). queryRaw tolerates both rows and no rows.
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
  await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
}

/**
 * Replaces the old raw-SQL CREATE TABLE bootstrap. The schema itself is now
 * owned by Prisma migrations (`prisma migrate deploy`, run on container start);
 * this only applies connection pragmas and seeds the demo wallet.
 */
export async function initDatabaseSchema(): Promise<void> {
  try {
    await applyPragmas();

    const url = process.env.DATABASE_URL || '(unset)';
    const mode = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode;');
    console.log(`⚡ SQLite ready — ${url} (journal_mode=${mode?.[0]?.journal_mode ?? '?'})`);
  } catch (err) {
    console.error('❌ Database initialization failure:', err);
    throw err;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Backwards-compatibility shim.
//
// The old module exported a pg Pool as `db` and call sites used
// `db.query(sql, params)`. Everything in src/ has been migrated to Prisma, but
// this keeps any straggler (or a cherry-picked upstream patch that still uses
// raw SQL) from failing at runtime. Postgres-style $1/$2 placeholders are
// rewritten to SQLite's ? form.
export const db = {
  async query<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[] }> {
    const sqliteSql = sql.replace(/\$(\d+)/g, '?');
    const trimmed = sqliteSql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.includes('RETURNING')) {
      const rows = await prisma.$queryRawUnsafe<T[]>(sqliteSql, ...params);
      return { rows };
    }
    await prisma.$executeRawUnsafe(sqliteSql, ...params);
    return { rows: [] };
  },
};
