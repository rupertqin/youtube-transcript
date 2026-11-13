import { parseGetTranscript } from './parse/transcript';

/**
 * 直接构造 InnerTube `get_transcript` 请求。
 *
 * 原生字幕面板显示的行，数据来源就是这个接口。
 * 之前我们等面板打开后拦截它发的请求，但面板打不开（入口元素、tab、懒加载）
 * 每一步都可能卡住 —— 现在自己构造 params 直接请求，绕开所有 DOM 问题。
 *
 * params 是 protobuf：外层 {1: videoId, 2: base64(内层)}，内层 {1: 'asr', 3: lang, 5: kind}。
 * 编码规则（protobuf wire format）：fieldNumber<<3|2 作为 tag，长度用 varint。
 */

const TEXT_ENCODER = new TextEncoder();

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function pbField(tag: number, payload: number[]): number[] {
  return [...varint(tag), ...varint(payload.length), ...payload];
}

function pbString(tag: number, value: string): number[] {
  return pbField(tag, [...TEXT_ENCODER.encode(value)]);
}

function toBase64(bytes: number[]): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 内层：{1: kind('asr'), 3: lang, 5: ''}，再整体 base64 一次塞进外层 field 2。 */
export function buildGetTranscriptParams(videoId: string, lang: string, kind = 'asr'): string {
  const inner = [...pbString(0x0a, kind), ...pbString(0x1a, lang), ...pbString(0x2a, '')];
  const outer = [
    ...pbString(0x0a, videoId),
    // field 2 的值是「内层 protobuf 的 base64 字符串」，注意是 string 不是 bytes
    ...pbString(0x12, toBase64(inner)),
  ];
  return toBase64(outer);
}

const DEFAULT_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

let lastDiagnostic = '';

/** 最近一次直连的结果/失败原因（错误卡片里直接显示）。 */
export function getGetTranscriptDiagnostic(): string {
  return lastDiagnostic;
}

interface ClientContext {
  name: string;
  context: Record<string, unknown>;
  apiKey: string;
}

interface InnertubeConfig {
  INNERTUBE_CONTEXT?: Record<string, unknown>;
  INNERTUBE_API_KEY?: string;
  INNERTUBE_CLIENT_VERSION?: string;
}

/**
 * YouTube 把当前视频的字幕参数直接写进了页面数据 / HTML：
 *   "getTranscriptEndpoint":{"params":"<base64>"}
 * 用它自己的 params 请求，就不会因为我拼的 protobuf 不对而 400。
 */
export function findTranscriptParamsInHtml(html: string): string[] {
  const out: string[] = [];
  const re = /"getTranscriptEndpoint"\s*:\s*\{[^{}]*?"params"\s*:\s*"([^"\\]+)"/gu;
  for (const match of html.matchAll(re)) {
    const value = match[1]?.replace(/\\u0026/gu, '&').replace(/\\u003d/gu, '=');
    if (value && value.length > 20 && !out.includes(value)) out.push(value);
  }
  return out;
}

/** 递归找页面 JS 对象里的 getTranscriptEndpoint.params（ytInitialData 里常见）。 */
function findParamsInObject(value: unknown, budget = { left: 20000 }): string[] {
  const found: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0 && budget.left-- > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    const endpoint = record.getTranscriptEndpoint as Record<string, unknown> | undefined;
    if (typeof endpoint?.params === 'string' && endpoint.params.length > 20) found.push(endpoint.params);
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return found;
}

function collectRealParams(win: Window): string[] {
  const scope = win as unknown as {
    ytInitialData?: unknown;
    ytInitialPlayerResponse?: unknown;
    ytcfg?: { data_?: () => unknown };
    document?: Document;
  };
  const found: string[] = [];
  try {
    for (const source of [scope.ytInitialData, scope.ytInitialPlayerResponse]) {
      found.push(...findParamsInObject(source));
    }
    if (typeof scope.ytcfg?.data_ === 'function') found.push(...findParamsInObject(scope.ytcfg.data_()));
  } catch {
    /* 页面对象不可读 */
  }
  try {
    const html = scope.document?.documentElement?.innerHTML ?? '';
    if (html) found.push(...findTranscriptParamsInHtml(html));
  } catch {
    /* 取不到 HTML */
  }
  return [...new Set(found)];
}

/**
 * 不能只依赖页面 ytcfg：2026 版某些页面/世界里它读不到（诊断里出现过 0ms 空退）。
 * 页面上下文优先，再补三个静态客户端上下文（WEB / ANDROID / TVHTML5），
 * 有些客户端不强制 POT，get_transcript 会照常返回。
 */
