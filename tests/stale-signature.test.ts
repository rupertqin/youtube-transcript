import { describe, expect, it } from 'vitest';
import { extractFromNativePanel, getDomDiagnostic } from '../src/core/dom/native-panel';
import { contentSignature } from '../src/core/format/fingerprint';
import type { TranscriptLine } from '../src/core/types';

/**
 * SPA 站内跳转后「新视频配上一条视频字幕」的回归测试。
 *
 * 真实场景：YouTube 不会销毁已经展开的原生字幕面板，切页后播放器已经是新视频、
 * 面板里还是旧行。所有基于 videoId 的校验都会放行（id 完全对得上），
 * 唯一能判的是内容本身 —— 所以用「切换前的内容指纹」做闸门。
 */

function docWithText(innerText: string, playerId: string): Document {
  const doc = {
    body: { innerText, textContent: innerText },
    querySelector: (selector: string) =>
      selector === '#movie_player' ? { getVideoData: () => ({ video_id: playerId }) } : null,
    querySelectorAll: () => [],
  } as unknown as Record<string, unknown>;

  // readPlayerVideoId 只要求 win.document
  doc.defaultView = { document: doc };
  return doc as unknown as Document;
}

const OLD_TEXT = [
  '0:02 上一条视频的第一句',
  '0:06 上一条视频的第二句',
  '0:09 上一条视频的第三句',
  '0:13 上一条视频的第四句',
].join('\n');

const OLD_LINES: TranscriptLine[] = [
  { start: 2000, dur: 0, text: '上一条视频的第一句' },
  { start: 6000, dur: 0, text: '上一条视频的第二句' },
  { start: 9000, dur: 0, text: '上一条视频的第三句' },
  { start: 13_000, dur: 0, text: '上一条视频的第四句' },
];

const NEW_TEXT = [
  '0:03 新视频完全不同的第一句',
  '0:07 新视频完全不同的第二句',
  '0:11 新视频完全不同的第三句',
  '0:15 新视频完全不同的第四句',
].join('\n');

describe('内容指纹', () => {
  it('同样的内容，文字里有没有时间码/无障碍时长都算出同一个指纹', () => {
    const a = contentSignature([{ start: 2006_000, text: '33 minutes, 26 seconds 正文内容' }]);
    const b = contentSignature([{ start: 2006_000, text: '正文内容' }]);
    expect(a).toBe(b);
  });

  it('忽略大小写与空白差异', () => {
    expect(contentSignature([{ start: 0, text: 'Hello  World' }])).toBe(
      contentSignature([{ start: 0, text: 'hello world' }]),
    );
  });

  it('不同内容指纹不同；空内容返回空串', () => {
    expect(contentSignature(OLD_LINES)).not.toBe(contentSignature([{ start: 0, text: '别的内容' }]));
    expect(contentSignature([])).toBe('');
  });
});

describe('切页后 DOM 层的旧内容闸门', () => {
  it('与上一条视频完全一致的内容被丢弃，不会当成新视频的字幕', async () => {
    const doc = docWithText(OLD_TEXT, 'BBBBBBBBBBB');
    const result = await extractFromNativePanel(doc, {
      videoId: 'BBBBBBBBBBB',
      avoidSignature: contentSignature(OLD_LINES),
    });

    expect(result.lines).toHaveLength(0);
    expect(getDomDiagnostic()).toContain('丢弃与上一条视频相同的内容');
  });

  it('内容确实换新时照常返回，不被闸门误杀', async () => {
    const doc = docWithText(NEW_TEXT, 'BBBBBBBBBBB');
    const result = await extractFromNativePanel(doc, {
      videoId: 'BBBBBBBBBBB',
      avoidSignature: contentSignature(OLD_LINES),
    });

    expect(result.lines).toHaveLength(4);
    expect(result.lines[0].text).toBe('新视频完全不同的第一句');
    expect(getDomDiagnostic()).not.toContain('丢弃与上一条视频相同的内容');
  });

  it('没有指纹（首屏、或上一条没有内容）时不拦截', async () => {
    const doc = docWithText(OLD_TEXT, 'BBBBBBBBBBB');
    const result = await extractFromNativePanel(doc, { videoId: 'BBBBBBBBBBB' });

    expect(result.lines).toHaveLength(4);
  });
});
