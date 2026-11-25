import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installWallpaper, installPluginPanelSurface, RENDERER_VERSION, RENDERER_REVISION } from './renderer.mjs';
import { randomUUID } from 'node:crypto';

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
let cachedInstallWallpaperSource;
let cachedInstallPluginPanelSource;
function compactFunctionSource(source) {
    return source
        .replace(/^[ \t]*\/\/[^\r\n]*\r?\n/gm, '')
        .replace(/^[ \t]+/gm, '')
        .replace(/\r?\n{2,}/g, '\n');
}
function getInstallWallpaperSource() {
    return (cachedInstallWallpaperSource ??= compactFunctionSource(installWallpaper.toString()));
}
function getInstallPluginPanelSource() {
    return (cachedInstallPluginPanelSource ??= compactFunctionSource(installPluginPanelSurface.toString()));
}
const RENDERER_KEY = `${RENDERER_VERSION}:${RENDERER_REVISION}`;
const PLUGIN_HEARTBEAT_SKIP_MS = 3000;
const ATTACH_RETRY_DELAYS = [150, 250, 400, 600, 1000, 1500];
const HOST_PROBE_EXPRESSION = 'window === window.top && Boolean(window.electronNative && window.nativeStorage)';
const COLLECT_PLUGIN_SLOTS_BODY =
    'const rightBody = document.querySelector(\'[data-side-panel-body]:not([data-has-browser-hole="true"])\');' +
    'const rightRect = rightBody ? rightBody.getBoundingClientRect() : null;' +
    'const hasRightRect = Boolean(rightRect && rightRect.width > 0 && rightRect.height > 0);' +
    'const entries = [];' +
    'const seen = new Set();' +
    'const collect = (iframe, slot) => {' +
    'if (!iframe || seen.has(iframe)) return;' +
    'seen.add(iframe);' +
    'const sidecarId = slot?.getAttribute("data-sidecar-id") || "";' +
    'const src = iframe.getAttribute("src") || "";' +
    'if (sidecarId === "antigravity-ui/panel" || /^plugin:\\/\\/antigravity-ui--panel-/i.test(src)) return;' +
    'let isRightPanel = true;' +
    'if (slot && slot.getAttribute("data-visible") === "true") {' +
    'const r = slot.getBoundingClientRect();' +
    'if (r.width > 0 && r.height > 0) {' +
    'if (!hasRightRect) { isRightPanel = false; }' +
    'else {' +
    'const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;' +
    'isRightPanel = cx >= rightRect.left - 8 && cx <= rightRect.right + 8 && cy >= rightRect.top - 8 && cy <= rightRect.bottom + 8;' +
    '}' +
    '}' +
    '}' +
    'entries.push({ iframe, frameId: iframe.getAttribute("data-ag-ui-frame-id") || "", isRightPanel, sig: (slot?.getAttribute("data-testid") || "direct") + "|" + sidecarId + "|" + (slot?.getAttribute("data-frame-key") || "") + "|" + src + "|" + (slot?.getAttribute("data-visible") || "") + "|" + (isRightPanel ? "1" : "0") });' +
    '};' +
    'for (const slot of document.querySelectorAll(\'.agy-sheet > .pointer-events-none.overflow-clip > :is([data-testid="sidecar-iframe-slot"],[data-testid="mcp-app-frame-slot"],div:has(iframe))\')) { for (const iframe of slot.querySelectorAll("iframe")) collect(iframe, slot); }' +
    'if (rightBody) { for (const iframe of rightBody.querySelectorAll("iframe")) collect(iframe, null); }';
const PLUGIN_SLOT_SCAN_BODY =
    COLLECT_PLUGIN_SLOTS_BODY +
    'const known = []; const unknownFlags = []; const allFlags = [];' +
    'for (const e of entries) { allFlags.push(e.isRightPanel); if (e.frameId) known.push([e.frameId, e.isRightPanel]); else unknownFlags.push(e.isRightPanel); }' +
    'return { sig: entries.map(e => e.sig).join("\\n"), known, unknownFlags, allFlags };';
const PLUGIN_SLOT_SCAN_EXPRESSION = '(() => {' + PLUGIN_SLOT_SCAN_BODY + '})()';
const PLUGIN_SLOT_UNKNOWN_ELEMENTS_EXPRESSION = '(() => {' + COLLECT_PLUGIN_SLOTS_BODY + 'return entries.filter(e => !e.frameId).map(e => e.iframe); })()';
const PLUGIN_SLOT_ELEMENTS_EXPRESSION = '(() => {' + COLLECT_PLUGIN_SLOTS_BODY + 'return entries.map(e => e.iframe); })()';
const FAST_EVAL_PREFIX =
    '(async (p, scanSlots) => {' +
    'if (window !== window.top || !window.electronNative || !window.nativeStorage) return { value: false, layout: null, hostColorScheme: null, pluginSlotScan: null };' +
    'const active = window.__antigravityUiRenderer;' +
    'if (!active) return { value: (p.css && p.image === undefined && p.imageHash) ? "NEED_IMAGE" : "NEED_FULL", layout: null, hostColorScheme: null, pluginSlotScan: null };' +
    `if (active.version !== ${RENDERER_VERSION} || active.revision !== ${RENDERER_REVISION} || active.empty) return { value: "NEED_FULL", layout: null, hostColorScheme: null, pluginSlotScan: null };` +
    'const ag = Number.isFinite(active.generation) ? active.generation : 0;' +
    'const ig = Number.isFinite(p.generation) ? p.generation : 0;' +
    'if (ag !== ig ? ag > ig : String(active.owner ?? "") > String(p.owner ?? "")) return { value: "IGNORED", layout: null, hostColorScheme: null, pluginSlotScan: null };' +
    'if (p.css && p.image === undefined && p.imageHash && active.imageHash !== p.imageHash) return { value: "NEED_IMAGE", layout: null, hostColorScheme: null, pluginSlotScan: null };' +
    'active.owner = p.owner; active.generation = p.generation;' +
    'active.update(p); await active.syncTitlebar();' +
    'const ok = window.__antigravityUiRenderer === active;' +
    'return { value: ok ? "OK" : "IGNORED", layout: ok ? (active.layout ?? null) : null, hostColorScheme: ok ? (active.hostColorScheme ?? "dark") : null, pluginSlotScan: (ok && scanSlots) ? (() => {' + PLUGIN_SLOT_SCAN_BODY + '})() : null };' +
    '})(';
