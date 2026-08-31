import type Database from 'better-sqlite3';

import { hashPassword, validatePassword } from '../auth/passwords.js';
import {
  AdminRepositoryError,
  createAdmin,
  findAdminByUsername,
  isValidAdminUsername,
  resetAdminPassword,
} from '../repositories/admins.js';

export interface AdminCommandInput {
  readonly argv: readonly string[];
  readLine(prompt: string): Promise<string>;
}

export interface AdminCommandOutput {
  write(text: string): void;
}

export interface HiddenInput {
  read(prompt: string): Promise<string>;
}

export interface AdminCommandOptions {
  readonly input: AdminCommandInput;
  readonly output: AdminCommandOutput;
  readonly hiddenInput: HiddenInput;
  readonly db?: Database.Database;
  readonly now: () => string;
  readonly randomId: () => string;
}

export const adminHelp = `用法:
  sweet-memories admin create
  sweet-memories admin reset-password
`;

type AdminAction = 'create' | 'reset-password';

function requestedAction(argv: readonly string[]): AdminAction | undefined {
  if (argv.length !== 2 || argv[0] !== 'admin') {
    return undefined;
  }
  return argv[1] === 'create' || argv[1] === 'reset-password' ? argv[1] : undefined;
}

function writeError(output: AdminCommandOutput, message: string): number {
  output.write(`${message}\n`);
  return 1;
}

function repositoryMessage(error: AdminRepositoryError): string {
  switch (error.code) {
    case 'ADMIN_ALREADY_EXISTS':
    case 'ADMIN_NOT_FOUND':
      return error.message;
    case 'ADMIN_CREATE_FAILED':
      return '无法创建管理员';
    case 'ADMIN_RESET_FAILED':
      return '无法重置管理员密码';
  }
}

async function withNewPassword(
  hiddenInput: HiddenInput,
  output: AdminCommandOutput,
  usePassword: (password: string) => Promise<number>,
): Promise<number | undefined> {
  const secrets: { password: string | null; confirmation: string | null } = {
    password: null,
    confirmation: null,
  };

  try {
    secrets.password = await hiddenInput.read('密码: ');
    secrets.confirmation = await hiddenInput.read('确认密码: ');
    if (secrets.password !== secrets.confirmation) {
      writeError(output, '两次密码输入不一致');
      return undefined;
    }
    if (!validatePassword(secrets.password)) {
      writeError(output, '密码长度必须为 12 到 256 个字符');
      return undefined;
    }
    return await usePassword(secrets.password);
  } finally {
    secrets.password = null;
    secrets.confirmation = null;
  }
}

export async function runAdminCommand(options: AdminCommandOptions): Promise<number> {
  const { argv } = options.input;
  if (argv.length === 1 && argv[0] === '--help') {
    options.output.write(adminHelp);
    return 0;
  }

  const action = requestedAction(argv);
  if (action === undefined) {
    options.output.write(adminHelp);
    return 1;
  }
  const db = options.db;
  if (db === undefined) {
    return writeError(options.output, '管理员命令执行失败');
  }

  const username = await options.input.readLine('用户名: ');
  if (!isValidAdminUsername(username)) {
    return writeError(options.output, '用户名格式无效');
  }

  if (action === 'create' && findAdminByUsername(db, username) !== undefined) {
    return writeError(options.output, `管理员已存在: ${username}`);
  }
  if (action === 'reset-password' && findAdminByUsername(db, username) === undefined) {
    return writeError(options.output, `管理员不存在: ${username}`);
  }

  const result = await withNewPassword(options.hiddenInput, options.output, async (password) => {
    try {
      const passwordHash = await hashPassword(password);
      if (action === 'create') {
        createAdmin(db, {
          id: options.randomId(),
          username,
          passwordHash,
          timestamp: options.now(),
        });
        options.output.write(`管理员 ${username} 创建成功\n`);
      } else {
        resetAdminPassword(db, {
          username,
          passwordHash,
          timestamp: options.now(),
        });
        options.output.write(`管理员 ${username} 密码重置成功\n`);
      }
      return 0;
    } catch (error) {
      if (error instanceof AdminRepositoryError) {
        return writeError(options.output, repositoryMessage(error));
      }
      return writeError(
        options.output,
        action === 'create' ? '无法创建管理员' : '无法重置管理员密码',
      );
    }
  });
  return result ?? 1;
}
