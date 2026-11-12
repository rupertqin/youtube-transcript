---
name: fix-legacy-copy-transcript-panel
overview: 修复 user-script.js 里 pickPanel()/openTranscriptPanel() 对 2026 版 YouTube 字幕面板的识别，让最终单产物 dist/userscript/youtube-transcript.user.js 里的 Copy Transcript 按钮能把已渲染的字幕复制进剪贴板，同时保持原版按钮、alert、Copied 提示、剪贴板流程不变。
todos:
  - id: patch-original
    content: 修改 user-script.js 的面板选择器、评分与就绪判定，保留全部 UI
    status: completed
  - id: sync-generated
    content: 重新生成逐字节副本与运行时，核对导出名单及接口一致
    status: completed
    dependencies:
      - patch-original
  - id: align-adapters
    content: 放宽 legacy.ts 跳过分支，更正提示文案与冻结注释
    status: completed
    dependencies:
      - patch-original
  - id: update-tests
    content: 补 2026 面板回归测试并改写两处旧断言
    status: completed
    dependencies:
      - sync-generated
      - align-adapters
  - id: verify-bundle
    content: 升版本，跑 tsc/vitest/build 并验证 dist 单产物完整性
    status: completed
    dependencies:
      - update-tests
---

## User Requirements
- 修复最终单产物 `dist/userscript/youtube-transcript.user.js` 里 `Copy Transcript` 按钮的复制字幕功能：点击一次即把当前视频的完整字幕写入剪贴板，不再弹出「找不到字幕面板」的提示。
- 允许调整原版脚本中面板识别与等待的必要逻辑；按钮外观、`Copy Transcript` / `Opening transcript...` / `Extracting transcript...` / `Copied!` 等状态文案、失败时的 alert、剪贴板写入方式全部保持原样。
- 原版与新版已合并在同一个油猴脚本中，不拆成两个版本，不新增也不移除任何界面元素。
- 独立安装的那份原版脚本也需一并修好；最终以构建出的单个油猴脚本为准。

## Product Overview
一个 YouTube 字幕工作台油猴脚本，顶栏同时提供新版 `Transcript` 面板与原版蓝色 `Copy Transcript` 按钮。用户点击 `Copy Transcript` 后，视频下方会先展开一个字幕框、里面全是字幕行，隔几秒才弹出找不到面板的提示 —— 字幕其实已经渲染出来，只是没有被读走。本次只修这条复制链路。

## Core Features
- 面板识别：认得 2026 版展开的字幕面板（展开状态、无 target-id 或 `PAmodern_transcript_view`），并在多块面板中选出真正含字幕行的那一块，不选中隐藏空面板、评论区或章节面板。
- 就绪判定：字幕行出现即继续读取，不再因为找不到旧版片段标签而空等 8 秒后才报错。
- 复制流程：按时间码切分面板文字，写入剪贴板，成功显示 `Copied` 提示；确实没有字幕时保留原有 alert 文案与行为。
- 一致性：同一份修改同时作用于单产物里的原版按钮与新版抓取链路，构建后自动同步。

## Tech Stack Selection
沿用项目现有栈，不引入新依赖：原版逻辑是纯 JavaScript（`user-script.js` IIFE），通过 `import '../src/legacy/verbatim-runtime.js'` 副作用导入；两端由 Vite / WXT 构建；测试用 Vitest + `node:vm`；新版 UI 为 TypeScript + Tailwind。本次核心改动落在 vanilla JS 一份文件里，其余为生成文件、适配层与测试。

## Implementation Approach
**策略：只改「面板怎么认出来、什么时候算就绪」这一层，不动按钮与复制流程。**

数据流（保持原版函数链不变）：点击 `Copy Transcript` → `openTranscriptPanel()` → `pickPanel()` 选 2026 面板 → `waitForSegments()` 判定就绪 → `extractTranscript()` → `collectFromList()` 无旧标签 → `extractFallback()` 用 `innerText` 按时间码切分 → `copyToClipboard()` → `Copied!`。

