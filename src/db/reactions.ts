import { db } from './connection.js';

// --- Reactions ---

export function upsertReaction(
  chatJid: string,
  messageId: string,
  sender: string,
  emoji: string,
  timestamp: string,
): void {
  if (emoji) {
    db.prepare(
      `INSERT OR REPLACE INTO reactions (chat_jid, message_id, sender, emoji, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(chatJid, messageId, sender, emoji, timestamp);
  } else {
    // Empty emoji = reaction removed
    db.prepare(
      `DELETE FROM reactions WHERE chat_jid = ? AND message_id = ? AND sender = ?`,
    ).run(chatJid, messageId, sender);
  }
}

export function getReactions(
  chatJid: string,
  messageId: string,
): Array<{ sender: string; emoji: string; timestamp: string }> {
  return db
    .prepare(
      `SELECT sender, emoji, timestamp FROM reactions
       WHERE chat_jid = ? AND message_id = ? ORDER BY timestamp`,
    )
    .all(chatJid, messageId) as Array<{
    sender: string;
    emoji: string;
    timestamp: string;
  }>;
}
