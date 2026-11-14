import type { TranscriptLine } from '../../types';

const VIDEO_ID_RE = /"?videoId"?\s*[:=]\s*"?([\w-]{11})/u;

/** base64 → binary string。浏览器用 atob，node（单测）用 Buffer，都没有就放弃。 */
function decodeBase64(input: string): string | null {
  const normalized = input.replace(/-/gu, '+').replace(/_/gu, '/');
  try {
    if (typeof atob === 'function') return atob(normalized);
    const buffer = (globalThis as { Buffer?: { from: (s: string, enc: string) => { toString: (enc: string) => string } } })
      .Buffer;
    if (buffer) return buffer.from(normalized, 'base64').toString('binary');
  } catch {
    /* 非法 base64，交给上层 */
  }
  return null;
}

/**
 * get_transcript 的 `params` 是 base64(protobuf)，videoId 在第 1 个字段：
 * 字节序列 `0x0a 0x0b <11 字节 id>`。这是**请求里唯一可信的归属信息**。
 */
const PARAM_VIDEO_ID_RE = /\u000a\u000b([A-Za-z0-9_-]{11})/u;

/**
 * 从 get_transcript 的**请求体**里取 videoId。
 *
 * 这个接口的 URL 上只有 prettyPrint，真实视频 id 藏在 POST body 里：
 *  - 新版 body 里可能直接有 `videoId` 字段；
 *  - 更常见的是只有 `params`，必须 base64 解码后从 protobuf 里读。
 *
 * 为什么非要读到它：读不到就只能退回「发请求那一刻的地址栏」，而 SPA 切页时
 * 地址栏先变、面板后变，旧面板迟到的请求会被错标成新视频 —— 于是新视频
 * 显示的正是上一个视频的字幕，而且 id 完全对得上，怎么查都查不出来。
 */
export function videoIdFromGetTranscriptBody(body: unknown): string | null {
  return readTranscriptParams(body).videoId;
}

/**
 * 从 `get_transcript` 的请求体里读出 **语言码**。
 *
 * params 是两层 protobuf：外层 {1: videoId, 2: base64(内层)}，内层 {1: kind, 3: lang, 5: ''}。
 * 语言码在内层 field 3。`get_transcript` 的 URL 上没有 `lang=` 参数，
 * 所以以前 `capture.lang` 恒为 null —— 拦截层一见「请求了目标语言」就把
 * 完整响应整条丢掉（判成「捕获的是未知语言」），于是永远只能退到 DOM 兜底、
 * 读到虚拟列表那一屏，前面的字幕全漏。这是「漏前段」的真正原因。
 */
export function langFromGetTranscriptBody(body: unknown): string | null {
  return readTranscriptParams(body).lang;
}

/**
 * 读 protobuf 的 varint（tag 与长度都可能是多字节）。
 *
 * `get_panel` 的 params 外层 tag 是 `0xAA 0x09`（field 149），两个字节 ——
 * 只读一个字节会把后面的内容当成长度，整条 params 解析成垃圾。
 */
function readVarint(binary: string, index: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let i = index;
  while (i < binary.length) {
    const byte = binary.charCodeAt(i) & 0xff;
    i += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 28) return null;
  }
  return null;
}

/** 读 protobuf，只取 length-delimited 字段（够我们这几处用）。 */
function readLengthDelimited(binary: string): Map<number, string> {
  const out = new Map<number, string>();
  let i = 0;
  while (i < binary.length) {
    const tag = readVarint(binary, i);
    if (!tag) break;
    i = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire !== 2) {
      // varint 字段（get_panel 的 field 3 = 1）跳过 1 个 varint
      const skip = readVarint(binary, i);
      if (!skip) break;
      i = skip.next;
      continue;
    }
    const len = readVarint(binary, i);
    if (!len) break;
    i = len.next;
    // len 0 是合法的（kind='' 表示手动上传的字幕），不能当成终止信号
    if (len.value > 4096 || i + len.value > binary.length) break;
    out.set(field, binary.slice(i, i + len.value));
    i += len.value;
  }
  return out;
}

export function readTranscriptParams(body: unknown): {
  videoId: string | null;
  lang: string | null;
} {
  const out = { videoId: null as string | null, lang: null as string | null };
  if (typeof body !== 'string') return out;

  // 先认 body 里直接带 videoId 的新格式
  const direct = VIDEO_ID_RE.exec(body);
  if (direct) out.videoId = direct[1];

  const params = /"params"\s*:\s*"([^"]+)"/u.exec(body);
  if (!params) return out;

  const outer = decodeBase64(params[1]);
  if (!outer) return out;

  const fields = readLengthDelimited(outer);
  out.videoId = out.videoId || fields.get(1) || PARAM_VIDEO_ID_RE.exec(outer)?.[1] || null;

  const innerB64 = fields.get(2);
  const inner = innerB64 ? decodeBase64(innerB64) : null;
  if (inner) out.lang = readLengthDelimited(inner).get(3) ?? null;

  // get_panel 的 params 是 {149: {1: videoId, 3: 1}}：videoId 在**内层** field 1
  if (!out.videoId || !out.lang) {
    for (const value of fields.values()) {
      const nested = readLengthDelimited(value);
      if (!out.videoId) {
        const candidate = nested.get(1);
        if (candidate && /^[\w-]{11}$/u.test(candidate)) out.videoId = candidate;
      }
      if (!out.lang) {
        const candidate = nested.get(3);
        if (candidate && /^[\w-]{2,12}$/u.test(candidate) && !/^\d+$/u.test(candidate)) {
          out.lang = candidate;
        }
      }
    }
  }
  return out;
}

