import { describe, expect, it } from 'vitest';
import { getDomDiagnostic, readDomPreview } from '../src/core/dom/native-panel';
import { contentSignature } from '../src/core/format/fingerprint';
import type { TranscriptLine } from '../src/core/types';

/**
 * DOM 层现在是「一次同步扫描已渲染文字」的预览，不承担取全量字幕的职责：
 * 不点击 Show transcript、不轮询 12 轮、不滚 60 屏虚拟列表。
 * 虚拟列表只渲染视口，这份结果天生不完整，只能临时显示。
 */

function makeDoc(innerText: string, playerId = 'AAAAAAAAAAA'): Document {
  const doc: Record<string, unknown> = {
    body: { innerText, textContent: innerText },
    querySelector: (selector: string) =>
      selector === '#movie_player' ? { getVideoData: () => ({ video_id: playerId }) } : null,
    querySelectorAll: () => [],
  };
  doc.defaultView = { document: doc };
  return doc as unknown as Document;
}

const TEXT = [
  '0:02 第一句',
  '0:06 第二句',
  '0:09 第三句',
  '0:13 第四句',
].join('\n');

const LINES: TranscriptLine[] = [
  { start: 2_000, dur: 0, text: '第一句' },
  { start: 6_000, dur: 0, text: '第二句' },
  { start: 9_000, dur: 0, text: '第三句' },
  { start: 13_000, dur: 0, text: '第四句' },
];

describe('readDomPreview：同步只读预览', () => {
  it('一次同步调用就返回已渲染的字幕行，不返回 Promise', () => {
    const result = readDomPreview(makeDoc(TEXT), { videoId: 'AAAAAAAAAAA' });

    expect(result).not.toBeInstanceOf(Promise);
    expect(result.lines).toHaveLength(4);
    expect(result.lines[0].text).toBe('第一句');
    expect(result.showTimestamps).toBe(true);
  });

  it('诊断明确写着没有点击任何按钮，也没有轮询/面板流程', () => {
    readDomPreview(makeDoc(TEXT), { videoId: 'AAAAAAAAAAA' });
    const diagnostic = getDomDiagnostic();

    expect(diagnostic).toContain('DOM 预览');
    expect(diagnostic).toContain('未点击任何按钮');
    expect(diagnostic).not.toContain('面板识别成功');
    expect(diagnostic).not.toContain('轮询');
    expect(diagnostic).not.toContain('打开原生面板');
  });

  it('刚切页时跳过页面现有文字，不把旧面板内容当预览', () => {
    const result = readDomPreview(makeDoc(TEXT), {
      videoId: 'AAAAAAAAAAA',
      skipSnapshot: true,
    });

    expect(result.lines).toHaveLength(0);
    expect(getDomDiagnostic()).toContain('跳过页面现有文字');
  });

  it('与上一条视频内容完全一致的快照被指纹闸门丢弃', () => {
    const result = readDomPreview(makeDoc(TEXT), {
      videoId: 'AAAAAAAAAAA',
      avoidSignature: contentSignature(LINES),
    });

    expect(result.lines).toHaveLength(0);
    expect(getDomDiagnostic()).toContain('丢弃与上一条视频相同的内容');
  });

  it('播放器仍停在别的视频时放弃预览', () => {
    const result = readDomPreview(makeDoc(TEXT, 'BBBBBBBBBBB'), { videoId: 'AAAAAAAAAAA' });

    expect(result.lines).toHaveLength(0);
    expect(getDomDiagnostic()).toContain('videoId mismatch');
  });

  it('页面上没有字幕文字时返回空结果，不去点开面板', () => {
    const result = readDomPreview(makeDoc('评论区\n暂无评论'), { videoId: 'AAAAAAAAAAA' });

    expect(result.lines).toHaveLength(0);
    expect(getDomDiagnostic()).not.toContain('打开原生面板');
  });
});
