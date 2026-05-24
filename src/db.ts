import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export async function initDatabaseSchema() {
  try {
    // Accounts Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        username TEXT PRIMARY KEY,
        priority_tier TEXT DEFAULT 'LOW',
        reputation_score NUMERIC DEFAULT 50.0,
        total_signals_tracked INT DEFAULT 0,
        last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Complete On-Chain Token Tracking Schema
    await db.query(`
      CREATE TABLE IF NOT EXISTS token_intelligence (
        token_address TEXT PRIMARY KEY,
        ticker TEXT,
        alpha_score NUMERIC DEFAULT 0.0,
        rug_probability NUMERIC DEFAULT 0.0,
        insider_risk_score NUMERIC DEFAULT 0.0,
        narrative_strength NUMERIC DEFAULT 0.0,
        classification TEXT DEFAULT 'ORGANIC',
        alert_sent BOOLEAN DEFAULT FALSE,
        is_bundled_launch BOOLEAN DEFAULT FALSE,
        dev_rug_history_count INT DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Positions Storage for Fault Tolerance
    await db.query(`
      CREATE TABLE IF NOT EXISTS active_positions (
        token_address TEXT PRIMARY KEY,
        ticker TEXT,
        entry_price_usd NUMERIC,
        current_price_usd NUMERIC,
        size_sol NUMERIC,
        tokens_held TEXT,
        status TEXT DEFAULT 'OPEN',
        highest_price_usd NUMERIC,
        timestamp BIGINT
      );
    `);

    console.log("⚡ Supabase Tables & High-Performance Schema Verified.");
  } catch (err) {
    console.error("❌ Database initialization failure:", err);
  }
}
