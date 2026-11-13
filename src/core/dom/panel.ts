import { deepQueryAll, deepQueryWithin } from './shadow';
import { getSelectors } from './selectors';
import { countTimecodes } from './text-rows';
import { isVisible, sleep, waitForSegments } from './wait';

let triggerInfo = '未尝试';

/** 上一次打开面板的触发器情况（进诊断，用来看「到底点没点开」）。 */
export function getTriggerInfo(): string {
  return triggerInfo;
}

/** 简介默认是折叠的，「Show transcript」按钮可能藏在里面；先点一下展开。 */
async function expandDescription(doc: Document): Promise<boolean> {
  const expander =
    doc.querySelector<HTMLElement>('#description-inline-expander #expand') ??
    doc.querySelector<HTMLElement>('#expand');
  if (!expander || !isVisible(expander)) return false;
  expander.click();
  await sleep(350);
  return true;
}

export function countSegments(root: ParentNode): number {
  const selectors = getSelectors();
  if (!(root instanceof Element)) return -1;
  // 新版面板的片段在 shadow root 里，普通 querySelectorAll 看不到
  if (deepQueryWithin(root, selectors.list).length === 0 && deepQueryWithin(root, selectors.segOld).length === 0) {
    return -1;
  }
  return deepQueryWithin(root, `${selectors.segOld},${selectors.segNew}`).length;
}

/**
 * 多个候选面板时取「内容最像字幕」的那个。
 * 先看文本里的时间码行数（与标签名无关），再看片段元素数量 —— 新版面板
 * 可能一个老标签都匹配不到，但文本一定是对的。
 */
export function scorePanel(el: Element): number {
  const node = el as HTMLElement;
  const text = node.innerText || node.textContent || '';
  return countTimecodes(text) * 10 + Math.max(0, countSegments(el));
}

export function pickPanel(doc: Document): Element | null {
  const selectors = getSelectors();
  const all = deepQueryAll(doc, selectors.panels);
  const visible = all.filter(isVisible);
  const pool = visible.length ? visible : all;
  if (pool.length === 0) return null;
  pool.sort((a, b) => scorePanel(b) - scorePanel(a));
  return pool[0];
}

/**
 * 找 YouTube 自己的「打开字幕」入口。
 *
 * 2026 版的入口不一定是个 <button>：可能是简介里的 Show transcript，
 * 也可能是视频下方那排 chip / tab（Chapters、Transcript…），所以把候选范围放宽到
 * chip / tab / role=button。必须排除 masthead —— 我们注入的两个按钮文案都带
 * Transcript，不排除就会点到自己身上。
 */
const TRIGGER_SELECTOR =
  'button, yt-button-shape button, [role="button"], yt-chip-cloud-chip-renderer, yt-tab-shape, tp-yt-paper-chip';

function triggerCandidates(doc: Document): HTMLElement[] {
  return deepQueryAll(doc, TRIGGER_SELECTOR)
    .filter((el): el is HTMLElement => el instanceof HTMLElement)
    .filter(
      (el) =>
        el.id !== 'ytt-entry-btn' &&
        !el.closest('#ytt-entry-btn, ytd-masthead') &&
        isVisible(el),
    );
}

function triggerLabel(el: HTMLElement): string {
  return (el.textContent || '').replace(/\s+/gu, ' ').trim();
}

function findTrigger(doc: Document): HTMLElement | null {
  const candidates = triggerCandidates(doc);
  return (
    candidates.find((el) => /show\s*transcript/iu.test(triggerLabel(el))) ||
    // chip / tab 的文案通常就是「Transcript」三个词
    candidates.find((el) => /^transcript(\b|$)/iu.test(triggerLabel(el))) ||
    candidates.find((el) => /transcript/iu.test(triggerLabel(el))) ||
    null
  );
}

/** 页面上所有疑似入口的文案（找不到触发器时写进诊断）。 */
function describeTriggers(doc: Document): string {
  const labels = triggerCandidates(doc)
    .map(triggerLabel)
    .filter((text) => text.length > 0 && text.length <= 24)
    .slice(0, 8);
  return labels.length > 0 ? labels.join(' / ') : '(页面上没有任何可点项)';
}

