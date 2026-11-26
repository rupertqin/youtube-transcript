# Transcript

一个常驻的字幕工作台，同时产出 **Chrome MV3 扩展** 与 **Tampermonkey 脚本**，两端共享同一套核心代码与 UI。

## 多站点

同一套面板在 **YouTube** 和 **哔哩哔哩** 上都能用；打开对应视频页自动生效，不支持的页面不注入任何按钮。

| 能力                     | YouTube                | Bilibili                           |
| ------------------------ | ---------------------- | ---------------------------------- |
| 入口 / 面板              | masthead 按钮 + 右栏卡片 | 顶部导航「投稿」左侧按钮 + `.right-container-inner` 卡片（只有一个面板） |
| 抓取                     | playerResponse / InnerTube / get_panel / DOM / timedtext 拦截 | WBI 签名的 `player/wbi/v2` + 字幕 CDN，失败退首屏 `__INITIAL_STATE__` |
| 章节 / 章节截图          | 支持                   | 不支持（控件自动隐藏）              |
| 机器翻译（中 / EN 按钮） | 仅原生轨道可保证       | 不支持；按钮只映射原生/AI 轨道      |
| 分 P / 分集              | 不适用                 | `BV…:p{n}` 独立缓存，切集自动跟随   |
| 缓存                     | `v9\|youtube\|…`        | `v9\|bilibili\|…`（两站互不相交）  |

B 站字幕接口要求登录态：匿名时可能返回**空轨道列表**而不是报错，面板会明确区分「未登录」「AI 字幕生成中」和「视频没有字幕」。`-352` 是风控，需稍后重试。抓取结束并确认当前视频没有可用字幕后，页面入口按钮会变成浅灰底（仍可点开看诊断信息）；切到有字幕的视频会自动恢复红橙渐变。

B 站轨道不只靠 `type` 判断来源：综合 `lan` 的 `ai-` 前缀、字幕 CDN 域名、`ai_status` / `is_ai` 等字段，并用 `view.subtitle.list` 给 `player/wbi/v2` 的轨道补线索；底栏会显示「中文（中国）（人工 / AI）」。默认优先级是**人工中文 → 人工任意 → 未知来源中文 → AI**。

页面是 SSR + Vue hydration：入口按钮和卡片都在右栏（按钮在卡片正上方），插入前要等 `[data-server-rendered]` 消失、文档加载完，再静置 1s（`createSettleGate`）—— 提前插节点会让 B 站自己的 app 抛 `HierarchyRequestError`，页头（登录态）跟着失效。

油猴产物保持 `@grant none`（一旦声明任何 `@grant`，Tampermonkey 会把脚本沙箱化，YouTube 的 `getPlayerResponse()` / fetch hook / 主动切轨全部失效）。因此 B 站走页面上下文 `fetch(..., { credentials: 'include' })`；扩展端则靠 `host_permissions` 拿 CORS 豁免。产物文件名与 `@name` 保持不变，方便已有安装直接更新。

- 页面标题栏出现一个「字」logo 按钮，点开是**嵌进观看页右栏的卡片**（相关视频上方，随页面滚动，不遮挡视频）；按钮带展开/收起箭头，不显示文案或版本号。无右栏的页面只给按钮提示。扩展仍可用工具栏开 Side Panel
- 切到另一个视频时面板不关，自动换成当前视频的字幕与章节；不会残留上一个视频的内容（判据是**内容指纹**，见下文「切页」）
- 标题栏第二行只在**抓取中**（显示当前阶段）和**抓取失败**时出现；抓成功后整行隐藏 —— 来源与行数底栏已经写了，不再重复
- **字幕语言可选**：工具栏 `中` / `EN` 两个按钮（有对应字幕才出现），都不选中 = 同音频（不翻译，用视频自己的轨道）
- 字幕支持搜索 / 命中计数 / 上下条跳转 / 关键词高亮
- 点击任意行跳转视频时间点，播放时自动高亮并滚动跟随
- 排版学 YouTube 原生面板：`Roboto, Arial, sans-serif`、正文 **14px / 行高 22px**；时间戳**内联在正文开头**、灰色 12px、括号包住（`(0:00) 正文…`），左右各 20px 留白
- **段内 vs 段间 = 22px : 34px**（上下内边距各 6px，跨段基线距 ≈ 1.5× 行距）。行距松一档、段距收窄，多行才会先被看成「一块」而不是一格格方块；段落边界由 `(0:00)` 标记与这 1.5 倍留白共同承担
- 复制全文，或导出 `txt` / `md` / `srt` / `json`
- 完整结构化字幕源优先的抓取兜底链 + 失败分类，抓一次缓存 7 天
- ASR 碎片按「约 8 秒一行」合并成段落（与 YouTube 原生面板分组一致），显示 / 搜索 / 复制 / 导出共用同一份

## 一个站点一个入口

每个站点页面上只有**一个**按钮和一个面板：两个按钮都只显示「字」logo + 展开/收起箭头（无文案、无版本号）。YouTube 的 `ytt-entry-btn` 在 masthead；B 站的 `ytt-float-btn` 在右栏、卡片正上方（容器 `#ytt-float-mount`），卡片放在 `#mirror-vdcon > .right-container-inner`。按钮只 toggle 这张卡片，没有右栏时不弹第二界面。

**按钮显隐跟着「页面有没有视频」走，不靠单次回调**：YouTube 端每 800ms 用
`entryButtonAction()` 对一次账（`hasVideo` + 按钮在不在文档里）：

| 情况 | 动作 |
| --- | --- |
| 首页 / 搜索页 / 频道页（地址栏没有 `?v=`） | 移除 |
| 观看页但按钮还没插，或被站点重建 masthead 冲掉 | 重建 |
| 观看页且按钮健在 | 保持（不重插，避免点击态被冲掉） |

只靠 `locationchange` 时有两个真实故障：从首页点进视频时右栏卡片自己挂上了、
按钮却要刷新页面才出现（宿主那次回调不一定触发）；以及切页时 YouTube 重建
masthead 会把按钮一起冲掉（卡片有 MutationObserver 兜着，按钮没有）。
`ensureEntryButton()` 等锚点可能等几秒，所以插完还要**复查一次地址栏**——
否则按钮会留在中途跳过去的首页上。

