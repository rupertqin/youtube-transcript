# YouTube Transcript Studio

一个常驻的 YouTube 字幕工作台，同时产出 **Chrome MV3 扩展** 与 **Tampermonkey 脚本**，两端共享同一套核心代码与 UI。

![show](./show.png)

- 页面标题栏出现 `Transcript` 入口，点开是常驻面板（扩展可开侧栏，油猴是右侧浮层）
- 字幕支持搜索 / 命中计数 / 上下条跳转 / 关键词高亮
- 点击任意行跳转视频时间点，播放时自动高亮并滚动跟随
- 复制全文，或导出 `txt` / `md` / `srt` / `json`
- 四层抓取兜底链 + 失败分类，抓一次缓存 7 天

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

| 顺序 | 层 | 说明 |
| --- | --- | --- |
| 1 | `player` | 读 `playerResponse.captionTracks` 的 `baseUrl`，用页面 cookie 再请求 `json3 → srv1` |
| 2 | `innertube` | `/youtubei/v1/player` 逐级降级 `ANDROID → TVHTML5_EMBED`（签名 caption URL 不强制 POT） |
| 3 | `intercept` | document_start 装 `fetch` / `XHR` hook，白嫖播放器自己发起的字幕响应。**同时覆盖两种接口**：`/api/timedtext`（播放器，带 POT）和 `/youtubei/v1/get_transcript`（原生面板，结构化 JSON、不吃 POT） |
| 4 | `dom` | 打开原生 Show transcript 面板抓 DOM（1.x 的老路径，永远的最后一道） |

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