/**
 * 面板顶部有 Chapters / Transcript 两个 tab；停在 Chapters 时字幕行根本不会渲染，
 * YouTube 也不会去请求字幕数据（拦截层因此也拿不到东西）。
 *
 * 新版把 tab 画成了普通 div，所以不能只按标签找：这里按「文本恰好是 Transcript」
 * 过滤出最深的那层，再向上找可点击的宿主（chip / button / role=tab）去点。
 */
function clickTranscriptTab(panel: Element): boolean {
  const isTarget = (el: Element): boolean => {
    const text = (el.textContent || '').replace(/\s+/gu, ' ').trim();
    return text.length > 0 && text.length <= 12 && /^transcript$/iu.test(text);
  };

  const matches = Array.from(panel.querySelectorAll<HTMLElement>('*')).filter(isTarget);
  if (matches.length === 0) return false;

  // 最深的才是一次「tab 文案」；它的祖先才是真正的点击目标
  const deepest = matches.reduce((best, el) => (depth(el) > depth(best) ? el : best), matches[0]);
  const clickable =
    (deepest.closest('button, [role="tab"], yt-chip-cloud-chip-renderer, a') as HTMLElement | null) ??
    deepest;

  if (clickable.getAttribute('aria-selected') === 'true') return false;
  clickable.click();
  return true;
}

function depth(el: Element): number {
  let level = 0;
  let node: Element | null = el;
  while (node?.parentElement) {
    level += 1;
    node = node.parentElement;
  }
  return level;
}

/**
 * 面板已存在时只等待加载，绝不二次点击 —— 二次点击会挂出重复列表。
 */
export async function openTranscriptPanel(
  doc: Document,
  options: { waitMs?: number; timeoutMs?: number } = {},
): Promise<Element | null> {
  const { waitMs = 3000, timeoutMs = 8000 } = options;
  triggerInfo = '开始打开面板…';

  // 只有「已经有片段」的面板才算真的开着；空壳（只有标题）必须重新点开
  let panel = pickPanel(doc);
  if (panel && countSegments(panel) > 0) {
    triggerInfo = '已有面板（含片段），未点击';
    await waitForSegments(panel, waitMs);
    return panel;
  }

  triggerInfo = '面板存在但为空壳';

  /**
   * 点开面板。返回 false 表示**一个可点的东西都没找到** —— 这时没必要再等，
   * 页面上不会凭空长出片段来（以前会白等满 8 秒）。
   */
  const clickOpen = async (): Promise<boolean> => {
    const trigger = findTrigger(doc);
    if (trigger) {
      triggerInfo = `点击触发器: ${trigger.textContent?.trim().slice(0, 30) ?? ''}`;
      trigger.click();
      await sleep(400);
      return true;
    }
    // 简介折叠时按钮不可见：展开一次再找
    if (!(await expandDescription(doc))) {
      triggerInfo = `未找到 Show transcript 触发器；可点项: ${describeTriggers(doc)}`;
      return false;
    }
    const retry = findTrigger(doc);
    if (!retry) {
      triggerInfo = `展开简介后仍未找到触发器；可点项: ${describeTriggers(doc)}`;
      return false;
    }
    triggerInfo = `展开简介后点击触发器: ${retry.textContent?.trim().slice(0, 30) ?? ''}`;
    retry.click();
    await sleep(400);
    return true;
  };

  if (!(await clickOpen())) return panel ?? null;

  const deadline = Date.now() + timeoutMs;
  let tabClicked = false;
  while (Date.now() < deadline) {
    panel = pickPanel(doc);
    if (panel) {
      if (scorePanel(panel) > 0) return panel;
      if (!tabClicked && clickTranscriptTab(panel)) {
        tabClicked = true;
        await sleep(300);
        continue;
      }
    }
    await sleep(150);
  }
  return panel ?? null;
}

