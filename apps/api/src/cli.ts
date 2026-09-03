import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

import {
  runAdminCommand,
  type AdminCommandInput,
  type AdminCommandOptions,
  type AdminCommandOutput,
  type HiddenInput,
} from './cli/admin.js';
import {
  databaseHelp,
  isDatabaseCommand,
  isDatabaseCommandNamespace,
  runDatabaseCommand,
  type DatabaseCommandOptions,
} from './cli/database.js';
import {
  isDatabaseManagementCommand,
  isManagementCommandNamespace,
  migrationHelp,
  runMigrationCommand,
  type MigrationCommandOptions,
} from './cli/migration.js';
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
  let active = false;

  return {
    read(prompt: string): Promise<string> {
      if (active) {
        return Promise.reject(new Error('密码输入失败'));
      }
      active = true;

      let initiallyRaw: boolean;
      let initiallyPaused: boolean;
      let setRawMode: (mode: boolean) => unknown;
      try {
        if (input.isTTY !== true || input.setRawMode === undefined) {
          active = false;
          return Promise.reject(new Error('密码输入需要交互终端'));
        }
        setRawMode = input.setRawMode;
        initiallyRaw = input.isRaw === true;
        initiallyPaused = input.isPaused();
      } catch {
        active = false;
        return Promise.reject(new Error('密码输入失败'));
      }

      return new Promise((resolvePassword, rejectPassword) => {
        let value = '';
        let settled = false;
        const inputFailure = () => new Error('密码输入失败');

        const restore = (): boolean => {
          let failed = false;
          for (const [event, listener] of [
            ['keypress', onKeypress],
            ['error', onInputError],
            ['end', onInputEnd],
          ] as const) {
            try {
              input.removeListener(event, listener);
            } catch {
              failed = true;
            }
          }
          try {
            setRawMode.call(input, initiallyRaw);
          } catch {
            failed = true;
          }
          if (initiallyPaused) {
            try {
              input.pause();
            } catch {
              failed = true;
            }
          }
          active = false;
          return failed;
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
          if (restore()) {
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
          emitKeypressEvents(input);
          input.on('keypress', onKeypress);
          input.once('error', onInputError);
          input.once('end', onInputEnd);
          setRawMode.call(input, true);
          output.write(prompt);
          input.resume();
        } catch {
          restore();
          rejectPassword(inputFailure());
        }
      });
    },
  };
}

