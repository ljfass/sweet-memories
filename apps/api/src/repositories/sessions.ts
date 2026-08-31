import type Database from 'better-sqlite3';

export interface SessionRecord {
  readonly tokenHash: string;
  readonly adminId: string;
  readonly username: string;
  readonly csrfHash: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly absoluteExpiresAt: string;
}

interface SessionRow {
  readonly token_hash: string;
  readonly admin_id: string;
  readonly username: string;
  readonly csrf_hash: string;
  readonly created_at: string;
  readonly last_activity_at: string;
  readonly absolute_expires_at: string;
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    tokenHash: row.token_hash,
    adminId: row.admin_id,
    username: row.username,
    csrfHash: row.csrf_hash,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

export interface InsertSessionValues {
  readonly tokenHash: string;
  readonly adminId: string;
  readonly csrfHash: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly absoluteExpiresAt: string;
}

export function insertSession(db: Database.Database, values: InsertSessionValues): void {
  db.prepare(
    `INSERT INTO sessions(
       token_hash, admin_id, csrf_hash, created_at, last_activity_at, absolute_expires_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    values.tokenHash,
    values.adminId,
    values.csrfHash,
    values.createdAt,
    values.lastActivityAt,
    values.absoluteExpiresAt,
  );
}

export function findSessionByTokenHash(
  db: Database.Database,
  tokenHash: string,
): SessionRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         sessions.token_hash,
         sessions.admin_id,
         admins.username,
         sessions.csrf_hash,
         sessions.created_at,
         sessions.last_activity_at,
         sessions.absolute_expires_at
       FROM sessions
       INNER JOIN admins ON admins.id = sessions.admin_id
       WHERE sessions.token_hash = ?`,
    )
    .get(tokenHash) as SessionRow | undefined;
  return row === undefined ? undefined : mapSession(row);
}

export function updateSessionActivity(
  db: Database.Database,
  tokenHash: string,
  lastActivityAt: string,
): boolean {
  return (
    db
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE token_hash = ?')
      .run(lastActivityAt, tokenHash).changes === 1
  );
}

export function updateSessionCsrf(
  db: Database.Database,
  tokenHash: string,
  csrfHash: string,
  lastActivityAt: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE sessions
         SET csrf_hash = ?, last_activity_at = ?
         WHERE token_hash = ?`,
      )
      .run(csrfHash, lastActivityAt, tokenHash).changes === 1
  );
}

export function deleteSession(db: Database.Database, tokenHash: string): boolean {
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes === 1;
}

export interface CleanupSessionsValues {
  readonly now: string;
  readonly idleCutoff: string;
}

export function cleanupExpiredSessions(
  db: Database.Database,
  values: CleanupSessionsValues,
): number {
  return db
    .prepare(
      `DELETE FROM sessions
       WHERE absolute_expires_at <= ? OR last_activity_at <= ?`,
    )
    .run(values.now, values.idleCutoff).changes;
}
