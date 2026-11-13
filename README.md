# YouTube Transcript Studio

一个常驻的 YouTube 字幕工作台，同时产出 **Chrome MV3 扩展** 与 **Tampermonkey 脚本**，两端共享同一套核心代码与 UI。

![show](./show.png)

- 页面标题栏出现 `Transcript` 入口，点开是常驻面板（扩展可开侧栏，油猴是右侧浮层）
- 字幕支持搜索 / 命中计数 / 上下条跳转 / 关键词高亮
- 点击任意行跳转视频时间点，播放时自动高亮并滚动跟随
- 复制全文，或导出 `txt` / `md` / `srt` / `json`
- 四层抓取兜底链 + 失败分类，抓一次缓存 7 天

## 一个产物，两个入口

同一份脚本在顶栏注入两个按钮，便于直接对比：

| 按钮 | 行为 |
| --- | --- |
| `Copy Transcript`（`1.x` 徽标，中性色） | **1.x 原版流程**：打开 YouTube 原生面板 → 逐行读 DOM → 拼纯文本 → 写剪贴板，**不关闭面板**，按钮回显 `Copied N 行` / `Failed` |
| `Transcript`（版本徽标，红色） | 新版：跑完整兜底链（DOM → 拦截 → 远程），结果显示在自己的面板里，可搜索/跟随播放/导出 |

两者按钮 id 分别是 `copy-transcript-btn` 与 `ytt-entry-btn`，互不干扰；`Copy Transcript` 只走原生 DOM，不碰缓存也不走接口，所以它的结果就是「YouTube 面板里到底有什么」的基准。

## 原版代码是怎么进来的（往多了抄 → 再慢慢减）

**先整份搬进来保证能跑，再逐块减**；不先做「精简移植」。

| 步骤 | 文件 | 内容 |
| --- | --- | --- |
| 1 | `scripts/sync-legacy.mjs` | 构建前自动同步，产出两份：`verbatim.js`（逐字节副本，仅用于核对）和 `verbatim-runtime.js`（**整份原版 + 唯一一行导出**） |
| 2 | `src/legacy/verbatim-runtime.js` | 原版 IIFE 完整运行：按钮注入 `addCopyButton`、onclick 全流程、剪贴板 `copyToClipboard`、SPA `setInterval`、失败 `alert`，全部照跑。多出的那一行只把 18 个内部函数挂到 `globalThis.__yttLegacyV19` |
| 3 | `src/core/dom/legacy.ts` | 新版 `dom` 层**直接调用原版自己的 `openTranscriptPanel()` / `extractTranscript()` / `extractFallback()`**，只做「纯文本 → 结构化行」的转换 |
| 4 | `src/core/dom/legacy-copy.ts` | 同样只调 `__yttLegacyV19`，产物里不再有第二套「移植版」逻辑 |

### 之前哪里没抄对

对照 `user-script.js`（15 个函数）与曾经的 `src/core/dom/legacy-runtime.ts`：

- **漏抄** `addCopyButton`、`buildButton`、`copyToClipboard`
- **漏抄** 按钮注入 `setTimeout(addCopyButton, 2000)`、SPA 导航 `setInterval`、`navigator.clipboard`、按钮 `disabled` 状态机
- 反而多出 `createLegacyRuntime` / `run` 两个自造包装

漏掉的正是「让代码真正跑起来的入口层」：没有按钮注入，提取逻辑永远不会被调用。
`legacy-runtime.ts` 现在只保留作对照，主路径不再引用它。

### 原版「报 Could not find the transcript panel 却仍有字幕」的真相

`user-script.js` 里真正把字幕切出来的，是 `extractFallback()`（把 `innerText` 按时间码切分）。
但它**只在 `extractTranscript(panel)` 内部被调用**（第 205 行），而 `panel` 为 null 时
onclick 第 297–299 行直接 `alert(...); return;` —— 这条路径永远走不到。

