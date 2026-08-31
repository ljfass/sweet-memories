# 管理员图片上传功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有单服务器 Vue 相册中增加安全的管理员登录、图片上传管理、SQLite 持久化、公开 API、可回退部署和本地备份，并通过两阶段上线保证现有五张照片不断站、不丢失。

**Architecture:** 保留 Nginx 静态前端发布链路，在同一仓库增加 `apps/api` pnpm 工作区；Fastify API 只监听 `127.0.0.1:3100`，SQLite 和媒体文件放在 `/var/lib/sweet-memories`，Nginx 代理 `/api` 并只读提供 `/media`。源码中的 `src/config/album-source.json` 决定公开前端使用静态五张照片还是 `/api/photos`，从而把准备发布与最终激活拆开。

**Tech Stack:** Node.js 24、pnpm 8.6.1、TypeScript 6、Fastify 5.12.1、`@fastify/cookie` 11.1.2、`@fastify/multipart` 10.1.1、better-sqlite3 13.0.3、argon2 0.45.1、Sharp 0.35.4、exifr 7.1.3、file-type 22.0.2、Vue 3.5、Vitest 4、Bash、systemd、Nginx、libheif `heif-info`/`heif-convert`

**Design spec:** `docs/superpowers/specs/2026-08-31-photo-upload-design.md`

