// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { createHiddenInput, createVisibleInput, runCli, type CliRuntime } from '../cli.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../database.js';
import { runMigrations } from '../migrations.js';
import { isValidAdminUsername } from '../repositories/admins.js';
import {
  adminHelp,
  runAdminCommand,
  type AdminCommandInput,
  type AdminCommandOutput,
  type HiddenInput,
} from './admin.js';

const migrationsRoot = resolve(import.meta.dirname, '../../migrations');
const temporaryRoots: string[] = [];
const openDatabases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sweet-memories-admin-'));
  temporaryRoots.push(dataRoot);
  const config = loadConfig({
    NODE_ENV: 'test',
    SWEET_MEMORIES_DATA_ROOT: dataRoot,
    SWEET_MEMORIES_MIGRATIONS_ROOT: migrationsRoot,
  });
  const db = openDatabase(config);
  openDatabases.push(db);
  runMigrations(db, migrationsRoot);
  return db;
}

interface InvocationOptions {
  readonly argv: readonly string[];
  readonly lines?: readonly string[];
  readonly secrets?: readonly string[];
  readonly now?: string;
  readonly randomId?: string;
  readonly db?: Database.Database;
}

async function invoke(options: InvocationOptions) {
  const lines = [...(options.lines ?? [])];
  const secrets = [...(options.secrets ?? [])];
  const outputText: string[] = [];
  const input: AdminCommandInput = {
    argv: options.argv,
    readLine: vi.fn(async () => lines.shift() ?? ''),
  };
  const output: AdminCommandOutput = {
    write: (text) => outputText.push(text),
  };
  const hiddenInput: HiddenInput = {
    read: vi.fn(async () => secrets.shift() ?? ''),
  };
  const exitCode = await runAdminCommand({
    input,
    output,
    hiddenInput,
    db: options.db,
    now: () => options.now ?? '2026-09-01T08:00:00.000Z',
    randomId: () => options.randomId ?? 'admin-generated-id',
  });
  return { exitCode, hiddenInput, input, output: outputText.join('') };
}

