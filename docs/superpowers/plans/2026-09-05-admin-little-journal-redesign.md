# Little Journal Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把管理员相册重塑为以日期叙事为主体、保留照片装裱感的“小小成长志”，同时完整保留现有认证、上传、编辑、删除、竞态保护和移动端行为。

**Architecture:** 只调整现有 Vue 管理端组件的展示结构和 `admin.css` 视觉系统。年份分段在 `PhotoLibrary.vue` 中由当前照片数组同步派生，严格保留 API 顺序；组件事件、composable、API 与后端合同保持不变。每个结构变化先用 Vue Test Utils 建立失败测试，再实现最小模板和样式，最后执行全管理端回归与桌面/移动视觉验收。

**Tech Stack:** Vue 3 Composition API、TypeScript、Vue Test Utils、Vitest、Lucide Vue、原生响应式 CSS。

---

## 文件结构

- Modify: `src/admin/AdminApp.vue`：品牌锁定、页面标题和管理端外壳语义。
- Modify: `src/admin/AdminApp.test.ts`：品牌、标题、设计 token 和既有集成行为回归。
- Modify: `src/admin/PhotoLibrary.vue`：相邻年份分段、照片装裱结构和日期文本。
- Modify: `src/admin/PhotoLibrary.test.ts`：顺序稳定的年份分段、照片卡、模态与焦点回归。
- Modify: `src/admin/PhotoEditor.vue`：记录页标题和装裱预览结构。
- Modify: `src/admin/PhotoEditor.test.ts`：编辑器结构、保存、冲突和事件回归。
- Modify: `src/admin/UploadQueue.vue`：轻量装裱缩略图结构。
- Modify: `src/admin/UploadQueue.test.ts`：队列视觉语义和两阶段进度回归。
- Modify: `src/styles/admin.css`：统一颜色、字体、边框、阴影、状态和响应式规则。

不修改 `src/admin/usePhotoLibrary.ts`、`src/admin/useUploadQueue.ts`、`src/admin/useAdminSession.ts`、`src/admin/api.ts`、后端、公开相册或部署文件。

### Task 1: 建立“小小成长志”视觉基础与页面外壳

**Files:**
- Modify: `src/admin/AdminApp.vue:89-140`
- Modify: `src/admin/AdminApp.test.ts:79-268`
- Modify: `src/styles/admin.css:1-280`

- [ ] **Step 1: 写入品牌、页面标题和设计 token 的失败测试**

在 `src/admin/AdminApp.test.ts` 的集成测试末尾加入：

```ts
it('renders the little-journal brand and growth-album heading', async () => {
  const wrapper = mount(AdminApp, {
    props: {
      session: session(),
      photoApi: photoApi([photo({ status: 'published' })]),
      uploadApi: idleUploadApi(),
    },
  })
  await flushPromises()

  expect(wrapper.get('.admin-brand-mark').text()).toBe('忆')
  expect(wrapper.get('.admin-brand-mark').attributes('aria-hidden')).toBe('true')
  expect(wrapper.get('.admin-toolbar h1').text()).toBe('相册管理')
  expect(wrapper.get('#photo-library-title > span:first-child').text()).toBe('成长相册')
  expect(wrapper.get('[data-photo-count]').text()).toBe('共 1 张')
})

it('defines the approved little-journal color tokens', () => {
  expect(adminCss).toContain('--admin-canvas: #f7f4f5')
  expect(adminCss).toContain('--admin-paper: #fffdfd')
  expect(adminCss).toContain('--admin-berry: #b84061')
  expect(adminCss).toContain('--admin-teal: #39767a')
  expect(adminCss).toContain('--admin-sun: #efa95a')
  expect(adminCss).not.toMatch(/linear-gradient|radial-gradient/)
})
```

- [ ] **Step 2: 运行测试并确认失败原因是新结构和 token 尚不存在**

Run:

```bash
pnpm exec vitest run src/admin/AdminApp.test.ts
```

Expected: FAIL；找不到 `.admin-brand-mark`、标题仍为“照片库”，且 `--admin-canvas` 等 token 不存在。既有测试不得先出现行为回归。

- [ ] **Step 3: 实现品牌锁定和成长相册标题**

将 `src/admin/AdminApp.vue` 的工具栏左侧结构替换为：

