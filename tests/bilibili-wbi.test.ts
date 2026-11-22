import { describe, expect, it } from 'vitest';
import { md5 } from '../src/core/site/bilibili/md5';
import { keyFromUrl, mixinKey, signWbi } from '../src/core/site/bilibili/wbi';

/**
 * WBI 签名没有「大概对」这回事：错一位就是 -403。
 * 这里用 RFC 1321 的标准向量锁死 MD5，再用 node:crypto 算出的黄金串锁死 signWbi
 * —— 表或排序规则被改动时，这两条会立刻红。
 */
describe('md5（RFC 1321 标准向量）', () => {
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
  ])('md5(%s)', (input, expected) => {
    expect(md5(input)).toBe(expected);
  });

  it('跨块的输入也正确（>56 字节会多补一个块）', () => {
    expect(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
  });
});

describe('WBI 签名', () => {
  const IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
  const SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70acbd.png';

  it('keyFromUrl 去掉路径与扩展名', () => {
    expect(keyFromUrl(IMG)).toBe('7cd084941338484aae1ad9425b84077c');
    expect(keyFromUrl(SUB)).toBe('4932caff0ff746eab6f01bf08b70acbd');
  });

  it('mixinKey 按 64 位乱序表重排后取前 32 位', () => {
    expect(mixinKey(keyFromUrl(IMG), keyFromUrl(SUB))).toBe('ea1db124af3c7062474693fa704f4ff8');
  });

  it('固定输入复算固定签名', () => {
    expect(signWbi({ bvid: 'BV1xx411c7mD', cid: 12345 }, keyFromUrl(IMG), keyFromUrl(SUB), 1_700_000_000_000)).toBe(
      'bvid=BV1xx411c7mD&cid=12345&wts=1700000000&w_rid=2287c5697788a0f4dd4927baf674b081',
    );
  });

  it('参数按 key 排序，且 !\'()* 从值里清洗掉', () => {
    const signed = signWbi({ z: 1, a: "O'Neil!*" }, keyFromUrl(IMG), keyFromUrl(SUB), 1_700_000_000_000);
    // wts 也参与排序：key 顺序是 a < wts < z
    expect(signed.startsWith('a=ONeil&wts=1700000000&z=1&w_rid=')).toBe(true);
  });
});