> **1.x 原版实现已彻底移除**（v2.23.0）。早期为了「先能跑」把旧脚本整份搬进产物，
> 新版通过一个全局对象调它的提取函数；旧 UI 早已退役、能力也全部由 TS 承接，
> 于是脚本本体、构建期同步脚本、转发层和空目录一并删除。
> **现在生成物里不含任何旧实现的代码、标识或全局变量。**
>
> 能力去向：

| 原版能力                                              | 现在的实现                    |
| ----------------------------------------------------- | ----------------------------- |
| `openTranscriptPanel` / `pickPanel` / `countSegments` | `src/core/dom/panel.ts`       |
| `extractTranscript` / `collectFromList`               | `src/core/dom/scrape.ts`      |
| `extractFallback`（按时间码切 `innerText`）           | `src/core/dom/text-rows.ts`   |
| `stripA11yDuration`（无障碍时长清洗）                 | `src/core/format/a11y.ts`     |
| `parseChapters` / `readChapterRows`                   | `src/core/format/chapters.ts` |
| `formatCopyText`                                      | `src/core/format/copy.ts`     |

产物因此少了约 7 kB（userscript 112 kB → 105 kB），构建也不再需要前置同步脚本。

### DOM 预览：一次同步只读，不点击、不轮询、不滚动

字幕列表是**虚拟列表**：只渲染视口附近的行，还会跟着播放进度自动滚到当前位置。
以前靠「点开原生面板 → 12 轮轮询 → 从头滚到底」凑字幕，既慢又会漏掉前段；
那份残缺结果一旦写进缓存，7 天里都显示不全，只能靠「清空缓存并重新抓取」恢复。

现在 DOM 层只负责**临时预览**：

- `readDomPreview(doc, { videoId, skipSnapshot, avoidSignature })` 一次同步扫描
  `body.innerText`（`quick: true`，不遍历整页候选元素），按行首时间码切行，
  取「时间戳最长递增段」；**一个按钮都不点、一个定时器都不起**
- 归属闸门：`videoId`（播放器还停在别的视频就放弃）、`avoidSignature`
  （与上一条视频内容完全一致就丢弃）、`skipSnapshot`（刚切页时不信页面现有文字）
- 预览经 `onPreview` 回传给会话层临时显示，`complete: false`，**不写缓存、
  不短路完整源**；`get_transcript` 的完整结果到达后直接覆盖它
- 快照只取**可见文本**，不用 `body.textContent` —— 后者会把 ytInitialData 里的
  章节 JSON 带进来，切出 `28:14 ] — Rethinking…` 这种假字幕
- 时间戳最长递增段要求相邻间隔 ≤ 45 秒、至少 3 行、行内无 JSON 残留

完整字幕由下面「抓取兜底链」的结构化源负责，不再依赖虚拟列表渲染了多少行。

### 复制 / 章节 / 时间戳：只有一份实现

`src/core/format/` 是唯一实现，面板、导出、搜索共用，不存在「两套规则对不上」：

- **干净文本**：YouTube 给每个时间点配了一段无障碍复述（`33:26 33 minutes, 26 seconds`、
  `3:323 minutes, 32 secondsI don't…` 这种粘连），`stripA11yDuration()` 会去掉它。
  判据是**数值必须和时间码完全一致**，所以 `1:23 we waited 5 minutes` 这种真实台词不动。
  清洗在进 state 前做一次（显示/搜索/复制/导出同一份），复制时再按行起点兜一次
- **时间戳开关**：工具栏时钟按钮 = `prefs.timestamps`，同时控制显示与复制
- **chapters**：`readChapterRows()` 只认章节面板
  （`target-id*="chapter"` / `*="macro-markers"`、`ytd-macro-markers-list-item-renderer`），
  按 30 秒间隔抽样；**绝不能加 `[visibility*="EXPANDED"]`** —— 那正是字幕面板，
  字幕行按 30s 抽样后会凑出十几行，把字幕误判成章节。章节独立存在 `PanelState.chapters`，
  不参与 `looksLikeTranscript()` 校验；抓取失败时章节照样能看、能复制
- **视图切换**：工具栏「字幕 / 章节」按钮切换 `prefs.view`；可切换时复制、导出（`-chapters.txt`）、
  搜索、播放高亮全部跟着换数据源。当前视频没有章节时自动回退到字幕视图
- **点击时间点**：`TranscriptLine.start` 是毫秒，`video.currentTime` 是秒，
  `row.ts` 里换算后再 seek（之前直接传毫秒，`1:05` 会跳到 65000 秒）

### 章节截图 / 高亮 / 开关即时生效

**章节截图**来自 YouTube 的 storyboard 雪碧图（`playerResponse.storyboards.playerStoryboardSpecRenderer.spec`），
按时间点裁切，不额外发请求：

- 规格串 `URL|帧宽#帧高#总帧数#列#行#帧间隔ms#图集名#签名`，URL 里 `$L` = 档位、`$N` = 图集名
- **每档 URL 必须拼回该档自己的 `?sigh=`（第 8 个字段）**。少了它 `i.ytimg.com` 直接
  401/404，表现就是「章节截图全是空白」——这是最容易漏、也最难从代码上看出来的一步
- `$L` 用**原始段序号**（0 起），解析失败的段不参与取帧但不能让后面的档位下标回退；
  与 YouTube.js 的 `PlayerStoryboardSpec` 一致
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

### 验收

`tests/copy-shared.test.ts` 覆盖时间码切行、无障碍时长清洗、章节解析与复制格式化；
`tests/chapters.test.ts` 用整页可见文本断言「章节时间点不会被当成字幕」。
`npm run build` = `clean → icons → build:ext → build:userscript`：**先清空 `dist`/`.output` 再产出**，
所以不会出现旧哈希 chunk 与新产物并存的情况。没有构建期同步步骤。

页面上只有 `ytt-entry-btn` 这一个入口；`removeEntryButton()` 也只删它。

> `dom` 层（`native-panel.ts`）的两处适配：面板若在 shadow root 里，用 `deepQueryAll` 重新发现；
> 失败时把逐层诊断（哪一层、为什么被丢弃、面板是否重建）写进诊断文本，点底栏「诊断」即可查看。
>
> 能读到 2026 版 "In this video" 框里的字幕，靠的是按时间码切 `innerText`：
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