**Implementation references:** [Fastify 5.12 documentation](https://fastify.dev/docs/v5.12.x/)、[Sharp installation](https://sharp.pixelplumbing.com/install/)、[Ubuntu 24.04 libheif-examples files](https://packages.ubuntu.com/noble/all/libheif-examples/filelist)、[Node.js 24.20.0 release files](https://nodejs.org/download/release/v24.20.0/)

---

## 实施边界和生产门槛

本计划按任务顺序执行，并设置两个发布里程碑及其人工/验收门槛：

1. **准备发布：** 完成任务 1-23，`album-source.json` 保持 `static`。API、后台和五张迁移记录上线，上传关闭，公开相册仍读取当前静态数组。
2. **人工数据门槛：** 管理员在 `/admin` 为五张旧照片填写真实或大致拍摄日期，服务器 readiness 命令必须通过。
3. **激活发布：** 执行任务 24，把 `album-source.json` 改为 `api` 后发布。工作流先激活旧记录，再切前端，公网检查通过后才开放上传。
4. **激活验收：** 执行任务 25；失败时自动回退前端并保持上传关闭。

任务 24 之前不得把生产环境的公开相册切到 API，也不得手工开启上传。

## 文件规划

### 工作区和 API

- 创建 `pnpm-workspace.yaml`：声明 `apps/*` 工作区。
- 创建 `apps/api/package.json`、`apps/api/tsconfig.json`：锁定 API 依赖和 Node ESM 构建。
- 创建 `apps/api/migrations/001_initial.sql`：定义管理员、会话、登录失败、设置、照片和媒体清单。
- 创建 `apps/api/src/config.ts`、`database.ts`、`migrations.ts`、`errors.ts`、`types.ts`：配置、SQLite、迁移、稳定错误和领域类型。
- 创建 `apps/api/src/repositories/*`：管理员、会话、登录限制、照片和设置的数据访问。
- 创建 `apps/api/src/auth/*`：密码、令牌、登录限制、会话生命周期、Origin 和 CSRF。
- 创建 `apps/api/src/media/*`：格式识别、HEIC 解码、EXIF 日期、处理队列、响应式输出和文件事务。
- 创建 `apps/api/src/services/*`：照片、迁移、删除、维护和备份用例。
- 创建 `apps/api/src/routes/*`、`app.ts`、`index.ts`、`cli.ts`：HTTP 边界、进程入口和交互式命令。
- 在上述目录创建同名 `*.test.ts`，所有服务端测试使用 `// @vitest-environment node`。

### 前端

- 创建 `src/config/album-source.json`：唯一允许值为 `static` 或 `api`，初始为 `static`。
- 创建 `src/services/photoApi.ts`、`src/composables/usePublicMemories.ts`：公开 DTO 校验、映射、加载和重试。
- 创建 `src/admin/*`：后台 API 客户端、会话状态、上传队列、登录、照片库、编辑器、重新登录对话框和后台根组件。
- 创建 `src/styles/admin.css`：独立后台响应式样式。
- 修改 `src/App.vue`、`src/main.ts`、`src/types/album.ts`：公开异步数据源和 `/admin` 入口。
- 修改相应 Vitest 文件并新增后台组件测试。

### 部署、运维和文档

- 创建 `scripts/deploy/manage-api-release.sh` 及 Shell 集成测试：API 版本切换、快照、回退和清理。
- 创建 `scripts/deploy/package-api.sh`：生成 Linux API 发布包。
- 创建 `ops/systemd/sweet-memories-api.service`、`ops/nginx/sweet-memories-api.conf`、`ops/sudoers/sweet-memories-api`：服务器模板。
- 修改 `.github/workflows/deploy.yml` 和 `scripts/deploy/workflow.test.ts`：API 构建发布、两阶段激活、失败回退和上传开关。
- 创建 `scripts/ops/backup-data.sh`、`restore-data.sh` 及测试：一致性备份和维护模式恢复。
- 创建 `scripts/monitor/check-photo-api.mjs` 及测试；修改站点巡检工作流。
- 创建 `docs/photo-upload-operations.md` 和合同测试：服务器安装、管理员初始化、迁移、备份、恢复、激活和回退。

## 任务 1：建立独立 API 工作区和质量命令

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `scripts/api/workspace.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `eslint.config.js`

- [ ] **Step 1: 写工作区合同测试**

创建 `scripts/api/workspace.test.ts`，用 `yaml` 和 JSON 解析器断言工作区只增加 `apps/*`，API package 名称为 `@sweet-memories/api`，Node engine 为 `>=24 <25`，依赖使用以下精确版本：

```ts
const expectedDependencies = {
  '@fastify/cookie': '11.1.2',
  '@fastify/multipart': '10.1.1',
  argon2: '0.45.1',
  'better-sqlite3': '13.0.3',
  exifr: '7.1.3',
  fastify: '5.12.1',
  'file-type': '22.0.2',
  sharp: '0.35.4',
}

expect(apiPackage.dependencies).toEqual(expectedDependencies)
expect(apiPackage.scripts).toMatchObject({
  build: 'tsc -p tsconfig.json',
  typecheck: 'tsc -p tsconfig.json --noEmit',
  test: 'vitest run src',
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run scripts/api/workspace.test.ts`

Expected: FAIL，指出 `pnpm-workspace.yaml` 或 `apps/api/package.json` 不存在。

- [ ] **Step 3: 创建工作区清单**

`pnpm-workspace.yaml`：

```yaml
packages:
  - 'apps/*'
```

`apps/api/package.json`：

```json
{
  "name": "@sweet-memories/api",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24 <25" },
  "files": ["dist", "migrations", "seed"],
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run src"
  },
  "dependencies": {
    "@fastify/cookie": "11.1.2",
    "@fastify/multipart": "10.1.1",
    "argon2": "0.45.1",
    "better-sqlite3": "13.0.3",
    "exifr": "7.1.3",
    "fastify": "5.12.1",
    "file-type": "22.0.2",
    "sharp": "0.35.4"
  },
  "devDependencies": {
    "@types/better-sqlite3": "9.6.0",
    "@types/node": "24.13.3",
    "typescript": "6.0.3",
    "vitest": "4.1.11"
  }
}
```

`apps/api/tsconfig.json` 使用 `NodeNext`、`ES2023`、`strict`、`noUncheckedIndexedAccess`，输入 `src/**/*.ts`，输出到 `dist`。

- [ ] **Step 4: 接入根质量命令和 ESLint Node 环境**

把根脚本改为：

```json
{
  "typecheck": "vue-tsc --noEmit -p tsconfig.app.json && pnpm --dir apps/api typecheck",
  "build:frontend": "vite build",
  "build:api": "pnpm --dir apps/api build",
  "build": "pnpm build:frontend && pnpm build:api",
  "test:api": "pnpm --dir apps/api test"
}
```

在 `eslint.config.js` 的 Node 文件 glob 中加入 `apps/api/src/**/*.ts`。

- [ ] **Step 5: 安装并验证 GREEN**

Run:

```bash
pnpm install
pnpm exec vitest run scripts/api/workspace.test.ts
pnpm --dir apps/api typecheck
pnpm lint
```

Expected: 合同测试通过，API 空项目类型检查通过，ESLint 0 warning。

- [ ] **Step 6: 提交工作区基础**

```bash
git add pnpm-workspace.yaml apps/api/package.json apps/api/tsconfig.json scripts/api/workspace.test.ts package.json pnpm-lock.yaml eslint.config.js
git commit -m "build: add photo API workspace"
```

## 任务 2：实现严格配置、SQLite 连接和版本迁移

**Files:**
- Create: `apps/api/src/config.ts`
- Create: `apps/api/src/config.test.ts`
- Create: `apps/api/src/database.ts`
- Create: `apps/api/src/migrations.ts`
- Create: `apps/api/src/migrations.test.ts`
- Create: `apps/api/migrations/001_initial.sql`
- Create: `apps/api/src/errors.ts`
- Create: `apps/api/src/types.ts`

- [ ] **Step 1: 写配置和迁移失败测试**

测试必须覆盖：非 HTTPS 生产 Origin 被拒绝、监听地址不是回环地址被拒绝、相对数据目录被拒绝、空库迁移后表和索引完整、重复迁移不改变版本、数据库启用 foreign keys/WAL/busy timeout。

```ts
expect(() => loadConfig({
  NODE_ENV: 'production',
  SWEET_MEMORIES_ORIGIN: 'http://huangjianfen.cn',
  SWEET_MEMORIES_DATA_ROOT: '/tmp/data',
})).toThrow('生产环境 Origin 必须使用 HTTPS')

expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
expect(listTables(db)).toEqual(expect.arrayContaining([
  'admins', 'sessions', 'login_attempts', 'settings', 'photos', 'photo_assets',
]))
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run apps/api/src/config.test.ts apps/api/src/migrations.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 定义配置和领域类型**

`config.ts` 导出不可变 `ApiConfig`，只接受以下环境变量和默认值：

```ts
export interface ApiConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: '127.0.0.1'
  port: number
  origin: string
  dataRoot: string
  databasePath: string
  mediaRoot: string
  stagingRoot: string
  backupRoot: string
  migrationsRoot: string
  heifInfoPath: string
  heifConvertPath: string
  cookieSecure: boolean
}
```

生产默认值为端口 `3100`、数据根 `/var/lib/sweet-memories`、Origin `https://huangjianfen.cn`、HEIF 工具 `/usr/bin/heif-info` 和 `/usr/bin/heif-convert`。测试必须显式传临时目录，不能触碰生产路径。

- [ ] **Step 4: 写第一版 SQL schema**

`001_initial.sql` 创建：

```sql
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL
);
CREATE INDEX sessions_admin_id_idx ON sessions(admin_id);
CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO settings(key, value, updated_at)
VALUES ('uploads_enabled', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  captured_date TEXT CHECK (captured_date IS NULL OR captured_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('migration_pending', 'published')),
  rotation INTEGER NOT NULL CHECK (rotation BETWEEN -6 AND 6),
  offset_x INTEGER NOT NULL CHECK (offset_x BETWEEN -16 AND 16),
  offset_y INTEGER NOT NULL CHECK (offset_y BETWEEN -16 AND 16),
  request_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX photos_public_order_idx
ON photos(status, captured_date, created_at, id);
CREATE TABLE photo_assets (
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('master', 'responsive')),
  format TEXT NOT NULL CHECK (format IN ('avif', 'webp', 'jpeg')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  relative_path TEXT NOT NULL UNIQUE,
  PRIMARY KEY(photo_id, kind, format, width)
);
```

- [ ] **Step 5: 实现迁移器和数据库工厂**

`openDatabase(config)` 创建目录后设置：

```ts
db.pragma('foreign_keys = ON')
db.pragma('journal_mode = WAL')
db.pragma('synchronous = FULL')
db.pragma('busy_timeout = 5000')
```

`runMigrations(db, migrationsRoot)` 按文件名排序，只接受 `NNN_name.sql`，每个文件在事务中执行并写入 `schema_migrations`；已记录版本跳过，读取失败或 SQL 失败保持原版本。

- [ ] **Step 6: 验证并提交**

Run:

```bash
pnpm exec vitest run apps/api/src/config.test.ts apps/api/src/migrations.test.ts
pnpm --dir apps/api typecheck
pnpm lint
```

Expected: 全部通过。

```bash
git add apps/api/src apps/api/migrations
git commit -m "feat: add photo API database foundation"
```

## 任务 3：实现管理员密码和交互式初始化命令

**Files:**
- Create: `apps/api/src/repositories/admins.ts`
- Create: `apps/api/src/auth/passwords.ts`
- Create: `apps/api/src/auth/passwords.test.ts`
- Create: `apps/api/src/cli/admin.ts`
- Create: `apps/api/src/cli/admin.test.ts`
- Create: `apps/api/src/cli.ts`

- [ ] **Step 1: 写密码和 CLI RED 测试**

覆盖用户名 `[a-z][a-z0-9_-]{2,31}`、密码 12-256 字符、二次输入不一致、Argon2id 哈希不含明文、创建同名管理员失败、重置密码使旧密码失效并删除该管理员的全部旧会话。

```ts
const hash = await hashPassword('correct horse battery staple')
expect(hash).toMatch(/^\$argon2id\$/)
expect(hash).not.toContain('correct horse battery staple')
expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true)
expect(await verifyPassword(hash, 'wrong password')).toBe(false)
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run apps/api/src/auth/passwords.test.ts apps/api/src/cli/admin.test.ts`

Expected: FAIL，密码和 CLI 模块不存在。

- [ ] **Step 3: 实现固定 Argon2id 参数**

```ts
export const passwordPolicy = Object.freeze({ minLength: 12, maxLength: 256 })

export function hashPassword(password: string) {
  validatePassword(password)
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  })
}
```

验证失败始终返回通用认证错误，HTTP 层不区分用户名不存在和密码错误。

- [ ] **Step 4: 实现可注入的交互式命令**

CLI 暴露：

```text
node dist/cli.js admin create
node dist/cli.js admin reset-password
```

`runAdminCommand({ input, output, hiddenInput, db, now, randomId })` 便于测试；真实 `hiddenInput` 关闭终端回显，读取两次密码后立即清空局部字符串引用。重置密码和删除该管理员全部会话在同一个 SQLite 事务中完成。命令只打印管理员用户名和成功状态，不打印密码或哈希。

- [ ] **Step 5: 验证并提交**

Run:

```bash
pnpm exec vitest run apps/api/src/auth/passwords.test.ts apps/api/src/cli/admin.test.ts
pnpm --dir apps/api build
node apps/api/dist/cli.js --help
```

Expected: 测试通过；帮助只列出允许的子命令。

```bash
git add apps/api/src
git commit -m "feat: add secure administrator provisioning"
```

## 任务 4：实现登录限流和服务端会话

**Files:**
- Create: `apps/api/src/auth/tokens.ts`
- Create: `apps/api/src/auth/session-service.ts`
- Create: `apps/api/src/auth/session-service.test.ts`
- Create: `apps/api/src/repositories/sessions.ts`
- Create: `apps/api/src/repositories/login-attempts.ts`

- [ ] **Step 1: 写会话生命周期 RED 测试**

使用注入时钟覆盖：256 位随机令牌只以 SHA-256 哈希入库、5 次失败后同 IP 阻断 15 分钟、成功登录清零、12 小时空闲过期、7 天绝对过期、退出删除、读取会话时轮换 CSRF、不同 IP 不互相锁定。

```ts
expect(created.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
expect(db.prepare('SELECT token_hash FROM sessions').get()).not.toContain(created.rawToken)
clock.advance({ hours: 12, seconds: 1 })
expect(sessionService.authenticate(created.rawToken)).toBeNull()
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run apps/api/src/auth/session-service.test.ts`

Expected: FAIL，会话服务不存在。

- [ ] **Step 3: 实现令牌和会话服务**

`tokens.ts` 使用 `randomBytes(32).toString('base64url')`，统一用 `createHash('sha256')` 保存 token/CSRF 哈希，并使用 `timingSafeEqual` 比较。

`SessionService` 公共接口固定为：

```ts
export interface SessionService {
  login(input: { username: string; password: string; ip: string }): Promise<{
    rawToken: string
    csrfToken: string
    idleExpiresAt: string
    absoluteExpiresAt: string
  }>
  authenticate(rawToken: string): AuthenticatedSession | null
  rotateCsrf(rawToken: string): string
  verifyCsrf(session: AuthenticatedSession, rawCsrf: string): boolean
  logout(rawToken: string): void
  cleanupExpired(): number
}
```

登录失败更新在 SQLite 事务中完成；`blocked_until` 未到时不运行 Argon2，避免绕过阻断。未找到用户名时也校验一个启动时生成的固定 dummy Argon2id 哈希；测试断言未知用户和错误密码都执行一次密码校验并返回相同错误结构，降低用户名枚举信号。

- [ ] **Step 4: 验证并提交**

Run: `pnpm exec vitest run apps/api/src/auth/session-service.test.ts`

Expected: 全部通过。

```bash
git add apps/api/src/auth apps/api/src/repositories
git commit -m "feat: add bounded administrator sessions"
```

## 任务 5：建立 Fastify 安全边界和认证路由

**Files:**
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/app.test.ts`
- Create: `apps/api/src/http/security.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/routes/admin-session.ts`
- Create: `apps/api/src/routes/admin-session.test.ts`

- [ ] **Step 1: 写 HTTP 安全 RED 测试**

用 `app.inject()` 覆盖：健康响应不泄露版本/路径、登录只接受合法 Origin、Cookie 精确包含 `HttpOnly; Secure; SameSite=Strict; Path=/` 且无 Domain、会话检查轮换 CSRF、修改请求缺 Origin/CSRF 返回 403、认证失败统一 401、错误体无 stack；响应和结构化日志均不得出现密码、Cookie、会话令牌、CSRF、上传原始文件名或服务器绝对路径。

```ts
expect(login.cookies[0]).toMatchObject({
  name: '__Host-sweet_memories_session',
  httpOnly: true,
  secure: true,
  sameSite: 'Strict',
  path: '/',
})
expect(login.cookies[0]?.domain).toBeUndefined()
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run apps/api/src/app.test.ts apps/api/src/routes/admin-session.test.ts`

Expected: FAIL，Fastify app 尚不存在。

- [ ] **Step 3: 实现 app 工厂和稳定错误格式**

`buildApp(dependencies)` 使用 `trustProxy: ['127.0.0.1', '::1']`，注册 Cookie 和 multipart 插件，并统一返回：

```ts
export interface ApiErrorBody {
  error: { code: string; message: string }
}
```

未知错误记录服务端 request id 后返回 `INTERNAL_ERROR`，响应不包含堆栈、路径或依赖版本。

- [ ] **Step 4: 实现会话路由和安全 hook**

固定路由：

```text
GET    /api/health
POST   /api/admin/session
GET    /api/admin/session
DELETE /api/admin/session
```

POST 登录要求 `Origin` 精确等于配置 Origin。DELETE 同时要求有效 Cookie、Origin 和 `x-csrf-token`。GET 会话检查返回新 CSRF Token；不把 Cookie Token 回显到 JSON。

- [ ] **Step 5: 验证并提交**

Run:

```bash
pnpm exec vitest run apps/api/src/app.test.ts apps/api/src/routes/admin-session.test.ts
pnpm --dir apps/api typecheck
```

Expected: 全部通过。

```bash
git add apps/api/src
git commit -m "feat: add authenticated photo API boundary"
```

## 任务 6：实现照片仓库、公开读取和管理编辑

**Files:**
- Create: `apps/api/src/repositories/photos.ts`
- Create: `apps/api/src/repositories/photos.test.ts`
- Create: `apps/api/src/services/photo-service.ts`
- Create: `apps/api/src/routes/public-photos.ts`
- Create: `apps/api/src/routes/admin-photos.ts`
- Create: `apps/api/src/routes/photos.test.ts`

- [ ] **Step 1: 写照片数据 RED 测试**

覆盖：公开接口只返回 `published`、排序为 `captured_date ASC, created_at ASC, id ASC`、description 为空回退 title、路径必须是 `/media/<id>/<file>`、管理员能看到迁移记录、日期严格校验真实日历、版本冲突返回 409。

```ts
expect(publicPhotos.map((photo) => photo.id)).toEqual([
  'earlier-created',
  'later-created',
  'next-date',
])
expect(updateWithStaleVersion.statusCode).toBe(409)
expect(updateWithStaleVersion.json().error.code).toBe('PHOTO_VERSION_CONFLICT')
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run apps/api/src/repositories/photos.test.ts apps/api/src/routes/photos.test.ts`

Expected: FAIL，照片仓库和路由不存在。

- [ ] **Step 3: 定义公开 DTO 和映射**

```ts
export interface PublicPhotoDto {
  id: string
  title: string
  alt: string
  capturedDate: string
  transform: { rotation: number; x: number; y: number }
  sources: {
    avif: Array<{ url: string; width: number }>
    webp: Array<{ url: string; width: number }>
    jpeg: Array<{ url: string; width: number }>
    fallback: { url: string; width: number; height: number }
  }
}
```

SQL 负责排序；映射器只接受数据库中的相对路径且拒绝 `..`、绝对路径和反斜杠。

- [ ] **Step 4: 实现读写接口**

固定路由：

```text
GET   /api/photos
GET   /api/admin/photos
PATCH /api/admin/photos/:id
```

PATCH JSON 只允许 `title`、`description`、`capturedDate`、`version`，拒绝多余字段。标题 1-120 字符，描述空串规范化为 null，日期通过 UTC 构造后反校验 `YYYY-MM-DD`，事务中执行 `WHERE id=? AND version=?` 并把 version 加一。

- [ ] **Step 5: 验证并提交**

Run: `pnpm exec vitest run apps/api/src/repositories/photos.test.ts apps/api/src/routes/photos.test.ts`

Expected: 全部通过。

```bash
git add apps/api/src
git commit -m "feat: add photo catalog APIs"
```

## 任务 7：实现可信格式识别、EXIF 日期和 HEIC 解码适配器

**Files:**
- Create: `apps/api/src/media/inspect-input.ts`
- Create: `apps/api/src/media/inspect-input.test.ts`
- Create: `apps/api/src/media/heif-tools.ts`
- Create: `apps/api/src/media/heif-tools.test.ts`
- Create: `apps/api/test/fixtures/valid.heic`
- Create: `apps/api/test/fixtures/not-an-image.bin`

- [ ] **Step 1: 生成并提交最小 HEIC 测试样本**

在当前 macOS 仓库根目录运行：

```bash
mkdir -p apps/api/test/fixtures
sips -Z 64 codebase/assets/images/1.jpg --out /tmp/sweet-memories-heic-source.jpg
sips -s format heic /tmp/sweet-memories-heic-source.jpg --out apps/api/test/fixtures/valid.heic
```

再用 `apply_patch` 创建 `apps/api/test/fixtures/not-an-image.bin`，内容精确为 `not an image\n`。Expected: `file apps/api/test/fixtures/valid.heic` 显示 HEIF/HEIC 图像，fixture 小于 100KB。

- [ ] **Step 2: 写输入检查 RED 测试**

覆盖 JPEG/PNG/WebP/HEIC/HEIF，拒绝扩展名伪造、AVIF、GIF、损坏文件、超过 6000 万像素、HEIF 序列和命令超时；EXIF 日期使用原始日历日期，缺失时返回 null。

```ts
expect(await inspectInput(renamedJpeg)).toMatchObject({ kind: 'jpeg' })
await expect(inspectInput(fakeJpeg)).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' })
await expect(inspectInput(sixtyMillionPlusOne)).rejects.toMatchObject({
  code: 'IMAGE_PIXEL_LIMIT',
})
```

- [ ] **Step 3: 运行测试确认 RED**

Run: `pnpm exec vitest run apps/api/src/media/inspect-input.test.ts apps/api/src/media/heif-tools.test.ts`

Expected: FAIL，检查器不存在。

- [ ] **Step 4: 实现格式和日期检查**

使用 `fileTypeFromFile()` 只映射 `image/jpeg`、`image/png`、`image/webp`、`image/heic`、`image/heif`。使用 exifr：

```ts
const exif = await exifr.parse(path, {
  pick: ['DateTimeOriginal', 'CreateDate'],
  reviveValues: false,
  translateValues: false,
})
```

从原始 `YYYY:MM:DD HH:mm:ss` 只取并验证日历日期；任何解析错误回退 null，不让 EXIF 控制输出路径或文件名。

- [ ] **Step 5: 实现有界 HEIF 工具调用**

`inspectHeif()` 用 `execFile(heif-info, [input])`，30 秒超时、1MB `maxBuffer`，解析唯一主图的宽高并拒绝序列。`convertHeif()` 用 `execFile(heif-convert, [input, outputPng])`，30 秒超时；不传 `--disable-limits`，继承 libheif 安全限制。所有参数通过数组传递，不经过 Shell。

- [ ] **Step 6: 验证并提交**

Run:

```bash
pnpm exec vitest run apps/api/src/media/inspect-input.test.ts apps/api/src/media/heif-tools.test.ts
pnpm --dir apps/api typecheck
```

Expected: 单元测试通过；若本机没有 `heif-info`，生产适配器测试使用注入的 fake command runner，真实 fixture 解析在 Ubuntu CI 任务中运行。

```bash
git add apps/api/src/media apps/api/test/fixtures
git commit -m "feat: validate supported photo inputs"
```

## 任务 8：实现图片净化、响应式输出和文件事务

**Files:**
- Create: `apps/api/src/media/storage.ts`
- Create: `apps/api/src/media/storage.test.ts`
- Create: `apps/api/src/media/processor.ts`
- Create: `apps/api/src/media/processor.test.ts`

- [ ] **Step 1: 写处理流水线 RED 测试**

覆盖：自动旋转、主图、320/640/960/1600 三格式、不放大小图、输出无 EXIF/GPS、输出路径无原名、成功时原子改名、任一步失败清理 staging 和正式半成品。

```ts
expect(manifest.assets.map(({ width }) => width)).toEqual([320, 640, 960, 1600])
expect(new Set(manifest.assets.map(({ format }) => format))).toEqual(
  new Set(['avif', 'webp', 'jpeg']),
)
expect(await exifr.gps(publicJpeg)).toBeUndefined()
expect(await exifr.parse(publicJpeg)).not.toHaveProperty('Model')
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run apps/api/src/media/storage.test.ts apps/api/src/media/processor.test.ts`

Expected: FAIL，处理器不存在。

- [ ] **Step 3: 实现文件事务**

`MediaStorage` 只接受服务端 UUID photo id，所有路径经 `path.resolve` 后必须仍位于配置根目录：

```ts
export interface MediaTransaction {
  stagingDir: string
  finalDir: string
  commit(): Promise<void>
  rollback(): Promise<void>
}
```

创建目录使用 `0700` staging；进程主组固定为 `sweet-memories-media`，测试断言 staging 内输出和原子 rename 后的正式资源都保留该组。正式目录设置 `0750`、文件 `0640`，从而让加入媒体组的 Nginx 只读访问；目标已存在立即失败，不覆盖既有照片。

- [ ] **Step 4: 实现 Sharp 流水线**

输入 Sharp 时设置 `limitInputPixels: 60_000_000`、`sequentialRead: true`，调用 `.rotate()`，且永不调用 `withMetadata()`。净化主图保存为 `master.jpg`；响应式文件名固定为 `<width>.<format>`，质量为 AVIF 62、WebP 78、JPEG 82。源图小于目标宽度时只生成源宽一次，并在 manifest 去重。

- [ ] **Step 5: 验证并提交**

Run:

```bash
pnpm exec vitest run apps/api/src/media/storage.test.ts apps/api/src/media/processor.test.ts
pnpm --dir apps/api typecheck
```

Expected: 全部通过，临时目录测试结束后为空。

```bash
git add apps/api/src/media
git commit -m "feat: generate sanitized responsive photos"
```

## 任务 9：实现单并发处理队列、磁盘门槛和幂等上传 API

**Files:**
- Create: `apps/api/src/media/processing-queue.ts`
- Create: `apps/api/src/media/processing-queue.test.ts`
- Create: `apps/api/src/services/upload-photo.ts`
- Create: `apps/api/src/services/upload-photo.test.ts`
- Modify: `apps/api/src/routes/admin-photos.ts`
- Modify: `apps/api/src/routes/photos.test.ts`

- [ ] **Step 1: 写队列和上传 RED 测试**

覆盖：同时最多处理 1 张、最多等待 9 张、队列满返回 429、可用空间低于 5GiB 返回 507、文件流超过 10MiB 中止、只接受一个文件、同 request id 返回既有照片、不同 request id 创建不同照片、上传开关关闭返回 423。

```ts
expect(queue.activeCount).toBe(1)
expect(queue.pendingCount).toBe(9)
await expect(queue.run(eleventhJob)).rejects.toMatchObject({ code: 'UPLOAD_QUEUE_FULL' })

expect(secondResponse.statusCode).toBe(200)
expect(secondResponse.json().photo.id).toBe(firstResponse.json().photo.id)
expect(photoCount(db)).toBe(1)
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run apps/api/src/media/processing-queue.test.ts apps/api/src/services/upload-photo.test.ts apps/api/src/routes/photos.test.ts`

Expected: FAIL，队列和上传服务不存在。

- [ ] **Step 3: 实现容量为 10 的队列**

`ProcessingQueue` 不使用无界 Promise 数组，接口固定为：

```ts
export class ProcessingQueue {
  readonly concurrency = 1
  readonly maxPending = 9
  get activeCount(): number
  get pendingCount(): number
  run<T>(job: () => Promise<T>): Promise<T>
}
```

任务完成、失败或取消都必须在 `finally` 释放槽位并启动下一项。

- [ ] **Step 4: 实现上传服务事务边界**

执行顺序固定为：检查 `uploads_enabled` → 查询 request id → `statfs` 检查 5GiB → 流式写 staging 并限制 10MiB → 排队 → 检查/转换/处理 → 原子移动正式目录 → SQLite 事务插入照片和 assets。数据库失败时删除新正式目录；网络重试先命中 request id，不重新处理。

标题默认值为：

```ts
export function defaultTitle(capturedDate: string) {
  const [, month, day] = capturedDate.split('-').map(Number)
  return `${capturedDate.slice(0, 4)}年${month}月${day}日的成长瞬间`
}
```

无 EXIF 日期时使用注入时钟在 `Asia/Shanghai` 的日历日期。transform 从 `sha256(photoId)` 稳定映射到设计允许范围，测试固定 id 得到固定结果。

- [ ] **Step 5: 实现 multipart 路由**

`POST /api/admin/photos` 要求：有效会话、Origin、CSRF、`Idempotency-Key` UUID、单个 `photo` part。multipart 限制：

```ts
{
  limits: {
    files: 1,
    fields: 0,
    fileSize: 10 * 1024 * 1024,
    parts: 1,
  },
}
```

成功新建返回 201，幂等重放返回 200；响应不包含原文件名和 staging 路径。

- [ ] **Step 6: 验证并提交**

Run:

```bash
pnpm exec vitest run apps/api/src/media/processing-queue.test.ts apps/api/src/services/upload-photo.test.ts apps/api/src/routes/photos.test.ts
pnpm --dir apps/api typecheck
```

Expected: 全部通过。

```bash
git add apps/api/src
git commit -m "feat: add bounded idempotent photo uploads"
```

## 任务 10：实现永久删除和故障补偿清理

**Files:**
- Create: `apps/api/src/services/delete-photo.ts`
- Create: `apps/api/src/services/delete-photo.test.ts`
- Create: `apps/api/src/services/maintenance.ts`
- Create: `apps/api/src/services/maintenance.test.ts`
- Modify: `apps/api/src/routes/admin-photos.ts`
- Modify: `apps/api/src/routes/photos.test.ts`

- [ ] **Step 1: 写删除 RED 测试**

覆盖：版本匹配才删除、媒体先移动到私有 `.deleting`、数据库失败恢复媒体、数据库成功后清理失败进入重试、重复删除返回幂等 204、路径异常时拒绝操作。

```ts
await expect(service.delete({ id, version: 1 })).resolves.toEqual({ deleted: true })
expect(photoById(db, id)).toBeUndefined()
expect(await pathExists(mediaDir)).toBe(false)

database.failNextTransaction()
await expect(service.delete({ id, version: 1 })).rejects.toThrow()
expect(await pathExists(mediaDir)).toBe(true)
expect(photoById(db, id)).toBeDefined()
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run apps/api/src/services/delete-photo.test.ts apps/api/src/services/maintenance.test.ts`

Expected: FAIL，服务尚不存在。

- [ ] **Step 3: 实现删除和维护服务**

删除临时目录使用 `<media-root>/.deleting/<photo-id>-<random>`，Nginx 配置必须拒绝点目录。`MaintenanceService.run()` 删除超过 24 小时的无数据库记录媒体、失败 staging 和 `.deleting` 残留，并删除过期会话；每次最多处理 100 项，避免长时间占用进程。

- [ ] **Step 4: 接入删除路由**

`DELETE /api/admin/photos/:id` 要求 `If-Match: "<version>"`、会话、Origin 和 CSRF。成功与已删除均返回 204；版本冲突返回 409；不允许通过请求传文件路径。

- [ ] **Step 5: 验证并提交**

Run: `pnpm exec vitest run apps/api/src/services/delete-photo.test.ts apps/api/src/services/maintenance.test.ts apps/api/src/routes/photos.test.ts`

Expected: 全部通过。

```bash
git add apps/api/src
git commit -m "feat: add compensated permanent photo deletion"
```

## 任务 11：导入现有五张照片并实现 readiness/激活命令

**Files:**
- Create: `apps/api/seed/legacy-photos.json`
- Create: `scripts/api/prepare-legacy-seed.mjs`
- Create: `scripts/api/prepare-legacy-seed.test.ts`
- Create: `apps/api/src/services/legacy-migration.ts`
- Create: `apps/api/src/services/legacy-migration.test.ts`
- Create: `apps/api/src/cli/migration.ts`
- Modify: `apps/api/src/cli.ts`

- [ ] **Step 1: 写 seed 合同和迁移 RED 测试**

manifest 精确保存现有标题、当前 alt 对应的 description 和 transform；日期为 null。测试覆盖重复导入不重复、状态始终 `migration_pending`、公开 API 不返回、缺任一资源 readiness 失败、日期未填失败、相同日期仍保持旧相册顺序、错误顺序失败、activate 幂等、上传开关单独启停。

```json
[
  { "legacyId": "1", "photoId": "9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1", "title": "刚出生的时候 🍼", "description": "刚出生的宝宝裹在粉色襁褓中安静熟睡", "capturedDate": null, "rotation": -5, "x": 0, "y": 10 },
  { "legacyId": "2", "photoId": "58efb95e-2a98-45be-bbe4-acde6c34f7cd", "title": "第一次笑得这么开心 😄", "description": "宝宝睁着眼睛躺在印花被褥中", "capturedDate": null, "rotation": 3, "x": 10, "y": -5 },
  { "legacyId": "3", "photoId": "f83da4e8-d94e-4b8a-a725-36e2d1f931bf", "title": "满月啦 🎈", "description": "爸爸妈妈抱着宝宝在蛋糕前庆祝满月", "capturedDate": null, "rotation": -2, "x": -10, "y": 0 },
  { "legacyId": "4", "photoId": "a15b8021-9842-4ed7-bd0f-9f98518a2d72", "title": "睡觉的样子最乖 💤", "description": "宝宝躺在圆点枕头上安静熟睡", "capturedDate": null, "rotation": 4, "x": 5, "y": 15 },
  { "legacyId": "5", "photoId": "c9608cd6-3480-43fb-84ab-623899262ff9", "title": "带去公园玩 🌳", "description": "宝宝坐在婴儿车里游览开满玫瑰的公园", "capturedDate": null, "rotation": -4, "x": 0, "y": -10 }
]
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run scripts/api/prepare-legacy-seed.test.ts apps/api/src/services/legacy-migration.test.ts`

Expected: FAIL，seed 和迁移服务不存在。

- [ ] **Step 3: 实现可复现 seed 构建**

`prepare-legacy-seed.mjs --output <absolute-empty-directory>` 从 `src/assets/generated/photo-{1..5}-{320,640,960}.{avif,webp,jpg}` 复制到指定临时目录的 `media/<photoId>/`，其中 `photoId` 必须使用上方 manifest 固定 UUID；960 JPEG 同时复制为 `master.jpg`，并在输出根写 `media-manifest.json`（相对路径、大小、SHA-256）。输出目录必须位于工作区外、已存在且为空；源文件缺失、软链接、格式/尺寸错误或摘要漂移时失败。`--check` 使用系统临时目录生成后验证并清理，禁止向 `apps/api/seed` 写生成媒体。

- [ ] **Step 4: 实现迁移服务和 CLI**

固定命令：

```text
node dist/cli.js migration import-legacy
node dist/cli.js migration check-ready
node dist/cli.js migration activate
node dist/cli.js uploads status
node dist/cli.js uploads enable
node dist/cli.js uploads disable
```

`import-legacy` 以 `legacy-photo-<1..5>` 作为 request id 幂等键，正式 photo id 使用 seed 中固定 UUID，并按 legacyId 把 `created_at` 固定为 `2000-01-01T00:00:01.000Z` 至 `2000-01-01T00:00:05.000Z`。`check-ready` 只查询这五个固定 UUID，要求五条全部存在、日期均为合法日历日期、按 `captured_date ASC, created_at ASC, id ASC` 排序后仍对应 legacyId 1..5、title/description 非空、所有媒体摘要一致。`activate` 在单事务内再次 readiness 后把这五条改为 `published`，不修改 `uploads_enabled`；以后新增照片不影响命令幂等性。

- [ ] **Step 5: 验证并提交**

Run:

```bash
pnpm exec vitest run scripts/api/prepare-legacy-seed.test.ts apps/api/src/services/legacy-migration.test.ts
node scripts/api/prepare-legacy-seed.mjs --check
pnpm --dir apps/api build
```

Expected: 测试和临时 seed 校验通过，API TypeScript 构建成功，命令结束后工作区内没有生成媒体。

```bash
git add apps/api scripts/api
git commit -m "feat: add idempotent legacy photo migration"
```

## 任务 12：完成 API 进程入口、维护调度和 Linux 发布包

**Files:**
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/index.test.ts`
- Create: `scripts/deploy/package-api.sh`
- Create: `scripts/deploy/package-api.test.sh`
- Modify: `package.json`

- [ ] **Step 1: 写进程和打包 RED 测试**

入口测试覆盖只监听配置回环地址、SIGTERM 停止接收请求并关闭 DB、启动先迁移后 listen、每小时维护不重叠。Shell 测试覆盖发布包只含 `dist`、`migrations`、带五张固定媒体和摘要的 `seed`、生产 `package.json` 和 Linux node_modules，不含 `.env`、数据库、持久化媒体、测试和源码；打包前后 Git 工作区状态不变。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
pnpm exec vitest run apps/api/src/index.test.ts
bash scripts/deploy/package-api.test.sh
```

Expected: 两项均因实现不存在而失败。

- [ ] **Step 3: 实现进程生命周期**

`startApi({ config, createApp, openDatabase, clock })` 的顺序固定为创建目录、打开数据库、执行迁移、分别验证 `heif-info --help` 和 `heif-convert --help`、注册每小时 maintenance、listen。SIGINT/SIGTERM 清定时器，等待当前单个图片任务最多 60 秒，关闭 Fastify 和数据库后退出。

- [ ] **Step 4: 实现 Linux 打包脚本**

`package-api.sh <output.tar.gz>` 必须在 Ubuntu x64、Node 24 下运行：

```bash
pnpm --dir apps/api build
pnpm --filter @sweet-memories/api deploy --prod "$RUNNER_TEMP/api-package"
mkdir "$RUNNER_TEMP/legacy-seed"
node scripts/api/prepare-legacy-seed.mjs --output "$RUNNER_TEMP/legacy-seed"
cp -a "$RUNNER_TEMP/legacy-seed/media" "$RUNNER_TEMP/legacy-seed/media-manifest.json" "$RUNNER_TEMP/api-package/seed/"
tar --dereference --hard-dereference -C "$RUNNER_TEMP/api-package" -czf "$1" .
```

归档前遍历 deploy 目录中的所有软链接，用 `realpath` 确认目标仍位于 deploy 根内，并拒绝悬空链接和特殊文件；随后用 GNU tar 解引用软链接和硬链接。脚本验证 native modules 能在 runner 上 `import()`，最终压缩包成员只允许普通文件/目录，不得为绝对路径、`..`、软链接、硬链接或特殊文件。

- [ ] **Step 5: 加入根命令并验证**

`package.json` 增加：

```json
{
  "test:api": "pnpm --dir apps/api test && bash scripts/deploy/package-api.test.sh",
  "package:api": "bash scripts/deploy/package-api.sh"
}
```

Run:

```bash
pnpm test:api
pnpm build
```

Expected: API 测试/打包测试通过，前后端都构建成功。

- [ ] **Step 6: 提交 API 可运行产物**

```bash
git add apps/api/src scripts/deploy package.json
git commit -m "build: package the photo API runtime"
```

## 任务 13：为公开相册增加静态/API 双数据源

**Files:**
- Create: `src/config/album-source.json`
- Create: `src/config/album-source.test.ts`
- Create: `src/services/photoApi.ts`
- Create: `src/services/photoApi.test.ts`
- Create: `src/composables/usePublicMemories.ts`
- Create: `src/composables/usePublicMemories.test.ts`
- Modify: `src/types/album.ts`
- Modify: `src/App.vue`
- Modify: `src/App.test.ts`

- [ ] **Step 1: 写双数据源 RED 测试**

覆盖：配置只允许 static/api；static 模式不请求网络且仍显示五张；api 模式校验 DTO 并生成正确 srcset；加载中预留照片墙；失败显示重试且视频/音频仍可用；无效/跨源媒体 URL 拒绝。

```ts
expect(fetchMock).not.toHaveBeenCalled()
expect(wrapper.findAll('.polaroid')).toHaveLength(5)

expect(mapPublicPhoto(dto).sources.avif).toBe(
  '/media/id/320.avif 320w, /media/id/640.avif 640w',
)
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run src/config/album-source.test.ts src/services/photoApi.test.ts src/composables/usePublicMemories.test.ts src/App.test.ts`

Expected: FAIL，新模块不存在。

- [ ] **Step 3: 创建准备阶段配置和严格 DTO 解析**

`src/config/album-source.json` 初始内容必须保持：

```json
{ "mode": "static" }
```

`photoApi.ts` 逐字段检查数组、字符串、宽高、transform 范围和同源 `/media/` 路径；不使用类型断言代替运行时校验。映射得到现有 `Memory` 结构，并为 `img` 增加真实 fallback 宽高。

- [ ] **Step 4: 实现 composable 和 App 状态**

```ts
export interface PublicMemoriesState {
  memories: Readonly<Ref<readonly Memory[]>>
  status: Readonly<Ref<'loading' | 'ready' | 'error'>>
  retry(): Promise<void>
}
```

static 模式同步使用 `memories.ts`；api 模式在 mounted 后请求 `/api/photos`。`App.vue` 的视频、音频、睡眠模式不依赖照片请求；error 状态显示简短重试按钮，图库容器保持稳定最小高度。

- [ ] **Step 5: 验证并提交准备模式**

Run:

```bash
pnpm exec vitest run src/config/album-source.test.ts src/services/photoApi.test.ts src/composables/usePublicMemories.test.ts src/App.test.ts
pnpm typecheck
pnpm build
```

Expected: 全部通过，构建产物仍以 static 模式显示五张照片。

```bash
git add src
git commit -m "feat: add a gated public photo API source"
```

## 任务 14：建立 `/admin` 登录和会话恢复框架

**Files:**
- Create: `src/admin/types.ts`
- Create: `src/admin/api.ts`
- Create: `src/admin/api.test.ts`
- Create: `src/admin/useAdminSession.ts`
- Create: `src/admin/useAdminSession.test.ts`
- Create: `src/admin/AdminLogin.vue`
- Create: `src/admin/AdminLogin.test.ts`
- Create: `src/admin/ReauthDialog.vue`
- Create: `src/admin/ReauthDialog.test.ts`
- Create: `src/admin/AdminApp.vue`
- Create: `src/main.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 写后台入口和会话 RED 测试**

覆盖：仅精确 `/admin` 加载后台；未登录显示用户名/密码；登录后密码字段清空；CSRF 只在内存；401 不卸载当前 AdminApp 而打开 modal；重新登录关闭 modal；退出清空会话；响应错误不显示内部字段。

```ts
expect(selectRoot('/admin')).toBe('admin')
expect(selectRoot('/admin/')).toBe('admin')
expect(selectRoot('/administrator')).toBe('public')

api.emitUnauthorized()
await nextTick()
expect(wrapper.get('[role="dialog"]').text()).toContain('登录已过期')
expect(wrapper.get('[data-testid="photo-library"]').exists()).toBe(true)
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run src/admin src/main.test.ts`

Expected: FAIL，后台模块不存在。

- [ ] **Step 3: 实现 API 客户端和会话状态**

`AdminApi` 所有请求设置 `credentials: 'same-origin'`；修改请求附 `Origin` 由浏览器提供并添加 `x-csrf-token`。收到 401 发布一次 `unauthorized` 事件，不自动重试修改请求。

```ts
export interface AdminSessionState {
  status: Ref<'checking' | 'anonymous' | 'authenticated' | 'reauth-required'>
  csrfToken: Ref<string | null>
  login(username: string, password: string): Promise<void>
  logout(): Promise<void>
}
```

状态只保存在 Vue 内存，不写 localStorage/sessionStorage/IndexedDB。

- [ ] **Step 4: 实现可访问登录和重新登录对话框**

表单有显式 label、autocomplete `username`/`current-password`、提交中禁用、防重复提交、错误 `aria-live=polite`。ReauthDialog 使用原生 `<dialog>` 或等效 focus trap，打开时聚焦用户名，Escape 不丢弃当前草稿，只提示必须登录或退出。

- [ ] **Step 5: 按路径选择根组件**

`main.ts` 只根据规范化 pathname 选择 `AdminApp` 或公开 `App`，两者共享 reset/theme 但后台额外引入 `admin.css`；不新增路由依赖。

- [ ] **Step 6: 验证并提交**

Run:

```bash
pnpm exec vitest run src/admin src/main.test.ts
pnpm typecheck
pnpm lint
```

Expected: 全部通过。

```bash
git add src/admin src/main.ts src/main.test.ts
git commit -m "feat: add administrator login experience"
```

## 任务 15：实现照片库、编辑和永久删除界面

**Files:**
- Create: `src/admin/PhotoLibrary.vue`
- Create: `src/admin/PhotoLibrary.test.ts`
- Create: `src/admin/PhotoEditor.vue`
- Create: `src/admin/PhotoEditor.test.ts`
- Create: `src/admin/DeletePhotoDialog.vue`
- Create: `src/admin/DeletePhotoDialog.test.ts`
- Create: `src/admin/usePhotoLibrary.ts`
- Create: `src/admin/usePhotoLibrary.test.ts`
- Modify: `src/admin/AdminApp.vue`

- [ ] **Step 1: 写照片库交互 RED 测试**

覆盖：桌面网格+右栏、手机双列+全屏编辑语义、迁移准备横幅、上传关闭、标题/日期/描述编辑、空描述回退提示、版本冲突刷新提示、删除必须二次确认、失败不从界面消失。

```ts
await editor.get('input[name="title"]').setValue('未保存标题')
session.status.value = 'reauth-required'
await nextTick()
expect(editor.get('input[name="title"]').element.value).toBe('未保存标题')

await deleteDialog.get('[data-confirm-delete]').trigger('click')
expect(api.deletePhoto).toHaveBeenCalledTimes(1)
expect(wrapper.find('[data-photo-id="photo-1"]').exists()).toBe(false)
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run src/admin/PhotoLibrary.test.ts src/admin/PhotoEditor.test.ts src/admin/DeletePhotoDialog.test.ts src/admin/usePhotoLibrary.test.ts`

Expected: FAIL，组件不存在。

- [ ] **Step 3: 实现内存草稿和并发版本**

`usePhotoLibrary` 保存服务器快照与独立 draft map；重新认证不重新创建 composable。保存时提交当前 version，成功替换快照并清除对应 dirty 标记；409 时保留 draft、展示“照片已在其他页面修改”，提供“载入最新内容”按钮，禁止静默覆盖。

- [ ] **Step 4: 实现照片库优先布局**

工具栏只放上传、刷新、退出；照片卡使用 1:1 预览和短标题。桌面 `minmax(0, 1fr) 320px`，移动端编辑器作为全屏层。删除按钮使用 lucide Trash 图标并有 tooltip/屏幕阅读器名称；确认对话框显示预览、标题和“永久删除，无法恢复”。

- [ ] **Step 5: 验证并提交**

Run:

```bash
pnpm exec vitest run src/admin/PhotoLibrary.test.ts src/admin/PhotoEditor.test.ts src/admin/DeletePhotoDialog.test.ts src/admin/usePhotoLibrary.test.ts
pnpm typecheck
```

Expected: 全部通过。

```bash
git add src/admin
git commit -m "feat: manage published photos from the admin library"
```

## 任务 16：实现最多 10 张、双并发和可恢复上传队列

**Files:**
- Create: `src/admin/useUploadQueue.ts`
- Create: `src/admin/useUploadQueue.test.ts`
- Create: `src/admin/UploadQueue.vue`
- Create: `src/admin/UploadQueue.test.ts`
- Modify: `src/admin/AdminApp.vue`

- [ ] **Step 1: 写上传队列 RED 测试**

覆盖：一次最多选择 10 张、单张前端预检 10MiB、支持扩展名提示但不替代服务端校验、同时请求最多 2、部分失败继续、失败可单独重试、每项 UUID request id 稳定、401 暂停 active/pending、重新登录后不自动继续、点击继续后恢复、刷新后不承诺保留 File。

```ts
queue.add(makeFiles(10))
expect(queue.items).toHaveLength(10)
expect(() => queue.add(makeFiles(11))).toThrow('一次最多选择 10 张照片')

await flushPromises()
expect(api.maxObservedConcurrency).toBe(2)
api.rejectNextWithUnauthorized()
expect(queue.status.value).toBe('paused-auth')
session.completeReauthentication()
expect(api.uploadCalls).toHaveLength(previousCallCount)
await queue.continueAfterLogin()
expect(api.uploadCalls.length).toBeGreaterThan(previousCallCount)
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run src/admin/useUploadQueue.test.ts src/admin/UploadQueue.test.ts`

Expected: FAIL，队列不存在。

- [ ] **Step 3: 实现有界浏览器队列**

每个 item 保存 `id`、`File`、object URL、request id、状态、进度和稳定错误码。调度器只启动两个 active Promise；`finally` 释放槽位。XHR 只用于同源上传进度，设置 `withCredentials=true`、`x-csrf-token`、`Idempotency-Key`；禁止把文件转 base64 或写浏览器持久存储。

- [ ] **Step 4: 实现暂停和显式恢复**

任一请求 401 时停止启动新项；进行中的另一请求允许完成，队列进入 `paused-auth`。重新登录只把状态改为 `ready-to-resume`，用户点击“继续上传”后才重新调度；已成功项不重发，失败/中断项复用原 request id。

- [ ] **Step 5: 实现队列 UI 并验证**

队列为每张照片显示缩略图、文件大小、等待/上传/处理/成功/失败/暂停状态、单项重试和移除；总状态使用 `aria-live=polite`，进度条有稳定尺寸。

Run:

```bash
pnpm exec vitest run src/admin/useUploadQueue.test.ts src/admin/UploadQueue.test.ts
pnpm typecheck
```

Expected: 全部通过。

```bash
git add src/admin
git commit -m "feat: add a recoverable photo upload queue"
```

## 任务 17：完成后台视觉、响应式和整体验收测试

**Files:**
- Create: `src/styles/admin.css`
- Create: `src/admin/AdminApp.test.ts`
- Modify: `src/admin/AdminApp.vue`
- Modify: `src/main.ts`

- [ ] **Step 1: 写后台整合 RED 测试**

测试完整路径：匿名登录 → 查看准备横幅 → 编辑旧照片日期 → 会话过期保留草稿 → 重新登录 → 手工保存 → 上传关闭时按钮禁用。另测 API 不可用、空库、网络失败、磁盘不足和退出。

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run src/admin/AdminApp.test.ts`

Expected: FAIL，完整组合尚未满足合同。

- [ ] **Step 3: 完成克制的管理界面样式**

使用现有 theme 变量并增加中性工作界面颜色；卡片圆角不超过 8px，不使用嵌套卡片、装饰渐变球或超大标题。桌面照片网格最小 180px 列宽，手机固定双列，工具栏和图标按钮固定 40px；所有长错误文本可换行且不覆盖队列。

- [ ] **Step 4: 验证桌面和手机布局**

启动：`pnpm dev --host 127.0.0.1`

使用浏览器在 1440x900、390x844 两个视口检查 `/admin`：无横向滚动、按钮不重叠、登录 dialog 可操作、照片网格和编辑器不遮挡、最长中文错误能完整显示。保存两张截图到临时目录，不提交截图。

- [ ] **Step 5: 跑整套前端检查并提交**

Run:

```bash
pnpm exec vitest run src/admin src/App.test.ts src/components
pnpm typecheck
pnpm lint
pnpm build:frontend
```

Expected: 所有测试通过，类型和 lint 无错误，Vite 构建成功。

```bash
git add src
git commit -m "feat: finish the responsive photo administration UI"
```

## 任务 18：实现服务器 API 版本管理和最小权限模板

**Files:**
- Create: `scripts/deploy/manage-api-release.sh`
- Create: `scripts/deploy/manage-api-release.test.sh`
- Create: `ops/systemd/sweet-memories-api.service`
- Create: `ops/nginx/sweet-memories-api.conf`
- Create: `ops/sudoers/sweet-memories-api`
- Modify: `apps/api/src/cli.ts`
- Create: `apps/api/src/cli/database.ts`

- [ ] **Step 1: 写 API 发布管理器 RED 集成测试**

在临时目录和 fake `systemctl`/`curl`/`sudo` 下覆盖：安全解包、40 位 SHA、拒绝软链接/特殊文件/路径穿越、首次启用、重复启用、健康失败自动回退、仅当前 SHA 匹配才回退、SQLite 迁移前快照、保留 5 版、持久化目录从不删除、TERM 清理 staging。

```bash
bash scripts/deploy/manage-api-release.test.sh
```

Expected: FAIL，`manage-api-release.sh` 不存在。

- [ ] **Step 2: 实现 root-owned 发布管理器**

固定接口：

```text
manage-api-release.sh activate <sha> <archive>
manage-api-release.sh rollback-if-current <sha>
manage-api-release.sh cleanup 5
manage-api-release.sh cli migration check-ready
manage-api-release.sh cli migration activate
manage-api-release.sh cli uploads enable
manage-api-release.sh cli uploads disable
manage-api-release.sh cli uploads status
```

脚本只使用固定根 `/opt/sweet-memories-api`、数据根 `/var/lib/sweet-memories` 和服务名 `sweet-memories-api.service`。activate 先解包到 `.incoming-<sha>`，校验普通文件/目录和入口，把 release 规范化为 root:root 且服务账号只读；所有会触碰 SQLite/media 的新 release CLI 都通过 `runuser --user sweet-memories --group sweet-memories-media --` 和固定环境/PATH 执行，测试断言不会留下 root-owned 数据文件。随后创建 SQLite 在线快照并迁移，原子更新 `current`/`previous`，重启并最多 3 次检查 `http://127.0.0.1:3100/api/health`；失败时恢复旧链接并重启旧服务。

- [ ] **Step 3: 为 CLI 增加数据库快照和迁移命令**

固定命令：

```text
node dist/cli.js database backup <absolute-output-file>
node dist/cli.js database migrate
```

backup 使用 better-sqlite3 在线 backup API，目标必须位于 `/var/lib/sweet-memories/backups/deploy`，必须为新普通文件；迁移失败不切 release。

- [ ] **Step 4: 创建 systemd 模板**

`ops/systemd/sweet-memories-api.service` 核心合同：

```ini
[Service]
Type=simple
User=sweet-memories
Group=sweet-memories-media
WorkingDirectory=/opt/sweet-memories-api/current
Environment=NODE_ENV=production
Environment=SWEET_MEMORIES_ORIGIN=https://huangjianfen.cn
Environment=SWEET_MEMORIES_DATA_ROOT=/var/lib/sweet-memories
ExecStart=/usr/local/bin/node /opt/sweet-memories-api/current/dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=75
UMask=0027
MemoryHigh=768M
MemoryMax=1G
TasksMax=64
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/sweet-memories
```

服务不以 root/deploy/www-data 运行，不绑定公网地址；HEIF 子进程和 Sharp 同属该 cgroup，避免单张恶意图片耗尽整台 2GB 服务器。

- [ ] **Step 5: 创建 Nginx 和 sudoers 模板**

Nginx snippet 设置 `client_max_body_size 12m`、`client_body_timeout 30s`、`proxy_send_timeout 30s` 和 `proxy_read_timeout 180s`；`/api/` 代理到回环并传递 Host、X-Forwarded-For、X-Forwarded-Proto；`/media/.` 返回 404；`/media/` 用 `root /var/lib/sweet-memories` 只读，关闭 autoindex，添加 `nosniff` 和不可变缓存。安装测试必须以 `www-data` 身份读取一份 `0750/0640` 示例媒体并确认不能写入。

sudoers 只允许 deploy 无密码运行 root-owned `/usr/local/sbin/manage-sweet-memories-api`，不允许任意 `node`、`systemctl`、Shell 或编辑器。

- [ ] **Step 6: 验证脚本和模板**

Run:

```bash
bash -n scripts/deploy/manage-api-release.sh
bash -n scripts/deploy/manage-api-release.test.sh
bash scripts/deploy/manage-api-release.test.sh
systemd-analyze verify ops/systemd/sweet-memories-api.service
```

Expected: Shell 测试通过；systemd 模板无错误。macOS 没有 `systemd-analyze` 时由 Ubuntu CI 执行最后一项。

- [ ] **Step 7: 提交服务器运行模板**

```bash
git add scripts/deploy/manage-api-release.sh scripts/deploy/manage-api-release.test.sh ops apps/api/src/cli.ts apps/api/src/cli/database.ts
git commit -m "ops: add atomic photo API releases"
```

## 任务 19：扩展 Tag 工作流并实现两阶段激活/回退

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `scripts/deploy/workflow.test.ts`

- [ ] **Step 1: 先扩展工作流结构测试**

测试精确断言：Ubuntu 安装 `libheif-examples`；运行 `test:api`；分别生成前端/API archive；API 先上传并启用；读取 `album-source.json`；static 模式强制 uploads disable；api 模式按 check-ready → activate legacy → frontend activate → public health → uploads enable 排序；任何 activation/public health 失败执行 uploads disable 和两个有条件回退；archive 总会清理；持久化路径不出现在 tar/cleanup 命令。

```ts
expect(ids).toEqual(expect.arrayContaining([
  'install-heif', 'test-api', 'package-api', 'upload-api', 'activate-api',
  'read-album-mode', 'prepare-photo-mode', 'activate-legacy',
  'activate-frontend', 'health-check', 'enable-uploads', 'rollback-api',
]))
expect(step('enable-uploads').if).toContain("steps.health-check.outcome == 'success'")
expect(step('disable-uploads').if).toContain('failure()')
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run scripts/deploy/workflow.test.ts`

Expected: FAIL，新增步骤缺失。

- [ ] **Step 3: 增加构建和原生能力检查**

在依赖安装前运行：

```bash
sudo apt-get update
sudo apt-get install --yes --no-install-recommends libheif-examples
heif-info --help >/dev/null
heif-convert --help >/dev/null
```

质量门顺序固定为 typecheck、lint、全量 Vitest、API Shell 测试、deploy 测试、monitor 测试、前后端 build。`package-api` 只在 Ubuntu runner 生成 native modules。

- [ ] **Step 4: 实现 API 先行发布**

上传 API archive 到 `/tmp/sweet-memories-api-${GITHUB_SHA}.tar.gz`，通过固定 sudo helper activate。API activation 失败时前端步骤必须 skipped；API health 成功后才进入相册模式分支。

- [ ] **Step 5: 实现相册模式和失败关闭**

用 Node JSON 解析读取 `src/config/album-source.json`，只接受 `static|api`，写入 step output。

- static：远程执行 `uploads disable`，公开前端按现有流程发布，健康检查现有静态首页。
- api：远程执行 `migration check-ready`、`migration activate`，再切前端；检查 HTTPS 首页、`/api/photos` 至少包含五个固定旧照片 ID、整体排序合法且首张媒体 2xx；全部成功后执行 `uploads enable`。
- 任意前端/API 公网检查失败：先执行 `uploads disable`，再调用现有前端 `rollback-if-current` 和 API `rollback-if-current`；回退命令有界重试并重新读取当前指针确认新版本已下线。

- [ ] **Step 6: 为新增网络步骤配置预算**

每个 step 必须有正 `timeout-minutes`；job timeout 必须大于全部 step timeout 总和并保留 10 分钟回退余量。SSH 继续使用现有 keepalive 和严格 host key；curl 使用 connect/max/retry 总边界。

- [ ] **Step 7: 验证并提交工作流**

Run:

```bash
pnpm exec vitest run scripts/deploy/workflow.test.ts
pnpm test:deploy
pnpm test:api
pnpm typecheck
```

Expected: 所有工作流合同和脚本测试通过；提取出的所有 Bash run block 均通过 `bash -n`。

```bash
git add .github/workflows/deploy.yml scripts/deploy/workflow.test.ts
git commit -m "ci: deploy and activate the photo API safely"
```

## 任务 20：实现一致性备份和可恢复恢复脚本

**Files:**
- Create: `scripts/ops/backup-data.sh`
- Create: `scripts/ops/restore-data.sh`
- Create: `scripts/ops/data-backup.test.sh`
- Modify: `package.json`

- [ ] **Step 1: 写备份/恢复 RED 集成测试**

fake systemd 环境覆盖：备份先校验容量再停止 API、异常 trap 必定重启、只归档 DB+media、manifest 包含 SHA-256/大小/相对路径、生成可供 Mac 校验的归档 sidecar 摘要、拒绝 symlink/特殊文件；`restore verify` 全程不停止服务，`restore apply` 先校验、拒绝 path traversal、先保存当前数据、健康失败恢复旧数据、成功后保留 recovery bundle。

Run: `bash scripts/ops/data-backup.test.sh`

Expected: FAIL，脚本不存在。

- [ ] **Step 2: 实现停服一致性备份**

固定命令：

```text
sudo backup-data.sh /var/lib/sweet-memories/backups/manual
```

脚本检查目标为固定数据根下普通目录，先计算 DB+media 普通文件总大小并用 `statfs` 确认目标卷至少有“两倍数据大小 + 1GiB”可用空间；容量不足时在停服前失败。`systemctl stop sweet-memories-api` 后验证进程停止，复制 `database/app.db` 和 `media` 到 mode 0700 临时目录，生成排序后的 `SHA256SUMS` 和 `MANIFEST.txt`，再创建 `sweet-memories-data-UTC时间.tar.gz` 及只含归档 basename 的 `.tar.gz.sha256` sidecar。EXIT trap 始终启动服务并检查回环 health。

- [ ] **Step 3: 实现维护模式恢复**

固定命令：

```text
sudo restore-data.sh verify /absolute/path/to/sweet-memories-data-*.tar.gz
sudo restore-data.sh apply /absolute/path/to/sweet-memories-data-*.tar.gz
```

两种模式都先列出归档并拒绝非普通文件/目录、绝对路径和 `..`，在临时目录解包并校验摘要/SQLite integrity/media 引用。`verify` 成功后清理临时目录并退出，不调用 systemctl、不写生产数据；`apply` 才停 API，把当前 data 原子移动到时间戳 recovery 目录，再移动恢复数据、修正 owner/group/mode、启动并检查 API。任何失败将 recovery 原子移回。

- [ ] **Step 4: 验证并提交**

`package.json` 增加：

```json
{
  "test:data-backup": "bash scripts/ops/data-backup.test.sh"
}
```

Run:

```bash
bash -n scripts/ops/backup-data.sh
bash -n scripts/ops/restore-data.sh
pnpm test:data-backup
```

Expected: 全部通过。

```bash
git add scripts/ops package.json
git commit -m "ops: add verified photo data backup and restore"
```

## 任务 21：扩展生产巡检到 API 和同源媒体

**Files:**
- Create: `scripts/monitor/check-photo-api.mjs`
- Create: `scripts/monitor/check-photo-api.test.ts`
- Modify: `.github/workflows/monitor.yml`
- Modify: `scripts/monitor/workflow.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 写巡检 RED 测试**

本地 HTTP server 覆盖：health 2xx JSON、photos 必须为数组、字段无效失败、跨源 media URL 失败、媒体 redirect 失败、2xx 图片成功；static 模式允许零张但 api 模式至少一张。工作流测试要求先运行现有首页检查，再运行 API 检查。

```ts
await expect(checkPhotoApi(server.url, { mode: 'api' })).rejects.toThrow(
  '公开照片列表为空',
)
await expect(checkPhotoApi(server.url, { mode: 'static' })).resolves.toMatchObject({
  photoCount: 0,
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm exec vitest run scripts/monitor/check-photo-api.test.ts scripts/monitor/workflow.test.ts`

Expected: FAIL，API 巡检不存在。

- [ ] **Step 3: 实现只读有界巡检**

`check-photo-api.mjs URL MODE` 使用 Node fetch，单请求 15 秒 AbortSignal、最多 3 次、总流程 90 秒；只允许输入 HTTPS 生产 URL 和同源 `/api`、`/media`。不发送 Cookie/Authorization，不请求 `/admin`，不跟随媒体 redirect。输出只包含状态码、照片数量和最终站点 Origin。

- [ ] **Step 4: 接入工作流和根测试**

monitor workflow 从已检出仓库解析 `album-source.json` 并运行：

```bash
node scripts/monitor/check-photo-api.mjs "$MONITOR_URL" "$ALBUM_MODE"
```

根 `test:monitor` 精确更新为：

```json
{
  "test:monitor": "python3 scripts/monitor/test_extract_assets.py && bash scripts/monitor/check-site.test.sh && vitest run scripts/monitor/check-photo-api.test.ts"
}
```

- [ ] **Step 5: 验证并提交**

Run:

```bash
pnpm test:monitor
pnpm exec vitest run scripts/monitor/workflow.test.ts
```

Expected: 全部通过。

```bash
git add scripts/monitor .github/workflows/monitor.yml package.json
git commit -m "ci: monitor the public photo API and media"
```

## 任务 22：编写服务器、管理员、迁移、备份和回退指南

**Files:**
- Create: `docs/photo-upload-operations.md`
- Create: `scripts/api/docs.test.ts`
- Modify: `docs/deployment.md`

- [ ] **Step 1: 写文档合同 RED 测试**

测试要求指南含：Ubuntu 24.04/Node 24/libheif；固定用户/组/目录/权限；systemd/Nginx/sudoers 安装；管理员交互创建和重置；准备发布；五张日期补录；readiness；备份下载到 Mac；恢复；激活；上传开关；自动/手工回退；日志和磁盘排障。扫描私钥、密码示例、`chmod 777`、关闭 host key、宽泛 sudo 和未限定 `rm -rf`。

Run: `pnpm exec vitest run scripts/api/docs.test.ts`

Expected: FAIL，指南不存在。

- [ ] **Step 2: 写一次性服务器安装步骤**

指南必须逐段说明在哪台机器执行，并用严格 Bash：创建 `sweet-memories` 系统用户、`sweet-memories-media` 组，把 `www-data` 加入媒体组；创建 database 0700、staging 0700、media 2750、backups 0700；从 Node.js 官方 release 下载 `node-v24.20.0-linux-x64.tar.xz`、`SHASUMS256.txt` 和 `SHASUMS256.txt.sig`，验证签名和归档 SHA-256 后安装到 `/usr/local`；apt 安装 `libheif-examples`；安装 root-owned helper/templates；`nginx -t` 后 reload。

- [ ] **Step 3: 写准备阶段和人工日期步骤**

包括：推送准备 Tag；验证 static 相册仍为五张；服务器执行 `import-legacy`；访问 `/admin`；为五张逐一填写日期；运行 `migration check-ready`；明确此时上传仍关闭。

- [ ] **Step 4: 写备份/恢复/激活/回退步骤**

备份段给出服务器生成归档和 sidecar、Mac 通过已有严格 SSH 配置下载两者、Mac 用 sidecar 校验 SHA256，并说明 `restore verify` 不修改生产而 `restore apply` 会进入维护状态。激活段只允许在 readiness 和异地备份成功后把配置改为 api 并发布。手工回退先 `uploads disable`，再条件回退前端和 API；任何 SSH/curl 失败不得继续打印成功。`docs/deployment.md` 只新增“图片 API 扩展”小节，链接到 `photo-upload-operations.md` 并说明原静态前端部署指南继续适用，不重复高风险命令。

- [ ] **Step 5: 验证并提交**

Run:

```bash
pnpm exec vitest run scripts/api/docs.test.ts
git diff --check
```

Expected: 文档合同和安全扫描通过。

```bash
git add docs/photo-upload-operations.md docs/deployment.md scripts/api/docs.test.ts
git commit -m "docs: add photo upload operations guide"
```

## 任务 23：全量验证并执行准备发布

**Files:**
- No code changes expected

- [ ] **Step 1: 从干净安装验证完整仓库**

Run:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:api
pnpm test:deploy
pnpm test:monitor
pnpm test:lighthouse
pnpm build
git diff --check
```

Expected: 所有命令退出 0；Vitest 无失败；Shell 套件输出各自通过；前后端构建成功。

- [ ] **Step 2: 在 Ubuntu 等价环境验证 native runtime**

CI 中安装 `libheif-examples`，运行真实 HEIC fixture 处理、`pnpm package:api`，解包后从产物目录执行：

```bash
node -e "Promise.all([import('argon2'), import('better-sqlite3'), import('sharp')])"
node dist/cli.js --help
```

Expected: native modules 加载成功，CLI 帮助成功。

- [ ] **Step 3: 复核准备模式**

Run:

```bash
node -e "const c=require('./src/config/album-source.json'); if(c.mode!=='static') process.exit(1)"
git status --short --branch
```

Expected: mode 是 static，工作区干净。

- [ ] **Step 4: 先执行一次性服务器配置**

在创建准备 Tag 之前，严格按 `docs/photo-upload-operations.md` 安装 Node/libheif、用户组、目录、systemd、Nginx 和 sudo helper。运行只读 preflight，确认版本目录、数据目录、Nginx 配置、systemd unit 和 sudo helper 均已就绪；此时不启动尚不存在的 API release，不切换公开相册。

- [ ] **Step 5: 推送准备版本并由用户确认 Tag**

把实现分支合并到 `main` 并推送；在用户明确确认版本号后，从 `origin/main` 的目标提交创建并推送 `v*` Tag。不要复用已存在 Tag，不在功能分支 Tag。确认 Tag workflow 绿色、API health 绿色、`/admin` 可登录、公开相册仍为原五张、uploads status 为 false。

- [ ] **Step 6: 导入旧照片、补日期并创建异地备份**

运行 `migration import-legacy`，在后台补齐五张日期，运行 `migration check-ready`。生成一致性备份，下载到 Mac，校验摘要并记录文件路径。只有这三项都成功才进入任务 24。

## 任务 24：切换公开相册到 API 并由工作流开放上传

**Files:**
- Modify: `src/config/album-source.json`
- Modify: `src/config/album-source.test.ts`

- [ ] **Step 1: 再次确认生产 readiness 和备份**

在服务器运行：

```bash
sudo /usr/local/sbin/manage-sweet-memories-api cli migration check-ready
sudo /usr/local/sbin/manage-sweet-memories-api cli uploads status
```

Expected: readiness 成功；uploads 为 false。确认 Mac 上存在已校验的最新备份。

- [ ] **Step 2: 先修改测试期望并确认 RED**

把 `album-source.test.ts` 的生产模式期望从 static 改为 api，运行：

```bash
pnpm exec vitest run src/config/album-source.test.ts
```

Expected: FAIL，实际仍为 static。

- [ ] **Step 3: 只改一行激活配置**

`src/config/album-source.json`：

```json
{ "mode": "api" }
```

- [ ] **Step 4: 验证激活提交**

Run:

```bash
pnpm exec vitest run src/config/album-source.test.ts src/services/photoApi.test.ts src/App.test.ts scripts/deploy/workflow.test.ts
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

Expected: 全部通过，差异只包含 mode 和对应测试期望。

- [ ] **Step 5: 提交并发布激活 Tag**

```bash
git add src/config/album-source.json src/config/album-source.test.ts
git commit -m "feat: activate the API-backed photo album"
```

合并并推送 `main` 后，由用户确认新版本号，再从该提交创建 Tag。工作流必须按 migration activate → frontend activate → public health → uploads enable 的顺序完成。

## 任务 25：生产激活验收和发布持久性检查

**Files:**
- No code changes expected

- [ ] **Step 1: 验证公开照片和上传开关**

确认 Tag workflow 绿色；生产巡检绿色；Lighthouse 绿色。访问 `https://huangjianfen.cn`，确认五张照片数量、标题、顺序、交互、视频和音频。服务器 `uploads status` 必须为 true。

- [ ] **Step 2: 完成管理员核心路径**

从手机一次选择 10 张混合支持格式，确认浏览器最多两个上传、服务器逐张处理、成功项自动公开。编辑其中一张标题/日期/描述并验证公开排序；触发一次会话过期，确认草稿保留、重新登录后不自动保存、手动继续上传有效。

- [ ] **Step 3: 验证隐私和永久删除**

下载公开 JPEG，用 exiftool 验证无 GPS、设备型号和输入 EXIF。删除专用测试照片，确认二次确认、公开 API 无记录、所有公开派生 URL 404、备份外无回收站。

- [ ] **Step 4: 用正常测试 Tag 验证发布持久性**

先记录管理员、照片数量、uploads 状态和一张媒体摘要，再发布一个不修改数据模型的正常测试 Tag。确认工作流绿色、SQLite/media/管理员会话未被 release 清理、数量和摘要不变。失败关闭及条件回退只复核任务 18/19 的自动化测试证据，不在生产主动制造故障。

- [ ] **Step 5: 创建激活后异地备份并最终验证**

生成新一致性备份并下载归档及 sidecar 到 Mac；在服务器执行 `restore-data.sh verify`，确认不停止 API且不覆盖生产。最后运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:api
pnpm test:deploy
pnpm test:monitor
pnpm test:lighthouse
pnpm build
git status --short --branch
```

Expected: 所有命令退出 0，工作区干净；生产 monitor 和 Lighthouse 保持绿色。