function collectSnippet(snippet: unknown): string {
  if (!snippet || typeof snippet !== 'object') return '';
  const node = snippet as { simpleText?: unknown; runs?: unknown };
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (!Array.isArray(node.runs)) return '';
  return node.runs
    .map((run) => {
      if (!run || typeof run !== 'object') return '';
      const text = (run as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/**
 * `get_panel` / `get_transcript` 的响应 → 字幕行。
 *
 * 2026 版原生字幕面板走的是这两个接口（不是 timedtext），返回结构化 JSON。
 *
 * **按形状找，不按名字找**：YouTube 一直在改渲染器名字
 * （`transcriptSegmentRenderer` → `transcriptSegmentViewModel` → 以后的别的）。
 * 只认某一个键名的结果就是——响应明明 200 拿到手，却解析出 0 行。
 *
 * 更坑的是**时间戳**：2026 的时间线面板（`TIMELINE_VIEW_STYLE_MODERN`）里
 * 分段节点**根本没有 `startMs`**，只有人读的 `timestamp: "0:03"`：
 *
 *   {"transcriptSegmentViewModel": {"simpleText": "…", "timestamp": "0:03", …}}
 *
 * 精确到毫秒的时间只出现在 `frameworkUpdates…timedMarkersListSyncEntity` 里，
 * 而且还要跟 syncItemId 对上，所以这里就用面板自己显示的 `timestamp`，
 * 结束时间取“下一段（不同起点）的开始时间”，与面板的行分组一致。
 *
 * 判据：**任何对象，只要有开始时间 + 文字，就算一条字幕**：
 * 数字字段（startMs / startTimeMs / …）优先，其次 `timestamp`（"0:03"），
 * 再次 `timestampA11yLabel`（"3 seconds"）。文字从 `snippet` / `content` / `runs`
 * / `simpleText` 里递归取，新旧结构都能吃。
 */
export function parseGetTranscript(raw: string): TranscriptLine[] {
  if (!raw.trim()) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }

  const found: { start: number; end: number | null; text: string }[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const record = node as Record<string, unknown>;
    const segment = segmentLine(record);
    if (segment) {
      const key = `${segment.start}|${segment.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push(segment);
      }
      // 已经是一条完整分段，不再往里钻，避免把内部字段算成第二条
      return;
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') walk(value);
    }
  };

  walk(payload);
  found.sort((a, b) => a.start - b.start);

  // 没有显式结束时间时，用「下一段不同起点的开始时间」补齐 —— 同一起点的多行
  // 属于同一屏（面板就是这么分组的），一起持续到下一屏。
  return found.map((segment, index) => {
    let dur = segment.end === null ? null : Math.max(0, segment.end - segment.start);
    if (dur === null) {
      const next = found.slice(index + 1).find((item) => item.start > segment.start);
      dur = next ? next.start - segment.start : 0;
    }
    return { start: segment.start, dur, text: segment.text };
  });
}

/** 开始/结束时间的各种历史命名，按优先级取第一个能解析成数字的。 */
const START_KEYS = ['startMs', 'startMillis', 'startTimeMs', 'timeRangeStartMillis', 'tStartMs'] as const;
const END_KEYS = ['endMs', 'endMillis', 'endTimeMs', 'timeRangeEndMillis'] as const;

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = record[key];
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** `"0:03"` / `"12:34"` / `"1:02:03"` → 毫秒。 */
function parseClock(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  return ((hours * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000;
}

/** `"3 seconds"` / `"1 minute, 2 seconds"` / `"1 hour, 3 minutes"` → 毫秒。 */
function parseA11yTimestamp(value: string): number | null {
  const unit = /(\d+)\s*(hour|minute|second)/giu;
  let total = 0;
  let matched = false;
  for (const [, amount, name] of value.matchAll(unit)) {
    matched = true;
    const scale = name.toLowerCase() === 'hour' ? 3600 : name.toLowerCase() === 'minute' ? 60 : 1;
    total += Number(amount) * scale;
  }
  return matched ? total * 1000 : null;
}

/** 一个分段节点 → 字幕行；缺时间戳或文字就返回 null。 */
function segmentLine(
  segment: Record<string, unknown>,
): { start: number; end: number | null; text: string } | null {
  let start = firstNumber(segment, START_KEYS);
  if (start === null) {
    // 2026 时间线面板只有人读的时间："0:03"，或在 a11y 标签里
    if (typeof segment.timestamp === 'string') start = parseClock(segment.timestamp);
    if (start === null && typeof segment.timestampA11yLabel === 'string') {
      start = parseA11yTimestamp(segment.timestampA11yLabel);
    }
  }
  if (start === null) return null;

  const end = firstNumber(segment, END_KEYS);
  const text = collectAnyText(segment.snippet ?? segment.content ?? segment)
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return null;

  return { start, end, text };
}

/**
 * 形状无关地取文字：`simpleText` / `runs` 优先，再往 `snippet` / `content` /
 * `text` / `runs` 这几个常见的容器里递归（新结构把文字挪了位置也能找到）。
 */
function collectAnyText(node: unknown, depth = 0): string {
  if (node === null || node === undefined || depth > 4) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';

  const record = node as Record<string, unknown>;
  const direct = collectSnippet(record);
  if (direct) return direct;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (!/snippet|content|text|runs/iu.test(key)) continue;
    const piece = collectAnyText(value, depth + 1);
    if (piece) parts.push(piece);
  }
  return parts.join('');
}