点工具栏图标打开 Side Panel；页面上的按钮打开的是**右栏内嵌卡片**（两站一致），不再尝试 Side Panel（工具栏那条路径保持不变）。扩展的 host 权限覆盖 `www.youtube.com` / `www.bilibili.com` / `api.bilibili.com` 与字幕 CDN。

没有右栏的页面（Shorts、极窄布局）不显示面板，按钮会短暂提示「当前页面没有右栏」并复原，不弹阻塞对话框。

### Tampermonkey 脚本

```bash
npm run build:userscript
```

把 `dist/userscript/transcript.user.js` 拖进 Tampermonkey 的安装页（或直接打开该文件）。meta 头 `@match` 了所有已支持的视频站点；脚本 `@grant none`，本身运行在页面上下文，不需要任何 GM\_ API。

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

核心思路：**抓取层对 world 无感知，UI 层对平台无感知，会话层对站点无感知**。两端差异落在各自的入口；站点差异落在 `SiteAdapter`；`platform/session.ts` 只认契约。

```
entrypoints/                 扩展端（Chrome MV3）
├── bridge.content.ts        MAIN world：① 被动拦截 ② playerResponse ④ InnerTube
├── content.ts               ISOLATED：③ 原生面板 DOM 抓取、入口按钮、右栏卡片、SEEK
├── background.ts            工具栏点击开侧栏 + 消息路由
└── sidepanel/               Side Panel（同一份 Panel 组件）
userscript/main.ts           油猴单 world：①②③④ + UI 全在一个进程
src/core/                    平台无关：抓取链、解析、缓存、导出、store
  site/                     站点层：SiteAdapter 契约 + registry + 两个实现
    youtube.ts               YouTube：抓取链 / playerResponse / DOM / 右栏挂载
    bilibili/                Bilibili：MD5 + WBI 签名 + 字幕 API + 页面兜底；UI 复用右栏卡片
src/platform/                session（只依赖 SiteAdapter）
  client.in-process.ts       两端共用：同进程直连 store（扩展 content + 油猴）
  client.sidepanel-chrome.ts Chrome 扩展 Side Panel 专属远程视图
  bridge.chrome-main-world.ts Chrome 扩展 MAIN↔ISOLATED RPC（油猴不需要）
  protocol.ts / types.ts     消息类型与 TranscriptClient 定义
src/ui/                      面板组件（双端同一份，原生 DOM）
  dom.ts                      el() 构造器、显隐、二分查找等基础件
  panel.ts                   面板骨架 + 状态派发 + 播放跟随
  toolbar.ts                 两行工具栏：搜索+跳转 / 视图+语言+时间戳+复制+导出
  virtual-list.ts            可变行高窗口化滚动（实测行高回填）
  sidebar.ts                 右栏内嵌：挂载点解析、Shadow 卡片、被重建后自动重挂
  sidepanel.ts               唯一剩下的第二种挂载点（扩展侧栏文档）
```

产物体积（生产 + minify，多站点之后）：油猴单文件约 132 KB / gzip 45 KB；扩展 content script 约 133 KB、侧栏 chunk 40 KB、CSS 24 KB。对比 1.x 的 14 KB 单文件，多出来的是兜底链、解析器、导出、IndexedDB 缓存、面板 UI，以及第二站点（MD5 + WBI + API + 右栏挂载）约 8–10 KB。content script 不能代码分割，因此 B 站模块会随 YouTube 一起进包。

### 为什么这样拆

- **扩展必须拆 world**：`#movie_player.getPlayerResponse()`、`ytInitialPlayerResponse`、`fetch` hook 都只能从页面 JS 上下文（MAIN world）拿到；而 `chrome.runtime`、侧栏、Shadow DOM 挂载在 ISOLATED world。两者用 `window.postMessage` 上的窄协议 RPC 通信。
- **油猴不需要拆**：`@grant none` 的脚本本身就跑在页面上下文，于是 `core/harvest/sources.ts` 里那三个源函数直接原地调用。**core 的每一层只接收传入的 `window`，绝不直接引用全局** —— 这就是「共享核心」成立的前提。
- **Side Panel 不能直接操作视频**：所有 `load` / `seek` 都走消息；油猴端是同一个进程内的 `TranscriptClient` 实现。

### 抓取兜底链

**完整结构化源优先，DOM 只做同步预览**。任一层拿到非空行即短路返回：

| 顺序            | 层                | 说明                                                                                                                                         |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ⓪（仅要翻译时） | `remote`          | `preferRemote`：链路仍支持，但 **YouTube 端已不再传** —— 远程层的 `&tlang=` 必 429，见下文「切语言」 |
| ⓪.5             | `cachedIntercept` | 此前已截获的完整 `get_transcript` / `timedtext` 响应，0ms 命中                                                                               |
| ①               | `domPreview`      | 同步预览，**不短路**：只让屏幕上先有字，`complete: false`                                                                                    |
| ②               | `structured`      | 主路径：直接构造 InnerTube `get_panel` 请求，**一次**拿回**全部分段**与精确 `startMs/endMs`。页面自带 params 优先，失败才用自己拼的那条（最多两次请求）；带 6s 上限 |
| ③               | `intercept`       | 逼原生面板发一次 `get_transcript` 请求，hook 截**完整响应**（短等 2.5s）。**默认不依赖 CC**：面板已开着时收起再点开，强制重新请求；只有「用户指定了产出语言、手上又没有该语言的捕获」时才主动切一次 CC 轨道（见下文「主动切轨」）。同音频模式下还会处理**没有原生面板**的视频：短等 900ms 拿不到就借播放器发一次 timedtext（见下文「没有原生字幕面板的视频」） |
| ④               | `remote`          | `playerResponse.captionTracks` → `/youtubei/v1/player` 降级探测                                                                              |
| ⑤（兜底）        | `domFallback`     | 以上全失败时，把页面**已经渲染出来**的字幕当结果返回，`complete: false`（**不进缓存**）；会在面板自己的滚动容器里滚到底，把每一屏的行按时间码并起来 |

