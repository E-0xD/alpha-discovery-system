import { BotSettings } from './settings';

/**
 * /help — one message, plain language, no internals.
 *
 * Plain text with no parse_mode on purpose: setting names contain
 * underscores, which Telegram's Markdown parser reads as italics markers, and
 * one unbalanced underscore fails the whole send with a 400.
 */

const TELEGRAM_LIMIT = 4000; // under the real 4096 for headroom

/** Backstop in case the text ever grows past the limit. Splits on blank lines. */
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

export function helpText(s: BotSettings): string {
  const demo = s.tradingMode === 'DEMO';

  return [
    'ALPHA BOT — HELP',
    '',
    demo
      ? 'You are in DEMO mode. No real money is being spent.'
      : 'You are in LIVE mode. Real money is being spent.',
    '',
    'WHAT IT DOES',
    'Watches for new Solana tokens, buys the ones that pass its filters,',
    'then sells them automatically at your take profit or stop loss.',
    'It checks your open trades about once a second.',
    '',
    'COMMANDS',
    '',
    '/chart       your profit and loss, as a graph',
    '/positions   what you are holding right now',
    '/settings    change trade size, take profit, stop loss',
    '/mode        switch between practice and real money',
    '/demo        your practice balance (add, remove, reset)',
    '/pnl         how well the alerts have been doing',
    '/winrate     how often the alerts are right',
    '/report      download your history as a spreadsheet',
    '/test        check the bot is awake',
    '/cancel      stop the bot waiting for an answer',
    '/help        this message',
    '',
    'YOUR SETTINGS RIGHT NOW',
    '',
    'Trade size      ' + s.tradeSizeSol + ' SOL on each buy',
    'Take profit     sells when up ' + s.takeProfitPct + '%',
    'Stop loss       sells when down ' + s.stopLossPct + '%',
    'Slippage        ' + s.slippageBps / 100 + '% price movement allowed',
    'Delayed entry   ' + (s.delayedEntryEnabled
      ? 'on — waits for $' + s.delayedEntryMcap.toLocaleString('en-US')
      : 'off — buys straight away'),
    '',
    'Change any of these with /settings.',
    '',
    'PRACTICE vs REAL',
    '',
    'Practice mode works exactly like the real thing, but spends fake',
    'money. It still charges realistic fees, so what you see in practice',
    'is close to what you would actually get.',
    '',
    'Stay in practice until /chart shows results you are happy with, then',
    'switch with:  /mode live',
    '',
    demo
      ? 'Top up practice money any time with /demo add 5'
      : 'Go back to practice any time with /mode demo',
  ].join('\n');
}