关键决策与权衡：
1. **用「时间码行数」作为评分与就绪判据，而不是继续猜 2026 的片段标签名。** 用户贴的真实 DOM 里只有面板文本，没有任何 `ytd-transcript-segment-*` 标签；原版 `extractFallback()` 本来就是能产出字幕的路径，缺的只是被喂对面板。
2. **扩展 `SEL.panels`，保留原三条以兼容老版本**：新增 `ytd-engagement-panel-section-list-renderer[visibility*="EXPANDED"]`、`ytd-engagement-panel-section-list-renderer[target-id*="transcript"]`（覆盖 `PAmodern_transcript_view`），以及无 target-id 的通用 `ytd-engagement-panel-section-list-renderer`。
3. **评分顺序：EXPANDED 优先、其次可见、再按时间码行数降序。** 章节时间点只有十几行，字幕有数百行，自然落败；HIDDEN 且文本为空的面板排最后。
4. **复用原版 `openTranscriptPanel()` 的早退分支**：`if (panel) { await waitForSegments(panel, 3000); return panel; }` 保持不变。`pickPanel()` 修好后，面板已开时直接返回，不会再去点 `Show transcript` —— 这正好消除了之前「点击把已展开面板关掉」的副作用，无需额外保护分支。
5. **不新增导出函数**：新增的时间码行统计辅助函数只作 IIFE 内部使用，因此 `scripts/sync-legacy.mjs` 的 18 项导出名单、`src/legacy/contract.ts` 的 `LegacyV19` 接口、`tests/verbatim-runtime.test.ts` 的断言都无需改动，把影响面压到最小。
6. **同步修正新版适配层**：`src/core/dom/legacy.ts` 里 `transcriptPanelExpanded()` 当前会在面板已展开时跳过 `openTranscriptPanel()`，修好原版后这个跳过会挡住刚修好的路径，需放宽为允许调用；`tests/legacy.test.ts` 与 `tests/transcript-tab.test.ts` 中对应「不调用 openTranscriptPanel」的旧断言要同步改写。
7. **`legacy-runtime.ts` 是仅被测试引用的逐函数移植旧副本**，主路径不 import；不改它的逻辑，只加一行「冻结快照、非运行时」注释，避免仓库里三份原版语义被误读。

**性能与复杂度**：面板候选约 13 个，每个取一次 `innerText` 并按行 split，代价可忽略；`waitForSegments` 仍按 150ms 轮询、沿用 3s / 6s 上限；不新增网络请求、不新增定时器。`extractFallback` 若需缩小 scope，限定为面板后代中时间码行最多的容器且限制扫描数量，避免对整页上万节点做全量遍历。构建产物体积仅微增。

## Implementation Notes
- **构建链**：`npm run build` 第一步就是 `node scripts/sync-legacy.mjs`，它会重新生成 `src/legacy/verbatim.js`（逐字节）与 `src/legacy/verbatim-runtime.js`（同内容 + 一行导出），并用 `runtime.replace(EXPORT, '') === text` 校验。改完 `user-script.js` 必须跑一次 build，否则 `tests/legacy.test.ts` 的逐字节一致性测试会失败。
- **UI 边界不得触碰**：`buildButton()`（262–325）、`copyToClipboard()`（240–258）、`addCopyButton()`（327–337）、SPA `setInterval`（339–347）、`btn.onclick` 状态机与三处 alert 文案，全部保持原样。产物中 `stopImmediatePropagation` 必须为不存在 —— 之前捕获阶段接管原版按钮的做法已撤销，不得恢复。
- **失败语义保持**：`pickPanel()` 返回空时仍走原来的 trigger 点击 + 8s 轮询 + 原有 alert，不改变用户可见的失败行为。
- **日志**：原版 `log()` 走 `console.debug`；新增分支只在关键判定处打一条，不要在轮询里打印整段 `innerText`。
- **诊断与文案**：`src/ui/labels.ts` 里若仍写「没有可自动点开的入口」需更正；`src/platform/session.ts` 的诊断首行会自动带上新版本号。`package.json` 版本升到 2.17.0。
- **已知边界**：原版 `innerText` 不跨 shadow root；若某次字幕行只在 closed shadow 内，新版 `dom` 层的 `deepQueryAll` 兜底路径仍然保留，两者互不干扰。
- **复测前提**：用户贴的诊断是 `v2.15.0`，当前已到 `v2.16.0`；交付时必须明确要求更新到新产物并硬刷新，否则验证的仍是旧脚本。

## Architecture Design
单文件修改经生成脚本扇出到两个宿主，关系简单，无需新增架构层：

```
user-script.js（唯一逻辑源）
  → scripts/sync-legacy.mjs（构建前自动同步）
      → src/legacy/verbatim.js（逐字节副本，仅核对）
      → src/legacy/verbatim-runtime.js（+ globalThis.__yttLegacyV19 导出）
          → userscript/main.ts 第 1 行 import  → dist/userscript/youtube-transcript.user.js
          → entrypoints/content.ts 第 1 行 import → dist/extension/content-scripts/content.js
```

