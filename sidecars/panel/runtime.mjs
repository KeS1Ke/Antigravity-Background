import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installWallpaper, RENDERER_VERSION, RENDERER_REVISION } from './renderer.mjs';
import { randomUUID } from 'node:crypto';

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
const INSTALL_WALLPAPER_SOURCE = installWallpaper.toString();
const RENDERER_KEY = `${RENDERER_VERSION}:${RENDERER_REVISION}`;
const ATTACH_RETRY_DELAYS = [150, 250, 400, 600, 1000, 1500];
const FAST_EVAL_PREFIX =
    '(async (p) => {' +
    'if (window !== window.top || !window.electronNative || !window.nativeStorage) return { value: false, layout: null };' +
    'const active = window.__antigravityUiRenderer;' +
    'if (!active) return { value: (p.css && p.image === undefined && p.imageHash) ? "NEED_IMAGE" : "NEED_FULL", layout: null };' +
    `if (active.version !== ${RENDERER_VERSION} || active.revision !== ${RENDERER_REVISION} || active.empty) return { value: "NEED_FULL", layout: null };` +
    'const ag = Number.isFinite(active.generation) ? active.generation : 0;' +
    'const ig = Number.isFinite(p.generation) ? p.generation : 0;' +
    'if (ag !== ig ? ag > ig : String(active.owner ?? "") > String(p.owner ?? "")) return { value: "IGNORED", layout: null };' +
    'if (p.css && p.image === undefined && p.imageHash && active.imageHash !== p.imageHash) return { value: "NEED_IMAGE", layout: null };' +
    'active.owner = p.owner; active.generation = p.generation;' +
    'active.update(p); await active.syncTitlebar();' +
    'return { value: window.__antigravityUiRenderer === active ? "OK" : "IGNORED", layout: window.__antigravityUiRenderer === active ? (active.layout ?? null) : null };' +
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
        this.installedKey = undefined;
        this.nonHost = false;
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

export class WallpaperRuntime {
    constructor(profile, style, enabled, hostPort) {
        this.profile = profile;
        this.style = style;
        this.enabled = enabled;
        this.hostPort = hostPort;
        this.connections = new Map();
        this.lastLayout = null;
        this.health = { windows: 0, error: '等待 Antigravity 界面连接。' };
        this.stopped = false;
        this.owner = randomUUID();
        this.generation = Date.now();
        this.dirty = false;
        this.pendingDiscover = false;
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

    start(tick = () => void this.update(false, true)) {
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
                tick();
                scheduleNext();
            }, delayMs);
        };
        tick();
        scheduleNext();
    }

    update(activate = false, discover = !activate) {
        if (this.stopped) return Promise.resolve();
        if (activate) this.generation = Math.max(Date.now(), this.generation + 1);
        this.dirty = true;
        this.pendingDiscover ||= discover;
        this.operation ??= this.drain();
        return this.operation;
    }

    async drain() {
        try {
            while (this.dirty && !this.stopped) {
                this.dirty = false;
                const discover = this.pendingDiscover;
                this.pendingDiscover = false;
                await this.apply({ discover });
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
        for (const [key, connection] of this.connections) {
            if (!live.has(key)) { connection.close(); this.connections.delete(key); }
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

    async evaluate(connection, payload) {
        const serializedPayload = JSON.stringify(payload);
        if (connection.installedKey === RENDERER_KEY && payload.enabled) {
            const fastResult = await connection.command('Runtime.evaluate', {
                expression: FAST_EVAL_PREFIX + serializedPayload + ')',
                returnByValue: true,
                awaitPromise: true,
            });
            if (fastResult.exceptionDetails) {
                connection.installedKey = undefined;
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
                } else {
                    connection.installedKey = undefined;
                    connection.lastLayout = null;
                }
                return fastValue;
            }
            connection.installedKey = undefined;
        }
        const result = await connection.command('Runtime.evaluate', {
            expression: '(async () => { const value = await (' + INSTALL_WALLPAPER_SOURCE + ')(' + serializedPayload + '); return { value, layout: (value === true || value === "OK") ? (window.__antigravityUiRenderer?.layout ?? null) : null }; })()',
            returnByValue: true,
            awaitPromise: true,
        });
        if (result.exceptionDetails) {
            connection.installedKey = undefined;
            const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '';
            throw new Error(detail ? '背景样式无法应用到界面：' + detail : '背景样式无法应用到界面。');
        }
        const outcome = result.result?.value;
        if (outcome && typeof outcome === 'object' && Object.hasOwn(outcome, 'value')) {
            connection.lastLayout = outcome.layout ?? null;
            connection.installedKey = (payload.enabled && (outcome.value === true || outcome.value === 'OK')) ? RENDERER_KEY : undefined;
            return outcome.value;
        }
        connection.installedKey = undefined;
        connection.lastLayout = null;
        return outcome;
    }

    async send(connection, payload) {
        const needImage = Boolean(payload.enabled && payload.css);
        const omitImage = !needImage || connection.nonHost || (payload.imageHash && connection.lastImageHash === payload.imageHash);
        let value = await this.evaluate(connection, omitImage ? { ...payload, image: undefined } : payload);
        if (this.stopped) return {};
        if (value === 'NEED_IMAGE') value = await this.evaluate(connection, payload);
        if (this.stopped) return {};
        if (value === 'IGNORED') {
            connection.nonHost = false;
            connection.lastImageHash = undefined;
            return { ignored: true };
        }
        if (value !== true && value !== 'OK') {
            if (value === false) {
                connection.nonHost = true;
                connection.lastImageHash = undefined;
                return { nonHost: true };
            }
            return {};
        }
        connection.nonHost = false;
        connection.lastImageHash = needImage ? payload.imageHash : '';
        if (!payload.enabled) return { applied: true, layout: null };
        return { applied: true, layout: connection.lastLayout ?? null };
    }

    async apply({ discover = false } = {}) {
        try {
            const didDiscover = discover || this.connections.size === 0 || (Date.now() - this.lastDiscoveryAt >= 250);
            const initialKeys = didDiscover ? [...await this.discoverTargets()] : [...this.connections.keys()];
            if (this.stopped) return;
            let desired = await this.readDesired();
            if (this.stopped) return;
            const succeeded = new Set();
            const errors = new Map();
            let applied = 0;
            let ignored = 0;
            let hadFailure = false;
            let nextLayout;
            const applyKeys = async (keys, probeNonHost) => {
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
                        const outcome = await this.send(connection, desired);
                        if (outcome.applied) {
                            applied++;
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
        await this.operation;
        const expression = '(' + INSTALL_WALLPAPER_SOURCE + ')(' +
            JSON.stringify({ enabled: false, owner: this.owner, generation: this.generation }) + ')';
        await Promise.allSettled([...this.connections.values()].map(async connection => {
            try {
                if (!connection.nonHost) {
                    await connection.command('Runtime.evaluate', { expression, awaitPromise: true });
                }
            } finally { connection.close(); }
        }));
        this.connections.clear();
    }
}
