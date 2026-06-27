import * as crypto from 'crypto';
import { db } from './db';

// Derives a 32-byte AES key: prefer explicit env var, fall back to bot token hash.
// The bot token is already a strong secret, making this safe for single-user self-hosted bots.
function getEncryptionKey(): Buffer {
  const hexKey = process.env.WALLET_ENCRYPTION_KEY;
  if (hexKey && hexKey.length === 64) {
    return Buffer.from(hexKey, 'hex');
  }
  const seed = process.env.TELEGRAM_BOT_TOKEN || 'alpha-discovery-fallback';
  return crypto.createHash('sha256').update(seed).digest();
}

export function encryptPrivateKey(privateKey: string): { encrypted: string; iv: string; tag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { encrypted, iv: iv.toString('hex'), tag };
}

export function decryptPrivateKey(encrypted: string, iv: string, tag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export async function saveEncryptedWallet(chatId: string, privateKey: string): Promise<void> {
  const { encrypted, iv, tag } = encryptPrivateKey(privateKey);
  await db.query(
    `INSERT INTO wallet_settings (chat_id, encrypted_key, iv, tag)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_id) DO UPDATE SET
       encrypted_key = EXCLUDED.encrypted_key,
       iv = EXCLUDED.iv,
       tag = EXCLUDED.tag,
       updated_at = NOW()`,
    [chatId, encrypted, iv, tag]
  );
}

export async function loadDecryptedWallet(chatId: string): Promise<string | null> {
  try {
    const res = await db.query(
      'SELECT encrypted_key, iv, tag FROM wallet_settings WHERE chat_id = $1',
      [chatId]
    );
    if (!res.rows.length) return null;
    const { encrypted_key, iv, tag } = res.rows[0];
    return decryptPrivateKey(encrypted_key, iv, tag);
  } catch {
    return null;
  }
}
