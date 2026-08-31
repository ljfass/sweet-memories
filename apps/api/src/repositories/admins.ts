import type Database from 'better-sqlite3';

const ADMIN_USERNAME = /^[a-z][a-z0-9_-]{2,31}$/;

export type AdminRepositoryErrorCode =
  | 'ADMIN_ALREADY_EXISTS'
  | 'ADMIN_NOT_FOUND'
  | 'ADMIN_CREATE_FAILED'
  | 'ADMIN_RESET_FAILED';

export class AdminRepositoryError extends Error {
  readonly code: AdminRepositoryErrorCode;

  constructor(code: AdminRepositoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AdminRepositoryError';
    this.code = code;
  }
}

export interface AdminRecord {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AdminRow {
  readonly id: string;
  readonly username: string;
  readonly password_hash: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function isValidAdminUsername(username: string): boolean {
  return ADMIN_USERNAME.test(username);
}

export function findAdminByUsername(
  db: Database.Database,
  username: string,
): AdminRecord | undefined {
  const row = db
    .prepare(
      `SELECT id, username, password_hash, created_at, updated_at
       FROM admins
       WHERE username = ?`,
    )
    .get(username) as AdminRow | undefined;

  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateAdminValues {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly timestamp: string;
}

function sqliteCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

export function createAdmin(db: Database.Database, values: CreateAdminValues): void {
  try {
    db.prepare(
      `INSERT INTO admins(id, username, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(values.id, values.username, values.passwordHash, values.timestamp, values.timestamp);
  } catch (cause) {
    if (
      sqliteCode(cause)?.startsWith('SQLITE_CONSTRAINT') === true &&
      findAdminByUsername(db, values.username) !== undefined
    ) {
      throw new AdminRepositoryError(
        'ADMIN_ALREADY_EXISTS',
        `管理员已存在: ${values.username}`,
      );
    }
    throw new AdminRepositoryError('ADMIN_CREATE_FAILED', '无法创建管理员', { cause });
  }
}

export interface ResetAdminPasswordValues {
  readonly username: string;
  readonly passwordHash: string;
  readonly timestamp: string;
}

export function resetAdminPassword(
  db: Database.Database,
  values: ResetAdminPasswordValues,
): void {
  try {
    db.transaction(() => {
      const admin = findAdminByUsername(db, values.username);
      if (admin === undefined) {
        throw new AdminRepositoryError(
          'ADMIN_NOT_FOUND',
          `管理员不存在: ${values.username}`,
        );
      }

      const result = db
        .prepare(
          `UPDATE admins
           SET password_hash = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(values.passwordHash, values.timestamp, admin.id);
      if (result.changes !== 1) {
        throw new AdminRepositoryError('ADMIN_RESET_FAILED', '无法重置管理员密码');
      }

      db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(admin.id);
    })();
  } catch (cause) {
    if (cause instanceof AdminRepositoryError) {
      throw cause;
    }
    throw new AdminRepositoryError('ADMIN_RESET_FAILED', '无法重置管理员密码', { cause });
  }
}