2026 版把字幕面板的 `target-id` 改成了 `EAmodern_transcript_view`，
`SEL.panels` 匹配不到它，于是原版弹窗退出；**可字幕文本其实就在页面上**
（In this video 框里）。所以不是「有两套代码」，而是「能读字幕的那套被 if 挡住了」。

`legacy.ts` 现在补上这一环：把整页可见文本（`body.innerText`，原版注释明确用它排除隐藏节点）
喂给**同一个原版 `extractFallback()`**（构造一个 `querySelector` 恒为 null 的伪 panel，
让原版 `scope = panel`）。切分逻辑一字不改；再用「时间戳最长递增段」挡掉推荐列表里
乱序的视频时长。这条路径 0ms 命中，不必再等 `openTranscriptPanel()` 的 8 秒。

### 按钮的职责是复制已有文字，不是去开面板

`复制页面结构` 的真实 DOM 给出答案：当前展开的是一块
`visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"` 但 **`target-id=""`** 的
`ytd-engagement-panel-section-list-renderer`，内容是
`In this video ChaptersTranscript … Chapter 1: … 3:32` —— 面板开着，但**停在
Chapters 标签页**，字幕行根本没渲染。原版 `SEL.panels` 要求
`target-id="engagement-panel-transcript"`，认不出这块空 target-id 的面板，
于是去点 `Show transcript`（把已展开的面板关掉），最后弹
`Could not find the transcript panel`。

现在（`src/core/dom/legacy.ts`，逐字节的 `verbatim-runtime.js` 一字未改）：

- ⓪ `snapshotTranscriptText(doc)` **同步**读当前可见文本，逐源交给原版
  `extractFallback()`，取时间戳最长递增段；命中即返回，不点任何按钮
- ① 快照为空时 `switchToTranscriptTab()` **精确点击文案恰好是 `Transcript` 的标签**，
  让 YouTube 自己渲染字幕行。不会误点 `Show transcript` / `Copy Transcript` /
  `Transcript v2.x`（我们自己的按钮）
- **已选中的标签绝不再点**：2026 的 chip 是开关式按钮，再点一次会把整个字幕框收起
  （用户看到的就是「原版字幕框消失」）。`aria-pressed`/`aria-selected` 为 true、
  或 class 含 `selected`/`active`/`is-on` 时直接跳过；`openTranscriptPanel()` 的
  兜底按钮搜索同样排除我们自己的两个按钮和已激活的 chip
- ② 每 250ms 轮询快照，最多 12 次，等虚拟列表把行渲染出来
- ③ 仍读不到、且面板**未**展开时才走原版 `openTranscriptPanel()` 兜底；
  面板已 `EXPANDED` 时跳过它，避免再次点 `Show transcript` 把面板关掉
- **不接管、不拦截、不改写** 1.x 的 `Copy Transcript` 按钮：它由逐字节的
  `verbatim-runtime.js` 自己注入、自己处理 onclick，行为完全保持原版
- 快照只取**可见文本**（`body.innerText` + 穿透 shadow 的候选元素），
  **不再用 `body.textContent`** —— 后者会把 ytInitialData 里的章节 JSON 带进来，
  切出 `28:14 ] — Rethinking…\n[` 这种「章节时间点冒充字幕」的假数据
- 时间戳最长递增段要求相邻间隔 ≤ 45 秒、至少 3 行、行内无 JSON 残留；
  章节列表（隔几分钟）会被切开并挡掉。缓存写入用同一判据，
  `CACHE_SCHEMA` 升到 4 让已经存进去的章节假数据失效

### 2026 面板识别：为什么 Copy Transcript 一直弹「找不到面板」

用户确认的现象：**点 `Copy Transcript` 后，视频下方字幕框先打开、里面全是字幕行，
隔几秒才弹 `Could not find the transcript panel`** —— 字幕其实已经渲染，只是没被读走。

根因在 `user-script.js` 的 `pickPanel()`：原 `SEL.panels` 只认
`engagement-panel-transcript`，而 2026 版展开面板 `target-id=""`、
字幕面板叫 `PAmodern_transcript_view`。`pickPanel()` 恒为 null →
`openTranscriptPanel()` 空等 8 秒 → onclick 弹 alert 并 `return reset()`，
`copyToClipboard()` 从未调用。

