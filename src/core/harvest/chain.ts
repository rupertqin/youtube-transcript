import type { ErrorCode, FailureRecord, HarvestResult, Logger, SourceName, SourceOutcome } from '../types';

/**
 * 注入式依赖：core 不认识 chrome.*，也不假定自己在哪个 world。
 * 扩展端把 ①②④ 交给 MAIN world bridge，③ 留在 ISOLATED；
 * 油猴端三件事都在同一个进程里直接调。
 */
export interface HarvestDeps {
  /** ② playerResponse.captionTracks + ④ InnerTube 降级 */
  remote?: () => Promise<SourceOutcome | null>;
  /** ① 等待被动拦截到的 timedtext */
  intercept?: (timeoutMs: number) => Promise<SourceOutcome | null>;
  /** 打开原生 Show transcript 面板（与 ③ 共用同一次点击） */
  openPanel?: () => Promise<unknown> | unknown;
  /** 收掉原生面板；只要调过 openPanel 就一定会在结束时被调用（成功/失败/中断都算） */
  closePanel?: (panel: unknown) => void;
  /** ③ 从原生面板 DOM 抓取 */
  dom?: (panel: unknown) => Promise<SourceOutcome | null>;
  signal: AbortSignal;
  log: Logger;
  onStage?: (stage: SourceName | 'panel') => void;
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

const INTERCEPT_WAIT_MS = 3500;

function interrupted(signal: AbortSignal): HarvestError {
  const error = new HarvestError('UNKNOWN', []);
  error.message = 'aborted';
  Object.defineProperty(error, 'aborted', { value: signal.aborted });
  return error;
}

/**
 * 四层兜底：②播放器(+④InnerTube) → ①被动拦截 → ③原生面板 DOM。
 * 任一层拿到非空行即短路返回，每层失败都留一条分类记录。
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
        return outcome;
      }
      // 这一层没自报分类时补一条，保证最终错误码指向真正失败的那一层
      if (failures.length === before) {
        failures.push({ source: name, code: emptyCode, ms: Date.now() - started, detail: 'no lines' });
      }
      const reported = failures[failures.length - 1];
      deps.log({ code: reported?.code ?? emptyCode, source: name, ms: Date.now() - started, detail: 'empty' });
      return null;
    } catch (error) {
      const code: ErrorCode =
        error && typeof error === 'object' && 'code' in error
          ? ((error as { code: ErrorCode }).code ?? 'UNKNOWN')
          : 'NETWORK_ERROR';
      failures.push({ source: name, code, ms: Date.now() - started, detail: String(error) });
      deps.log({ code, source: name, ms: Date.now() - started, detail: String(error) });
      return null;
    }
  };

  // ② + ④
  if (deps.remote) {
    const remote = await step('player', 'NO_CAPTION_TRACK', deps.remote);
    if (remote) return { ...remote, failures };
  }

  // ① 与 ③ 共用同一次「打开原生面板」动作：先并发触发，再等拦截
  let panelPromise: Promise<unknown> = Promise.resolve(null);
  const willOpenPanel = Boolean(deps.openPanel);
  if (deps.openPanel) {
    deps.onStage?.('panel');
    panelPromise = Promise.resolve()
      .then(() => deps.openPanel!())
      .catch(() => null);
  }

  try {
    if (deps.intercept) {
      const intercepted = await step('intercept', 'EMPTY_200', () => deps.intercept!(INTERCEPT_WAIT_MS));
      if (intercepted) {
        await panelPromise;
        return { ...intercepted, failures };
      }
    }

    // ③
    if (deps.dom) {
      const panel = await panelPromise;
      const dom = await step('dom', 'SELECTOR_MISS', () => deps.dom!(panel));
      if (dom) return { ...dom, failures };
    }

    // DOM 等待的那几秒里，面板请求可能刚好被 hook 捕获 —— 最后白拿一次
    if (deps.intercept && !deps.signal.aborted) {
      const late = await deps.intercept(0).catch(() => null);
      if (late && late.lines.length > 0) {
        deps.log({ code: 'OK', source: 'intercept', ms: 0, meta: { lines: late.lines.length } });
        return { ...late, failures };
      }
    }

    const lastCode = failures.length > 0 ? failures[failures.length - 1].code : 'NO_CAPTION_TRACK';
    throw new HarvestError(lastCode, failures);
  } finally {
    // 原生面板只是抓取载体：成功、失败、被中断都要收掉，否则页面会同时挂着两套字幕 UI
    if (willOpenPanel && deps.closePanel) {
      try {
        deps.closePanel(await panelPromise);
      } catch {
        /* 关闭失败不影响结果 */
      }
    }
  }
}
