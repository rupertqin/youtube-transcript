import type { LegacyV19 } from '../../legacy/contract';

export interface LegacyCopyResult {
  ok: boolean;
  lines: number;
  chars: number;
}

/**
 * 直接调用整份内联的原版 v1.9 运行时（__yttLegacyV19）。
 *
 * 注意：这里**不挂钩、不拦截、不改写** `copy-transcript-btn` 的 onclick。
 * 那个按钮由逐字节的 verbatim-runtime.js 自己注入、自己处理，
 * 任何捕获阶段的接管都会改变原版行为 —— 不要动原版的东西。
 * 2026 面板兼容逻辑修在 user-script.js 内部函数里，这里无需改动。
 */
export async function copyTranscriptLegacy(_doc: Document): Promise<LegacyCopyResult> {
  const legacy = globalThis.__yttLegacyV19 as LegacyV19 | undefined;
  if (!legacy) return { ok: false, lines: 0, chars: 0 };

  const panel = await legacy.openTranscriptPanel();
  if (!panel) return { ok: false, lines: 0, chars: 0 };
  const result = await legacy.extractTranscript(panel);
  if (!result.text) return { ok: false, lines: 0, chars: 0 };

  const ok = await legacy.copyToClipboard(result.text);
  return {
    ok,
    lines: result.text.split('\n').filter(Boolean).length,
    chars: result.text.length,
  };
}
