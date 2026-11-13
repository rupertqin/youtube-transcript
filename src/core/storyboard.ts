/**
 * 章节截图：YouTube 的 storyboard 雪碧图。
 *
 * playerResponse.storyboards.playerStoryboardSpecRenderer.spec 形如：
 *   https://i.ytimg.com/sb/<id>/storyboard3_L$L/$N.jpg?sqp=…|$M|48#27#100#10#10#0#default#sig|160#90#…|…
 *
 * `|` 分段：第 0 段是 URL 模板，其余每段是一个清晰度档位：
 *   <帧宽>#<帧高>#<总帧数>#<列数>#<行数>#<帧间隔ms>#<图集名>#<签名>
 * 模板里的 $L 换成档位序号、$N 换成图集名（图集名里的 $M 换成第几张图集）。
 *
 * 坑：URL 后面可能还跟着一个 **非档位段**（常见是 `$M` 这种签名占位）。
 * 段号不能直接当 $L 用，否则下标整体偏一位，请求到不存在的 L1/L2 图集
 * （图片 404、缩略图全空）。$L 必须是**在已解析出的档位里的序号**。
 *
 * 任何一步解析不出来就返回 null —— 宁可没有缩略图，也不能在章节行里
 * 放一张错位的图。
 */

export interface StoryboardFrame {
  url: string;
  /** 该帧在缩放后的图集里的偏移（px，负数） */
  offsetX: number;
  offsetY: number;
  /** 缩放后的整张图集尺寸 */
  sheetWidth: number;
  sheetHeight: number;
  /** 显示尺寸 */
  width: number;
  height: number;
}

interface Level {
  index: number;
  template: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  interval: number;
  name: string;
}

/** 多数视频的 spec 长这样，字段顺序与上面的注释一致。 */
function parseLevels(spec: string): Level[] {
  const parts = spec.split('|');
  if (parts.length < 2) return [];
  const template = parts[0];
  if (!template.includes('$L') || !template.includes('$N')) return [];

  const levels: Level[] = [];
  // index 只对**成功解析的档位**自增。spec 里 URL 后面可能挂着一个 `$M`
  // 之类的签名占位段，拿段号当 $L 会让所有档位偏一位、图片全 404。
  for (const part of parts.slice(1)) {
    const fields = part.split('#');
    // 有的响应的档位只有 6 段（缺 name/sigh），缺 name 就用 default
    if (fields.length < 6) continue;
    const [width, height, , cols, rows, interval] = fields.slice(0, 6).map(Number);
    if (![width, height, cols, rows].every((n) => Number.isFinite(n) && n > 0)) continue;
    if (!Number.isFinite(interval)) continue;
    levels.push({
      index: levels.length,
      template,
      width,
      height,
      cols,
      rows,
      interval,
      name: fields[6] || 'default',
    });
  }
  return levels;
}

/** 解析结果按 spec 字符串缓存：spec 一整个视频不变，不必每行重解析。 */
let cachedSpec: string | null = null;
let cachedLevels: Level[] = [];

function levelsFor(spec: string | null | undefined): Level[] {
  if (!spec) return [];
  if (spec === cachedSpec) return cachedLevels;
  cachedSpec = spec;
  cachedLevels = parseLevels(spec);
  return cachedLevels;
}

/** 显示用的缩略图宽度。行高由 16:9 推出，与真实帧比例一致。 */
const THUMB_WIDTH = 56;

/**
 * 取某个时间点的画面。
 * 只挑**有帧间隔**的档位（L0 那种 interval=0 的是整段海报，不能按时间定位），
 * 并在其中选最接近 THUMB_WIDTH 的一档，避免为大图付流量。
 */
export function frameAt(
  spec: string | null | undefined,
  ms: number,
  displayWidth = THUMB_WIDTH,
): StoryboardFrame | null {
  const usable = levelsFor(spec).filter((level) => level.interval > 0);
  if (usable.length === 0 || !Number.isFinite(ms) || ms < 0) return null;

  const level =
    [...usable].sort((a, b) => a.width - b.width).find((item) => item.width >= displayWidth) ??
    usable[usable.length - 1];

  const frameIndex = Math.floor(ms / level.interval);
  const perSheet = level.cols * level.rows;
  if (perSheet <= 0) return null;

  const sheet = Math.floor(frameIndex / perSheet);
  const within = frameIndex % perSheet;
  const col = within % level.cols;
  const row = Math.floor(within / level.cols);

  const sheetName = level.name.replace(/\$M/gu, String(sheet));
  const url = level.template.replace(/\$L/gu, String(level.index)).replace(/\$N/gu, sheetName);
  if (!/^https?:/u.test(url)) return null;

  // 等比缩放：宽度、高度、偏移必须用同一个 scale，否则裁出来的帧
  // 会和图集错开最多半行（56/80*45 = 31.5，四舍五入就漏出下一行）。
  const scale = displayWidth / level.width;
  return {
    url,
    // +0 把 -0 归一成 0，避免 background-position 出现 "-0px"
    offsetX: -col * level.width * scale + 0,
    offsetY: -row * level.height * scale + 0,
    sheetWidth: level.cols * level.width * scale,
    sheetHeight: level.rows * level.height * scale,
    width: displayWidth,
    height: level.height * scale,
  };
}