```vue
<div class="admin-brand-lockup">
  <span
    class="admin-brand-mark"
    aria-hidden="true"
  >
    忆
  </span>
  <div>
    <p class="admin-eyebrow">
      甜蜜回忆
    </p>
    <h1>相册管理</h1>
  </div>
</div>
```

将图库标题中的首个文本节点改为：

```vue
<span>成长相册</span>
```

在 `src/styles/admin.css` 的 `.admin-app` 中集中定义并使用基础变量：

```css
.admin-app {
  --admin-control-size: 40px;
  --admin-canvas: #f7f4f5;
  --admin-paper: #fffdfd;
  --admin-berry: #b84061;
  --admin-berry-pressed: #8f2f4a;
  --admin-teal: #39767a;
  --admin-sun: #efa95a;
  --admin-success: #28674d;
  --admin-text: #2d292c;
  --admin-muted: #70676c;
  --admin-border: #dfd6da;
  --admin-sans: "PingFang SC", "Microsoft YaHei", sans-serif;
  --admin-serif: "Songti SC", "STSong", serif;

  min-height: 100vh;
  overflow-x: clip;
  color: var(--admin-text);
  background: var(--admin-canvas);
  font-family: var(--admin-sans);
}

.admin-brand-lockup {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 12px;
}

.admin-brand-mark {
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  border: 1px solid var(--admin-berry-pressed);
  border-radius: 6px;
  color: #ffffff;
  background: var(--admin-berry);
  box-shadow: 4px 4px 0 #eed0d9;
  font-family: var(--admin-serif);
  font-size: 1.15rem;
  font-weight: 700;
  place-items: center;
}

.admin-primary-button {
  color: #ffffff;
  background: var(--admin-berry);
}

.admin-photo-count {
  color: var(--admin-teal);
  font-variant-numeric: tabular-nums;
}

.admin-login-panel,
.admin-dialog,
.admin-photo-editor,
.admin-editor-placeholder {
  border-color: var(--admin-border);
  background: var(--admin-paper);
}

.admin-secondary-button,
.admin-icon-button,
.admin-editor-back {
  border-color: #bfb3b8;
  color: var(--admin-text);
  background: var(--admin-paper);
}
```

用变量替换相同语义的现有页面背景、主文字、次文字、边框和主按钮色。明确删除被上述规则取代的重复旧声明；错误色仍保留独立语义色，不替换为莓果色。

- [ ] **Step 4: 运行测试并确认页面外壳转绿**

Run:

```bash
pnpm exec vitest run src/admin/AdminApp.test.ts
```

Expected: PASS；品牌标记、标题、照片数量和既有集成测试全部通过。

- [ ] **Step 5: 提交页面外壳**

```bash
git add src/admin/AdminApp.vue src/admin/AdminApp.test.ts src/styles/admin.css
git commit -m "feat: establish the little journal admin shell"
```

### Task 2: 增加稳定年份分段和照片装裱

**Files:**
- Modify: `src/admin/PhotoLibrary.vue:1-350`
- Modify: `src/admin/PhotoLibrary.test.ts:17-190`
- Modify: `src/styles/admin.css:427-490`

- [ ] **Step 1: 写入顺序、缺失日期和卡片日期的失败测试**

在 `src/admin/PhotoLibrary.test.ts` 增加测试辅助函数：

```ts
function photoRecord(
  id: string,
  title: string,
  capturedDate: string | null,
): AdminPhoto {
  return {
    ...photo,
    id,
    title,
    capturedDate,
    sources: {
      avif: [{ url: `/media/${id}/320.avif`, width: 320 }],
      webp: [{ url: `/media/${id}/320.webp`, width: 320 }],
      jpeg: [{ url: `/media/${id}/320.jpg`, width: 320 }],
      fallback: { url: `/media/${id}/320.jpg`, width: 320, height: 240 },
    },
  }
}
```

加入以下测试：

