import { describe, expect, it } from 'vitest';
import { detectFormat, parseJson3, parseSrv, parseTimedText, parseVtt } from '../src/core/harvest/parse';
import {
  buildTimedTextUrl,
  classifyStatus,
  videoIdFromTimedTextUrl,
} from '../src/core/harvest/timedtext';
import { pickTrack } from '../src/core/harvest/player';
import { videoIdFromLocation } from '../src/core/harvest/intercept';
import { parseGetTranscript, videoIdFromGetTranscriptBody } from '../src/core/harvest/parse/transcript';

describe('json3 解析', () => {
  const raw = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { tStartMs: 1200, dDurationMs: 800, segs: [{ utf8: '\n' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '你好' }, { utf8: '世界' }] },
    ],
  });

  it('拼接 segs 并跳过换行事件', () => {
    const lines = parseJson3(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ start: 0, dur: 1200, text: 'Hello world' });
    expect(lines[1].text).toBe('你好世界');
  });

  it('拉丁词之间补空格、CJK 之间不补', () => {
    expect(parseJson3(raw)[0].text).toContain('Hello world');
    expect(parseJson3(raw)[1].text).toBe('你好世界');
  });
});

describe('srv 解析', () => {
  it('解析 srv1 的 <text start dur>', () => {
    const raw =
      '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
      '<text start="1.5" dur="2.25">Tom &amp; Jerry</text>' +
      '<text start="3.75" dur="1">第二行</text>' +
      '</transcript>';
    const lines = parseSrv(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ start: 1500, dur: 2250, text: 'Tom & Jerry' });
    expect(lines[1].start).toBe(3750);
  });

  it('解析 srv3 的 <p t d> 并剥掉内联标签', () => {
    const raw =
      '<timedtext format="3"><body>' +
      '<p t="500" d="1500"><s>Hello</s><s> there</s></p>' +
      '<p t="2000" d="1000">a<br/>b</p>' +
      '</body></timedtext>';
    const lines = parseSrv(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ start: 500, dur: 1500, text: 'Hello there' });
    expect(lines[1].text).toBe('a b');
  });
});

describe('vtt 解析', () => {
  it('跳过 header 并解析时间轴', () => {
    const raw = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.500',
      'First <b>cue</b>',
      '',
      '00:00:03.500 --> 00:00:05.000 align:start',
      'Second',
      '',
    ].join('\n');
    const lines = parseVtt(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ start: 1000, dur: 2500, text: 'First cue' });
    expect(lines[1].start).toBe(3500);
  });
});

describe('格式嗅探', () => {
  it('识别三种格式', () => {
    expect(detectFormat('{"events":[]}')).toBe('json3');
    expect(detectFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi')).toBe('vtt');
    expect(detectFormat('<transcript><text start="0">x</text></transcript>')).toBe('srv');
  });

  it('空内容返回空数组', () => {
    expect(parseTimedText('   ')).toEqual([]);
  });
});

describe('timedtext 请求与分类', () => {
  it('拼 fmt 参数且不破坏原有 signature', () => {
    const url = buildTimedTextUrl('https://www.youtube.com/api/timedtext?v=abc&lang=en&signature=xyz', 'json3');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('fmt')).toBe('json3');
    expect(parsed.searchParams.get('signature')).toBe('xyz');
    expect(parsed.searchParams.get('v')).toBe('abc');
  });

  it('从 URL 上取视频 id', () => {
    expect(videoIdFromTimedTextUrl('https://x/api/timedtext?v=dQw4w9WgXcQ&lang=en')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromTimedTextUrl('https://x/api/timedtext?lang=en')).toBeNull();
  });

  it('HTTP 状态映射到分类错误码', () => {
    expect(classifyStatus(429)).toBe('RATE_LIMITED');
    expect(classifyStatus(403)).toBe('POT_ENFORCED');
    expect(classifyStatus(404)).toBe('NO_CAPTION_TRACK');
    expect(classifyStatus(500)).toBe('NETWORK_ERROR');
    expect(classifyStatus(204)).toBe('UNKNOWN');
  });
});

