import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// 1. Initialize Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');

// 2. Scan function (Logic to find tokens)
async function scan() {
    console.log("🔍 Scanning DexScreener...");
    try {
        const { data: profiles } = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
        console.log(`Found ${profiles.length} profiles to check.`);
        
        // ... add your buying/alert logic here ...
    } catch (e) { 
        console.error("Scan error:", e); 
    }
}

// 3. Launch with conflict protection
bot.launch({ dropPendingUpdates: true })
  .then(() => {
    console.log("🤖 Bot Live: Polling Started (Zombie processes cleared)");
  })
  .catch((err) => {
    console.error("Fatal Launch Error:", err);
    process.exit(1); 
  });

// 4. Test handler to verify the bot is alive
bot.command('test', (ctx) => ctx.reply('Bot is online.'));

// 5. Run the scanner every 60 seconds
setInterval(scan, 60000);