const FAST_PLUGIN_EVAL_PREFIX =
    '(async (p) => {' +
    'if (window === window.top) return { value: false, colorScheme: null };' +
    'if (document.documentElement?.dataset?.agUiPanelNative === "true") return { value: "NATIVE", colorScheme: null };' +
    'const active = window.__antigravityUiPluginSurface;' +
    'if (!active) return { value: "NEED_FULL", colorScheme: null };' +
    `if (active.version !== ${RENDERER_VERSION} || active.revision !== ${RENDERER_REVISION} || active.empty) return { value: "NEED_FULL", colorScheme: null };` +
    'const ag = Number.isFinite(active.generation) ? active.generation : 0;' +
    'const ig = Number.isFinite(p.generation) ? p.generation : 0;' +
    'if (ag !== ig ? ag > ig : String(active.owner ?? "") > String(p.owner ?? "")) return { value: "IGNORED", colorScheme: null };' +
    'active.owner = p.owner; active.generation = p.generation;' +
    'active.update(p);' +
    'return { value: window.__antigravityUiPluginSurface === active ? "OK" : "IGNORED", colorScheme: window.__antigravityUiPluginSurface === active ? (active.colorScheme ?? null) : null };' +
    '})(';

function missingPortError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = 'MISSING_DEVTOOLS_PORT';
    return error;
}

export class Connection {
    constructor(url) {
        this.url = url;
        this.pending = new Map();
        this.nextId = 0;
        this.lastImageHash = undefined;
        this.lastLayout = null;
        this.hostColorScheme = 'dark';
        this.installedKey = undefined;
        this.nonHost = false;
        this.hostVerified = false;
        this.pluginSlotSignature = '';
        this.rightPanelFrameIds = new Set();
        this.nonRightPanelFrameIds = new Set();
        this.iframeSchemeByFrameId = new Map();
        this.lastPluginPayloadSig = undefined;
        this.lastPluginSyncedAt = 0;
        this.lastPluginColorScheme = null;
        this.lastPluginDisabledAt = 0;
        this.lastPluginSlotScan = null;
    }

    async open() {
        this.socket = new WebSocket(this.url);
        this.socket.addEventListener('message', ({ data }) => {
            let reply;
            try {
                reply = JSON.parse(data);
            } catch {
                return;
            }
            const operation = this.pending.get(reply?.id);
            if (!operation) return;
            this.pending.delete(reply.id);
            clearTimeout(operation.timer);
            if (reply.error) {
                const detail = reply.error.message ? `${reply.error.code} (${reply.error.message})` : reply.error.code;
                operation.reject(new Error('界面命令失败：' + detail));
            } else {
                operation.resolve(reply.result);
            }
        });
        this.socket.addEventListener('close', () => {
            for (const operation of this.pending.values()) {
                clearTimeout(operation.timer);
                operation.reject(new Error('界面连接已断开。'));
            }
            this.pending.clear();
        });
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                this.socket.removeEventListener('open', onOpen);
                this.socket.removeEventListener('close', onClose);
                this.socket.removeEventListener('error', onError);
            };
            const onOpen = () => { cleanup(); resolve(); };
            const onClose = () => { cleanup(); reject(new Error('界面连接已断开。')); };
            const onError = () => { cleanup(); this.close(); reject(new Error('界面连接失败。')); };
            const timer = setTimeout(() => { cleanup(); this.close(); reject(new Error('界面连接超时。')); }, 3000);
            this.socket.addEventListener('open', onOpen, { once: true });
            this.socket.addEventListener('close', onClose, { once: true });
            this.socket.addEventListener('error', onError, { once: true });
        });
    }

    command(method, params = {}) {
        return new Promise((resolve, reject) => {
            if (this.socket?.readyState !== WebSocket.OPEN) return reject(new Error('界面连接已断开。'));
            const id = ++this.nextId;
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('界面命令超时。')); }, 3000);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    close() {
        this.socket?.close();
    }
}

export function validTarget(target, inspectorPort, hostPort) {
    try {
        const page = new URL(target.url);
        const socket = new URL(target.webSocketDebuggerUrl);
        return target.type === 'page' && loopback.has(page.hostname) &&
            ['https:', 'http:'].includes(page.protocol) && Boolean(page.port) &&
            (hostPort === undefined || page.protocol === 'https:' || page.port === hostPort) &&
            socket.protocol === 'ws:' && loopback.has(socket.hostname) &&
            Number(socket.port) === inspectorPort;
    } catch {
        return false;
    }
}

