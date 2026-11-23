/** 内联 SVG 图标（stroke 风格，24 网格），替换掉 lucide 依赖。 */

type Attrs = Record<string, string>;
type Spec = [string, Attrs];

const ICONS = {
  search: [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['line', { x1: '16.5', y1: '16.5', x2: '21', y2: '21' }],
  ],
  chevronUp: [['polyline', { points: '6 15 12 9 18 15' }]],
  chevronDown: [['polyline', { points: '6 9 12 15 18 9' }]],
  clock: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['polyline', { points: '12 7 12 12 16 14' }],
  ],
  globe: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M3 12h18' }],
    ['path', { d: 'M12 3c2.6 2.7 4 6 4 9s-1.4 6.3-4 9c-2.6-2.7-4-6-4-9s1.4-6.3 4-9z' }],
  ],
  copy: [
    ['rect', { x: '9', y: '9', width: '12', height: '12', rx: '2.5' }],
    ['path', { d: 'M15 5.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h0.5' }],
  ],
  check: [['polyline', { points: '4 12.5 9.5 18 20 6' }]],
  download: [
    ['path', { d: 'M12 3v12' }],
    ['polyline', { points: '7 10.5 12 15.5 17 10.5' }],
    ['path', { d: 'M4 20h16' }],
  ],
  close: [
    ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }],
    ['line', { x1: '18', y1: '6', x2: '6', y2: '18' }],
  ],
  sun: [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4' }],
  ],
  moon: [['path', { d: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z' }]],
  monitor: [
    ['rect', { x: '2.5', y: '4', width: '19', height: '13', rx: '2' }],
    ['path', { d: 'M9 21h6M12 17v4' }],
  ],
  alert: [
    ['path', { d: 'M12 3.5 21.5 20.5H2.5z' }],
    ['path', { d: 'M12 9.5v5' }],
    ['path', { d: 'M12 17.5h0.01' }],
  ],
  searchX: [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['line', { x1: '16.5', y1: '16.5', x2: '21', y2: '21' }],
    ['line', { x1: '8.5', y1: '8.5', x2: '13.5', y2: '13.5' }],
    ['line', { x1: '13.5', y1: '8.5', x2: '8.5', y2: '13.5' }],
  ],
  spinner: [['path', { d: 'M12 3a9 9 0 1 0 9 9' }]],
  database: [
    ['ellipse', { cx: '12', cy: '5.5', rx: '8', ry: '3' }],
    ['path', { d: 'M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13' }],
    ['path', { d: 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' }],
  ],
  list: [
    ['path', { d: 'M9 6h11M9 12h11M9 18h11' }],
    ['path', { d: 'M4.5 6h0.01M4.5 12h0.01M4.5 18h0.01' }],
  ],
  /** 字型图标（T 字）：用来开字号/行距这类排版设置 */
  type: [
    ['polyline', { points: '4 7 4 4 20 4 20 7' }],
    ['line', { x1: '9', y1: '20', x2: '15', y2: '20' }],
    ['line', { x1: '12', y1: '4', x2: '12', y2: '20' }],
  ],
  activity: [['polyline', { points: '3 12 7 12 10 4 14 20 17 12 21 12' }]],
  refresh: [
    ['path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1' }],
    ['polyline', { points: '20.5 3.5 20.5 8.5 15.5 8.5' }],
  ],
} satisfies Record<string, Spec[]>;

export type IconName = keyof typeof ICONS;

const NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, size = 14): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.flexShrink = '0';

  for (const [tag, attrs] of ICONS[name]) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  }

  return svg;
}