/**
 * 切页时把上一页残留的原生字幕面板收掉。
 *
 * YouTube 的 SPA 切页不会销毁展开着的字幕面板，面板里仍是**上一个视频**的行。
 * 这些行没有任何 videoId 标记，DOM 层无法判断归属，只能强制让它重新渲染：
 * 收起来之后，下一次 `openTranscriptPanel()` 会让 YouTube 按新视频重新拉取。
 *
 * 只在「确实像字幕面板」时才动手（有行首时间码 / 有片段元素），
 * 避免把评论、简介这类其它 engagement panel 一起关掉。
 */
export function discardStaleTranscriptPanel(doc: Document): boolean {
  try {
    const panel = pickPanel(doc);
    if (panel && scorePanel(panel) > 0) {
      closeTranscriptPanel(doc, panel);
      return true;
    }

    // `pickPanel()` 认不出（2026 改版、面板停在上一个视频且结构不同）时，
    // 退一步按 target-id 直接找。关不掉也不强求 —— 上层还有内容指纹兜底，
    // 但这里多试一次能省掉一整轮「读到旧内容再丢弃」的等待。
    const fallback = deepQueryAll(doc, '[target-id*="transcript"]').find((el) => isVisible(el));
    if (!fallback) return false;
    closeTranscriptPanel(doc, fallback);
    return true;
  } catch {
    return false;
  }
}

export function closeTranscriptPanel(doc: Document, panel: Element | null): void {
  const scope = panel ?? doc;

  // 2026 面板换过几版结构：#visibility-button 有时是容器、有时直接是按钮，
  // 新版干脆只留一个 aria-label 含 Close 的图标按钮。三条都试一遍。
  const explicit =
    scope.querySelector<HTMLElement>('#visibility-button button') ??
    scope.querySelector<HTMLElement>('ytd-engagement-panel-title-header-renderer #visibility-button button') ??
    scope.querySelector<HTMLElement>('yt-icon-button#visibility-button button') ??
    doc.querySelector<HTMLElement>(
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #visibility-button button',
    );
  if (explicit) {
    explicit.click();
    return;
  }

  // #visibility-button 本身常常就是那个 <yt-icon-button>（里面没有 <button>）
  const visibility = scope.querySelector<HTMLElement>('#visibility-button');
  if (visibility) {
    visibility.click();
    return;
  }

  const labelled = deepQueryWithin(scope as Element, 'button, yt-icon-button, [role="button"]').find((el) => {
    const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`;
    return /close|收起|关闭/iu.test(label) && isVisible(el);
  }) as HTMLElement | undefined;
  labelled?.click();
}

/**
 * 原生字幕面板现在是否展开。
 *
 * 关闭动作是异步生效的：点一下立刻检查 DOM 还是 EXPANDED，所以必须有
 * 「点 → 等 → 再看」的验证循环，否则就是用户说的「显示了不会消失」。
 */
export function isTranscriptPanelExpanded(doc: Document): boolean {
  try {
    const panel = pickPanel(doc);
    if (panel) {
      const visibility = panel.getAttribute('visibility') ?? '';
      if (visibility.includes('EXPANDED')) return true;
      if (visibility.includes('COLLAPSED')) return false;
    }
    // 面板识别不到时退一步：页面上有没有可见的「关闭字幕」按钮
    return deepQueryAll(doc, 'button, [role="button"]').some((el) => {
      const label = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`;
      return (
        /close\s*transcript/iu.test(label) &&
        typeof el.getClientRects === 'function' &&
        el.getClientRects().length > 0
      );
    });
  } catch {
    return false;
  }
}

/**
 * 验证式收起：最多三轮「点一下、等一下、再看」，确认真的收起了才返回。
 *
 * 只点 YouTube 自己的按钮，不隐藏/移除它的节点 —— 后者会让官方 UI 的
 * 「已展开」状态与实际画面不一致，下一次点击反而打不开。
 */
export async function closeTranscriptPanelVerified(doc: Document): Promise<boolean> {
  try {
    for (let attempt = 0; attempt < 3 && isTranscriptPanelExpanded(doc); attempt += 1) {
      closeTranscriptPanel(doc, pickPanel(doc));
      await sleep(220);
    }
    return !isTranscriptPanelExpanded(doc);
  } catch {
    return false;
  }
}
