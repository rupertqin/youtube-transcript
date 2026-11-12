import type { CaptionTrack, FailureRecord } from '../types';
import { readCaptionTracks, readInnertubeConfig } from './player';

interface ProbeClient {
  label: string;
  clientName: string;
  clientVersion: string;
  extraContext?: Record<string, unknown>;
}

/**
 * 逐级降级的 InnerTube 客户端。ANDROID 的签名 caption URL 目前不强制 POT，
 * TVHTML5 嵌入客户端是更长尾的兜底。
 */
const CLIENTS: ProbeClient[] = [
  {
    label: 'ANDROID',
    clientName: 'ANDROID',
    clientVersion: '19.44.38',
    extraContext: { androidSdkVersion: 30 },
  },
  {
    label: 'TVHTML5_EMBED',
    clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    clientVersion: '2.0',
    extraContext: {
      thirdParty: { embedUrl: 'https://www.youtube.com/' },
    },
  },
];

const CLIENT_HEADER_ID: Record<string, string> = {
  ANDROID: '3',
  TVHTML5_SIMPLY_EMBEDDED_PLAYER: '85',
};

export interface InnertubeOutcome {
  tracks: CaptionTrack[];
  failures: FailureRecord[];
  detail?: string;
}

interface InnertubeResponse {
  captions?: unknown;
  playabilityStatus?: { status?: string; reason?: string };
}

async function requestPlayer(
  win: Window,
  fetchFn: typeof fetch,
  client: ProbeClient,
  videoId: string,
  signal: AbortSignal,
): Promise<InnertubeResponse | null> {
  const config = readInnertubeConfig(win);
  const url = new URL('/youtubei/v1/player', win.location.origin);
  url.searchParams.set('prettyPrint', 'false');
  if (config.key) url.searchParams.set('key', config.key);

  const body = {
    context: {
      client: {
        clientName: client.clientName,
        clientVersion: config.clientVersion && client.clientName === 'WEB'
          ? config.clientVersion
          : client.clientVersion,
        hl: 'en',
        gl: 'US',
        ...client.extraContext,
      },
      user: {
        lockedSafetyMode: false,
        ...(config.visitorData ? { visitorData: config.visitorData } : {}),
      },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };

  const response = await fetchFn(url.toString(), {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: {
      'content-type': 'application/json',
      'X-Youtube-Client-Name': CLIENT_HEADER_ID[client.clientName] ?? '1',
      'X-Youtube-Client-Version': client.clientVersion,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) return null;
  return (await response.json()) as InnertubeResponse;
}

export async function probeInnertube(
  win: Window,
  videoId: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = (input, init) => win.fetch(input, init),
): Promise<InnertubeOutcome> {
  const failures: FailureRecord[] = [];

  for (const client of CLIENTS) {
    if (signal.aborted) break;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const payload = await requestPlayer(win, fetchFn, client, videoId, controller.signal);
      const tracks = readCaptionTracks(payload as never);
      if (tracks.length > 0) {
        return { tracks, failures, detail: client.label };
      }
      failures.push({
        source: 'innertube',
        code: 'NO_CAPTION_TRACK',
        ms: Date.now() - started,
        detail: `${client.label}: no captionTracks`,
      });
    } catch (error) {
      failures.push({
        source: 'innertube',
        code: 'NETWORK_ERROR',
        ms: Date.now() - started,
        detail: `${client.label}: ${String(error)}`,
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  return { tracks: [], failures };
}