describe('轨道选择', () => {
  const tracks = [
    { baseUrl: 'u1', languageCode: 'en', kind: 'asr', name: 'English (auto)' },
    { baseUrl: 'u2', languageCode: 'en', name: 'English' },
    { baseUrl: 'u3', languageCode: 'zh-Hans', name: '中文' },
  ];

  it('语言偏好优先', () => {
    expect(pickTrack(tracks, ['zh-Hans', 'en'])?.baseUrl).toBe('u3');
  });

  it('同语言下手动字幕优先于 ASR', () => {
    expect(pickTrack(tracks, ['en'])?.baseUrl).toBe('u2');
  });

  it('没有偏好时退回首个轨道', () => {
    expect(pickTrack(tracks, [])?.baseUrl).toBe('u2');
    expect(pickTrack([], ['en'])).toBeNull();
  });
});


describe('get_transcript（原生面板走的 InnerTube 接口）', () => {
  const payload = JSON.stringify({
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: [
                        {
                          transcriptSegmentRenderer: {
                            startMs: '1034000',
                            endMs: '1041000',
                            snippet: { runs: [{ text: "And it's " }, { text: 'clear we do' }] },
                          },
                        },
                        {
                          transcriptSegmentRenderer: {
                            startMs: '1041000',
                            endMs: '1043000',
                            snippet: { simpleText: 'second line' },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  });

  it('从结构化响应里取出带时间戳的行', () => {
    expect(parseGetTranscript(payload)).toEqual([
      { start: 1034000, dur: 7000, text: "And it's clear we do" },
      { start: 1041000, dur: 2000, text: 'second line' },
    ]);
  });

  it('按开始时间排序（面板可能倒着返回）', () => {
    const segment = (startMs: number, text: string) => ({
      transcriptSegmentRenderer: { startMs: String(startMs), endMs: String(startMs + 1000), snippet: { simpleText: text } },
    });
    const reversed = JSON.stringify({
      actions: [
        {
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                content: {
                  transcriptSearchPanelRenderer: {
                    body: {
                      transcriptSegmentListRenderer: {
                        initialSegments: [segment(9000, 'third'), segment(5000, 'second'), segment(1000, 'first')],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    });

    expect(parseGetTranscript(reversed).map((line) => line.text)).toEqual(['first', 'second', 'third']);
  });

  it('不认渲染器名字：换名 + 换时间戳字段名（startTimeMs）也能解析', () => {
    // 2026 的结构可能把 transcriptSegmentViewModel 换成别的名字、startMs 换成 startTimeMs。
    // 只按「有开始时间 + 有文字」判，响应 200 拿到了就不能解析成 0 行。
    const renamed = JSON.stringify({
      actions: [
        {
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                content: {
                  timelineItems: [
                    { timelineItemViewModel: { startTimeMs: '1000', endTimeMs: '2500', snippet: { content: 'first' } } },
                    { timelineItemViewModel: { startTimeMs: '2500', snippet: { runs: [{ text: 'sec' }, { text: 'ond' }] } } },
                  ],
                },
              },
            },
          },
        },
      ],
    });

    expect(parseGetTranscript(renamed)).toEqual([
      { start: 1000, dur: 1500, text: 'first' },
      { start: 2500, dur: 0, text: 'second' },
    ]);
  });

  it('2026 时间线面板：没有 startMs，只有 timestamp "0:03" 也能解析', () => {
    // 真实响应长这样（日志里「200 但 0 段」就是栽在这）：
    //   {"transcriptSegmentViewModel": {"simpleText": "…", "timestamp": "0:03", …}}
    // 毫秒只出现在 frameworkUpdates 的 sync 实体里，面板自己只有这种可读时间。
    const item = (timestamp: string | null, text: string, a11y?: string) => ({
      macroMarkersPanelItemViewModel: {
        item: {
          timelineItemViewModel: {
            ...(timestamp ? { timestamp } : {}),
            contentItems: [
              {
                transcriptSegmentViewModel: {
                  simpleText: text,
                  ...(timestamp ? { timestamp } : {}),
                  ...(a11y ? { timestampA11yLabel: a11y } : {}),
                },
              },
            ],
          },
        },
      },
    });
    const payload = JSON.stringify({
      content: {
        engagementPanelSectionListRenderer: {
          content: {
            sectionListRenderer: {
              contents: [
                {
                  itemSectionRenderer: {
                    contents: [
                      item('0:13', 'second'),
                      item('0:03', 'first'),
                      item(null, 'third', '1 minute, 30 seconds'),
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    // 按时间排序；没有显式结束时间就用「下一段不同起点」补 dur
    expect(parseGetTranscript(payload)).toEqual([
      { start: 3000, dur: 10000, text: 'first' },
      { start: 13000, dur: 77000, text: 'second' },
      { start: 90000, dur: 0, text: 'third' },
    ]);
  });

  it('空响应与坏 JSON 都返回空数组，不抛错', () => {
    expect(parseGetTranscript('')).toEqual([]);
    expect(parseGetTranscript('not json')).toEqual([]);
    expect(parseGetTranscript('{}')).toEqual([]);
  });

  it('videoId 在 POST body 里，不在 URL 上', () => {
    expect(videoIdFromGetTranscriptBody('{"videoId":"dQw4w9WgXcQ","params":"abc"}')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromGetTranscriptBody('params=abc')).toBeNull();
    expect(videoIdFromGetTranscriptBody(undefined)).toBeNull();
  });
});

describe('get_transcript 捕获的视频归属', () => {
  it('POST body 里没有 videoId，改从当前页 URL 取', () => {
    const win = (href: string) => ({ location: { href } }) as unknown as Window;
    expect(videoIdFromLocation(win('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s'))).toBe(
      'dQw4w9WgXcQ',
    );
    expect(videoIdFromLocation(win('https://www.youtube.com/shorts/dQw4w9WgXcQ'))).toBe(
      'dQw4w9WgXcQ',
    );
    expect(videoIdFromLocation(win('https://www.youtube.com/'))).toBeNull();
  });
});

/**
 * YouTube 正在把 `*Renderer` 迁移成 `*ViewModel`。
 * 解析器只认旧名字时，响应明明截到了却解析出 0 行 —— 链路里记成
 * 「拦截 no lines」，只能退到 DOM 读虚拟列表那一屏，前面的字幕全漏。
 */
describe('parseGetTranscript：响应结构改名后仍要解析出字幕', () => {
  const wrap = (segments: unknown): string =>
    JSON.stringify({
      actions: [
        {
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                content: {
                  transcriptSearchPanelRenderer: {
                    body: { transcriptSegmentListRenderer: { initialSegments: segments } },
                  },
                },
              },
            },
          },
        },
      ],
    });

  it('transcriptSegmentViewModel（新命名）', () => {
    const rows = parseGetTranscript(
      wrap([
        {
          transcriptSegmentViewModel: {
            startMs: '0',
            endMs: '1500',
            snippet: { content: 'hello' },
          },
        },
        {
          transcriptSegmentViewModel: {
            startMs: '1500',
            endMs: '3000',
            snippet: { runs: [{ text: 'wor' }, { text: 'ld' }] },
          },
        },
      ]),
    );

    expect(rows).toEqual([
      { start: 0, dur: 1_500, text: 'hello' },
      { start: 1_500, dur: 1_500, text: 'world' },
    ]);
  });

  it('文字被挪到更深的容器里也能找到', () => {
    const rows = parseGetTranscript(
      wrap([
        {
          transcriptSegmentViewModel: {
            startMs: '2000',
            endMs: '3000',
            snippet: { content: { segmentText: { content: 'deep text' } } },
          },
        },
      ]),
    );

    expect(rows).toEqual([{ start: 2_000, dur: 1_000, text: 'deep text' }]);
  });

  it('没有时间戳的节点不当成字幕行（章节标题之类）', () => {
    const rows = parseGetTranscript(
      wrap([
        { transcriptSectionViewModel: { title: { content: 'Chapter 1' } } },
        {
          transcriptSegmentViewModel: {
            startMs: '0',
            endMs: '1000',
            snippet: { content: 'only this' },
          },
        },
      ]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('only this');
  });
});
