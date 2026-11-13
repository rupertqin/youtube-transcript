import { describe, expect, it } from 'vitest';
import { isBlockedPayload, parseTimedText } from '../src/core/harvest/parse';
import { fetchTimedText } from '../src/core/harvest/timedtext';

/**
 * YouTube 的「异常流量」拦截页是 **HTTP 200 + HTML**。
 *
 * 以前没有这道判断：`parseSrv` 的 `<p>` 兜底会把提示整段当成一条字幕，
 * 面板里就出现
 *   "…your computer or network may be sending automated queries…"
 * 而且状态是 ready、来源显示「拦截」，看起来像是真字幕。
 */

const BLOCK_PAGE = `<!DOCTYPE html><html lang="en"><head><title>Before you continue</title></head>
<body><div><p>Our systems have detected unusual traffic from your computer network.
This page checks to see if it's really you sending the requests, and not a robot.</p>
<p>… but your computer or network may be sending automated queries.
To protect our users, we can't process your request right now.</p></div></body></html>`;

const REAL_SRV =
  '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
  '<text start="1.2" dur="3.4">hello</text><text start="5" dur="2">world</text></transcript>';

const REAL_SRV3 =
  '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>' +
  '<p t="1200" d="3400"><s>hello</s></p></body></timedtext>';

describe('isBlockedPayload', () => {
  it('识别人机校验页', () => {
    expect(isBlockedPayload(BLOCK_PAGE)).toBe(true);
    expect(isBlockedPayload('<html>unusual traffic</html>')).toBe(true);
  });

  it('真字幕不会被误判', () => {
    expect(isBlockedPayload(REAL_SRV)).toBe(false);
    expect(isBlockedPayload('{"events":[{"tStartMs":0,"segs":[{"utf8":"hi"}]}]}')).toBe(false);
  });
});

describe('parseTimedText 不接受异常页面', () => {
  it('拦截页解析出 0 行（不是 1 行提示语）', () => {
    expect(parseTimedText(BLOCK_PAGE)).toEqual([]);
  });

  it('普通 HTML（没有字幕标签）也解析出 0 行', () => {
    expect(parseTimedText('<html><body><p>评论区</p></body></html>')).toEqual([]);
  });

  it('真正的 srv / srv3 仍能解析', () => {
    expect(parseTimedText(REAL_SRV).map((l) => l.text)).toEqual(['hello', 'world']);
    expect(parseTimedText(REAL_SRV3).map((l) => l.text)).toEqual(['hello']);
  });

  it('以 { 开头但没有 events 的内容不算 json3', () => {
    expect(parseTimedText('{"error":"nope"}')).toEqual([]);
  });
});

describe('fetchTimedText 把拦截页当失败', () => {
  const respond = (body: string, status = 200) =>
    (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      }) as unknown as Response) as unknown as typeof fetch;

  it('200 + 拦截页 → RATE_LIMITED，0 行', async () => {
    const outcome = await fetchTimedText(
      respond(BLOCK_PAGE),
      'https://www.youtube.com/api/timedtext?v=abc&lang=en',
      'srv1',
      new AbortController().signal,
    );
    expect(outcome.lines).toEqual([]);
    expect(outcome.code).toBe('RATE_LIMITED');
  });

  it('正常字幕不受影响', async () => {
    const outcome = await fetchTimedText(
      respond(REAL_SRV),
      'https://www.youtube.com/api/timedtext?v=abc&lang=en',
      'srv1',
      new AbortController().signal,
    );
    expect(outcome.lines.length).toBe(2);
    expect(outcome.code).toBeUndefined();
  });
});