原版按钮走 IIFE 内部 `onclick`；新版 `dom` 层通过 `__yttLegacyV19.openTranscriptPanel()` / `extractFallback()` 复用同一份函数。两处都因同一份改动受益。

## Directory Structure

```
project-root/
├── user-script.js                                # [MODIFY] 核心修复。仅改 SEL.panels、新增内部时间码行统计辅助函数、改 countSegments/pickPanel/waitForSegments/openTranscriptPanel 的评分与就绪判定、extractFallback 的 scope 选择；每处加「2026 兼容」行内注释便于对照原版。保留原三条 selector 与全部 UI/alert/剪贴板代码。
├── scripts/
│   └── sync-legacy.mjs                           # [MODIFY] 逻辑不改动；仅在头部注释补一句「user-script.js 已含 2026 兼容逻辑，导出名单保持不变」，避免后续误加导出。
├── src/legacy/
│   ├── verbatim.js                               # [MODIFY] 由 sync 脚本自动重新生成，与 user-script.js 逐字节一致，禁止手工编辑。
│   ├── verbatim-runtime.js                       # [MODIFY] 由 sync 脚本自动重新生成：修复后的整份 IIFE + 原有 18 项导出，禁止手工编辑。
│   └── contract.ts                               # [MODIFY] 接口签名无需变化；仅在文件头注释标明 SEL.panels 已扩展，避免阅读者按旧选择器理解。
├── src/core/dom/
│   ├── legacy.ts                                 # [MODIFY] 放宽 transcriptPanelExpanded() 的跳过分支，让修好的原版 openTranscriptPanel() 能被调用；主流程其余快照/切标签逻辑保留；诊断文案补充「原版面板识别」结果。
│   ├── legacy-runtime.ts                         # [MODIFY] 只加一行「冻结的 1.9 逐函数快照，非运行时，主路径请用 verbatim-runtime.js」注释；不改任何逻辑，保证既有单测通过。
│   └── legacy-copy.ts                            # [MODIFY] 不改逻辑；确认注释中「不挂钩/不拦截/不改写 copy-transcript-btn」仍然成立，产物中不得出现 stopImmediatePropagation。
├── src/ui/labels.ts                              # [MODIFY] 更正 SELECTOR_MISS 的 hint，去掉「没有可自动点开的入口」的旧表述，改为说明原版按钮已能直接识别 2026 面板。
├── package.json                                  # [MODIFY] version 由 2.16.0 升到 2.17.0；scripts 不动。
├── README.md                                     # [MODIFY] 在「原版代码是怎么进来的」章节补一小节：记录 2026 面板的 target-id / visibility 实况、pickPanel 恒空导致 8s 后 alert 的根因、以及本次只改必要逻辑不动 UI 的边界。
├── tests/
│   ├── legacy-panel-2026.test.ts                 # [NEW] 用 node:vm 真实执行 verbatim-runtime.js，构造 2026 假 DOM（EXPANDED 且 target-id 为空的面板、PAmodern_transcript_view 隐藏面板、comments 面板、Chapters 面板），断言 pickPanel 选中字幕面板、waitForSegments 立即就绪、extractFallback 切出字幕行、buildButton().onclick 调用 clipboard 而不触发 alert；并断言 UI 文案与按钮 id 未变。
│   ├── legacy.test.ts                            # [MODIFY] 更新「有可见 Close transcript 时不调用 openTranscriptPanel」的断言，改为验证修好的原版路径可被调用；保留逐字节一致性与导出名单校验。
│   ├── transcript-tab.test.ts                    # [MODIFY] 同步更新依赖「面板已打开且展开」诊断文案的断言。
│   └── verbatim-runtime.test.ts                  # [MODIFY] 保持 18 项导出断言不变；补一条断言确认导出名单未新增函数（防止改动扩散到 sync 脚本与 contract）。
└── dist/
    ├── userscript/youtube-transcript.user.js     # [MODIFY] 构建产物，用户指定的唯一交付物。验证 @version 2.17.0、含新增面板选择器、含 Copy Transcript / Could not find the transcript panel / Copied 文案、不含 stopImmediatePropagation。
    └── extension/content-scripts/content.js      # [MODIFY] 构建产物，同样验证选择器与 UI 文案完整性。
```
