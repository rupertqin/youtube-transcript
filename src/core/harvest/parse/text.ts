/** 文本清洗小工具：三个解析器共用。 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const mapped = ENTITIES[body.toLowerCase()];
    return mapped ?? match;
  });
}

/** 折叠空白但保留可读性。 */
export function collapseWhitespace(input: string): string {
  return input.replace(/[\s\u00a0]+/gu, ' ').trim();
}

export function stripTags(input: string): string {
  return input.replace(/<br\s*\/?>/giu, ' ').replace(/<[^>]+>/gu, '');
}

function isLatinWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9]/.test(ch);
}

/** 逐段拼接：CJK 直接相连，拉丁文之间补一个空格。 */
export function joinSegments(segments: string[]): string {
  let out = '';
  for (const segment of segments) {
    if (!segment) continue;
    if (!out) {
      out = segment;
      continue;
    }
    const prev = out[out.length - 1];
    const next = segment[0];
    const needSpace = isLatinWordChar(prev) && isLatinWordChar(next);
    out += needSpace ? ` ${segment}` : segment;
  }
  return out;
}

export function toMs(value: number | string | undefined | null, unit: 'ms' | 's'): number {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.round(unit === 's' ? num * 1000 : num));
}

export function dropEmpty(
  lines: { start: number; dur: number; text: string }[],
): { start: number; dur: number; text: string }[] {
  return lines
    .map((line) => ({ ...line, text: collapseWhitespace(line.text) }))
    .filter((line) => line.text.length > 0);
}