> **2026 年面板的数据源是 `get_panel`，而且只有它。**
> `panelId = PAmodern_transcript_view`，`params` 是 protobuf `{149: {1: videoId, 3: 1}}`
> （真实请求 `qgkPCgtIWXJSWUNTUnhkRRgB` 反推而来，有逐字回归测试锁住）。
> 以前的 `get_transcript` 直连已经整个删掉：那个端点对我们的请求只回
> `400 Precondition check failed`，留着它只是白刷请求。
>
> **URL 不带 `?key=`。** 原生成功的那条请求是
> `POST /youtubei/v1/get_panel?prettyPrint=false`，靠页面 cookie 认证；
> 带上项目 key 反而会被内塔顶回 400（网络面板里带 key 的全红，不带 key 的才成功）。
>
> **只发一次。** 用页面自己的 `INNERTUBE_CONTEXT`（`X-Youtube-Client-Name: 1` +
> 页面 `clientVersion` + visitorData + `SAPISIDHASH`），不再遍历
> ANDROID / TVHTML5 / 各种 params 编码变体。params 一律用
> `buildGetPanelParams()`（`{149:{1:videoId,3:1}}`）。
>
> 页面里那份 `getTranscriptEndpoint.params` **不要用**：实测同视频同 panelId，
> 自拼 → 200 / 116 KB / 85 段；页面那份 → 200 / 960 字节 / 0 段（只有
> `responseContext`）。它是给「可搜索字幕面板」用的，形状不同。
> 先试它再试自拼的，就是「两次请求，一次空一次满」的来源。
>
> **登录态。** 成功那条真实请求带的是
> `Authorization: SAPISIDHASH <ts>_<sha1(ts + ' ' + SAPISID + ' ' + origin)>`
> （外加 `SAPISID1PHASH` / `SAPISID3PHASH` 两个变体，分别用
> `__Secure-1PAPISID` / `__Secure-3PAPISID`）以及
> `X-Youtube-Bootstrap-Logged-In` / `X-Goog-AuthUser`。
> `authHeaders()` 从 `document.cookie` 里的 SAPISID 系列算出这个头；
> 没登录就退回匿名请求，不硬塞空头。

`get_panel` 就是 YouTube 原生字幕面板的数据源：它一次返回全部分段，
不依赖虚拟列表渲染了多少行，也不依赖播放器就绪。所以主路径既**快**又**完整**，
最坏等待从「12s 等播放器 + 10s 等切页 + 12 轮轮询 + 60 屏滚动」收敛为
「一次短网络请求 + 一次线性合并」。

**最糟的失败形态是「面板里明明渲染着字幕，我们却报没有字幕轨道」**，所以加了第 ⑤ 层：
真实案例（`JW5s9Md4U2U`）里结构化源回 `400 Precondition check failed`、timedtext 空 body、
InnerTube 探不到轨道，而页面上躺着 376 行完整字幕。现在这种情形会把那 376 行给你，
只是标记 `complete: false` —— 不写缓存（命中缓存时也不会二次合并），下次仍重新抓完整版；
底栏「诊断」的 **完整性** 一行会写明「不完整（页面已渲染文本兜底，未缓存）」。

> **漏前段的真正根因：拦截层把完整响应整条丢了。**
> `get_transcript` 的 URL 上没有 `lang=` 参数，于是 `capture.lang` **恒为 null**；
> 拦截层一见「用户选了目标语言」就判成「捕获的是未知语言，不是要的 xx」，
> 把一次能拿全**全部分段**的响应丢掉，永远只能退到 DOM 兜底 ——
> 而字幕列表是虚拟列表，只渲染视口附近的行，前面整段读不到。
>
> 现在语言先**推**再判：`get_panel` 的语言取 `videoDetails.defaultAudioLanguage`
> （面板永远返回默认轨；**不能**用 `captionTracks[0]`，多轨视频里第一条未必是默认轨，
> 实测 `uxdh2lqc-1Y` 第一条是 `ar`、面板给的是英文）。语言未知的捕获只有在
> 「要的就是默认语言」时才放行，否则宁可失败 —— 拿默认轨顶目标语言，
> 就是「切中文显示英文」而且状态还是 ready，用户完全看不出哪里不对。
>
> 另外两道兜底都不碰 CC：
> ① `ensureFreshTranscriptRequest()`：面板已开着时那一次请求早就发过了，hook 抓不到。
> 收起再点开一次，页面必须重新请求（POST 不会被浏览器缓存）；
> ② `readRenderedTranscript()`：真退到 DOM 时，在面板**自己的**滚动容器里从头滚到底
> （有上限，滚完还原 `scrollTop`），每一屏的行按时间码去重合并。
>
> **自己的请求不能污染捕获缓存**。hook 补的是全局 `window.fetch`，我们直连
> `get_transcript` 的请求也会被截下来 —— 失败时截到的是 119 字符的 400 错误体，
> 它把缓存污染成「已有一条 get_transcript 响应」，拦截层 0ms 命中垃圾、解析出 0 行，
> 真正的面板响应反而等不到。现在自己的请求打 `SELF_FETCH` 标记不截，
> 错误响应（`ok === false`）也不截。诊断里的 `截到了 get_transcript 响应（119 字符）
> 但解析出 0 行` 就是这条污染留下的痕迹。
>
> 还有一处会让「截到了却没用上」：`parseGetTranscript()` 以前只认
> `transcriptSegmentRenderer`，而 YouTube 正把 `*Renderer` 迁移成 `*ViewModel`
> （`transcriptSegmentViewModel`）。认不出新名字就解析出 0 行，链路里记成
> `拦截 no lines`，看起来像「没截到」。现在解析器**形状无关**：任何键名带
> `segment`、有时间戳和文字的节点都算一条，文字从 `snippet`/`content`/`runs`
> 里递归取。诊断也把两种情况分开了：`截到了 get_transcript 响应（N 字符）但解析出 0 行`
> 与「压根没截到」是两回事。

> 顺带修了两处会把诊断带偏的地方：
> ① `get_transcript` 请求现在带上 `X-Youtube-Client-Name` / `X-Youtube-Client-Version` /
> `X-Goog-Visitor-Id` 三个头 —— 少了它们 YouTube 直接回 `400 Precondition check failed`
> （那不是参数错，参数错是另一种消息）；
> ② 全部失败时的错误码优先取主路径的真实原因，不再被末层探测的 `NO_CAPTION_TRACK`
> 盖成「这个视频没有字幕轨道」。

