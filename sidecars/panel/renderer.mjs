// The wallpaper stays viewport-sized. Sidebar surfaces change stacking, so
// opening a pane never changes the image's dimensions, crop or position.
export async function installWallpaper(payload = {}) {
    // v18 checks this protocol version before honoring another owner's lease.
    const version = 18;
    const revision = 26;

    // -------------------------------------------------------------------------
    // Section 1: Pure helpers (kept inside installWallpaper so toString() CDP
    // injection remains 100% self-contained with zero external closure deps).
    // -------------------------------------------------------------------------

    const shouldIgnoreLease = (active, incoming) => {
        if (!active) return false;
        const activeVersion = Number.isFinite(active.version) ? active.version : 0;
        const incomingVersion = Number.isFinite(incoming.version) ? incoming.version : 0;
        if (activeVersion !== incomingVersion) return activeVersion > incomingVersion;

        const activeRevision = Number.isFinite(active.revision) ? active.revision : 0;
        const incomingRevision = Number.isFinite(incoming.revision) ? incoming.revision : 0;
        const activeGeneration = Number.isFinite(active.generation) ? active.generation : 0;
        const incomingGeneration = Number.isFinite(incoming.generation) ? incoming.generation : 0;
        const activeOwner = String(active.owner ?? '');
        const incomingOwner = String(incoming.owner ?? '');

        if (activeRevision > incomingRevision) return true;
        if (activeRevision < incomingRevision) {
            // Stale disable requests (enabled: false) must never override a higher-generation active session.
            return !incoming.enabled && activeGeneration > incomingGeneration;
        }
        if (activeGeneration !== incomingGeneration) return activeGeneration > incomingGeneration;
        return activeOwner > incomingOwner;
    };

    const createHelpers = () => {
        const cssNumRe = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;
        const srgbColorRe = /^color\(\s*srgb\s+([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)(?:\s*\/\s*([^\s)]+))?\s*\)$/i;
        const cssColor4Re = /^(?:color|oklab|oklch|lab|lch)\(/i;
        const hexColorRe = /^#[0-9a-f]{6}$/i;
        let colorCtx = null;

        const parseUnitChannel = token => {
            if (typeof token !== 'string' || !cssNumRe.test(token)) return Number.NaN;
            const isPct = token.endsWith('%');
            const num = Number(isPct ? token.slice(0, -1) : token);
            if (!Number.isFinite(num)) return Number.NaN;
            const unit = isPct ? num / 100 : num;
            return Math.min(1, Math.max(0, unit));
        };

        const normalizeColor = value => {
            if (typeof value !== 'string') return '';
            const trimmed = value.trim();
            if (!trimmed) return '';
            const match = trimmed.match(srgbColorRe);
            if (match) {
                const r = parseUnitChannel(match[1]);
                const g = parseUnitChannel(match[2]);
                const b = parseUnitChannel(match[3]);
                if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return trimmed;
                const rgb = `${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}`;
                if (match[4] === undefined) return `rgb(${rgb})`;
                const alpha = parseUnitChannel(match[4]);
                if (!Number.isFinite(alpha)) return trimmed;
                return alpha >= 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${+alpha.toFixed(4)})`;
            }
            if (cssColor4Re.test(trimmed) && typeof document !== 'undefined' &&
                typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', trimmed)) {
                if (!colorCtx) {
                    const canvas = document.createElement('canvas');
                    canvas.width = 1;
                    canvas.height = 1;
                    colorCtx = canvas.getContext('2d', { willReadFrequently: true });
                }
                if (colorCtx) {
                    colorCtx.clearRect(0, 0, 1, 1);
                    colorCtx.fillStyle = trimmed;
                    colorCtx.fillRect(0, 0, 1, 1);
                    const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
                    return a >= 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(4)})`;
                }
            }
            return trimmed;
        };

        const mix = (color, alpha) => 'color-mix(in srgb,' + color + ' ' + alpha + '%,transparent)';

        const computeSurfaceState = (options, prefix, flatFallback, borderFallback = '', allowLayered = false) => {
            const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
            const cover = opts[prefix + 'Cover'] !== false;
            const layered = Boolean(allowLayered && opts[prefix + 'Layered'] !== false);
            const rawOpacity = opts[prefix + 'Opacity'];
            const opacity = typeof rawOpacity === 'number' && Number.isFinite(rawOpacity)
                ? Math.min(100, Math.max(0, Math.round(rawOpacity)))
                : 100;
            const rawBlur = opts[prefix + 'Blur'];
            const blur = typeof rawBlur === 'number' && Number.isFinite(rawBlur)
                ? Math.min(30, Math.max(0, Math.round(rawBlur)))
                : 0;
            const rawOuter = opts[prefix + 'OuterColor'];
            const rawInner = opts[prefix + 'InnerColor'];
            const outerColor = typeof rawOuter === 'string' && hexColorRe.test(rawOuter) ? rawOuter.toLowerCase() : '';
            const innerColor = typeof rawInner === 'string' && hexColorRe.test(rawInner) ? rawInner.toLowerCase() : '';
            const alpha = cover ? opacity : 0;
            const effectiveBlur = cover && blur > 0 ? blur : 0;
            const outerBg = cover ? mix(outerColor || 'var(--ag-ui-frame-default)', alpha) : 'transparent';
            const innerBg = cover
                ? mix(innerColor || (layered ? 'var(--ag-ui-raised-default)' : flatFallback), alpha)
                : 'transparent';
            const outerBorder = cover && outerColor
                ? mix(outerColor, alpha)
                : (layered ? 'var(--ag-ui-rim-default)' : borderFallback);
            const innerRim = cover && innerColor
                ? 'color-mix(in srgb,' + innerColor + ' ' + Math.min(100, alpha + 22) + '%,var(--ag-ui-rim-default))'
                : 'var(--ag-ui-rim-default)';
            return { cover, layered, alpha, effectiveBlur, outerBg, innerBg, outerBorder, innerRim };
        };

        const computeLayoutMetrics = ({ width, height, hasHostShell, insetTop, leftWidth, noLeftNav, rightWidth, tabStripHeight }) => {
            if (!hasHostShell || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
                return null;
            }
            return {
                width,
                height,
                titlebarPct: Number.isFinite(insetTop) && insetTop >= 0 ? +(insetTop / height * 100).toFixed(2) : null,
                leftPct: noLeftNav ? 0 : (Number.isFinite(leftWidth) && leftWidth >= 0 ? +(leftWidth / width * 100).toFixed(2) : null),
                rightPct: Number.isFinite(rightWidth) && rightWidth >= 0 ? +(rightWidth / width * 100).toFixed(2) : null,
                tabStripPct: Number.isFinite(tabStripHeight) && tabStripHeight > 0 ? +(tabStripHeight / height * 100).toFixed(2) : null,
            };
        };

        const matchesTrackGeometry = (box, tr, horizontal) => {
            const scaleX = box.offsetWidth > 0 ? box.width / box.offsetWidth : 1;
            const scaleY = box.offsetHeight > 0 ? box.height / box.offsetHeight : 1;
            const clientLeft = (box.clientLeft || 0) * scaleX;
            const clientTop = (box.clientTop || 0) * scaleY;
            const cw = box.clientWidth > 0 ? box.clientWidth * scaleX : box.width;
            const ch = box.clientHeight > 0 ? box.clientHeight * scaleY : box.height;
            const expTop = horizontal ? box.top + clientTop + ch - 14 * scaleY : box.top + clientTop + 2 * scaleY;
            const expLeft = horizontal ? box.left + clientLeft + 2 * scaleX : box.left + clientLeft + cw - 14 * scaleX;
            const expLen = Math.max(0, horizontal ? cw - 4 * scaleX : ch - 4 * scaleY);
            const actLen = horizontal ? tr.width : tr.height;
            const tolX = Math.max(3, 3 * scaleX);
            const tolY = Math.max(3, 3 * scaleY);
            const tolLen = horizontal ? tolX : tolY;
            return Math.abs(expTop - tr.top) <= tolY && Math.abs(expLeft - tr.left) <= tolX && Math.abs(expLen - actLen) <= tolLen;
        };

        const computeClipInsets = (clip, tr) => {
            const topInset = Math.max(0, Math.ceil(clip.top - tr.top));
            const bottomInset = Math.max(0, Math.ceil(tr.bottom - clip.bottom));
            const leftInset = Math.max(0, Math.ceil(clip.left - tr.left));
            const rightInset = Math.max(0, Math.ceil(tr.right - clip.right));
            if (topInset + bottomInset >= tr.height || leftInset + rightInset >= tr.width) {
                return 'inset(100% 0px 0px 0px)';
            }
            if (topInset || rightInset || bottomInset || leftInset) {
                return `inset(${topInset}px ${rightInset}px ${bottomInset}px ${leftInset}px)`;
            }
            return '';
        };

        return { normalizeColor, computeSurfaceState, computeLayoutMetrics, matchesTrackGeometry, computeClipInsets };
    };

    if (typeof window === 'undefined' && payload?.__inspectHelpers === true) {
        return { version, revision, shouldIgnoreLease, ...createHelpers() };
    }

    // -------------------------------------------------------------------------
    // Section 2: Host window fingerprint & lease negotiation
    // -------------------------------------------------------------------------

    // Antigravity main window fingerprint: top-level Electron renderer with
    // `electronNative` (titlebar overlay IPC) and `nativeStorage` (main host only).
    if (window !== window.top || !window.electronNative || !window.nativeStorage) return false;
    const { enabled = false, css = '', image, imageHash = '', owner = '', generation = 0, surfaces = {} } = payload;
    const key = '__antigravityUiRenderer';
    const incoming = { version, revision, owner, generation, enabled: Boolean(enabled) };
    const isCurrent = item => item?.version === version && item.revision === revision && !item.empty;

    const active = window[key];
    if (shouldIgnoreLease(active, incoming)) return 'IGNORED';

    if (!enabled) {
        let attempts = 0;
        while (window[key] && attempts++ < 4) {
            const existing = window[key];
            if (shouldIgnoreLease(existing, incoming)) return 'IGNORED';
            await existing.dispose?.();
        }
        const afterDispose = window[key];
        if (afterDispose) return 'IGNORED';
        // Keep ownership while disabled so a standby heartbeat cannot restore stale settings.
        let lease;
        let disposed = false;
        const state = {
            version, revision, owner, generation, empty: true,
            dispose() {
                if (disposed) return;
                disposed = true;
                clearTimeout(lease);
                if (window[key] === state) delete window[key];
            },
        };
        window[key] = state;
        lease = setTimeout(() => state.dispose(), 6500);
        return true;
    }

    const current = isCurrent(active) ? active : undefined;
    if (css && image === undefined && imageHash && current?.imageHash !== imageHash) {
        return 'NEED_IMAGE';
    }

    if (active && !current) {
        let attempts = 0;
        while (window[key] && !isCurrent(window[key]) && attempts++ < 4) {
            const existing = window[key];
            if (shouldIgnoreLease(existing, incoming)) return 'IGNORED';
            await existing.dispose?.();
        }
        const postDispose = window[key];
        if (postDispose) {
            if (shouldIgnoreLease(postDispose, incoming)) return 'IGNORED';
            if (!isCurrent(postDispose)) return 'IGNORED';
            if (css && image === undefined && imageHash && postDispose.imageHash !== imageHash) {
                return 'NEED_IMAGE';
            }
        }
    }

    // -------------------------------------------------------------------------
    // Section 3: Renderer instance initialization (runs once per mount)
    // -------------------------------------------------------------------------

    let created = false;
    if (!window[key]) {
        created = true;
        const {
            normalizeColor,
            computeSurfaceState,
            computeLayoutMetrics,
            matchesTrackGeometry,
            computeClipInsets,
        } = createHelpers();

        const safeImageRe = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
        // Host DOM right-split pane structural selector (prefers semantic attribute, falls back to 3rd split slot).
        const rightPane = '.agy-sheet > .outline-none > :is([data-side-panel],:nth-child(3))';

        const shellColors = () => {
            const style = getComputedStyle(document.querySelector('.agy-shell') || document.body || document.documentElement);
            return { color: normalizeColor(style.backgroundColor), symbolColor: normalizeColor(style.color) };
        };
        const themeSignature = () => {
            const root = document.documentElement;
            const rootStyle = getComputedStyle(root);
            return [
                rootStyle.getPropertyValue('--sidebar').trim(),
                rootStyle.getPropertyValue('--foreground').trim(),
                rootStyle.getPropertyValue('--shell').trim(),
                rootStyle.getPropertyValue('--background').trim(),
                root.className,
                root.dataset.theme ?? '',
                document.body?.className ?? '',
                document.body?.dataset.theme ?? '',
                document.body?.dataset.agyTheme ?? '',
            ].join('\0');
        };

        const layer = document.createElement('div');
        layer.id = 'antigravity-ui-background';
        layer.setAttribute('aria-hidden', 'true');
        const shadow = layer.attachShadow({ mode: 'closed' });
        const imageEl = document.createElement('div');
        imageEl.className = 'image';
        shadow.append(imageEl);
        const content = new CSSStyleSheet();
        shadow.adoptedStyleSheets = [content];
        const layout = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, layout];

        let currentCss;
        let currentSurfaces;
        let lease;
        let disposed = false;
        let bodyObserved = false;
        let syncRafId = 0;
        let lastFallbackScanAt = 0;

        const FALLBACK_SCAN_INTERVAL = 250;
        const FALLBACK_SCAN_LIMIT = 200;
        const trackOwners = new WeakMap();
        const appliedClip = new WeakMap();
        const observedTracks = new WeakSet();
        const recentScrollables = [];
        const recentScrollableSet = new WeakSet();

        const rememberScrollable = el => {
            if (!el || el === document.body || el === document.documentElement || recentScrollableSet.has(el)) return;
            recentScrollableSet.add(el);
            recentScrollables.push(typeof WeakRef === 'function' ? new WeakRef(el) : el);
            while (recentScrollables.length > 32) {
                const entry = recentScrollables.shift();
                const evicted = typeof WeakRef === 'function' ? entry?.deref() : entry;
                if (evicted) recentScrollableSet.delete(evicted);
            }
        };

        const hasFloatingTrack = () => {
            for (let el = document.body?.firstElementChild; el; el = el.nextElementSibling) {
                if (el.hasAttribute('data-overlay-scrollbar-track')) return true;
            }
            return false;
        };

        const matchesTrackOwner = (el, tr, horizontal) => {
            if (!el || !el.isConnected || el === document.body || el === document.documentElement) return false;
            const cs = getComputedStyle(el);
            const ov = horizontal ? cs.overflowX : cs.overflowY;
            if (ov !== 'auto' && ov !== 'scroll' && ov !== 'overlay') return false;
            if (horizontal ? el.scrollWidth <= el.clientWidth + 1 : el.scrollHeight <= el.clientHeight + 1) return false;
            const r = el.getBoundingClientRect();
            return matchesTrackGeometry({
                top: r.top,
                left: r.left,
                width: r.width,
                height: r.height,
                clientTop: el.clientTop,
                clientLeft: el.clientLeft,
                clientWidth: el.clientWidth,
                clientHeight: el.clientHeight,
                offsetWidth: el.offsetWidth,
                offsetHeight: el.offsetHeight,
            }, tr, horizontal);
        };

        const findTrackOwner = (track, tr, horizontal) => {
            const cached = trackOwners.get(track);
            if (matchesTrackOwner(cached, tr, horizontal)) return cached;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
            const samples = horizontal
                ? [
                    [clamp((Math.max(0, tr.left) + Math.min(vw, tr.right)) / 2, 0, vw - 1), clamp(tr.top - 4, 0, vh - 1)],
                    [clamp(Math.max(0, tr.left) + 12, 0, vw - 1), clamp(tr.top - 4, 0, vh - 1)],
                    [clamp(Math.min(vw, tr.right) - 12, 0, vw - 1), clamp(tr.top - 4, 0, vh - 1)],
                ]
                : [
                    [clamp(tr.left - 4, 0, vw - 1), clamp((Math.max(0, tr.top) + Math.min(vh, tr.bottom)) / 2, 0, vh - 1)],
                    [clamp(tr.left - 4, 0, vw - 1), clamp(Math.max(0, tr.top) + 12, 0, vh - 1)],
                    [clamp(tr.left - 4, 0, vw - 1), clamp(Math.min(vh, tr.bottom) - 12, 0, vh - 1)],
                ];
            for (const [sx, sy] of samples) {
                for (const hit of document.elementsFromPoint(sx, sy)) {
                    for (let cur = hit; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
                        if (matchesTrackOwner(cur, tr, horizontal)) {
                            trackOwners.set(track, cur);
                            rememberScrollable(cur);
                            return cur;
                        }
                    }
                }
            }
            for (let i = recentScrollables.length - 1; i >= 0; i--) {
                const entry = recentScrollables[i];
                const el = typeof WeakRef === 'function' ? entry?.deref() : entry;
                if (!el || !el.isConnected) {
                    if (el) recentScrollableSet.delete(el);
                    recentScrollables.splice(i, 1);
                    continue;
                }
                if (matchesTrackOwner(el, tr, horizontal)) {
                    trackOwners.set(track, el);
                    return el;
                }
            }
            const now = Date.now();
            if (now - lastFallbackScanAt >= FALLBACK_SCAN_INTERVAL) {
                lastFallbackScanAt = now;
                state.diagnostics.fallbackScans++;
                const candidates = document.querySelectorAll('[data-testid="autoscroll-viewport"], [class*="overflow-"], [style*="overflow"]');
                const limit = Math.min(candidates.length, FALLBACK_SCAN_LIMIT);
                for (let i = 0; i < limit; i++) {
                    const el = candidates[i];
                    if (matchesTrackOwner(el, tr, horizontal)) {
                        trackOwners.set(track, el);
                        rememberScrollable(el);
                        return el;
                    }
                }
            }
            return null;
        };

        const isFixedContainingBlock = cs => (
            cs.transform !== 'none' ||
            (cs.translate && cs.translate !== 'none') ||
            (cs.rotate && cs.rotate !== 'none') ||
            (cs.scale && cs.scale !== 'none') ||
            (cs.perspective && cs.perspective !== 'none') ||
            cs.filter !== 'none' ||
            cs.backdropFilter !== 'none' ||
            /\b(?:paint|layout|strict|content)\b/.test(cs.contain || '') ||
            /\b(?:transform|perspective|filter|backdrop-filter|contain)\b/.test(cs.willChange || '')
        );

        const computeClipRect = owner => {
            let left = 0;
            let top = 0;
            let right = window.innerWidth;
            let bottom = window.innerHeight;
            let cs = getComputedStyle(owner);
            let needMode = cs.position === 'fixed' ? 'fixed' : (cs.position === 'absolute' ? 'absolute' : 'none');
            for (let el = owner.parentElement; el && el !== document.documentElement; el = el.parentElement) {
                cs = getComputedStyle(el);
                if (cs.display === 'contents') continue;
                if (needMode === 'fixed') {
                    if (!isFixedContainingBlock(cs)) continue;
                } else if (needMode === 'absolute') {
                    if (cs.position === 'static' && !isFixedContainingBlock(cs)) continue;
                }
                needMode = cs.position === 'fixed' ? 'fixed' : (cs.position === 'absolute' ? 'absolute' : 'none');
                const clipX = cs.overflowX !== 'visible';
                const clipY = cs.overflowY !== 'visible';
                if (clipX || clipY) {
                    const r = el.getBoundingClientRect();
                    const sx = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
                    const sy = el.offsetHeight > 0 ? r.height / el.offsetHeight : 1;
                    const l = r.left + el.clientLeft * sx;
                    const t = r.top + el.clientTop * sy;
                    if (clipX) {
                        left = Math.max(left, l);
                        right = Math.min(right, l + el.clientWidth * sx);
                    }
                    if (clipY) {
                        top = Math.max(top, t);
                        bottom = Math.min(bottom, t + el.clientHeight * sy);
                    }
                }
            }
            return { left, top, right, bottom };
        };

        const syncFloatingScrollbars = () => {
            if (disposed || !document.body) return;
            const tracks = [];
            for (let el = document.body.firstElementChild; el; el = el.nextElementSibling) {
                if (el.hasAttribute('data-overlay-scrollbar-track')) tracks.push(el);
            }
            if (tracks.length === 0) return;

            // Phase 1: read-only layout measurements & clip calculation (avoids layout thrashing)
            const writes = [];
            for (const track of tracks) {
                if (!observedTracks.has(track)) {
                    observedTracks.add(track);
                    trackStyleObserver.observe(track, { attributes: true, attributeFilter: ['style'] });
                }
                const tr = track.getBoundingClientRect();
                if (tr.width <= 0 || tr.height <= 0) continue;
                const inlineZ = Number(track.style.zIndex);
                const currentlyElevated = track.getAttribute('data-ag-ui-elevated-track') === 'true';
                let shouldElevate = currentlyElevated;
                if (Number.isFinite(inlineZ) && inlineZ >= 1000) {
                    shouldElevate = false;
                } else if (!currentlyElevated) {
                    const zVal = Number(getComputedStyle(track).zIndex);
                    if (Number.isFinite(zVal) && zVal > 0 && zVal < 1000) shouldElevate = true;
                }
                const horizontal = track.dataset.orientation === 'horizontal';
                const owner = findTrackOwner(track, tr, horizontal);
                const nextClip = owner ? computeClipInsets(computeClipRect(owner), tr) : '';
                const clipChanged = appliedClip.get(track) !== nextClip || Boolean(track.style.clipPath) !== Boolean(nextClip);
                const elevateChanged = shouldElevate !== currentlyElevated;
                if (clipChanged || elevateChanged) {
                    writes.push({ track, nextClip, clipChanged, shouldElevate, elevateChanged });
                }
            }

            // Phase 2: write-only style updates, draining self-triggered style records
            if (writes.length === 0) return;
            for (const { track, nextClip, clipChanged, shouldElevate, elevateChanged } of writes) {
                if (elevateChanged) {
                    if (shouldElevate) track.setAttribute('data-ag-ui-elevated-track', 'true');
                    else track.removeAttribute('data-ag-ui-elevated-track');
                }
                if (clipChanged) {
                    appliedClip.set(track, nextClip);
                    if (nextClip) track.style.clipPath = nextClip;
                    else track.style.removeProperty('clip-path');
                }
            }
            trackStyleObserver.takeRecords();
        };

        const scheduleFloatingSync = () => {
            if (disposed || syncRafId) return;
            syncRafId = requestAnimationFrame(() => {
                syncRafId = 0;
                if (!disposed) syncFloatingScrollbars();
            });
        };

        const trackStyleObserver = new MutationObserver(scheduleFloatingSync);
        const trackObserver = new MutationObserver(scheduleFloatingSync);

        const onScroll = event => {
            const target = event.target;
            if (target instanceof HTMLElement && target !== document.body && target !== document.documentElement) {
                rememberScrollable(target);
            }
            if (hasFloatingTrack()) scheduleFloatingSync();
        };
        const onPointerOver = event => {
            if (syncRafId || !hasFloatingTrack()) return;
            const target = event.target;
            if (!(target instanceof HTMLElement) || target === document.body || target === document.documentElement) return;
            if (target.childElementCount === 0 || recentScrollableSet.has(target)) return;
            if (target.scrollHeight > target.clientHeight + 1 || target.scrollWidth > target.clientWidth + 1) {
                rememberScrollable(target);
                scheduleFloatingSync();
            }
        };
        const onResize = () => {
            if (hasFloatingTrack()) scheduleFloatingSync();
        };

        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        document.addEventListener('pointerover', onPointerOver, { capture: true, passive: true });
        window.addEventListener('resize', onResize, { passive: true });

        const refreshLease = () => {
            if (disposed) return;
            clearTimeout(lease);
            lease = setTimeout(() => { Promise.resolve(state.dispose()).catch(() => {}); }, 6500);
        };

        const state = {
            version,
            revision,
            owner,
            generation,
            empty: false,
            hasCss: false,
            imageHash: '',
            layout: null,
            titlebar: null,
            titlebarAt: 0,
            diagnostics: { layoutMeasured: false, fallbackScans: 0 },
            measureLayout() {
                const w = window.innerWidth;
                const h = window.innerHeight;
                const insetEl = document.querySelector('.agy-inset-shell');
                const sheetEl = document.querySelector('.agy-sheet');
                const inset = insetEl?.getBoundingClientRect();
                const firstSplitChild = document.querySelector('.agy-inset-shell > [data-split-root] > :first-child');
                const noLeftNav = Boolean(firstSplitChild?.matches('.agy-sheet'));
                const leftNav = firstSplitChild && !noLeftNav ? firstSplitChild.getBoundingClientRect() : null;
                const sidePaneEl = document.querySelector('[data-side-panel-body]') || document.querySelector(rightPane);
                const sidePane = sidePaneEl?.getBoundingClientRect();
                const strip = document.querySelector('[data-side-panel-strip]')?.getBoundingClientRect();
                const measured = computeLayoutMetrics({
                    width: w,
                    height: h,
                    hasHostShell: Boolean(insetEl || sheetEl),
                    insetTop: inset?.top,
                    leftWidth: leftNav?.width,
                    noLeftNav,
                    rightWidth: sidePane?.width,
                    tabStripHeight: strip?.height,
                });
                state.layout = measured;
                state.diagnostics.layoutMeasured = Boolean(measured);
                return measured;
            },
            update({ css: nextCss, image: nextImage, imageHash: nextImageHash, surfaces: options } = {}) {
                refreshLease();
                observeBody();
                state.measureLayout();
                const safeCss = typeof nextCss === 'string' ? nextCss : '';
                const safeHash = typeof nextImageHash === 'string' ? nextImageHash : '';
                state.hasCss = Boolean(safeCss);
                if (safeCss) {
                    if (nextImage !== undefined) {
                        if (typeof nextImage === 'string' && safeImageRe.test(nextImage)) {
                            if (safeHash !== state.imageHash || !imageEl.style.getPropertyValue('--ag-ui-image')) {
                                imageEl.style.setProperty('--ag-ui-image', 'url("' + nextImage + '")');
                                state.imageHash = safeHash;
                            }
                        } else if (nextImage === '') {
                            imageEl.style.removeProperty('--ag-ui-image');
                            state.imageHash = '';
                        }
                    }
                    if (safeCss !== currentCss) {
                        content.replaceSync('.image {' + safeCss + '}');
                        currentCss = safeCss;
                    }
                    if (!layer.isConnected) document.documentElement.append(layer);
                } else {
                    layer.remove();
                    if (currentCss) {
                        content.replaceSync('');
                        currentCss = '';
                    }
                    if (state.imageHash) {
                        imageEl.style.removeProperty('--ag-ui-image');
                        state.imageHash = '';
                    }
                }
                const nextOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
                const signature = JSON.stringify(nextOptions);
                if (signature !== currentSurfaces) {
                    const leftSidebar = computeSurfaceState(nextOptions, 'leftSidebar', 'var(--sidebar,var(--background,#131313))');
                    const sidebar = computeSurfaceState(nextOptions, 'sidebar', 'var(--background,#131313)');
                    const composer = computeSurfaceState(
                        nextOptions,
                        'composer',
                        'var(--background,#131313)',
                        'var(--card-border,var(--color-card-border,var(--glass-border,var(--border,rgba(128,128,128,.22)))))',
                        true
                    );
                    const overview = computeSurfaceState(
                        nextOptions,
                        'overview',
                        'var(--card,var(--background,#131313))',
                        'var(--border,var(--card-border,rgba(128,128,128,.22)))',
                        false
                    );
                    const flatBg = (bg, blur) => 'background:' + bg + ' !important;' + (
                        blur > 0
                            ? 'backdrop-filter:blur(' + blur + 'px) !important;-webkit-backdrop-filter:blur(' + blur + 'px) !important;'
                            : 'backdrop-filter:none !important;-webkit-backdrop-filter:none !important;'
                    );
                    const raisedShadow = rim => 'box-shadow:inset 0 1px 0 var(--ag-ui-highlight-default),0 0 0 1px ' + rim + ',var(--ag-ui-card-shadow) !important;';
                    const outerFrameShadow = border => 'box-shadow:inset 0 0 0 1px ' + border + ',inset 0 1px 2px var(--ag-ui-inset-shadow),var(--ag-ui-drop-shadow) !important;';
                    const leftDocked = '[data-testid="sidebar-split"] > :first-child:has(.bg-sidebar):not(:has([data-peek-surface]))';
                    const leftShell = ':is([data-testid="sidebar-split"] > :first-child:not(:has([data-peek-surface])),[data-testid="sidebar-split"] [data-peek-surface="open"]) .h-full.w-full.flex.flex-col.bg-sidebar,.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"]';
                    const rightBody = '.agy-sheet [data-side-panel-body]:not([data-has-browser-hole="true"])';
                    const anyComposer = '[data-testid="agent-input-box"] .surface-composer';
                    const topComposer = '[data-testid="agent-input-box"] .surface-composer:has(> [data-testid="input-box-bottom-toolbar"])';
                    const baseComposer = '[data-testid="agent-input-box"] .surface-composer:not(:has(> [data-testid="input-box-bottom-toolbar"]))';
                    const overviewHosts = '[data-testid="overview-panel-host-overlay"],[data-testid="overview-panel-host-gutter"],[data-testid="overview-panel-host-sibling"],[data-testid="battle-overview-dropdown"]';
                    // Equal (0,0,0) specificity across :root / light / dark so source order governs overrides.
                    const themeTokens =
                        ':where(:root) { --ag-ui-frame-default:var(--onyx-frame,#0d0d11);--ag-ui-raised-default:var(--onyx-raised,var(--card,var(--background,#131313)));--ag-ui-rim-default:rgba(255,255,255,.12);--ag-ui-highlight-default:rgba(255,255,255,.14);--ag-ui-inset-shadow:rgba(0,0,0,.34);--ag-ui-drop-shadow:0 18px 40px -12px rgba(0,0,0,.44),0 2px 8px -2px rgba(0,0,0,.28);--ag-ui-card-shadow:0 4px 12px -2px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22); }' +
                        ':where(:root:not(.dark):not(.dark-theme):not(.theme-dark):not(.vscode-dark):not([data-theme="dark"]) body[data-agy-theme]:not(.dark):not(.dark-theme):not(.theme-dark):not(.vscode-dark):not([data-theme="dark"]),.vscode-light,[data-theme="light"]) { --ag-ui-frame-default:var(--onyx-frame,#eaedf2);--ag-ui-raised-default:var(--onyx-raised,var(--card,#ffffff));--ag-ui-rim-default:rgba(10,10,12,.11);--ag-ui-highlight-default:rgba(255,255,255,.85);--ag-ui-inset-shadow:rgba(10,10,12,.06);--ag-ui-drop-shadow:0 10px 26px -10px rgba(10,10,12,.14),0 2px 6px -1px rgba(10,10,12,.06);--ag-ui-card-shadow:0 3px 10px -2px rgba(10,10,12,.08),0 1px 3px rgba(10,10,12,.05); }' +
                        ':where(.dark,.dark-theme,.theme-dark,.vscode-dark,[data-theme="dark"]) { --ag-ui-frame-default:color-mix(in srgb,var(--onyx-frame,#111216) 72%,#000);--ag-ui-raised-default:color-mix(in srgb,var(--onyx-raised,var(--card,#1d1e23)) 92%,#fff);--ag-ui-rim-default:rgba(255,255,255,.12);--ag-ui-highlight-default:rgba(255,255,255,.14);--ag-ui-inset-shadow:rgba(0,0,0,.34);--ag-ui-drop-shadow:0 18px 40px -12px rgba(0,0,0,.44),0 2px 8px -2px rgba(0,0,0,.28);--ag-ui-card-shadow:0 4px 12px -2px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22); }';
                    const leftSidebarRules =
                        leftDocked + ' { position:relative;z-index:auto !important; }' +
                        'body[data-has-browser-hole="true"] ' + leftDocked + ':not([data-has-browser-hole="true"]) { background-color:var(--shell-canvas,var(--sidebar,var(--background))) !important;box-shadow:1px 0 0 var(--shell-canvas,var(--sidebar,var(--background))) !important; }' +
                        leftDocked + ' > [data-split-sized] { z-index:1001 !important; }' +
                        leftDocked + ':not(:has(> [data-split-sized])) .h-full.w-full.flex.flex-col.bg-sidebar { position:relative;z-index:1001 !important; }' +
                        '[data-testid="sidebar-split"] .bg-sidebar .bg-sidebar,[data-testid="sidebar-split"] .bg-sidebar .agy-row-actions::before,.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"] .bg-sidebar .bg-sidebar,.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"] .agy-row-actions::before { background:transparent !important; }' +
                        leftShell + ' {' + flatBg(leftSidebar.innerBg, leftSidebar.effectiveBlur) + 'box-shadow:none !important; }';
                    const rightPanelRules =
                        rightPane + ' .browser-hole-ancestor { background:transparent !important; }' +
                        // Only the body rises above the wallpaper. Tabs share the main area's wallpaper treatment.
                        rightBody + ' { position:relative;z-index:1001;' + flatBg(sidebar.innerBg, sidebar.effectiveBlur) + 'box-shadow:none !important; }' +
                        rightBody + ' :is([data-testid="subagent-tab-sidebar"],[data-testid="terminals-and-tasks-sidebar"]) { background:transparent !important; }';
                    const composerRules = composer.layered
                        ? anyComposer + ' { padding:4px !important;border-radius:calc(var(--nux-composer-radius,20px) + 4px) !important;' + flatBg(composer.outerBg, composer.effectiveBlur) + outerFrameShadow(composer.outerBorder) + ' }' +
                          anyComposer + ' .surface-composer-card { border-radius:var(--nux-composer-radius,20px) !important;background:' + composer.innerBg + ' !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;' + raisedShadow(composer.innerRim) + ' }' +
                          anyComposer + ':focus-within > .surface-composer-card { box-shadow:inset 0 1px 0 var(--ag-ui-highlight-default),0 0 0 1px ' + composer.innerRim + ',var(--ag-ui-drop-shadow) !important; }'
                        : topComposer + ' {' + flatBg(composer.innerBg, composer.effectiveBlur) + 'box-shadow:inset 0 0 0 1px ' + composer.outerBorder + ' !important; }' +
                          topComposer + ' .surface-composer-card { background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:none !important; }' +
                          baseComposer + ' { background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:inset 0 0 0 1px ' + composer.outerBorder + ' !important; }' +
                          baseComposer + ' .surface-composer-card {' + flatBg(composer.innerBg, composer.effectiveBlur) + 'box-shadow:none !important; }';
                    const bubbleRules = composer.layered
                        ? '.agy-user-bubble-frame { padding:3px !important;border-radius:calc(var(--nux-composer-radius,20px) + 3px) !important;' + flatBg(composer.outerBg, composer.effectiveBlur) + outerFrameShadow(composer.outerBorder) + ' }' +
                          '.agy-user-bubble { border-radius:var(--nux-composer-radius,20px) !important;background:' + composer.innerBg + ' !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;' + raisedShadow(composer.innerRim) + ' }'
                        : '.agy-user-bubble-frame { background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:inset 0 0 0 1px ' + composer.outerBorder + ' !important; }' +
                          '.agy-user-bubble {' + flatBg(composer.innerBg, composer.effectiveBlur) + 'box-shadow:none !important; }';
                    const overviewRules =
                        overviewHosts + ' { z-index:1002 !important;' + flatBg(overview.innerBg, overview.effectiveBlur) + 'border-color:' + overview.outerBorder + ' !important;box-shadow:none !important; }';
                    layout.replaceSync(
                        themeTokens +
                        '#antigravity-ui-background { position:fixed; inset:0; z-index:1000; pointer-events:none; overflow:hidden; contain:paint; }' +
                        '.agy-sheet { z-index:auto !important; }' +
                        rightPane + ' { position:relative; z-index:auto !important; }' +
                        rightPane + ' > .h-full.w-full { z-index:auto !important; }' +
                        leftSidebarRules +
                        rightPanelRules +
                        '.agy-sheet[data-side-panel-maximized] [data-side-panel-body]:not([data-has-browser-hole="true"]),.agy-sheet:is([data-side-panel-maximized],:has(> [data-split-root] > [data-split-overlaid="true"])) [data-side-panel-strip] { position:relative; z-index:1002 !important; }' +
                        '[data-side-panel-body][data-has-browser-hole="true"] { background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important; }' +
                        '.agy-sheet > .pointer-events-none.overflow-clip { z-index:1002 !important; }' +
                        '.agy-sheet > .pointer-events-none.overflow-clip > div:has(iframe[data-testid="sidecar-iframe"]) { background:transparent !important; }' +
                        '.agy-inset-shell > .absolute.left-0.top-0,.agy-inset-shell > .absolute.right-0,[data-testid="sidebar-peek-hot-zone"],[data-testid="sidebar-split"] [data-split-sized]:has([data-peek-surface="open"]),.agy-inset-shell > [data-testid="sidebar-popover-backdrop"],.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"],.fixed.z-40:has(> [data-testid="voice-dock-composer"]) { z-index:1003 !important; }' +
                        '.agy-inset-shell > .absolute.right-0 > div { background:transparent !important; }' +
                        '.agy-inset-shell > .absolute.right-0 > div > .right-full { background:none !important; }' +
                        '.agy-sheet .relative.z-10:has([data-testid="agent-input-box"]),.agy-sheet .z-\\[1\\]:has([data-testid="agent-input-box"]) { z-index:1001 !important; }' +
                        composerRules +
                        // Required per CSS Filter Effects L2: host `isolation: isolate` establishes a Backdrop Root
                        // that blocks user-bubble backdrop-filter; `position: relative; z-index: 1001` does not.
                        '[data-testid="autoscroll-viewport"] { isolation:auto !important;position:relative;z-index:1001 !important;' +
                        (composer.cover && composer.effectiveBlur > 0 ? 'mask-image:none !important;-webkit-mask-image:none !important;' : '') + ' }' +
                        ':is([data-testid="side-question-tab-conversation"],[data-testid="subagent-tab-conversation"],[data-testid="conversation-view"] > .relative.min-h-0) > .absolute.bottom-0.z-10.pointer-events-none { background:none !important; }' +
                        '[data-testid="autoscroll-viewport"] ~ [data-testid="overlay-scrollbar"],[data-testid="autoscroll-viewport"] ~ .agy-scroll-bottom,[data-testid="bottom-terminal-panel-resize-handle"],body > [data-overlay-scrollbar-track]:is([style*="z-index: 51"],[style*="z-index:51"],[data-ag-ui-elevated-track="true"]) { z-index:1001 !important; }' +
                        '[data-testid="conversation-view"] > .pointer-events-none.inset-y-0.left-0:has(> [data-testid="conversation-navigator"]),[data-testid="conversation-navigator"],[data-testid="conversation-view"] .sticky.top-0:has([data-testid="find-bar-match-count"]),[data-main-content-body] .absolute.top-4.right-4:has(> button:is([aria-label="Close"],[aria-label="关闭"],[data-testid*="close"])),.selection-popup,[data-comment-bubble-popover="true"],[data-testid="pdf-selected-annotation-popover"],[data-testid="comment-box"].absolute { z-index:1002 !important; }' +
                        '[data-main-content-body] [data-split-sized]:not(:has(> [data-peek-surface])) { z-index:auto !important; }' +
                        bubbleRules +
                        '[data-testid="overview-panel-overlay-backdrop"] { z-index:1002 !important; }' +
                        overviewRules +
                        '[data-main-content-body]:not([data-has-browser-hole="true"]) { clip-path:none !important;box-shadow:none !important; }' +
                        '[data-split-fill-edge]:not([data-has-browser-hole="true"]):not([data-split-overlaid="true"]) { clip-path:none !important; }' +
                        '[data-split-sash],[data-testid="tiling-splitter"] { z-index:1003 !important;background:transparent !important;background-image:none !important; }' +
                        ':is(.agy-sheet[data-sheet-inset] [data-main-content-body],[data-split-panes] .agy-sheet[data-sheet-inset] [data-tiling-pane][data-edge-left],.agy-sheet[data-side-panel-maximized] [data-side-panel-body])::before { z-index:1002 !important; }'
                    );
                    currentSurfaces = signature;
                }
                syncFloatingScrollbars();
                refreshLease();
            },
            async syncTitlebar(force = false) {
                const base = shellColors();
                const overlay = state.hasCss ? { color: '#00000000', symbolColor: base.symbolColor } : base;
                if (!force &&
                    state.titlebar?.color === overlay.color &&
                    state.titlebar?.symbolColor === overlay.symbolColor &&
                    Date.now() - state.titlebarAt < 1000) return;
                const setter = window.electronNative?.setTitleBarOverlay;
                if (typeof setter !== 'function') return;
                await setter.call(window.electronNative, overlay);
                if (!disposed && window[key] === state) {
                    state.titlebar = overlay;
                    state.titlebarAt = Date.now();
                }
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                clearTimeout(lease);
                if (syncRafId) {
                    cancelAnimationFrame(syncRafId);
                    syncRafId = 0;
                }
                observer.disconnect();
                trackObserver.disconnect();
                trackStyleObserver.disconnect();
                trackStyleObserver.takeRecords();
                document.removeEventListener('scroll', onScroll, { capture: true });
                document.removeEventListener('pointerover', onPointerOver, { capture: true });
                window.removeEventListener('resize', onResize);
                recentScrollables.length = 0;
                for (const track of document.body?.querySelectorAll(':scope > [data-overlay-scrollbar-track]') || []) {
                    track.style.removeProperty('clip-path');
                    track.removeAttribute('data-ag-ui-elevated-track');
                }
                layer.remove();
                document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== layout);
                if (window[key] === state) delete window[key];
                return window.electronNative?.setTitleBarOverlay?.(shellColors());
            },
        };

        let currentTheme = themeSignature();
        const observer = new MutationObserver(() => {
            observeBody();
            const nextTheme = themeSignature();
            if (nextTheme === currentTheme) return;
            currentTheme = nextTheme;
            if (!disposed && window[key] === state && state.hasCss) {
                Promise.resolve(state.syncTitlebar(true)).catch(() => {});
            }
        });
        const observeBody = () => {
            if (bodyObserved || !document.body) return;
            observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-agy-theme'] });
            trackObserver.observe(document.body, { childList: true });
            syncFloatingScrollbars();
            bodyObserved = true;
        };
        observer.observe(document.documentElement, {
            childList: !document.body,
            attributes: true,
            attributeFilter: ['style', 'class', 'data-theme'],
        });
        observeBody();
        window[key] = state;
    }

    const activeState = window[key];
    if (!activeState || !isCurrent(activeState) || shouldIgnoreLease(activeState, incoming)) {
        return 'IGNORED';
    }
    try {
        activeState.owner = owner;
        activeState.generation = generation;
        activeState.update({ css, image, imageHash, surfaces });
    } catch (error) {
        if (created) await activeState.dispose?.();
        throw error;
    }
    await activeState.syncTitlebar();
    return window[key] === activeState ? 'OK' : 'IGNORED';
}

const exportedHelpers = await installWallpaper({ __inspectHelpers: true });
export const RENDERER_VERSION = exportedHelpers.version;
export const RENDERER_REVISION = exportedHelpers.revision;
export const shouldIgnoreLease = exportedHelpers.shouldIgnoreLease;
export const normalizeColor = exportedHelpers.normalizeColor;
export const computeSurfaceState = exportedHelpers.computeSurfaceState;
export const computeLayoutMetrics = exportedHelpers.computeLayoutMetrics;
export const matchesTrackGeometry = exportedHelpers.matchesTrackGeometry;
export const computeClipInsets = exportedHelpers.computeClipInsets;
