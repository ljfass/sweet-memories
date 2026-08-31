import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';

import {
  runAdminCommand,
  type AdminCommandInput,
  type AdminCommandOptions,
  type AdminCommandOutput,
  type HiddenInput,
} from './cli/admin.js';
import { loadConfig, type ApiConfig } from './config.js';
import { openDatabase } from './database.js';
import { runMigrations } from './migrations.js';

interface HiddenInputStream extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  isRaw?: boolean;
  isPaused(): boolean;
  setRawMode?(mode: boolean): unknown;
}

interface Key {
  readonly ctrl?: boolean;
  readonly name?: string;
}

export function createHiddenInput(
  input: HiddenInputStream,
  output: AdminCommandOutput,
): HiddenInput {
  return {
    read(prompt: string): Promise<string> {
      if (input.isTTY !== true || input.setRawMode === undefined) {
        return Promise.reject(new Error('密码输入需要交互终端'));
      }
      const setRawMode = input.setRawMode;

      return new Promise((resolvePassword, rejectPassword) => {
        const initiallyRaw = input.isRaw === true;
        const initiallyPaused = input.isPaused();
        let value = '';
        let settled = false;
        const inputFailure = () => new Error('密码输入失败');

        const restore = () => {
          input.removeListener('keypress', onKeypress);
          input.removeListener('error', onInputError);
          input.removeListener('end', onInputEnd);
          setRawMode.call(input, initiallyRaw);
          if (initiallyPaused) {
            input.pause();
          }
        };
        const finish = (result: { value: string } | { error: Error }) => {
          if (settled) return;
          settled = true;
          let error = 'error' in result ? result.error : undefined;
          try {
            output.write('\n');
          } catch {
            error = inputFailure();
          }
          try {
            restore();
          } catch {
            error = inputFailure();
          }
          if (error !== undefined) rejectPassword(error);
          else if ('value' in result) resolvePassword(result.value);
        };
        const onInputError = () => finish({ error: inputFailure() });
        const onInputEnd = () => finish({ error: inputFailure() });
        const onKeypress = (character: string | undefined, key: Key | undefined) => {
          if ((key?.ctrl === true && key.name === 'c') || character === '\u0003') {
            finish({ error: new Error('密码输入已取消') });
            return;
          }
          if (key?.name === 'return' || key?.name === 'enter' || character === '\r' || character === '\n') {
            finish({ value });
            return;
          }
          if (key?.name === 'backspace') {
            value = Array.from(value).slice(0, -1).join('');
            return;
          }
          if (character !== undefined && key?.ctrl !== true && key?.name !== 'escape') {
            value += character;
          }
        };

        try {
          output.write(prompt);
          emitKeypressEvents(input);
          input.on('keypress', onKeypress);
          input.once('error', onInputError);
          input.once('end', onInputEnd);
          setRawMode.call(input, true);
          input.resume();
        } catch {
          try {
            restore();
          } catch {
            // The caller receives one stable error even when restoration itself fails.
          }
          rejectPassword(inputFailure());
        }
      });
    },
  };
}

function createVisibleInput(): AdminCommandInput {
  return {
    argv: [],
    async readLine(prompt: string): Promise<string> {
      const interface_ = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise<string>((resolveLine) => interface_.question(prompt, resolveLine));
      } finally {
        interface_.close();
      }
    },
  };
}

export interface CliRuntime {
  readonly input: AdminCommandInput;
  readonly output: AdminCommandOutput;
  readonly hiddenInput: HiddenInput;
  readonly loadConfig: () => Readonly<ApiConfig>;
  readonly openDatabase: (config: ApiConfig) => Database.Database;
  readonly runMigrations: (db: Database.Database, migrationsRoot: string) => void;
  readonly runAdminCommand: (options: AdminCommandOptions) => Promise<number>;
  readonly now: () => string;
  readonly randomId: () => string;
}

function defaultRuntime(): CliRuntime {
  const output: AdminCommandOutput = { write: (text) => process.stdout.write(text) };
  return {
    input: createVisibleInput(),
    output,
    hiddenInput: createHiddenInput(process.stdin, output),
    loadConfig,
    openDatabase,
    runMigrations,
    runAdminCommand,
    now: () => new Date().toISOString(),
    randomId: randomUUID,
  };
}

function needsDatabase(argv: readonly string[]): boolean {
  return (
    argv.length === 2 &&
    argv[0] === 'admin' &&
    (argv[1] === 'create' || argv[1] === 'reset-password')
  );
}

export async function runCli(
  argv: readonly string[],
  runtime: CliRuntime = defaultRuntime(),
): Promise<number> {
  const input = { ...runtime.input, argv };
  if (!needsDatabase(argv)) {
    return runtime.runAdminCommand({
      input,
      output: runtime.output,
      hiddenInput: runtime.hiddenInput,
      now: runtime.now,
      randomId: runtime.randomId,
    });
  }

  let db: Database.Database | undefined;
  try {
    const config = runtime.loadConfig();
    db = runtime.openDatabase(config);
    runtime.runMigrations(db, config.migrationsRoot);
    return await runtime.runAdminCommand({
      input,
      output: runtime.output,
      hiddenInput: runtime.hiddenInput,
      db,
      now: runtime.now,
      randomId: runtime.randomId,
    });
  } catch {
    runtime.output.write('管理员命令执行失败\n');
    return 1;
  } finally {
    db?.close();
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectExecution()) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