> **CC 开关与抓取无关，默认路径也不去动它**。这本来就是两条完全不同的数据通路：
>
> | 通路 | 端点 | 依赖 CC 吗 |
> | --- | --- | --- |
> | 播放器字幕轨 | `/api/timedtext` | **是** —— 只有选中某条字幕轨才会请求 |
> | 原生字幕面板 | `/youtubei/v1/get_transcript` | **否** —— 只按 videoId 取 |
>
> 所以「CC 关着 → 抓不到，CC 一开 → 立刻有」不是能力限制，而是我们**选错了触发源**：
> 兜底链里那一层「截获播放器自己发的 timedtext」在 CC 关闭时无内容可截。
> 面板走的是 `get_transcript`，CC 关着照样有字幕 —— 这就是原生框一直能用的原因。
>
> 现在拦截层在等待前先 `openTranscriptPanel(document, { timeoutMs: 1200 })`：
> 点开面板**只为逼出那条 `get_transcript` 请求**；hook 截下来的是**完整响应**
> （不是虚拟列表渲染出的几十行），所以不需要滚动，也不会缺前段。
> 抓完由 `chain.ts` 的 `finally` 调 `closeTranscriptPanelVerified()` 收起。
> 默认路径全程不碰 CC，不会出现「插件字幕 + YouTube 自带字幕」重复。
> 唯一例外是下面这条**主动切轨**，而且只在「指定了产出语言、手上又没有该语言的捕获」时发生。

### 主动切轨：让播放器自己发一条目标语言的 timedtext

`timedtext` 的 `signature` 和 `pot` 由播放器现算，且绑定 `(video, lang, kind)`：
实测改 `lang` → 404、加 `tlang` → 429、换 `v` → 404。所以**没法自己拼**，
只能让播放器自己发那条请求，我们去截（`src/core/harvest/player-track.ts`）。

```
已有捕获（0ms）→ 有就直接用，不碰播放器
  └─ 没有，且 prefs.autoSwitchTrack 且指定了产出语言
       → 在 tracklist 里找目标语言（同语言优先手动轨，绝不拿别的语言顶）
         └─ 没有目标语言的原生轨：改用播放器自己的「自动翻译」
            （轨道对象带 translationLanguage → 播放器发 tlang= 那条）
       → setOption('captions','track', 目标轨)
       → waitForMatch(videoId, 语言匹配, timeout)  ← 只认目标语言，不会被原语言那条顶掉
       → finally 还原：原来有轨道就切回原轨道，原来 CC 是关的就点 CC 按钮关掉
```

**没有原生目标轨时不再直接放弃。** 真实案例 `K7Q6i3GW_ok`：原声是中文，字幕轨只有一条
`en` ASR（YouTube 给的那条本身就是翻译品），页面上也没有 Show transcript。以前会在
7ms 内报「播放器没有 zh-Hans 轨道」，现在改成给播放器设
`translationLanguage: { languageCode: 'zh-Hans' }`，让**它**发那条 `tlang=zh-Hans`
的 timedtext（`tlang` 和 `signature`/`pot` 绑定，自己拼是 429，只有播放器现算的有效）。
截到的捕获里 `lang` 取 URL 上的 `tlang`，所以缓存键、语言徽标、`satisfiesLang` 拿到的
都是真正产出的中文。

两个保证不了就白给的地方，现在都堵上了：

- **轨道表可能读不到**。MAIN world 里 `getOption('captions','tracklist')` 未必已就绪
  （播放器刚初始化，或这个构建只暴露 `setOption`）。空表时退回
  `playerResponse.captionTracks` 拼出同样形状的轨道再 `setOption` ——
  否则用户明明看得见字幕，我们却只能报「没有可用字幕轨道」。
- **失败原因必须能看见**。切轨的 `detail` 现在写进 `failures[]`（面板诊断），
  不再只 `ctx.log` 到 console：诊断里出现「切轨失败：切到 en→zh-Hans（自动翻译）后
  1500ms 内没截到 timedtext」，才是真的「播放器不肯发」；而「0ms 就失败」说明
  是轨道表/播放器 API 的问题。

`is_translateable: false` 不再当硬闸门——这个字段来自内部 API，拼写和取值都不稳，
拿它拦住只会把最后一条路也堵掉；真翻译不了就是 1.5s 超时，代价远小于「明明有字幕却报没有」。

- 代价：截取期间**字幕会短暂出现在画面上**，所以由 `prefs.autoSwitchTrack`（默认开）控制
- 面板（`get_panel`）永远只返回**视频默认轨**，params 里也没有语言位 ——
  所以「切语言」这件事面板做不到，只有播放器轨道这条路
- 语言匹配用 `langMatches`：`zh-Hant` 能匹配请求的 `zh-Hans`（主语言相同）
- 截到语言不符的响应一律当失败：`detail` 会写成「在播放器里把字幕语言切成目标语言后再重试」

### 没有原生字幕面板的视频：借播放器发一次 timedtext

有些视频**有字幕、但没有「Show transcript」面板**（`ytInitialData` 里连
`engagement-panel-searchable-transcript` / `getTranscriptEndpoint` 都没有）。
真实案例 `K7Q6i3GW_ok`：只有一条 `en` ASR 轨、`defaultAudioLanguage` 为空。

对这种页面，前面几层注定全军覆没：

| 层 | 结果 |
| --- | --- |
| `get_panel` | 200，960 字节，**0 段**（面板不存在，只有 `responseContext`） |
| 裸请求 `baseUrl` | 200 + **空 body**（POT 生效） |
| DOM 预览/兜底 | 没有面板，页面上没有字幕文字 |

所以同音频模式（没指定产出语言）的拦截层现在这样走：

```
先短等 900ms（页面自己可能已经发过 get_panel / timedtext）→ 有就直接用
  └─ 没有，且 prefs.autoSwitchTrack
       → 按语言偏好从播放器轨道表挑一条（pickPlayerTrack，同 pickTrack 的打分）
       → setOption('captions','track', 该轨道) → 截带 POT 的 timedtext
       → finally 还原（原来有轨道就切回，原来 CC 关着就点 CC 按钮关掉）
```

判据只看「手上有没有完整响应」，所以原生面板能用的视频**不会**走到切轨这一步
（不会在画面上闪字幕）；只有确实拿不到面板数据的视频才多花这一次切轨。

