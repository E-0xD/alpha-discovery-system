import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import * as http from 'http';

dotenv.config();

// 1. Keep Render alive
const PORT = parseInt(process.env.PORT || '3000', 10);
http.createServer((req, res) => res.end('OK')).listen(PORT);

// 2. Start Bot cleanly
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');

// Force kill existing connections and clear the queue
bot.launch({ dropPendingUpdates: true })
  .then(() => console.log("🤖 Bot Live: Polling Started (Updates Cleared)"))
  .catch((err) => console.error("Launch Error:", err));

// 3. Simple test to verify it works
bot.command('test', (ctx) => ctx.reply('Bot is working perfectly.'));