```ts
it('segments adjacent years without reordering photos and labels missing dates', () => {
  const photos = [
    photoRecord('a', '春日', '2026-05-01'),
    photoRecord('b', '夏日', '2026-06-02'),
    photoRecord('c', '去年', '2025-12-31'),
    photoRecord('d', '再次出现的今年', '2026-01-01'),
    photoRecord('e', '日期待补', null),
  ]
  const wrapper = mount(PhotoLibrary, {
    props: { library: library({ photos: ref(photos) }) },
  })

  const sections = wrapper.findAll('[data-photo-year-section]')
  expect(sections.map((section) => section.get('h3').text())).toEqual([
    '2026 年 · 成长片段',
    '2025 年 · 成长片段',
    '2026 年 · 成长片段',
    '待补充日期',
  ])
  expect(sections.map((section) => (
    section.findAll('[data-photo-id]').map((card) => card.attributes('data-photo-id'))
  ))).toEqual([['a', 'b'], ['c'], ['d'], ['e']])
  expect(wrapper.get('[data-photo-id="a"] [data-captured-date]').text()).toBe('2026.05.01')
  expect(wrapper.get('[data-photo-id="e"] [data-captured-date]').text()).toBe('日期待补充')

  await wrapper.get('[data-photo-id="a"] button').trigger('click')
  expect(wrapper.get('[data-photo-id="a"] .admin-photo-selected').find('svg').exists()).toBe(true)
})
```

- [ ] **Step 2: 运行测试并确认当前平铺网格失败**

Run:

```bash
pnpm exec vitest run src/admin/PhotoLibrary.test.ts -t "segments adjacent years"
```

Expected: FAIL；当前没有 `[data-photo-year-section]` 与 `[data-captured-date]`。

- [ ] **Step 3: 在组件内同步派生连续年份分段**

在 `src/admin/PhotoLibrary.vue` 的 `<script setup>` 中加入：

同时把图标导入改为：

```ts
import { Check, RefreshCw, Upload } from '@lucide/vue'
```

再加入分段类型与派生逻辑：

```ts
interface PhotoSection {
  readonly key: string
  readonly group: string
  readonly label: string
  readonly photos: AdminPhoto[]
}

const photoSections = computed<PhotoSection[]>(() => {
  const sections: PhotoSection[] = []
  for (const photo of props.library.photos.value) {
    const year = photo.capturedDate?.slice(0, 4) ?? null
    const group = year ?? 'undated'
    const previous = sections.at(-1)
    if (previous?.group === group) {
      previous.photos.push(photo)
      continue
    }
    sections.push({
      key: `${group}-${sections.length}`,
      group,
      label: year === null ? '待补充日期' : `${year} 年 · 成长片段`,
      photos: [photo],
    })
  }
  return sections
})

function capturedDateLabel(value: string | null): string {
  return value === null ? '日期待补充' : value.replaceAll('-', '.')
}
```

保持外层 `.admin-photo-grid` 的 `inert`、`aria-hidden`、`aria-label` 和 `data-mobile-columns`，将卡片循环改为：

```vue
<div
  class="admin-photo-grid"
  data-mobile-columns="2"
  aria-label="照片库"
  :inert="isMobileEditorOpen"
  :aria-hidden="isMobileEditorOpen ? 'true' : undefined"
>
  <section
    v-for="section in photoSections"
    :key="section.key"
    class="admin-photo-year-section"
    :data-photo-year-section="section.key"
    :aria-labelledby="`photo-year-${section.key}`"
  >
    <header class="admin-photo-year-heading">
      <span aria-hidden="true" />
      <h3 :id="`photo-year-${section.key}`">
        {{ section.label }}
      </h3>
    </header>
    <div class="admin-photo-section-grid">
      <article
        v-for="photo in section.photos"
        :key="photo.id"
        class="admin-photo-card"
        :class="{ 'is-selected': library.selectedId.value === photo.id }"
        :data-photo-id="photo.id"
      >
        <button
          type="button"
          @click="openPhoto(photo.id, $event)"
        >
          <picture>
            <source
              type="image/avif"
              :srcset="sourceSet(photo.sources.avif)"
            >
            <source
              type="image/webp"
              :srcset="sourceSet(photo.sources.webp)"
            >
            <img
              :src="photo.sources.fallback.url"
              :alt="photo.alt"
              :width="photo.sources.fallback.width"
              :height="photo.sources.fallback.height"
            >
          </picture>
          <span
            v-if="library.selectedId.value === photo.id"
            class="admin-photo-selected"
            aria-hidden="true"
          >
            <Check :size="16" />
          </span>
          <span class="admin-photo-card-copy">
            <strong>{{ photo.title }}</strong>
            <small data-captured-date>{{ capturedDateLabel(photo.capturedDate) }}</small>
          </span>
        </button>
      </article>
    </div>
  </section>
</div>
```

