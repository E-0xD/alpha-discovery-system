import axios from 'axios';
import * as crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────
// Lore/story-strength scoring — some tokens have a genuine, specific,
// shareable narrative (real people, real events, a distinct concept)
// instead of generic copy-paste PvP-relaunch language. That's a real
// signal worth boosting, but judging it is a language task, not something
// a keyword list can do reliably. Two-stage approach: a free heuristic
// filters out anything too short/empty to even be a real story, THEN an
// AI call judges only the survivors — keeps API usage cheap and bounded.
//
// History: this originally hard-coded `llama-3.3-70b-versatile`, which Groq
// retired. Every call returned 404 model_not_found, the catch block returned
// 0, and the +15 alpha boost silently never fired — for every call from the
// day GROQ_API_KEY was set. The failure modes below are now reported loudly,
// once, instead of disappearing into a per-call log line.
// ─────────────────────────────────────────────────────────────────────────

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Verified against the live Groq API on 2026-09-15 with this exact prompt:
 * a specific, real-feeling story scored 85–95 and generic "1000x gem" copy
 * scored 0–5. That wide separation matters because the boost threshold is
 * 70. `openai/gpt-oss-120b` scored the same strong story 68 — it would have
 * failed the exact case this exists to catch.
 *
 * Override with GROQ_MODEL. Check what your key can use with:
 *   GET https://api.groq.com/openai/v1/models
 */
export const DEFAULT_LORE_MODEL = 'qwen/qwen3.8-27b';

export function loreModel(): string {
  return (process.env.GROQ_MODEL || '').trim() || DEFAULT_LORE_MODEL;
}

/**
 * Reasoning models spend output tokens thinking before they answer. The old
 * `max_tokens: 10` with a reasoning model returns EMPTY content with
 * finish_reason=length — parseInt('') is NaN, NaN became 0, and the boost
 * silently never fires again with a different model. Verified live: a
 * drop-in swap to gpt-oss-20b at max_tokens 10 did exactly that.
 *
 * So output headroom is generous (you only pay for tokens actually used —
 * qwen with reasoning off answers in 2–3), and reasoning is dialled down per
 * model family using the values verified to be accepted.
 */
const MAX_OUTPUT_TOKENS = 300;

function reasoningParams(model: string): Record<string, string> {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low' };
  if (model.startsWith('qwen/')) return { reasoning_effort: 'none' };
  return {};
}

// ── Free-tier budget ──────────────────────────────────────────────────────
// Groq's free tier allows 1,000 requests/day per model (read from the
// x-ratelimit-* headers on this account, 2026-09-15). The scanner runs every
// 60s and a token that fails to alert is soft-skipped rather than marked
// seen, so without a cache the SAME token's story is re-scored every minute
// for as long as it stays in the candidate list — enough to exhaust the daily
// allowance by mid-day and switch lore scoring off until the reset.
//
// A token's description does not change minute to minute, so its score is
// cached. The key includes a hash of the description, so an edited story is
// re-scored. Only successful scores are cached: a transient failure retries.
const LORE_CACHE_TTL_MS = Number(process.env.LORE_CACHE_TTL_MS || String(24 * 60 * 60 * 1000));
const LORE_CACHE_MAX = 5000;
const loreCache = new Map<string, { score: number; at: number }>();

function cacheKey(ticker: string, description: string, address?: string): string {
  const digest = crypto.createHash('sha1').update(description).digest('hex').slice(0, 16);
  return (address || ticker) + ':' + digest;
}

function cacheGet(key: string): number | null {
  const hit = loreCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > LORE_CACHE_TTL_MS) {
    loreCache.delete(key);
    return null;
  }
  return hit.score;
}

function cacheSet(key: string, score: number): void {
  // Map preserves insertion order, so the first key is the oldest.
  if (loreCache.size >= LORE_CACHE_MAX) {
    const oldest = loreCache.keys().next().value;
    if (oldest !== undefined) loreCache.delete(oldest);
  }
  loreCache.set(key, { score, at: Date.now() });
}

// When the daily allowance runs out, every further call is a guaranteed 429.
// Pause instead of hammering the API, and say so once per pause rather than
// once per scan.
let pausedUntil = 0;

/**
 * Groq reports resets as compound durations ("1m26.4s", "2h3m", "292ms");
 * Retry-After is plain seconds. Returns milliseconds, or null.
 */
