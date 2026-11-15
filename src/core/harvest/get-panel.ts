import type { ErrorCode, TranscriptLine } from '../types';
import { SELF_FETCH } from './intercept';
import { parseGetTranscript } from './parse/transcript';

/**
 * 直连 InnerTube `get_panel` 取字幕 —— 这是 2026 年原生字幕面板**唯一**的数据源。
 *
 * 以前的实现走 `get_transcript`，还加了一堆客户端/语言/编码变体去试，
 * 结果只是把「这个端点已经不吃我们的请求」发出的 400 刷满网络面板。
 * 现在就一条路：照原生请求原样发一次 `get_panel`。
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

/** 2026 年字幕面板的 panelId（原生 Show transcript 面板） */
const TRANSCRIPT_PANEL_ID = 'PAmodern_transcript_view';

/**
 * `get_panel` 的 params：protobuf `{149: {1: videoId, 3: 1}}`。
 *
 * 这是从真实请求里反推出来的（`qgkPCgtIWXJSWUNTUnhkRRgB` →
 * `aa 09 0f | 0a 0b HYrRYCSRxdE | 18 01`）：外层 field 149 装着
 * `{1: videoId, 3: 1}`。
 */
export function buildGetPanelParams(videoId: string): string {
  const inner = [...pbString(0x0a, videoId), ...varint(0x18), ...varint(1)];
  return toBase64(pbField((149 << 3) | 2, inner));
}

/**
 * 和原生请求**逐字一致**：URL 上只有 `prettyPrint=false`。
 *
 * 关键的一条：**不要 `?key=`**。原生这条请求用的是页面 cookie + SAPISIDHASH，
 * 带上项目 key 反而会被内塔判成 `400 Precondition check failed`（网络面板里
 * 带 key 的那几条全是红的，不带 key 的那条才是原生成功的那一次）。
 */
const GET_PANEL_URL = 'https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false';

let lastDiagnostic = '';
/** 200 但 0 段 ≠ 网络异常：区分开，错误卡片才不会指向代理。 */
let lastFailureCode: ErrorCode = 'UNKNOWN';

/** 最近一次直连的结果/失败原因（错误卡片里直接显示）。 */
export function getPanelDiagnostic(): string {
  return lastDiagnostic;
}

/** 最近一次失败的错误码（EMPTY_200 / NETWORK_ERROR / …）。 */
export function getPanelFailureCode(): ErrorCode {
  return lastFailureCode;
}

/**
 * YouTube **登录态**请求必须带 `Authorization: SAPISIDHASH …`。
 *
 * 格式：`<LABEL> <时间戳>_<sha1(时间戳 + ' ' + SAPISID + ' ' + origin)>`，
 * 三个变体分别用 `SAPISID` / `__Secure-1PAPISID` / `__Secure-3PAPISID`，
 * 空格拼在一起。没登录（拿不到 cookie）就返回空对象，退回匿名请求。
 */