function insertAdmin(
  db: Database.Database,
  values: { id: string; username: string; passwordHash: string; updatedAt?: string },
): void {
  const updatedAt = values.updatedAt ?? '2026-08-31T00:00:00.000Z';
  db.prepare(
    `INSERT INTO admins(id, username, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(values.id, values.username, values.passwordHash, updatedAt, updatedAt);
}

function insertSession(db: Database.Database, tokenHash: string, adminId: string): void {
  db.prepare(
    `INSERT INTO sessions(
       token_hash, admin_id, csrf_hash, created_at, last_activity_at, absolute_expires_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    tokenHash,
    adminId,
    `csrf-${tokenHash}`,
    '2026-08-31T00:00:00.000Z',
    '2026-08-31T00:00:00.000Z',
    '2026-09-02T00:00:00.000Z',
  );
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close();
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('administrator usernames', () => {
  it.each([
    'abc',
    `a${'0'.repeat(31)}`,
    'admin-user_01',
  ])('accepts the exact lowercase ASCII username grammar: %s', (username) => {
    expect(isValidAdminUsername(username)).toBe(true);
  });

  it.each([
    'ab',
    `a${'0'.repeat(32)}`,
    'Admin',
    '1admin',
    '_admin',
    '-admin',
    ' admin',
    'admin ',
    'adm.in',
    '管理员',
  ])('rejects an invalid username without normalization: %s', (username) => {
    expect(isValidAdminUsername(username)).toBe(false);
  });
});

describe('admin commands', () => {
  it('creates an administrator with injected identity and time without exposing secrets', async () => {
    const db = createDatabase();
    const password = 'a secure admin password';

    const result = await invoke({
      argv: ['admin', 'create'],
      lines: ['owner'],
      secrets: [password, password],
      db,
      randomId: 'admin-owner',
      now: '2026-09-01T09:30:00.000Z',
    });

    expect(result.exitCode).toBe(0);
    const row = db.prepare('SELECT * FROM admins WHERE username = ?').get('owner') as {
      id: string;
      username: string;
      password_hash: string;
      created_at: string;
      updated_at: string;
    };
    expect(row).toMatchObject({
      id: 'admin-owner',
      username: 'owner',
      created_at: '2026-09-01T09:30:00.000Z',
      updated_at: '2026-09-01T09:30:00.000Z',
    });
    await expect(verifyPassword(row.password_hash, password)).resolves.toBe(true);
    expect(result.output).toContain('owner');
    expect(result.output).toContain('创建成功');
    expect(result.output).not.toContain(password);
    expect(result.output).not.toContain(row.password_hash);
  });

  it('rejects mismatched create passwords without changing the database', async () => {
    const db = createDatabase();

    const result = await invoke({
      argv: ['admin', 'create'],
      lines: ['owner'],
      secrets: ['a secure admin password', 'a different password'],
      db,
    });

    expect(result.exitCode).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM admins').get()).toEqual({ count: 0 });
    expect(result.output).toContain('两次密码输入不一致');
    expect(result.output).not.toContain('a secure admin password');
    expect(result.output).not.toContain('a different password');
  });

  it('rejects passwords outside the policy before writing an administrator', async () => {
    const db = createDatabase();

    for (const password of ['x'.repeat(11), 'x'.repeat(257)]) {
      const result = await invoke({
        argv: ['admin', 'create'],
        lines: ['owner'],
        secrets: [password, password],
        db,
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('密码长度必须为 12 到 256 个字符');
      expect(result.output).not.toContain(password);
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM admins').get()).toEqual({ count: 0 });
  });

  it('returns a stable safe error when creating a duplicate administrator', async () => {
    const db = createDatabase();
    const password = 'a secure admin password';
    const first = await invoke({
      argv: ['admin', 'create'],
      lines: ['owner'],
      secrets: [password, password],
      db,
    });
    const second = await invoke({
      argv: ['admin', 'create'],
      lines: ['owner'],
      secrets: [password, password],
      db,
    });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(1);
    expect(second.output).toContain('管理员已存在: owner');
    expect(second.output).not.toContain(password);
    expect(second.output).not.toContain('$argon2');
    expect(db.prepare('SELECT COUNT(*) AS count FROM admins').get()).toEqual({ count: 1 });
  });

  it('resets the password, timestamp, and only that administrator sessions', async () => {
    const db = createDatabase();
    const oldPassword = 'the previous password';
    const newPassword = 'the replacement password';
    const otherPassword = 'the other admin password';
    insertAdmin(db, {
      id: 'admin-owner',
      username: 'owner',
      passwordHash: await hashPassword(oldPassword),
    });
    insertAdmin(db, {
      id: 'admin-other',
      username: 'other',
      passwordHash: await hashPassword(otherPassword),
    });
    insertSession(db, 'owner-session-1', 'admin-owner');
    insertSession(db, 'owner-session-2', 'admin-owner');
    insertSession(db, 'other-session', 'admin-other');

    const result = await invoke({
      argv: ['admin', 'reset-password'],
      lines: ['owner'],
      secrets: [newPassword, newPassword],
      db,
      now: '2026-09-01T10:00:00.000Z',
    });

    expect(result.exitCode).toBe(0);
    const owner = db
      .prepare('SELECT password_hash, updated_at FROM admins WHERE username = ?')
      .get('owner') as { password_hash: string; updated_at: string };
    await expect(verifyPassword(owner.password_hash, oldPassword)).resolves.toBe(false);
    await expect(verifyPassword(owner.password_hash, newPassword)).resolves.toBe(true);
    expect(owner.updated_at).toBe('2026-09-01T10:00:00.000Z');
    expect(db.prepare('SELECT token_hash FROM sessions ORDER BY token_hash').all()).toEqual([
      { token_hash: 'other-session' },
    ]);
    expect(result.output).toContain('owner');
    expect(result.output).toContain('密码重置成功');
    expect(result.output).not.toContain(newPassword);
    expect(result.output).not.toContain(owner.password_hash);
  });

  it('does not reset anything when password confirmation differs', async () => {
    const db = createDatabase();
    const oldHash = await hashPassword('the previous password');
    insertAdmin(db, { id: 'admin-owner', username: 'owner', passwordHash: oldHash });
    insertSession(db, 'owner-session', 'admin-owner');

    const result = await invoke({
      argv: ['admin', 'reset-password'],
      lines: ['owner'],
      secrets: ['the replacement password', 'a different replacement'],
      db,
    });

    expect(result.exitCode).toBe(1);
    expect(
      db.prepare('SELECT password_hash, updated_at FROM admins WHERE username = ?').get('owner'),
    ).toEqual({
      password_hash: oldHash,
      updated_at: '2026-08-31T00:00:00.000Z',
    });
    expect(db.prepare('SELECT token_hash FROM sessions').all()).toEqual([
      { token_hash: 'owner-session' },
    ]);
  });

  it('rolls back the password update when deleting sessions fails', async () => {
    const db = createDatabase();
    const oldHash = await hashPassword('the previous password');
    insertAdmin(db, { id: 'admin-owner', username: 'owner', passwordHash: oldHash });
    insertSession(db, 'owner-session', 'admin-owner');
    db.exec(`CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions
             BEGIN SELECT RAISE(ABORT, 'sensitive database detail'); END;`);

    const result = await invoke({
      argv: ['admin', 'reset-password'],
      lines: ['owner'],
      secrets: ['the replacement password', 'the replacement password'],
      db,
      now: '2026-09-01T10:00:00.000Z',
    });

    expect(result.exitCode).toBe(1);
    expect(
      db.prepare('SELECT password_hash, updated_at FROM admins WHERE username = ?').get('owner'),
    ).toEqual({ password_hash: oldHash, updated_at: '2026-08-31T00:00:00.000Z' });
    expect(db.prepare('SELECT token_hash FROM sessions').all()).toEqual([
      { token_hash: 'owner-session' },
    ]);
    expect(result.output).toContain('无法重置管理员密码');
    expect(result.output).not.toContain('sensitive database detail');
    expect(result.output).not.toContain(oldHash);
  });

  it('does not delete sessions when the administrator update fails', async () => {
    const db = createDatabase();
    const oldHash = await hashPassword('the previous password');
    insertAdmin(db, { id: 'admin-owner', username: 'owner', passwordHash: oldHash });
    insertSession(db, 'owner-session', 'admin-owner');
    db.exec(`CREATE TRIGGER fail_admin_update BEFORE UPDATE ON admins
             BEGIN SELECT RAISE(ABORT, 'sensitive update detail'); END;`);

    const result = await invoke({
      argv: ['admin', 'reset-password'],
      lines: ['owner'],
      secrets: ['the replacement password', 'the replacement password'],
      db,
    });

    expect(result.exitCode).toBe(1);
    expect(db.prepare('SELECT password_hash FROM admins WHERE username = ?').get('owner')).toEqual({
      password_hash: oldHash,
    });
    expect(db.prepare('SELECT token_hash FROM sessions').all()).toEqual([
      { token_hash: 'owner-session' },
    ]);
    expect(result.output).not.toContain('sensitive update detail');
  });

  it('reports an absent administrator without exposing storage details', async () => {
    const db = createDatabase();
    const result = await invoke({
      argv: ['admin', 'reset-password'],
      lines: ['missing'],
      secrets: ['the replacement password', 'the replacement password'],
      db,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('管理员不存在: missing');
    expect(result.output).not.toContain('$argon2');
  });

  it('prints only supported commands for help and fails closed for unknown commands', async () => {
    const help = await invoke({ argv: ['--help'] });
    const unknown = await invoke({ argv: ['admin', 'delete'] });
    const missing = await invoke({ argv: ['admin'] });

    expect(help.exitCode).toBe(0);
    expect(help.output).toBe(adminHelp);
    expect(help.output).toContain('admin create');
    expect(help.output).toContain('admin reset-password');
    expect(help.output).not.toContain('delete');
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toBe(adminHelp);
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toBe(adminHelp);
  });
});

describe('terminal password input', () => {
  function terminal() {
    const input = new PassThrough() as PassThrough & {
      isRaw: boolean;
      isTTY: boolean;
      setRawMode(raw: boolean): PassThrough;
    };
    input.isRaw = false;
    input.isTTY = true;
    const setRawMode = vi.fn((raw: boolean): PassThrough => {
      input.isRaw = raw;
      return input;
    });
    input.setRawMode = setRawMode;
    const outputText: string[] = [];
    const hiddenInput = createHiddenInput(input, {
      write: (text: string) => outputText.push(text),
    });
    return { hiddenInput, input, outputText, setRawMode };
  }

  it('suppresses password echo and restores terminal mode after success', async () => {
    const { hiddenInput, input, outputText, setRawMode } = terminal();
    const reading = hiddenInput.read('密码: ');
    input.write('top secret\r');

    await expect(reading).resolves.toBe('top secret');
    expect(outputText.join('')).toBe('密码: \n');
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.isRaw).toBe(false);
  });

  it('restores terminal mode when Ctrl-C aborts secret input', async () => {
    const { hiddenInput, input, setRawMode } = terminal();
    const reading = hiddenInput.read('密码: ');
    input.write('\x03');

    await expect(reading).rejects.toThrow('密码输入已取消');
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.isRaw).toBe(false);
  });

  it('restores terminal mode and hides details when terminal setup fails', async () => {
    const { hiddenInput, input, setRawMode } = terminal();
    setRawMode.mockImplementation((raw: boolean): PassThrough => {
      input.isRaw = raw;
      if (raw) throw new Error('sensitive terminal detail');
      return input;
    });

    const reading = hiddenInput.read('密码: ');

    await expect(reading).rejects.toThrow('密码输入失败');
    await expect(reading).rejects.not.toThrow('sensitive terminal detail');
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.isRaw).toBe(false);
  });

  it('rejects a concurrent read without touching the active terminal and allows later reads', async () => {
    const { hiddenInput, input, setRawMode } = terminal();
    const first = hiddenInput.read('密码: ');
    const keypressListeners = input.listenerCount('keypress');

    const concurrent = hiddenInput.read('确认密码: ');

    await expect(concurrent).rejects.toThrow('密码输入失败');
    expect(input.listenerCount('keypress')).toBe(keypressListeners);
    expect(setRawMode.mock.calls).toEqual([[true]]);
    input.write('first secret\r');
    await expect(first).resolves.toBe('first secret');
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);

    const later = hiddenInput.read('密码: ');
    input.write('later secret\r');
    await expect(later).resolves.toBe('later secret');
    expect(setRawMode.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it.each(['isTTY', 'isRaw', 'isPaused', 'setRawMode'] as const)(
    'turns an initial %s access failure into a stable error',
    async (state) => {
      const { hiddenInput, input } = terminal();
      const fail = () => {
        throw new Error(`sensitive ${state} detail`);
      };
      if (state === 'isPaused') {
        input.isPaused = fail;
      } else {
        Object.defineProperty(input, state, { configurable: true, get: fail });
      }

      const reading = Promise.resolve().then(() => hiddenInput.read('密码: '));

      await expect(reading).rejects.toThrow('密码输入失败');
      await expect(reading).rejects.not.toThrow(`sensitive ${state} detail`);
    },
  );

  it('continues restoring pause state when raw mode restoration fails', async () => {
    const { hiddenInput, input, setRawMode } = terminal();
    const pause = vi.spyOn(input, 'pause');
    input.pause();
    pause.mockClear();
    setRawMode.mockImplementation((raw: boolean): PassThrough => {
      if (!raw) throw new Error('sensitive raw restore detail');
      input.isRaw = raw;
      return input;
    });

    const reading = hiddenInput.read('密码: ');
    input.write('top secret\r');

    await expect(reading).rejects.toThrow('密码输入失败');
    await expect(reading).rejects.not.toThrow('sensitive raw restore detail');
    expect(pause).toHaveBeenCalledOnce();
  });
});

describe('visible terminal input', () => {
  function visibleTerminal() {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;
    return { input, output, visibleInput: createVisibleInput(input, output) };
  }

  async function settleWithin<T>(promise: Promise<T>): Promise<T> {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('visible input did not settle')), 100);
      }),
    ]);
  }

  it('resolves only after receiving an answer and cleans up listeners', async () => {
    const { input, visibleInput } = visibleTerminal();
    const reading = visibleInput.readLine('用户名: ');
    input.write('owner\n');

    await expect(settleWithin(reading)).resolves.toBe('owner');
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
  });

  it('rejects a username prompt on EOF instead of hanging', async () => {
    const { input, visibleInput } = visibleTerminal();
    const reading = visibleInput.readLine('用户名: ');
    input.end();

    await expect(settleWithin(reading)).rejects.toThrow('用户名输入失败');
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
  });

  it('rejects when the input stream closes without an answer', async () => {
    const { input, visibleInput } = visibleTerminal();
    const reading = visibleInput.readLine('用户名: ');
    input.emit('close');

    await expect(settleWithin(reading)).rejects.toThrow('用户名输入失败');
    expect(input.listenerCount('close')).toBe(0);
  });

  it('turns input errors into a stable rejection and removes listeners', async () => {
    const { input, visibleInput } = visibleTerminal();
    const reading = visibleInput.readLine('用户名: ');
    input.emit('error', new Error('sensitive visible input detail'));

    await expect(settleWithin(reading)).rejects.toThrow('用户名输入失败');
    await expect(settleWithin(reading)).rejects.not.toThrow('sensitive visible input detail');
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
  });

  it('rejects SIGINT and cleans up the readline interface', async () => {
    const { input, visibleInput } = visibleTerminal();
    const reading = visibleInput.readLine('用户名: ');
    input.write('\x03');

    await expect(settleWithin(reading)).rejects.toThrow('用户名输入失败');
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
  });
});

