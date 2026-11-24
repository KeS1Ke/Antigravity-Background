// The wallpaper stays viewport-sized. Sidebar surfaces change stacking, so
// opening a pane never changes the image's dimensions, crop or position.
export async function installWallpaper(payload = {}) {
    // v18 checks this protocol version before honoring another owner's lease.
    const version = 18;
    const revision = 34;

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
        const detectHostColorScheme = () => {
            const cs = getComputedStyle(document.documentElement).colorScheme || '';
            if (cs === 'dark' || cs === 'light') return cs;
            const root = document.documentElement;
            const body = document.body;
            if (root.classList.contains('dark') || root.dataset.theme === 'dark' ||
                body?.classList.contains('dark') || body?.dataset.theme === 'dark' ||
                Boolean(document.querySelector('.agy-shell')?.closest('.dark'))) {
                return 'dark';
            }
            return 'light';
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
        let lastMeasureAt = 0;
        let aspectToken = 0;
        let aspectScheduleId = 0;
        let aspectScheduleIsIdle = false;
        const cancelAspectSchedule = () => {
            if (!aspectScheduleId) return;
            if (aspectScheduleIsIdle && typeof cancelIdleCallback === 'function') cancelIdleCallback(aspectScheduleId);
            else clearTimeout(aspectScheduleId);
            aspectScheduleId = 0;
            aspectScheduleIsIdle = false;
        };
        const syncImageAspect = src => {
            const token = ++aspectToken;
            cancelAspectSchedule();
            if (!src) {
                layer.style.removeProperty('--ag-ui-image-aspect');
                return;
            }
            const runProbe = () => {
                aspectScheduleId = 0;
                aspectScheduleIsIdle = false;
                if (disposed || token !== aspectToken) return;
                const probe = new Image();
                probe.onload = () => {
                    if (disposed || token !== aspectToken || !probe.naturalWidth || !probe.naturalHeight) return;
                    layer.style.setProperty('--ag-ui-image-aspect', String(Number((probe.naturalWidth / probe.naturalHeight).toFixed(6))));
                };
                probe.onerror = () => {
                    if (disposed || token !== aspectToken) return;
                    layer.style.removeProperty('--ag-ui-image-aspect');
                };
                probe.src = src;
            };
            if (typeof requestIdleCallback === 'function') {
                aspectScheduleIsIdle = true;
                aspectScheduleId = requestIdleCallback(runProbe, { timeout: 200 });
            } else {
                aspectScheduleId = setTimeout(runProbe, 0);
            }
        };

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
            state.measureLayout();
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
            hostColorScheme: detectHostColorScheme(),
            titlebar: null,
            titlebarHasCss: null,
            titlebarAt: 0,
            pendingShellColors: null,
            diagnostics: { layoutMeasured: false, fallbackScans: 0 },
            measureLayout() {
                lastMeasureAt = Date.now();
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
                const now = Date.now();
                const safeCss = typeof nextCss === 'string' ? nextCss : '';
                const safeHash = typeof nextImageHash === 'string' ? nextImageHash : '';
                const nextHasCss = Boolean(safeCss);
                // Read layout & shell colors before writing DOM/adoptedStyleSheets to avoid forced sync style recalc.
                state.hostColorScheme = detectHostColorScheme();
                if (!state.layout || now - lastMeasureAt >= 2000) state.measureLayout();
                state.pendingShellColors = (!state.titlebar || state.titlebarHasCss !== nextHasCss || now - state.titlebarAt >= 1000)
                    ? shellColors()
                    : null;
                state.hasCss = nextHasCss;
                if (safeCss) {
                    if (nextImage !== undefined) {
                        if (typeof nextImage === 'string' && safeImageRe.test(nextImage)) {
                            const currentUrl = imageEl.style.getPropertyValue('--ag-ui-image');
                            let nextUrl;
                            const imageChanged = safeHash
                                ? (safeHash !== state.imageHash || !currentUrl)
                                : (currentUrl !== (nextUrl = 'url("' + nextImage + '")'));
                            if (imageChanged) {
                                imageEl.style.setProperty('--ag-ui-image', nextUrl ?? ('url("' + nextImage + '")'));
                                state.imageHash = safeHash;
                                syncImageAspect(nextImage);
                            }
                        } else if (nextImage === '') {
                            imageEl.style.removeProperty('--ag-ui-image');
                            state.imageHash = '';
                            syncImageAspect('');
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
                    if (state.imageHash || imageEl.style.getPropertyValue('--ag-ui-image')) {
                        imageEl.style.removeProperty('--ag-ui-image');
                        state.imageHash = '';
                        syncImageAspect('');
                    }
                }
                const nextOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
                const signature = JSON.stringify(nextOptions);
                const surfacesChanged = signature !== currentSurfaces;
                if (surfacesChanged) {
                    const borderDefault = 'var(--card-border,var(--color-card-border,var(--glass-border,var(--border,rgba(128,128,128,.22)))))';
                    const leftSidebar = computeSurfaceState(nextOptions, 'leftSidebar', 'var(--sidebar,var(--background,#131313))');
                    const sidebar = computeSurfaceState(nextOptions, 'sidebar', 'var(--background,#131313)');
                    const composer = computeSurfaceState(nextOptions, 'composer', 'var(--background,#131313)', borderDefault, true);
                    const bubble = computeSurfaceState(nextOptions, 'bubble', 'var(--background,#131313)', borderDefault, true);
                    const selectedRow = computeSurfaceState(nextOptions, 'selectedRow', 'var(--sidebar,var(--background,#131313))', borderDefault, true);
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
                    const hollowRing = (bg, pad, zIndex) =>
                        'content:"" !important;position:absolute !important;inset:0 !important;z-index:' + zIndex + ' !important;pointer-events:none !important;border-radius:inherit !important;box-sizing:border-box !important;padding:' + pad + ' !important;background:' + bg + ' !important;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0) !important;-webkit-mask-composite:xor !important;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0) !important;mask-composite:exclude !important;';
                    const raisedShadow = rim => 'box-shadow:inset 0 1px 0 var(--ag-ui-highlight-default),0 0 0 1px ' + rim + ',var(--ag-ui-card-shadow) !important;';
                    const outerFrameShadow = border => 'box-shadow:inset 0 0 0 1px ' + border + ',inset 0 1px 2px var(--ag-ui-inset-shadow),var(--ag-ui-drop-shadow) !important;';
                    const leftDocked = '[data-testid="sidebar-split"] > :first-child:has(.bg-sidebar):not(:has([data-peek-surface]))';
                    const leftShell = ':is([data-testid="sidebar-split"] > :first-child:not(:has([data-peek-surface])),[data-testid="sidebar-split"] [data-peek-surface="open"]) .h-full.w-full.flex.flex-col.bg-sidebar,.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"]';
                    const leftSidebarScope = ':is([data-testid="sidebar-split"],.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"])';
                    const activeSidebarRow = leftSidebarScope + ' .agy-sidebar-row:is(:hover,:focus-visible,:has(:focus-visible),:has(.agy-row-actions [aria-expanded="true"]))';
                    const selectedSidebarRow = leftSidebarScope + ' .agy-sidebar-row[data-selected="true"]';
                    const selectedSidebarRowHost = leftSidebarScope + ' [data-sidebar-row-id]:has(.agy-sidebar-row[data-selected="true"])';
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
                        activeSidebarRow + ' .agy-row-actions:not(:empty) { position:relative !important;inset:auto !important;padding-left:0 !important;height:16px !important;margin-right:-4px !important; }' +
                        activeSidebarRow + ':has(.agy-row-actions:not(:empty)) .agy-row-status { display:none !important; }' +
                        leftShell + ' {' + flatBg(leftSidebar.innerBg, leftSidebar.effectiveBlur) + 'box-shadow:none !important; }';
                    const rightPanelRules =
                        rightPane + ' .browser-hole-ancestor { background:transparent !important; }' +
                        // Only the body and strip foreground items rise above the wallpaper; strip container stays below to share main wallpaper treatment.
                        rightBody + ' { position:relative;z-index:1001;' + flatBg(sidebar.innerBg, sidebar.effectiveBlur) + 'box-shadow:none !important; }' +
                        rightBody + ' :is([data-testid="subagent-tab-sidebar"],[data-testid="terminals-and-tasks-sidebar"]) { background:transparent !important; }';
                    const composerRules = composer.layered
                        ? anyComposer + ' { position:relative !important;z-index:0 !important;padding:4px !important;border-radius:calc(var(--nux-composer-radius,20px) + 4px) !important;' + flatBg('transparent', composer.effectiveBlur) + outerFrameShadow(composer.outerBorder) + ' }' +
                          anyComposer + '::before {' + hollowRing(composer.outerBg, '4px', -1) + ' }' +
                          anyComposer + ' .surface-composer-card { border-radius:var(--nux-composer-radius,20px) !important;background:' + composer.innerBg + ' !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;' + raisedShadow(composer.innerRim) + ' }' +
                          anyComposer + ':focus-within > .surface-composer-card { box-shadow:inset 0 1px 0 var(--ag-ui-highlight-default),0 0 0 1px ' + composer.innerRim + ',var(--ag-ui-drop-shadow) !important; }'
                        : anyComposer + '::before { content:none !important; }' +
                          topComposer + ' {' + flatBg(composer.innerBg, composer.effectiveBlur) + 'box-shadow:inset 0 0 0 1px ' + composer.outerBorder + ' !important; }' +
                          topComposer + ' .surface-composer-card { background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:none !important; }' +
                          baseComposer + ' { background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:inset 0 0 0 1px ' + composer.outerBorder + ' !important; }' +
                          baseComposer + ' .surface-composer-card {' + flatBg(composer.innerBg, composer.effectiveBlur) + 'box-shadow:none !important; }';
                    const bubbleRules = bubble.layered
                        ? '.agy-user-bubble-frame { position:relative !important;z-index:0 !important;padding:3px !important;border-radius:calc(var(--nux-composer-radius,20px) + 3px) !important;' + flatBg('transparent', bubble.effectiveBlur) + outerFrameShadow(bubble.outerBorder) + ' }' +
                          '.agy-user-bubble-frame::before {' + hollowRing(bubble.outerBg, '3px', -1) + ' }' +
                          '.agy-user-bubble { border-radius:var(--nux-composer-radius,20px) !important;background:' + bubble.innerBg + ' !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;' + raisedShadow(bubble.innerRim) + ' }'
                        : '.agy-user-bubble-frame::before { content:none !important; }' +
                          '.agy-user-bubble-frame { background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:inset 0 0 0 1px ' + bubble.outerBorder + ' !important; }' +
                          '.agy-user-bubble {' + flatBg(bubble.innerBg, bubble.effectiveBlur) + 'box-shadow:none !important; }';
                    const selectedRowRules =
                        selectedSidebarRowHost + ' { z-index:2 !important; }' +
                        selectedSidebarRow + '.py-1\\.5 { padding-top:6px !important; }' +
                        selectedSidebarRow + '.py-2 { padding-top:8px !important; }' +
                        selectedSidebarRow + '.py-3 { padding-top:12px !important; }' +
                        (selectedRow.layered
                            ? selectedSidebarRow + ' { position:relative !important;z-index:1 !important;border-top:0 !important;background-clip:border-box !important;--row-bg:transparent !important;border-radius:var(--nux-radius-md,12px) !important;' + flatBg('transparent', selectedRow.effectiveBlur) + outerFrameShadow(selectedRow.outerBorder) + ' }' +
                              selectedSidebarRow + '::after {' + hollowRing(selectedRow.outerBg, '3px', -2) + ' }' +
                              selectedSidebarRow + '::before { content:"" !important;position:absolute !important;inset:3px !important;z-index:-1 !important;pointer-events:none !important;border-radius:calc(var(--nux-radius-md,12px) - 3px) !important;background:' + selectedRow.innerBg + ' !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;' + raisedShadow(selectedRow.innerRim) + ' }'
                            : selectedSidebarRow + ' { position:relative !important;z-index:1 !important;border-top:0 !important;background-clip:border-box !important;--row-bg:transparent !important;' + flatBg(selectedRow.innerBg, selectedRow.effectiveBlur) + 'box-shadow:inset 0 0 0 1px ' + selectedRow.outerBorder + ' !important; }' +
                              selectedSidebarRow + '::before,' + selectedSidebarRow + '::after { content:none !important; }');
                    const overviewRules =
                        overviewHosts + ' { z-index:1002 !important;' + flatBg(overview.innerBg, overview.effectiveBlur) + 'border-color:' + overview.outerBorder + ' !important;box-shadow:none !important; }';
                    layout.replaceSync(
                        themeTokens +
                        '#antigravity-ui-background { position:fixed; inset:0; z-index:1000; pointer-events:none; overflow:hidden; contain:paint; container-type:size; }' +
                        '.agy-sheet { z-index:auto !important; }' +
                        rightPane + ' { position:relative; z-index:auto !important; }' +
                        rightPane + ' > .h-full.w-full { z-index:auto !important; }' +
                        leftSidebarRules +
                        rightPanelRules +
                        '.agy-sheet[data-side-panel-maximized] [data-side-panel-body]:not([data-has-browser-hole="true"]),.agy-sheet:is([data-side-panel-maximized],:has(> [data-split-root] > [data-split-overlaid="true"])) [data-side-panel-strip] { position:relative; z-index:1002 !important; }' +
                        '[data-side-panel-body][data-has-browser-hole="true"] { background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important; }' +
                        '.agy-sheet > .pointer-events-none.overflow-clip { z-index:1002 !important; }' +
                        '.agy-sheet > .pointer-events-none.overflow-clip > :is([data-testid="sidecar-iframe-slot"],[data-testid="mcp-app-frame-slot"],div:has(iframe)) { background:transparent !important; }' +
                        '.agy-sheet > .pointer-events-none.overflow-clip iframe,[data-side-panel-body]:not([data-has-browser-hole="true"]) iframe { background:transparent !important; }' +
                        'iframe[data-ag-ui-iframe-scheme="light"] { color-scheme:light !important; }' +
                        'iframe[data-ag-ui-iframe-scheme="dark"] { color-scheme:dark !important; }' +
                        '.agy-inset-shell > .absolute.left-0.top-0,.agy-inset-shell > .absolute.right-0,[data-testid="sidebar-peek-hot-zone"],[data-testid="sidebar-split"] [data-split-sized]:has([data-peek-surface="open"]),.agy-inset-shell > [data-testid="sidebar-popover-backdrop"],.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"],.fixed.z-40:has(> [data-testid="voice-dock-composer"]) { z-index:1003 !important; }' +
                        '.agy-inset-shell > .absolute.right-0 > div { background:transparent !important; }' +
                        '.agy-inset-shell > .absolute.right-0 > div > .right-full { background:none !important; }' +
                        '[data-testid="title-menu-bar"] [data-testid="title-menu-bar-item"],[data-main-content-header]:not([data-has-browser-hole="true"]) > *,[data-side-panel-strip]:not([data-has-browser-hole="true"]) > *,.agy-sheet .agy-home { position:relative;z-index:1001 !important; }' +
                        '.agy-sheet .relative.z-10:has([data-testid="agent-input-box"]),.agy-sheet .z-\\[1\\]:has([data-testid="agent-input-box"]) { z-index:1001 !important; }' +
                        composerRules +
                        // Required per CSS Filter Effects L2: host `isolation: isolate` establishes a Backdrop Root
                        // that blocks user-bubble backdrop-filter; `position: relative; z-index: 1001` does not.
                        '[data-testid="autoscroll-viewport"] { isolation:auto !important;position:relative;z-index:1001 !important;' +
                        (bubble.cover && bubble.effectiveBlur > 0 ? 'mask-image:none !important;-webkit-mask-image:none !important;' : '') + ' }' +
                        ':is([data-testid="side-question-tab-conversation"],[data-testid="subagent-tab-conversation"],[data-testid="conversation-view"] > .relative.min-h-0) > .absolute.bottom-0.z-10.pointer-events-none { background:none !important; }' +
                        '[data-testid="autoscroll-viewport"] ~ [data-testid="overlay-scrollbar"],[data-testid="autoscroll-viewport"] ~ .agy-scroll-bottom,[data-testid="bottom-terminal-panel-resize-handle"],body > [data-overlay-scrollbar-track]:is([style*="z-index: 51"],[style*="z-index:51"],[data-ag-ui-elevated-track="true"]) { z-index:1001 !important; }' +
                        '[data-testid="conversation-view"] > .pointer-events-none.inset-y-0.left-0:has(> [data-testid="conversation-navigator"]),[data-testid="conversation-navigator"],[data-testid="conversation-view"] .sticky.top-0:has([data-testid="find-bar-match-count"]),[data-main-content-body] .absolute.top-4.right-4:has(> button:is([aria-label="Close"],[aria-label="关闭"],[data-testid*="close"])),.selection-popup,[data-comment-bubble-popover="true"],[data-testid="pdf-selected-annotation-popover"],[data-testid="comment-box"].absolute { z-index:1002 !important; }' +
                        '[data-main-content-body] [data-split-sized]:not(:has(> [data-peek-surface])) { z-index:auto !important; }' +
                        bubbleRules +
                        selectedRowRules +
                        '[data-testid="overview-panel-overlay-backdrop"] { z-index:1002 !important; }' +
                        overviewRules +
                        '[data-main-content-body]:not([data-has-browser-hole="true"]) { clip-path:none !important;box-shadow:none !important; }' +
                        '[data-split-fill-edge]:not([data-has-browser-hole="true"]):not([data-split-overlaid="true"]) { clip-path:none !important; }' +
                        '[data-split-sash],[data-testid="tiling-splitter"] { z-index:1003 !important;background:transparent !important;background-image:none !important; }' +
                        ':is(.agy-sheet[data-sheet-inset] [data-main-content-body],[data-split-panes] .agy-sheet[data-sheet-inset] [data-tiling-pane][data-edge-left],.agy-sheet[data-side-panel-maximized] [data-side-panel-body])::before { z-index:1002 !important; }'
                    );
                    currentSurfaces = signature;
                }
                if (hasFloatingTrack()) scheduleFloatingSync();
                refreshLease();
            },
            async syncTitlebar(force = false) {
                const prefetched = state.pendingShellColors;
                state.pendingShellColors = null;
                const now = Date.now();
                if (!force &&
                    state.titlebar &&
                    state.titlebarHasCss === state.hasCss &&
                    now - state.titlebarAt < 1000) return;
                const base = (!force && prefetched) ? prefetched : shellColors();
                const overlay = state.hasCss ? { color: '#00000000', symbolColor: base.symbolColor } : base;
                if (!force &&
                    state.titlebar?.color === overlay.color &&
                    state.titlebar?.symbolColor === overlay.symbolColor &&
                    now - state.titlebarAt < 1000) return;
                const setter = window.electronNative?.setTitleBarOverlay;
                if (typeof setter !== 'function') return;
                await setter.call(window.electronNative, overlay);
                if (!disposed && window[key] === state) {
                    state.titlebar = overlay;
                    state.titlebarHasCss = state.hasCss;
                    state.titlebarAt = Date.now();
                }
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                aspectToken++;
                cancelAspectSchedule();
                state.pendingShellColors = null;
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
                for (const frame of document.querySelectorAll('iframe[data-ag-ui-iframe-scheme], iframe[data-ag-ui-frame-id]')) {
                    frame.removeAttribute('data-ag-ui-iframe-scheme');
                    frame.removeAttribute('data-ag-ui-frame-id');
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
            state.hostColorScheme = detectHostColorScheme();
            if (!disposed && window[key] === state && state.hasCss) {
                Promise.resolve(state.syncTitlebar(true)).catch(() => {});
            }
        });
        const observeBody = () => {
            if (bodyObserved || !document.body) return;
            observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-agy-theme'] });
            trackObserver.observe(document.body, { childList: true });
            if (hasFloatingTrack()) scheduleFloatingSync();
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

// Self-contained surface adapter injected via CDP into right-sidebar plugin
// iframes (Sidecar UI plugins and MCP Apps). Zero external closures so
// installPluginPanelSurface.toString() can be evaluated directly inside OOPIFs.
export async function installPluginPanelSurface(payload = {}) {
    const version = 18;
    const revision = 34;

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
            return !incoming.enabled && activeGeneration > incomingGeneration;
        }
        if (activeGeneration !== incomingGeneration) return activeGeneration > incomingGeneration;
        return activeOwner > incomingOwner;
    };

    const createColorHelpers = () => {
        const cssNumRe = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;
        const rgbRe = /^rgba?\(\s*([^\s,/]+)[,\s]+([^\s,/]+)[,\s]+([^\s,/]+)(?:\s*[,/]\s*([^\s)]+))?\s*\)$/i;
        const srgbRe = /^color\(\s*srgb\s+([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)(?:\s*\/\s*([^\s)]+))?\s*\)$/i;
        const cssColor4Re = /^(?:color|oklab|oklch|lab|lch)\(/i;
        let colorCtx = null;

        const parseChannel = (token, scale = 255) => {
            if (typeof token !== 'string' || !cssNumRe.test(token)) return Number.NaN;
            const isPct = token.endsWith('%');
            const num = Number(isPct ? token.slice(0, -1) : token);
            if (!Number.isFinite(num)) return Number.NaN;
            const value = isPct ? (num / 100) * scale : (scale === 255 ? num : num * scale);
            return Math.min(scale, Math.max(0, value));
        };

        const parseAlpha = token => {
            if (token === undefined) return 1;
            if (typeof token !== 'string' || !cssNumRe.test(token)) return Number.NaN;
            const isPct = token.endsWith('%');
            const num = Number(isPct ? token.slice(0, -1) : token);
            if (!Number.isFinite(num)) return Number.NaN;
            return Math.min(1, Math.max(0, isPct ? num / 100 : num));
        };

        const parseRgba = value => {
            if (typeof value !== 'string') return null;
            const trimmed = value.trim();
            if (!trimmed || trimmed === 'transparent' || trimmed === 'none') return { r: 0, g: 0, b: 0, a: 0 };
            let match = trimmed.match(rgbRe);
            if (match) {
                const r = Math.round(parseChannel(match[1], 255));
                const g = Math.round(parseChannel(match[2], 255));
                const b = Math.round(parseChannel(match[3], 255));
                const a = parseAlpha(match[4]);
                if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
                    return { r, g, b, a };
                }
            }
            match = trimmed.match(srgbRe);
            if (match) {
                const r = Math.round(parseChannel(match[1], 1) * 255);
                const g = Math.round(parseChannel(match[2], 1) * 255);
                const b = Math.round(parseChannel(match[3], 1) * 255);
                const a = parseAlpha(match[4]);
                if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
                    return { r, g, b, a };
                }
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
                    return { r, g, b, a: a / 255 };
                }
            }
            return null;
        };

        const colorDist = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
        const saturation = c => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
        const luminance = c => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
        const formatRgb = c => `rgb(${c.r}, ${c.g}, ${c.b})`;
        const computePluginSurfaceMetrics = (alpha, blur) => {
            const safeAlpha = Number.isFinite(alpha) ? Math.min(100, Math.max(0, Math.round(alpha))) : 100;
            const safeBlur = Number.isFinite(blur) ? Math.min(30, Math.max(0, Math.round(blur))) : 0;
            return {
                alpha: safeAlpha,
                blur: safeBlur,
                cardAlpha: Math.round(58 + safeAlpha * 0.42),
                stickyAlpha: Math.round(12 + safeAlpha * 0.28),
                stickyBlur: Math.max(8, safeBlur),
            };
        };

        const hasLargeSpreadShadow = boxShadow => {
            if (!boxShadow || boxShadow === 'none') return false;
            const matches = boxShadow.match(/([+-]?\d+(?:\.\d+)?)px/g);
            if (!matches) return false;
            for (const token of matches) {
                if (Math.abs(Number.parseFloat(token)) >= 100) return true;
            }
            return false;
        };

        return { parseRgba, colorDist, saturation, luminance, formatRgb, computePluginSurfaceMetrics, hasLargeSpreadShadow };
    };

    if (typeof window === 'undefined' && payload?.__inspectHelpers === true) {
        return { version, revision, shouldIgnoreLease, ...createColorHelpers() };
    }

    if (window === window.top) return { value: false, colorScheme: null };
    if (document.documentElement?.dataset?.agUiPanelNative === 'true') {
        return { value: 'NATIVE', colorScheme: null };
    }

    const { enabled = false, owner = '', generation = 0, sidebar = {}, hostColorScheme = 'dark' } = payload;
    const rawAlpha = sidebar.cover === false ? 0 : (Number.isFinite(sidebar.alpha) ? Math.min(100, Math.max(0, Math.round(sidebar.alpha))) : 100);
    const rawBlur = sidebar.cover === false ? 0 : (Number.isFinite(sidebar.blur) ? Math.min(30, Math.max(0, Math.round(sidebar.blur))) : 0);
    const activeEnabled = Boolean(enabled && rawAlpha < 100);
    const key = '__antigravityUiPluginSurface';
    const incoming = { version, revision, owner, generation, enabled: activeEnabled };
    const isCurrent = item => item?.version === version && item.revision === revision && !item.empty;

    const active = window[key];
    if (shouldIgnoreLease(active, incoming)) return { value: 'IGNORED', colorScheme: null };

    if (!activeEnabled) {
        let attempts = 0;
        while (window[key] && attempts++ < 4) {
            const existing = window[key];
            if (shouldIgnoreLease(existing, incoming)) return { value: 'IGNORED', colorScheme: null };
            await existing.dispose?.();
        }
        if (window[key]) return { value: 'IGNORED', colorScheme: null };
        let lease;
        let disposed = false;
        const placeholder = {
            version, revision, owner, generation, empty: true,
            dispose() {
                if (disposed) return;
                disposed = true;
                clearTimeout(lease);
                if (window[key] === placeholder) delete window[key];
            },
        };
        window[key] = placeholder;
        lease = setTimeout(() => placeholder.dispose(), 6500);
        return { value: 'DISPOSED', colorScheme: null };
    }

    if (active && !isCurrent(active)) {
        let attempts = 0;
        while (window[key] && !isCurrent(window[key]) && attempts++ < 4) {
            const existing = window[key];
            if (shouldIgnoreLease(existing, incoming)) return { value: 'IGNORED', colorScheme: null };
            await existing.dispose?.();
        }
        const postDispose = window[key];
        if (postDispose && (shouldIgnoreLease(postDispose, incoming) || !isCurrent(postDispose))) {
            return { value: 'IGNORED', colorScheme: null };
        }
    }

    let created = false;
    if (!window[key]) {
        created = true;
        const {
            parseRgba,
            colorDist,
            saturation,
            luminance,
            formatRgb,
            computePluginSurfaceMetrics,
            hasLargeSpreadShadow,
        } = createColorHelpers();

        const SKIP_TAGS = new Set([
            'HTML', 'BODY', 'IMG', 'VIDEO', 'CANVAS', 'SVG', 'IFRAME', 'SCRIPT', 'STYLE',
            'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'OPTION', 'OPTGROUP', 'PROGRESS', 'METER',
            'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A', 'CODE', 'KBD', 'MARK', 'DIALOG',
        ]);
        const SKIP_ROLES = new Set([
            'button', 'switch', 'tab', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
            'tooltip', 'dialog', 'alertdialog', 'menu', 'listbox',
        ]);
        const CARD_TAGS = new Set([
            'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'NAV',
            'LI', 'UL', 'OL', 'DETAILS', 'FIELDSET', 'FORM', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
        ]);
        const MAX_SCAN_NODES = 1200;

        const sheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

        let disposed = false;
        let lease;
        let rescanRaf = 0;
        let incrementalRaf = 0;
        let bodyObserved = false;
        let lastMetricsSig = '';
        let lastWasVisible = window.innerWidth > 0 && window.innerHeight > 0;
        let canvasColors = [];
        let primaryCanvas = null;
        let effectiveColorScheme = hostColorScheme === 'light' ? 'light' : 'dark';
        let forceRootScheme = false;
        let currentAlpha = rawAlpha;
        let currentBlur = rawBlur;
        let currentHostScheme = hostColorScheme === 'light' ? 'light' : 'dark';
        const pendingNodes = new Set();

        const refreshLease = () => {
            if (disposed) return;
            clearTimeout(lease);
            lease = setTimeout(() => { Promise.resolve(state.dispose()).catch(() => {}); }, 6500);
        };

        const addCanvasColor = color => {
            if (!color || color.a < 0.9 || saturation(color) > 45) return;
            if (!canvasColors.some(existing => colorDist(existing, color) <= 4)) {
                canvasColors.push(color);
            }
            if (!primaryCanvas) primaryCanvas = color;
        };

        const clearMarks = root => {
            if (!root) return;
            const marked = root.querySelectorAll('[data-ag-ui-surface], [data-ag-ui-clear-shadow]');
            for (const el of marked) {
                el.removeAttribute('data-ag-ui-surface');
                el.removeAttribute('data-ag-ui-clear-shadow');
                el.style.removeProperty('--ag-ui-orig-bg');
            }
        };

        const SKIP_SUBTREE_TAGS = new Set([
            'SVG', 'TEMPLATE', 'SCRIPT', 'STYLE', 'DIALOG', 'IFRAME', 'CANVAS', 'VIDEO', 'SELECT',
        ]);
        const SKIP_SUBTREE_ROLES = new Set([
            'dialog', 'alertdialog', 'menu', 'listbox', 'tooltip',
        ]);
        const isSkippedSubtree = (el, passedCs = null) => {
            if (!el || el.nodeType !== 1) return true;
            if (SKIP_SUBTREE_TAGS.has(el.tagName)) return true;
            if (el.getAttribute('aria-modal') === 'true') return true;
            const role = el.getAttribute('role');
            if (role && SKIP_SUBTREE_ROLES.has(role.toLowerCase())) return true;
            const cs = passedCs || getComputedStyle(el);
            if (cs.position === 'fixed') {
                const bg = parseRgba(cs.backgroundColor);
                const zVal = Number(cs.zIndex);
                const isBackdrop = Boolean(bg && bg.a > 0.05 && bg.a < 0.92);
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const r = (vw > 0 && vh > 0) ? el.getBoundingClientRect() : null;
                const isFullViewport = Boolean(r && r.width >= vw * 0.9 && r.height >= vh * 0.9);
                if (isBackdrop || (!isFullViewport && (Number.isFinite(zVal) ? zVal >= 10 : true))) {
                    return true;
                }
            }
            return false;
        };

        const isExcludedElement = el => {
            if (!el || el.nodeType !== 1) return true;
            if (SKIP_TAGS.has(el.tagName)) return true;
            if (el.getAttribute('aria-modal') === 'true') return true;
            const role = el.getAttribute('role');
            if (role && SKIP_ROLES.has(role.toLowerCase())) return true;
            return false;
        };

        const collectElementWrite = (el, cs) => {
            if (isExcludedElement(el) || el.hasAttribute('data-ag-ui-surface')) return null;
            if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
            const bg = parseRgba(cs.backgroundColor);
            if (!bg || bg.a < 0.92) return null;

            const pos = cs.position;
            const isCanvasMatch = canvasColors.some(c => colorDist(bg, c) <= 8);

            if (pos === 'fixed') {
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                if (vw <= 0 || vh <= 0) return null;
                const rect = el.getBoundingClientRect();
                if (rect.width < vw * 0.9 || rect.height < vh * 0.9) return null;
                return isCanvasMatch ? { el, surface: 'canvas', origBg: '', clearShadow: false } : null;
            }

            if (isCanvasMatch) {
                if (pos === 'sticky') {
                    return {
                        el,
                        surface: 'sticky',
                        origBg: formatRgb(bg),
                        clearShadow: hasLargeSpreadShadow(cs.boxShadow),
                    };
                }
                return { el, surface: 'canvas', origBg: '', clearShadow: false };
            }

            if (!primaryCanvas || !CARD_TAGS.has(el.tagName)) return null;
            if (pos === 'absolute') {
                const zVal = Number(cs.zIndex);
                if (Number.isFinite(zVal) && zVal >= 20) return null;
            }
            if (el.childElementCount === 0 && !el.textContent?.trim()) return null;

            const bgLum = luminance(bg);
            const canvasLum = luminance(primaryCanvas);
            const samePolarity = (bgLum < 0.48 && canvasLum < 0.48) || (bgLum > 0.6 && canvasLum > 0.6);
            if (!samePolarity) return null;
            if (saturation(bg) > 28) return null;
            if (Math.abs(saturation(bg) - saturation(primaryCanvas)) > 20) return null;
            if (colorDist(bg, primaryCanvas) > 36) return null;

            return { el, surface: 'card', origBg: formatRgb(bg), clearShadow: false };
        };

        const applySurfaceWrites = writes => {
            for (const item of writes) {
                item.el.setAttribute('data-ag-ui-surface', item.surface);
                if (item.origBg) item.el.style.setProperty('--ag-ui-orig-bg', item.origBg);
                if (item.clearShadow) item.el.setAttribute('data-ag-ui-clear-shadow', 'true');
            }
        };

        const walkSubtree = (root, budget, writes, visited) => {
            if (!root || root.nodeType !== 1 || budget.left <= 0) return;
            const stack = [root];
            while (stack.length > 0 && budget.left > 0) {
                const node = stack.pop();
                if (!node || node.nodeType !== 1 || visited.has(node)) continue;
                visited.add(node);
                if (SKIP_SUBTREE_TAGS.has(node.tagName) || node.getAttribute('aria-modal') === 'true') continue;
                const role = node.getAttribute('role');
                if (role && SKIP_SUBTREE_ROLES.has(role.toLowerCase())) continue;
                const cs = getComputedStyle(node);
                if (isSkippedSubtree(node, cs)) continue;
                budget.left--;
                const write = collectElementWrite(node, cs);
                if (write) writes.push(write);
                for (let i = node.children.length - 1; i >= 0; i--) {
                    stack.push(node.children[i]);
                }
            }
        };

        const renderStylesheet = () => {
            const metrics = computePluginSurfaceMetrics(currentAlpha, currentBlur);
            const sig = `${metrics.alpha}:${metrics.blur}:${forceRootScheme ? effectiveColorScheme : ''}`;
            if (sig === lastMetricsSig) return;
            lastMetricsSig = sig;
            sheet.replaceSync(
                `:root[data-ag-ui-panel-active="true"] {` +
                `--ag-ui-sidebar-alpha:${metrics.alpha}%;` +
                `--ag-ui-sidebar-blur:${metrics.blur}px;` +
                `--ag-ui-card-alpha:${metrics.cardAlpha}%;` +
                `--ag-ui-sticky-alpha:${metrics.stickyAlpha}%;` +
                `--ag-ui-sticky-blur:${metrics.stickyBlur}px;` +
                (forceRootScheme ? `color-scheme:${effectiveColorScheme};` : '') +
                `}` +
                `html[data-ag-ui-panel-active="true"],html[data-ag-ui-panel-active="true"] > body { background-color:transparent !important;background-image:none !important; }` +
                `html[data-ag-ui-panel-active="true"] [data-ag-ui-surface="canvas"][data-ag-ui-surface="canvas"] { background-color:transparent !important; }` +
                `html[data-ag-ui-panel-active="true"] [data-ag-ui-surface="sticky"][data-ag-ui-surface="sticky"] { background-color:color-mix(in srgb,var(--ag-ui-orig-bg) var(--ag-ui-sticky-alpha),transparent) !important;backdrop-filter:blur(var(--ag-ui-sticky-blur)) !important;-webkit-backdrop-filter:blur(var(--ag-ui-sticky-blur)) !important; }` +
                `html[data-ag-ui-panel-active="true"] [data-ag-ui-clear-shadow="true"][data-ag-ui-clear-shadow="true"] { box-shadow:none !important; }` +
                `html[data-ag-ui-panel-active="true"] [data-ag-ui-surface="card"][data-ag-ui-surface="card"] { background-color:color-mix(in srgb,var(--ag-ui-orig-bg) var(--ag-ui-card-alpha),transparent) !important; }`
            );
        };

        const fullRescan = () => {
            if (disposed || !document.documentElement) return;
            sheet.disabled = true;
            document.documentElement.removeAttribute('data-ag-ui-panel-active');
            clearMarks(document.body);

            canvasColors = [];
            primaryCanvas = null;

            const htmlEl = document.documentElement;
            const bodyEl = document.body;
            const htmlCs = getComputedStyle(htmlEl);
            const bodyCs = bodyEl ? getComputedStyle(bodyEl) : null;
            const bodyBg = bodyCs ? parseRgba(bodyCs.backgroundColor) : null;
            const htmlBg = parseRgba(htmlCs.backgroundColor);

            if (bodyBg) addCanvasColor(bodyBg);
            if (htmlBg) addCanvasColor(htmlBg);

            // Also inspect shallow full-bleed app wrappers (e.g., React #root > div, main.widget)
            if (bodyEl) {
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const shallow = [];
                for (const child of bodyEl.children) {
                    if (child.nodeType !== 1 || SKIP_TAGS.has(child.tagName)) continue;
                    shallow.push(child);
                    if ((child.id === 'root' || child.id === 'app' || child.id === 'board') && child.children.length <= 3) {
                        for (const grand of child.children) {
                            if (grand.nodeType === 1 && !SKIP_TAGS.has(grand.tagName)) shallow.push(grand);
                        }
                    }
                }
                for (const wrapper of shallow) {
                    const wCs = getComputedStyle(wrapper);
                    if (wCs.backgroundImage && wCs.backgroundImage !== 'none') continue;
                    const wBg = parseRgba(wCs.backgroundColor);
                    if (!wBg || wBg.a < 0.9 || saturation(wBg) > 45) continue;
                    if (vw > 0 && vh > 0) {
                        const r = wrapper.getBoundingClientRect();
                        if (r.width >= vw * 0.85 && r.height >= vh * 0.85) {
                            primaryCanvas = wBg;
                            addCanvasColor(wBg);
                            break;
                        }
                    } else if (!primaryCanvas) {
                        addCanvasColor(wBg);
                    }
                }
            }

            const rawScheme = (htmlCs.colorScheme || '').trim().toLowerCase();
            if (rawScheme === 'dark' || rawScheme === 'light') {
                effectiveColorScheme = rawScheme;
                forceRootScheme = false;
            } else {
                const inferred = primaryCanvas
                    ? (luminance(primaryCanvas) < 0.5 ? 'dark' : 'light')
                    : currentHostScheme;
                effectiveColorScheme = inferred;
                forceRootScheme = rawScheme === 'normal' || rawScheme === '';
            }

            const writes = [];
            if (bodyEl) {
                const budget = { left: MAX_SCAN_NODES };
                const visited = new Set();
                for (const child of bodyEl.children) {
                    if (budget.left <= 0) break;
                    walkSubtree(child, budget, writes, visited);
                }
            }
            applySurfaceWrites(writes);

            document.documentElement.setAttribute('data-ag-ui-panel-active', 'true');
            lastMetricsSig = '';
            renderStylesheet();
            sheet.disabled = false;
            state.colorScheme = effectiveColorScheme;
            state.diagnostics.scans++;
        };

        const flushPendingNodes = () => {
            incrementalRaf = 0;
            if (disposed || pendingNodes.size === 0) return;
            if (!primaryCanvas) {
                pendingNodes.clear();
                fullRescan();
                return;
            }
            const batch = [...pendingNodes];
            pendingNodes.clear();
            const budget = { left: MAX_SCAN_NODES };
            const writes = [];
            const visited = new Set();
            for (const root of batch) {
                if (!root || !root.isConnected || budget.left <= 0) continue;
                let blocked = false;
                for (let cur = root.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
                    if (isSkippedSubtree(cur)) { blocked = true; break; }
                }
                if (blocked) continue;
                walkSubtree(root, budget, writes, visited);
            }
            applySurfaceWrites(writes);
        };

        const scheduleFullRescan = () => {
            if (disposed || rescanRaf) return;
            rescanRaf = requestAnimationFrame(() => {
                rescanRaf = 0;
                if (!disposed) fullRescan();
            });
        };

        const scheduleIncremental = () => {
            if (disposed || incrementalRaf || rescanRaf) return;
            incrementalRaf = requestAnimationFrame(flushPendingNodes);
        };

        const rootObserver = new MutationObserver(() => {
            observeBody();
            scheduleFullRescan();
        });
        const domObserver = new MutationObserver(records => {
            for (const rec of records) {
                for (const node of rec.addedNodes) {
                    if (node.nodeType === 1) pendingNodes.add(node);
                }
            }
            if (pendingNodes.size > 0) scheduleIncremental();
        });
        const onResize = () => {
            const visible = window.innerWidth > 0 && window.innerHeight > 0;
            if (visible && !lastWasVisible) {
                lastWasVisible = true;
                scheduleFullRescan();
            } else if (!visible) {
                lastWasVisible = false;
            }
        };

        const observeBody = () => {
            if (bodyObserved || !document.body) return;
            domObserver.observe(document.body, { childList: true, subtree: true });
            rootObserver.observe(document.body, {
                attributes: true,
                attributeFilter: ['class', 'data-theme', 'data-agy-theme', 'data-pulse-theme', 'data-color-scheme'],
            });
            bodyObserved = true;
        };

        const state = {
            version,
            revision,
            owner,
            generation,
            empty: false,
            colorScheme: effectiveColorScheme,
            diagnostics: { scans: 0 },
            update({ sidebar: nextSidebar = {}, hostColorScheme: nextHostScheme } = {}) {
                refreshLease();
                observeBody();
                const nextAlpha = nextSidebar.cover === false ? 0 : (Number.isFinite(nextSidebar.alpha) ? Math.min(100, Math.max(0, Math.round(nextSidebar.alpha))) : 100);
                const nextBlur = nextSidebar.cover === false ? 0 : (Number.isFinite(nextSidebar.blur) ? Math.min(30, Math.max(0, Math.round(nextSidebar.blur))) : 0);
                currentAlpha = nextAlpha;
                currentBlur = nextBlur;
                const normalizedHostScheme = nextHostScheme === 'light' ? 'light' : 'dark';
                const schemeChanged = normalizedHostScheme !== currentHostScheme;
                currentHostScheme = normalizedHostScheme;
                const nowVisible = window.innerWidth > 0 && window.innerHeight > 0;
                const becameVisible = nowVisible && !lastWasVisible;
                lastWasVisible = nowVisible;
                if (state.diagnostics.scans === 0 || becameVisible || (schemeChanged && !primaryCanvas)) {
                    fullRescan();
                } else {
                    renderStylesheet();
                }
                refreshLease();
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                clearTimeout(lease);
                if (rescanRaf) { cancelAnimationFrame(rescanRaf); rescanRaf = 0; }
                if (incrementalRaf) { cancelAnimationFrame(incrementalRaf); incrementalRaf = 0; }
                pendingNodes.clear();
                rootObserver.disconnect();
                domObserver.disconnect();
                window.removeEventListener('resize', onResize);
                document.documentElement?.removeAttribute('data-ag-ui-panel-active');
                clearMarks(document.body);
                document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet);
                if (window[key] === state) delete window[key];
            },
        };

        rootObserver.observe(document.documentElement, {
            childList: !document.body,
            attributes: true,
            attributeFilter: ['style', 'class', 'data-theme', 'data-pulse-theme', 'data-color-scheme'],
        });
        observeBody();
        window.addEventListener('resize', onResize, { passive: true });
        window[key] = state;
    }

    const activeState = window[key];
    if (!activeState || !isCurrent(activeState) || shouldIgnoreLease(activeState, incoming)) {
        return { value: 'IGNORED', colorScheme: null };
    }
    try {
        activeState.owner = owner;
        activeState.generation = generation;
        activeState.update({ sidebar: { cover: sidebar.cover !== false, alpha: rawAlpha, blur: rawBlur }, hostColorScheme });
    } catch (error) {
        if (created) await activeState.dispose?.();
        throw error;
    }
    return window[key] === activeState
        ? { value: 'OK', colorScheme: activeState.colorScheme ?? null }
        : { value: 'IGNORED', colorScheme: null };
}

const exportedPluginHelpers = await installPluginPanelSurface({ __inspectHelpers: true });
export const computePluginSurfaceMetrics = exportedPluginHelpers.computePluginSurfaceMetrics;
