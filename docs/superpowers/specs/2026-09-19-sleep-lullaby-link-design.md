# 哄睡模式联动摇篮曲

## 目标

点月亮进入哄睡时，相册切到夜景，并在同一次点击里尝试播放摇篮曲。退出哄睡只恢复相册，不停音乐。音符按钮在夜景和相册里都仍是唯一的暂停/继续控制。

## 当前问题

- `App.vue` 把 `FloatingControls` 的 `is-overlay-visible` 写死为 `false`，`useSleepMode` 的 3 秒 overlay 从未显示。
- SleepView 已有「嘘，宝宝睡着了... 💤」。再叠 overlay 会重复。
- 月亮和音符互不相关：进哄睡不会播摇篮曲。

## 行为

### 进入哄睡

用户点击月亮：

1. 立刻 `emit('toggle-sleep')`，相册切到 SleepView。
2. 若音频状态不是 `playing` 且不是 `loading`，在同一次点击里调用只播不切的 `play()`。
3. 若已经在播或正在加载，不调用播放，也不暂停。

### 退出哄睡

再点月亮：只切回相册。不暂停、不重播、不重置音频。音符按钮继续控制播放。

### 播放失败

`play()` 被浏览器拦截或媒体出错：

- 夜景照进。
- 音频停在未播（`error`）。
- 沿用现有读屏文案「音乐暂时无法播放」。
- 不弹第二层 overlay，不打断哄睡。

### Overlay

本次不启用 3 秒 overlay。`App.vue` 继续传 `is-overlay-visible="false"`。`useSleepMode` 里的 overlay 计时先保留，不删除。

## 实现边界

联动放在 `FloatingControls` 的月亮点击处理里，不把播放器状态抬到 `App.vue`。同一次用户手势才能通过浏览器自动播放限制。

- `useAudioPlayer` 增加 `play()`：只尝试播放。`playing` 或 `loading` 时 no-op。失败走现有 `error` 路径。
- `togglePlayback()` 行为不变，仍给音符按钮用。
- 摇篮曲仍是静态 `src/data/memories.ts` 的 `audioSources`（`lullaby.m4a` / `lullaby.mp3`）。
- 不改 SleepView 文案或画面。
- 不改成长视频。
- 不改后台、API、相册数据源。

## 测试

- 未播放时点月亮：发出 `toggle-sleep`，并调用 `HTMLMediaElement.play()`。
- 已在播放时点月亮：发出 `toggle-sleep`，不暂停。
- 从哄睡退出：不调用 `pause()`，播放状态保持。
- `play()` 失败：仍发出 `toggle-sleep`，出现「音乐暂时无法播放」，不渲染 overlay。
- `App.vue` 仍把 overlay 固定为隐藏。

验证命令：`pnpm exec vitest run src/components/FloatingControls.test.ts src/composables/useAudioPlayer.test.ts src/App.test.ts`，再 `pnpm typecheck` 与 `pnpm lint`。

## 范围外

- 不按退出哄睡自动停音乐。
- 不新增可配置摇篮曲或音量控制。
- 不把 overlay 接到 App。
- 不清理 `useSleepMode` 的 overlay 计时（可另开）。