- [ ] **Step 4: 实现分段和装裱样式**

用以下结构替换原 `.admin-photo-grid` 平铺规则，并更新卡片文本选择器：

```css
.admin-photo-grid {
  display: grid;
  gap: 30px;
}

.admin-photo-year-section {
  min-width: 0;
}

.admin-photo-year-heading {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
  gap: 10px;
}

.admin-photo-year-heading > span {
  width: 28px;
  height: 3px;
  flex: 0 0 28px;
  background: var(--admin-sun);
}

.admin-photo-year-heading h3 {
  margin: 0;
  color: var(--admin-text);
  font-family: var(--admin-serif);
  font-size: 1rem;
}

.admin-photo-section-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 14px;
}

.admin-photo-card button {
  position: relative;
  display: grid;
  width: 100%;
  padding: 6px;
  overflow: hidden;
  border: 1px solid var(--admin-border);
  border-radius: 6px;
  color: var(--admin-text);
  background: var(--admin-paper);
  box-shadow: 0 8px 20px rgb(76 54 64 / 8%);
  text-align: left;
  cursor: pointer;
}

.admin-photo-selected {
  position: absolute;
  top: 12px;
  right: 12px;
  display: grid;
  width: 26px;
  height: 26px;
  border: 2px solid #ffffff;
  border-radius: 50%;
  color: #ffffff;
  background: var(--admin-berry);
  box-shadow: 0 2px 8px rgb(45 41 44 / 20%);
  place-items: center;
}

.admin-photo-card-copy {
  display: grid;
  min-height: 58px;
  padding: 10px 7px 6px;
  gap: 3px;
}

.admin-photo-card-copy strong {
  overflow: hidden;
  font-family: var(--admin-serif);
  font-size: 0.95rem;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-photo-card-copy small {
  color: var(--admin-muted);
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}
```

删除原 `.admin-photo-card span` 规则；移动端原 `.admin-photo-card span` 选择器同步改为 `.admin-photo-card-copy`，确保选中对勾不会继承文字区的尺寸、内边距或溢出规则。

选中状态继续使用边框和外圈，并使用上述 Lucide `Check` 标记；标记设置 `aria-hidden="true"`，按钮的可访问名称继续来自照片内容。

- [ ] **Step 5: 运行照片库测试并提交**

Run:

```bash
pnpm exec vitest run src/admin/PhotoLibrary.test.ts
```

Expected: PASS；年份分段、照片顺序、焦点恢复、移动端模态和删除流程全部通过。

```bash
git add src/admin/PhotoLibrary.vue src/admin/PhotoLibrary.test.ts src/styles/admin.css
git commit -m "feat: group and mount admin memories"
```

### Task 3: 把编辑器塑造成清晰的照片记录页

**Files:**
- Modify: `src/admin/PhotoEditor.vue:29-161`
- Modify: `src/admin/PhotoEditor.test.ts:19-76`
- Modify: `src/styles/admin.css:492-592`

- [ ] **Step 1: 写入记录页标题和装裱预览的失败测试**

在 `src/admin/PhotoEditor.test.ts` 加入：

```ts
it('presents the editor as a mounted memory record without changing its commands', async () => {
  const wrapper = mount(PhotoEditor, {
    props: {
      photo,
      draft,
      conflict: false,
      saving: false,
      message: '',
      messageTone: null,
    },
  })

  expect(wrapper.get('.admin-photo-editor-kicker').text()).toBe('照片信息')
  expect(wrapper.get('.admin-photo-editor h2').text()).toBe('记录这张照片')
  expect(wrapper.get('.admin-editor-mount img').attributes()).toMatchObject({
    src: '/media/photo-1/320.jpg',
    width: '320',
    height: '240',
  })
  expect(wrapper.get('button[type="submit"]').text()).toBe('保存修改')

  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('save')).toHaveLength(1)
})
```

- [ ] **Step 2: 运行测试并确认旧标题和裸图片失败**

Run:

```bash
pnpm exec vitest run src/admin/PhotoEditor.test.ts -t "mounted memory record"
```

Expected: FAIL；标题仍为“编辑照片”，不存在 `.admin-photo-editor-kicker` 和 `.admin-editor-mount`。

- [ ] **Step 3: 更新编辑器模板但保持事件合同**