export function createVisibleInput(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): AdminCommandInput {
  return {
    argv: [],
    readLine(prompt: string): Promise<string> {
      return new Promise((resolveLine, rejectLine) => {
        let interface_: ReturnType<typeof createInterface>;
        const existingDataListeners = new Set(input.rawListeners('data'));
        try {
          interface_ = createInterface({ input, output, terminal: false });
        } catch {
          rejectLine(new Error('用户名输入失败'));
          return;
        }
        const readlineDataListeners = input
          .rawListeners('data')
          .filter((listener) => !existingDataListeners.has(listener)) as Array<
          (...args: unknown[]) => void
        >;

        let settled = false;
        const cleanup = () => {
          interface_.removeListener('close', onClose);
          interface_.removeListener('error', onError);
          interface_.removeListener('SIGINT', onSigint);
          input.removeListener('data', onInputData);
          input.removeListener('close', onClose);
          input.removeListener('error', onError);
          try {
            interface_.close();
          } finally {
            for (const listener of readlineDataListeners) {
              input.removeListener('data', listener);
            }
          }
        };
        const finish = (answer?: string) => {
          if (settled) return;
          settled = true;
          let cleanupFailed = false;
          try {
            cleanup();
          } catch {
            cleanupFailed = true;
          }
          if (answer !== undefined && !cleanupFailed) {
            resolveLine(answer);
          } else {
            rejectLine(new Error('用户名输入失败'));
          }
        };
        const onClose = () => finish();
        const onError = () => finish();
        const onSigint = () => finish();
        function onInputData(chunk: unknown): void {
          if (String(chunk).includes('\u0003')) finish();
        }

        interface_.once('close', onClose);
        interface_.once('error', onError);
        interface_.once('SIGINT', onSigint);
        input.on('data', onInputData);
        input.once('close', onClose);
        input.once('error', onError);
        try {
          interface_.question(prompt, (answer) => finish(answer));
        } catch {
          finish();
        }
      });
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
  readonly runDatabaseCommand?: (options: DatabaseCommandOptions) => Promise<number>;
  readonly runMigrationCommand?: (options: MigrationCommandOptions) => Promise<number>;
  readonly seedRoot?: string;
  readonly now: () => string;
  readonly randomId: () => string;
}

function defaultSeedRoot(): string {
  return fileURLToPath(new URL('../seed', import.meta.url));
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
    runDatabaseCommand,
    runMigrationCommand,
    seedRoot: defaultSeedRoot(),
    now: () => new Date().toISOString(),
    randomId: randomUUID,
  };
}

function needsDatabase(argv: readonly string[]): boolean {
  return (
    (
      argv.length === 2 &&
      argv[0] === 'admin' &&
      (argv[1] === 'create' || argv[1] === 'reset-password')
    ) || isDatabaseManagementCommand(argv) || isDatabaseCommand(argv)
  );
}

export async function runCli(
  argv: readonly string[],
  runtime: CliRuntime = defaultRuntime(),
): Promise<number> {
  const input = { ...runtime.input, argv };
  const reportFailure = () => {
    try {
      runtime.output.write('管理员命令执行失败\n');
    } catch {
      // A failed output stream must not turn cleanup into an unhandled rejection.
    }
  };
  if (isManagementCommandNamespace(argv) && !isDatabaseManagementCommand(argv)) {
    try {
      runtime.output.write(migrationHelp);
      return 1;
    } catch {
      reportFailure();
      return 1;
    }
  }
  if (isDatabaseCommandNamespace(argv) && !isDatabaseCommand(argv)) {
    try {
      runtime.output.write(databaseHelp);
      return 1;
    } catch {
      reportFailure();
      return 1;
    }
  }
  if (!needsDatabase(argv)) {
    try {
      return await runtime.runAdminCommand({
        input,
        output: runtime.output,
        hiddenInput: runtime.hiddenInput,
        now: runtime.now,
        randomId: runtime.randomId,
      });
    } catch {
      reportFailure();
      return 1;
    }
  }

  let db: Database.Database | undefined;
  let result: number;
  try {
    const config = runtime.loadConfig();
    db = runtime.openDatabase(config);
    if (isDatabaseCommand(argv)) {
      result = await (runtime.runDatabaseCommand ?? runDatabaseCommand)({
        argv,
        output: runtime.output,
        db,
        dataRoot: config.dataRoot,
        migrationsRoot: config.migrationsRoot,
        migrate: runtime.runMigrations,
      });
    } else {
      runtime.runMigrations(db, config.migrationsRoot);
      if (isDatabaseManagementCommand(argv)) {
        result = await (runtime.runMigrationCommand ?? runMigrationCommand)({
          argv,
          output: runtime.output,
          db,
          seedRoot: runtime.seedRoot ?? defaultSeedRoot(),
          mediaRoot: config.mediaRoot,
          now: runtime.now,
        });
      } else {
        result = await runtime.runAdminCommand({
          input,
          output: runtime.output,
          hiddenInput: runtime.hiddenInput,
          db,
          now: runtime.now,
          randomId: runtime.randomId,
        });
      }
    }
  } catch {
    reportFailure();
    result = 1;
  }
  if (db !== undefined) {
    try {
      db.close();
    } catch {
      reportFailure();
      result = 1;
    }
  }
  return result;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return (
      realpathSync.native(fileURLToPath(import.meta.url)) ===
      realpathSync.native(resolve(entry))
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void runCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      try {
        process.stdout.write('管理员命令执行失败\n');
      } catch {
        // Nothing else can be reported safely when stdout itself has failed.
      }
      process.exitCode = 1;
    },
  );
}
