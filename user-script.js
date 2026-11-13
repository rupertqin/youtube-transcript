// ==UserScript==
// @name         YouTube Transcript Extractor
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Extracts YouTube transcripts to the clipboard
// @author       Programazing
// @match        https://www.youtube.com/watch?v=*
// @grant        none
// ==/UserScript==


(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * 选择器集中管理：YouTube 的 DOM 命名在 A/B 环境里并不统一，
     * 同时保留 old(#id) / new(.class) 两种写法。
     * ------------------------------------------------------------------ */
    const SEL = {
        mastheadEnd: 'ytd-masthead #end',
        panels: [
            'ytd-transcript-search-panel-renderer',
            'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-transcript"]',
            '[role="dialog"] ytd-transcript-segment-list-renderer',
            // ---- 2026 兼容：只加选择器，原三条一条不动 ----
            // 字幕面板改名 PAmodern_transcript_view；当前展开的那块 target-id 甚至是空的。
            'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
            'ytd-engagement-panel-section-list-renderer[visibility*="EXPANDED"]',
            'yt-engagement-panel-section-list-view-model'
        ].join(','),
        list: 'ytd-transcript-segment-list-renderer',
        segOld: 'ytd-transcript-segment-renderer, .ytd-transcript-segment-renderer',
        segNew: 'yt-transcript-segment-renderer',
        stamp: '#segment-timestamp, .segment-timestamp',
        text: '#segment-text, .segment-text'
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const DEBUG = true;
    const log = (...a) => { if (DEBUG) console.debug('[copy-transcript]', ...a); };

    /* ------------------------------------------------------------------ *
     * 2026 兼容（新增内部辅助，不导出）：面板里已经没有
     * ytd-transcript-segment-* 标签，字幕行只能从 innerText 按时间码切出来 ——
     * 这正是原版 extractFallback() 一直在做的事，缺的只是「被喂对面板」。
     *
     * 这里数「连续递增、相邻间隔 <= 45s」的行数：字幕相邻只隔几秒，
     * 章节时间点（28:14 -> 33:04 -> 34:23）隔几分钟，自然连不成段。
     * 因此既不会把停在 Chapters 的面板当成字幕面板，也不会把章节复制成字幕。
     * ------------------------------------------------------------------ */
    function timecodeToMs(time) {
        const bits = time.split(':').map(Number);
        if (bits.some((n) => !Number.isFinite(n))) return -1;
        return bits.length === 3
            ? (bits[0] * 3600 + bits[1] * 60 + bits[2]) * 1000
            : (bits[0] * 60 + bits[1]) * 1000;
    }

    function subtitleRows(root) {
        const raw = normalizeLines(root.innerText || '');
        if (!raw) return 0;
        const parts = raw.split(/\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*/);
        let best = 0;
        let run = 0;
        let lastMs = -1;
        for (let i = 1; i < parts.length; i += 2) {
            const time = parts[i];
            const text = normalize(parts[i + 1]);
            const ms = time ? timecodeToMs(time) : -1;
            if (!time || !text || ms < 0) { run = 0; lastMs = -1; continue; }
            run = (run > 0 && ms > lastMs && ms - lastMs <= 45000) ? run + 1 : 1;
            lastMs = ms;
            if (run > best) best = run;
        }
        return best;
    }

    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const interval = 100;
            let elapsed = 0;
            const timer = setInterval(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearInterval(timer);
                    resolve(el);
                } else if ((elapsed += interval) >= timeout) {
                    clearInterval(timer);
                    reject(new Error(`Element ${selector} not found within ${timeout}ms`));
                }
            }, interval);
        });
    }

    /* ------------------------------------------------------------------ *
     * 可见性判定：关闭时间线时 YouTube 只做 CSS 隐藏，DOM 文本仍在
     * ------------------------------------------------------------------ */
    function isVisible(el) {
        if (!el) return false;
        if (el.getClientRects().length === 0) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    /* ------------------------------------------------------------------ *
     * 面板唯一化选择
     * ------------------------------------------------------------------ */
    function countSegments(root) {
        const legacy = root.querySelectorAll(SEL.segOld + ',' + SEL.segNew).length;
        if (legacy > 0 || root.querySelector(SEL.list)) return legacy;
        // 2026 兼容：没有旧片段标签时，改用 innerText 能切出的字幕行数评分
        return subtitleRows(root);
    }

    function pickPanel() {
        const all = Array.from(document.querySelectorAll(SEL.panels));
        const visible = all.filter(isVisible);
        const pool = visible.length ? visible : all;
        if (!pool.length) return null;

        // 2026 兼容：#panels 里同时挂着十几块面板，只有一块是 EXPANDED。
        // 只认「至少能切出 3 行连续字幕」的面板，避免把停在 Chapters 的面板
        // 当成字幕面板 —— 否则早退分支会跳过 Show transcript 点击，字幕反而不渲染。
        // 旧版页面只要有片段标签就照旧认，不受行数阈值影响。
        const scored = pool
            .map((el) => {
                const rows = countSegments(el);
                const visibility = el.getAttribute('visibility') || '';
                return {
                    el,
                    rows,
                    ready: rows >= 3 ||
                        Boolean(el.querySelector(SEL.list) || el.querySelector(SEL.segOld)),
                    score: rows +
                        (visibility.includes('EXPANDED') ? 25 : 0) -
                        (visibility.includes('HIDDEN') ? 25 : 0)
                };
            })
            .filter((item) => item.ready)
            .sort((a, b) => b.score - a.score);
        return scored.length ? scored[0].el : null;
    }

    async function waitForSegments(panel, timeout = 8000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (panel.querySelector(SEL.list) || panel.querySelector(SEL.segOld)) return true;
            // 2026 兼容：字幕行没有专用标签，innerText 能切出连续行就算就绪，
            // 不再因为找不到旧标签而白等 6s / 8s。
            if (subtitleRows(panel) >= 3) return true;
            await sleep(150);
        }
        return false;
    }

    async function openTranscriptPanel() {
        // 面板已存在 → 只等待加载，绝不二次点击（二次点击会挂出重复列表）
        let panel = pickPanel();
        if (panel) {
            await waitForSegments(panel, 3000);
            return panel;
        }

        const buttons = Array.from(document.querySelectorAll('button, yt-button-shape button'))
            // 我们自己的按钮（Copy Transcript / Transcript v2.x）绝不能点
            .filter((b) => b.id !== 'ytt-entry-btn' && b.id !== 'copy-transcript-btn');

        // Transcript 标签是开关式 chip：已选中时再点一次会把面板收起，
        // 用户看到的就是「原版字幕框消失了」。已选中的一律跳过。
        const isActiveChip = (b) => {
            const pressed = (b.getAttribute('aria-pressed') || b.getAttribute('aria-selected') || '').toLowerCase();
            if (pressed === 'true') return true;
            return /\b(selected|active|is-on)\b/i.test(b.getAttribute('class') || '');
        };

        const trigger =
            buttons.find((b) => /show\s*transcript/i.test(b.textContent || '')) ||
            buttons.find((b) => /transcript/i.test(b.textContent || '') && !isActiveChip(b));

        if (trigger) {
            trigger.click();
            await sleep(400);
        }

        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            panel = pickPanel();
            // 2026 兼容：字幕框打开后行是纯文本，没有旧片段标签；
            // 只要能切出连续字幕行就立刻返回，不用空等满 8s 再弹 alert。
            if (panel && (
                panel.querySelector(SEL.list) ||
                panel.querySelector(SEL.segOld) ||
                subtitleRows(panel) >= 3
            )) return panel;
            await sleep(150);
        }
        return panel || null;
    }

    /* ------------------------------------------------------------------ *
     * 单个列表内提取
     * ------------------------------------------------------------------ */
    function segmentSelectorFor(list) {
        // 新旧两套元素互斥使用，避免同一片段被两套选择器同时命中
        return list.querySelector(SEL.segNew) ? SEL.segNew : SEL.segOld;
    }

    function collectFromList(list) {
        const segSel = segmentSelectorFor(list);
        // 元素级去重：同一节点被多个选择器命中时只保留一次
        const segs = Array.from(new Set(Array.from(list.querySelectorAll(segSel))));
        if (!segs.length) return { lines: [], showTimestamps: false, segCount: 0 };

        // 以首段的时间戳单元格为探针判定开关状态；
        // 若时间戳节点已被整体移除，探针为 null → 视为隐藏。
        const probe = segs[0].querySelector(SEL.stamp);
        const showTimestamps = isVisible(probe);

        const lines = [];
        for (const seg of segs) {
            const stampEl = seg.querySelector(SEL.stamp);
            const textEl =
                seg.querySelector(SEL.text) ||
                seg.querySelector('yt-formatted-string');

            const time = showTimestamps && isVisible(stampEl) ? normalize(stampEl.textContent) : '';
            const text = normalize(textEl ? (textEl.innerText || textEl.textContent) : '');

            if (!text) continue;                 // 行是否有效只看正文，不看时间戳
            lines.push(time ? `${time} ${text}` : text);
        }

        return { lines, showTimestamps, segCount: segs.length };
    }

    /* ------------------------------------------------------------------ *
     * 重复内容兜底（结构修复失效时的第二道保险）
     * - 连续重复折叠：仅在检测到多列表 / 片段数异常时启用
     * - 整段重复：前后两半完全相同则保留一半
     * ------------------------------------------------------------------ */
    function collapseDuplicates(lines, aggressive) {
        if (lines.length < 2) return lines;

        let out = lines;
        if (aggressive) {
            out = [];
            for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
        }

        if (out.length >= 4 && out.length % 2 === 0) {
            const half = out.length / 2;
            if (out.slice(0, half).join('\n') === out.slice(half).join('\n')) {
                log('duplicated halves detected, trimmed', out.length, '->', half);
                return out.slice(0, half);
            }
        }
        return out;
    }

    async function extractTranscript(panel) {
        await waitForSegments(panel, 6000);

        const lists = Array.from(panel.querySelectorAll(SEL.list)).filter(isVisible);
        const candidates = lists.length ? lists : [panel];

        // 只取第一个能产出内容的列表；绝不合并多个列表（合并即重复）
        let best = { lines: [], showTimestamps: false, segCount: 0 };
        for (const list of candidates) {
            const r = collectFromList(list);
            if (r.lines.length) { best = r; break; }
        }

        if (best.lines.length) {
            // 触发激进去重的三个信号：多个列表 / 片段数与行数不符 /
            // 重复率超过 30%（真实字幕几乎不可能达到，DOM 双份则会接近 50%）
            const distinct = new Set(best.lines).size;
            const aggressive =
                lists.length > 1 ||
                best.segCount !== best.lines.length ||
                distinct < best.lines.length * 0.7;
            const lines = collapseDuplicates(best.lines, aggressive);
            log({ lists: lists.length, segs: best.segCount, lines: lines.length, showTimestamps: best.showTimestamps });
            return { text: lines.join('\n'), showTimestamps: best.showTimestamps };
        }

        const fb = extractFallback(panel);
        log('fallback used', { chars: fb.text.length });
        return { ...fb, showTimestamps: false };
    }

    /* 降级路径：仅作用于片段列表容器，且用 innerText 排除隐藏节点 */
    function extractFallback(panel) {
        const scope = panel.querySelector(SEL.list) || panel;
        const raw = normalizeLines(scope.innerText || '');
        if (!raw) return { text: '' };

        const TS = /(\d{1,2}:\d{2}(?::\d{2})?)/;
        if (!TS.test(raw)) {
            // 无时间戳（已关闭开关）→ 原样按行输出，绝不合成时间戳
            return { text: raw };
        }

        const parts = raw.split(/\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*/);
        const out = [];
        for (let i = 1; i < parts.length; i += 2) {
            const time = parts[i];
            const lineText = normalize(parts[i + 1]);
            if (time && lineText) out.push(`${time} ${lineText}`);
        }
        return { text: out.length ? out.join('\n') : raw };
    }

    function normalizeLines(s) {
        return (s || '')
            .split('\n')
            .map((l) => l.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n');
    }

    /* ------------------------------------------------------------------ *
     * 共享层：原版按钮与新版面板**调用同一份函数**，保证两个入口完全同步。
     * 由 scripts/sync-legacy.mjs 导出到 __yttLegacyV19，TS 侧直接复用。
     * ------------------------------------------------------------------ */

    /** m:ss / h:mm:ss，与新版 formatTimestamp 保持同一格式。 */
    function formatStamp(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '--:--';
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
    }

    /**
     * YouTube 给每个时间点配了一段无障碍时长文本，复制时会一起带出来：
     *   "33:26 33 minutes, 26 seconds 正文"   → 后面的 33 分 26 秒就是 33:26 的复述
     *   "3:323 minutes, 32 secondsI don't…"  → 中间没有空格，粘在一起
     *
     * 判定规则：**数值必须和时间码完全一致才删**。
     * 这样 "1:23 we waited 5 minutes" 里的 5 minutes 不会被动到，
     * 只有真正的复述（33:26 ↔ 33 minutes, 26 seconds）才去掉。
     */
    const DURATION_UNITS = [
        ['hours?|hrs?', 3600000], ['minutes?|mins?', 60000], ['seconds?|secs?', 1000],
        ['小时|小時|时|時', 3600000], ['分钟|分鐘', 60000], ['秒', 1000]
    ];
    const DURATION_WORDS = DURATION_UNITS.map(([w]) => w).join('|');
    const DURATION_PHRASE = `(?:\\d{1,2}\\s*(?:${DURATION_WORDS})[\\s,，]*)+`;
    const DURATION_AFTER_STAMP = new RegExp(
        `(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*(${DURATION_PHRASE})`, 'giu'
    );
    const DURATION_ONLY_LINE = new RegExp(`^${DURATION_PHRASE}$`, 'iu');
    const DURATION_TOKEN = new RegExp(`(\\d{1,2})\\s*(${DURATION_WORDS})`, 'giu');

    function timecodeMs(time) {
        const bits = String(time || '').split(':').map(Number);
        if (bits.some((n) => !Number.isFinite(n))) return -1;
        return bits.length === 3
            ? (bits[0] * 3600 + bits[1] * 60 + bits[2]) * 1000
            : (bits[0] * 60 + bits[1]) * 1000;
    }

    /** 把 "33 minutes, 26 seconds" 这样的复述换算成毫秒；认不出单位返回 -1。 */
    function spokenDurationMs(phrase) {
        let total = 0;
        let seen = false;
        for (const match of String(phrase || '').matchAll(DURATION_TOKEN)) {
            const unit = match[2].toLowerCase();
            const entry = DURATION_UNITS.find(([words]) => new RegExp(`^(?:${words})$`, 'iu').test(unit));
            if (!entry) return -1;
            total += Number(match[1]) * entry[1];
            seen = true;
        }
        return seen ? total : -1;
    }

    const DURATION_AT_START = new RegExp(`^${DURATION_PHRASE}`, 'iu');

    /**
     * @param expectedMs 已知该行起点（毫秒）时传入。结构化行的时间码已被
     *   解析到 start 字段、正文里只剩那串复述，这时靠 expectedMs 才能对上。
     */
    function stripA11yDuration(text, expectedMs) {
        const raw = String(text || '');
        let cleaned = raw.replace(DURATION_AFTER_STAMP, (match, stamp, phrase) => {
            // 只在前面的时间码和后面的复述数值一致时才删
            return timecodeMs(stamp) === spokenDurationMs(phrase) ? `${stamp} ` : match;
        });

        // 行首单独一段复述（时间码在 start 里，不在这段文本里）
        const lead = DURATION_AT_START.exec(cleaned);
        if (lead && Number.isFinite(expectedMs) && expectedMs >= 0) {
            if (spokenDurationMs(lead[0]) === expectedMs) cleaned = cleaned.slice(lead[0].length);
        }

        return normalizeLines(cleaned)
            .split('\n')
            .filter((line) => !DURATION_ONLY_LINE.test(line.trim()))
            .map((line) => normalize(line))
            .join('\n');
    }

    /** 把原版那种 "时间码 正文" 纯文本转成结构化行（毫秒）。 */
    function textToRows(text) {
        return normalizeLines(text)
            .split('\n')
            .map((line) => {
                const match = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/u.exec(line);
                if (!match) return { start: -1, dur: 0, text: line };
                return { start: timecodeToMs(match[1]), dur: 0, text: match[2] };
            })
            .filter((row) => row.text);
    }

    /** 章节：按时间码切分，剥掉无障碍时长；去重、按时间递增。 */
    function parseChapters(text) {
        const parts = normalizeLines(stripA11yDuration(text))
            .split(/\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*/u);
        const seen = new Set();
        const out = [];
        for (let i = 1; i < parts.length; i += 2) {
            const ms = timecodeToMs(parts[i]);
            const label = normalize(parts[i + 1]);
            if (ms < 0 || !label || label.length > 200 || seen.has(ms)) continue;
            seen.add(ms);
            out.push({ start: ms, dur: 0, text: label });
        }
        return out.sort((a, b) => a.start - b.start);
    }

    /**
     * 只认「章节面板」。绝不能写 [visibility*="EXPANDED"] —— 那块正是字幕面板，
     * 字幕行间隔几秒，按 30s 抽样后也能凑出十几行，会被误当章节。
     * 真实 dump 里章节面板是 target-id="engagement-panel-macro-markers-description-chapters"。
     */
    const CHAPTER_PANELS = [
        'ytd-engagement-panel-section-list-renderer[target-id*="chapter"]',
        'ytd-engagement-panel-section-list-renderer[target-id*="macro-markers"]',
        '[target-id*="macro-markers"]',
        'ytd-macro-markers-list-item-renderer'
    ].join(',');

    /** 章节条目自身的容器：面板认不出时，把所有条目文本拼起来再切。 */
    const CHAPTER_ITEMS = [
        'ytd-macro-markers-list-item-renderer',
        'yt-macro-markers-list-item-view-model',
        '[class*="macro-markers-list-item"]'
    ].join(',');

    /**
     * 从一段面板文本里切章节。
     *
     * 防「字幕被当成章节」的判据：字幕每隔几秒一行，按 30s 抽样后
     * 间隔会**整齐地堆在 30s 附近**（每次都是「越过阈值后的第一行」）。
     * 真实章节的间隔是分钟级且参差不齐。所以：
     *   - 若 ≥70% 的间隔都落在 30~40s，判定为字幕抽样，丢弃；
     *   - 章节这么密的视频几乎不存在，这条不会误伤真实章节。
     */
    function parseChapterList(raw, minGapMs, maxRows) {
        const kept = [];
        for (const row of parseChapters(raw)) {
            if (kept.length === 0 || row.start - kept[kept.length - 1].start >= minGapMs) {
                kept.push(row);
            }
        }
        if (kept.length < 2 || kept.length > maxRows) return [];

        const gaps = [];
        for (let i = 1; i < kept.length; i += 1) gaps.push(kept[i].start - kept[i - 1].start);
        const sampled = gaps.filter((gap) => gap >= 30000 && gap <= 40000).length;
        if (gaps.length >= 3 && sampled / gaps.length >= 0.7) return [];
        return kept;
    }

    function readChapterRows(doc) {
        if (!doc || typeof doc.querySelectorAll !== 'function') return [];
        const MIN_GAP = 30000;
        const MAX_ROWS = 80;
        try {
            // ① 整块章节面板（innerText 一次读完，顺序天然正确）
            for (const el of Array.from(doc.querySelectorAll(CHAPTER_PANELS)).slice(0, 16)) {
                const raw = el.innerText || el.textContent || '';
                if (!raw || raw.length > 20000) continue;
                const rows = parseChapterList(raw, MIN_GAP, MAX_ROWS);
                if (rows.length > 0) return rows;
            }

            // ② 面板结构变了（只剩条目节点）：按 DOM 顺序把条目文本拼起来
            const items = Array.from(doc.querySelectorAll(CHAPTER_ITEMS)).slice(0, 120);
            if (items.length >= 2) {
                const raw = items.map((el) => normalize(el.innerText || el.textContent || '')).join('\n');
                const rows = parseChapterList(raw, MIN_GAP, MAX_ROWS);
                if (rows.length > 0) return rows;
            }
        } catch { /* 读取失败就当没有章节 */ }
        return [];
    }

    /**
     * 两个入口共用的复制格式化。rows/chapters 都是 {start(ms), text}。
     * timestamps=false 时去掉时间码前缀；view='chapters' 且有章节时复制章节。
     */
    function formatCopyText(rows, options) {
        const opts = options || {};
        const withTime = opts.timestamps !== false;
        const chapters = Array.isArray(opts.chapters) ? opts.chapters : [];
        const useChapters = opts.view === 'chapters' && chapters.length > 0;
        const source = useChapters ? chapters : (Array.isArray(rows) ? rows : []);
        const out = [];

        for (const row of source) {
            const label = stripA11yDuration(row.text || '', row.start);
            if (!label) continue;
            out.push(withTime && row.start >= 0 ? `${formatStamp(row.start)} ${label}` : label);
        }
        return out.join('\n');
    }

    /** 共享偏好：新版 UI 写 globalThis + localStorage，原版按钮读同一份。 */
    const PREFS_KEY = 'ytt-prefs';
    function sharedPrefs() {
        const defaults = { timestamps: true, view: 'lines' };
        const fromGlobal = globalThis.__yttSharedPrefs;
        if (fromGlobal && typeof fromGlobal === 'object') return { ...defaults, ...fromGlobal };
        try {
            const raw = localStorage.getItem(PREFS_KEY);
            if (raw) return { ...defaults, ...JSON.parse(raw) };
        } catch { /* 独立安装时没有偏好存储 */ }
        return defaults;
    }

    /** 原版按钮上的 Shift/Alt 快捷切换也要写回共享偏好，让新版面板同步。 */
    function setSharedPrefs(patch) {
        const next = { ...sharedPrefs(), ...patch };
        globalThis.__yttSharedPrefs = next;
        try {
            if (typeof globalThis.__yttSetSharedPrefs === 'function') {
                globalThis.__yttSetSharedPrefs(patch);
            } else {
                const raw = localStorage.getItem(PREFS_KEY);
                const stored = raw ? JSON.parse(raw) : {};
                localStorage.setItem(PREFS_KEY, JSON.stringify({ ...stored, ...patch }));
            }
        } catch { /* 写不进去也至少本次复制已生效 */ }
        return next;
    }

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                ta.remove();
                return ok;
            } catch {
                return false;
            }
        }
    }

    /* ------------------------------------------------------------------ */

    function buildButton() {
        const btn = document.createElement('button');
        btn.id = 'copy-transcript-btn';
        btn.textContent = 'Copy Transcript';
        btn.style.cssText = [
            'margin-left:12px',
            'padding:10px 16px',
            'background:#1da1f2',
            'color:#fff',
            'border:none',
            'border-radius:6px',
            'font-size:16px',
            'cursor:pointer',
            'box-shadow:0 2px 8px rgba(0,0,0,0.15)',
            'transition:background 0.2s',
            'height:40px',
            'align-self:center',
            'display:inline-flex',
            'align-items:center'
        ].join(';');

        btn.onmouseover = () => { btn.style.background = '#0d8ddb'; };
        btn.onmouseout = () => { btn.style.background = '#1da1f2'; };

        const reset = (label = 'Copy Transcript') => {
            btn.textContent = label;
            btn.disabled = false;
        };

        btn.onclick = async (event) => {
            btn.disabled = true;
            btn.textContent = 'Opening transcript...';

            try {
                // 与新版面板共用同一份偏好。Shift 点击 = 反转时间戳；
                // Alt 点击 = 反转 字幕/章节。改动写回共享偏好，两边同步。
                let prefs = sharedPrefs();
                if (event && event.shiftKey) {
                    const patch = { timestamps: !prefs.timestamps };
                    setSharedPrefs(patch);
                    prefs = { ...prefs, ...patch };
                }
                if (event && event.altKey) {
                    const patch = { view: prefs.view === 'chapters' ? 'lines' : 'chapters' };
                    setSharedPrefs(patch);
                    prefs = { ...prefs, ...patch };
                }

                const chapters = readChapterRows(document);
                const options = { ...prefs, chapters };
                let rows;

                if (prefs.view === 'chapters' && chapters.length > 0) {
                    // 章节是页面独立数据，不必先打开字幕面板（那个面板可能打不开）
                    rows = chapters;
                    btn.textContent = 'Extracting transcript...';
                } else {
                    const panel = await openTranscriptPanel();
                    if (!panel) {
                        alert('Could not find the transcript panel. This video may not have a transcript.');
                        return reset();
                    }

                    btn.textContent = 'Extracting transcript...';
                    const { text: raw } = await extractTranscript(panel);
                    if (!raw) {
                        alert('Transcript is empty or still loading. Try again in a moment.');
                        return reset();
                    }
                    rows = textToRows(raw);
                    options.view = 'lines';
                }

                // 与新版面板调用同一个 formatCopyText：清洗、开关、章节完全一致
                const text = formatCopyText(rows, options);
                if (!text) {
                    alert('Transcript is empty or still loading. Try again in a moment.');
                    return reset();
                }

                if (!(await copyToClipboard(text))) {
                    alert('Failed to copy transcript to clipboard.');
                    return reset();
                }

                btn.textContent = prefs.timestamps ? 'Copied!' : 'Copied (no timestamps)!';
                setTimeout(() => reset(), 2000);
            } catch (err) {
                console.error('[copy-transcript] extraction failed:', err);
                alert('An error occurred while extracting the transcript.');
                reset();
            }
        };

        return btn;
    }

    async function addCopyButton() {
        let mastheadEnd;
        try {
            mastheadEnd = await waitForElement(SEL.mastheadEnd);
        } catch {
            console.error('[copy-transcript] masthead #end not found');
            return;
        }
        if (document.getElementById('copy-transcript-btn')) return;
        mastheadEnd.appendChild(buildButton());
    }

    /* SPA 导航：URL 变化后重建按钮 */
    let lastUrl = '';
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            document.getElementById('copy-transcript-btn')?.remove();
            setTimeout(addCopyButton, 1500);
        }
    }, 500);

    setTimeout(addCopyButton, 2000);
})();
