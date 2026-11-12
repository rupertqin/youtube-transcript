import { deepElements, deepQueryAll } from './shadow';

const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?\s/u;

function short(el: Element, limit = 140): string {
  return (el.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function describe(el: Element): string {
  const cls = (el.getAttribute('class') || '').slice(0, 60);
  return `<${el.tagName.toLowerCase()} id="${el.id}" class="${cls}">`;
}

const BUTTON_SELECTOR =
  'button, yt-button-shape button, [role="button"], yt-chip-cloud-chip-renderer, yt-tab-shape, tp-yt-paper-chip';

function buttonLine(el: Element): string {
  const label = short(el, 60);
  const aria = (el.getAttribute('aria-label') || '').trim().slice(0, 60);
  const title = (el.getAttribute('title') || '').trim().slice(0, 60);
  return `${describe(el)} text="${label}" aria="${aria}" title="${title}"`;
}

/**
 * 自动写进诊断文本的精简版结构摘要。
 *
 * 用户每次反馈都会贴诊断文本，所以把真实 DOM 直接放进去，不需要他额外点
 * 「复制页面结构」。重点回答两件事：字幕行在不在（含 shadow root）、入口长什么样
 * （44 个按钮里为什么没有一个文字含 transcript —— 很可能入口只用 aria-label）。
 */
export function dumpStructureSummary(doc: Document): string {
  const out: string[] = [];

  const panels = deepQueryAll(
    doc,
    'ytd-engagement-panel-section-list-renderer, yt-engagement-panel-section-list-view-model, [role="dialog"], ytd-transcript-search-panel-renderer',
  );
  const lightPanels = doc.querySelectorAll('[target-id], ytd-engagement-panel-section-list-renderer').length;
  out.push(`穿透后面板候选=${panels.length}（light DOM 中带 target-id/标签的=${lightPanels}）`);
  for (const panel of panels.slice(0, 6)) {
    out.push(
      `  面板 ${describe(panel)} target-id="${panel.getAttribute('target-id') ?? ''}" visibility="${panel.getAttribute('visibility') ?? ''}" 文本="${short(panel, 70)}"`,
    );
  }

  const buttons = [...new Set([...doc.querySelectorAll(BUTTON_SELECTOR), ...deepQueryAll(doc, BUTTON_SELECTOR)])];
  const keyed = buttons.filter((el) =>
    /transcript|in this video|chapters|key moments|show more|简介/iu.test(
      `${short(el, 80)} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`,
    ),
  );
  out.push(`可点元素=${buttons.length}，相关=${keyed.length}`);
  for (const el of keyed.slice(0, 10)) out.push(`  相关 ${buttonLine(el)}`);
  out.push('可点元素样例（前 10）:');
  for (const el of buttons.slice(0, 10)) out.push(`  ${buttonLine(el)}`);

  const rows: Element[] = [];
  for (const { elements } of deepElements(doc)) {
    for (const el of elements) {
      const text = short(el, 200);
      if (text && TIME_RE.test(text) && rows.length < 12) rows.push(el);
    }
  }
  out.push(`时间码开头的元素=${rows.length}`);
  for (const el of rows) out.push(`  行 ${describe(el)} 文本="${short(el, 90)}"`);

  return out.join('\n');
}

/**
 * 一键导出页面结构：把「面板在哪、行长什么样、入口文案是什么」原样复制出来，
 * 用来代替反复猜选择器。内容写进剪贴板，用户直接粘给开发者即可。
 */
export function dumpPageStructure(doc: Document): string {
  const out: string[] = [];
  out.push(`URL: ${doc.location?.href ?? ''}`);
  out.push(`时间: ${new Date().toISOString()}`);

  const panels = deepQueryAll(
    doc,
    'ytd-engagement-panel-section-list-renderer, yt-engagement-panel-section-list-view-model, [role="dialog"], ytd-transcript-search-panel-renderer',
  );
  out.push(`--- 面板候选 ${panels.length} 个`);
  for (const panel of panels.slice(0, 12)) {
    out.push(
      `${describe(panel)} target-id="${panel.getAttribute('target-id') ?? ''}" visibility="${panel.getAttribute('visibility') ?? ''}" children=${panel.children.length} text="${short(panel)}"`,
    );
  }

  const rowEls: Element[] = [];
  const transcriptLabels: Element[] = [];
  for (const { elements } of deepElements(doc)) {
    for (const el of elements) {
      const text = short(el, 240);
      if (!text) continue;
      if (el.children.length <= 2 && TIME_RE.test(text) && rowEls.length < 12) rowEls.push(el);
      if (text.length <= 40 && /transcript/iu.test(text) && transcriptLabels.length < 12) {
        transcriptLabels.push(el);
      }
    }
  }

  out.push(`--- 以时间码开头的元素（前 ${rowEls.length} 个）`);
  for (const el of rowEls) {
    out.push(`${describe(el)} parent=${describe(el.parentElement ?? el)} text="${short(el)}"`);
  }

  out.push(`--- 文案含 Transcript 的元素（前 ${transcriptLabels.length} 个）`);
  for (const el of transcriptLabels) {
    out.push(`${describe(el)} parent=${describe(el.parentElement ?? el)} text="${short(el, 60)}"`);
  }

  // 疑似字幕行容器：子元素多数以时间码开头
  const containers: { el: Element; hits: number }[] = [];
  for (const { elements } of deepElements(doc)) {
    for (const el of elements) {
      if (el.children.length < 2) continue;
      const kids = Array.from(el.children).slice(0, 12);
      const hits = kids.filter((kid) => TIME_RE.test((kid.textContent || '').trim())).length;
      if (hits >= 2 && hits / kids.length >= 0.6) containers.push({ el, hits });
    }
  }
  containers.sort((a, b) => b.hits - a.hits);
  out.push(`--- 疑似字幕行容器 ${containers.length} 个`);
  for (const { el, hits } of containers.slice(0, 3)) {
    out.push(`${describe(el)} children=${el.children.length} timecode-rows=${hits}`);
    out.push(`HTML: ${(el as HTMLElement).outerHTML?.slice(0, 1200) ?? ''}`);
  }

  return out.join('\n').slice(0, 20000);
}