async function authHeaders(win: Window): Promise<Record<string, string>> {
  const cookie = typeof win.document?.cookie === 'string' ? win.document.cookie : '';
  const pairs: [string, string][] = [
    ['SAPISIDHASH', 'SAPISID'],
    ['SAPISID1PHASH', '__Secure-1PAPISID'],
    ['SAPISID3PHASH', '__Secure-3PAPISID'],
  ];
  const origin = 'https://www.youtube.com';
  const timestamp = Math.floor(Date.now() / 1000);
  const parts: string[] = [];

  for (const [label, name] of pairs) {
    const value = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`, 'u').exec(cookie)?.[1];
    if (!value) continue;
    const digest = await sha1Hex(`${timestamp} ${decodeURIComponent(value)} ${origin}`);
    if (digest) parts.push(`${label} ${timestamp}_${digest}`);
  }
  if (parts.length === 0) return {};

  return {
    Authorization: parts.join(' '),
    'X-Goog-AuthUser': '0',
    'X-Youtube-Bootstrap-Logged-In': 'true',
  };
}

async function sha1Hex(input: string): Promise<string | null> {
  try {
    const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
    if (!subtle?.digest) return null;
    const digest = await subtle.digest('SHA-1', new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

interface InnertubeConfig {
  INNERTUBE_CONTEXT?: Record<string, unknown>;
  INNERTUBE_CLIENT_VERSION?: string;
}

interface PageClient {
  context: Record<string, unknown>;
  clientName: string;
  clientVersion?: string;
  visitorData?: string;
}

type Ytcfg = {
  data_?: () => InnertubeConfig;
  get_?: (key: string) => unknown;
};

function readYtcfg(win: Window): Ytcfg | undefined {
  try {
    return (win as unknown as { ytcfg?: Ytcfg }).ytcfg;
  } catch {
    return undefined;
  }
}

function readContextVisitorData(context: Record<string, unknown> | undefined): string | null {
  const client = context?.client as { visitorData?: string } | undefined;
  return typeof client?.visitorData === 'string' && client.visitorData ? client.visitorData : null;
}

function pickClientVersion(context: Record<string, unknown> | undefined): string | undefined {
  const client = context?.client as { clientVersion?: string } | undefined;
  return typeof client?.clientVersion === 'string' ? client.clientVersion : undefined;
}

/**
 * 用**页面自己的** INNERTUBE_CONTEXT —— 原生请求发的就是这个，
 * 换任何花哨的客户端（ANDROID / TVHTML5）都只是自找 400。
 *
 * 页面上下文读不到时才拼一个最小 WEB 上下文：那种情况下 cookie 也未必有，
 * 请求大概率失败，但至少只发一次，不刷屏。
 */
function pageClient(win: Window): PageClient {
  const ytcfg = readYtcfg(win);
  let context: Record<string, unknown> | undefined;
  try {
    const data = typeof ytcfg?.data_ === 'function' ? ytcfg.data_() : null;
    context = data?.INNERTUBE_CONTEXT;
    if (!context && typeof ytcfg?.get_ === 'function') {
      context = ytcfg.get_('INNERTUBE_CONTEXT') as Record<string, unknown> | undefined;
    }
  } catch {
    /* ytcfg 不可读，走最小上下文 */
  }

  const getValue = (key: string): string | undefined => {
    try {
      const value = typeof ytcfg?.get_ === 'function' ? ytcfg.get_(key) : undefined;
      return typeof value === 'string' && value ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const clientVersion =
    pickClientVersion(context) ?? getValue('INNERTUBE_CLIENT_VERSION') ?? '2.20250312.04.00';
  const visitorData = readContextVisitorData(context) ?? getValue('VISITOR_DATA');

  return {
    context:
      context ??
      ({
        client: {
          clientName: 'WEB',
          clientVersion,
          hl: 'en',
          gl: 'US',
          ...(visitorData ? { visitorData } : {}),
        },
      } as Record<string, unknown>),
    clientName: '1',
    clientVersion,
    visitorData,
  };
}

function innerTubeHeaders(
  client: PageClient,
  auth: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-origin': 'https://www.youtube.com',
    ...auth,
  };
  if (client.clientName) headers['X-Youtube-Client-Name'] = client.clientName;
  if (client.clientVersion) headers['X-Youtube-Client-Version'] = client.clientVersion;
  if (client.visitorData) headers['X-Goog-Visitor-Id'] = client.visitorData;
  return headers;
}

export interface PanelOutcome {
  lines: TranscriptLine[];
  /** 这条轨道的语言码；推不出来就是 null（绝不编造） */
  lang: string | null;
}

/**
 * `get_panel` 的 params 里没有语言位（实测：149 里 field 2 直接 400，
 * field 3/4~8 塞语言或轨道一律被忽略，`hl`/`gl` 也不影响），
 * 响应分段也不带语言码 —— 面板永远返回**视频默认轨道**。
 *
 * 所以语言只能从页面推断：用 `videoDetails.defaultAudioLanguage`。
 *
 * **不能用 `captionTracks[0]`**：多轨视频里第一条未必是默认轨
 * （实测 uxdh2lqc-1Y 的 captionTracks 第一条是 `ar`，面板实际给的是英文）。
 * 推不出来就返回 null —— 上层据此决定要不要走翻译，而不是瞎猜。
 */
function panelLang(win: Window): string | null {
  const scope = win as unknown as {
    ytInitialPlayerResponse?: { videoDetails?: { defaultAudioLanguage?: string } };
  };
  try {
    const audio = scope.ytInitialPlayerResponse?.videoDetails?.defaultAudioLanguage;
    if (typeof audio === 'string' && audio) return audio;
  } catch {
    /* 页面对象不可读 */
  }
  return null;
}

/**
 * 直连 `get_panel` 取字幕：**一次请求**，形状照抄原生成功的那条。
 *
 * page 上下文 + `X-Youtube-Client-Name/Version` + visitorData + SAPISIDHASH，
 * URL 不带 key，params 一律用 `buildGetPanelParams()`。
 *
 * 为什么不用页面 `getTranscriptEndpoint` 里那份 params —— 实测（同视频同 panelId）：
 *   - 自拼 `{149: {1: videoId, 3: 1}}`    → 200，116 KB，85 段；
 *   - 页面 `getTranscriptEndpoint.params` → 200，**960 字节，0 段**（只有 responseContext）。
 *
 * 页面那份是给「可搜索字幕面板」用的，形状不同，问 `get_panel` 只会得到空面板。
 * 以前的「两次请求，一次空一次满」就是拿它先试造成的：现在直接一次到位。
 */
export async function fetchGetPanel(options: {
  win: Window;
  fetchFn: typeof fetch;
  videoId: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<PanelOutcome | null> {
  const { win, fetchFn, videoId, signal } = options;
  const timeoutMs = options.timeoutMs ?? 6_000;
  const client = pageClient(win);
  const headers = innerTubeHeaders(client, await authHeaders(win));
  lastFailureCode = 'UNKNOWN';

  // 自己给自己兜一个超时：卡住一次请求就是卡住整条链，不能只靠调用方
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal.aborted) return null;
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);

  try {
    const init: RequestInit & Record<symbol, unknown> = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        context: client.context,
        user: { lockedSafetyMode: false },
        request: { useSsl: true, internalExperimentFlags: [], consistencyTokenJars: [] },
        panelId: TRANSCRIPT_PANEL_ID,
        params: buildGetPanelParams(videoId),
      }),
      signal: controller.signal,
    };
    // 自己发的请求不截：避免污染 hook 的捕获缓存
    init[SELF_FETCH] = true;
    const response = await fetchFn(GET_PANEL_URL, init);
    const status = typeof response?.status === 'number' ? response.status : 200;
    const text = await response.text();

    if (status >= 400) {
      lastFailureCode = status === 429 ? 'RATE_LIMITED' : 'UNKNOWN';
      lastDiagnostic = `get_panel 失败: HTTP ${status}`;
      return null;
    }

    const lines = parseGetTranscript(text);
    if (lines.length > 0) {
      const lang = panelLang(win);
      lastDiagnostic = `get_panel OK: ${lines.length} 行（${lang ?? '语言未知'}）`;
      return { lines, lang };
    }

    // 200 但解析不出分段：结构又变了 —— 把原始响应的头暴露出来，别让人瞎猜
    lastFailureCode = 'EMPTY_200';
    lastDiagnostic = `get_panel 失败: 200 但 0 段（${text.length} 字节）`;
    try {
      console.warn(
        '[ytt] get_panel 200 但 0 段，原始响应前 160 字符：',
        text.replace(/\s+/gu, ' ').slice(0, 160),
      );
    } catch {
      /* 没有 console 也不影响 */
    }
    return null;
  } catch (error) {
    lastFailureCode = 'NETWORK_ERROR';
    lastDiagnostic = `get_panel 失败: ${error instanceof Error ? error.message : String(error)}`;
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/**
 * 结构化解字幕：只有 `get_panel` 一条路，失败就把原因抛出去（由兜底链记进诊断）。
 *
 * 抛出的 Error 带 `code`：200 但 0 段是 `EMPTY_200`（不是网络异常），
 * 请求本身失败才是 `NETWORK_ERROR` —— 以前一律被兜底链记成网络异常，误导排查。
 */
export async function fetchPanelTranscript(options: {
  win: Window;
  fetchFn: typeof fetch;
  videoId: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<PanelOutcome> {
  const outcome = await fetchGetPanel(options);
  if (outcome && outcome.lines.length > 0) return outcome;
  const error = new Error(lastDiagnostic || 'get_panel: 无结果');
  Object.assign(error, { code: lastFailureCode });
  throw error;
}
