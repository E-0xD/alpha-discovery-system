-- CreateTable
CREATE TABLE "accounts" (
    "username" TEXT NOT NULL PRIMARY KEY,
    "priority_tier" TEXT NOT NULL DEFAULT 'LOW',
    "reputation_score" REAL NOT NULL DEFAULT 50.0,
    "total_signals_tracked" INTEGER NOT NULL DEFAULT 0,
    "last_scanned" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "token_intelligence" (
    "token_address" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT,
    "alpha_score" REAL NOT NULL DEFAULT 0.0,
    "rug_probability" REAL NOT NULL DEFAULT 0.0,
    "insider_risk_score" REAL NOT NULL DEFAULT 0.0,
    "narrative_strength" REAL NOT NULL DEFAULT 0.0,
    "classification" TEXT NOT NULL DEFAULT 'ORGANIC',
    "alert_sent" BOOLEAN NOT NULL DEFAULT false,
    "is_bundled_launch" BOOLEAN NOT NULL DEFAULT false,
    "dev_rug_history_count" INTEGER NOT NULL DEFAULT 0,
    "last_updated" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "active_positions" (
    "token_address" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'LIVE',
    "ticker" TEXT,
    "entry_price_usd" REAL,
    "current_price_usd" REAL,
    "size_sol" REAL,
    "tokens_held" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "highest_price_usd" REAL,
    "timestamp" REAL,

    PRIMARY KEY ("token_address", "mode")
);

-- CreateTable
CREATE TABLE "trades_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "address" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'LIVE',
    "ticker" TEXT,
    "source" TEXT,
    "alert_time" REAL,
    "alert_price" REAL,
    "alert_mcap" REAL,
    "entry_price" REAL,
    "entry_size_sol" REAL,
    "peak_price" REAL,
    "peak_mcap" REAL,
    "peak_time" REAL,
    "peak_gain_pct" REAL,
    "exit_price" REAL,
    "exit_time" REAL,
    "exit_type" TEXT,
    "pnl_pct" REAL,
    "pnl_sol" REAL,
    "held_minutes" INTEGER,
    "alpha_score" REAL,
    "rug_probability" REAL,
    "unique_buyers" INTEGER,
    "buyer_velocity" TEXT,
    "top_holder_pct" REAL,
    "is_bundled_launch" BOOLEAN,
    "wash_trading" BOOLEAN,
    "smart_money" BOOLEAN,
    "status" TEXT NOT NULL DEFAULT 'ALERTED'
);

-- CreateTable
CREATE TABLE "alert_history" (
    "address" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT,
    "alert_time" REAL,
    "alert_mcap" REAL,
    "alert_price" REAL,
    "peak_mcap" REAL,
    "peak_price" REAL,
    "peak_time" REAL,
    "current_mcap" REAL,
    "current_price" REAL,
    "last_updated" REAL,
    "exit_reason" TEXT,
    "exit_price" REAL,
    "exit_mcap" REAL,
    "exit_time" REAL,
    "milestones_hit" TEXT NOT NULL DEFAULT '[]'
);

-- CreateTable
CREATE TABLE "wallet_settings" (
    "chat_id" TEXT NOT NULL PRIMARY KEY,
    "encrypted_key" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "bot_settings" (
    "chat_id" TEXT NOT NULL PRIMARY KEY,
    "trade_size_sol" REAL NOT NULL DEFAULT 0.15,
    "take_profit_pct" REAL NOT NULL DEFAULT 50,
    "stop_loss_pct" REAL NOT NULL DEFAULT 35,
    "delayed_entry_enabled" BOOLEAN NOT NULL DEFAULT false,
    "delayed_entry_mcap" REAL NOT NULL DEFAULT 15000,
    "robinhood_enabled" BOOLEAN NOT NULL DEFAULT true,
    "slippage_bps" REAL NOT NULL DEFAULT 1000,
    "trading_mode" TEXT NOT NULL DEFAULT 'LIVE',
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "demo_account" (
    "chat_id" TEXT NOT NULL PRIMARY KEY,
    "balance_sol" REAL NOT NULL DEFAULT 10.0,
    "starting_balance" REAL NOT NULL DEFAULT 10.0,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "demo_ledger" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chat_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_sol" REAL NOT NULL,
    "balance_after" REAL NOT NULL,
    "address" TEXT,
    "ticker" TEXT,
    "note" TEXT,
    "timestamp" REAL NOT NULL
);

-- CreateIndex
CREATE INDEX "active_positions_mode_status_idx" ON "active_positions"("mode", "status");

-- CreateIndex
CREATE INDEX "trades_log_mode_exit_time_idx" ON "trades_log"("mode", "exit_time");

-- CreateIndex
CREATE INDEX "trades_log_mode_status_idx" ON "trades_log"("mode", "status");

-- CreateIndex
CREATE INDEX "alert_history_alert_time_idx" ON "alert_history"("alert_time");

-- CreateIndex
CREATE INDEX "demo_ledger_chat_id_timestamp_idx" ON "demo_ledger"("chat_id", "timestamp");
