import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installWallpaper } from './renderer.mjs';
import { randomUUID } from 'node:crypto';

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class Connection {
    constructor(url) {
        this.url = url;
        this.pending = new Map();
        this.nextId = 0;
        this.lastImageHash = undefined;
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
            if (reply.error) operation.reject(new Error('界面命令失败：' + reply.error.code));
            else operation.resolve(reply.result);
        });
        this.socket.addEventListener('close', () => {
            for (const operation of this.pending.values()) {
                clearTimeout(operation.timer);
                operation.reject(new Error('界面连接已断开。'));
            }
            this.pending.clear();
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.close(); reject(new Error('界面连接超时。')); }, 3000);
            this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
            this.socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('界面连接已断开。')); }, { once: true });
            this.socket.addEventListener('error', () => { clearTimeout(timer); this.close(); reject(new Error('界面连接失败。')); }, { once: true });
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

export function validTarget(target, inspectorPort) {
    try {
        const page = new URL(target.url);
        const socket = new URL(target.webSocketDebuggerUrl);
        return target.type === 'page' && loopback.has(page.hostname) &&
            ['https:', 'http:'].includes(page.protocol) && page.port &&
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
    }

    start(tick = () => void this.update(false, true)) {
        tick();
        this.timer = setInterval(tick, 1500);
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
        if (this.dirty && !this.stopped) return this.update(false, false);
    }

    async discoverTargets() {
        const file = await readFile(join(this.profile, 'DevToolsActivePort'), 'utf8');
        const port = Number(file.split(/\r?\n/)[0]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('界面检查端口无效。');
        const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error('无法发现 Antigravity 窗口。');
        const targets = (await response.json()).filter(target => validTarget(target, port) &&
            (new URL(target.url).protocol === 'https:' || new URL(target.url).port === this.hostPort));
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
        const result = await connection.command('Runtime.evaluate', {
            expression: '(' + installWallpaper.toString() + ')(' + JSON.stringify(payload) + ')',
            returnByValue: true,
            awaitPromise: true,
        });
        if (result.exceptionDetails) throw new Error('背景样式无法应用到界面。');
        return result.result?.value;
    }

    async send(connection, payload) {
        const needImage = Boolean(payload.enabled && payload.css);
        const omitImage = !needImage || (payload.imageHash && connection.lastImageHash === payload.imageHash);
        let value = await this.evaluate(connection, omitImage ? { ...payload, image: undefined } : payload);
        if (this.stopped) return {};
        if (value === 'NEED_IMAGE') value = await this.evaluate(connection, payload);
        if (this.stopped) return {};
        if (value === 'IGNORED') {
            connection.lastImageHash = undefined;
            return { ignored: true };
        }
        if (value !== true && value !== 'OK') return {};
        connection.lastImageHash = needImage ? payload.imageHash : '';
        if (!payload.enabled) return { applied: true, layout: null };
        const measured = await connection.command('Runtime.evaluate', {
            expression: 'window.__antigravityUiRenderer?.layout',
            returnByValue: true,
        });
        return { applied: true, layout: measured.result?.value ?? null };
    }

    async apply({ discover = false } = {}) {
        try {
            const didDiscover = discover || this.connections.size === 0 || (Date.now() - this.lastDiscoveryAt >= 250);
            const initialKeys = didDiscover ? [...await this.discoverTargets()] : [...this.connections.keys()];
            if (this.stopped) return;
            let desired = await this.readDesired();
            if (this.stopped) return;
            const attempted = new Set();
            let applied = 0;
            let ignored = 0;
            let hadFailure = false;
            let lastError;
            let nextLayout;
            const applyKeys = async keys => {
                const pending = [];
                for (const key of [...keys].sort()) {
                    if (attempted.has(key)) continue;
                    attempted.add(key);
                    pending.push(key);
                }
                const layouts = new Array(pending.length).fill(null);
                await Promise.all(pending.map(async (key, index) => {
                    let connection = this.connections.get(key);
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
                        }
                        if (outcome.ignored) ignored++;
                    } catch (error) {
                        connection?.close();
                        this.connections.delete(key);
                        hadFailure = true;
                        lastError = error;
                    }
                }));
                nextLayout ??= layouts.find(Boolean);
            };
            await applyKeys(initialKeys);
            if (this.stopped) return;
            if (!didDiscover && (hadFailure || this.connections.size === 0)) {
                const live = await this.discoverTargets();
                if (this.stopped) return;
                if (desired.generation !== this.generation) desired = await this.readDesired();
                if (this.stopped) return;
                await applyKeys([...live]);
                if (this.stopped) return;
            }
            if (!desired.enabled) this.lastLayout = null;
            else if (nextLayout) this.lastLayout = nextLayout;
            this.health = {
                windows: applied,
                error: applied || (ignored && !lastError) ? '' : (lastError?.message || '等待 Antigravity 主窗口。'),
                ...(this.lastLayout ? { layout: this.lastLayout } : {}),
            };
        } catch (error) {
            if (this.stopped) return;
            this.health = {
                windows: 0,
                error: error.message,
                ...(this.lastLayout ? { layout: this.lastLayout } : {}),
            };
        }
    }

    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        await this.operation;
        const expression = '(' + installWallpaper.toString() + ')(' +
            JSON.stringify({ enabled: false, owner: this.owner, generation: this.generation }) + ')';
        await Promise.allSettled([...this.connections.values()].map(async connection => {
            try {
                await connection.command('Runtime.evaluate', { expression, awaitPromise: true });
            } finally { connection.close(); }
        }));
        this.connections.clear();
    }
}