把标题和预览改为：

```vue
<div>
  <p class="admin-photo-editor-kicker">
    照片信息
  </p>
  <h2>记录这张照片</h2>
</div>

<div class="admin-editor-mount">
  <img
    class="admin-editor-preview"
    :src="photo.sources.fallback.url"
    :alt="photo.alt"
    :width="photo.sources.fallback.width"
    :height="photo.sources.fallback.height"
  >
</div>
```

删除、返回、字段顺序、冲突按钮、保存消息和 `emit` 声明保持原样。

- [ ] **Step 4: 更新记录页样式**

```css
.admin-photo-editor,
.admin-editor-placeholder {
  position: sticky;
  top: 20px;
  width: 320px;
  border: 1px solid var(--admin-border);
  border-radius: 6px;
  background: var(--admin-paper);
  box-shadow: 8px 10px 0 rgb(57 118 122 / 10%);
}

.admin-photo-editor-kicker {
  margin: 0 0 4px;
  color: var(--admin-teal);
  font-size: 0.875rem;
  font-weight: 800;
}

.admin-photo-editor-header h2 {
  margin: 0;
  font-family: var(--admin-serif);
  font-size: 1.12rem;
}

.admin-editor-mount {
  padding: 6px;
  border: 1px solid var(--admin-border);
  background: #ffffff;
  box-shadow: 0 7px 18px rgb(76 54 64 / 9%);
}

.admin-editor-preview {
  display: block;
  width: 100%;
  height: 176px;
  object-fit: cover;
  background: #eee8ea;
}
```

- [ ] **Step 5: 运行编辑器与照片库回归并提交**

Run:

```bash
pnpm exec vitest run src/admin/PhotoEditor.test.ts src/admin/PhotoLibrary.test.ts
```

Expected: PASS；保存、冲突、删除、返回和草稿事件没有回归。

```bash
git add src/admin/PhotoEditor.vue src/admin/PhotoEditor.test.ts src/styles/admin.css
git commit -m "feat: frame the admin photo record editor"
```

### Task 4: 统一上传队列和业务状态的视觉语言

**Files:**
- Modify: `src/admin/UploadQueue.vue:56-152`
- Modify: `src/admin/UploadQueue.test.ts:41-114`
- Modify: `src/styles/admin.css:293-425`

- [ ] **Step 1: 写入装裱缩略图和两阶段状态的失败测试**

在 `src/admin/UploadQueue.test.ts` 加入：

```ts
it('uses a light photo mount while preserving honest two-stage progress', async () => {
  const state = queue([item({ progress: 46 })])
  const wrapper = mount(UploadQueue, { props: { queue: state } })

  expect(wrapper.get('.admin-upload-thumbnail img').attributes()).toMatchObject({
    src: 'blob:family',
    alt: '',
    width: '64',
    height: '64',
  })
  expect(wrapper.get('progress').attributes('value')).toBe('46')
  expect(wrapper.text()).toContain('正在上传 46%')

  state.items.value = [item({ progress: 100 })]
  await wrapper.vm.$nextTick()

  expect(wrapper.get('progress').attributes('value')).toBeUndefined()
  expect(wrapper.get('progress').attributes('aria-label')).toBe('服务器处理 family.jpg')
  expect(wrapper.text()).toContain('服务器处理中')
})
```

- [ ] **Step 2: 运行测试并确认缩略图包装尚不存在**

Run:

```bash
pnpm exec vitest run src/admin/UploadQueue.test.ts -t "light photo mount"
```

Expected: FAIL；找不到 `.admin-upload-thumbnail`，既有进度断言仍通过。

- [ ] **Step 3: 增加轻量装裱缩略图**

把队列项中的图片改为：

```vue
<div class="admin-upload-thumbnail">
  <img
    :src="item.previewUrl"
    alt=""
    width="64"
    height="64"
  >
</div>
```

不得修改 `itemStatus()`、`queueSummary()`、`progress` 的确定/不确定模式、继续上传按钮或队列操作事件。

- [ ] **Step 4: 更新队列、迁移横幅和状态样式**

