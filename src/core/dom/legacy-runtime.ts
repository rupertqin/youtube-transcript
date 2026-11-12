/**
 * 【冻结快照，非运行时】user-script.js v1.9 的**逐函数移植**（第 19–238 行）。
 * 主路径请用逐字节的 src/legacy/verbatim-runtime.js；本文件仅被单测引用，
 * 不含 2026 面板兼容逻辑，不要再往这里加功能。
 *
 * 移植方法（按「逐步转移」的要求）：
 *  1. 只做一处必要适配：闭包里 `const document = doc`，让原版代码里的
 *     `document.querySelectorAll` 等调用一字不改即可工作。
 *  2. 其余函数名、变量名、正则、阈值、注释全部保持原样；行号见每处注释。
 *  3. 不 import 本项目任何 DOM 工具（shadow / wait / selectors / lines），
 *     也不加内容校验、形状扫描、面板关闭、超时参数 —— 那些都不是原版行为。
 *  4. 第 2 步（把纯文本转成结构化行）放在 legacy.ts，与这份运行时隔离。
 *
 * 对照命令：`diff <(sed -n '19,238p' user-script.js) ...`（本文件按同样顺序排列）。
 */

export interface LegacyRuntime {
  /** 原版按钮 onclick 的两步：openTranscriptPanel() → extractTranscript(panel) */
  run(): Promise<{ text: string; showTimestamps: boolean; lines: number }>;
  /** 供单测调用：原版 extractFallback */
  extractFallback(panel: Element): { text: string };
  /** 供单测调用：原版 collapseDuplicates */
  collapseDuplicates(lines: string[], aggressive: boolean): string[];
  /** 原版 log() 收集到的信息 */
  diagnostics(): string[];
}

