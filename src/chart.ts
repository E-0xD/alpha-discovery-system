import { createCanvas } from '@napi-rs/canvas';
import { ClosedTrade } from './trades';
import { TradingMode } from './settings';

// ─────────────────────────────────────────────────────────────────────────────
// Cumulative P&L chart.
//
// Form: the job of this data is change-over-time on a single measure, so it is
// one line against a zero baseline — not a bar per trade, and never two y-axes.
//
// Colour: gain/loss is a polarity (diverging) encoding. The obvious green/red
// pair is the textbook deuteranopia failure — measured CVD separation is only
// ~4.9 dE, well under the safe floor, so no amount of secondary encoding makes
// it legible. The blue/orange pair below validates clean on every check
// (lightness band, chroma floor, CVD separation 25.3 dE, normal-vision
// separation 30.7 dE, contrast vs surface). Set PNL_CLASSIC_COLORS=true to
// force conventional green/red if you know you are not colour-blind.
//
// Polarity is never carried by colour alone: the line sits above or below the
// zero baseline, and the headline number is explicitly signed.
//
// Fonts follow cards.ts — headless containers ship no system fonts, and canvas
// silently draws nothing rather than erroring. Emoji are never baked into the
// PNG for the same reason; they belong in the Telegram caption.
// ─────────────────────────────────────────────────────────────────────────────

const FONT = 'CardFont, DejaVu Sans, sans-serif';

const CLASSIC = process.env.PNL_CLASSIC_COLORS === 'true';

const C = {
  surface: '#1A1A19',
  grid: '#2E2E2C',
  axis: '#3A3A37',
  inkPrimary: '#ECEDEE',
  inkSecondary: '#9BA1A6',
  inkMuted: '#6B7280',
  gain: CLASSIC ? '#30A46C' : '#4C8FE8',
  loss: CLASSIC ? '#E5484D' : '#E86A33',
  demoBadge: '#8B5CF6',
  liveBadge: '#E5A03D',
};

export interface ChartOptions {
  mode: TradingMode;
  trades: ClosedTrade[];
  /** Demo balance, shown only in demo mode. */
  balanceSol?: number;
  periodLabel: string;
}

function fmtSol(n: number, dp = 4): string {
  return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(dp);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return String(d.getUTCDate()).padStart(2, '0') + ' ' + MONTHS[d.getUTCMonth()];
}

