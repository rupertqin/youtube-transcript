---
name: panel-resync-self-healing
overview: 面板切页后冻结在旧视频（标题与字幕都不更新）。根因不在抓取链，而在切页驱动：tick 先更新 lastUrl 再干活，任何异常都会让 session.sync 被永久跳过；面板也没有「当前页视频 ≠ 面板视频」的自检。改为会话级自我纠偏 + 面板渲染前置新鲜度闸门，并补缓存诊断与清空入口。
todos:
  - id: session-reconcile
    content: 在 session.ts 新增 reconcile/start/dispose 定时自愈，并让 title 钩子按 videoId 取标题
    status: completed
  - id: entry-hardening
    content: 改造油猴与扩展入口：tick 先干活后记 lastUrl、逐步 try/catch、启动 session.start
    status: completed
    dependencies:
      - session-reconcile
  - id: sidebar-remount
    content: "修复 sidebar.ensurePanel 宿主重建后不重挂，并清理重复的 #ytt-sidebar-host"
    status: completed
  - id: panel-gate
    content: panel.ts 增加新鲜度闸门与 currentVideoId 选项，statusbar 诊断显示 当前/面板 videoId 并支持清空缓存
    status: completed
    dependencies:
      - sidebar-remount
  - id: verify
    content: 补 reconcile、重挂、闸门三组回归测试，跑 tsc/vitest/build 全量验收
    status: completed
    dependencies:
      - session-reconcile
      - entry-hardening
      - sidebar-remount
      - panel-gate
  - id: docs
    content: 更新 README 的自愈机制与缓存语义说明，递增版本号
    status: completed
    dependencies:
      - verify
---

## 问题现象
面板在切换视频后**整个冻结在上一个视频**：标题不变、字幕不变。用户反馈「标题也不变，整个面板都是旧视频的内容」「切换过程会把很早以前的字幕拿出来」「刷新页面/新开标签也会」。

## 已定位的根因（不再改抓取链）
标题来自 `document.title`读取的 `readTitle(win)`，与抓取无关。标题也停在旧视频 ⇒ **面板状态从未切换**，前两轮改的 DOM/videoId 归属校验全在下游，永远走不到。具体有三处缺陷：

1. **切页驱动一旦抛异常就永久失效**：`userscript/main.ts` 的 `tick()` 先 `lastUrl = location.href` 再执行 `sidebar.ensureMounted(); session.sync();`。`ensureMounted()` 抛一次异常，本次 `sync()` 被跳过，而 `lastUrl` 已更新 —— 之后每次 tick 都在第一行 return，**该页面再也不会同步**。`entrypoints/content.ts` 的 `wxt:locationchange` 回调同样没有隔离。
2. **会话没有自愈能力**：`session.sync()` 只在被显式调用时推进，没有「`store.videoId` 与当前页 `?v=` 不一致就重建」的定时检查，漏一次就是永久错。
3. **侧栏宿主重建后面板不重新挂载**：`sidebar.ensurePanel()` 只要 `panel` 已存在就 `return`，YouTube 重建 `#secondary-inner` 后新建的 shadow root 是空的，面板元素仍留在旧（已脱离）的宿主里；同时没有清理重复的 `#ytt-sidebar-host`。

## 关于「缓存」的结论
用户的直觉不准，但需求合理：`readCacheForVideo(videoId)` 与 `writeCache` 都按 `videoId` 过滤/建主键，**缓存不会把 A 的字幕给 B**。但界面既没有「本次是否命中缓存」的明确提示，也没有清空缓存的入口，无法自证。

## 目标行为
- 任何时刻面板显示的 `videoId` 必须等于当前页 `?v=`；不等则立即清空并抓新视频，绝不继续展示旧视频内容（含旧标题）。
- 不依赖任何单次事件：即使宿主事件丢失、回调抛异常，**500ms 内自我纠正**。
- 用户可一键确认缓存命中情况并清空缓存。


## 技术方案

沿用现有栈（TypeScript + 原生 DOM + 自建 store），**不再改动 `src/core/harvest/*` 与 `src/core/dom/legacy.ts`**（已排除），只改「谁驱动状态」和「状态能不能被显示」这一层。

### 1. 会话自愈：`reconcile()` 取代一次性 `sync()`
`src/platform/session.ts`

- 抽出 `reconcile()`：每次执行只做 `readVideoId(win)` 与 `store.getState().videoId` 的比较，成本是「一次 URL 解析 + 一次字符串比较」。
  - `id === current.videoId` → 直接返回（幂等）。
  - `id === null` → 若有状态则 `abort` + `emptyPanelState('')`。
  - 不一致 → 复用现有「abort → 重置 state → `loadStoryboard` → `load()`」流程，并置 `switchPending`（保留已有的 `staleRisk` 传递）。
- `sync()` 保留为 `reconcile()` 的别名（两端入口不用改调用名）。
- `Session` 增加 `start()` / `dispose()`：`start()` 起一个 **500ms** 的 `setInterval(reconcile)`，回调整体包 `try/catch` 并 `log`，异常绝不外溢；`dispose()` 清理定时器。
- 定时器只在 watch 页有实际动作，非 watch 页只是一个 `querySelector` 级别的判断，忽略不计开销。

