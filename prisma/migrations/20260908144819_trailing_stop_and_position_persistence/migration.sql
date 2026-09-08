-- AlterTable
ALTER TABLE "active_positions" ADD COLUMN "trailing_stop_pct" REAL;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_bot_settings" (
    "chat_id" TEXT NOT NULL PRIMARY KEY,
    "trade_size_sol" REAL NOT NULL DEFAULT 0.15,
    "take_profit_pct" REAL NOT NULL DEFAULT 50,
    "stop_loss_pct" REAL NOT NULL DEFAULT 35,
    "delayed_entry_enabled" BOOLEAN NOT NULL DEFAULT false,
    "delayed_entry_mcap" REAL NOT NULL DEFAULT 15000,
    "robinhood_enabled" BOOLEAN NOT NULL DEFAULT true,
    "slippage_bps" REAL NOT NULL DEFAULT 1000,
    "trading_mode" TEXT NOT NULL DEFAULT 'LIVE',
    "exit_mode" TEXT NOT NULL DEFAULT 'FIXED',
    "max_portfolio_sol" REAL NOT NULL DEFAULT 5.0,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_bot_settings" ("chat_id", "delayed_entry_enabled", "delayed_entry_mcap", "robinhood_enabled", "slippage_bps", "stop_loss_pct", "take_profit_pct", "trade_size_sol", "trading_mode", "updated_at") SELECT "chat_id", "delayed_entry_enabled", "delayed_entry_mcap", "robinhood_enabled", "slippage_bps", "stop_loss_pct", "take_profit_pct", "trade_size_sol", "trading_mode", "updated_at" FROM "bot_settings";
DROP TABLE "bot_settings";
ALTER TABLE "new_bot_settings" RENAME TO "bot_settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