```css
.admin-upload-queue {
  margin-bottom: 24px;
  border-block: 1px solid var(--admin-border);
}

.admin-upload-item {
  min-width: 0;
  min-height: 88px;
  padding: 12px 0;
  border-top: 1px solid var(--admin-border);
  gap: 14px;
}

.admin-upload-thumbnail {
  width: 70px;
  height: 70px;
  flex: 0 0 70px;
  padding: 3px;
  border: 1px solid var(--admin-border);
  background: var(--admin-paper);
  box-shadow: 3px 4px 0 rgb(57 118 122 / 8%);
}

.admin-upload-thumbnail img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.admin-upload-detail progress {
  width: 100%;
  height: 8px;
  grid-column: 1;
  accent-color: var(--admin-berry);
}

.admin-migration-banner,
.admin-upload-resume {
  border-inline-start: 4px solid var(--admin-sun);
  color: #5f452b;
  background: #fff7e9;
}
```

保存成功继续使用绿色图标、文字和淡绿色背景；错误、冲突、删除继续使用各自语义色。空态和加载态保持紧凑，不新增插画或说明卡片。

- [ ] **Step 5: 运行上传队列测试并提交**

Run:

```bash
pnpm exec vitest run src/admin/UploadQueue.test.ts
```

Expected: PASS；确定进度、服务器处理中、失败重试、显式继续和可访问名称全部通过。

```bash
git add src/admin/UploadQueue.vue src/admin/UploadQueue.test.ts src/styles/admin.css
git commit -m "feat: restyle the admin upload states"
```

### Task 5: 收敛桌面与移动响应式布局

**Files:**
- Modify: `src/admin/AdminApp.test.ts:249-268`
- Modify: `src/admin/PhotoLibrary.test.ts:291-420`
- Modify: `src/styles/admin.css:679-787`

- [ ] **Step 1: 写入 CSS 布局合同的失败测试**

在 `src/admin/AdminApp.test.ts` 加入：

```ts
it('keeps the approved desktop and mobile layout constraints', () => {
  expect(adminCss).toMatch(
    /\.admin-library-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*320px/s,
  )
  expect(adminCss).toMatch(
    /\.admin-photo-section-grid\s*\{[^}]*minmax\(180px,\s*1fr\)/s,
  )
  expect(adminCss).toMatch(
    /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-photo-section-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
  )
  expect(adminCss).toMatch(
    /@media\s*\(max-width:\s*720px\)[\s\S]*\.admin-photo-editor\s*\{[^}]*position:\s*fixed[^}]*height:\s*100dvh/,
  )
  expect(adminCss).toContain('@media (prefers-reduced-motion: reduce)')
})
```

在现有移动端 PhotoLibrary 测试中继续断言：照片浏览区被 `inert`、全屏编辑器具有 `role="dialog"` 和 `aria-modal="true"`、关闭后焦点回到原卡片；只把查询目标从内部列网格改到仍保留这些属性的外层 `.admin-photo-grid`。

- [ ] **Step 2: 运行布局合同并确认缺少新网格与 reduced-motion 规则**

Run:

```bash
pnpm exec vitest run src/admin/AdminApp.test.ts src/admin/PhotoLibrary.test.ts
```

Expected: FAIL；`.admin-photo-section-grid` 的移动双列规则和 `prefers-reduced-motion` 尚未齐备。既有焦点与模态测试仍应通过。

- [ ] **Step 3: 实现稳定桌面、移动和动效规则**

在 `src/styles/admin.css` 中落实：

```css
.admin-library-layout {
  display: grid;
  align-items: start;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 24px;
}

.admin-primary-button,
.admin-secondary-button,
.admin-icon-button,
.admin-photo-card button {
  transition:
    border-color 180ms ease,
    box-shadow 180ms ease,
    color 180ms ease,
    background-color 180ms ease,
    transform 180ms ease;
}

.admin-photo-card button:hover {
  border-color: #c9b9bf;
  box-shadow: 0 10px 24px rgb(76 54 64 / 12%);
}

.admin-primary-button:active:not(:disabled),
.admin-secondary-button:active:not(:disabled) {
  transform: translateY(1px);
}

@media (max-width: 720px) {
  .admin-workspace {
    width: min(100% - 24px, 1180px);
    padding-top: 16px;
  }

  .admin-photo-section-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .admin-photo-card button {
    padding: 4px;
  }

  .admin-photo-card-copy {
    min-height: 58px;
    padding: 8px 6px 5px;
  }

  .admin-photo-editor {
    position: fixed;
    z-index: 40;
    inset: 0;
    width: auto;
    height: 100dvh;
    overflow-y: auto;
    padding: 18px 16px calc(28px + env(safe-area-inset-bottom));
    border: 0;
    border-radius: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .admin-primary-button,
  .admin-secondary-button,
  .admin-icon-button,
  .admin-photo-card button {
    transition: none;
  }
}
```