修复只落在 `user-script.js` 的识别层（构建时逐字节同步到两端产物）：

- `SEL.panels` 保留原三条，新增 `[target-id*="transcript"]`、
  `[visibility*="EXPANDED"]`、`yt-engagement-panel-section-list-view-model`
- 新增内部辅助 `timecodeToMs()` / `subtitleRows()`（**不导出**），
  统计 `innerText` 里连续递增、相邻间隔 ≤ 45s 的字幕行数；
  章节时间点隔几分钟连不成段，因此不会把 Chapters 面板误当字幕面板
- `countSegments()` / `pickPanel()` / `waitForSegments()` /
  `openTranscriptPanel()` 改用这个行数做评分与就绪判定：
  字幕行一出现就立刻返回，不再白等 8s / 6s；面板停在 Chapters 时仍返回 null，
  让原版照旧点 `Show transcript` 把字幕框打开
- `extractFallback()`（按时间码切 `innerText`）、`collectFromList()`、
  `copyToClipboard()`、`buildButton()`、onclick 状态机、三处 alert、
  `Copied!` 文案、按钮样式、SPA `setInterval` **一行未改**

### 两个入口共用一套复制逻辑（chapters / 时间戳开关 / 时长清洗）

原版 `Copy Transcript` 按钮与新版面板**不是两份实现**：清洗、章节解析、复制格式化
都写在 `user-script.js` 里，由 `scripts/sync-legacy.mjs` 导出到 `__yttLegacyV19`，
新版 TS 侧只做类型转发（`src/core/format/copy.ts`）。因此两边输出必然一致。

- **干净文本**：YouTube 给每个时间点配了一段无障碍复述（`33:26 33 minutes, 26 seconds`、
  `3:323 minutes, 32 secondsI don't…` 这种粘连），`stripA11yDuration()` 会去掉它。
  判据是**数值必须和时间码完全一致**，所以 `1:23 we waited 5 minutes` 这种真实台词不动。
  清洗在进 state 前做一次（显示/搜索/复制/导出同一份），复制时再按行起点兜一次。
- **时间戳开关**：工具栏时钟按钮 = `prefs.timestamps`，同时控制显示与复制；
  原版按钮读同一份偏好。原版按钮上 **Shift+点击** 反转时间戳、**Alt+点击** 反转字幕/章节，
  改完写回共享偏好，新版面板会跟着重渲染。
- **chapters**：`readChapterRows()` 只认章节面板
  （`target-id*="chapter"` / `*="macro-markers"`、`ytd-macro-markers-list-item-renderer`），
  按 30 秒间隔抽样；**绝不能加 `[visibility*="EXPANDED"]`** —— 那正是字幕面板，
  字幕行按 30s 抽样后会凑出十几行，把字幕误判成章节。章节独立存在 `PanelState.chapters`，
  不参与 `looksLikeTranscript()` 校验；抓取失败时章节照样能看、能复制。
- **视图切换**：工具栏「字幕 / 章节」按钮切换 `prefs.view`；可切换时复制、导出（`-chapters.txt`）、
  搜索、播放高亮全部跟着换数据源。当前视频没有章节时自动回退到字幕视图。
- **点击时间点**：`TranscriptLine.start` 是毫秒，`video.currentTime` 是秒，
  `row.ts` 里换算后再 seek（之前直接传毫秒，`1:05` 会跳到 65000 秒）。

### 章节截图 / 高亮 / 开关即时生效

**章节截图**来自 YouTube 的 storyboard 雪碧图（`playerResponse.storyboards.playerStoryboardSpecRenderer.spec`），
按时间点裁切，不额外发请求：