export function validIframeTarget(target, inspectorPort, hostIds) {
    try {
        if (target?.type !== 'iframe' || !target.id || !target.parentId || !hostIds.has(target.parentId)) {
            return false;
        }
        if (typeof target.url === 'string' && /^plugin:\/\/antigravity-ui--panel-/i.test(target.url)) {
            return false;
        }
        const socket = new URL(target.webSocketDebuggerUrl);
        return socket.protocol === 'ws:' && loopback.has(socket.hostname) &&
            Number(socket.port) === inspectorPort;
    } catch {
        return false;
    }
}

function computeSidebarPayload(surfaces) {
    const opts = surfaces && typeof surfaces === 'object' && !Array.isArray(surfaces) ? surfaces : {};
    const cover = opts.sidebarCover !== false;
    const rawOpacity = opts.sidebarOpacity;
    const opacity = typeof rawOpacity === 'number' && Number.isFinite(rawOpacity)
        ? Math.min(100, Math.max(0, Math.round(rawOpacity)))
        : 100;
    const rawBlur = opts.sidebarBlur;
    const blur = typeof rawBlur === 'number' && Number.isFinite(rawBlur)
        ? Math.min(30, Math.max(0, Math.round(rawBlur)))
        : 0;
    return {
        cover,
        alpha: cover ? opacity : 0,
        blur: cover && blur > 0 ? blur : 0,
    };
}

export class WallpaperRuntime {
    constructor(profile, style, enabled, hostPort) {
        this.profile = profile;
        this.style = style;
        this.enabled = enabled;
        this.hostPort = hostPort;
        this.connections = new Map();
        this.pluginConnections = new Map();
        this.hostTargetByUrl = new Map();
        this.exactHostPortUrls = new Set();
        this.iframeTargetsByParent = new Map();
        this.lastLayout = null;
        this.health = { windows: 0, error: '等待 Antigravity 界面连接。' };
        this.stopped = false;
        this.owner = randomUUID();
        this.generation = Date.now();
        this.dirty = false;
        this.pendingDiscover = false;
        this.pendingActivate = false;
        this.lastDiscoveryAt = 0;
        this.timer = undefined;
        this.timerToken = 0;
    }

    isDirty() {
        return this.dirty;
    }

