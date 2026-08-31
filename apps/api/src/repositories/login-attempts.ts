import type Database from 'better-sqlite3';

interface LoginAttemptRow {
  readonly failure_count: number;
  readonly blocked_until: string | null;
}

export interface LoginAttemptPolicy {
  readonly maximumFailures: number;
  readonly blockMilliseconds: number;
}

export interface LoginAttemptValues {
  readonly ip: string;
  readonly now: string;
}

export function isLoginBlocked(
  db: Database.Database,
  values: LoginAttemptValues,
): boolean {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT failure_count, blocked_until
         FROM login_attempts
         WHERE ip = ?`,
      )
      .get(values.ip) as LoginAttemptRow | undefined;
    if (row?.blocked_until === null || row === undefined) {
      return false;
    }
    if (values.now < row.blocked_until) {
      return true;
    }
    db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(values.ip);
    return false;
  })();
}

export function recordLoginFailure(
  db: Database.Database,
  values: LoginAttemptValues,
  policy: LoginAttemptPolicy,
): void {
  db.transaction(() => {
    const row = db
      .prepare(
        `SELECT failure_count, blocked_until
         FROM login_attempts
         WHERE ip = ?`,
      )
      .get(values.ip) as LoginAttemptRow | undefined;
    const previousCount = Math.max(
      0,
      Math.min(policy.maximumFailures, Math.trunc(row?.failure_count ?? 0)),
    );
    const failureCount = Math.min(policy.maximumFailures, previousCount + 1);
    const blockedUntil =
      failureCount >= policy.maximumFailures
        ? new Date(new Date(values.now).getTime() + policy.blockMilliseconds).toISOString()
        : null;

    db.prepare(
      `INSERT INTO login_attempts(ip, failure_count, blocked_until, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET
         failure_count = excluded.failure_count,
         blocked_until = excluded.blocked_until,
         updated_at = excluded.updated_at`,
    ).run(values.ip, failureCount, blockedUntil, values.now);
  })();
}

export function clearLoginFailures(db: Database.Database, ip: string): void {
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
}