> **面板的开合策略**。`structured`（直连 `get_transcript`，完全不点任何东西）永远是第一步；
> 只有它失败时才点开面板逼请求。若页面上残留着旧版本留下（或用户自己点开）的面板，
> `chain.ts` 的 `finally` 会 `await closeTranscriptPanelVerified(document)`：
> 「点一下 → 等 220ms → 再看是否仍展开」，最多三轮，确实收起了才算完成。
> 只点 YouTube 自己的按钮，不隐藏/移除它的节点。

### 切页（SPA）为什么以前会显示上一个视频的字幕

点「相关视频」跳到另一个视频时，YouTube 只换 DOM 不换进程，于是有几段时间窗口会读到旧数据。

分两类：**状态压根没换**（整个面板含标题都停在旧视频）和 **状态换了但内容来自旧视频**。

#### 一、状态没换（标题也不变 —— 说明不是抓取问题）

标题直接来自 `document.title`，与抓取链无关。标题也停在旧视频，只能是「面板状态从未切换」。

| 环节                   | 现象                                                                                                                                                              | 现在怎么做                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一次异常就永久失效     | `tick()` 先 `lastUrl = location.href` 再干活；`sidebar.ensureMounted()` 抛一次异常就跳过本次 `sync()`，而 URL 已被记成「处理过」，之后每次 tick 都在第一行 return | `lastUrl` 挪到**全部干完之后**才更新；每步独立 `try/catch`                                                                                                            |
| 只靠事件驱动           | `session.sync()` 只在被调用时推进，漏一次就永久错                                                                                                                 | 新增 **500ms `reconcile()` 自愈循环**（`session.start()`）：只比对「地址栏 ?v=」与「store.videoId」，不一致就 abort + 清空 + 重抓；回调整体 `try/catch`，异常绝不外溢 |
| 宿主重建后面板不重挂   | `ensurePanel()` 见到 `panel` 就 return，新 shadow root 是空的，面板还留在旧的（已脱离）root 里                                                                    | 判定 `panel.element.parentNode !== shadowRoot` 就重新 append 并 `relayout()`；同时清理重复的 `#ytt-sidebar-host`                                                      |
| 标题可能来自旧玩家响应 | `readTitle` 只读 `document.title`                                                                                                                                 | `readTitleFor(win, videoId)`：`playerResponse.videoDetails.videoId` 对得上才用它，否则退回 `document.title`                                                           |

#### 二、状态换了但内容来自旧视频

| 环节                   | 现象                                                                                                    | 现在怎么做                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 地址栏先变、播放器后变 | 播放器还停在旧视频，DOM 里仍是旧字幕行                                                                  | `readDomPreview()` 里的 `staleVideoNote(doc, videoId)` 直接放弃预览；完整结果来自结构化源，不依赖播放器就绪                                                                    |
| **原生面板不销毁**     | YouTube 切页不会关掉展开着的字幕面板，里面还是上一个视频的行；**这些行没有任何 videoId 标记**           | ①`reconcile()` 里 `closeTranscriptPanelVerified()` 验证式收起（最多三轮）；②切页那一刻记下**旧内容指纹**（`contentSignature`），预览前比对，与上一条完全一致就丢弃             |
| 预览没有归属信息       | `snapshotTranscriptText` 只认文字，不认是谁的                                                           | `readDomPreview(doc, { videoId, skipSnapshot, avoidSignature })` 三道闸门一起判；而且预览**不进缓存、不当最终结果**，最坏也只闪一下就被完整字幕覆盖                            |
| 播放器响应滞后         | `playerResponse` 还挂着上一个视频，用它取 `captionTracks` 会拉到**上一页**的 timedtext；storyboard 同理 | `sources.ts` 校验 `playerResponse.videoDetails.videoId`，不匹配就不取轨道（改走 innertube 探测）；`readStoryboardSpec(win, videoId)` 同样校验                                  |
| 拦截层归属错标         | `get_transcript` 的 videoId 用地址栏猜，切页时会把旧视频的响应当成新视频                                | 先读 **POST body 的 base64(protobuf) `params`**（`0x0a 0x0b <11 字节 id>`），读不到再退**请求发出那一刻的播放器 id**，最后才是地址栏；归属为 `null` 的捕获不命中任何 `waitFor` |

#### 三、最后一道闸门：可见即正确

即使前面全部失效，界面也不会显示错的内容。`panel.ts` 的 `render()` 每次都会比对「面板状态的 videoId」与「地址栏当前 videoId」：

- 不一致 → 标题变「正在切换到新视频…」，列表清空只留骨架，复制/导出按钮禁用；
- 侧栏 600ms 轮询发现地址栏视频变了就 `panel.refresh()`，不依赖 store 通知。

所以最坏情况下看到的是「同步中」，而不是上一个视频的字幕。

章节也走同一套判断：切页瞬间 `sync()` 直接清空章节，等 videoId 对齐后再从页面重新读取（`readChaptersIfCurrent`）。

### 字幕语言（中 / EN 两个按钮）

工具栏上是**两个独立按钮**：`中` 和 `EN`。

> B 站没有机器翻译：这两个按钮只用来挑**已有的轨道**。`ai-zh` 归为 `zh-Hans`、`ai-en` 归为 `en`，`type===0` 的投稿字幕优先于 AI 字幕；目标语言不存在时退回分数最高的那条（显示原文），缺语言按钮的提示会注明「该站点不支持机器翻译」。可用轨道来自 WBI 接口，抓取完成后由站点适配器同步给会话层。

- **都不选中 = 同音频**（默认）：不翻译，用视频自己的字幕轨道（通常是 ASR 原声）。
- 选中某个语言就切过去；**再点一次已选中的按钮**回到同音频。

判据是 `readAvailableLangs(win)`，它只报**原生** `captionTracks` 的语言：

```
availableLangs = 原生 captionTracks 的语言      ← 只有这个
```

- 有任意一条轨道 → 站点支持机翻（YouTube）时 `中`/`EN` **都可点**：没有原生轨就走播放器机翻；
- 只有日文字幕这类「中/英都没有原生轨」的情况 → 依然可点，靠机翻产出；
- **一条轨道都没有**（视频无字幕）→ 整组隐藏，不给点了没反应的按钮；
- `playerResponse.videoDetails.videoId` 对不上当前页时返回空数组，避免切页瞬间拿上一个视频的轨道去建按钮。