### 2. 入口：先干活、最后记账，并逐步隔离异常
- `userscript/main.ts`
  ```ts
  const tick = () => {
    if (location.href === lastUrl) return;
    try { sidebar.ensureMounted(); } catch (e) { log(...) }
    try { session.sync(); } catch (e) { log(...) }
    void refreshButton();
    lastUrl = location.href;        // ← 放到最后
  };
  ```
  `refreshButton()` 里 `ensureEntryButton` 会 `waitForElement` 最长 8s，必须 `void` 且不阻塞后续步骤。
- `entrypoints/content.ts`：`wxt:locationchange` 同样两段 `try/catch`；启动时调用 `session.start()`。
- 由于 `reconcile()` 幂等且 500ms 一次，`lastUrl` 现在只负责「要不要刷新入口按钮」，**即使 tick 完全不跑，面板仍会自愈**。

### 3. 侧栏重挂修复
`src/ui/sidebar.ts`

```ts
function ensurePanel(): PanelHandle {
  if (!panel) { /* 原有创建逻辑 */ }
  // 宿主被 YouTube 重建后，shadow root 是新的，必须把面板挪回去
  if (panel.element.parentNode !== host!.shadowRoot) {
    host!.shadowRoot!.appendChild(panel.element);
  }
  return panel;
}
```
- `ensureMounted()` 在拿到 `mount` 后清理重复宿主：`doc.querySelectorAll('#ytt-sidebar-host')` 中除当前 `host` 外一律 `remove()`（YouTube 保留旧 DOM 快照时会产生多个）。
- 重挂后补 `relayout()`（沿用现有 `fresh` 分支的 `raf`）。

### 4. 面板新鲜度闸门（可见即正确）
`src/ui/panel.ts`

- `PanelOptions` 增加 `currentVideoId?: () => string | null`（不新增 state 字段，避免污染共享类型）。
- `render()` 开头：
  ```ts
  const pageId = currentVideoId?.();
  const stale = Boolean(pageId && state.videoId && pageId !== state.videoId);
  ```
  `stale` 时：标题显示「正在切换到新视频…」、列表清空并显示加载态，**不渲染任何旧行**；`stale` 解除后按正常流程重建（`listKey` 已包含 `videoId`，天然会重建）。
- 好处：即使 session 因任何未知原因慢一拍，UI 也不会把旧视频内容当成当前视频给人看。

### 5. 标题按 videoId 取，避免旧标题
`src/core/harvest/player.ts` 新增：
```ts
export function readTitleFor(win: Window, videoId: string): string {
  const response = readPlayerResponse(win);
  const declared = response?.videoDetails?.videoId;
  if (declared === videoId && response?.videoDetails?.title) return response.videoDetails.title;
  return win.document.title.replace(/\s*-\s*YouTube\s*$/u, '');
}
```
`SessionHooks.title` 改为 `(videoId: string) => string`，两个入口传 `(id) => readTitleFor(win, id)`。这样标题与内容同源，不会再出现「新字幕配旧标题」。

### 6. 缓存可观测 + 可清空
`src/ui/statusbar.ts`
- `createStatusBar({ onClearCache })`，诊断 popover 顶部加一块固定信息：
  `当前页面 <videoId>` / `面板所属 <videoId>` / `来源 + 是否命中缓存`，并附一句说明「缓存按视频独立存放，7 天过期，不会跨视频复用」。
- 底部加「清空缓存并重新抓取」按钮：`clearCache()` → `client.load(true)`。
- `update(state, pageVideoId)` 增加第二个参数，由 panel 传入 `currentVideoId?.()`。

### 7. 性能与风险控制
- 500ms 一次的 `reconcile` 只做比较，**不触碰 DOM 查询**（`readVideoId` 只解析 `location.href`）。
- `reconcile` 不一致时才 abort + `load()`，已有 `inflight` 计数丢弃过期结果。
- 新鲜度闸门在 `render()` 里是纯判断，无额外渲染成本。
- 改动集中在 4 个文件，不触碰抓取链，回归面小。

## 目录结构

```
src/platform/session.ts     # [MODIFY] 新增 reconcile()/start()/dispose()，sync 复用；title 钩子带 videoId
src/ui/sidebar.ts           # [MODIFY] ensurePanel 重挂、重复宿主清理
src/ui/panel.ts             # [MODIFY] currentVideoId 选项 + render 新鲜度闸门 + 诊断传 pageVideoId
src/ui/statusbar.ts         # [MODIFY] 诊断显示 当前/面板 videoId + 清空缓存按钮
src/core/harvest/player.ts  # [MODIFY] 新增 readTitleFor(win, videoId)
userscript/main.ts          # [MODIFY] tick 顺序/异常隔离，启动 session.start()
entrypoints/content.ts      # [MODIFY] 同上
tests/session-reconcile.test.ts  # [NEW] URL 变化但无事件时，reconcile 500ms 内切到新 videoId
tests/sidebar-remount.test.ts    # [NEW] 宿主重建后面板被重新 append、重复宿主被清理
tests/panel-freshness.test.ts    # [NEW] state.videoId ≠ pageVideoId 时不渲染旧行
README.md                   # [MODIFY] 说明自愈机制与缓存语义
package.json                # [MODIFY] 版本递增
```

