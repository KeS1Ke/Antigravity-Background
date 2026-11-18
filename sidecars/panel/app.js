(() => {
    const { controls, surfaceControls, defaults, normalize, wallpaperStyle } = window.wallpaperAppearance;
    const DIALOG_SUFFIXES = ['Cover', 'OuterColor', 'InnerColor', 'Opacity', 'Blur'];
    const find = selector => document.querySelector(selector);
    const status = find('#status');
    const imageInput = find('#image');
    const discard = find('#discard');
    const save = find('#save');
    const sliders = [];
    const modes = [...document.querySelectorAll('[data-mode]')];
    const dialogTargets = [...document.querySelectorAll('[data-dialog-target]')];
    const names = { fill: '填充', stretch: '拉伸', fit: '适应', tile: '平铺' };
    const preview = find('.wallpaper');
    const previewSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, previewSheet];
    if (window.parent !== window) document.documentElement.dataset.embedded = 'true';
    const systemTheme = matchMedia('(prefers-color-scheme: light)');
    const tabId = crypto.randomUUID();
    const channel = new BroadcastChannel('antigravity-ui-panel-sync');
    let settings = normalize();
    let activeDialogTarget = 'bubble';
    let ready = false;
    let busy = false;
    let saving = false;
    let hasDraft = false;
    let revision = 0;
    let actionRevision = 0;
    let hostTheme;
    let hostThemeColor;
    let previewImage;
    let serverImage;
    let serverImageHash;
    let previewTimer;
    let previewInFlight = false;
    let previewQueued = false;
    let syncInFlight = false;
    let syncToken = 0;
    let operations = Promise.resolve();

    function syncOverviewFromBubble() {
        for (const suffix of DIALOG_SUFFIXES) settings['overview' + suffix] = settings['bubble' + suffix];
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
        const response = await transport(path, {
            method, headers: { 'Content-Type': 'application/json' },
            ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
        });
        const result = await response.json();
        if (!response.ok) {
            const error = new Error(result.error || '设置请求失败。');
            error.status = response.status;
            error.code = result.code;
            throw error;
        }
        return result;
    }

    function syncServerImage(result) {
        serverImage = result.settings.image;
        serverImageHash = result.imageHash;
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

    function schedulePreview() {
        if (previewInFlight) {
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
        if (previewInFlight) {
            previewQueued = true;
            return;
        }
        previewInFlight = true;
        let submitted;
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
            message(
                result.runtime.error
                    ? '实时预览失败：' + result.runtime.error
                    : (hasDraft ? '实时预览 · 未保存' : ''),
                Boolean(result.runtime.error)
            );
            broadcastState();
        }).catch(error => {
            if (submitted === revision && !saving) {
                message('实时预览失败：' + error.message, true);
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
    window.addEventListener('pagehide', () => clearTimeout(previewTimer));

    function message(text = '', error = false) {
        status.textContent = text;
        status.classList.toggle('error', error);
    }

    function broadcastState() {
        const canOmitImage = settings.image === serverImage && serverImageHash !== undefined;
        channel.postMessage({
            source: tabId,
            settings: canOmitImage ? { ...settings, image: undefined } : { ...settings },
            imageHash: canOmitImage ? serverImageHash : undefined,
            hasDraft,
            serverImageHash,
            statusText: status.textContent,
            statusError: status.classList.contains('error'),
        });
    }

    function applyIncomingState(msg, resolvedImage) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
        previewQueued = false;
        settings = normalize({ ...msg.settings, image: resolvedImage });
        if (msg.serverImageHash === '') {
            serverImage = '';
            serverImageHash = '';
        } else if (msg.serverImageHash === msg.imageHash || msg.settings.image === undefined) {
            serverImage = resolvedImage;
            serverImageHash = msg.serverImageHash;
        }
        hasDraft = msg.hasDraft;
        revision++;
        message(msg.statusText, msg.statusError);
        render();
    }

    async function applyBroadcast(msg) {
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
        if (msg.imageHash && settings.image && (await sha256Hex(settings.image)) === msg.imageHash) {
            if (token !== syncToken || saving || busy) return;
            applyIncomingState(msg, settings.image);
            return;
        }
        if (token === syncToken) void syncFromServer();
    }

    channel.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.source === tabId || !ready || saving || busy) return;
        void applyBroadcast(msg);
    });

    function parseRgb(resolved) {
        const rgb = resolved.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
        if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
        const srgb = resolved.match(/^color\(\s*srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+%?))?\s*\)$/i);
        if (!srgb) return null;
        const alpha = srgb[4] === undefined ? 1 : (srgb[4].endsWith('%') ? Number(srgb[4].slice(0, -1)) / 100 : Number(srgb[4]));
        return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, alpha];
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
        hostThemeColor = color;
        const [r, g, b, a] = channels;
        if (a > 0) hostTheme = (r * .2126 + g * .7152 + b * .0722) > 150 ? 'light' : 'dark';
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

    const colorBindings = [
        { inputId: 'composerOuterColor', resetSelector: '[data-reset-color="composerOuterColor"]', key: () => 'composerOuterColor', cover: () => settings.composerCover },
        { inputId: 'composerInnerColor', resetSelector: '[data-reset-color="composerInnerColor"]', key: () => 'composerInnerColor', cover: () => settings.composerCover },
        { inputId: 'dialogOuterColor', resetSelector: '[data-reset-dialog-color="outer"]', key: () => activeDialogTarget + 'OuterColor', cover: () => settings[activeDialogTarget + 'Cover'] },
        { inputId: 'dialogInnerColor', resetSelector: '[data-reset-dialog-color="inner"]', key: () => activeDialogTarget + 'InnerColor', cover: () => settings[activeDialogTarget + 'Cover'] },
    ];

    function render() {
        const locked = !ready || busy;
        const actionLocked = locked || saving;
        const enabled = find('#enabled');
        const theme = find('#theme');
        const sidebarCover = find('#sidebar-cover');
        const composerCover = find('#composer-cover');
        const overviewSync = find('#overview-sync');
        const dialogCover = find('#dialog-cover');
        if (settings.overviewSync) activeDialogTarget = 'bubble';
        enabled.checked = settings.enabled;
        enabled.disabled = locked;
        theme.value = settings.theme;
        theme.disabled = locked;
        sidebarCover.checked = settings.sidebarCover;
        sidebarCover.disabled = locked;
        composerCover.checked = settings.composerCover;
        composerCover.disabled = locked;
        overviewSync.checked = settings.overviewSync;
        overviewSync.disabled = locked;
        find('#dialog-target-switch').hidden = settings.overviewSync;
        for (const button of dialogTargets) {
            button.disabled = locked || settings.overviewSync;
            button.setAttribute('aria-pressed', String(button.dataset.dialogTarget === activeDialogTarget));
        }
        dialogCover.checked = settings[activeDialogTarget + 'Cover'];
        dialogCover.disabled = locked;
        for (const binding of colorBindings) {
            const key = binding.key();
            const input = find('#' + binding.inputId);
            input.value = settings[key] || '#131313';
            input.disabled = locked || !binding.cover();
            find(binding.resetSelector).disabled = locked || !binding.cover() || !settings[key];
        }
        const sidebarAlpha = !settings.enabled ? 100 : (settings.sidebarCover ? settings.sidebarOpacity : 0);
        document.documentElement.style.setProperty('--ag-ui-sidebar-alpha', sidebarAlpha + '%');
        imageInput.disabled = actionLocked;
        find('#remove').disabled = actionLocked || !settings.image;
        find('#reset').disabled = locked;
        discard.disabled = actionLocked || !hasDraft;
        save.disabled = actionLocked;
        find('#mode-label').textContent = names[settings.mode];
        find('#empty').hidden = Boolean(settings.image);
        for (const button of modes) {
            button.disabled = locked;
            button.setAttribute('aria-pressed', String(button.dataset.mode === settings.mode));
        }
        for (const { input, output, unit, getValue, isDisabled } of sliders) {
            const value = getValue();
            input.value = value;
            output.value = value + unit;
            input.disabled = locked || isDisabled();
        }
        if (previewImage !== settings.image) {
            previewImage = settings.image;
            preview.style.setProperty('--image', previewImage ? 'url("' + previewImage + '")' : 'none');
        }
        const frame = find('#preview');
        const ratio = frame.clientWidth / 1600;
        const mix = (color, alpha) => 'color-mix(in srgb,' + color + ' ' + alpha + '%,transparent)';
        const setSurfacePreview = (cover, opacity, blur, outerColor, innerColor, defaultInner, outerVar, innerVar, blurVar) => {
            const alpha = !settings.enabled ? 100 : (cover ? opacity : 0);
            frame.style.setProperty(innerVar, mix((settings.enabled && innerColor) || defaultInner, alpha));
            frame.style.setProperty(outerVar, (!settings.enabled || !cover || !outerColor) ? 'var(--ag-ui-border)' : mix(outerColor, alpha));
            frame.style.setProperty(blurVar, ((settings.enabled && cover ? blur : 0) * ratio) + 'px');
        };
        frame.style.setProperty('--preview-sidebar', mix('var(--ag-ui-page)', sidebarAlpha));
        frame.style.setProperty('--preview-sidebar-blur', ((settings.enabled && settings.sidebarCover ? settings.sidebarBlur : 0) * ratio) + 'px');
        setSurfacePreview(settings.composerCover, settings.composerOpacity, settings.composerBlur, settings.composerOuterColor, settings.composerInnerColor, 'var(--ag-ui-page)', '--preview-outer', '--preview-inner', '--preview-composer-blur');
        setSurfacePreview(settings.bubbleCover, settings.bubbleOpacity, settings.bubbleBlur, settings.bubbleOuterColor, settings.bubbleInnerColor, 'var(--ag-ui-card)', '--preview-bubble-outer', '--preview-bubble-inner', '--preview-bubble-blur');
        setSurfacePreview(settings.overviewCover, settings.overviewOpacity, settings.overviewBlur, settings.overviewOuterColor, settings.overviewInnerColor, 'var(--ag-ui-card)', '--preview-overview-outer', '--preview-overview-inner', '--preview-overview-blur');
        const css = wallpaperStyle({ ...settings, blur: settings.blur * ratio, imageWidth: settings.imageWidth * ratio, imageHeight: settings.imageHeight * ratio }, 'var(--image)');
        previewSheet.replaceSync(css ? '.wallpaper {' + css + ' position: absolute; }' : '');
        applyTheme();
    }

    new ResizeObserver(render).observe(find('#preview'));

    function changed() {
        if (settings.overviewSync) syncOverviewFromBubble();
        hasDraft = true;
        revision++;
        render();
        broadcastState();
        schedulePreview();
    }

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
        sliders.push({ input, output, unit: option.unit, getValue, isDisabled });
    }

    for (const [key, option] of Object.entries(controls)) {
        addSlider({
            id: key,
            option,
            container: '#controls',
            getValue: () => settings[key],
            onInput: value => { settings[key] = value; changed(); },
            isDisabled: () => false,
        });
    }
    for (const [key, option] of Object.entries(surfaceControls)) {
        if (!key.startsWith('sidebar') && !key.startsWith('composer')) continue;
        const prefix = key.startsWith('sidebar') ? 'sidebar' : 'composer';
        addSlider({
            id: key,
            option,
            container: '#' + prefix + '-controls',
            getValue: () => settings[key],
            onInput: value => { settings[key] = value; changed(); },
            isDisabled: () => !settings[prefix + 'Cover'],
        });
    }
    for (const suffix of ['Opacity', 'Blur']) {
        addSlider({
            id: 'dialog' + suffix,
            option: surfaceControls['bubble' + suffix],
            container: '#dialog-controls',
            getValue: () => settings[activeDialogTarget + suffix],
            onInput: value => {
                settings[activeDialogTarget + suffix] = value;
                changed();
            },
            isDisabled: () => !settings[activeDialogTarget + 'Cover'],
        });
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
    for (const button of dialogTargets) {
        button.addEventListener('click', () => {
            if (settings.overviewSync || activeDialogTarget === button.dataset.dialogTarget) return;
            activeDialogTarget = button.dataset.dialogTarget;
            render();
        });
    }
    find('#enabled').addEventListener('change', event => { settings.enabled = event.target.checked; changed(); });
    find('#theme').addEventListener('change', event => { settings.theme = event.target.value; changed(); });
    find('#sidebar-cover').addEventListener('change', event => {
        settings.sidebarCover = event.target.checked;
        settings.sidebarTransparent = !settings.sidebarCover;
        changed();
    });
    find('#composer-cover').addEventListener('change', event => { settings.composerCover = event.target.checked; changed(); });
    find('#overview-sync').addEventListener('change', event => {
        settings.overviewSync = event.target.checked;
        if (settings.overviewSync) activeDialogTarget = 'bubble';
        changed();
    });
    find('#dialog-cover').addEventListener('change', event => {
        settings[activeDialogTarget + 'Cover'] = event.target.checked;
        changed();
    });
    for (const binding of colorBindings) {
        const colorInput = find('#' + binding.inputId);
        const updateColor = event => {
            const key = binding.key();
            const next = event.target.value.toLowerCase();
            if (settings[key] === next) return;
            settings[key] = next;
            changed();
        };
        colorInput.addEventListener('input', updateColor);
        colorInput.addEventListener('change', updateColor);
        find(binding.resetSelector).addEventListener('click', () => {
            settings[binding.key()] = '';
            changed();
        });
    }
    find('#remove').addEventListener('click', () => { settings.image = ''; changed(); });
    find('#reset').addEventListener('click', () => {
        Object.assign(settings, defaults, { mode: 'fit', x: 50, y: 50, scale: 100 });
        changed();
    });
    imageInput.addEventListener('change', async () => {
        const file = imageInput.files[0];
        if (!file) return;
        busy = true;
        render();
        message('正在读取图片…');
        try {
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
            if (file.size > 32 * 1024 * 1024) throw new Error('请选择小于 32 MB 的图片。');
            const bitmap = await createImageBitmap(file);
            try {
                const ratio = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
                canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
                canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                settings = normalize({
                    ...settings, image: canvas.toDataURL('image/webp', .94),
                    imageWidth: canvas.width, imageHeight: canvas.height, enabled: true,
                });
            } finally { bitmap.close(); }
            busy = false;
            changed();
        } catch (error) { message(error.message, true); }
        finally {
            busy = false;
            imageInput.value = '';
            render();
        }
    });
    discard.addEventListener('click', async () => {
        clearTimeout(previewTimer);
        previewTimer = undefined;
        previewQueued = false;
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
            revision++;
            message('已还原已保存设置。' + (result.runtime.error ? ' 背景连接提示：' + result.runtime.error : ''));
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
        clearTimeout(previewTimer);
        previewTimer = undefined;
        previewQueued = false;
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
            message(hint + (result.runtime.error ? ' 背景连接提示：' + result.runtime.error : ' 背景已应用。'));
            synced = true;
            if (submitted !== revision) schedulePreview();
        } catch (error) { message(error.message, true); }
        finally {
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
        if (syncInFlight) return;
        syncInFlight = true;
        const startRevision = revision;
        const token = ++syncToken;
        try {
            const result = await request();
            const nextSettings = normalize(result.settings);
            const nextHasDraft = result.hasDraft;
            if (!initial && (token !== syncToken || revision !== startRevision || saving || previewInFlight || previewQueued || busy || previewTimer)) {
                return;
            }
            const stateChanged = initial || !sameValues(settings, nextSettings) || hasDraft !== nextHasDraft ||
                serverImageHash !== result.imageHash;
            settings = nextSettings;
            serverImage = settings.image;
            serverImageHash = result.imageHash;
            hasDraft = nextHasDraft;
            ready = true;
            if (stateChanged) {
                revision++;
                if (hasDraft) {
                    message('实时预览 · 未保存' + (result.runtime.error ? '（' + result.runtime.error + '）' : ''), Boolean(result.runtime.error));
                } else if (result.runtime.error) {
                    message(result.runtime.error);
                } else if (!initial) {
                    message('');
                }
            } else if (!initial && !hasDraft && !result.runtime.error && status.classList.contains('error')) {
                message('');
            }
        } catch (error) {
            if (initial) message('读取失败：' + error.message, true);
        } finally {
            syncInFlight = false;
            render();
        }
    }

    function handleActivation() {
        updateHostTheme();
        applyTheme();
        if (!ready || saving || previewInFlight || previewQueued || busy || previewTimer || syncInFlight) return;
        void syncFromServer();
    }
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) handleActivation();
    });
    window.addEventListener('focus', handleActivation);

    async function initialize() {
        updateHostTheme();
        render();
        await syncFromServer({ initial: true });
    }
    void initialize();
})();