> 早先 `中` 只在有原生中文轨时才可点，因为 `&tlang=` 必被签名/POT 挡掉，
> 点了也只会拿回原声轨道 —— 那才是「假按钮」。现在机翻由**播放器**自己发
> （`translationLanguage`，见「主动切轨」），所以按钮按「机翻也能出」来判定。

**语言表在扩展端必须过桥读。** content script 跑在 ISOLATED world，
`ytInitialPlayerResponse` / `#movie_player` 上的 JS 属性一概看不见 —— 直接读永远是空数组。
后果不只是「按钮不出现」：`pickUsableChoice()` 对空表刻意不降级，于是用户上次选的
「中文」会被套到**每一个**视频上，全被机翻成中文。所以：
`READ_LANGS` 桥（MAIN world）→ 按 videoId 缓存 → `reconcile()` 每 500ms 校正一次；
抓取前还会 **await 到真实语言表**（最多 ~600ms，`resolvePlan()`），抓取与缓存读取共用
同一份 plan，不会出现「面板写着中文、命中却是英文缓存」。

解析规则（`src/core/langs.ts` 的 `resolveLangPlan`）：

| 选择    | 轨道偏好顺序                                       | 是否翻译                   |
| ------- | -------------------------------------------------- | -------------------------- |
| 同音频  | **视频音轨自己的字幕** → 浏览器语言 → zh → en      | 否（默认，用视频自己的轨） |
| 中文    | `zh-Hans` → `zh-Hant` → `zh` → `zh-CN` → `zh-TW`   | 有原生用原生，没有才机翻   |
| English | `en`                                               | 有原生用原生，没有才机翻   |

**「同音频」跟随视频，不跟随浏览器。** 优先顺序由 `readOwnCaptionLangs()` 给出：

```
playerCaptionsTracklistRenderer.audioTracks[defaultAudioTrackIndex].captionTrackIndices
  → 这些字幕轨的语言（默认音轨自己的，别的音轨的是翻译品）
  → 音轨语言（audioTrackId 形如 `zh-Hant.4`，没有就用 defaultAudioLanguage）
```

中文浏览器打开日文视频时，按浏览器语言会先去要中文（拿不到就机翻），那并不是视频的听写。
`preferOwnLangs()` 把上面这份顺序插到 `plan.langs` 最前面（只在 `tlang` 为空时生效）。

> `K7Q6i3GW_ok` 拆开看是这样的：`audioTracks` 有两条 —— `zh-Hant.4`（中文原声，
> 默认）和 `en-US.10`（YouTube 自动配音），两条都只挂了**同一条** `en` ASR
> （`captionTrackIndices: [0]`，名字就是 "English (auto-generated)"）。
> 也就是说这条视频 YouTube **没有给中文听写**，能拿到的只有那条英文轨；
> 中文只能靠机翻。这不是我们没找，是数据里就没有。

`&tlang=` 自己拼**一定失败**（签名/POT 绑定 `video+lang+kind`，实测 429），所以翻译只有一条路：
**让播放器发**——给轨道对象设 `translationLanguage`（见上文「主动切轨」）。
`tryTrack` 里保留的 `&tlang=` 代码只在远程层生效，因此 YouTube 端不再把远程层提到最前。

**只要视频本身有该语言的原生字幕，就用原生的**（质量比机器翻译好）；没有才走播放器机翻。

几个配套细节：

- 切语言会**强制重抓**（`load(true)`）并先清空旧行，不会让你盯着英文界面以为切失败；
- **不再「要翻译就先问远程层」**（YouTube 端已不传 `preferRemote`）：那条路必 429，
  排在最前只会每次白花一次请求，并把最终错误码污染成 `RATE_LIMITED`（用户看到
  「请求过于频繁」，而不是真实原因）。现在改成**每层自己守住语言**：
  - 结构化源（`get_panel`）只给默认轨 → `panelLangSatisfies()` 判语言，**语言未知也算不满足**
    （只有 ASR 轨、`defaultAudioLanguage` 缺失的视频很常见，例如 `K7Q6i3GW_ok`）；
  - 拦截层靠 `satisfiesLang()` 拒绝语言不符的捕获；
  - 真的缺目标语言时，拦截层用播放器的机翻补上（`translationLanguage`）；
- 缓存按语言分开存（`cacheKey` 里含语言），读的时候也按目标语言过滤，所以「切中文」不会命中上次的英文；
- 面板 / 拦截层拿到的默认轨如果语言和选择不一致，底栏的语言徽标会显示**实际语言**
  （例如 `EN`），一眼就能看出「这条视频没有你要的语言，显示的是原文」；
- **主/备分工**：`get_panel`（即原 Show transcript 那条）永远是主路径；只有「用户指定了
  目标语言、面板又给不了这个语言」时，拦截层才动播放器的 CC 轨道去机翻。选「同音频」
  时全程不碰 CC，画面上不会闪字幕；
- 语言选择是**全局记忆**的（`prefs.lang`）：选了「中文」就表示「能翻的都给我中文」，
  新视频同样适用。再点一次已选中的按钮即回到「同音频」。

### 缓存语义（会不会串视频）

**按 videoId 建键不会串**，但**内容可能被写错**——这是 v2.20.2 之后才查清的一个坑：

早期版本在 SPA 切页窗口期抓到的是**上一个视频**的 DOM 字幕，却按**新视频**的 `videoId` 写进了缓存。这种条目：

```
videoId   B  ✓ 与当前页一致
内容      却是 A 的字幕  ✗
```

`readCacheForVideo` 按 videoId 过滤，所以永远命中它；面板新鲜度闸门比 id，也永远通过。结果是那条视频打开就显示别人的字幕，且持续 7 天——「把很早以前的字幕拿出来」就是这么来的。

四道防线：

1. **整体作废**：`CACHE_SCHEMA` 抬到 **9**，旧条目全部失效（键前缀变了）。v6 清的是 DOM 串页写坏的条目，v7 清的是拦截层归属错误写坏的条目，v8 清的是「只含视口几十行」的残缺 DOM 结果，**v9 给 key 加站点段**，让 YouTube 与 B 站的同 id 条目彻底隔开。
2. **完整性标记** `SourceOutcome.complete` / `CachedTranscript.complete`：DOM 预览 `complete: false`，`writeCache()` 直接拒写，`readCacheForVideo()` 也只返回 `complete !== false` 的条目。缓存里存的是**清洗后的原始分段**，展示时才做句子合并，避免命中缓存时二次合并把行越粘越长。
3. **写入守卫** `writeCache(entry, { playerVideoId })`：抓取当时播放器不在 `entry.videoId` 上就拒绝写入。
4. **读取时做物理一致性校验**：`transcriptFitsDuration(lines, duration)` —— 字幕最后一条不可能晚于视频结束（留 60s 容差）。这条判据与 videoId 无关，所以能揪出「id 对、内容错」的条目，命中即删除并改为现抓。