- 规格串 `URL|帧宽#帧高#总帧数#列#行#帧间隔ms#图集名#签名`，URL 里 `$L` = 档位、`$N` = 图集名
- **`$L` 必须是「已解析档位里的序号」，不能用原始段号**。URL 后面常挂着一个 `$M`
  之类的签名占位段，拿段号当 `$L` 会整体偏一位 → 请求不存在的 L2/M2.jpg → 缩略图全空
- 跳过 `间隔=0` 的档位（那是整段海报，无法按时间定位）
- 宽、高、偏移**必须共用同一个 scale**：`56/80*45 = 31.5`，四舍五入成 32 会让裁切漏出下一行
- 只在章节视图渲染；字幕视图几千行，逐行拉图没有意义
- 扩展的 content script 在 isolated world 读不到 `playerResponse`，走 `STORYBOARD` 桥到 MAIN world；
  油猴本身在页面上下文，直接读。取不到就不显示，不影响章节本身

**章节高亮**必须用真实播放位置 `positionMs`：

```ts
// 错的：state.lines[activeIndex].start 是字幕行起点，早于章节起点
// 章节 28:14 对应的字幕行可能是 28:09 → 永远高亮上一章
findChapterIndex(chapters, state.positionMs);
```

`timeupdate` 只把 `positionMs` 按秒取整写入（无章节时不写，避免白白多渲染），
`seek()` 立刻写入，所以点章节的瞬间高亮就跳到目标，不用等下一个 `timeupdate`。

**时间戳开关不生效**的根因在虚拟列表：开关改变行结构但不改变行数，
而 `setCount()` 在数量相同时直接 `return`，已挂载的行永远不会重建。
新增 `refresh()` 强制重渲染并保留滚动位置，面板比较行数后择一调用。

### 保证能运行的验收

`tests/verbatim-runtime.test.ts` 用 `node:vm` **真实执行整份 `verbatim-runtime.js`**，断言
原版 18 项 + 共享层 8 项全部挂载、且原版 `extractFallback` 能把带时间码的面板文本切出字幕行。
`tests/legacy.test.ts` 另有「逐字节一致」与「导出名单每个名字都在原版里声明过」两条静态校验，
防止同步漂移或 IIFE 抛 `ReferenceError`。

按钮由原版脚本自己注入（`copy-transcript-btn`），新版按钮 id 是 `ytt-entry-btn`，互不干扰；
`removeEntryButton()` 只删新版自己的按钮。

> 新版 `dom` 层（`legacy.ts`）还做两处适配，但不改原版提取逻辑：面板若在 shadow root 里，
> 用 `deepQueryAll` 重新发现面板后**仍交给原版的 `extractFallback()`** 切时间码；
> 失败时把 `dumpStructureSummary()`（面板候选、44 个按钮的 text/aria-label/title、时间码行）
> 自动写进诊断文本，不需要用户额外点「复制页面结构」。
>
> 原版能读到 2026 版 "In this video" 框里的字幕，靠的是 `extractFallback`：
> 片段标签一个都匹配不到时，它直接把 `panel.innerText` 按时间码切分。
> 它**不要求面板里已经有片段元素**。之前的新版实现加了「面板必须有片段」这个条件，
> 把那个能产出文本的面板丢掉了 —— 这是「原版能行、新版不行」的分歧点。

## 安装

### Chrome 扩展

```bash
npm install
npm run build:ext
```

