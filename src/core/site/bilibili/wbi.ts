import { md5 } from './md5';

/**
 * WBI 签名。
 *
 * B 站从 2023 起把 `player` 等接口换成 wbi 签名：`wts` + 参数按 key 排序 +
 * 一个由 `img_url` / `sub_url` 拼出来的 mixin key，最后 `w_rid = md5(query+key)`。
 * 表是站点前端硬编码的 64 位乱序表，所有脚本都抄同一份。
 */
export const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** `https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png` → `7cd0…77c` */
export function keyFromUrl(url: string): string {
  const name = String(url).split('/').pop() ?? '';
  return name.replace(/\.[^.]*$/, '');
}

/** 两张 key 拼起来按表重排，取前 32 位。 */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let out = '';
  for (const index of MIXIN_KEY_ENC_TAB) out += raw[index] ?? '';
  return out.slice(0, 32);
}

/**
 * 生成 `k=v&…&w_rid=…`（已排序、已编码）。
 *
 * `now` 可注入，测试里才能对固定输入复算出固定签名。
 */
export function signWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  now: number = Date.now(),
): string {
  const key = mixinKey(imgKey, subKey);
  const withTs: Record<string, string | number> = { ...params, wts: Math.floor(now / 1000) };
  const query = Object.keys(withTs)
    .sort()
    .map((name) => {
      // B 站前端会把 !'()* 从值里去掉，签名与请求必须用同一套清洗规则
      const value = String(withTs[name]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + key)}`;
}
