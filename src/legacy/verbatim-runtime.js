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

        const buttons = Array.from(document.querySelectorAll('button, yt-button-shape button'));
        const trigger =
            buttons.find((b) => /show\s*transcript/i.test(b.textContent || '')) ||
            buttons.find((b) => /transcript/i.test(b.textContent || ''));

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

        btn.onclick = async () => {
            btn.disabled = true;
            btn.textContent = 'Opening transcript...';

            try {
                const panel = await openTranscriptPanel();
                if (!panel) {
                    alert('Could not find the transcript panel. This video may not have a transcript.');
                    return reset();
                }

                btn.textContent = 'Extracting transcript...';
                const { text, showTimestamps } = await extractTranscript(panel);

                if (!text) {
                    alert('Transcript is empty or still loading. Try again in a moment.');
                    return reset();
                }

                if (!(await copyToClipboard(text))) {
                    alert('Failed to copy transcript to clipboard.');
                    return reset();
                }

                btn.textContent = showTimestamps ? 'Copied!' : 'Copied (no timestamps)!';
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

    // [ytt] 唯一新增：暴露原版全部内部函数（逐步转移第 1 步）
    globalThis.__yttLegacyV19 = {
        SEL, sleep, normalize, waitForElement, isVisible, countSegments, pickPanel,
        waitForSegments, openTranscriptPanel, segmentSelectorFor, collectFromList,
        collapseDuplicates, extractTranscript, extractFallback, normalizeLines,
        copyToClipboard, buildButton, addCopyButton
    };
})();
