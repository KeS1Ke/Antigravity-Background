(() => {
    const {
        controls,
        surfaceControls,
        normalize,
        wallpaperStyle,
        minScale: appearanceMinScale,
        extractCanvasBorderColor,
    } = window.wallpaperAppearance;
    const DEFAULT_REPO_URL = 'https://github.com/KeS1Ke/Antigravity-Background';
    const SURFACES = [
        {
            prefix: 'leftSidebar',
            slug: 'left-sidebar',
            hasLayered: false,
            hasColors: false,
            innerVar: '--preview-left-sidebar',
            blurVar: '--preview-left-sidebar-blur',
            defaultInner: 'var(--ag-ui-surface)',
        },
        {
            prefix: 'sidebar',
            slug: 'sidebar',
            hasLayered: false,
            hasColors: false,
            innerVar: '--preview-sidebar',
            blurVar: '--preview-sidebar-blur',
            defaultInner: 'var(--ag-ui-page)',
        },
        {
            prefix: 'composer',
            slug: 'composer',
            hasLayered: true,
            hasColors: true,
            attr: 'composerLayered',
            outerBgVar: '--preview-composer-outer-bg',
            outerVar: '--preview-outer',
            innerVar: '--preview-inner',
            blurVar: '--preview-composer-blur',
            defaultOuter: 'var(--ag-sample-frame)',
            defaultInner: 'var(--ag-sample-raised)',
        },
        {
            prefix: 'overview',
            slug: 'overview',
            hasLayered: false,
            hasColors: true,
            outerVar: '--preview-overview-outer',
            innerVar: '--preview-overview-inner',
            blurVar: '--preview-overview-blur',
            defaultOuter: 'var(--ag-ui-border)',
            defaultInner: 'var(--ag-ui-card)',
        },
    ];

    // --- Shared Helpers ---

    const find = selector => document.querySelector(selector);

    function safeHttpUrl(raw, fallback = DEFAULT_REPO_URL) {
        if (typeof raw !== 'string') return fallback;
        const trimmed = raw.trim();
        if (!trimmed) return fallback;
        try {
            const parsed = new URL(trimmed);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
        } catch {}
        return fallback;
    }

    function sameValues(a, b) {
        return Object.keys(a).every(key => a[key] === b[key]);
    }

    async function sha256Hex(text) {
        if (!text) return '';
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function request(method = 'GET', input, path = '/api/settings') {
        const transport = window.sidecar?.fetch?.bind(window.sidecar) || fetch;
        const init = { method };
        if (input !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(input);
        }
        const response = await transport(path, init);
        let result = null;
        try {
            result = await response.json();
        } catch {}
        if (!response.ok) {
            const errorText = (result && typeof result.error === 'string' && result.error)
                || ('请求失败（HTTP ' + response.status + '）。');
            const error = new Error(errorText);
            error.status = response.status;
            error.code = (result && typeof result.code === 'string' && result.code)
                || (result && typeof result.error === 'string' && result.error)
                || undefined;
            error.detail = (result && typeof result.errorDetail === 'string' && result.errorDetail)
                || (result && typeof result.detail === 'string' && result.detail)
                || undefined;
            throw error;
        }
        if (result === null || typeof result !== 'object') {
            const error = new Error('服务返回的数据格式无效，请稍后重试。');
            error.status = response.status;
            error.code = 'INVALID_JSON';
            throw error;
        }
        return result;
    }

    // --- DOM References & Template Hydration ---

    const pageRegions = [find('header'), find('main'), find('footer')].filter(Boolean);
    const previewStage = find('#preview');
    const dragStage = find('#drag-preview-stage');
    const stages = [previewStage, dragStage];
    const sampleTemplate = find('#sample-window-template');
    if (sampleTemplate) {
        for (const stage of stages) stage.prepend(sampleTemplate.content.cloneNode(true));
    }
    const wallpaperEls = [...document.querySelectorAll('.wallpaper')];

    const status = find('#status');
    const imageInput = find('#image');
    const retryLoad = find('#retry-load');
    const repairLaunch = find('#repair-launch');
    const discard = find('#discard');
    const save = find('#save');
    const enabledInput = find('#enabled');
    const themeSelect = find('#theme');
    const removeBtn = find('#remove');
    const resetBtn = find('#reset');
    const modeLabel = find('#mode-label');
    const emptyHint = find('#empty');
    const sliders = [];
    const modes = [...document.querySelectorAll('[data-mode]')];
    const names = { fill: '填充', stretch: '拉伸', fit: '适应', tile: '平铺' };
    const dragModal = find('#drag-preview-modal');
    const openDragPreview = find('#open-drag-preview');
    const closeDragPreview = find('#close-drag-preview');
    const dragPreviewMask = find('#drag-preview-mask');
    const dragPreviewReset = find('#drag-preview-reset');
    const dragPreviewMeta = find('#drag-preview-meta');

    const surfaceBindings = SURFACES.map(surface => ({
        ...surface,
        layeredEl: surface.hasLayered ? find('#' + surface.slug + '-layered') : null,
        coverEl: find('#' + surface.slug + '-cover'),
    }));
    const colorBindings = SURFACES
        .filter(surface => surface.hasColors)
        .flatMap(({ prefix }) => [
            {
                key: prefix + 'OuterColor',
                inputEl: find('#' + prefix + 'OuterColor'),
                resetEl: find(`[data-reset-color="${prefix}OuterColor"]`),
                cover: () => settings[prefix + 'Cover'],
            },
            {
                key: prefix + 'InnerColor',
                inputEl: find('#' + prefix + 'InnerColor'),
                resetEl: find(`[data-reset-color="${prefix}InnerColor"]`),
                cover: () => settings[prefix + 'Cover'],
            },
        ]);

    const previewSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, previewSheet];
    if (window.parent !== window) document.documentElement.dataset.embedded = 'true';
    const systemTheme = matchMedia('(prefers-color-scheme: light)');
    const tabId = crypto.randomUUID();
    const channel = new BroadcastChannel('antigravity-ui-panel-sync');

    // --- Wallpaper Settings & Sync State ---

    let settings = normalize();
    let ready = false;
    let initFailed = false;
    let busy = false;
    let saving = false;
    let hasDraft = false;
    let revision = 0;
    let actionRevision = 0;
    let hostTheme;
    let hostThemeColor;
    let hostLayout;
    let previewImage;
    let naturalWidth = 0;
    let naturalHeight = 0;
    let loadedImageEl = null;
    let detectedImageFor = '';
    let detectedImageColor = '';
    let serverImage;
    let serverImageHash;
    let previewTimer;
    let previewInFlight = false;
    let previewQueued = false;
    let keepStatusAfterPreview = false;
    let syncInFlight = false;
    let syncQueued = false;
    let syncToken = 0;
    let hasRuntimeNotice = false;
    let repairNoticeActive = false;
    let missingDebugPort = false;
    let repairingShortcuts = false;
    let operations = Promise.resolve();
    let lastMetricsKey = '';
    let lastPreviewCss = '';

    function isInteractionBusy() {
        return saving || previewInFlight || previewQueued || busy || Boolean(previewTimer);
    }

    function applyRuntimeLayout(runtime) {
        if (!runtime) return;
        hostLayout = runtime.layout ?? null;
        missingDebugPort = runtime.errorCode === 'MISSING_DEVTOOLS_PORT';
    }

    function syncServerImage(result) {
        serverImage = result.settings.image;
        serverImageHash = result.imageHash;
        applyRuntimeLayout(result.runtime);
    }

    async function postSettings(path, snapshot) {
        const canOmitImage = snapshot.image === serverImage && serverImageHash !== undefined;
        const body = canOmitImage ? { ...snapshot, image: undefined, imageHash: serverImageHash } : snapshot;
        try {
            return await request('POST', body, path);
        } catch (error) {
            if (!canOmitImage || error.status !== 409 || error.code !== 'IMAGE_CACHE_MISS') throw error;
            return request('POST', snapshot, path);
        }
    }

    function enqueue(operation) {
        const result = operations.then(operation);
        operations = result.catch(() => {});
        return result;
    }

    function message(text = '', error = false, runtimeNotice = false, { sticky = false } = {}) {
        hasRuntimeNotice = runtimeNotice;
        repairNoticeActive = sticky;
        status.textContent = text;
        status.classList.toggle('error', error);
    }

    function schedulePreview() {
        if (saving || previewInFlight) {
            previewQueued = true;
            return;
        }
        if (previewTimer) return;
        previewTimer = setTimeout(() => {
            previewTimer = undefined;
            flushPreview();
        }, 16);
    }

    function flushPreview() {
        clearTimeout(previewTimer);
        previewTimer = undefined;
        if (previewInFlight) {
            previewQueued = true;
            return;
        }
        previewInFlight = true;
        let submitted;
        const preserveStatus = keepStatusAfterPreview;
        keepStatusAfterPreview = false;
        void enqueue(async () => {
            if (saving && revision === actionRevision) return;
            previewQueued = false;
            submitted = revision;
            const snapshot = { ...settings };
            const result = await postSettings('/api/preview', snapshot);
            syncServerImage(result);
            if (submitted !== revision || saving) return;
            hasDraft = result.hasDraft;
            render();
            const runtimeError = Boolean(result.runtime.error);
            if (runtimeError) {
                message('实时预览失败：' + result.runtime.error, true, true);
            } else if (!repairNoticeActive && !preserveStatus) {
                message(hasDraft ? '实时预览 · 未保存' : '', false, false);
            }
            broadcastState();
        }).catch(error => {
            if (submitted === revision && !saving) {
                if (!preserveStatus) message('实时预览失败：' + error.message, true);
                broadcastState();
            }
        }).finally(() => {
            previewInFlight = false;
            if (previewQueued && !saving) {
                previewQueued = false;
                flushPreview();
            }
        });
    }

    function broadcastState() {
        const canOmitImage = settings.image === serverImage && serverImageHash !== undefined;
        channel.postMessage({
            source: tabId,
            settings: canOmitImage ? { ...settings, image: undefined } : { ...settings },
            imageHash: canOmitImage ? serverImageHash : undefined,
            hasDraft,
            serverImageHash,
            hostLayout,
            missingDebugPort,
            statusText: status.textContent,
            statusError: status.classList.contains('error'),
            hasRuntimeNotice,
        });
    }

    function applyIncomingState(msg, resolvedImage) {
        const nextSettings = normalize({ ...msg.settings, image: resolvedImage });
        clearTimeout(previewTimer);
        previewTimer = undefined;
        previewQueued = false;
        keepStatusAfterPreview = false;
        syncQueued = false;
        hostLayout = msg.hostLayout ?? null;
        missingDebugPort = Boolean(msg.missingDebugPort);
        settings = nextSettings;
        if (msg.serverImageHash === '') {
            serverImage = '';
            serverImageHash = '';
        } else if (msg.serverImageHash === msg.imageHash || msg.settings.image === undefined) {
            serverImage = resolvedImage;
            serverImageHash = msg.serverImageHash;
        }
        hasDraft = Boolean(msg.hasDraft);
        revision++;
        message(msg.statusText || '', Boolean(msg.statusError), Boolean(msg.hasRuntimeNotice));
        render();
    }

    async function applyBroadcast(msg) {
        if (!msg.settings || typeof msg.settings !== 'object') throw new Error('Invalid broadcast payload');
        const token = ++syncToken;
        if (msg.settings.image !== undefined) {
            applyIncomingState(msg, msg.settings.image);
            return;
        }
        if (msg.imageHash === '') {
            applyIncomingState(msg, '');
            return;
        }
        if (msg.imageHash !== undefined && msg.imageHash === serverImageHash && serverImage !== undefined) {
            applyIncomingState(msg, serverImage);
            return;
        }
        if (msg.imageHash && settings.image) {
            const startRevision = revision;
            const matched = (await sha256Hex(settings.image)) === msg.imageHash;
            if (token !== syncToken || revision !== startRevision || isInteractionBusy()) return;
            if (matched) {
                applyIncomingState(msg, settings.image);
                return;
            }
        }
        if (token === syncToken) void syncFromServer();
    }

    channel.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.source === tabId || !ready || isInteractionBusy()) return;
        void applyBroadcast(msg).catch(() => {
            if (ready && !isInteractionBusy()) void syncFromServer();
        });
    });

    // --- Host Theme & Layout Geometry ---

    function parseAlpha(raw) {
        if (raw === undefined) return 1;
        const value = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
        return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : NaN;
    }

    function parseRgbChannel(raw) {
        const value = raw.endsWith('%') ? Number(raw.slice(0, -1)) * 2.55 : Number(raw);
        return Number.isFinite(value) ? value : NaN;
    }

    function parseRgb(resolved) {
        const comma = resolved.match(/^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)(?:\s*,\s*([\d.eE+-]+%?))?\s*\)$/i);
        if (comma) {
            const channels = [parseRgbChannel(comma[1]), parseRgbChannel(comma[2]), parseRgbChannel(comma[3]), parseAlpha(comma[4])];
            return channels.every(Number.isFinite) ? channels : null;
        }
        const space = resolved.match(/^rgba?\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.eE+-]+%?))?\s*\)$/i);
        if (space) {
            const channels = [parseRgbChannel(space[1]), parseRgbChannel(space[2]), parseRgbChannel(space[3]), parseAlpha(space[4])];
            return channels.every(Number.isFinite) ? channels : null;
        }
        const srgb = resolved.match(/^color\(\s*srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+%?))?\s*\)$/i);
        if (srgb) {
            const channels = [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, parseAlpha(srgb[4])];
            return channels.every(Number.isFinite) ? channels : null;
        }
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = resolved;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
    }

    function updateHostTheme(vars) {
        const style = getComputedStyle(document.documentElement);
        const color = vars?.['--color-background'] || vars?.['--background'] ||
            style.getPropertyValue('--color-background').trim() || style.getPropertyValue('--background').trim();
        if (!color || color === hostThemeColor) return;
        const probe = document.createElement('span');
        probe.style.color = color;
        if (!probe.style.color) return;
        document.body.append(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        const channels = parseRgb(resolved);
        if (!channels) return;
        const [r, g, b, a] = channels;
        if (a <= 0) return;
        hostThemeColor = color;
        hostTheme = (r * .2126 + g * .7152 + b * .0722) > 150 ? 'light' : 'dark';
    }

    function applyTheme() {
        document.documentElement.dataset.theme = settings.theme === 'system'
            ? hostTheme || (systemTheme.matches ? 'light' : 'dark')
            : settings.theme;
    }
    systemTheme.addEventListener('change', applyTheme);
    window.addEventListener('message', event => {
        if (event.source !== window.parent || event.data?.type !== 'theme-change') return;
        updateHostTheme(event.data.payload?.cssVariables);
        applyTheme();
    });

    const minScale = (mode = settings.mode) => typeof appearanceMinScale === 'function'
        ? appearanceMinScale(mode)
        : (mode === 'tile' ? controls.scale.min : 100);
    const effectiveScale = () => Math.max(minScale(), settings.scale);
    const canOpenDragPreview = () => ready && !busy && settings.enabled && Boolean(settings.image);
    const canDragWallpaper = () => canOpenDragPreview() && !dragModal.hidden;

    function hostMetrics() {
        const width = Number.isFinite(hostLayout?.width) && hostLayout.width > 0 ? hostLayout.width : 1920;
        const height = Number.isFinite(hostLayout?.height) && hostLayout.height > 0 ? hostLayout.height : 1032;
        const embeddedPanel = window.parent !== window && window.innerWidth > 0;
        const rawLeft = Number.isFinite(hostLayout?.leftPct) ? hostLayout.leftPct : 13.33;
        const rawRight = embeddedPanel
            ? +(window.innerWidth / width * 100).toFixed(2)
            : (Number.isFinite(hostLayout?.rightPct) ? hostLayout.rightPct : 39.01);
        let leftPct = Math.max(0, Math.min(80, rawLeft));
        let rightPct = Math.max(0, Math.min(80, rawRight));
        if (leftPct + rightPct > 90) {
            const factor = 90 / (leftPct + rightPct);
            leftPct = +(leftPct * factor).toFixed(2);
            rightPct = +(rightPct * factor).toFixed(2);
        }
        const titlebarPct = Number.isFinite(hostLayout?.titlebarPct) ? Math.max(0, Math.min(20, hostLayout.titlebarPct)) : 3.39;
        const tabStripPct = Number.isFinite(hostLayout?.tabStripPct) ? Math.max(0, Math.min(20, hostLayout.tabStripPct)) : 4.01;
        return { width, height, titlebarPct, leftPct, rightPct, tabStripPct };
    }

    function dragSpan(stage) {
        const metrics = hostMetrics();
        const w = stage.clientWidth;
        const h = stage.clientHeight || (w * metrics.height / metrics.width);
        if (!w || !h) return { dx: 0, dy: 0 };
        const s = effectiveScale() / 100;
        let w0 = w;
        let h0 = h;
        if (settings.mode === 'tile') {
            const ratio = w / metrics.width;
            w0 = (settings.imageWidth || 512) * ratio;
            h0 = (settings.imageHeight || 512) * ratio;
        } else {
            const iw = naturalWidth || settings.imageWidth || 512;
            const ih = naturalHeight || settings.imageHeight || 512;
            const ri = iw / ih;
            if (settings.mode === 'fill') {
                w0 = Math.max(w, h * ri);
                h0 = Math.max(h, w / ri);
            } else if (settings.mode === 'fit') {
                w0 = Math.min(w, h * ri);
                h0 = Math.min(h, w / ri);
            }
        }
        return { dx: w - s * w0, dy: h - s * h0 };
    }

    // --- Render ---

    const mixColor = (color, alpha) => 'color-mix(in srgb,' + color + ' ' + alpha + '%,transparent)';

    function setSurfacePreview(frame, ratio, item) {
        const cover = settings[item.prefix + 'Cover'];
        const opacity = settings[item.prefix + 'Opacity'];
        const blur = settings[item.prefix + 'Blur'];
        const outerColor = item.hasColors ? settings[item.prefix + 'OuterColor'] : '';
        const innerColor = item.hasColors ? settings[item.prefix + 'InnerColor'] : '';
        const activeLayered = item.hasLayered ? (!settings.enabled || settings[item.prefix + 'Layered']) : false;
        const alpha = !settings.enabled ? 100 : (cover ? opacity : 0);
        if (item.attr) frame.dataset[item.attr] = String(activeLayered);
        if (item.outerBgVar) {
            frame.style.setProperty(item.outerBgVar, (!settings.enabled || cover) ? mixColor((settings.enabled && outerColor) || item.defaultOuter, alpha) : 'transparent');
        }
        frame.style.setProperty(item.innerVar, (!settings.enabled || cover) ? mixColor((settings.enabled && innerColor) || (item.hasLayered && !activeLayered ? 'var(--ag-ui-page)' : item.defaultInner), alpha) : 'transparent');
        if (item.outerVar) {
            frame.style.setProperty(item.outerVar, (!settings.enabled || !cover || !outerColor) ? 'var(--ag-ui-border)' : mixColor(outerColor, alpha));
        }
        frame.style.setProperty(item.blurVar, ((settings.enabled && cover ? blur : 0) * ratio) + 'px');
    }

    function detectImageEdgeColor(img) {
        if (!extractCanvasBorderColor || !img.naturalWidth || !img.naturalHeight) return '';
        const ratio = Math.min(1, 2560 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return extractCanvasBorderColor(ctx, canvas.width, canvas.height);
    }

    function ensureTileEdgeColor() {
        if (settings.mode !== 'tile' || !settings.image || settings.imageColor ||
            detectedImageFor === settings.image || !loadedImageEl) {
            return false;
        }
        detectedImageColor = detectImageEdgeColor(loadedImageEl);
        detectedImageFor = settings.image;
        if (detectedImageColor) {
            settings.imageColor = detectedImageColor;
            return true;
        }
        return false;
    }

    function render() {
        const locked = !ready || busy;
        const actionLocked = locked || saving;
        const draggable = canDragWallpaper();
        enabledInput.checked = settings.enabled;
        enabledInput.disabled = locked;
        themeSelect.value = settings.theme;
        themeSelect.disabled = locked;
        for (const { prefix, layeredEl, coverEl } of surfaceBindings) {
            if (layeredEl) {
                layeredEl.checked = settings[prefix + 'Layered'];
                layeredEl.disabled = locked;
            }
            coverEl.checked = settings[prefix + 'Cover'];
            coverEl.disabled = locked;
        }
        for (const binding of colorBindings) {
            binding.inputEl.value = settings[binding.key] || '#131313';
            binding.inputEl.disabled = locked || !binding.cover();
            binding.resetEl.disabled = locked || !binding.cover() || !settings[binding.key];
        }
        const sidebarAlpha = !settings.enabled ? 100 : (settings.sidebarCover ? settings.sidebarOpacity : 0);
        document.documentElement.style.setProperty('--ag-ui-sidebar-alpha', sidebarAlpha + '%');
        imageInput.disabled = actionLocked;
        removeBtn.disabled = actionLocked || !settings.image;
        resetBtn.disabled = locked;
        openDragPreview.disabled = locked || !settings.enabled || !settings.image;
        dragPreviewReset.disabled = locked;
        dragPreviewMask.disabled = locked;
        if (!dragModal.hidden && (!settings.enabled || !settings.image)) closeModal();
        retryLoad.hidden = ready || !initFailed;
        retryLoad.disabled = syncInFlight;
        repairLaunch.hidden = !missingDebugPort;
        repairLaunch.disabled = actionLocked || repairingShortcuts;
        discard.disabled = actionLocked || !hasDraft;
        save.disabled = actionLocked;
        modeLabel.textContent = names[settings.mode];
        emptyHint.hidden = Boolean(settings.image);
        for (const button of modes) {
            button.disabled = locked;
            button.setAttribute('aria-pressed', String(button.dataset.mode === settings.mode));
        }
        const currentMinScale = minScale();
        for (const { id, input, output, unit, getValue, isDisabled } of sliders) {
            if (id === 'scale') input.min = currentMinScale;
            const value = getValue();
            input.value = value;
            output.value = value + unit;
            input.disabled = locked || isDisabled();
        }
        if (previewImage !== settings.image) {
            previewImage = settings.image;
            const bg = previewImage ? 'url("' + previewImage + '")' : 'none';
            for (const wp of wallpaperEls) wp.style.setProperty('--image', bg);
            naturalWidth = 0;
            naturalHeight = 0;
            loadedImageEl = null;
            if (!previewImage) {
                detectedImageFor = '';
                detectedImageColor = '';
            }
            if (previewImage) {
                const captured = previewImage;
                const img = new Image();
                img.onload = () => {
                    if (previewImage === captured) {
                        naturalWidth = img.naturalWidth;
                        naturalHeight = img.naturalHeight;
                        loadedImageEl = img;
                        if (ensureTileEdgeColor() && ready && !busy && !saving) {
                            changed();
                            return;
                        }
                        if (!dragModal.hidden) render();
                    }
                };
                img.src = captured;
            }
        }

        const metrics = hostMetrics();
        const metricsKey = [metrics.width, metrics.height, metrics.titlebarPct, metrics.leftPct, metrics.rightPct, metrics.tabStripPct].join('|');
        if (metricsKey !== lastMetricsKey) {
            lastMetricsKey = metricsKey;
            const aspect = metrics.width + ' / ' + metrics.height;
            const aspectNum = String(metrics.width / metrics.height);
            for (const frame of stages) {
                frame.style.setProperty('--ag-host-aspect', aspect);
                frame.style.setProperty('--ag-host-aspect-num', aspectNum);
                frame.style.setProperty('--ag-host-titlebar', metrics.titlebarPct + '%');
                frame.style.setProperty('--ag-host-left', metrics.leftPct + '%');
                frame.style.setProperty('--ag-host-right', metrics.rightPct + '%');
                frame.style.setProperty('--ag-host-tab-strip', metrics.tabStripPct + '%');
            }
        }

        // Batch layout reads before style writes to avoid forced reflow interleaving.
        const stageWidths = stages.map(frame => frame.clientWidth);
        const span = !dragModal.hidden ? dragSpan(dragStage) : null;
        const rules = [];
        for (let i = 0; i < stages.length; i++) {
            const width = stageWidths[i];
            if (!width) continue;
            const frame = stages[i];
            const ratio = width / metrics.width;
            for (const item of SURFACES) setSurfacePreview(frame, ratio, item);
            const css = wallpaperStyle({
                ...settings,
                blur: settings.blur * ratio,
                imageWidth: settings.imageWidth * ratio,
                imageHeight: settings.imageHeight * ratio,
            }, 'var(--image)');
            if (css) rules.push('#' + frame.id + ' .wallpaper {' + css + '}');
        }
        dragStage.dataset.draggable = String(draggable);
        const nextPreviewCss = rules.join('\n');
        if (nextPreviewCss !== lastPreviewCss) {
            lastPreviewCss = nextPreviewCss;
            previewSheet.replaceSync(nextPreviewCss);
        }
        const scaleRangeText = currentMinScale + '%–' + controls.scale.max + '%';
        const lockedHint = span && (Math.abs(span.dx) <= 0.5 || Math.abs(span.dy) <= 0.5)
            ? (settings.mode === 'tile'
                ? ' · 滚轮缩放（' + scaleRangeText + '）可多向拖动'
                : ' · 滚轮放大（' + scaleRangeText + '）可多向拖动')
            : ' · 缩放范围 ' + scaleRangeText;
        dragPreviewMeta.textContent = '水平 ' + settings.x + '% · 垂直 ' + settings.y + '% · 缩放 ' + effectiveScale() + '%' + lockedHint;
        applyTheme();
    }

    const stageObserver = new ResizeObserver(render);
    for (const stage of stages) stageObserver.observe(stage);

    function changed() {
        if (settings.mode === 'tile' && settings.image && !settings.imageColor) {
            if (detectedImageFor === settings.image && detectedImageColor) {
                settings.imageColor = detectedImageColor;
            } else {
                ensureTileEdgeColor();
            }
        }
        syncQueued = false;
        keepStatusAfterPreview = false;
        hasDraft = true;
        revision++;
        render();
        broadcastState();
        schedulePreview();
    }

    // --- Settings Controls ---

    function addSlider({ id, option, container, getValue, onInput, isDisabled }) {
        const row = document.createElement('div');
        row.className = 'slider';
        const caption = document.createElement('div');
        caption.className = 'slider-label';
        const label = document.createElement('label');
        label.textContent = option.label;
        label.htmlFor = 'wallpaper-' + id;
        const output = document.createElement('output');
        const input = document.createElement('input');
        input.id = label.htmlFor;
        input.type = 'range';
        input.min = option.min;
        input.max = option.max;
        input.value = option.value;
        input.disabled = true;
        input.addEventListener('input', () => onInput(input.valueAsNumber));
        caption.append(label, output);
        row.append(caption, input);
        find(container).append(row);
        sliders.push({ id, input, output, unit: option.unit, getValue, isDisabled });
    }

    for (const [key, option] of Object.entries(controls)) {
        addSlider({
            id: key,
            option,
            container: '#controls',
            getValue: () => key === 'scale' ? effectiveScale() : settings[key],
            onInput: value => {
                settings[key] = key === 'scale' ? Math.max(minScale(), value) : value;
                changed();
            },
            isDisabled: () => false,
        });
    }
    for (const { prefix, slug } of SURFACES) {
        for (const suffix of ['Opacity', 'Blur']) {
            const key = prefix + suffix;
            addSlider({
                id: key,
                option: surfaceControls[key],
                container: '#' + slug + '-controls',
                getValue: () => settings[key],
                onInput: value => { settings[key] = value; changed(); },
                isDisabled: () => !settings[prefix + 'Cover'],
            });
        }
    }
    for (const button of modes) {
        button.addEventListener('click', () => {
            settings.mode = button.dataset.mode;
            settings.scale = 100;
            settings.x = 50;
            settings.y = 50;
            changed();
        });
    }
    enabledInput.addEventListener('change', event => { settings.enabled = event.target.checked; changed(); });
    themeSelect.addEventListener('change', event => { settings.theme = event.target.value; changed(); });
    for (const { prefix, layeredEl, coverEl } of surfaceBindings) {
        if (layeredEl) {
            layeredEl.addEventListener('change', event => {
                settings[prefix + 'Layered'] = event.target.checked;
                changed();
            });
        }
        coverEl.addEventListener('change', event => {
            settings[prefix + 'Cover'] = event.target.checked;
            changed();
        });
    }
    for (const binding of colorBindings) {
        const updateColor = event => {
            const next = event.target.value.toLowerCase();
            if (settings[binding.key] === next) return;
            settings[binding.key] = next;
            changed();
        };
        binding.inputEl.addEventListener('input', updateColor);
        binding.inputEl.addEventListener('change', updateColor);
        binding.resetEl.addEventListener('click', () => {
            settings[binding.key] = '';
            changed();
        });
    }
    removeBtn.addEventListener('click', () => {
        settings.image = '';
        settings.imageColor = '';
        changed();
    });
    resetBtn.addEventListener('click', () => {
        for (const [key, option] of Object.entries(controls)) settings[key] = option.value;
        changed();
    });

    // --- Modal Coordination & Drag Preview Modal ---

    function syncModalInert() {
        const hasOpenModal = !dragModal.hidden || updateController.isOpen();
        for (const region of pageRegions) region.inert = hasOpenModal;
    }

    function closeModal(shouldRestoreFocus = true) {
        if (dragModal.hidden) return;
        const restoreFocus = shouldRestoreFocus && dragModal.contains(document.activeElement);
        stopStageDrag();
        dragModal.hidden = true;
        syncModalInert();
        if (restoreFocus && !openDragPreview.disabled) openDragPreview.focus();
    }

    function bindInteractiveStage(stage) {
        let drag;
        const stopDrag = () => {
            if (!drag) return;
            const { pointerId } = drag;
            drag = undefined;
            delete stage.dataset.dragging;
            if (stage.hasPointerCapture?.(pointerId)) stage.releasePointerCapture?.(pointerId);
        };
        stage.addEventListener('pointerdown', event => {
            if (event.button !== 0 || !canDragWallpaper()) return;
            event.preventDefault();
            stage.setPointerCapture?.(event.pointerId);
            stage.dataset.dragging = 'true';
            drag = {
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startX: settings.x,
                startY: settings.y,
            };
        });
        stage.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            if (!canDragWallpaper()) {
                stopDrag();
                return;
            }
            const { dx, dy } = dragSpan(stage);
            const deltaX = event.clientX - drag.startClientX;
            const deltaY = event.clientY - drag.startClientY;
            const nextX = Math.abs(dx) > 0.5 ? Math.min(100, Math.max(0, Math.round(drag.startX + (deltaX / dx) * 100))) : drag.startX;
            const nextY = Math.abs(dy) > 0.5 ? Math.min(100, Math.max(0, Math.round(drag.startY + (deltaY / dy) * 100))) : drag.startY;
            if (nextX !== settings.x || nextY !== settings.y) {
                settings.x = nextX;
                settings.y = nextY;
                changed();
            }
        });
        stage.addEventListener('pointerup', event => {
            if (drag && event.pointerId === drag.pointerId) stopDrag();
        });
        stage.addEventListener('pointercancel', stopDrag);
        stage.addEventListener('lostpointercapture', stopDrag);
        stage.addEventListener('wheel', event => {
            if (!canDragWallpaper() || !event.deltaY) return;
            event.preventDefault();
            const step = event.deltaY < 0 ? 5 : -5;
            const nextScale = Math.min(controls.scale.max, Math.max(minScale(), effectiveScale() + step));
            if (nextScale !== effectiveScale()) {
                settings.scale = nextScale;
                if (drag) {
                    drag.startClientX = event.clientX;
                    drag.startClientY = event.clientY;
                    drag.startX = settings.x;
                    drag.startY = settings.y;
                }
                changed();
            }
        }, { passive: false });
        stage.addEventListener('keydown', event => {
            if (!canDragWallpaper()) return;
            const moveStep = event.shiftKey ? 5 : 1;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                const delta = event.key === 'ArrowRight' ? moveStep : -moveStep;
                const nextX = Math.min(100, Math.max(0, settings.x + delta));
                if (nextX !== settings.x) {
                    settings.x = nextX;
                    changed();
                }
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                const delta = event.key === 'ArrowDown' ? moveStep : -moveStep;
                const nextY = Math.min(100, Math.max(0, settings.y + delta));
                if (nextY !== settings.y) {
                    settings.y = nextY;
                    changed();
                }
            } else if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
                event.preventDefault();
                const nextScale = Math.min(controls.scale.max, Math.max(minScale(), effectiveScale() + 5));
                if (nextScale !== effectiveScale()) {
                    settings.scale = nextScale;
                    changed();
                }
            } else if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') {
                event.preventDefault();
                const nextScale = Math.min(controls.scale.max, Math.max(minScale(), effectiveScale() - 5));
                if (nextScale !== effectiveScale()) {
                    settings.scale = nextScale;
                    changed();
                }
            }
        });
        return stopDrag;
    }

    const stopStageDrag = bindInteractiveStage(dragStage);
    openDragPreview.addEventListener('click', () => {
        if (!canOpenDragPreview() || !dragModal.hidden) return;
        updateController.close(false);
        dragModal.hidden = false;
        syncModalInert();
        render();
        closeDragPreview.focus();
    });
    closeDragPreview.addEventListener('click', () => closeModal());
    dragModal.addEventListener('click', event => {
        if (event.target === dragModal) closeModal();
    });
    dragPreviewMask.addEventListener('change', event => {
        dragStage.dataset.hideMask = String(!event.target.checked);
    });
    dragPreviewReset.addEventListener('click', () => {
        settings.x = controls.x.value;
        settings.y = controls.y.value;
        settings.scale = controls.scale.value;
        changed();
    });

    // --- Plugin Update Dialog Submodule ---

    function createUpdateController({ onBeforeOpen, onModalStateChange }) {
        const pluginVersion = find('#plugin-version');
        const githubLink = find('#github-link');
        const checkUpdateBtn = find('#check-update');
        const updateModal = find('#update-modal');
        const closeUpdateModalBtn = find('#close-update-modal');
        const updateStatusIcon = find('#update-status-icon');
        const updateStatusPath = find('#update-status-path');
        const updateStatusText = find('#update-status-text');
        const updateSourceBadge = find('#update-source-badge');
        const updateProgressLabel = find('#update-progress-label');
        const updateProgressValue = find('#update-progress-value');
        const updateProgressTrack = find('#update-progress-track');
        const updateProgressFill = find('#update-progress-fill');
        const updateCurrentVersion = find('#update-current-version');
        const updateLatestVersion = find('#update-latest-version');
        const updateGithubLink = find('#update-github-link');
        const updateGithubLinkLabel = find('#update-github-link-label');
        const copyGithubLinkBtn = find('#copy-github-link');
        const updateNotesWrap = find('#update-notes-wrap');
        const updateNotesLabel = find('#update-notes-label');
        const updateNotes = find('#update-notes');
        const updateFeedback = find('#update-feedback');
        const updateActionBtn = find('#update-action');

        const UPDATE_STATUS_TEXT = {
            idle: '检查更新',
            checking: '正在检查…',
            current: '已是最新版本',
            available: '发现新版本',
            installing: '正在下载并安装…',
            installed: '更新已完成',
            reloading: '正在重新加载…',
            error: '更新未完成',
        };
        const UPDATE_PHASE_TEXT = {
            check: '正在连接 GitHub 仓库',
            download: '正在下载更新包',
            verify: '正在校验更新包',
            extract: '正在准备插件文件',
            backup: '正在备份当前版本',
            install: '正在替换插件文件',
            recover: '正在恢复原版本',
            complete: '更新完成',
        };
        const UPDATE_ERROR_TEXT = {
            network: '连接 GitHub 失败，请稍后重试',
            verification: '未通过更新包校验',
            location: '无法确认插件安装目录，请检查目录位置或链接后重试',
            busy: '已有更新正在进行',
            install: '未能确认安装完成，请重新检查更新',
            rollback: '恢复失败，请重新运行 manage.cjs install 修复',
        };
        const UPDATE_ERROR_DETAIL = {
            timeout: '连接超时，请检查网络或代理后重试',
            dns: '无法解析 GitHub 地址，请检查网络设置',
            certificate: '无法验证 HTTPS 证书，请检查代理或系统证书',
            proxy: '代理连接失败，请检查系统或环境变量代理设置',
            http: 'GitHub 暂时拒绝请求，请稍后重试',
            connection: '网络连接中断，请检查网络后重试',
            permission: '插件文件被占用或无写入权限，请关闭占用后重试',
            'install-location': '无法确认标准插件安装目录，请运行 manage.cjs install 更新',
            'legacy-lock': '旧版更新锁仍存在。请退出旧客户端后检查遗留锁，再重试。',
            'dev-workspace': '当前运行在源码工作区，仅支持检查与跳转 GitHub',
            'plan-expired': '更新信息已变化或过期，请重新检查更新',
        };
        const RELOAD_POLL_INTERVAL_MS = 600;
        const RELOAD_POLL_MAX_ATTEMPTS = 10;

        let updateState = {
            state: 'idle',
            repoUrl: DEFAULT_REPO_URL,
        };
        let updateBusy = false;
        let updatePollTimer;
        let updateEpoch = 0;
        let updateMeterPhase = null;
        let updateCopyTimer;

        function formatVersionWithCommit(version, commitShort) {
            if (!version) return '—';
            return commitShort ? `v${version} (${commitShort})` : `v${version}`;
        }

        function mapUpdateRequestError(action, error) {
            const statusCode = error?.status;
            const isClientError = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500;
            if (action === 'reload') {
                if (isClientError) {
                    const rawCode = typeof error.code === 'string' ? error.code : '';
                    const rawDetail = typeof error.detail === 'string' ? error.detail : '';
                    return {
                        ...updateState,
                        state: 'error',
                        error: UPDATE_ERROR_TEXT[rawCode] ? rawCode : 'install',
                        errorDetail: UPDATE_ERROR_DETAIL[rawDetail]
                            ? rawDetail
                            : (UPDATE_ERROR_DETAIL[rawCode] ? rawCode : undefined),
                        progress: undefined,
                    };
                }
                if (!Number.isInteger(statusCode) || updateState.state === 'reloading') {
                    return { ...updateState, state: 'reloading' };
                }
                return {
                    ...updateState,
                    state: 'error',
                    error: 'install',
                    errorDetail: UPDATE_ERROR_DETAIL[error.detail] ? error.detail : undefined,
                    progress: undefined,
                };
            }
            if (action === 'status' && updateState.state === 'reloading' && !Number.isInteger(statusCode)) {
                return { ...updateState, state: 'reloading' };
            }
            if (Number.isInteger(statusCode)) {
                const rawCode = typeof error.code === 'string' ? error.code : '';
                const rawDetail = typeof error.detail === 'string' ? error.detail : '';
                const mappedError = UPDATE_ERROR_TEXT[rawCode] ? rawCode : (isClientError ? 'verification' : 'network');
                const mappedDetail = UPDATE_ERROR_DETAIL[rawDetail]
                    ? rawDetail
                    : (UPDATE_ERROR_DETAIL[rawCode] ? rawCode : (isClientError ? undefined : 'http'));
                return {
                    ...updateState,
                    state: 'error',
                    error: mappedError,
                    errorDetail: mappedDetail,
                    progress: undefined,
                };
            }
            return { ...updateState, state: 'error', error: 'network', errorDetail: 'connection', progress: undefined };
        }

        function renderUpdateProgress() {
            const s = updateState;
            const progress = s.progress || {};
            const phase = progress.phase;
            const complete = ['current', 'available', 'installed'].includes(s.state);
            const active = ['checking', 'installing', 'reloading'].includes(s.state);
            const known = s.state === 'installing' && phase === 'download' &&
                Number.isSafeInteger(progress.total) && progress.total > 0 &&
                Number.isSafeInteger(progress.received) && progress.received >= 0 && progress.received <= progress.total;
            const fraction = known ? progress.received / progress.total : (complete ? 1 : null);
            const meterKey = `${s.state}:${known ? 'download' : (phase || 'unknown')}`;
            if (updateMeterPhase !== meterKey) {
                updateMeterPhase = meterKey;
                updateProgressFill.style.transition = 'none';
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => updateProgressFill.style.removeProperty('transition'));
                });
            }
            let label = UPDATE_PHASE_TEXT[phase] || '正在处理';
            if (s.state === 'idle') label = '等待检查';
            else if (s.state === 'checking') label = UPDATE_PHASE_TEXT.check;
            else if (s.state === 'current') label = '检查完成';
            else if (s.state === 'available') label = '准备就绪';
            else if (s.state === 'installed') label = UPDATE_PHASE_TEXT.complete;
            else if (s.state === 'reloading') label = '正在重新加载插件';
            else if (s.state === 'error') label = '操作未完成，可重试';

            updateProgressLabel.textContent = label;
            if (known) {
                updateProgressValue.textContent = `${(progress.received / 1048576).toFixed(1)} / ${(progress.total / 1048576).toFixed(1)} MB · ${Math.floor(fraction * 100)}%`;
            } else if (s.state === 'installing' && phase === 'download' && Number.isSafeInteger(progress.received)) {
                updateProgressValue.textContent = `已下载 ${(progress.received / 1048576).toFixed(1)} MB`;
            } else {
                updateProgressValue.textContent = complete ? '100%' : '';
            }

            updateModal.dataset.progress = s.state === 'error' ? 'error' : (fraction === null ? 'unknown' : 'known');
            updateProgressTrack.setAttribute('aria-label', label);
            if (fraction !== null) {
                updateProgressTrack.setAttribute('aria-valuenow', String(Math.floor(fraction * 100)));
                updateProgressFill.style.transform = `scaleX(${fraction})`;
            } else {
                updateProgressTrack.removeAttribute('aria-valuenow');
                updateProgressFill.style.removeProperty('transform');
            }
            updateStatusIcon.dataset.busy = String(active);
            updateStatusIcon.dataset.complete = String(complete);
            updateStatusIcon.dataset.error = String(s.state === 'error');
            updateStatusPath.setAttribute('d', complete
                ? 'M4.5 10l3.5 3.5 7.5-7.5'
                : (s.state === 'error' ? 'M10 5.5v5.5M10 14h.01' : 'M15.7 8a6 6 0 1 0-.2 4.5M16 3.5V8h-4.5'));
        }

        function renderUpdateState() {
            const s = updateState;
            const repoUrl = safeHttpUrl(s.repoUrl, DEFAULT_REPO_URL);
            if (s.currentVersion) {
                pluginVersion.textContent = 'v' + s.currentVersion;
                pluginVersion.hidden = false;
            }
            githubLink.href = repoUrl;
            checkUpdateBtn.dataset.hasUpdate = String(s.state === 'available');

            const isCommitUpdate = s.state === 'available' && s.updateReason === 'commit';
            updateStatusText.textContent = isCommitUpdate ? '发现最新提交' : (UPDATE_STATUS_TEXT[s.state] || UPDATE_STATUS_TEXT.error);
            updateModal.setAttribute('aria-busy', String(['checking', 'installing', 'reloading'].includes(s.state)));

            if (s.sourceKind === 'release') {
                updateSourceBadge.textContent = 'Release';
                updateSourceBadge.hidden = false;
            } else if (s.sourceKind === 'main') {
                updateSourceBadge.textContent = 'main 分支';
                updateSourceBadge.hidden = false;
            } else {
                updateSourceBadge.hidden = true;
            }

            renderUpdateProgress();

            updateCurrentVersion.textContent = formatVersionWithCommit(s.currentVersion, s.currentCommitShort);
            updateLatestVersion.textContent = formatVersionWithCommit(s.latestVersion, s.latestCommitShort);

            const releaseUrl = safeHttpUrl(s.releaseUrl, '');
            const commitUrl = safeHttpUrl(s.commitUrl, '');
            const targetUrl = releaseUrl || commitUrl || repoUrl;
            updateGithubLink.href = targetUrl;
            updateGithubLinkLabel.textContent = releaseUrl
                ? '前往 GitHub Release 发布页'
                : (commitUrl ? '在 GitHub 查看最新提交' : '在 GitHub 查看仓库');

            const showNotes = Boolean(s.notes) && ['available', 'current'].includes(s.state);
            updateNotesWrap.hidden = !showNotes;
            if (showNotes) {
                updateNotesLabel.textContent = s.sourceKind === 'main' ? '最新提交说明' : '更新内容';
                updateNotes.textContent = String(s.notes).split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 6).join('\n');
            } else {
                updateNotes.textContent = '';
            }

            let feedback = '';
            let feedbackError = false;
            if (s.state === 'error') {
                feedbackError = true;
                feedback = UPDATE_ERROR_DETAIL[s.errorDetail] || UPDATE_ERROR_TEXT[s.error] || UPDATE_ERROR_TEXT.network;
            } else if (s.state === 'available') {
                if (!s.canApply) {
                    feedback = UPDATE_ERROR_DETAIL[s.applyDisabledReason] || UPDATE_ERROR_DETAIL['install-location'];
                } else {
                    feedback = '现有壁纸、透明度和外观设置将保留';
                }
            } else if (s.state === 'installed') {
                feedback = s.persistenceUpdated
                    ? '含启动持久化脚本变更，后续退出 Antigravity 时可重跑 manage.cjs install'
                    : '请点击「重新加载插件」以启用新版本';
            } else if (s.state === 'reloading') {
                feedback = 'Sidecar 正在重启；若未自动刷新，请关闭后重新打开本面板';
            } else if (s.state === 'current' && s.sourceKind === 'main' && !s.currentCommit) {
                feedback = '当前版本一致；未记录本地提交哈希，暂无法比对同版本后续提交';
            }
            updateFeedback.textContent = feedback;
            updateFeedback.classList.toggle('error', feedbackError);

            const canShowAction = (s.state === 'available' && s.canApply) || ['installed', 'error'].includes(s.state);
            updateActionBtn.hidden = !canShowAction;
            updateActionBtn.disabled = updateBusy;
            updateActionBtn.textContent = s.state === 'installed'
                ? '重新加载插件'
                : (s.state === 'error' ? '重试' : '一键更新');
        }

        function pollReloadRecovery(ticket, attempt = 0) {
            updatePollTimer = setTimeout(async () => {
                if (ticket !== updateEpoch || updateState.state !== 'reloading') return;
                try {
                    const probe = await request('GET', undefined, '/api/update');
                    if (ticket !== updateEpoch) return;
                    if (probe && probe.state !== 'reloading') {
                        location.reload();
                        return;
                    }
                } catch {
                    // Sidecar may still be restarting; retry until max attempts.
                }
                if (ticket !== updateEpoch || updateState.state !== 'reloading') return;
                if (attempt + 1 < RELOAD_POLL_MAX_ATTEMPTS) {
                    pollReloadRecovery(ticket, attempt + 1);
                } else {
                    updateFeedback.textContent = '插件重启已完成或超时，请关闭并重新打开右侧 Antigravity Background 面板以加载新版本。';
                }
            }, RELOAD_POLL_INTERVAL_MS);
        }

        async function callUpdateApi(action) {
            const ticket = ++updateEpoch;
            clearTimeout(updatePollTimer);
            updateBusy = true;
            if (action === 'check') {
                updateState = { ...updateState, state: 'checking', error: undefined, errorDetail: undefined, progress: { phase: 'check' } };
            } else if (action === 'apply') {
                updateState = { ...updateState, state: 'installing', error: undefined, errorDetail: undefined, progress: { phase: 'verify' } };
            }
            renderUpdateState();
            try {
                let next;
                if (action === 'status') {
                    next = await request('GET', undefined, '/api/update');
                } else if (action === 'check') {
                    next = await request('POST', {}, '/api/update/check');
                } else if (action === 'apply') {
                    next = await request('POST', { version: updateState.latestVersion, commit: updateState.latestCommit }, '/api/update/apply');
                } else if (action === 'reload') {
                    next = await request('POST', {}, '/api/update/reload');
                }
                if (ticket !== updateEpoch) return;
                updateState = next;
            } catch (error) {
                if (ticket !== updateEpoch) return;
                updateState = mapUpdateRequestError(action, error);
            } finally {
                if (ticket === updateEpoch) {
                    updateBusy = false;
                    renderUpdateState();
                    if (!updateModal.hidden && ['checking', 'installing'].includes(updateState.state)) {
                        updatePollTimer = setTimeout(() => void callUpdateApi('status'), 500);
                    } else if (action === 'reload' && updateState.state === 'reloading') {
                        pollReloadRecovery(ticket, 0);
                    }
                }
            }
        }

        function open() {
            onBeforeOpen();
            updateModal.hidden = false;
            onModalStateChange();
            renderUpdateState();
            closeUpdateModalBtn.focus();
            if (['installed', 'reloading'].includes(updateState.state)) return;
            if (['checking', 'installing'].includes(updateState.state)) {
                void callUpdateApi('status');
                return;
            }
            void callUpdateApi('check');
        }

        function close(shouldRestoreFocus = true) {
            if (updateModal.hidden) return;
            const restoreFocus = shouldRestoreFocus && updateModal.contains(document.activeElement);
            clearTimeout(updatePollTimer);
            updateModal.hidden = true;
            onModalStateChange();
            if (restoreFocus) checkUpdateBtn.focus();
        }

        function init() {
            renderUpdateState();
            const initialEpoch = updateEpoch;
            void request('GET', undefined, '/api/update')
                .then(info => {
                    if (initialEpoch !== updateEpoch) return;
                    updateState = info;
                    renderUpdateState();
                })
                .catch(() => {});
        }

        function cleanup() {
            clearTimeout(updatePollTimer);
            clearTimeout(updateCopyTimer);
        }

        checkUpdateBtn.addEventListener('click', open);
        closeUpdateModalBtn.addEventListener('click', () => close());
        updateModal.addEventListener('click', event => {
            if (event.target === updateModal) close();
        });
        updateActionBtn.addEventListener('click', () => {
            const action = updateState.state === 'installed' ? 'reload' : (updateState.state === 'error' ? 'check' : 'apply');
            void callUpdateApi(action);
        });
        copyGithubLinkBtn.addEventListener('click', async () => {
            const url = safeHttpUrl(updateGithubLink.getAttribute('href'), DEFAULT_REPO_URL);
            let copied = false;
            try {
                await navigator.clipboard.writeText(url);
                copied = true;
            } catch {
                const box = document.createElement('textarea');
                box.value = url;
                box.style.position = 'fixed';
                box.style.opacity = '0';
                document.body.append(box);
                try {
                    box.select();
                    copied = Boolean(document.execCommand('copy'));
                } catch {
                    copied = false;
                } finally {
                    box.remove();
                }
            }
            copyGithubLinkBtn.textContent = copied ? '已复制' : '复制失败';
            clearTimeout(updateCopyTimer);
            updateCopyTimer = setTimeout(() => { copyGithubLinkBtn.textContent = '复制链接'; }, 1500);
        });

        return {
            init,
            open,
            close,
            cleanup,
            isOpen: () => !updateModal.hidden,
        };
    }

    const updateController = createUpdateController({
        onBeforeOpen: () => closeModal(false),
        onModalStateChange: syncModalInert,
    });

    window.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (!dragModal.hidden) closeModal();
        else if (updateController.isOpen()) updateController.close();
    });
    window.addEventListener('pagehide', () => {
        clearTimeout(previewTimer);
        updateController.cleanup();
    });

    // --- File Upload, Actions & Server Sync ---

    imageInput.addEventListener('change', async () => {
        const file = imageInput.files[0];
        if (!file) return;
        busy = true;
        render();
        message('正在读取图片…');
        let didChange = false;
        try {
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
            if (file.size > 32 * 1024 * 1024) throw new Error('请选择小于 32 MB 的图片。');
            let bitmap;
            try {
                bitmap = await createImageBitmap(file);
            } catch {
                throw new Error('图片解析失败，文件可能已损坏或格式不受支持。');
            }
            try {
                const ratio = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
                canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('浏览器绘图上下文不可用，无法处理图片。');
                ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                const imageColor = extractCanvasBorderColor ? extractCanvasBorderColor(ctx, canvas.width, canvas.height) : '';
                const nextImage = canvas.toDataURL('image/webp', .94);
                settings = normalize({
                    ...settings, image: nextImage, imageColor,
                    imageWidth: canvas.width, imageHeight: canvas.height, enabled: true,
                });
                detectedImageFor = settings.image;
                detectedImageColor = imageColor;
            } finally { bitmap.close(); }
            busy = false;
            message('');
            didChange = true;
            changed();
        } catch (error) {
            message(error.message || '读取图片失败，请重试。', true);
        } finally {
            busy = false;
            imageInput.value = '';
            if (!didChange) render();
        }
    });

    retryLoad.addEventListener('click', () => {
        if (ready || syncInFlight) return;
        message('正在重新读取设置…');
        void syncFromServer({ initial: true });
    });

    repairLaunch.addEventListener('click', async () => {
        if (repairingShortcuts) return;
        repairingShortcuts = true;
        render();
        message('正在检查并修复 Antigravity 快捷方式…', false, false, { sticky: true });
        try {
            const res = await request('POST', {}, '/api/repair-shortcuts');
            const asarTip = res.asarPatched
                ? ''
                : '；也可退出后运行一次 Antigravity-UI.cmd / manage.cjs install 开启全局启动持久化';
            if (res.repaired > 0) {
                message('已为 ' + res.repaired + ' 个快捷方式（共 ' + res.total + ' 个）补充调试端口参数。请完全退出后通过快捷方式重启 Antigravity' + asarTip + '。', false, false, { sticky: true });
            } else if (res.total > 0) {
                message('已找到 ' + res.total + ' 个快捷方式且参数完整。请完全退出后改由桌面或开始菜单快捷方式重启 Antigravity' + asarTip + '。', false, false, { sticky: true });
            } else {
                message('未找到 Antigravity 快捷方式，请退出后运行 manage.cjs install 或在快捷方式末尾追加 --remote-debugging-port=0 --remote-debugging-address=127.0.0.1。', true, false, { sticky: true });
            }
        } catch (error) {
            message('修复失败：' + error.message, true, false, { sticky: true });
        } finally {
            repairingShortcuts = false;
            render();
        }
    });

    discard.addEventListener('click', async () => {
        clearTimeout(previewTimer);
        previewTimer = undefined;
        previewQueued = false;
        keepStatusAfterPreview = false;
        syncQueued = false;
        busy = true;
        saving = true;
        actionRevision = revision;
        render();
        message('正在还原…');
        let synced = false;
        try {
            const result = await enqueue(() => request('POST', {}, '/api/preview/discard'));
            settings = normalize(result.settings);
            serverImage = settings.image;
            serverImageHash = result.imageHash;
            hasDraft = result.hasDraft;
            applyRuntimeLayout(result.runtime);
            revision++;
            message('已还原已保存设置。' + (result.runtime.error ? ' 背景连接提示：' + result.runtime.error : ''), false, Boolean(result.runtime.error));
            synced = true;
        } catch (error) { message('还原失败：' + error.message, true); }
        finally {
            busy = false;
            saving = false;
            render();
            if (synced) broadcastState();
        }
    });

    save.addEventListener('click', async () => {
        const submitted = revision;
        const snapshot = { ...settings };
        const hadPendingPreview = Boolean(previewTimer) || previewQueued;
        clearTimeout(previewTimer);
        previewTimer = undefined;
        previewQueued = false;
        keepStatusAfterPreview = false;
        syncQueued = false;
        saving = true;
        actionRevision = submitted;
        render();
        message('正在保存…');
        let synced = false;
        try {
            const result = await enqueue(() => postSettings('/api/settings', snapshot));
            saving = false;
            syncServerImage(result);
            if (submitted === revision) {
                settings = normalize(result.settings);
                hasDraft = result.hasDraft;
            }
            const hint = submitted === revision ? '已保存。' : '已保存，当前还有新的调整。';
            message(hint + (result.runtime.error ? ' 背景连接提示：' + result.runtime.error : ' 背景已应用。'), false, Boolean(result.runtime.error));
            synced = true;
            if (submitted !== revision) previewQueued = true;
        } catch (error) {
            message(error.message, true);
            if (hasDraft && (hadPendingPreview || submitted !== revision)) {
                previewQueued = true;
                keepStatusAfterPreview = true;
            }
        } finally {
            saving = false;
            render();
            if (synced) broadcastState();
            if (previewQueued && !previewInFlight) {
                previewQueued = false;
                flushPreview();
            }
        }
    });

    async function syncFromServer({ initial = false } = {}) {
        if (syncInFlight) {
            syncQueued = true;
            return;
        }
        syncInFlight = true;
        if (initial) {
            initFailed = false;
            render();
        }
        const startRevision = revision;
        const token = ++syncToken;
        try {
            const result = await request();
            const nextSettings = normalize(result.settings);
            const nextHasDraft = result.hasDraft;
            if (!initial && (token !== syncToken || revision !== startRevision || isInteractionBusy())) {
                return;
            }
            applyRuntimeLayout(result.runtime);
            const stateChanged = initial || !sameValues(settings, nextSettings) || hasDraft !== nextHasDraft ||
                serverImageHash !== result.imageHash;
            settings = nextSettings;
            serverImage = settings.image;
            serverImageHash = result.imageHash;
            hasDraft = nextHasDraft;
            ready = true;
            initFailed = false;
            const runtimeError = Boolean(result.runtime.error);
            if (stateChanged) {
                revision++;
                if (hasDraft) {
                    if (runtimeError || !repairNoticeActive) {
                        message('实时预览 · 未保存' + (runtimeError ? '（' + result.runtime.error + '）' : ''), runtimeError, runtimeError);
                    }
                } else if (runtimeError) {
                    message(result.runtime.error, false, true);
                } else if (!repairNoticeActive) {
                    message('');
                }
            } else if (!initial) {
                if (runtimeError) {
                    if (hasDraft) {
                        message('实时预览 · 未保存（' + result.runtime.error + '）', true, true);
                    } else if (hasRuntimeNotice || !status.textContent) {
                        message(result.runtime.error, false, true);
                    }
                } else if (!repairNoticeActive && (hasRuntimeNotice || status.classList.contains('error'))) {
                    message(hasDraft ? '实时预览 · 未保存' : '');
                }
            }
        } catch (error) {
            if (initial) {
                initFailed = true;
                message('读取失败：' + error.message, true);
            }
        } finally {
            syncInFlight = false;
            render();
            if (syncQueued) {
                syncQueued = false;
                if (ready && !isInteractionBusy()) {
                    void syncFromServer();
                }
            }
        }
    }

    function handleActivation() {
        updateHostTheme();
        applyTheme();
        if (!ready) {
            if (!syncInFlight) void syncFromServer({ initial: true });
            return;
        }
        if (isInteractionBusy()) return;
        void syncFromServer();
    }
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) handleActivation();
    });
    window.addEventListener('focus', handleActivation);

    async function initialize() {
        updateHostTheme();
        render();
        updateController.init();
        await syncFromServer({ initial: true });
    }
    void initialize();
})();
