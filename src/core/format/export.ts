import type { ExportFormat, TranscriptLine } from '../types';

/** 时间戳：负值表示该行没有时间（DOM 抓取时时间戳被关掉）。 */
export function formatTimestamp(ms: number, withHours?: boolean): string {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0 || withHours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function srtTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3600000);
  const minutes = Math.floor((safe % 3600000) / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export interface ExportMeta {
  title: string;
  videoId: string;
  url: string;
  lang?: string | null;
  source?: string | null;
}

export function toPlainText(lines: TranscriptLine[], options: { timestamps: boolean }): string {
  return lines
    .map((line) => (options.timestamps && line.start >= 0 ? `${formatTimestamp(line.start)} ${line.text}` : line.text))
    .join('\n');
}

export function toMarkdown(lines: TranscriptLine[], meta: ExportMeta): string {
  const header = [
    `# ${meta.title || 'Transcript'}`,
    '',
    `- Video: ${meta.url}`,
    `- Language: ${meta.lang ?? 'unknown'}`,
    `- Source: ${meta.source ?? 'unknown'}`,
    `- Lines: ${lines.length}`,
    '',
    '---',
    '',
  ].join('\n');
  const body = lines
    .map((line) => (line.start >= 0 ? `**[${formatTimestamp(line.start)}]** ${line.text}` : line.text))
    .join('\n\n');
  return `${header}${body}\n`;
}

export function toSrt(lines: TranscriptLine[]): string {
  return lines
    .map((line, index) => {
      const start = line.start >= 0 ? line.start : 0;
      const next = lines[index + 1];
      const fallbackEnd = next && next.start > start ? next.start : start + 3000;
      const end = line.dur > 0 ? start + line.dur : fallbackEnd;
      return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${line.text}\n`;
    })
    .join('\n');
}

export function toJson(lines: TranscriptLine[], meta: ExportMeta): string {
  return JSON.stringify({ ...meta, lines }, null, 2);
}

export function buildExport(format: ExportFormat, lines: TranscriptLine[], meta: ExportMeta, timestamps: boolean): string {
  if (format === 'txt') return toPlainText(lines, { timestamps });
  if (format === 'md') return toMarkdown(lines, meta);
  if (format === 'srt') return toSrt(lines);
  return toJson(lines, meta);
}

export function fileExtension(format: ExportFormat): string {
  return format === 'md' ? 'md' : format === 'json' ? 'json' : format === 'srt' ? 'srt' : 'txt';
}

export function mimeFor(format: ExportFormat): string {
  if (format === 'json') return 'application/json';
  if (format === 'md') return 'text/markdown';
  if (format === 'srt') return 'application/x-subrip';
  return 'text/plain';
}

export function slugifyTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/gu, ' ')
    .replace(/\s+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return cleaned || 'transcript';
}

/** 1000+ 行的字幕在 SRT/JSON 里体积可观，导出前先给个可读的体量提示。 */
export function estimateBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
