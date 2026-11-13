/** 轨道语言偏好：先跟随浏览器，再兜中文/英文，最后才用首条可用轨道。 */
export function defaultLangs(): string[] {
  const nav =
    typeof navigator !== 'undefined'
      ? navigator.languages?.length
        ? [...navigator.languages]
        : [navigator.language]
      : [];
  const picked = [...nav.slice(0, 2), 'zh-Hans', 'zh', 'en'].filter(Boolean) as string[];
  return [...new Set(picked)];
}

/**
 * 用户想读哪种语言的字幕。
 *
 * auto = 同音频：不做翻译，用视频自己的字幕轨道（原来看的就是这个）。
 * 另外两个是显式选择：优先原生轨道，没有就让 YouTube 机器翻译（tlang）。
 */
export type LangChoice = 'auto' | 'zh' | 'en';

export const LANG_CHOICES: LangChoice[] = ['auto', 'zh', 'en'];

export const LANG_LABEL: Record<LangChoice, string> = {
  auto: '同音频',
  zh: '中文',
  en: 'English',
};

export interface LangPlan {
  /** 原生轨道的偏好顺序；前几项决定「有没有现成的」，最后一项是兜底原文 */
  langs: string[];
  /** 需要机器翻译成的语言；null = 不翻译 */
  tlang: string | null;
}

/**
 * 把用户选择翻译成「按什么顺序挑轨道 + 是否要翻译」。
 *
 * 注意 zh/en 的 langs 里都把目标语言排在前面：只要视频本身有该语言的字幕，
 * 就走原生轨道，不用机器翻译（质量更好）；没有才回落到 tlang。
 */
export function resolveLangPlan(choice: LangChoice): LangPlan {
  if (choice === 'zh') {
    return { langs: ['zh-Hans', 'zh-Hant', 'zh', 'zh-CN', 'zh-TW', 'en'], tlang: 'zh-Hans' };
  }
  if (choice === 'en') {
    return { langs: ['en'], tlang: 'en' };
  }
  return { langs: defaultLangs(), tlang: null };
}

/**
 * 实际可用的语言选择。
 *
 * 偏好是全局的（记住你上次选了中文），但某条视频可能给不了中文。
 * 这时必须按「同音频」处理，否则按钮显示未选中、实际却在请求机翻，
 * 界面与行为不一致。available 为空表示还没读到轨道信息，此时不擅自降级。
 */
export function pickUsableChoice(choice: LangChoice, available: readonly string[]): LangChoice {
  if (choice === 'auto' || available.length === 0) return choice;
  return available.some((code) => langMatches(code, choice)) ? choice : 'auto';
}

/** 轨道语言是否已满足目标（按主语言比较：zh-Hant 也算中文）。 */
export function langMatches(code: string | null | undefined, target: string | null | undefined): boolean {
  if (!code || !target) return false;
  const a = code.toLowerCase();
  const b = target.toLowerCase();
  return a === b || a.split('-')[0] === b.split('-')[0];
}
