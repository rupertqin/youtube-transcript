import type {
  ErrorCode,
  FailureRecord,
  HarvestResult,
  Logger,
  SourceName,
  SourceOutcome,
  TranscriptLine,
} from '../types';

/**
 * 注入式依赖：core 不认识 chrome.*，也不假定自己在哪个 world。
 * 扩展端把结构化请求/远程交给 MAIN world bridge，DOM 预览留在 ISOLATED；
 * 油猴端全部在同一个进程里直接调。
 */
export interface HarvestDeps {
  /** ② playerResponse.captionTracks + ④ InnerTube 降级 */
  remote?: () => Promise<SourceOutcome | null>;
  /** ① 等待被动拦截到的 timedtext / get_transcript */
  intercept?: (timeoutMs: number) => Promise<SourceOutcome | null>;
  /** ⓪ 已经截获的响应（用户此前打开过原生面板时 0ms 命中） */
  cachedIntercept?: () => Promise<SourceOutcome | null>;
  /**
   * 结构化完整源：一次 `get_transcript` 请求拿回全部分段。
   *
   * 这是主路径。虚拟列表只渲染视口内的行，靠滚面板凑字幕既慢又会丢前段；
   * 结构化响应带精确 start/end，从 0:00 到片尾一次到手。
   */
  structured?: () => Promise<SourceOutcome | null>;
  /**
   * 同步读页面上**已经渲染**的字幕，只作临时预览（complete:false）。
   * 禁止点击、轮询、滚动 —— 一次同步扫描就返回，绝不短路完整源。
   */
  domPreview?: () => SourceOutcome | null | Promise<SourceOutcome | null>;
  /** 预览回传给会话层，先显示一点内容，完整结果到达后覆盖 */
  onPreview?: (lines: TranscriptLine[]) => void;
  /** 收起页面上残留的原生字幕面板；成功/失败/中断都会 await 一次 */
  closePanel?: () => Promise<unknown> | unknown;
  signal: AbortSignal;
  log: Logger;
  onStage?: (stage: SourceName | 'panel') => void;
  /**
   * 先把远程层排到最前面（要翻译、且视频没有该语言原生轨道时）。
   * 拦截层与 DOM 层只能给视频原文，先命中就会出现「切中文显示英文」。
   */
  preferRemote?: boolean;
}

export class HarvestError extends Error {
  readonly code: ErrorCode;
  readonly failures: FailureRecord[];

  constructor(code: ErrorCode, failures: FailureRecord[]) {
    super(`transcript harvest failed: ${code}`);
    this.name = 'HarvestError';
    this.code = code;
    this.failures = failures;
  }
}

const INTERCEPT_WAIT_MS = 2500;

function interrupted(signal: AbortSignal): HarvestError {
  const error = new HarvestError('UNKNOWN', []);
  error.message = 'aborted';
  Object.defineProperty(error, 'aborted', { value: signal.aborted });
  return error;
}

/**
 * 兜底链：**完整结构化源优先，DOM 只做同步预览**。
 *
 * 旧的「先开原生面板 → 12 轮轮询 → 60 屏滚动」既慢又只能拿到视口内的行，
 * 那份残缺结果还会被写进缓存 7 天，表现就是「前面的字幕不见了，
 * 点清空缓存重抓才拿到全部」。现在预览绝不进缓存、也绝不当最终结果。
 */