describe('CLI lifecycle', () => {
  function runtime(overrides: Partial<CliRuntime> = {}): CliRuntime {
    return {
      input: { argv: [], readLine: vi.fn(async () => '') },
      output: { write: vi.fn() },
      hiddenInput: { read: vi.fn(async () => '') },
      loadConfig: vi.fn(() => ({ migrationsRoot: '/migrations' }) as never),
      openDatabase: vi.fn(),
      runMigrations: vi.fn(),
      runAdminCommand: vi.fn(async () => 0),
      now: () => '2026-09-01T00:00:00.000Z',
      randomId: () => 'admin-id',
      ...overrides,
    };
  }

  it('does not load configuration or open a database for help', async () => {
    const dependencies = runtime();

    await expect(runCli(['--help'], dependencies)).resolves.toBe(0);

    expect(dependencies.runAdminCommand).toHaveBeenCalledOnce();
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
    expect(dependencies.openDatabase).not.toHaveBeenCalled();
    expect(dependencies.runMigrations).not.toHaveBeenCalled();
  });

  it('closes the database after a real command succeeds', async () => {
    const close = vi.fn();
    const db = { close } as unknown as Database.Database;
    const dependencies = runtime({ openDatabase: vi.fn(() => db) });

    await expect(runCli(['admin', 'create'], dependencies)).resolves.toBe(0);

    expect(dependencies.runMigrations).toHaveBeenCalledWith(db, '/migrations');
    expect(dependencies.runAdminCommand).toHaveBeenCalledWith(
      expect.objectContaining({ db, input: expect.objectContaining({ argv: ['admin', 'create'] }) }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns a safe failure and closes the database when command execution throws', async () => {
    const close = vi.fn();
    const db = { close } as unknown as Database.Database;
    const output = { write: vi.fn() };
    const dependencies = runtime({
      output,
      openDatabase: vi.fn(() => db),
      runAdminCommand: vi.fn(async () => {
        throw new Error('sensitive runtime detail');
      }),
    });

    await expect(runCli(['admin', 'reset-password'], dependencies)).resolves.toBe(1);

    expect(close).toHaveBeenCalledOnce();
    expect(output.write).toHaveBeenCalledWith('管理员命令执行失败\n');
    expect(output.write).not.toHaveBeenCalledWith(expect.stringContaining('sensitive runtime detail'));
  });

  it('returns a safe failure when closing the database throws', async () => {
    const close = vi.fn(() => {
      throw new Error('sensitive close detail');
    });
    const db = { close } as unknown as Database.Database;
    const output = { write: vi.fn() };
    const dependencies = runtime({ output, openDatabase: vi.fn(() => db) });

    await expect(runCli(['admin', 'create'], dependencies)).resolves.toBe(1);

    expect(close).toHaveBeenCalledOnce();
    expect(output.write).toHaveBeenCalledWith('管理员命令执行失败\n');
    expect(output.write).not.toHaveBeenCalledWith(expect.stringContaining('sensitive close detail'));
  });

  it('returns a safe failure and closes the database when username input reaches EOF', async () => {
    const inputStream = new PassThrough() as PassThrough & { isTTY: boolean };
    const promptOutput = new PassThrough() as PassThrough & { isTTY: boolean };
    inputStream.isTTY = true;
    promptOutput.isTTY = true;
    const close = vi.fn();
    const db = { close } as unknown as Database.Database;
    const output = { write: vi.fn() };
    const dependencies = runtime({
      input: createVisibleInput(inputStream, promptOutput),
      output,
      openDatabase: vi.fn(() => db),
      runAdminCommand,
    });

    const running = runCli(['admin', 'create'], dependencies);
    inputStream.end();

    await expect(running).resolves.toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(output.write).toHaveBeenCalledWith('管理员命令执行失败\n');
  });
});
