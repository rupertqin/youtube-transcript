import { collapseWhitespace } from '../harvest/parse/text';

/**
 * 洗掉 YouTube 的无障碍时长复述。
 *
 * 页面给每个时间点都配了一段朗读文本，读面板 innerText 时会一起带出来：
 *
 *   "33:26 33 minutes, 26 seconds 正文"   → 后面的 33 分 26 秒就是 33:26 的复述
 *   "3:323 minutes, 32 secondsI don't…"   → 中间没有空格，直接粘在一起
 *
 * 判定规则：**数值必须和时间码完全一致才删**。
 * 这样 "1:23 we waited 5 minutes" 里的 5 minutes 不会被动到，
 * 只有真正的复述（33:26 ↔ 33 minutes, 26 seconds）才去掉。
 *
 * 解析规则只有这一份：面板、搜索、导出、复制共用。
 */

const DURATION_UNITS: [string, number][] = [
  ['hours?|hrs?', 3_600_000],
  ['minutes?|mins?', 60_000],
  ['seconds?|secs?', 1_000],
  ['小时|小時|时|時', 3_600_000],
  ['分钟|分鐘', 60_000],
  ['秒', 1_000],
];

const DURATION_WORDS = DURATION_UNITS.map(([words]) => words).join('|');
const DURATION_PHRASE = `(?:\\d{1,2}\\s*(?:${DURATION_WORDS})[\\s,，]*)+`;

const AFTER_STAMP = new RegExp(`(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*(${DURATION_PHRASE})`, 'giu');
const AT_START = new RegExp(`^${DURATION_PHRASE}`, 'iu');
const ONLY_LINE = new RegExp(`^${DURATION_PHRASE}$`, 'iu');
const TOKEN = new RegExp(`(\\d{1,2})\\s*(${DURATION_WORDS})`, 'giu');
const UNIT_TO_MS = DURATION_UNITS.map(([words, ms]) => [new RegExp(`^(?:${words})$`, 'iu'), ms] as const);

/** "1:23" / "01:02:03" → 毫秒；解析不出来返回 -1。 */
function timecodeMs(time: string): number {
  const bits = time.split(':').map(Number);
  if (bits.some((n) => !Number.isFinite(n))) return -1;
  return bits.length === 3
    ? (bits[0] * 3600 + bits[1] * 60 + bits[2]) * 1000
    : (bits[0] * 60 + bits[1]) * 1000;
}

/** 把 "33 minutes, 26 seconds" 这样的复述换算成毫秒；认不出单位返回 -1。 */
function spokenDurationMs(phrase: string): number {
  let total = 0;
  let seen = false;
  for (const match of phrase.matchAll(TOKEN)) {
    const unit = match[2].toLowerCase();
    const entry = UNIT_TO_MS.find(([pattern]) => pattern.test(unit));
    if (!entry) return -1;
    total += Number(match[1]) * entry[1];
    seen = true;
  }
  return seen ? total : -1;
}

/**
 * @param expectedMs 已知该行起点（毫秒）时传入。结构化行的时间码已被解析到
 *   start 字段、正文里只剩那串复述，这时靠 expectedMs 才能对上。
 */
export function stripA11yDuration(text: string, expectedMs?: number): string {
  let cleaned = text.replace(AFTER_STAMP, (match, stamp: string, phrase: string) =>
    timecodeMs(stamp) === spokenDurationMs(phrase) ? `${stamp} ` : match,
  );

  // 行首单独一段复述（时间码在 start 里，不在这段文本里）
  const lead = AT_START.exec(cleaned);
  if (lead && Number.isFinite(expectedMs) && (expectedMs as number) >= 0) {
    if (spokenDurationMs(lead[0]) === expectedMs) cleaned = cleaned.slice(lead[0].length);
  }

  return cleaned
    .split('\n')
    .map((line) => collapseWhitespace(line))
    .filter((line) => line.length > 0 && !ONLY_LINE.test(line))
    .join('\n');
}
