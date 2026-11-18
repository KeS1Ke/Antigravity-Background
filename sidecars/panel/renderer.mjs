// The wallpaper stays viewport-sized. Sidebar surfaces change stacking, so
// opening a pane never changes the image's dimensions, crop or position.
export async function installWallpaper(payload = {}) {
    if (window !== window.top || !window.electronNative || !window.nativeStorage) return false;
    const { enabled = false, css = '', image, imageHash = '', owner = '', generation = 0, surfaces = {} } = payload;
    const key = '__antigravityUiRenderer';
    // v18 checks this protocol version before honoring another owner's lease.
    const version = 18;
    const revision = 23;
    const active = window[key];
    if (active && (
        active.version > version || (active.version === version && active.revision > revision) ||
        active.generation > generation || (active.generation === generation && active.owner > owner)
    )) return 'IGNORED';
    if (window.__antigravityUiWallpaper) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== window.__antigravityUiWallpaper);
        delete window.__antigravityUiWallpaper;
    }
    clearTimeout(window.__antigravityUiExpiry);
    const normalizeColor = value => {
        const match = typeof value === 'string' && value.match(/^color\(\s*srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+%?))?\s*\)$/i);
        if (!match) return value;
        const toByte = n => Math.min(255, Math.max(0, Math.round(Number(n) * 255)));
        const rgb = `${toByte(match[1])}, ${toByte(match[2])}, ${toByte(match[3])}`;
        if (match[4] === undefined) return `rgb(${rgb})`;
        const alpha = match[4].endsWith('%') ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
        return alpha >= 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${alpha})`;
    };
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
    if (!enabled) {
        await window[key]?.dispose();
        // Keep ownership while disabled so a standby heartbeat cannot restore stale settings.
        let lease;
        const state = {
            version, revision, owner, generation, empty: true,
            dispose() {
                clearTimeout(lease);
                if (window[key] === state) delete window[key];
            },
        };
        window[key] = state;
        lease = setTimeout(() => state.dispose(), 6500);
        return true;
    }
    const current = active?.version === version && active.revision === revision && !active.empty ? active : undefined;
    if (css && image === undefined && imageHash && current?.imageHash !== imageHash) {
        return 'NEED_IMAGE';
    }
    if (active && !current) await active.dispose();
    if (!window[key]) {
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
        let bodyObserved = false;
        const trackOwners = new WeakMap();
        const appliedClip = new WeakMap();
        const observedTracks = new WeakSet();
        const recentScrollables = new Set();
        const matchesTrackOwner = (el, tr, horizontal) => {
            if (!el || !el.isConnected || el === document.body || el === document.documentElement) return false;
            const cs = getComputedStyle(el);
            const ov = horizontal ? cs.overflowX : cs.overflowY;
            if (ov !== 'auto' && ov !== 'scroll' && ov !== 'overlay') return false;
            if (horizontal ? el.scrollWidth <= el.clientWidth + 1 : el.scrollHeight <= el.clientHeight + 1) return false;
            const r = el.getBoundingClientRect();
            const cw = el.clientWidth || r.width;
            const ch = el.clientHeight || r.height;
            const expTop = horizontal ? r.top + el.clientTop + ch - 14 : r.top + el.clientTop + 2;
            const expLeft = horizontal ? r.left + el.clientLeft + 2 : r.left + el.clientLeft + cw - 14;
            const expLen = Math.max(0, (horizontal ? el.clientWidth : el.clientHeight) - 4);
            const actLen = horizontal ? tr.width : tr.height;
            return Math.abs(expTop - tr.top) <= 3 && Math.abs(expLeft - tr.left) <= 3 && Math.abs(expLen - actLen) <= 3;
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
                            return cur;
                        }
                    }
                }
            }
            for (const el of recentScrollables) {
                if (!el.isConnected) { recentScrollables.delete(el); continue; }
                if (matchesTrackOwner(el, tr, horizontal)) {
                    trackOwners.set(track, el);
                    return el;
                }
            }
            for (const el of document.querySelectorAll('[class*="overflow-"], [style*="overflow"]')) {
                if (matchesTrackOwner(el, tr, horizontal)) {
                    trackOwners.set(track, el);
                    return el;
                }
            }
            return null;
        };
        const computeClipRect = owner => {
            let left = 0;
            let top = 0;
            let right = window.innerWidth;
            let bottom = window.innerHeight;
            let cs = getComputedStyle(owner);
            if (cs.position === 'fixed') return { left, top, right, bottom };
            let needCb = cs.position === 'absolute';
            for (let el = owner.parentElement; el && el !== document.documentElement; el = el.parentElement) {
                cs = getComputedStyle(el);
                if (cs.display === 'contents') continue;
                const isCb = cs.position !== 'static' || cs.transform !== 'none' || cs.filter !== 'none' ||
                    cs.backdropFilter !== 'none' || /\b(?:paint|layout|strict|content)\b/.test(cs.contain);
                if (needCb && !isCb) continue;
                needCb = cs.position === 'absolute';
                const clipX = cs.overflowX !== 'visible';
                const clipY = cs.overflowY !== 'visible';
                if (clipX || clipY) {
                    const r = el.getBoundingClientRect();
                    const l = r.left + el.clientLeft;
                    const t = r.top + el.clientTop;
                    if (clipX) {
                        left = Math.max(left, l);
                        right = Math.min(right, l + el.clientWidth);
                    }
                    if (clipY) {
                        top = Math.max(top, t);
                        bottom = Math.min(bottom, t + el.clientHeight);
                    }
                }
                if (cs.position === 'fixed') break;
            }
            return { left, top, right, bottom };
        };
        const syncFloatingScrollbars = () => {
            if (!document.body) return;
            for (const track of document.body.querySelectorAll(':scope > [data-overlay-scrollbar-track]')) {
                if (!observedTracks.has(track)) {
                    observedTracks.add(track);
                    trackStyleObserver.observe(track, { attributes: true, attributeFilter: ['style'] });
                }
                const tr = track.getBoundingClientRect();
                if (tr.width <= 0 || tr.height <= 0) continue;
                const horizontal = track.dataset.orientation === 'horizontal';
                const owner = findTrackOwner(track, tr, horizontal);
                let nextClip = '';
                if (owner) {
                    const clip = computeClipRect(owner);
                    const topInset = Math.max(0, Math.ceil(clip.top - tr.top));
                    const bottomInset = Math.max(0, Math.ceil(tr.bottom - clip.bottom));
                    const leftInset = Math.max(0, Math.ceil(clip.left - tr.left));
                    const rightInset = Math.max(0, Math.ceil(tr.right - clip.right));
                    if (topInset + bottomInset >= tr.height || leftInset + rightInset >= tr.width) {
                        nextClip = 'inset(100% 0px 0px 0px)';
                    } else if (topInset || rightInset || bottomInset || leftInset) {
                        nextClip = `inset(${topInset}px ${rightInset}px ${bottomInset}px ${leftInset}px)`;
                    }
                }
                if (appliedClip.get(track) !== nextClip || Boolean(track.style.clipPath) !== Boolean(nextClip)) {
                    appliedClip.set(track, nextClip);
                    if (nextClip) track.style.clipPath = nextClip;
                    else track.style.removeProperty('clip-path');
                }
            }
        };
        const trackStyleObserver = new MutationObserver(syncFloatingScrollbars);
        const trackObserver = new MutationObserver(syncFloatingScrollbars);
        const onScrollOrOver = event => {
            if (event.target instanceof HTMLElement && event.target !== document.body && event.target !== document.documentElement) {
                if (event.target.scrollHeight > event.target.clientHeight + 1 || event.target.scrollWidth > event.target.clientWidth + 1) {
                    if (recentScrollables.size > 32) recentScrollables.clear();
                    recentScrollables.add(event.target);
                }
            }
            if (document.body?.querySelector(':scope > [data-overlay-scrollbar-track]')) syncFloatingScrollbars();
        };
        const onResize = () => {
            if (document.body?.querySelector(':scope > [data-overlay-scrollbar-track]')) syncFloatingScrollbars();
        };
        document.addEventListener('scroll', onScrollOrOver, { capture: true, passive: true });
        document.addEventListener('pointerover', onScrollOrOver, { capture: true, passive: true });
        window.addEventListener('resize', onResize, { passive: true });
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
            measureLayout() {
                const w = window.innerWidth;
                const h = window.innerHeight;
                if (w <= 0 || h <= 0) return;
                const inset = document.querySelector('.agy-inset-shell')?.getBoundingClientRect();
                const firstSplitChild = document.querySelector('.agy-inset-shell > [data-split-root] > :first-child');
                const noLeftNav = Boolean(firstSplitChild?.matches('.agy-sheet'));
                const leftNav = firstSplitChild && !noLeftNav ? firstSplitChild.getBoundingClientRect() : null;
                const sidePane = (document.querySelector('[data-side-panel-body]') || document.querySelector('.agy-sheet > .outline-none > :nth-child(3)'))?.getBoundingClientRect();
                const strip = document.querySelector('[data-side-panel-strip]')?.getBoundingClientRect();
                state.layout = {
                    width: w,
                    height: h,
                    titlebarPct: inset && inset.top >= 0 ? +(inset.top / h * 100).toFixed(2) : 3.39,
                    leftPct: noLeftNav ? 0 : (leftNav && leftNav.width >= 0 ? +(leftNav.width / w * 100).toFixed(2) : 13.33),
                    rightPct: sidePane && sidePane.width >= 0 ? +(sidePane.width / w * 100).toFixed(2) : 0,
                    tabStripPct: strip && strip.height > 0 ? +(strip.height / h * 100).toFixed(2) : 4.01,
                };
            },
            update({ css: nextCss, image: nextImage, imageHash: nextImageHash, surfaces: options }) {
                observeBody();
                state.measureLayout();
                state.hasCss = Boolean(nextCss);
                if (nextCss) {
                    if (nextImage !== undefined && (nextImageHash !== state.imageHash || !imageEl.style.getPropertyValue('--ag-ui-image'))) {
                        imageEl.style.setProperty('--ag-ui-image', 'url("' + nextImage + '")');
                        state.imageHash = nextImageHash;
                    }
                    if (nextCss !== currentCss) {
                        content.replaceSync('.image {' + nextCss + ' position:absolute; }');
                        currentCss = nextCss;
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
                const signature = JSON.stringify(options);
                if (signature !== currentSurfaces) {
                    const mix = (color, alpha) => 'color-mix(in srgb,' + color + ' ' + alpha + '%,transparent)';
                    const surfaceState = (prefix, flatFallback, borderFallback, allowLayered = false) => {
                        const cover = options[prefix + 'Cover'] !== false;
                        const layered = allowLayered && options[prefix + 'Layered'] !== false;
                        const opacity = options[prefix + 'Opacity'] ?? 100;
                        const blur = options[prefix + 'Blur'] ?? 0;
                        const outerColor = options[prefix + 'OuterColor'] || '';
                        const innerColor = options[prefix + 'InnerColor'] || '';
                        const alpha = cover ? opacity : 0;
                        const effectiveBlur = cover ? blur : 0;
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
                    const cardFallback = 'var(--card,var(--background,#131313))';
                    const defaultBorder = 'var(--glass-border,var(--card-border,var(--border,rgba(128,128,128,.22))))';
                    const leftSidebar = surfaceState('leftSidebar', 'var(--sidebar,var(--background,#131313))', defaultBorder, false);
                    const sidebar = surfaceState('sidebar', 'var(--background,#131313)', defaultBorder, false);
                    const composer = surfaceState(
                        'composer',
                        'var(--background,#131313)',
                        'var(--card-border,var(--color-card-border,var(--glass-border,var(--border,rgba(128,128,128,.22)))))',
                        true
                    );
                    const overview = surfaceState(
                        'overview',
                        cardFallback,
                        'var(--border,var(--card-border,rgba(128,128,128,.22)))',
                        false
                    );
                    const flatBg = (bg, blur) => 'background:' + bg + ' !important;backdrop-filter:blur(' + blur + 'px) !important;';
                    const raisedShadow = rim => 'box-shadow:inset 0 1px 0 var(--ag-ui-highlight-default),0 0 0 1px ' + rim + ',var(--ag-ui-card-shadow) !important;';
                    const outerFrameShadow = border => 'box-shadow:inset 0 0 0 1px ' + border + ',inset 0 1px 2px var(--ag-ui-inset-shadow),var(--ag-ui-drop-shadow) !important;';
                    const leftDocked = '[data-testid="sidebar-split"] > :first-child:has(.bg-sidebar):not(:has([data-peek-surface]))';
                    const leftShell = ':is([data-testid="sidebar-split"] > :first-child:not(:has([data-peek-surface])),[data-testid="sidebar-split"] [data-peek-surface="open"]) .h-full.w-full.flex.flex-col.bg-sidebar,.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"]';
                    const rightBody = '.agy-sheet > .outline-none > :nth-child(3) [data-side-panel-body]:not([data-has-browser-hole="true"])';
                    const anyComposer = '[data-testid="agent-input-box"] .surface-composer';
                    const topComposer = '[data-testid="agent-input-box"] .surface-composer:has(> [data-testid="input-box-bottom-toolbar"])';
                    const baseComposer = '[data-testid="agent-input-box"] .surface-composer:not(:has(> [data-testid="input-box-bottom-toolbar"]))';
                    const overviewHosts = '[data-testid="overview-panel-host-overlay"],[data-testid="overview-panel-host-gutter"],[data-testid="overview-panel-host-sibling"],[data-testid="battle-overview-dropdown"]';
                    const themeTokens =
                        ':root { --ag-ui-frame-default:var(--onyx-frame,#0d0d11);--ag-ui-raised-default:var(--onyx-raised,var(--card,var(--background,#131313)));--ag-ui-rim-default:rgba(255,255,255,.12);--ag-ui-highlight-default:rgba(255,255,255,.14);--ag-ui-inset-shadow:rgba(0,0,0,.34);--ag-ui-drop-shadow:0 18px 40px -12px rgba(0,0,0,.44),0 2px 8px -2px rgba(0,0,0,.28);--ag-ui-card-shadow:0 4px 12px -2px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22); }' +
                        ':is(body[data-agy-theme]:not(.dark):not(.dark-theme):not(.theme-dark):not(.vscode-dark),.vscode-light,[data-theme="light"]) { --ag-ui-frame-default:var(--onyx-frame,#eaedf2);--ag-ui-raised-default:var(--onyx-raised,var(--card,#ffffff));--ag-ui-rim-default:rgba(10,10,12,.11);--ag-ui-highlight-default:rgba(255,255,255,.85);--ag-ui-inset-shadow:rgba(10,10,12,.06);--ag-ui-drop-shadow:0 10px 26px -10px rgba(10,10,12,.14),0 2px 6px -1px rgba(10,10,12,.06);--ag-ui-card-shadow:0 3px 10px -2px rgba(10,10,12,.08),0 1px 3px rgba(10,10,12,.05); }' +
                        ':is(.dark,.dark-theme,.theme-dark,.vscode-dark,[data-theme="dark"]) { --ag-ui-frame-default:color-mix(in srgb,var(--onyx-frame,#111216) 72%,#000);--ag-ui-raised-default:color-mix(in srgb,var(--onyx-raised,var(--card,#1d1e23)) 92%,#fff);--ag-ui-rim-default:rgba(255,255,255,.12);--ag-ui-highlight-default:rgba(255,255,255,.14);--ag-ui-inset-shadow:rgba(0,0,0,.34);--ag-ui-drop-shadow:0 18px 40px -12px rgba(0,0,0,.44),0 2px 8px -2px rgba(0,0,0,.28);--ag-ui-card-shadow:0 4px 12px -2px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22); }';
                    const leftSidebarRules =
                        leftDocked + ' { position:relative;z-index:1001 !important; }' +
                        '[data-testid="sidebar-split"] .bg-sidebar .bg-sidebar,[data-testid="sidebar-split"] .bg-sidebar .agy-row-actions::before,.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"] .bg-sidebar .bg-sidebar,.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"] .agy-row-actions::before { background:transparent !important; }' +
                        leftShell + ' {' + flatBg(leftSidebar.innerBg, leftSidebar.effectiveBlur) + 'box-shadow:none !important; }';
                    const rightPanelRules =
                        '.agy-sheet > .outline-none > :nth-child(3) .browser-hole-ancestor { background:transparent !important; }' +
                        // Only the body rises above the wallpaper. Tabs share the main area's wallpaper treatment.
                        rightBody + ' { position:relative;z-index:1001;' + flatBg(sidebar.innerBg, sidebar.effectiveBlur) + 'box-shadow:none !important; }';
                    const composerRules = composer.layered
                        ? anyComposer + ' { padding:4px !important;border-radius:calc(var(--nux-composer-radius,20px) + 4px) !important;' + flatBg(composer.outerBg, composer.effectiveBlur) + outerFrameShadow(composer.outerBorder) + ' }' +
                          anyComposer + ' .surface-composer-card { border-radius:var(--nux-composer-radius,20px) !important;background:' + composer.innerBg + ' !important;backdrop-filter:none !important;' + raisedShadow(composer.innerRim) + ' }' +
                          anyComposer + ':focus-within > .surface-composer-card { box-shadow:inset 0 1px 0 var(--ag-ui-highlight-default),0 0 0 1px ' + composer.innerRim + ',var(--ag-ui-drop-shadow) !important; }'
                        : topComposer + ' {' + flatBg(composer.innerBg, composer.effectiveBlur) + 'box-shadow:inset 0 0 0 1px ' + composer.outerBorder + ' !important; }' +
                          topComposer + ' .surface-composer-card { background:transparent !important;backdrop-filter:none !important;box-shadow:none !important; }' +
                          baseComposer + ' { background:transparent !important;backdrop-filter:none !important;box-shadow:inset 0 0 0 1px ' + composer.outerBorder + ' !important; }' +
                          baseComposer + ' .surface-composer-card {' + flatBg(composer.innerBg, composer.effectiveBlur) + 'box-shadow:none !important; }';
                    const bubbleRules = composer.layered
                        ? '.agy-user-bubble-frame { padding:3px !important;border-radius:calc(var(--nux-composer-radius,20px) + 3px) !important;' + flatBg(composer.outerBg, composer.effectiveBlur) + outerFrameShadow(composer.outerBorder) + ' }' +
                          '.agy-user-bubble { border-radius:var(--nux-composer-radius,20px) !important;background:' + composer.innerBg + ' !important;backdrop-filter:none !important;' + raisedShadow(composer.innerRim) + ' }'
                        : '.agy-user-bubble-frame { background:transparent !important;backdrop-filter:none !important;box-shadow:inset 0 0 0 1px ' + composer.outerBorder + ' !important; }' +
                          '.agy-user-bubble {' + flatBg(composer.innerBg, composer.effectiveBlur) + 'box-shadow:none !important; }';
                    const overviewRules =
                        overviewHosts + ' { z-index:1002 !important;' + flatBg(overview.innerBg, overview.effectiveBlur) + 'border-color:' + overview.outerBorder + ' !important;box-shadow:none !important; }';
                    layout.replaceSync(
                        themeTokens +
                        '#antigravity-ui-background { position:fixed; inset:0; z-index:1000; pointer-events:none; overflow:hidden; contain:paint; }' +
                        '.agy-sheet { z-index:auto !important; }' +
                        '.agy-sheet > .outline-none > :nth-child(3) { position:relative; z-index:auto !important; }' +
                        '.agy-sheet > .outline-none > :nth-child(3) > .h-full.w-full { z-index:auto !important; }' +
                        leftSidebarRules +
                        rightPanelRules +
                        '.agy-sheet[data-side-panel-maximized] > .outline-none > :nth-child(3) [data-side-panel-body]:not([data-has-browser-hole="true"]),.agy-sheet:is([data-side-panel-maximized],:has(> [data-split-root] > [data-split-overlaid="true"])) [data-side-panel-strip] { position:relative; z-index:1002 !important; }' +
                        '[data-side-panel-body][data-has-browser-hole="true"] { background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important; }' +
                        '.agy-sheet > .pointer-events-none.overflow-clip { z-index:1002 !important; }' +
                        '.agy-sheet > .pointer-events-none.overflow-clip > div:has(iframe[data-testid="sidecar-iframe"]) { background:transparent !important; }' +
                        '.agy-inset-shell > .absolute.left-0.top-0,.agy-inset-shell > .absolute.right-0,[data-testid="sidebar-peek-hot-zone"],[data-testid="sidebar-split"] [data-split-sized]:has([data-peek-surface="open"]),.agy-inset-shell > [data-testid="sidebar-popover-backdrop"],.agy-inset-shell > [data-testid="sidebar-popover-backdrop"] + [role="dialog"],.fixed.z-40:has([data-testid="voice-dock-composer"]) { z-index:1003 !important; }' +
                        '.agy-inset-shell > .absolute.right-0 > div { background:transparent !important; }' +
                        '.agy-inset-shell > .absolute.right-0 > div > .right-full { background:none !important; }' +
                        '.relative.z-10:has([data-testid="agent-input-box"]),.z-\\[1\\]:has([data-testid="agent-input-box"]) { z-index:1001 !important; }' +
                        composerRules +
                        '[data-testid="autoscroll-viewport"] { isolation:auto !important;position:relative;z-index:1001 !important;' +
                        (composer.cover && composer.effectiveBlur > 0 ? 'mask-image:none !important;-webkit-mask-image:none !important;' : '') + ' }' +
                        '[data-testid="autoscroll-viewport"] ~ [data-testid="overlay-scrollbar"],[data-testid="autoscroll-viewport"] ~ .agy-scroll-bottom,[data-testid="bottom-terminal-panel-resize-handle"],body > [data-overlay-scrollbar-track][style*="z-index: 51"] { z-index:1001 !important; }' +
                        '[data-testid="conversation-view"] > .pointer-events-none.inset-y-0.left-0:has([data-testid="conversation-navigator"]),[data-testid="conversation-navigator"],.sticky.top-0:has([data-testid="find-bar-match-count"]),[data-main-content-body] .absolute.top-4.right-4:has(> button[aria-label="Close"]),.selection-popup,[data-comment-bubble-popover="true"],[data-testid="pdf-selected-annotation-popover"],[data-testid="comment-box"].absolute { z-index:1002 !important; }' +
                        '[data-main-content-body] [data-split-sized]:not(:has([data-peek-surface])) { z-index:auto !important; }' +
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
                clearTimeout(lease);
                lease = setTimeout(() => state.dispose(), 6500);
            },
            syncTitlebar(force = false) {
                const base = shellColors();
                const overlay = state.hasCss ? { color: '#00000000', symbolColor: base.symbolColor } : base;
                if (!force &&
                    state.titlebar?.color === overlay.color &&
                    state.titlebar?.symbolColor === overlay.symbolColor &&
                    Date.now() - state.titlebarAt < 1000) return;
                state.titlebar = overlay;
                state.titlebarAt = Date.now();
                return window.electronNative.setTitleBarOverlay?.(overlay);
            },
            dispose() {
                clearTimeout(lease);
                observer.disconnect();
                trackObserver.disconnect();
                trackStyleObserver.disconnect();
                document.removeEventListener('scroll', onScrollOrOver, { capture: true });
                document.removeEventListener('pointerover', onScrollOrOver, { capture: true });
                window.removeEventListener('resize', onResize);
                for (const track of document.body?.querySelectorAll(':scope > [data-overlay-scrollbar-track]') || []) {
                    track.style.removeProperty('clip-path');
                }
                layer.remove();
                document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== layout);
                if (window[key] === state) delete window[key];
                return window.electronNative.setTitleBarOverlay?.(shellColors());
            },
        };
        let currentTheme = themeSignature();
        const observer = new MutationObserver(() => {
            observeBody();
            const nextTheme = themeSignature();
            if (nextTheme === currentTheme) return;
            currentTheme = nextTheme;
            if (window[key] === state && state.hasCss) void state.syncTitlebar(true);
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
    activeState.owner = owner;
    activeState.generation = generation;
    activeState.update({ css, image, imageHash, surfaces });
    await activeState.syncTitlebar();
    return 'OK';
}
