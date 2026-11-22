import { describe, expect, it } from 'vitest';
import { createBilibiliSite } from '../src/core/site/bilibili';
import { capabilitiesOf, siteIdOf, SITE_IDS } from '../src/core/site/registry';
import { createYouTubeSite } from '../src/core/site/youtube';

const noop = () => undefined;
const fakeWin = (href: string) => ({ location: { href } }) as unknown as Window;
const fakeDoc = () => ({}) as Document;
const log = noop as unknown as Parameters<typeof createYouTubeSite>[0]['log'];

describe('站点识别', () => {
  it('按 host 识别两站', () => {
    expect(siteIdOf(new URL('https://www.youtube.com/watch?v=abc'))).toBe('youtube');
    expect(siteIdOf(new URL('https://www.bilibili.com/video/BV1xx411c7mD'))).toBe('bilibili');
  });

  it('未知站点返回 null（入口据此不注入任何按钮）', () => {
    expect(siteIdOf(new URL('https://example.com/watch?v=abc'))).toBeNull();
    // 只认后缀匹配，不能被骗
    expect(siteIdOf(new URL('https://evilyoutube.com/watch?v=abc'))).toBeNull();
  });

  it('能力表：B 站没有章节 / 缩略图 / 机翻', () => {
    expect(capabilitiesOf('youtube')).toMatchObject({ chapters: true, machineTranslate: true });
    expect(capabilitiesOf('bilibili')).toMatchObject({
      chapters: false,
      storyboard: false,
      machineTranslate: false,
      ccTrackSwitch: false,
    });
    // 状态还没初始化时按「全开」处理，避免把 YouTube 的按钮永久藏掉
    expect(capabilitiesOf('')).toEqual(capabilitiesOf('youtube'));
    expect(SITE_IDS).toEqual(['youtube', 'bilibili']);
  });
});

describe('YouTube adapter 的边界', () => {
  const site = createYouTubeSite({ win: fakeWin('https://www.youtube.com/'), doc: fakeDoc(), log });

  it('watch / shorts 都能解析出视频 id', () => {
    expect(site.videoIdOf({ href: 'https://www.youtube.com/watch?v=abc12345678' })).toBe('abc12345678');
    expect(site.videoIdOf({ href: 'https://www.youtube.com/shorts/xyz98765432' })).toBe('xyz98765432');
    expect(site.videoIdOf({ href: 'https://www.youtube.com/' })).toBeNull();
  });

  it('缓存命名空间与入口文案', () => {
    expect(site.cacheNamespace).toBe('youtube');
    expect(site.entryLabel).toBe('Transcript');
    expect(site.capabilities.chapters).toBe(true);
  });
});

describe('Bilibili adapter 的边界', () => {
  const site = createBilibiliSite({ win: fakeWin('https://www.bilibili.com/'), doc: fakeDoc(), log });

  it('videoIdOf 带分 P（否则第 2 P 会命中第 1 P 的缓存）', () => {
    expect(site.videoIdOf({ href: 'https://www.bilibili.com/video/BV1xx411c7mD' })).toBe('BV1xx411c7mD');
    expect(site.videoIdOf({ href: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2' })).toBe(
      'BV1xx411c7mD:p2',
    );
    expect(site.videoIdOf({ href: 'https://www.bilibili.com/' })).toBeNull();
  });

  it('没有章节与 storyboard，且语言计划里没有 tlang', () => {
    expect(site.chapters()).toEqual([]);
    expect(site.capabilities).toMatchObject({ chapters: false, storyboard: false });
    expect(site.langPlan().tlang).toBeNull();
    expect(site.cacheNamespace).toBe('bilibili');
    expect(site.entryLabel).toBe('字幕');
  });
});