保留桌面 `40px` 工具栏控件；表单、对话框和移动端触控操作维持至少 `44px`。照片、按钮、标题、长文件名和错误文案不得造成横向滚动。

- [ ] **Step 4: 运行完整管理端测试并提交**

Run:

```bash
pnpm exec vitest run src/admin src/main.test.ts
```

Expected: PASS；登录、重登、照片库、上传、编辑、删除、焦点、数量和保存成功全部通过。

```bash
git add src/admin/AdminApp.test.ts src/admin/PhotoLibrary.test.ts src/styles/admin.css
git commit -m "feat: finish the responsive little journal layout"
```

### Task 6: 全量验证与视觉验收

**Files:**
- Verify: `src/admin/*.vue`
- Verify: `src/admin/*.test.ts`
- Verify: `src/styles/admin.css`
- Do not commit: `.superpowers/`
- Do not commit: `dist/`
- Do not commit: `apps/api/dist/`

- [ ] **Step 1: 运行 focused 管理端回归**

Run:

```bash
pnpm exec vitest run src/admin src/main.test.ts
```

Expected: 全部 PASS，无 Vue warning、未处理 Promise 或意外网络请求。

- [ ] **Step 2: 运行 source-only 全量测试**

Run:

```bash
pnpm exec vitest run --exclude 'apps/api/dist/**'
```

Expected: 全部 PASS；不得因为生成的 API `dist` 重复收集测试。

- [ ] **Step 3: 运行类型、代码风格和前端构建**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm build:frontend
git diff --check
```

Expected: 四条命令均 exit 0。若宿主 Node 版本只产生项目已知 engine warning，记录 warning，但不得忽略实际错误。

- [ ] **Step 4: 检查构建产物与工作树范围**

Run:

```bash
git status --short
git diff --stat HEAD~5..HEAD
```

Expected: 只包含本计划列出的管理端组件、测试和 `admin.css`；`.superpowers/`、根 `dist/`、`apps/api/dist/` 不进入提交。

- [ ] **Step 5: 启动本地前端并执行可获得的浏览器检查**

Run:

```bash
pnpm dev --host 127.0.0.1 --port 4173
```

在 `http://127.0.0.1:4173/admin` 检查登录页，并在有可用同源 API/已认证环境时检查完整工作区：

- `1440 × 900`：年份标题、至少四列照片、320px sticky 编辑器、上传队列展开、长标题。
- `390 × 844`：固定双列、底部操作区、全屏编辑器、返回焦点、删除和重登单一模态。
- `320px` 宽：按钮文字、错误提示和长文件名不溢出。
- 200% 文本缩放：不遮挡主操作，无横向滚动。
- reduced motion：无非必要过渡。

若当前浏览器工具或本地同源 API 不可用，不得声称完成了完整工作区截图；记录限制，并把真实认证工作区的桌面/移动人工检查列为部署前门槛。截图只保存到临时目录，不提交。

- [ ] **Step 6: 最终回归确认**

重新运行：

```bash
pnpm exec vitest run src/admin src/main.test.ts
pnpm typecheck
pnpm lint
git status --short --branch
```

Expected: 测试、类型和 lint 全绿；分支只允许存在明确披露且未跟踪的视觉草稿目录，不得有未提交生产改动。

## 完成定义

- H“小小成长志”日期叙事和 F 照片装裱感均落实到真实管理端。
- 照片严格保持 API 顺序，只按相邻年份分段；缺失日期显示“待补充日期”。
- 桌面维持高效网格与 sticky 编辑器，移动端维持双列和全屏编辑器。
- 上传两阶段进度、刷新、保存成功、冲突、永久删除、会话恢复和所有竞态保护没有回归。
- 所有管理端交互可键盘访问，状态不只依赖颜色，模态背景继续正确隔离。
- focused tests、source-only tests、typecheck、lint、frontend build 和 diff-check 全部通过。
- 生产文件提交中不包含视觉草稿、截图或构建产物。
