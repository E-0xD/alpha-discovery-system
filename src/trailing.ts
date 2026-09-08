/**
 * Trailing stop ladder.
 *
 * As a position runs up, the stop ratchets behind it:
 *
 *     peak +70%   ->  stop at break even (0%)
 *     peak +100%  ->  stop at +70%
 *     peak +150%  ->  stop at +100%
 *     peak +200%  ->  stop at +150%
 *     ... and onward in 50-point steps (+250% -> +200%, etc.)
 *
 * Two properties matter and are enforced here rather than at the call site:
 *
 *   1. It is driven by PEAK profit, not current profit. A position that hit
 *      +160% and fell back to +90% keeps its +100% stop and exits there. If it
 *      tracked current profit the stop would slide back down and the whole
 *      mechanism would do nothing.
 *
 *   2. It only ever moves UP. The stored level is passed back in and the
 *      higher of the two wins, so a bad price tick cannot loosen a stop that
 *      is already locked in.
 */

export interface LadderRung {
  /** Peak profit % that arms this rung. */
  atProfitPct: number;
  /** Stop level, as % relative to entry. 0 = break even. */
  stopAtPct: number;
}

export const DEFAULT_LADDER: LadderRung[] = [
  { atProfitPct: 70, stopAtPct: 0 },
  { atProfitPct: 100, stopAtPct: 70 },
  { atProfitPct: 150, stopAtPct: 100 },
  { atProfitPct: 200, stopAtPct: 150 },
];

/** Above the last rung the pattern continues: every +50% of peak lifts the
 *  stop by 50, staying 50 points behind. */
const STEP_PCT = 50;

/**
 * Stop level for a given peak profit, or null when no rung is armed yet
 * (the position is still under the first threshold, so the base stop loss
 * applies instead).
 */
export function ladderStopFor(
  peakProfitPct: number,
  ladder: LadderRung[] = DEFAULT_LADDER,
  maxProfitPct?: number
): number | null {
  if (!ladder.length) return null;

  // The ladder climbs only up to the configured ceiling (default 5x = +400%).
  // Clamping the PEAK used for rung lookup, rather than clamping the resulting
  // stop, keeps every armed rung at its documented level -- clamping the stop
  // would produce levels that appear nowhere in the ladder (a 2x ceiling would
  // turn the +100% rung's "+70%" into "+50%").
  const effectivePeak =
    typeof maxProfitPct === 'number' ? Math.min(peakProfitPct, maxProfitPct) : peakProfitPct;
  peakProfitPct = effectivePeak;

  const last = ladder[ladder.length - 1];

  if (peakProfitPct >= last.atProfitPct + STEP_PCT) {
    // Extrapolate beyond the table in whole steps, so +263% arms the +250%
    // rung (stop +200%) rather than an odd fractional level.
    const stepsPast = Math.floor((peakProfitPct - last.atProfitPct) / STEP_PCT);
    return last.stopAtPct + stepsPast * STEP_PCT;
  }

  let armed: number | null = null;
  for (const rung of ladder) {
    if (peakProfitPct >= rung.atProfitPct) armed = rung.stopAtPct;
  }
  return armed;
}

export interface TrailingDecision {
  /** Stop level now in force, as % relative to entry. */
  stopPct: number;
  /** True when the ladder is driving the stop rather than the base stop loss. */
  laddered: boolean;
  /** True when the position should be closed now. */
  shouldExit: boolean;
  /** Why, for logging and the exit card. */
  reason: 'TRAIL' | 'SL' | 'NONE';
  /** True when the exit fired inside the anticipation band rather than after
   *  the level was already breached. */
  anticipated: boolean;
}

/**
 * Decide whether a trailing position should close.
 *
 * `anticipationPct` exists because the risk loop samples about once a second,
 * and price can gap straight through a stop between samples — you intend to
 * exit at +70% and actually fill at +58%. Firing as soon as price enters a
 * small band above the stop means the realised exit lands much closer to the
 * intended number. It cannot eliminate a true gap, but it removes the routine
 * overshoot.
 *
 * The band is deliberately narrow: too wide and normal noise closes winners
 * early, which costs more than the overshoot it prevents.
 */
export function evaluateTrailing(opts: {
  currentProfitPct: number;
  peakProfitPct: number;
  /** Base stop loss as a positive number, e.g. 35 meaning -35%. */
  baseStopLossPct: number;
  /** Previously stored ladder level, so the stop can only ratchet up. */
  storedStopPct?: number | null;
  anticipationPct?: number;
  ladder?: LadderRung[];
  /** Ceiling the ladder climbs to, as profit %. 400 = 5x. */
  maxProfitPct?: number;
}): TrailingDecision {
  const anticipation = opts.anticipationPct ?? 2;

  const fromLadder = ladderStopFor(opts.peakProfitPct, opts.ladder, opts.maxProfitPct);

  // Ratchet: never below what is already locked in.
  let laddered = false;
  let stopPct: number;
  if (fromLadder !== null || opts.storedStopPct != null) {
    const best = Math.max(
      fromLadder ?? Number.NEGATIVE_INFINITY,
      opts.storedStopPct ?? Number.NEGATIVE_INFINITY
    );
    stopPct = best;
    laddered = true;
  } else {
    stopPct = -Math.abs(opts.baseStopLossPct);
  }

  const breached = opts.currentProfitPct <= stopPct;
  const withinBand = !breached && opts.currentProfitPct <= stopPct + anticipation;

  return {
    stopPct,
    laddered,
    shouldExit: breached || withinBand,
    reason: breached || withinBand ? (laddered ? 'TRAIL' : 'SL') : 'NONE',
    anticipated: withinBand,
  };
}

/** Convert a target multiple (5 = 5x) into the profit percentage it represents. */
export function multipleToProfitPct(multiple: number): number {
  return (multiple - 1) * 100;
}