export function createLegacyRuntime(doc: Document): LegacyRuntime {
  // ↓↓↓ 唯一适配：让下面所有原版代码里的 `document` 指向调用方给的文档 ↓↓↓
  const document = doc;

  const notes: string[] = [];
  const log = (...a: unknown[]): void => {
    notes.push(a.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join(' '));
  };

  /* ---------------- user-script.js:19-31 ---------------- */
  const SEL = {
    mastheadEnd: 'ytd-masthead #end',
    panels: [
      'ytd-transcript-search-panel-renderer',
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-transcript"]',
      '[role="dialog"] ytd-transcript-segment-list-renderer'
    ].join(','),
    list: 'ytd-transcript-segment-list-renderer',
    segOld: 'ytd-transcript-segment-renderer, .ytd-transcript-segment-renderer',
    segNew: 'yt-transcript-segment-renderer',
    stamp: '#segment-timestamp, .segment-timestamp',
    text: '#segment-text, .segment-text'
  };

  /* ---------------- user-script.js:33-34 ---------------- */
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const normalize = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  /* ---------------- user-script.js:38-53 ---------------- */
  function waitForElement(selector: string, timeout = 10000) {
    return new Promise<Element>((resolve, reject) => {
      const interval = 100;
      let elapsed = 0;
      const timer = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(timer);
          resolve(el);
        } else if ((elapsed += interval) >= timeout) {
          clearInterval(timer);
          reject(new Error(`Element ${selector} not found within ${timeout}ms`));
        }
      }, interval);
    });
  }
  void waitForElement;
  void SEL.mastheadEnd;

  /* ---------------- user-script.js:58-63 ---------------- */
  function isVisible(el: Element | null | undefined): boolean {
    if (!el) return false;
    if (el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el as HTMLElement);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  /* ---------------- user-script.js:68-71 ---------------- */
  function countSegments(root: ParentNode): number {
    if (!root.querySelector(SEL.list) && !root.querySelector(SEL.segOld)) return -1;
    return root.querySelectorAll(SEL.segOld + ',' + SEL.segNew).length;
  }

  /* ---------------- user-script.js:73-81 ---------------- */
  function pickPanel(): Element | null {
    const all = Array.from(document.querySelectorAll(SEL.panels));
    const visible = all.filter(isVisible);
    const pool = visible.length ? visible : all;
    if (!pool.length) return null;
    // 多个候选面板时取片段最多的那个（真正的主面板）
    pool.sort((a, b) => countSegments(b) - countSegments(a));
    return pool[0];
  }

  /* ---------------- user-script.js:83-90 ---------------- */
  async function waitForSegments(panel: ParentNode, timeout = 8000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (panel.querySelector(SEL.list) || panel.querySelector(SEL.segOld)) return true;
      await sleep(150);
    }
    return false;
  }

  /* ---------------- user-script.js:92-117 ---------------- */
  async function openTranscriptPanel(): Promise<Element | null> {
    // 面板已存在 → 只等待加载，绝不二次点击（二次点击会挂出重复列表）
    let panel = pickPanel();
    if (panel) {
      log('panel exists, waiting for segments');
      await waitForSegments(panel, 3000);
      return panel;
    }

    const buttons = Array.from(document.querySelectorAll('button, yt-button-shape button'));
    const trigger =
      buttons.find((b) => /show\s*transcript/i.test(b.textContent || '')) ||
      buttons.find((b) => /transcript/i.test(b.textContent || ''));

    log(trigger ? `click trigger: ${normalize(trigger.textContent)}` : 'no trigger found');
    if (trigger) {
      (trigger as HTMLElement).click();  // 仅 TS 类型断言：原版 JS 里就是 trigger.click()
      await sleep(400);
    }

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      panel = pickPanel();
      if (panel && (panel.querySelector(SEL.list) || panel.querySelector(SEL.segOld))) return panel;
      await sleep(150);
    }
    log('no panel with segments within 8s');
    return panel || null;
  }

  /* ---------------- user-script.js:122-125 ---------------- */
  function segmentSelectorFor(list: ParentNode): string {
    // 新旧两套元素互斥使用，避免同一片段被两套选择器同时命中
    return list.querySelector(SEL.segNew) ? SEL.segNew : SEL.segOld;
  }

  /* ---------------- user-script.js:127-153 ---------------- */
  function collectFromList(list: ParentNode): {
    lines: string[];
    showTimestamps: boolean;
    segCount: number;
  } {
    const segSel = segmentSelectorFor(list);
    // 元素级去重：同一节点被多个选择器命中时只保留一次
    const segs = Array.from(new Set(Array.from(list.querySelectorAll(segSel))));
    if (!segs.length) return { lines: [], showTimestamps: false, segCount: 0 };

    // 以首段的时间戳单元格为探针判定开关状态；
    // 若时间戳节点已被整体移除，探针为 null → 视为隐藏。
    const probe = segs[0].querySelector(SEL.stamp);
    const showTimestamps = isVisible(probe);

    const lines: string[] = [];
    for (const seg of segs) {
      const stampEl = seg.querySelector(SEL.stamp);
      const textEl =
        seg.querySelector(SEL.text) ||
        seg.querySelector('yt-formatted-string');

      const time = showTimestamps && isVisible(stampEl) ? normalize(stampEl!.textContent) : '';
      const text = normalize(textEl ? (textEl as HTMLElement).innerText || textEl.textContent : '');

      if (!text) continue;                 // 行是否有效只看正文，不看时间戳
      lines.push(time ? `${time} ${text}` : text);
    }

    return { lines, showTimestamps, segCount: segs.length };
  }

  /* ---------------- user-script.js:160-177 ---------------- */
  function collapseDuplicates(lines: string[], aggressive: boolean): string[] {
    if (lines.length < 2) return lines;

    let out = lines;
    if (aggressive) {
      out = [];
      for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
    }

    if (out.length >= 4 && out.length % 2 === 0) {
      const half = out.length / 2;
      if (out.slice(0, half).join('\n') === out.slice(half).join('\n')) {
        log('duplicated halves detected, trimmed', out.length, '->', half);
        return out.slice(0, half);
      }
    }
    return out;
  }

  /* ---------------- user-script.js:179-208 ---------------- */
  async function extractTranscript(panel: Element): Promise<{ text: string; showTimestamps: boolean }> {
    await waitForSegments(panel, 6000);

    const lists = Array.from(panel.querySelectorAll(SEL.list)).filter(isVisible);
    const candidates = lists.length ? lists : [panel];

    // 只取第一个能产出内容的列表；绝不合并多个列表（合并即重复）
    let best = { lines: [] as string[], showTimestamps: false, segCount: 0 };
    for (const list of candidates) {
      const r = collectFromList(list);
      if (r.lines.length) { best = r; break; }
    }

    if (best.lines.length) {
      // 触发激进去重的三个信号：多个列表 / 片段数与行数不符 /
      // 重复率超过 30%（真实字幕几乎不可能达到，DOM 双份则会接近 50%）
      const distinct = new Set(best.lines).size;
      const aggressive =
        lists.length > 1 ||
        best.segCount !== best.lines.length ||
        distinct < best.lines.length * 0.7;
      const lines = collapseDuplicates(best.lines, aggressive);
      log({ lists: lists.length, segs: best.segCount, lines: lines.length, showTimestamps: best.showTimestamps });
      return { text: lines.join('\n'), showTimestamps: best.showTimestamps };
    }

    const fb = extractFallback(panel);
    log('fallback used', { chars: fb.text.length });
    return { ...fb, showTimestamps: false };
  }

  /* ---------------- user-script.js:211-230 ---------------- */
  function extractFallback(panel: Element): { text: string } {
    const scope = panel.querySelector(SEL.list) || panel;
    const raw = normalizeLines((scope as HTMLElement).innerText || '');
    if (!raw) return { text: '' };

    const TS = /(\d{1,2}:\d{2}(?::\d{2})?)/;
    if (!TS.test(raw)) {
      // 无时间戳（已关闭开关）→ 原样按行输出，绝不合成时间戳
      return { text: raw };
    }

    const parts = raw.split(/\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*/);
    const out: string[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      const time = parts[i];
      const lineText = normalize(parts[i + 1]);
      if (time && lineText) out.push(`${time} ${lineText}`);
    }
    return { text: out.length ? out.join('\n') : raw };
  }

  /* ---------------- user-script.js:232-238 ---------------- */
  function normalizeLines(s: string): string {
    return (s || '')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  /* ---------------- user-script.js:291-316（按钮 onclick 的两步） ---------------- */
  async function run(): Promise<{ text: string; showTimestamps: boolean; lines: number }> {
    // 包装层诊断（非原版代码）：把「为什么 pickPanel 找不到面板」直接写清楚
    const panelCount = document.querySelectorAll(SEL.panels).length;
    const buttonCount = document.querySelectorAll('button, yt-button-shape button').length;
    const targetIds = Array.from(document.querySelectorAll('[target-id]'))
      .map((el) => el.getAttribute('target-id'))
      .filter((id): id is string => Boolean(id))
      .slice(0, 10);
    log(`DOM 探测: panels=${panelCount}, buttons=${buttonCount}, target-id=[${targetIds.join(' / ')}]`);

    const panel = await openTranscriptPanel();
    if (!panel) {
      log('Could not find the transcript panel');
      return { text: '', showTimestamps: false, lines: 0 };
    }
    const result = await extractTranscript(panel);
    const lines = result.text ? result.text.split('\n').filter(Boolean).length : 0;
    log('extract done', { lines, chars: result.text.length });
    return { ...result, lines };
  }

  return {
    run,
    extractFallback,
    collapseDuplicates,
    diagnostics: () => [...notes],
  };
}