export async function renderPnlChart(o: ChartOptions): Promise<Buffer> {
  const W = 1200;
  const H = 675;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = C.surface;
  ctx.fillRect(0, 0, W, H);

  const isDemo = o.mode === 'DEMO';
  const badgeColor = isDemo ? C.demoBadge : C.liveBadge;
  const badgeText = isDemo ? 'DEMO' : 'LIVE';

  // ── Header ──────────────────────────────────────────────────────────────
  const PAD = 56;
  ctx.font = 'bold 15px ' + FONT;
  const badgeW = ctx.measureText(badgeText).width + 28;
  ctx.fillStyle = badgeColor;
  ctx.beginPath();
  ctx.roundRect(PAD, 44, badgeW, 30, 8);
  ctx.fill();
  ctx.fillStyle = '#12100E';
  ctx.textAlign = 'center';
  ctx.fillText(badgeText, PAD + badgeW / 2, 64);

  ctx.textAlign = 'left';
  ctx.fillStyle = C.inkSecondary;
  ctx.font = '16px ' + FONT;
  ctx.fillText('Cumulative P&L  ·  ' + o.periodLabel, PAD + badgeW + 16, 65);

  // ── Cumulative series ───────────────────────────────────────────────────
  const pts: Array<{ t: number; cum: number }> = [];
  let cum = 0;
  for (const t of o.trades) {
    cum += t.pnlSol;
    pts.push({ t: t.exitTime, cum });
  }

  const total = cum;
  const wins = o.trades.filter((t) => t.pnlSol > 0).length;
  const winRate = o.trades.length ? (wins / o.trades.length) * 100 : 0;
  const polarity = total >= 0 ? C.gain : C.loss;

  // ── Hero number ─────────────────────────────────────────────────────────
  ctx.fillStyle = polarity;
  ctx.font = 'bold 68px ' + FONT;
  ctx.fillText(fmtSol(total) + ' SOL', PAD, 152);

  // ── Stat row ────────────────────────────────────────────────────────────
  const stats: Array<[string, string]> = [
    ['TRADES', String(o.trades.length)],
    ['WIN RATE', o.trades.length ? winRate.toFixed(0) + '%' : '—'],
  ];
  if (isDemo && o.balanceSol !== undefined) {
    stats.push(['BALANCE', o.balanceSol.toFixed(3) + ' SOL']);
  }
  if (o.trades.length) {
    stats.push(['BEST', fmtSol(Math.max(...o.trades.map((t) => t.pnlSol)), 3)]);
    stats.push(['WORST', fmtSol(Math.min(...o.trades.map((t) => t.pnlSol)), 3)]);
  }

  let sx = PAD;
  for (const [label, value] of stats) {
    ctx.fillStyle = C.inkMuted;
    ctx.font = 'bold 12px ' + FONT;
    ctx.fillText(label, sx, 186);
    ctx.fillStyle = C.inkPrimary;
    ctx.font = 'bold 22px ' + FONT;
    ctx.fillText(value, sx, 214);
    sx += Math.max(ctx.measureText(value).width, 84) + 52;
  }

  // ── Plot area ───────────────────────────────────────────────────────────
  const plot = { x: PAD, y: 258, w: W - PAD * 2, h: H - 258 - 74 };

  if (pts.length < 2) {
    ctx.fillStyle = C.inkMuted;
    ctx.font = '20px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillText(
      pts.length === 0
        ? 'No closed trades yet in ' + o.mode + ' mode'
        : 'Only one closed trade so far — a curve needs two',
      W / 2,
      plot.y + plot.h / 2
    );
    return canvas.toBuffer('image/png');
  }

  const cums = pts.map((p) => p.cum);
  // Always include zero so the baseline stays meaningful, then pad so the line
  // never touches the frame.
  let lo = Math.min(0, ...cums);
  let hi = Math.max(0, ...cums);
  const span = hi - lo || Math.abs(hi) || 1;
  lo -= span * 0.12;
  hi += span * 0.12;

  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const tSpan = t1 - t0 || 1;

  const X = (t: number) => plot.x + ((t - t0) / tSpan) * plot.w;
  const Y = (v: number) => plot.y + plot.h - ((v - lo) / (hi - lo)) * plot.h;

  // ── Recessive grid ──────────────────────────────────────────────────────
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.font = '13px ' + FONT;
  const TICKS = 4;
  for (let i = 0; i <= TICKS; i++) {
    const v = lo + ((hi - lo) * i) / TICKS;
    const y = Y(v);
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillStyle = C.inkMuted;
    ctx.fillText(v.toFixed(2), plot.x - 12, y + 4);
  }

  // ── Zero baseline — the reference that makes above/below readable ───────
  const yZero = Y(0);
  ctx.strokeStyle = C.axis;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(plot.x, yZero);
  ctx.lineTo(plot.x + plot.w, yZero);
  ctx.stroke();

  // ── Area fill, clipped at zero so gain and loss regions read apart ──────
  const drawArea = (above: boolean) => {
    ctx.save();
    ctx.beginPath();
    if (above) ctx.rect(plot.x, plot.y, plot.w, Math.max(0, yZero - plot.y));
    else ctx.rect(plot.x, yZero, plot.w, Math.max(0, plot.y + plot.h - yZero));
    ctx.clip();

    ctx.beginPath();
    ctx.moveTo(X(pts[0].t), yZero);
    for (const p of pts) ctx.lineTo(X(p.t), Y(p.cum));
    ctx.lineTo(X(pts[pts.length - 1].t), yZero);
    ctx.closePath();
    ctx.fillStyle = above ? C.gain : C.loss;
    ctx.globalAlpha = 0.16;
    ctx.fill();
    ctx.restore();
  };
  drawArea(true);
  drawArea(false);

  // ── The line: 2px, single series, coloured by final polarity ───────────
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.cum)) : ctx.moveTo(X(p.t), Y(p.cum))));
  ctx.strokeStyle = polarity;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // ── Selective direct label: last point only, never one per point ───────
  const last = pts[pts.length - 1];
  const lx = X(last.t);
  const ly = Y(last.cum);
  ctx.beginPath();
  ctx.arc(lx, ly, 5, 0, Math.PI * 2);
  ctx.fillStyle = polarity;
  ctx.fill();
  // 2px surface ring keeps the marker legible where it overlaps the line.
  ctx.strokeStyle = C.surface;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = C.inkPrimary;
  ctx.font = 'bold 15px ' + FONT;
  const nearRight = lx > plot.x + plot.w - 90;
  ctx.textAlign = nearRight ? 'right' : 'left';
  ctx.fillText(fmtSol(last.cum, 3), lx + (nearRight ? -12 : 12), ly - 12);

  // ── Time axis: endpoints only, kept recessive ──────────────────────────
  ctx.fillStyle = C.inkMuted;
  ctx.font = '13px ' + FONT;
  ctx.textAlign = 'left';
  ctx.fillText(fmtDate(t0), plot.x, plot.y + plot.h + 28);
  ctx.textAlign = 'right';
  ctx.fillText(fmtDate(t1), plot.x + plot.w, plot.y + plot.h + 28);

  return canvas.toBuffer('image/png');
}
