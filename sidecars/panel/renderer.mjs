// The wallpaper stays viewport-sized. Sidebar surfaces change stacking, so
// opening a pane never changes the image's dimensions, crop or position.
export async function installWallpaper(payload = {}) {
    if (window !== window.top || !window.electronNative || !window.nativeStorage) return false;
    const { enabled = false, css = '', image, imageHash = '', owner = '', generation = 0, surfaces = {} } = payload;
    const key = '__antigravityUiRenderer';
    const version = 13;
    const active = window[key];
    if (active?.version === version && (
        active.generation > generation ||
        (active.generation === generation && active.owner > owner)
    )) return true;
    if (active && active.version !== version) await active.dispose();
    if (window.__antigravityUiWallpaper) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== window.__antigravityUiWallpaper);
        delete window.__antigravityUiWallpaper;
    }
    clearTimeout(window.__antigravityUiExpiry);
    const shellStyle = () => getComputedStyle(document.querySelector('.agy-shell') || document.body);
    if (!enabled) {
        await window[key]?.dispose();
        // Keep ownership while disabled so a standby heartbeat cannot restore stale settings.
        let lease;
        const state = {
            version, owner, generation, empty: true,
            dispose() {
                clearTimeout(lease);
                if (window[key] === state) delete window[key];
            },
        };
        window[key] = state;
        lease = setTimeout(() => state.dispose(), 6500);
        return true;
    }
    const current = window[key]?.empty ? undefined : window[key];
    if (css && image === undefined && imageHash && current?.imageHash !== imageHash) {
        return 'NEED_IMAGE';
    }
    if (window[key]?.empty) await window[key].dispose();
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
        const state = {
            version,
            owner,
            generation,
            empty: false,
            imageHash: '',
            titlebar: null,
            update({ css: nextCss, image: nextImage, imageHash: nextImageHash, surfaces: options }) {
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
                    const outerBorder = (cover, color, alpha, fallback) => cover && color ? mix(color, alpha) : fallback;
                    const surfaceBg = (cover, color, alpha, blur, fallback) =>
                        'background:' + mix((cover && color) || fallback, cover ? alpha : 0) + ' !important;' +
                        'backdrop-filter:blur(' + (cover ? blur : 0) + 'px) !important;';
                    const {
                        sidebarCover = true, sidebarOpacity = 100, sidebarBlur = 0,
                        composerCover = true, composerOpacity = 100, composerBlur = 0,
                        composerOuterColor = '', composerInnerColor = '',
                        bubbleCover = true, bubbleOpacity = 100, bubbleBlur = 0,
                        bubbleOuterColor = '', bubbleInnerColor = '',
                        overviewCover = bubbleCover, overviewOpacity = bubbleOpacity, overviewBlur = bubbleBlur,
                        overviewOuterColor = bubbleOuterColor, overviewInnerColor = bubbleInnerColor,
                    } = options;
                    const cardFallback = 'var(--card,var(--background,#131313))';
                    const composerOuter = outerBorder(
                        composerCover, composerOuterColor, composerOpacity,
                        'var(--card-border,var(--color-card-border,var(--glass-border,var(--border,rgba(128,128,128,.22)))))'
                    );
                    const composerFill = surfaceBg(composerCover, composerInnerColor, composerOpacity, composerBlur, 'var(--background,#131313)');
                    const bubbleOuter = outerBorder(
                        bubbleCover, bubbleOuterColor, bubbleOpacity,
                        'var(--glass-border,var(--card-border,var(--border,rgba(128,128,128,.22))))'
                    );
                    const bubbleFill = surfaceBg(bubbleCover, bubbleInnerColor, bubbleOpacity, bubbleBlur, cardFallback);
                    const overviewOuter = outerBorder(
                        overviewCover, overviewOuterColor, overviewOpacity,
                        'var(--border,var(--card-border,rgba(128,128,128,.22)))'
                    );
                    const overviewFill = surfaceBg(
                        overviewCover, overviewInnerColor, overviewOpacity, overviewBlur, cardFallback
                    );
                    const topComposer = '[data-testid="agent-input-box"] .surface-composer:has(> [data-testid="input-box-bottom-toolbar"])';
                    const baseComposer = '[data-testid="agent-input-box"] .surface-composer:not(:has(> [data-testid="input-box-bottom-toolbar"]))';
                    layout.replaceSync(
                        '#antigravity-ui-background { position:fixed; inset:0; z-index:1000; pointer-events:none; overflow:hidden; contain:paint; }' +
                        '.agy-sheet { z-index:auto !important; }' +
                        '.agy-sheet > .outline-none > :nth-child(3) { position:relative; z-index:auto !important; }' +
                        '.agy-sheet > .outline-none > :nth-child(3) > .h-full.w-full { z-index:auto !important; }' +
                        // Only the body rises above the wallpaper. Tabs share the main area's wallpaper treatment.
                        '.agy-sheet > .outline-none > :nth-child(3) .flex-grow.overflow-hidden { position:relative; z-index:1001;' +
                        surfaceBg(sidebarCover, '', sidebarOpacity, sidebarBlur, 'var(--background,#131313)') + ' }' +
                        '.agy-sheet > .outline-none > :nth-child(3) .browser-hole-ancestor { background:transparent !important; }' +
                        '.agy-sheet > .pointer-events-none.overflow-clip { z-index:1002 !important; }' +
                        '.agy-sheet > .pointer-events-none.overflow-clip > div:has(iframe[data-testid="sidecar-iframe"]) { background:transparent !important; }' +
                        '.agy-inset-shell > .absolute.right-0 { z-index:1003 !important; }' +
                        '.agy-inset-shell > .absolute.right-0 > div { background:transparent !important; }' +
                        '.agy-inset-shell > .absolute.right-0 > div > .right-full { background:none !important; }' +
                        '.relative.z-10:has([data-testid="agent-input-box"]),.z-\\[1\\]:has([data-testid="agent-input-box"]) { z-index:1001 !important; }' +
                        topComposer + ' {' + composerFill + 'box-shadow:inset 0 0 0 1px ' + composerOuter + ' !important; }' +
                        topComposer + ' .surface-composer-card { background:transparent !important;backdrop-filter:none !important;box-shadow:none !important; }' +
                        baseComposer + ' { background:transparent !important;backdrop-filter:none !important;box-shadow:inset 0 0 0 1px ' + composerOuter + ' !important; }' +
                        baseComposer + ' .surface-composer-card {' + composerFill + 'box-shadow:none !important; }' +
                        '[data-testid="autoscroll-viewport"] { isolation:auto !important;position:relative;z-index:1001 !important;' +
                        (bubbleCover && bubbleBlur > 0 ? 'mask-image:none !important;-webkit-mask-image:none !important;' : '') + ' }' +
                        '.agy-user-bubble-frame { background:transparent !important;box-shadow:inset 0 0 0 1px ' + bubbleOuter + ' !important; }' +
                        '.agy-user-bubble {' + bubbleFill + 'box-shadow:none !important; }' +
                        '[data-testid="overview-panel-overlay-backdrop"] { z-index:1002 !important; }' +
                        '[data-testid="overview-panel-host-overlay"],[data-testid="overview-panel-host-gutter"],[data-testid="overview-panel-host-sibling"],[data-testid="battle-overview-dropdown"] { z-index:1002 !important;' +
                        overviewFill + 'border-color:' + overviewOuter + ' !important; }'
                    );
                    currentSurfaces = signature;
                }
                clearTimeout(lease);
                lease = setTimeout(() => state.dispose(), 6500);
            },
            dispose() {
                clearTimeout(lease);
                layer.remove();
                document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== layout);
                if (window[key] === state) delete window[key];
                const style = shellStyle();
                return window.electronNative.setTitleBarOverlay?.({ color: style.backgroundColor, symbolColor: style.color });
            },
        };
        window[key] = state;
    }
    const activeState = window[key];
    activeState.owner = owner;
    activeState.generation = generation;
    activeState.update({ css, image, imageHash, surfaces });
    const style = shellStyle();
    const overlay = { color: css ? '#00000000' : style.backgroundColor, symbolColor: style.color };
    if (activeState.titlebar?.color !== overlay.color || activeState.titlebar?.symbolColor !== overlay.symbolColor) {
        await window.electronNative.setTitleBarOverlay?.(overlay);
        activeState.titlebar = overlay;
    }
    return 'OK';
}