打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/extension`。

点工具栏图标打开 Side Panel；页面上的 `Transcript` 按钮会先尝试开侧栏，手势被浏览器拒绝时自动回落到页面内浮层。

### Tampermonkey 脚本

```bash
npm run build:userscript
```

把 `dist/userscript/youtube-transcript.user.js` 拖进 Tampermonkey 的安装页（或直接打开该文件）。脚本 `@grant none`，本身运行在页面上下文，不需要任何 GM_ API。

> 仓库根目录的 `user-script.js` 是 1.x 的旧版本，**保留但不再维护**，新产物只写 `dist/`。

## 开发

```bash
npm run dev              # WXT 开发模式（改组件会整页重载，见下方说明）
npm run dev:userscript   # 油猴产物 watch 构建
npm run build            # 图标 + 扩展 + 油猴 一起构建
npm run typecheck        # tsc --noEmit
npm test                 # vitest：解析器 / 兜底链 / 导出 / DOM 纯函数
npm run zip              # 打包扩展 zip
```

> **UI 层是原生 TypeScript，没有任何框架运行时。** 面板用 `document.createElement` + 一套 8 个文件的迷你组件（`dom.ts` / `virtual-list.ts` / `toolbar.ts` / `panel.ts` …）构建，图标是内联 SVG，滚动是手写的窗口化实现。`package.json` 的 `dependencies` 为空，所有依赖都在 devDependencies（构建期）。代价是改 UI 要自己管 DOM 更新时机；收益是产物从 328 KB 降到 72 KB（gzip 102 → 24 KB），且不受任何框架升级影响。

## 架构

核心思路：**抓取层对 world 无感知，UI 层对平台无感知**，两端差异只落在各自的入口与适配器里。

```
entrypoints/                 扩展端（Chrome MV3）
├── bridge.content.ts        MAIN world：① 被动拦截 ② playerResponse ④ InnerTube
├── content.ts               ISOLATED：③ 原生面板 DOM 抓取、入口按钮、浮层、SEEK
├── background.ts            工具栏点击开侧栏 + 消息路由
└── sidepanel/               Side Panel（同一份 Panel 组件）
userscript/main.ts           油猴单 world：①②③④ + UI 全在一个进程
src/core/                    平台无关：抓取链、解析、缓存、导出、store
src/platform/                session / bridge RPC / local+remote client
src/ui/                      面板组件（双端同一份，原生 DOM）
  dom.ts                      el() 构造器、显隐、二分查找等基础件
  panel.ts                   面板骨架 + 状态派发 + 播放跟随
  toolbar.ts                 搜索/跳转/时间戳/复制/导出
  virtual-list.ts            可变行高窗口化滚动（实测行高回填）
  overlay.ts / sidepanel.ts  两个挂载点（Shadow DOM / 侧栏文档）
```

产物体积（生产 + minify）：油猴单文件 73 KB / gzip 24 KB；扩展 content script 68 KB、侧栏 chunk 27 KB、CSS 23 KB。对比 1.x 的 14 KB 单文件，多出来的部分是兜底链、解析器、导出、IndexedDB 缓存与整个面板 UI。

### 为什么这样拆

- **扩展必须拆 world**：`#movie_player.getPlayerResponse()`、`ytInitialPlayerResponse`、`fetch` hook 都只能从页面 JS 上下文（MAIN world）拿到；而 `chrome.runtime`、侧栏、Shadow DOM 挂载在 ISOLATED world。两者用 `window.postMessage` 上的窄协议 RPC 通信。
- **油猴不需要拆**：`@grant none` 的脚本本身就跑在页面上下文，于是 `core/harvest/sources.ts` 里那三个源函数直接原地调用。**core 的每一层只接收传入的 `window`，绝不直接引用全局** —— 这就是「共享核心」成立的前提。
- **Side Panel 不能直接操作视频**：所有 `load` / `seek` 都走消息；油猴端是同一个进程内的 `TranscriptClient` 实现。

### 抓取兜底链

按可靠度串联，任一层拿到非空行即短路返回：

顺序就是 1.x 的顺序：**先走经过验证的那条路，失败才去试旁路**。

| 顺序 | 层 | 说明 |
| --- | --- | --- |
| 1 | `dom` | 打开原生 Show transcript 面板，按 `ytd-transcript-segment-renderer` / `yt-transcript-segment-renderer` 逐行读（**1.x 原版算法，选择器表与判定逻辑逐条对齐**） |
| 2 | `get_transcript` | **不再依赖面板打开**：直接构造 InnerTube `get_transcript` 请求（原生面板的数据源），params 按 protobuf 编码生成 |
| 3 | `intercept` | 面板打开时播放器/面板自己会发请求，hook 顺手截一份。覆盖 `/api/timedtext` 与 `/youtubei/v1/get_transcript` |
| 4 | `player` | 读 `playerResponse.captionTracks` 的 `baseUrl`，用页面 cookie 再请求 `json3 → srv1` |
| 5 | `innertube` | `/youtubei/v1/player` 逐级降级 `ANDROID → TVHTML5_EMBED` |

