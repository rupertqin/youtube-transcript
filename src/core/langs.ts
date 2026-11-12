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
