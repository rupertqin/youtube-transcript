/** 极小的 DOM 构造工具：整个面板不引入任何框架。 */

export interface NodeProps {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  style?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, EventListener>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: NodeProps = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;

  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  if (props.style) {
    for (const [key, value] of Object.entries(props.style)) {
      node.style.setProperty(key, value);
    }
  }

  if (props.on) {
    for (const [type, listener] of Object.entries(props.on)) {
      node.addEventListener(type, listener as EventListener);
    }
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }

  return node;
}

export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function toggle(node: Element, className: string, on: boolean): void {
  node.classList.toggle(className, on);
}

export function show(node: HTMLElement, visible: boolean): void {
  node.style.display = visible ? '' : 'none';
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 二分查找：返回 offsets 中最后一个 <= value 的下标。 */
export function findOffset(offsets: number[], value: number): number {
  let low = 0;
  let high = offsets.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= value) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
