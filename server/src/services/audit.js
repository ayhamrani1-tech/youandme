/**
 * Admin audit trail. Every destructive or privileged mutation records who did
 * what, so the admin dashboard can show a history and nothing happens silently.
 */
import { getDb } from '../db/index.js';

export async function recordAudit(req, { action, entity, entityId, meta }) {
  try {
    const db = getDb();
    await db.insert('audit_log', {
      actor_id: req.user?.id ?? null,
      action,
      entity,
      entity_id: entityId === undefined || entityId === null ? null : String(entityId),
      meta: meta ? JSON.stringify(meta) : null,
      ip: req.ip || null,
    });
  } catch (err) {
    // Auditing must never break the request it is recording.
    console.warn('[audit] failed to record entry:', err.message);
  }
}