export async function harvestTranscript(deps: HarvestDeps): Promise<HarvestResult> {
  const failures: FailureRecord[] = [];
  const absorb = (outcome: SourceOutcome | null): void => {
    if (outcome?.failures?.length) failures.push(...outcome.failures);
  };

  const step = async (
    name: SourceName,
    emptyCode: ErrorCode,
    run: () => Promise<SourceOutcome | null>,
  ): Promise<SourceOutcome | null> => {
    if (deps.signal.aborted) throw interrupted(deps.signal);
    deps.onStage?.(name);
    const started = Date.now();
    try {
      const outcome = await run();
      const before = failures.length;
      absorb(outcome);
      if (outcome && outcome.lines.length > 0) {
        deps.log({
          code: 'OK',
          source: name,
          ms: Date.now() - started,
          meta: { lines: outcome.lines.length },
        });
        return { ...outcome, complete: outcome.complete !== false };
      }
      // 这一层没自报分类时补一条，保证最终错误码指向真正失败的那一层
      if (failures.length === before) {
        failures.push({ source: name, code: emptyCode, ms: Date.now() - started, detail: 'no lines' });
      }
      const reported = failures[failures.length - 1];
      deps.log({ code: reported?.code ?? emptyCode, source: name, ms: Date.now() - started, detail: 'empty' });
      return null;
    } catch (error) {
      if (deps.signal.aborted) throw interrupted(deps.signal);
      const code: ErrorCode =
        error && typeof error === 'object' && 'code' in error
          ? ((error as { code: ErrorCode }).code ?? 'UNKNOWN')
          : 'NETWORK_ERROR';
      failures.push({ source: name, code, ms: Date.now() - started, detail: String(error) });
      deps.log({ code, source: name, ms: Date.now() - started, detail: String(error) });
      return null;
    }
  };

  try {
    // ⓪ 明确要翻译时先问远程：它是唯一能产出目标语言的层。
    let remoteTried = false;
    if (deps.preferRemote && deps.remote) {
      remoteTried = true;
      const remote = await step('player', 'NO_CAPTION_TRACK', deps.remote);
      if (remote) return { ...remote, failures };
    }

    // ⓪.5 已截获的完整响应：0ms 命中，不等待、不记失败
    if (deps.cachedIntercept && !deps.signal.aborted) {
      const cached = await deps.cachedIntercept().catch(() => null);
      if (cached && cached.lines.length > 0) {
        deps.log({ code: 'OK', source: 'intercept', ms: 0, meta: { lines: cached.lines.length } });
        return { ...cached, complete: true, failures };
      }
    }

    // ① 同步预览：一次扫描已渲染的文字，先给用户看点东西。
    //    它只有视口内的行，**绝不短路**后面的完整源。
    if (deps.domPreview && !deps.signal.aborted) {
      const preview = await Promise.resolve(deps.domPreview()).catch(() => null);
      if (preview && preview.lines.length > 0 && !deps.signal.aborted) {
        deps.onPreview?.(preview.lines);
      }
    }

    // ② 结构化完整源：主路径，一次请求拿全部分段
    if (deps.structured) {
      const structured = await step('innertube', 'NO_CAPTION_TRACK', deps.structured);
      if (structured) return { ...structured, failures };
    }

    // ③ 被动拦截：等 YouTube 自己发出的字幕响应（短等，不再 3.5s 白等）
    if (deps.intercept) {
      const intercepted = await step('intercept', 'EMPTY_200', () => deps.intercept!(INTERCEPT_WAIT_MS));
      if (intercepted) return { ...intercepted, failures };
    }

    // ④ 远程（preferRemote 时已经跑过，不重复抓）
    if (deps.remote && !remoteTried) {
      const remote = await step('player', 'NO_CAPTION_TRACK', deps.remote);
      if (remote) return { ...remote, failures };
    }

    // 所有完整源都失败：不把预览留成「成功结果」，否则又变成缺前段的字幕
    const lastCode = failures.length > 0 ? failures[failures.length - 1].code : 'NO_CAPTION_TRACK';
    throw new HarvestError(lastCode, failures);
  } finally {
    // 页面上残留的原生面板（旧版本留下的、或用户自己点开的）一律收掉。
    // 必须 await：同步点一下经常赶不上 YouTube 的异步 DOM 更新。
    if (deps.closePanel) {
      try {
        await deps.closePanel();
      } catch {
        /* 收面板失败不影响抓取结果 */
      }
    }
  }
}