底栏「诊断」里能直接看到**当前页面 / 面板所属**两个 videoId 以及**这次是缓存命中还是现抓**，底部有「清空缓存并重新抓取」按钮（现在正常情况下不再需要它）。

### 失败分类

`EMPTY_200` / `POT_ENFORCED` / `RATE_LIMITED` / `AGE_RESTRICTED` / `NO_CAPTION_TRACK` / `SELECTOR_MISS` / `NETWORK_ERROR` / `UNKNOWN`

每层失败都写入 `failures[]`，面板底栏「诊断 N」可以展开看每一层的错误码与耗时——排查时先看这个，再决定是重试还是等更新。

> 扩展端的 `GET_TRANSCRIPT` / `HARVEST_REMOTE` 现在**把 `failures[]` 原样带回来**
> （RPC 的 reject 只有 message，`code` 一丢就会把「`get_panel` 200 但 0 段」误记成
> `NETWORK_ERROR`）。诊断里出现 `EMPTY_200 · 200 但 0 段（N 字节）` 时，说明
> 这条视频**没有原生字幕面板**（`ytInitialData` 里没有 `engagement-panel-searchable-transcript`），
> 只能走播放器那条路。

最终展示的错误码取**最后一层**的分类：结构化源没轨道报 `NO_CAPTION_TRACK`（视频没字幕），拦截超时报 `EMPTY_200`，远程被限流报 `RATE_LIMITED` —— 这些情况的处理方式完全不同。DOM 预览不产生最终结果，因此不再有 `SELECTOR_MISS` 误报。

> 2025 年中之后 YouTube 对 WEB client 的 timedtext 加了 proof-of-origin token，裸请求会返回 `HTTP 200 + 空 body`。空 body 不等于「没有字幕」，`captionTracks` 是否存在才是判断依据。

> 另一种 200 陷阱：**人机校验页**（"…may be sending automated queries…"）。它是 `HTTP 200 + HTML`，
> `parseSrv` 的 `<p>` 兜底会把它当成「一条字幕」显示出来，看起来和真字幕没区别。
> 现在 `isBlockedPayload()` 会在解析前拦掉，并按 `RATE_LIMITED` 记失败，让兜底链继续往下走。

### 缓存

`IndexedDB`（库名 `ytt-cache`），key = `v9|site|videoId|lang|kind`，TTL 7 天；同一视频切来切去不会重复请求，降低被限流概率。只缓存完整结构化结果。`site` 段由 `SiteAdapter.cacheNamespace` 提供，B 站 videoId 带分 P（`BV…:p2`）。

### 句子合并

`get_transcript` 返回的是 2–4 秒一段的 ASR 碎片，YouTube 原生面板会把连续几段合成一条、只在段落开头留一个时间码。我们以前把每个 segment 单独渲染成一行，同一份数据看起来「特别散」。

`mergeFragments()`（`src/core/lines.ts`）做一次线性遍历补上这一步，判据是**时间跨度**：

- **一行攒满约 8 秒就换行**（跨度 = 本段 `start` − 行首 `start`）。这不是拍脑袋：同一份数据里，原生面板每一条覆盖 7–8 秒 —— `0:00→0:08`（两段，53 字）、`0:08→0:15`（四段，149 字）、`0:20→0:28`（两段，83 字）。字符数从 20 到 149 完全不固定，跨度却稳定；照这个粒度分组，9 段碎片正好切成和原生面板一模一样的 4 条。
- **只用 `start`，不用结束时间**。`endMs` / `dDurationMs` 常缺失或盖过下一段，算不出「停顿」；跨度只需要两个起点，不受影响。
- **标点只作参考、不作判据** —— 大多数碎片根本没有句末标点，指着它切会把整段字滚成一块。
- `[CHEERING, APPLAUSE]` 这类舞台提示独立成行，前后都断开；中文边界不加空格、英文边界补空格。
- 章节之间隔几分钟，跨度判据会自然把行断开，不用额外处理。
- **片段本身不再切开**（切了就没有对应的时间点）。保留首段 `start`（点击跳转 / 播放高亮靠它），`dur` 取到末段结束，异常超长的单段时长截到 4s（SRT 导出靠 `dur`）。字数上限 240 只在时间码异常（多段挤在同一秒）时兜底。

底栏「诊断」里新增一行 **「句子合并：475 → 118 行」**。数字没变就说明合并没生效，可以直接据此定位，不用猜。粒度就是 `MERGE_MAX_SPAN_MS`（默认 8000）：调小 = 每行更短、行数更多，调大 = 每行更长、行数更少。

## 加一层新抓取

1. 在 `src/core/harvest/` 写一个返回 `SourceOutcome | null` 的函数（只接收传入的 `window` / `signal`）。
2. 在 `src/core/harvest/chain.ts` 的调用顺序里插入，或在两个宿主的 `harvest` 钩子里接上。
3. 失败时返回 `failures: [{ source, code, ms, detail }]`，UI 会自动在诊断里展示。

## 排错

| 现象                    | 先看                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| 面板一直「抓取中」      | 调试台的 `[ytt]` 日志，确认 bridge 是否 `PING` 通（`MAIN world bridge unreachable` 说明注入失败）       |
| 显示 `POT_ENFORCED`     | 先手动点开一次 YouTube 原生字幕面板，再点重试，让被动拦截层拿到请求                                     |
| 显示 `NO_CAPTION_TRACK` | 视频确实没有字幕轨；`captionTracks` 为空                                                                |
| 字幕重复                | 别去改 `collapseDuplicates` 的触发条件，那是 DOM 双份渲染的兜底，根因在 `pickPanel` / `collectFromList` |
| 页面结构变了            | `src/core/dom/selectors.ts` 是唯一改选择器的地方                                                        |

## 许可

仅用于个人学习与内容整理，请遵守 YouTube 服务条款。