function clientContexts(win: Window): ClientContext[] {
  const out: ClientContext[] = [];
  const ytcfg = (win as unknown as { ytcfg?: { data_?: () => InnertubeConfig; get_?: (key: string) => unknown } })
    .ytcfg;

  try {
    const data = typeof ytcfg?.data_ === 'function' ? ytcfg.data_() : null;
    const context = data?.INNERTUBE_CONTEXT;
    if (context) {
      out.push({ name: 'page', context, apiKey: data?.INNERTUBE_API_KEY ?? DEFAULT_API_KEY });
    } else if (typeof ytcfg?.get_ === 'function') {
      const ctx = ytcfg.get_('INNERTUBE_CONTEXT') as Record<string, unknown> | undefined;
      if (ctx) {
        out.push({
          name: 'page',
          context: ctx,
          apiKey: (ytcfg.get_('INNERTUBE_API_KEY') as string | undefined) ?? DEFAULT_API_KEY,
        });
      }
    }
  } catch {
    /* ytcfg 不可读，继续用静态上下文 */
  }

  const version =
    (ytcfg && typeof ytcfg.get_ === 'function' ? (ytcfg.get_('INNERTUBE_CLIENT_VERSION') as string) : null) ??
    '2.20250312.04.00';

  out.push({
    name: 'WEB',
    apiKey: DEFAULT_API_KEY,
    context: { client: { clientName: 'WEB', clientVersion: version, hl: 'en', gl: 'US' } },
  });
  out.push({
    name: 'ANDROID',
    apiKey: DEFAULT_API_KEY,
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 30,
        hl: 'en',
        gl: 'US',
      },
    },
  });
  out.push({
    name: 'TVHTML5',
    apiKey: DEFAULT_API_KEY,
    context: { client: { clientName: 'TVHTML5', clientVersion: '7.20250312.18.00', hl: 'en', gl: 'US' } },
  });

  return out;
}

export interface GetTranscriptOutcome {
  lines: { start: number; dur: number; text: string }[];
  lang: string;
  params: string;
  via: string;
}

export interface GetTranscriptOptions {
  win: Window;
  fetchFn: typeof fetch;
  videoId: string;
  langs: string[];
  signal: AbortSignal;
  /** 整体时限与尝试上限：主路径不能因为排列组合把用户卡住十几秒 */
  timeoutMs?: number;
  maxAttempts?: number;
}

/**
 * 逐个（客户端 × 语言 × params 变体）尝试，直到拿到非空行。
 * 全部失败时抛出带原因的 Error —— 由兜底链记进「诊断」，不再静默返回 null（0ms 无信息）。
 */
export async function fetchGetTranscript(options: GetTranscriptOptions): Promise<GetTranscriptOutcome | null> {
  const { win, fetchFn, videoId, langs, signal } = options;
  const deadline = Date.now() + (options.timeoutMs ?? 8_000);
  const maxAttempts = options.maxAttempts ?? 12;
  const clients = clientContexts(win);
  const reasons: string[] = [];
  let attempts = 0;

  // 页面自带的 params 排在最前：它是 YouTube 为这个视频生成的，编码一定正确
  const realParams = collectRealParams(win);
  const generated: { value: string; lang: string }[] = [];
  for (const lang of langs.length > 0 ? langs : ['en']) {
    const params = buildGetTranscriptParams(videoId, lang);
    generated.push(
      { value: params, lang },
      { value: params.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, ''), lang },
    );
  }
  const paramList = [
    ...realParams.map((value) => ({ value, label: 'page-params', lang: '' })),
    ...generated.map(({ value, lang }) => ({ value, label: 'generated', lang })),
  ];

  for (const client of clients) {
    const url = `https://www.youtube.com/youtubei/v1/get_transcript?key=${client.apiKey}&prettyPrint=false`;
    for (const { value: params, label, lang } of paramList) {
      // 主路径必须快：超时/超次数就停，剩下的交给兜底层
      if (signal.aborted || attempts >= maxAttempts || Date.now() > deadline) {
        if (reasons.length === 0) reasons.push(`${client.name}: 超时或达到尝试上限`);
        break;
      }
      attempts += 1;
        try {
          const response = await fetchFn(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ context: client.context, params }),
            signal,
          });
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            const hint = body.replace(/\s+/gu, ' ').slice(0, 60);
            reasons.push(`${client.name}/${label}: HTTP ${response.status}${hint ? ` (${hint})` : ''}`);
            continue;
          }
          const text = await response.text();
          const lines = parseGetTranscript(text);
          if (lines.length > 0) {
            lastDiagnostic = `get_transcript OK: ${client.name}/${label}, ${lines.length} 行`;
            // lang 必须是语言码，不能是 'page-params'/'generated' 这种来源标签
            return { lines, lang: lang || langs[0] || '', params, via: client.name };
          }
          reasons.push(`${client.name}/${label}: ${text.length ? 'no segments' : 'empty body'}`);
        } catch (error) {
          reasons.push(`${client.name}/${label}: ${String(error).slice(0, 40)}`);
        }
    }
  }

  lastDiagnostic = `get_transcript 失败: ${reasons.slice(0, 4).join(' | ')}`;
  throw new Error(lastDiagnostic);
}