export function parseGroqDuration(value: unknown): number | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
  }
  return matched ? Math.round(total) : null;
}

const stats = { calls: 0, cacheHits: 0, rateLimited: 0 };
export function loreStats() {
  return { ...stats, cached: loreCache.size, pausedUntil };
}

export function hasLorePotential(description: string | undefined): boolean {
  if (!description) return false;
  const trimmed = description.trim();
  if (trimmed.length < 60) return false; // too short to be a real story
  const wordCount = trimmed.split(/\s+/).length;
  return wordCount >= 12;
}

/**
 * First integer 0–100 in the reply, or null. Tolerates models that wrap the
 * number ("Score: 72", "72/100") — the old parseInt only worked when the
 * reply started with a digit.
 */
export function parseLoreScore(text: unknown): number | null {
  const m = String(text ?? '').match(/\b(\d{1,3})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

// Configuration problems (retired model, bad key) repeat on every scan. Log
// them once, prominently, rather than once a minute where they become noise
// nobody reads — which is how the retired model went unnoticed.
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.log('');
  console.log('⚠️⚠️ LORE SCORING DISABLED: ' + message);
  console.log('   The +15 alpha boost will not fire until this is fixed.');
  console.log('');
}

export async function scoreLoreWithAI(
  ticker: string,
  description: string,
  opts: { address?: string } = {}
): Promise<number> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return 0;

  const key = cacheKey(ticker, description, opts.address);
  const cached = cacheGet(key);
  if (cached !== null) {
    stats.cacheHits++;
    return cached;
  }

  // Rate-limited: don't spend a request that is certain to be refused.
  if (Date.now() < pausedUntil) return 0;

  const model = loreModel();

  try {
    stats.calls++;
    const res = await axios.post(
      GROQ_URL,
      {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...reasoningParams(model),
        messages: [{
          role: 'user',
          content: `Rate how compelling and shareable this crypto token's story/lore is, on a scale of 0-100. A high score means a genuine, specific, unique narrative (real people, real events, a distinct concept) that could realistically go viral. A low score means generic, vague, templated, or copy-paste marketing language with no real story.\n\nToken: $${ticker}\nDescription: "${description}"\n\nRespond with ONLY a number from 0 to 100, nothing else.`,
        }],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );

    const choice = res.data?.choices?.[0];
    const score = parseLoreScore(choice?.message?.content);
    if (score === null) {
      warnOnce(
        'unparseable:' + model,
        `${model} returned no usable score (finish_reason=${choice?.finish_reason}). ` +
        `If finish_reason is "length", the model is spending its output on reasoning — ` +
        `pick a different GROQ_MODEL.`
      );
      return 0;
    }
    cacheSet(key, score);
    return score;
  } catch (e: any) {
    const status = e.response?.status;
    const code = e.response?.data?.error?.code;
    const headers = e.response?.headers || {};

    if (status === 429) {
      stats.rateLimited++;
      const wait =
        parseGroqDuration(headers['retry-after']) ??
        parseGroqDuration(headers['x-ratelimit-reset-requests']) ??
        60_000;
      // Clamp: never hammer (min 5s), never go dark for most of a day on a
      // malformed header (max 6h).
      const pauseMs = Math.min(Math.max(wait, 5_000), 6 * 60 * 60 * 1000);
      const wasPaused = Date.now() < pausedUntil;
      pausedUntil = Date.now() + pauseMs;
      if (!wasPaused) {
        console.log(
          `⏸ Groq free-tier limit reached — lore scoring paused until ` +
          `${new Date(pausedUntil).toISOString()}. Tokens keep scanning; the boost just won't apply meanwhile.`
        );
      }
    } else if (status === 404 || code === 'model_not_found') {
      warnOnce(
        'model:' + model,
        `Groq model "${model}" does not exist or this key cannot use it. ` +
        `Set GROQ_MODEL to one listed by GET https://api.groq.com/openai/v1/models`
      );
    } else if (status === 401 || status === 403) {
      warnOnce('auth', `GROQ_API_KEY was rejected (HTTP ${status}). Check or regenerate it.`);
    } else {
      // Transient (timeout, 5xx): worth a line per occurrence.
      console.log(`⚠️ Lore scoring failed for ${ticker}: ${e.message}`);
    }
    return 0;
  }
}