> 2–4 只在 1 拿不到任何行时才执行，不会改写 1 的结果。POT 生效的视频里 2–4 基本都会失败，真正救场的是第 1 层。

第 3、4 层共用同一次「打开原生面板」动作：面板一开，播放器就会发起 timedtext 请求，hook 与 DOM 抓取同时具备条件。

> 第 4 层不再依赖标签名。2026 版面板把字幕行换成了 `*-view-model` 系自定义元素，`#segment-text` / `ytd-transcript-segment-renderer` 都可能消失，所以抓取按三层递进：老标签（最准）→ 面板 `innerText` 按行首时间码切分（`text-rows.ts`，与 DOM 结构无关）→ 整页文本（面板被 portal 到别处时的最后兜底）。`pickPanel` 也用「文本里有多少行首时间码」给候选面板打分，而不是数片段元素。
>
> 原生面板只是抓取载体。`createPanelSession` 记住「是不是我们打开的」，并在抓取结束时**无论成功、失败还是被中断都把它收回**（`src/core/dom/panel-session.ts`），否则页面上会同时挂着 YouTube 原生字幕和我们的面板。用户自己打开的面板不会被我们关掉。加载态会显示当前所在层，例如「正在打开 YouTube 原生字幕面板抓取…」。

### 失败分类

`EMPTY_200` / `POT_ENFORCED` / `RATE_LIMITED` / `AGE_RESTRICTED` / `NO_CAPTION_TRACK` / `SELECTOR_MISS` / `NETWORK_ERROR` / `UNKNOWN`

每层失败都写入 `failures[]`，面板底栏「诊断 N」可以展开看每一层的错误码与耗时——排查时先看这个，再决定是重试还是等更新。

最终展示的错误码取**最后一层**的分类：如果 DOM 层开了面板却没读到行，报 `SELECTOR_MISS`（页面结构变了），而不是沿用上游的 `NO_CAPTION_TRACK`（视频没字幕）——这两种情况的处理方式完全不同。

> 2025 年中之后 YouTube 对 WEB client 的 timedtext 加了 proof-of-origin token，裸请求会返回 `HTTP 200 + 空 body`。空 body 不等于「没有字幕」，`captionTracks` 是否存在才是判断依据。

### 缓存

`IndexedDB`（库名 `ytt-cache`），key = `videoId|lang|kind`，TTL 7 天；同一视频切来切去不会重复请求，降低被限流的概率。

## 加一层新抓取

1. 在 `src/core/harvest/` 写一个返回 `SourceOutcome | null` 的函数（只接收传入的 `window` / `signal`）。
2. 在 `src/core/harvest/chain.ts` 的调用顺序里插入，或在两个宿主的 `harvest` 钩子里接上。
3. 失败时返回 `failures: [{ source, code, ms, detail }]`，UI 会自动在诊断里展示。

## 排错

| 现象 | 先看 |
| --- | --- |
| 面板一直「抓取中」 | 调试台的 `[ytt]` 日志，确认 bridge 是否 `PING` 通（`MAIN world bridge unreachable` 说明注入失败） |
| 显示 `POT_ENFORCED` | 先手动点开一次 YouTube 原生字幕面板，再点重试，让被动拦截层拿到请求 |
| 显示 `NO_CAPTION_TRACK` | 视频确实没有字幕轨；`captionTracks` 为空 |
| 字幕重复 | 别去改 `collapseDuplicates` 的触发条件，那是 DOM 双份渲染的兜底，根因在 `pickPanel` / `collectFromList` |
| 页面结构变了 | `src/core/dom/selectors.ts` 是唯一改选择器的地方 |

## 许可

仅用于个人学习与内容整理，请遵守 YouTube 服务条款。
