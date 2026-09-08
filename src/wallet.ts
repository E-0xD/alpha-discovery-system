import * as crypto from 'crypto';
import { prisma } from './db';

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
  await prisma.walletSetting.upsert({
    where: { chatId },
    create: { chatId, encryptedKey: encrypted, iv, tag },
    update: { encryptedKey: encrypted, iv, tag },
  });
}

export async function loadDecryptedWallet(chatId: string): Promise<string | null> {
  try {
    const row = await prisma.walletSetting.findUnique({ where: { chatId } });
    if (!row) return null;
    return decryptPrivateKey(row.encryptedKey, row.iv, row.tag);
  } catch {
    return null;
  }
}
