/**
 * 穿透 Shadow DOM 的查询工具。
 *
 * 2026 版 YouTube 把字幕面板换成了带 shadow root 的组件：行明明渲染在页面上，
 * `document.querySelectorAll` 却一个都看不到。所有 DOM 探测都要走这里。
 */

const CAPTURE_KEY = '__yttShadowCaptureV1';

/** attachShadow 钩子登记的 roots：closed root 只有这里能拿到引用。 */
const registry = new Set<ShadowRoot>();
let captureInstalled = false;
let cache: { doc: Document; at: number; roots: (Document | ShadowRoot)[] } | null = null;

/**
 * document_start 装一次：页面每次 attachShadow 都把 root 记下来。
 * 必须在页面脚本运行之前装（document_start），晚装只能拿到 open root。
 */
export function installShadowCapture(win: Window): void {
  const scope = win as unknown as Record<string, unknown>;
  if (captureInstalled || scope[CAPTURE_KEY]) return;
  captureInstalled = true;
  scope[CAPTURE_KEY] = true;

  const ctor = (win as unknown as typeof globalThis).Element;
  if (!ctor || typeof ctor.prototype?.attachShadow !== 'function') return;
  const original = ctor.prototype.attachShadow;
  ctor.prototype.attachShadow = function patched(this: Element, init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, init);
    registry.add(root);
    cache = null;
    return root;
  } as typeof Element.prototype.attachShadow;
}

function walkShadowRoots(
  root: Document | ShadowRoot | Element,
  out: (Document | ShadowRoot)[],
  seen: Set<Element>,
): void {
  for (const el of root.querySelectorAll('*')) {
    if (seen.has(el)) continue;
    seen.add(el);
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow && !out.includes(shadow)) {
      out.push(shadow);
      walkShadowRoots(shadow, out, seen);
    }
  }
}

/** light DOM + 所有可达的 shadow root（带短缓存，轮询场景不会反复全树遍历）。 */
export function allRoots(doc: Document, maxAgeMs = 400): (Document | ShadowRoot)[] {
  if (cache && cache.doc === doc && Date.now() - cache.at < maxAgeMs) return cache.roots;

  const roots: (Document | ShadowRoot)[] = [doc];
  walkShadowRoots(doc, roots, new Set());
  for (const root of registry) {
    if (!roots.includes(root)) {
      roots.push(root);
      walkShadowRoots(root, roots, new Set());
    }
  }

  cache = { doc, at: Date.now(), roots };
  return roots;
}

/** 在整页（含 shadow DOM）范围内按选择器收集，元素级去重。 */
export function deepQueryAll(doc: Document, selector: string): Element[] {
  const out = new Set<Element>();
  for (const root of allRoots(doc)) {
    for (const el of root.querySelectorAll(selector)) out.add(el);
  }
  return [...out];
}

/** 在某个元素的子树（含其内部的 shadow root）范围内按选择器收集。 */
export function deepQueryWithin(scope: Element, selector: string): Element[] {
  const out = new Set<Element>();
  const roots: ParentNode[] = [scope];

  const selfShadow = (scope as HTMLElement).shadowRoot;
  if (selfShadow) roots.push(selfShadow);
  for (const el of scope.querySelectorAll('*')) {
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) roots.push(shadow);
  }

  for (const root of roots) {
    for (const el of root.querySelectorAll(selector)) out.add(el);
  }
  return [...out];
}

/** light DOM 与所有 shadow root，各自带元素列表（供形状扫描用）。 */
export function deepElements(doc: Document): { root: Document | ShadowRoot; elements: Element[] }[] {
  return allRoots(doc).map((root) => ({ root, elements: Array.from(root.querySelectorAll('*')) }));
}