    stopTimer() {
        this.timerToken++;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    start(tick = () => this.update(false, true)) {
        this.stopTimer();
        const token = ++this.timerToken;
        let retryStep = 0;
        const scheduleNext = () => {
            if (this.stopped || token !== this.timerToken) return;
            let delayMs;
            if (this.health.windows > 0) {
                retryStep = 0;
                delayMs = 1500;
            } else {
                delayMs = ATTACH_RETRY_DELAYS[Math.min(retryStep, ATTACH_RETRY_DELAYS.length - 1)];
                if (retryStep < ATTACH_RETRY_DELAYS.length - 1) retryStep++;
            }
            this.timer = setTimeout(() => {
                this.timer = undefined;
                if (this.stopped || token !== this.timerToken) return;
                runTick();
            }, delayMs);
        };
        const runTick = () => {
            Promise.resolve()
                .then(() => tick())
                .catch(() => {})
                .finally(() => { scheduleNext(); });
        };
        runTick();
    }

    update(activate = false, discover = !activate) {
        if (this.stopped) return Promise.resolve();
        if (activate) this.generation = Math.max(Date.now(), this.generation + 1);
        this.dirty = true;
        this.pendingDiscover ||= discover;
        this.pendingActivate ||= activate;
        this.operation ??= this.drain();
        return this.operation;
    }

    async drain() {
        try {
            while (this.dirty && !this.stopped) {
                this.dirty = false;
                const discover = this.pendingDiscover;
                const activate = this.pendingActivate;
                this.pendingDiscover = false;
                this.pendingActivate = false;
                await this.apply({ discover, activate });
            }
        } finally {
            this.operation = undefined;
        }
    }

    async discoverTargets() {
        let file;
        try {
            file = await readFile(join(this.profile, 'DevToolsActivePort'), 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw missingPortError('未检测到 Antigravity 本地调试端口，背景暂未附加（可能未使用快捷方式启动，或客户端更新覆盖了自启开关）。', error);
            }
            throw error;
        }
        const firstLine = file.replace(/^\uFEFF/, '').split(/\r?\n/)[0]?.trim() || '';
        const port = Number(firstLine);
        if (!firstLine || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw missingPortError('Antigravity 本地调试端口文件无效，背景暂未附加（请尝试修复快捷方式并重启客户端）。');
        }
        let response;
        try {
            response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2000) });
        } catch (error) {
            throw missingPortError('无法连接到 Antigravity 本地调试端口（可能存在残留端口文件或未使用快捷方式启动），请尝试修复快捷方式并重启客户端。', error);
        }
        if (!response.ok) {
            throw missingPortError('Antigravity 本地调试端口响应异常（可能端口已失效或被占用），请尝试修复快捷方式并重启客户端。');
        }
        let list;
        try {
            list = await response.json();
        } catch (error) {
            throw missingPortError('Antigravity 本地调试端口返回格式无效，请尝试修复快捷方式并重启客户端。', error);
        }
        if (!Array.isArray(list)) {
            throw missingPortError('Antigravity 本地调试端口返回列表无效，请尝试修复快捷方式并重启客户端。');
        }
        const targets = list.filter(target => validTarget(target, port, this.hostPort));
        const live = new Set(targets.map(target => target.webSocketDebuggerUrl));
        const hostIds = new Set();
        this.hostTargetByUrl.clear();
        this.exactHostPortUrls.clear();
        for (const target of targets) {
            if (target.id) {
                hostIds.add(target.id);
                this.hostTargetByUrl.set(target.webSocketDebuggerUrl, target.id);
            }
            if (this.hostPort) {
                try {
                    if (new URL(target.url).port === this.hostPort) {
                        this.exactHostPortUrls.add(target.webSocketDebuggerUrl);
                    }
                } catch {}
            }
        }
        const iframeTargets = list.filter(target => validIframeTarget(target, port, hostIds));
        const liveIframeUrls = new Set();
        this.iframeTargetsByParent.clear();
        for (const target of iframeTargets) {
            liveIframeUrls.add(target.webSocketDebuggerUrl);
            let group = this.iframeTargetsByParent.get(target.parentId);
            if (!group) {
                group = new Map();
                this.iframeTargetsByParent.set(target.parentId, group);
            }
            group.set(target.id, {
                id: target.id,
                url: target.url,
                wsUrl: target.webSocketDebuggerUrl,
            });
        }
        for (const [key, connection] of this.connections) {
            if (!live.has(key)) { connection.close(); this.connections.delete(key); }
        }
        for (const [key, connection] of this.pluginConnections) {
            if (!liveIframeUrls.has(key)) { connection.close(); this.pluginConnections.delete(key); }
        }
        this.lastDiscoveryAt = Date.now();
        return live;
    }

    async readDesired() {
        while (true) {
            const generation = this.generation;
            const enabled = await this.enabled();
            const style = enabled
                ? await this.style()
                : { enabled: false, css: '', image: '', imageHash: '', surfaces: {} };
            if (generation === this.generation || this.stopped) {
                return { ...style, owner: this.owner, generation };
            }
        }
    }

    resetHostPluginState(connection) {
        connection.iframeSchemeByFrameId.clear();
        connection.pluginSlotSignature = '';
        connection.rightPanelFrameIds.clear();
        connection.nonRightPanelFrameIds.clear();
        connection.lastPluginSlotScan = null;
    }

    async evaluate(connection, payload, { scanSlots = false } = {}) {
        const serializedPayload = JSON.stringify(payload);
        connection.lastPluginSlotScan = null;
        if (connection.installedKey === RENDERER_KEY && payload.enabled) {
            const fastResult = await connection.command('Runtime.evaluate', {
                expression: FAST_EVAL_PREFIX + serializedPayload + ',' + (scanSlots ? 'true' : 'false') + ')',
                returnByValue: true,
                awaitPromise: true,
            });
            if (fastResult.exceptionDetails) {
                connection.installedKey = undefined;
                this.resetHostPluginState(connection);
                const detail = fastResult.exceptionDetails.exception?.description || fastResult.exceptionDetails.text || '';
                throw new Error(detail ? '背景样式无法应用到界面：' + detail : '背景样式无法应用到界面。');
            }
            const fastOutcome = fastResult.result?.value;
            const fastValue = fastOutcome && typeof fastOutcome === 'object' && Object.hasOwn(fastOutcome, 'value')
                ? fastOutcome.value
                : fastOutcome;
            if (fastValue !== 'NEED_FULL') {
                if (fastValue === 'OK' || fastValue === true) {
                    connection.lastLayout = fastOutcome?.layout ?? null;
                    if (fastOutcome?.hostColorScheme === 'dark' || fastOutcome?.hostColorScheme === 'light') {
                        connection.hostColorScheme = fastOutcome.hostColorScheme;
                    }
                    connection.lastPluginSlotScan = fastOutcome?.pluginSlotScan ?? null;
                } else {
                    connection.installedKey = undefined;
                    connection.lastLayout = null;
                    if (fastValue === false) this.resetHostPluginState(connection);
                }
                return fastValue;
            }
            connection.installedKey = undefined;
        }
        const scanExpr = scanSlots ? '(ok ? (() => {' + PLUGIN_SLOT_SCAN_BODY + '})() : null)' : 'null';
        const result = await connection.command('Runtime.evaluate', {
            expression: '(async () => { const value = await (' + getInstallWallpaperSource() + ')(' + serializedPayload + '); const ok = value === true || value === "OK"; return { value, layout: ok ? (window.__antigravityUiRenderer?.layout ?? null) : null, hostColorScheme: ok ? (window.__antigravityUiRenderer?.hostColorScheme ?? "dark") : null, pluginSlotScan: ' + scanExpr + ' }; })()',
            returnByValue: true,
            awaitPromise: true,
        });
        if (result.exceptionDetails) {
            connection.installedKey = undefined;
            this.resetHostPluginState(connection);
            const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '';
            throw new Error(detail ? '背景样式无法应用到界面：' + detail : '背景样式无法应用到界面。');
        }
        const outcome = result.result?.value;
        this.resetHostPluginState(connection);
        if (outcome && typeof outcome === 'object' && Object.hasOwn(outcome, 'value')) {
            connection.lastLayout = outcome.layout ?? null;
            if (outcome.hostColorScheme === 'dark' || outcome.hostColorScheme === 'light') {
                connection.hostColorScheme = outcome.hostColorScheme;
            }
            connection.lastPluginSlotScan = outcome.pluginSlotScan ?? null;
            connection.installedKey = (payload.enabled && (outcome.value === true || outcome.value === 'OK')) ? RENDERER_KEY : undefined;
            return outcome.value;
        }
        connection.installedKey = undefined;
        connection.lastLayout = null;
        return outcome;
    }

    async send(connection, payload, { scanSlots = false } = {}) {
        const skipInitialProbe = !connection.hostVerified && !connection.nonHost &&
            Boolean(this.hostPort) && this.exactHostPortUrls.has(connection.url);
        if (!skipInitialProbe && (!connection.hostVerified || connection.nonHost)) {
            const probe = await connection.command('Runtime.evaluate', {
                expression: HOST_PROBE_EXPRESSION,
                returnByValue: true,
            });
            if (this.stopped) return {};
            if (probe.exceptionDetails || probe.result?.value !== true) {
                connection.nonHost = true;
                connection.hostVerified = false;
                connection.installedKey = undefined;
                connection.lastImageHash = undefined;
                return { nonHost: true };
            }
            connection.nonHost = false;
            connection.hostVerified = true;
        }
        const needImage = Boolean(payload.enabled && payload.css);
        const omitImage = !needImage || (payload.imageHash && connection.lastImageHash === payload.imageHash);
        let value = await this.evaluate(connection, omitImage ? { ...payload, image: undefined } : payload, { scanSlots });
        if (this.stopped) return {};
        if (value === 'NEED_IMAGE') value = await this.evaluate(connection, payload, { scanSlots });
        if (this.stopped) return {};
        if (value === 'IGNORED') {
            connection.nonHost = false;
            connection.lastImageHash = undefined;
            return { ignored: true };
        }
        if (value !== true && value !== 'OK') {
            if (value === false) {
                connection.nonHost = true;
                connection.hostVerified = false;
                connection.lastImageHash = undefined;
                return { nonHost: true };
            }
            return {};
        }
        connection.nonHost = false;
        connection.hostVerified = true;
        connection.lastImageHash = needImage ? payload.imageHash : '';
        if (!payload.enabled) return { applied: true, layout: null };
        return { applied: true, layout: connection.lastLayout ?? null };
    }

    async describePluginSlotElements(hostConn, expression, flags, nextRightIds, nextNonRightIds) {
        const elemsRes = await hostConn.command('Runtime.evaluate', {
            expression,
            returnByValue: false,
        });
        const arrayObjId = elemsRes.result?.objectId;
        if (!arrayObjId) return flags.length === 0;
        try {
            const props = await hostConn.command('Runtime.getProperties', {
                objectId: arrayObjId,
                ownProperties: true,
            });
            const itemProps = (props.result || []).filter(p => /^\d+$/.test(p.name) && p.value?.objectId);
            if (itemProps.length !== flags.length) {
                await Promise.all(itemProps.map(prop =>
                    hostConn.command('Runtime.releaseObject', { objectId: prop.value.objectId }).catch(() => {})
                ));
                return false;
            }
            await Promise.all(itemProps.map(async prop => {
                const index = Number(prop.name);
                const itemObjId = prop.value.objectId;
                try {
                    const desc = await hostConn.command('DOM.describeNode', { objectId: itemObjId });
                    const frameId = desc?.node?.frameId;
                    if (frameId) {
                        if (flags[index] !== false) nextRightIds.add(frameId);
                        else nextNonRightIds.add(frameId);
                        await hostConn.command('Runtime.callFunctionOn', {
                            objectId: itemObjId,
                            functionDeclaration: 'function(id) { if (this.getAttribute("data-ag-ui-frame-id") !== id) this.setAttribute("data-ag-ui-frame-id", id); }',
                            arguments: [{ value: frameId }],
                        }).catch(() => {});
                    }
                } catch {
                } finally {
                    hostConn.command('Runtime.releaseObject', { objectId: itemObjId }).catch(() => {});
                }
            }));
            return true;
        } finally {
            hostConn.command('Runtime.releaseObject', { objectId: arrayObjId }).catch(() => {});
        }
    }

    async resolveHostRightPanelFrames(hostConn, childTargets) {
        let scan = hostConn.lastPluginSlotScan;
        hostConn.lastPluginSlotScan = null;
        if (!scan) {
            const scanRes = await hostConn.command('Runtime.evaluate', {
                expression: PLUGIN_SLOT_SCAN_EXPRESSION,
                returnByValue: true,
            });
            if (scanRes.exceptionDetails) return hostConn.rightPanelFrameIds;
            scan = scanRes.result?.value;
        }
        const nextSig = typeof scan?.sig === 'string' ? scan.sig : '';
        const knownEntries = Array.isArray(scan?.known) ? scan.known : [];
        const unknownFlags = Array.isArray(scan?.unknownFlags) ? scan.unknownFlags : [];
        const allFlags = Array.isArray(scan?.allFlags) ? scan.allFlags : [];
        let allKnown = true;
        for (const targetId of childTargets.keys()) {
            if (!hostConn.rightPanelFrameIds.has(targetId) && !hostConn.nonRightPanelFrameIds.has(targetId)) {
                allKnown = false;
                break;
            }
        }
        if (nextSig === hostConn.pluginSlotSignature && allKnown && unknownFlags.length === 0) {
            return hostConn.rightPanelFrameIds;
        }

        const nextRightIds = new Set();
        const nextNonRightIds = new Set();
        let scanConsistent = true;
        if (nextSig) {
            let hasStaleKnownId = false;
            for (const [frameId, isRightPanel] of knownEntries) {
                if (typeof frameId !== 'string' || !frameId) continue;
                if (!childTargets.has(frameId)) hasStaleKnownId = true;
                if (isRightPanel !== false) nextRightIds.add(frameId);
                else nextNonRightIds.add(frameId);
            }
            if (!allKnown && hasStaleKnownId) {
                nextRightIds.clear();
                nextNonRightIds.clear();
                scanConsistent = await this.describePluginSlotElements(
                    hostConn,
                    PLUGIN_SLOT_ELEMENTS_EXPRESSION,
                    allFlags,
                    nextRightIds,
                    nextNonRightIds,
                );
            } else if (unknownFlags.length > 0) {
                scanConsistent = await this.describePluginSlotElements(
                    hostConn,
                    PLUGIN_SLOT_UNKNOWN_ELEMENTS_EXPRESSION,
                    unknownFlags,
                    nextRightIds,
                    nextNonRightIds,
                );
            }
        }
        if (!scanConsistent) {
            hostConn.pluginSlotSignature = '';
            return hostConn.rightPanelFrameIds;
        }
        for (const targetId of childTargets.keys()) {
            if (!nextRightIds.has(targetId)) nextNonRightIds.add(targetId);
        }
        hostConn.pluginSlotSignature = nextSig;
        hostConn.rightPanelFrameIds = nextRightIds;
        hostConn.nonRightPanelFrameIds = nextNonRightIds;
        return nextRightIds;
    }

    async evaluatePluginPanel(connection, payload) {
        const serializedPayload = JSON.stringify(payload);
        const wantActive = Boolean(payload.enabled && payload.sidebar?.alpha < 100);
        if (connection.installedKey === RENDERER_KEY && wantActive) {
            const fastResult = await connection.command('Runtime.evaluate', {
                expression: FAST_PLUGIN_EVAL_PREFIX + serializedPayload + ')',
                returnByValue: true,
                awaitPromise: true,
            });
            if (!fastResult.exceptionDetails) {
                const fastOutcome = fastResult.result?.value;
                const fastValue = fastOutcome && typeof fastOutcome === 'object' ? fastOutcome.value : fastOutcome;
                if (fastValue !== 'NEED_FULL') {
                    if (fastValue !== 'OK' && fastValue !== 'NATIVE') connection.installedKey = undefined;
                    return fastOutcome && typeof fastOutcome === 'object'
                        ? fastOutcome
                        : { value: fastValue, colorScheme: null };
                }
            }
            connection.installedKey = undefined;
        }
        const result = await connection.command('Runtime.evaluate', {
            expression: '(' + getInstallPluginPanelSource() + ')(' + serializedPayload + ')',
            returnByValue: true,
            awaitPromise: true,
        });
        if (result.exceptionDetails) {
            connection.installedKey = undefined;
            throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '插件面板注入失败');
        }
        const outcome = result.result?.value;
        const value = outcome && typeof outcome === 'object' ? outcome.value : outcome;
        connection.installedKey = (wantActive && (value === 'OK' || value === 'NATIVE')) ? RENDERER_KEY : undefined;
        return outcome && typeof outcome === 'object' ? outcome : { value, colorScheme: null };
    }

    async syncHostIframeSchemes(hostConn, entries) {
        const updates = [];
        for (const [frameId, scheme] of entries) {
            const normalized = (scheme === 'dark' || scheme === 'light') ? scheme : '';
            if ((hostConn.iframeSchemeByFrameId.get(frameId) || '') === normalized) continue;
            updates.push([frameId, normalized]);
        }
        if (updates.length === 0) return;
        const res = await hostConn.command('Runtime.evaluate', {
            expression: `((list) => {
                const applied = [];
                for (const [id, next] of list) {
                    const el = document.querySelector('iframe[data-ag-ui-frame-id=' + JSON.stringify(id) + ']');
                    if (!el) continue;
                    if (next) el.setAttribute('data-ag-ui-iframe-scheme', next);
                    else el.removeAttribute('data-ag-ui-iframe-scheme');
                    applied.push([id, next]);
                }
                return applied;
            })(${JSON.stringify(updates)})`,
            returnByValue: true,
        }).catch(() => null);
        const applied = (!res?.exceptionDetails && Array.isArray(res?.result?.value)) ? res.result.value : [];
        for (const [frameId, next] of applied) {
            if (next) hostConn.iframeSchemeByFrameId.set(frameId, next);
            else hostConn.iframeSchemeByFrameId.delete(frameId);
        }
    }

    async syncPluginPanels(desired, hostKeys, force = false) {
        const sidebar = computeSidebarPayload(desired.surfaces);
        const wantActive = Boolean(desired.enabled && sidebar.alpha < 100);
        await Promise.allSettled([...hostKeys].map(async hostKey => {
            const hostConn = this.connections.get(hostKey);
            if (!hostConn || hostConn.nonHost || !hostConn.hostVerified) return;
            const parentId = this.hostTargetByUrl.get(hostKey);
            if (!parentId) return;
            const childTargets = this.iframeTargetsByParent.get(parentId);
            if (!childTargets || childTargets.size === 0) {
                hostConn.iframeSchemeByFrameId.clear();
                return;
            }
            for (const cachedFrameId of hostConn.iframeSchemeByFrameId.keys()) {
                if (!childTargets.has(cachedFrameId)) hostConn.iframeSchemeByFrameId.delete(cachedFrameId);
            }

            const hostColorScheme = hostConn.hostColorScheme === 'light' ? 'light' : 'dark';
            const pluginPayload = {
                enabled: Boolean(desired.enabled),
                owner: desired.owner,
                generation: desired.generation,
                sidebar,
                hostColorScheme,
            };
            const payloadSig = `${pluginPayload.enabled ? 1 : 0}:${sidebar.cover ? 1 : 0}:${sidebar.alpha}:${sidebar.blur}:${hostColorScheme}`;
            const schemeEntries = [];

            if (!wantActive) {
                const now = Date.now();
                const disablePayload = {
                    enabled: false,
                    owner: desired.owner,
                    generation: desired.generation,
                    sidebar,
                    hostColorScheme,
                };
                await Promise.allSettled([...childTargets.values()].map(async target => {
                    const existing = this.pluginConnections.get(target.wsUrl);
                    if (existing) {
                        const shouldThrottle = !desired.enabled && !force && existing.lastPluginDisabledAt &&
                            (now - existing.lastPluginDisabledAt < PLUGIN_HEARTBEAT_SKIP_MS);
                        if (!shouldThrottle) {
                            try {
                                await this.evaluatePluginPanel(existing, disablePayload);
                                existing.lastPluginPayloadSig = undefined;
                                existing.lastPluginSyncedAt = 0;
                                existing.lastPluginColorScheme = null;
                                existing.lastPluginDisabledAt = Date.now();
                            } catch {
                                existing.close();
                                this.pluginConnections.delete(target.wsUrl);
                            }
                        }
                        if (desired.enabled && this.pluginConnections.get(target.wsUrl) === existing) {
                            existing.close();
                            this.pluginConnections.delete(target.wsUrl);
                        }
                    }
                    schemeEntries.push([target.id, '']);
                }));
                if (!this.stopped) await this.syncHostIframeSchemes(hostConn, schemeEntries);
                return;
            }

            let rightPanelFrameIds;
            try {
                rightPanelFrameIds = await this.resolveHostRightPanelFrames(hostConn, childTargets);
            } catch {
                return;
            }
            if (this.stopped) return;

            const now = Date.now();
            await Promise.allSettled([...childTargets.values()].map(async target => {
                if (!rightPanelFrameIds.has(target.id)) {
                    const existing = this.pluginConnections.get(target.wsUrl);
                    if (existing) {
                        try {
                            await this.evaluatePluginPanel(existing, {
                                enabled: false,
                                owner: desired.owner,
                                generation: desired.generation,
                                sidebar,
                                hostColorScheme,
                            });
                        } catch {}
                        existing.close();
                        this.pluginConnections.delete(target.wsUrl);
                    }
                    schemeEntries.push([target.id, '']);
                    return;
                }

                let pluginConn = this.pluginConnections.get(target.wsUrl);
                if (!force &&
                    pluginConn &&
                    pluginConn.installedKey === RENDERER_KEY &&
                    pluginConn.lastPluginPayloadSig === payloadSig &&
                    now - pluginConn.lastPluginSyncedAt < PLUGIN_HEARTBEAT_SKIP_MS) {
                    const cachedScheme = (pluginConn.lastPluginColorScheme && pluginConn.lastPluginColorScheme !== hostColorScheme)
                        ? pluginConn.lastPluginColorScheme
                        : '';
                    schemeEntries.push([target.id, cachedScheme]);
                    return;
                }
                try {
                    if (!pluginConn) {
                        pluginConn = new Connection(target.wsUrl);
                        await pluginConn.open();
                        if (this.stopped) {
                            pluginConn.close();
                            return;
                        }
                        this.pluginConnections.set(target.wsUrl, pluginConn);
                    }
                    const outcome = await this.evaluatePluginPanel(pluginConn, pluginPayload);
                    if (this.stopped) return;
                    if (outcome?.value === 'OK' || outcome?.value === 'NATIVE') {
                        pluginConn.lastPluginPayloadSig = payloadSig;
                        pluginConn.lastPluginSyncedAt = Date.now();
                        pluginConn.lastPluginColorScheme = outcome?.value === 'OK' ? (outcome.colorScheme ?? null) : null;
                        pluginConn.lastPluginDisabledAt = 0;
                    } else {
                        pluginConn.lastPluginPayloadSig = undefined;
                        pluginConn.lastPluginSyncedAt = 0;
                        pluginConn.lastPluginColorScheme = null;
                    }
                    const desiredScheme = (outcome?.value === 'OK' && outcome.colorScheme && outcome.colorScheme !== hostColorScheme)
                        ? outcome.colorScheme
                        : '';
                    schemeEntries.push([target.id, desiredScheme]);
                } catch {
                    pluginConn?.close();
                    this.pluginConnections.delete(target.wsUrl);
                }
            }));
            if (!this.stopped) await this.syncHostIframeSchemes(hostConn, schemeEntries);
        }));
    }

    async apply({ discover = false, activate = false } = {}) {
        try {
            const didDiscover = discover || this.connections.size === 0 || (Date.now() - this.lastDiscoveryAt >= 250);
            let initialKeys;
            let desired;
            if (didDiscover) {
                const [live, initialDesired] = await Promise.all([
                    this.discoverTargets(),
                    this.readDesired(),
                ]);
                if (this.stopped) return;
                initialKeys = [...live];
                desired = initialDesired.generation === this.generation ? initialDesired : await this.readDesired();
            } else {
                initialKeys = [...this.connections.keys()];
                desired = await this.readDesired();
            }
            if (this.stopped) return;
            const succeeded = new Set();
            const appliedHosts = new Set();
            const errors = new Map();
            let applied = 0;
            let ignored = 0;
            let hadFailure = false;
            let nextLayout;
            const applyKeys = async (keys, probeNonHost) => {
                const wantPluginActive = Boolean(desired.enabled && computeSidebarPayload(desired.surfaces).alpha < 100);
                const pending = [];
                for (const key of [...keys].sort()) {
                    if (succeeded.has(key)) continue;
                    pending.push(key);
                }
                const layouts = new Array(pending.length).fill(null);
                await Promise.all(pending.map(async (key, index) => {
                    let connection = this.connections.get(key);
                    if (connection?.nonHost && !probeNonHost) {
                        succeeded.add(key);
                        return;
                    }
                    try {
                        if (!connection) {
                            connection = new Connection(key);
                            await connection.open();
                            if (this.stopped) {
                                connection.close();
                                return;
                            }
                            this.connections.set(key, connection);
                        }
                        const parentId = this.hostTargetByUrl.get(key);
                        const scanSlots = Boolean(wantPluginActive && parentId && (this.iframeTargetsByParent.get(parentId)?.size > 0));
                        const outcome = await this.send(connection, desired, { scanSlots });
                        if (outcome.applied) {
                            applied++;
                            appliedHosts.add(key);
                            layouts[index] = outcome.layout;
                            succeeded.add(key);
                            errors.delete(key);
                        } else if (outcome.ignored) {
                            ignored++;
                            succeeded.add(key);
                            errors.delete(key);
                        } else if (outcome.nonHost) {
                            succeeded.add(key);
                            errors.delete(key);
                        }
                    } catch (error) {
                        connection?.close();
                        this.connections.delete(key);
                        hadFailure = true;
                        errors.set(key, error);
                    }
                }));
                nextLayout ??= layouts.find(Boolean);
            };
            await applyKeys(initialKeys, didDiscover);
            if (this.stopped) return;
            if (!didDiscover && (hadFailure || this.connections.size === 0)) {
                const live = await this.discoverTargets();
                if (this.stopped) return;
                if (desired.generation !== this.generation) desired = await this.readDesired();
                if (this.stopped) return;
                await applyKeys([...live], true);
                if (this.stopped) return;
            }
            if (appliedHosts.size > 0) {
                await this.syncPluginPanels(desired, appliedHosts, activate);
                if (this.stopped) return;
            }
            if (!desired.enabled) this.lastLayout = null;
            else if (nextLayout) this.lastLayout = nextLayout;
            const lastError = [...errors.values()].at(-1);
            const ok = Boolean(applied || (ignored && !lastError));
            this.health = {
                windows: applied,
                error: ok ? '' : (lastError?.message || '等待 Antigravity 主窗口。'),
                ...(!ok && lastError?.code ? { errorCode: lastError.code } : {}),
                ...(this.lastLayout ? { layout: this.lastLayout } : {}),
            };
        } catch (error) {
            if (this.stopped) return;
            this.health = {
                windows: 0,
                error: error.message,
                ...(error.code ? { errorCode: error.code } : {}),
                ...(this.lastLayout ? { layout: this.lastLayout } : {}),
            };
        }
    }

    async stop() {
        this.stopped = true;
        this.stopTimer();
        if (this.operation) {
            await Promise.race([
                this.operation.catch(() => {}),
                new Promise(resolve => setTimeout(resolve, 1200)),
            ]);
        }
        const expression = '(' + getInstallWallpaperSource() + ')(' +
            JSON.stringify({ enabled: false, owner: this.owner, generation: this.generation }) + ')';
        const pluginExpression = '(' + getInstallPluginPanelSource() + ')(' +
            JSON.stringify({ enabled: false, owner: this.owner, generation: this.generation }) + ')';
        await Promise.allSettled([
            ...[...this.connections.values()].map(async connection => {
                try {
                    if (!connection.nonHost) {
                        await Promise.race([
                            connection.command('Runtime.evaluate', { expression, awaitPromise: true }),
                            new Promise(resolve => setTimeout(resolve, 1500)),
                        ]);
                    }
                } finally { connection.close(); }
            }),
            ...[...this.pluginConnections.values()].map(async connection => {
                try {
                    await Promise.race([
                        connection.command('Runtime.evaluate', { expression: pluginExpression, awaitPromise: true }),
                        new Promise(resolve => setTimeout(resolve, 1500)),
                    ]);
                } finally { connection.close(); }
            }),
        ]);
        this.connections.clear();
        this.pluginConnections.clear();
    }
}
