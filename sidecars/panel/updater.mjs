import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { PLUGIN_NAME, REQUIRED_RUNTIME_FILES, RUNTIME_ROOTS, stageRuntimeArchive } from './archive.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_REPO = 'KeS1Ke/Antigravity-Background';
const TRUSTED_GITHUB_HOSTS = new Set([
    'api.github.com',
    'github.com',
    'raw.githubusercontent.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com',
]);
const ALLOWED_NETWORK_DETAILS = new Set(['timeout', 'dns', 'certificate', 'proxy', 'http', 'connection']);
const ALLOWED_ERROR_CODES = new Set(['network', 'verification', 'location', 'busy', 'install', 'rollback']);
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const SOCKET_TIMEOUT_MS = 10000;
const CHECK_BUDGET_MS = 30000;
const APPLY_BUDGET_MS = 120000;
const CHECK_COOLDOWN_MS = 5000;
const PLAN_TTL_MS = 15 * 60 * 1000;
const SEMVER_RE = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const SAFE_NOTES_STRIP_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\u202a-\u202e\u2066-\u2069]/g;

class UpdateError extends Error {
    constructor(code, detail, statusCode) {
        super(ALLOWED_ERROR_CODES.has(code) ? code : 'install');
        this.code = ALLOWED_ERROR_CODES.has(code) ? code : 'install';
        this.detail = detail || undefined;
        this.statusCode = Number.isInteger(statusCode) ? statusCode : undefined;
    }
}

export function parseSemver(value) {
    if (typeof value !== 'string' || !SEMVER_RE.test(value)) return null;
    return value.split('.').map(Number);
}

export function compareSemver(a, b) {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right) throw new UpdateError('verification');
    for (let i = 0; i < 3; i++) {
        if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
    }
    return 0;
}

function sanitizeText(text, maxLength = 1800) {
    if (typeof text !== 'string') return '';
    return text.replace(SAFE_NOTES_STRIP_RE, '').trim().slice(0, maxLength);
}

function decodeHtmlEntities(text) {
    return String(text)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/gi, "'")
        .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function digestSha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function isLoopbackHost(hostname) {
    const lower = String(hostname || '').toLowerCase();
    return lower === '127.0.0.1' || lower === 'localhost' || lower === '::1' || lower === '[::1]';
}

function hostMatchesRule(hostname, rule) {
    const host = String(hostname || '').toLowerCase();
    const pattern = String(rule || '').trim().toLowerCase();
    if (!host || !pattern) return false;
    if (pattern === '*') return true;
    if (pattern === '<local>') return !host.includes('.');
    if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return regex.test(host);
    }
    const clean = pattern.replace(/:\d+$/, '').replace(/^\./, '');
    return host === clean || host.endsWith('.' + clean);
}

function parseProxyServerValue(rawValue, scheme) {
    const raw = String(rawValue || '').trim();
    if (!raw) return null;
    if (!raw.includes('=')) {
        return raw.includes('://') ? raw : `http://${raw}`;
    }
    const map = {};
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) map[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
    }
    const selected = map[scheme] || map.https || map.http;
    if (!selected) return null;
    return selected.includes('://') ? selected : `http://${selected}`;
}

async function readWindowsProxy() {
    if (process.platform !== 'win32') return null;
    try {
        const { stdout } = await execFileAsync(
            'reg.exe',
            ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
            { encoding: 'utf8', windowsHide: true, timeout: 2000 }
        );
        const enableMatch = stdout.match(/^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/mi);
        if (!enableMatch || Number(enableMatch[1]) === 0) return null;
        const serverMatch = stdout.match(/^\s*ProxyServer\s+REG_SZ\s+(.+)$/mi);
        if (!serverMatch) return null;
        const overrideMatch = stdout.match(/^\s*ProxyOverride\s+REG_SZ\s+(.+)$/mi);
        return {
            server: serverMatch[1].trim(),
            bypass: overrideMatch ? overrideMatch[1].trim().split(';').filter(Boolean) : [],
        };
    } catch {
        return null;
    }
}

export async function resolveSystemProxy(targetUrl, env = process.env, windowsProxyReader = readWindowsProxy) {
    const parsed = new URL(targetUrl);
    if (isLoopbackHost(parsed.hostname)) return null;
    const scheme = parsed.protocol.replace(':', '').toLowerCase();

    const readEnv = name => (env[name.toLowerCase()] ?? env[name.toUpperCase()]);
    const noProxyRaw = readEnv('no_proxy');
    if (noProxyRaw) {
        for (const rule of noProxyRaw.split(',')) {
            if (hostMatchesRule(parsed.hostname, rule)) return null;
        }
    }

    const schemeKey = scheme === 'https' ? 'https_proxy' : 'http_proxy';
    const hasEnvScheme = Object.keys(env).some(key => key.toLowerCase() === schemeKey);
    if (hasEnvScheme) {
        const value = (readEnv(schemeKey) || '').trim();
        return value || null;
    }
    const hasEnvAll = Object.keys(env).some(key => key.toLowerCase() === 'all_proxy');
    if (hasEnvAll) {
        const value = (readEnv('all_proxy') || '').trim();
        return value || null;
    }

    const win = await windowsProxyReader();
    if (!win?.server) return null;
    if (win.bypass?.some(rule => hostMatchesRule(parsed.hostname, rule))) return null;
    return parseProxyServerValue(win.server, scheme);
}

function classifyNetworkError(error) {
    if (error instanceof UpdateError && error.code === 'network') return error;
    const text = String(error?.message || '');
    const code = String(error?.code || '');
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code.includes('CERT') || text.includes('certificate')) {
        return new UpdateError('network', 'certificate');
    }
    if (error?.name === 'AbortError' || code === 'ETIMEDOUT' || text.includes('timed out')) {
        return new UpdateError('network', 'timeout');
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return new UpdateError('network', 'dns');
    }
    if (text.includes('Tunnel connection failed') || error?.proxyError) {
        return new UpdateError('network', 'proxy');
    }
    if (Number.isInteger(error?.statusCode)) {
        return new UpdateError('network', error.statusCode === 407 ? 'proxy' : 'http', error.statusCode);
    }
    return new UpdateError('network', 'connection');
}

function isRetryableTlsError(error) {
    const code = String(error?.code || '');
    const msg = String(error?.message || '');
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code.includes('CERT') || msg.includes('certificate')) return false;
    return code.startsWith('ERR_SSL') || code === 'ECONNRESET' || msg.includes('TLS') || msg.includes('SSL');
}

function openConnectTunnel(proxyUrlString, targetHost, targetPort, timeoutMs, maxVersion) {
    const proxyUrl = new URL(proxyUrlString.includes('://') ? proxyUrlString : `http://${proxyUrlString}`);
    if (!['http:', 'https:'].includes(proxyUrl.protocol)) {
        const err = new Error('Unsupported proxy protocol');
        err.proxyError = true;
        return Promise.reject(err);
    }
    const proxyHost = proxyUrl.hostname;
    const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);

    return new Promise((resolveSocket, rejectSocket) => {
        let settled = false;
        let buffer = Buffer.alloc(0);
        const socket = proxyUrl.protocol === 'https:'
            ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost })
            : net.connect({ host: proxyHost, port: proxyPort });
        const fail = error => {
            if (settled) return;
            settled = true;
            socket.destroy();
            rejectSocket(error);
        };
        socket.setTimeout(timeoutMs, () => fail(Object.assign(new Error('Proxy connect timed out'), { code: 'ETIMEDOUT' })));
        socket.once('error', error => fail(Object.assign(error, { proxyError: true })));

        const onConnect = () => {
            const headers = [
                `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
                `Host: ${targetHost}:${targetPort}`,
            ];
            if (proxyUrl.username || proxyUrl.password) {
                const auth = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64');
                headers.push(`Proxy-Authorization: Basic ${auth}`);
            }
            socket.write(headers.join('\r\n') + '\r\n\r\n');
        };
        socket.once(proxyUrl.protocol === 'https:' ? 'secureConnect' : 'connect', onConnect);

        const onData = chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > 16384) {
                fail(Object.assign(new Error('Proxy header too large'), { proxyError: true }));
                return;
            }
            const end = buffer.indexOf('\r\n\r\n');
            if (end < 0) return;
            socket.removeListener('data', onData);
            socket.setTimeout(0);
            const head = buffer.subarray(0, end).toString('latin1');
            const match = head.match(/^HTTP\/\d\.\d\s+(\d{3})/);
            const status = match ? Number(match[1]) : 0;
            if (status !== 200) {
                fail(Object.assign(new Error(`Tunnel connection failed: ${status}`), { proxyError: true, statusCode: status === 407 ? 407 : undefined }));
                return;
            }
            socket.pause();
            const leftover = buffer.subarray(end + 4);
            if (leftover.length) socket.unshift(leftover);
            const tlsSocket = tls.connect({
                socket,
                servername: targetHost,
                ...(maxVersion ? { maxVersion } : {}),
            });
            tlsSocket.once('secureConnect', () => {
                if (settled) {
                    tlsSocket.destroy();
                    return;
                }
                settled = true;
                resolveSocket(tlsSocket);
            });
            tlsSocket.once('error', fail);
        };
        socket.on('data', onData);
    });
}

function validateTrustedUrl(urlString, extraTrustedOrigins) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        throw new UpdateError('verification');
    }
    if (parsed.username || parsed.password) throw new UpdateError('verification');
    if (extraTrustedOrigins?.has(parsed.origin)) return parsed;
    if (parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443') || !TRUSTED_GITHUB_HOSTS.has(parsed.hostname)) {
        throw new UpdateError('verification');
    }
    return parsed;
}

async function httpRequestOnce(urlString, {
    method = 'GET',
    headers = {},
    maxBytes = MAX_METADATA_BYTES,
    timeoutMs = SOCKET_TIMEOUT_MS,
    deadline = Date.now() + CHECK_BUDGET_MS,
    onProgress = null,
    proxyResolver = resolveSystemProxy,
    maxVersion = undefined,
}) {
    const parsed = new URL(urlString);
    const remaining = Math.max(1000, Math.min(timeoutMs, deadline - Date.now()));
    const proxyUrl = await proxyResolver(urlString);
    const isHttps = parsed.protocol === 'https:';
    const port = Number(parsed.port) || (isHttps ? 443 : 80);

    let tunnelSocket = null;
    if (proxyUrl && isHttps) {
        tunnelSocket = await openConnectTunnel(proxyUrl, parsed.hostname, port, remaining, maxVersion);
    }

    const requestUrl = (!isHttps && proxyUrl) ? proxyUrl : urlString;
    const reqParsed = new URL(requestUrl);
    const transport = reqParsed.protocol === 'https:' ? https : http;
    const requestOptions = {
        protocol: reqParsed.protocol,
        hostname: reqParsed.hostname,
        port: reqParsed.port || (reqParsed.protocol === 'https:' ? 443 : 80),
        path: (!isHttps && proxyUrl) ? urlString : (parsed.pathname + parsed.search),
        method,
        agent: false,
        headers: {
            'User-Agent': 'Antigravity-Background-Updater',
            Connection: 'close',
            ...headers,
            ...(!isHttps && proxyUrl ? { Host: parsed.host } : {}),
        },
        ...(tunnelSocket ? { createConnection: () => tunnelSocket } : {}),
        ...(isHttps && !tunnelSocket && maxVersion ? { maxVersion } : {}),
    };

    return new Promise((resolveResponse, rejectResponse) => {
        let settled = false;
        const done = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadlineTimer);
            if (error) {
                req.destroy();
                tunnelSocket?.destroy();
                rejectResponse(error);
            } else {
                tunnelSocket?.destroy();
                resolveResponse(result);
            }
        };
        const deadlineTimer = setTimeout(() => {
            done(Object.assign(new Error('Update request timed out'), { code: 'ETIMEDOUT' }));
        }, Math.max(500, deadline - Date.now()));

        const req = transport.request(requestOptions, res => {
            const status = res.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                res.resume();
                done(null, { status, location: res.headers.location, headers: res.headers, body: Buffer.alloc(0) });
                return;
            }
            const contentLengthRaw = res.headers['content-length'];
            const total = contentLengthRaw && /^\d+$/.test(contentLengthRaw) ? Number(contentLengthRaw) : null;
            if (total !== null && total > maxBytes) {
                res.resume();
                done(new UpdateError('verification'));
                return;
            }
            const chunks = [];
            let received = 0;
            let lastReport = 0;
            res.on('data', chunk => {
                if (Date.now() > deadline) {
                    res.destroy(Object.assign(new Error('Update request timed out'), { code: 'ETIMEDOUT' }));
                    return;
                }
                received += chunk.length;
                if (received > maxBytes) {
                    res.destroy(new UpdateError('verification'));
                    return;
                }
                chunks.push(chunk);
                if (onProgress && Date.now() - lastReport >= 120) {
                    lastReport = Date.now();
                    try { onProgress(received, total); } catch {}
                }
            });
            res.on('end', () => {
                if (onProgress) try { onProgress(received, total); } catch {}
                done(null, { status, headers: res.headers, body: Buffer.concat(chunks), finalUrl: urlString });
            });
            res.on('error', error => done(error));
        });
        req.setTimeout(remaining, () => {
            req.destroy(Object.assign(new Error('Update socket timed out'), { code: 'ETIMEDOUT' }));
        });
        req.on('error', error => done(error));
        req.end();
    });
}

async function fetchTrusted(urlString, options = {}) {
    const { extraTrustedOrigins, method = 'GET', deadline = Date.now() + CHECK_BUDGET_MS } = options;
    let currentUrl = urlString;
    for (let hop = 0; hop < 6; hop++) {
        validateTrustedUrl(currentUrl, extraTrustedOrigins);
        let response;
        try {
            response = await httpRequestOnce(currentUrl, { ...options, deadline });
        } catch (error) {
            if (isRetryableTlsError(error)) {
                try {
                    response = await httpRequestOnce(currentUrl, { ...options, deadline, maxVersion: 'TLSv1.2' });
                } catch (retryError) {
                    throw classifyNetworkError(retryError);
                }
            } else {
                throw classifyNetworkError(error);
            }
        }
        if (response.location) {
            currentUrl = new URL(response.location, currentUrl).href;
            continue;
        }
        if (response.status >= 400) {
            throw Object.assign(new UpdateError('network', response.status === 407 ? 'proxy' : 'http', response.status), { statusCode: response.status });
        }
        return { ...response, finalUrl: currentUrl };
    }
    throw new UpdateError('verification');
}

function parseChecksumFile(text, filename) {
    const matches = [];
    for (const rawLine of String(text).split(/\r?\n/)) {
        const parts = rawLine.trim().split(/\s+/);
        if (parts.length === 1 && SHA256_RE.test(parts[0])) {
            matches.push(parts[0].toLowerCase());
        } else if (parts.length === 2 && parts[1].replace(/^\*/, '') === filename && SHA256_RE.test(parts[0])) {
            matches.push(parts[0].toLowerCase());
        }
    }
    if (matches.length !== 1) throw new UpdateError('verification');
    return matches[0];
}

function parseAtomLatestCommit(xmlText, repo, webBase) {
    const entryMatch = String(xmlText).match(/<entry>([\s\S]*?)<\/entry>/i);
    if (!entryMatch) throw new UpdateError('verification');
    const entry = entryMatch[1];
    const idMatch = entry.match(/<id>[^<]*Commit\/([0-9a-f]{40})<\/id>/i);
    if (!idMatch) throw new UpdateError('verification');
    const sha = idMatch[1].toLowerCase();
    const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/i);
    const title = titleMatch ? sanitizeText(decodeHtmlEntities(titleMatch[1]), 300) : '';
    const rawHref = linkMatch ? decodeHtmlEntities(linkMatch[1]) : `${webBase}/${repo}/commit/${sha}`;
    return {
        sha,
        message: title,
        url: rawHref.startsWith('http') ? rawHref : `${webBase}${rawHref}`,
    };
}

/** Windows locks a process's current working directory; move cwd to pluginDir so sidecars/ files can swap cleanly. */
export function releaseRuntimeDirectory(pluginDir, {
    platform = process.platform,
    cwd = () => process.cwd(),
    chdir = dir => process.chdir(dir),
} = {}) {
    if (platform !== 'win32') return false;
    const root = win32.resolve(pluginDir);
    const current = win32.resolve(cwd());
    for (const segment of ['assets', 'plugin', 'sidecars']) {
        const relative = win32.relative(win32.join(root, segment), current);
        if (relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative))) {
            chdir(root);
            return true;
        }
    }
    return false;
}

function hasSymlinkInTree(targetPath) {
    const info = lstatSync(targetPath, { throwIfNoEntry: false });
    if (!info) return false;
    if (info.isSymbolicLink()) return true;
    return false;
}

const PRIVATE_ENTRIES = new Set(['data', 'sdk']);

async function listRuntimeFiles(rootDir) {
    const files = [];
    for (const rootEntry of RUNTIME_ROOTS) {
        const entryPath = join(rootDir, rootEntry);
        const info = lstatSync(entryPath, { throwIfNoEntry: false });
        if (!info) continue;
        if (info.isSymbolicLink()) throw new UpdateError('location', 'install-location');
        if (info.isFile()) {
            files.push(rootEntry);
            continue;
        }
        if (info.isDirectory()) {
            const walk = async (dir, prefix) => {
                const items = await readdir(dir, { withFileTypes: true });
                for (const item of items) {
                    if (PRIVATE_ENTRIES.has(item.name.toLowerCase())) continue;
                    const rel = prefix ? `${prefix}/${item.name}` : item.name;
                    const full = join(dir, item.name);
                    if (item.isSymbolicLink()) throw new UpdateError('location', 'install-location');
                    if (item.isDirectory()) await walk(full, rel);
                    else if (item.isFile()) files.push(rel);
                }
            };
            await walk(entryPath, rootEntry);
        }
    }
    return files.sort();
}

async function writeAtomicFile(targetPath, content) {
    await mkdir(dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
        await writeFile(tempPath, content, { flag: 'wx' });
        await rename(tempPath, targetPath);
    } finally {
        await rm(tempPath, { force: true }).catch(() => {});
    }
}

async function copyAtomicFile(sourcePath, targetPath) {
    await mkdir(dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
        await copyFile(sourcePath, tempPath);
        await rename(tempPath, targetPath);
    } finally {
        await rm(tempPath, { force: true }).catch(() => {});
    }
}

async function fileSha256(filePath) {
    try {
        return digestSha256(await readFile(filePath));
    } catch {
        return null;
    }
}

export class PluginUpdater {
    constructor({
        pluginDir,
        dataDir,
        home = homedir(),
        onReload = null,
        now = Date.now,
        repo = DEFAULT_REPO,
        endpoints = {},
        expectedPluginDir = null,
        allowCustomTarget = false,
        proxyResolver = resolveSystemProxy,
    }) {
        this.pluginDir = resolve(pluginDir);
        this.updatesDir = join(resolve(dataDir), 'updates');
        this.home = home;
        this.onReload = onReload;
        this.now = now;
        this.repo = repo;
        this.endpoints = {
            apiBase: endpoints.apiBase || 'https://api.github.com',
            webBase: endpoints.webBase || 'https://github.com',
            rawBase: endpoints.rawBase || 'https://raw.githubusercontent.com',
            codeloadBase: endpoints.codeloadBase || 'https://codeload.github.com',
        };
        this.extraTrustedOrigins = new Set(
            Object.values(this.endpoints)
                .map(url => new URL(url).origin)
                .filter(origin => !TRUSTED_GITHUB_HOSTS.has(new URL(origin).hostname))
        );
        this.expectedPluginDir = expectedPluginDir ? resolve(expectedPluginDir) : join(resolve(home), '.gemini', 'config', 'plugins', PLUGIN_NAME);
        this.allowCustomTarget = allowCustomTarget;
        this.proxyResolver = proxyResolver;

        this.state = {
            state: 'idle',
            repo: this.repo,
            repoUrl: `${this.endpoints.webBase}/${this.repo}`,
            releaseUrl: null,
            commitUrl: null,
            currentVersion: null,
            currentCommit: null,
            latestVersion: null,
            latestCommit: null,
            sourceKind: null,
            hasUpdate: false,
            updateReason: null,
            notes: '',
            progress: undefined,
            error: undefined,
            errorDetail: undefined,
            canApply: false,
            applyDisabledReason: undefined,
            persistenceUpdated: false,
            checkedAt: null,
        };
        this.plan = null;
        this.checkPending = null;
        this.applyPending = null;
        this.job = null;
        this.lastCheck = 0;
    }

    publicState() {
        const s = this.state;
        return {
            state: s.state,
            repo: s.repo,
            repoUrl: s.repoUrl,
            releaseUrl: s.releaseUrl,
            commitUrl: s.commitUrl,
            currentVersion: s.currentVersion,
            currentCommit: s.currentCommit,
            currentCommitShort: s.currentCommit ? s.currentCommit.slice(0, 7) : null,
            latestVersion: s.latestVersion,
            latestCommit: s.latestCommit,
            latestCommitShort: s.latestCommit ? s.latestCommit.slice(0, 7) : null,
            sourceKind: s.sourceKind,
            hasUpdate: Boolean(s.hasUpdate),
            updateReason: s.updateReason,
            notes: s.notes || '',
            progress: s.progress,
            error: s.error,
            errorDetail: s.errorDetail,
            canApply: Boolean(s.canApply),
            applyDisabledReason: s.applyDisabledReason,
            persistenceUpdated: Boolean(s.persistenceUpdated),
            checkedAt: s.checkedAt,
        };
    }

    async readLocalState() {
        const manifestRaw = await readFile(join(this.pluginDir, 'plugin.json'), 'utf8');
        const manifest = JSON.parse(manifestRaw.replace(/^\uFEFF/, ''));
        if (manifest?.name !== PLUGIN_NAME || !parseSemver(manifest?.version)) {
            throw new UpdateError('verification');
        }
        let currentCommit = null;
        try {
            const sourceRaw = await readFile(join(this.pluginDir, '.install-source.json'), 'utf8');
            const source = JSON.parse(sourceRaw.replace(/^\uFEFF/, ''));
            if (source?.version === manifest.version && typeof source?.commit === 'string' && SHA_RE.test(source.commit)) {
                currentCommit = source.commit.toLowerCase();
            }
        } catch {}
        return { currentVersion: manifest.version, currentCommit };
    }

    inspectTargetEligibility() {
        if (existsSync(join(this.pluginDir, '.git'))) {
            return { canApply: false, reason: 'dev-workspace' };
        }
        if (hasSymlinkInTree(this.pluginDir)) {
            return { canApply: false, reason: 'location' };
        }
        if (!this.allowCustomTarget) {
            try {
                if (!existsSync(this.expectedPluginDir) || hasSymlinkInTree(this.expectedPluginDir)) {
                    return { canApply: false, reason: 'location' };
                }
                if (realpathSync(this.pluginDir).toLowerCase() !== realpathSync(this.expectedPluginDir).toLowerCase()) {
                    return { canApply: false, reason: 'location' };
                }
            } catch {
                return { canApply: false, reason: 'location' };
            }
        }
        return { canApply: true, reason: null };
    }

    async initializeLocalInfo() {
        try {
            const local = await this.readLocalState();
            const target = this.inspectTargetEligibility();
            this.state.currentVersion = local.currentVersion;
            this.state.currentCommit = local.currentCommit;
            this.state.canApply = target.canApply;
            this.state.applyDisabledReason = target.reason || undefined;
        } catch {}
        return this.publicState();
    }

    fetchOptions(deadline, extra = {}) {
        return {
            extraTrustedOrigins: this.extraTrustedOrigins,
            proxyResolver: this.proxyResolver,
            deadline,
            ...extra,
        };
    }

    async tryFetchLatestRelease(currentVersion, deadline) {
        const { apiBase, webBase, codeloadBase } = this.endpoints;
        const apiUrl = `${apiBase}/repos/${this.repo}/releases/latest`;
        try {
            const res = await fetchTrusted(apiUrl, this.fetchOptions(Math.min(deadline, Date.now() + 10000), {
                headers: { Accept: 'application/vnd.github+json' },
                maxBytes: MAX_METADATA_BYTES,
            }));
            const release = JSON.parse(res.body.toString('utf8'));
            if (release.draft || release.prerelease) return null;
            const rawTag = String(release.tag_name || '').trim();
            const versionMatch = rawTag.match(/^v?(\d+\.\d+\.\d+)$/);
            if (!versionMatch || !parseSemver(versionMatch[1])) throw new UpdateError('verification');
            const latestVersion = versionMatch[1];
            const assets = Array.isArray(release.assets) ? release.assets : [];
            const zipAsset = this.selectReleaseZipAsset(assets, latestVersion);
            const shaAsset = zipAsset ? assets.find(item => item?.name === `${zipAsset.name}.sha256`) : null;
            const hasPair = Boolean(zipAsset && shaAsset && this.isTrustedDownloadAsset(zipAsset.browser_download_url) && this.isTrustedDownloadAsset(shaAsset.browser_download_url));
            return {
                sourceKind: 'release',
                tag: rawTag,
                latestVersion,
                latestCommit: null,
                releaseUrl: `${webBase}/${this.repo}/releases/tag/${rawTag}`,
                commitUrl: null,
                notes: sanitizeText(release.body || ''),
                packageKind: hasPair ? 'release-zip' : 'tarball',
                archiveName: hasPair ? zipAsset.name : `${PLUGIN_NAME}-${latestVersion}.tar.gz`,
                url: hasPair ? zipAsset.browser_download_url : `${codeloadBase}/${this.repo}/tar.gz/refs/tags/${rawTag}`,
                checksumUrl: hasPair ? shaAsset.browser_download_url : null,
                size: hasPair && Number.isSafeInteger(zipAsset.size) && zipAsset.size > 0 && zipAsset.size <= MAX_ARCHIVE_BYTES ? zipAsset.size : null,
            };
        } catch (error) {
            if (error?.statusCode === 404) return null;
            if (error?.statusCode !== undefined && ![403, 429].includes(error.statusCode)) throw error;
            if (error?.detail === 'certificate') throw error;
        }

        // Fallback to public HTML page when API hits 403/429 rate-limit or transient API block.
        const htmlRes = await fetchTrusted(`${webBase}/${this.repo}/releases/latest`, this.fetchOptions(deadline, {
            headers: { Accept: 'text/html' },
            maxBytes: MAX_METADATA_BYTES,
        }));
        const finalPath = new URL(htmlRes.finalUrl).pathname.replace(/\/+$/, '');
        if (finalPath === `/${this.repo}/releases`) return null;
        const tagPrefix = `/${this.repo}/releases/tag/`;
        if (!finalPath.startsWith(tagPrefix)) throw new UpdateError('verification');
        const rawTag = decodeURIComponent(finalPath.slice(tagPrefix.length));
        const versionMatch = rawTag.match(/^v?(\d+\.\d+\.\d+)$/);
        if (!versionMatch || !parseSemver(versionMatch[1])) throw new UpdateError('verification');
        const latestVersion = versionMatch[1];

        let zipAsset = null;
        let shaAsset = null;
        if (compareSemver(latestVersion, currentVersion) > 0) {
            try {
                const expandedRes = await fetchTrusted(`${webBase}/${this.repo}/releases/expanded_assets/${encodeURIComponent(rawTag)}`, this.fetchOptions(deadline, {
                    headers: { Accept: 'text/html' },
                    maxBytes: MAX_METADATA_BYTES,
                }));
                const expandedHtml = decodeHtmlEntities(expandedRes.body.toString('utf8'));
                const hrefs = [...expandedHtml.matchAll(/href="([^"]*\/releases\/download\/[^"]+)"/g)].map(m => m[1]);
                const resolvedAssets = hrefs.map(href => new URL(href, webBase).href);
                const zipUrls = resolvedAssets.filter(href => href.toLowerCase().endsWith('.zip'));
                const chosenZip = this.selectPreferredZipUrl(zipUrls, latestVersion);
                const chosenSha = chosenZip ? resolvedAssets.find(href => href === `${chosenZip}.sha256`) : null;
                if (chosenZip && chosenSha) {
                    zipAsset = chosenZip;
                    shaAsset = chosenSha;
                }
            } catch {}
        }

        return {
            sourceKind: 'release',
            tag: rawTag,
            latestVersion,
            latestCommit: null,
            releaseUrl: `${webBase}/${this.repo}/releases/tag/${rawTag}`,
            commitUrl: null,
            notes: '',
            packageKind: zipAsset && shaAsset ? 'release-zip' : 'tarball',
            archiveName: zipAsset ? zipAsset.split('/').pop() : `${PLUGIN_NAME}-${latestVersion}.tar.gz`,
            url: zipAsset && shaAsset ? zipAsset : `${codeloadBase}/${this.repo}/tar.gz/refs/tags/${rawTag}`,
            checksumUrl: zipAsset && shaAsset ? shaAsset : null,
            size: null,
        };
    }

    isTrustedDownloadAsset(assetUrl) {
        if (typeof assetUrl !== 'string') return false;
        try {
            validateTrustedUrl(assetUrl, this.extraTrustedOrigins);
            return true;
        } catch {
            return false;
        }
    }

    selectReleaseZipAsset(assets, latestVersion) {
        const zips = assets.filter(item => typeof item?.name === 'string' && item.name.toLowerCase().endsWith('.zip'));
        const preferredNames = [
            `antigravity-background-${latestVersion}.zip`,
            `antigravity-ui-${latestVersion}.zip`,
        ];
        for (const preferred of preferredNames) {
            const match = zips.find(item => item.name.toLowerCase() === preferred);
            if (match) return match;
        }
        return zips.length === 1 ? zips[0] : null;
    }

    selectPreferredZipUrl(urls, latestVersion) {
        const preferredNames = [
            `antigravity-background-${latestVersion}.zip`,
            `antigravity-ui-${latestVersion}.zip`,
        ];
        for (const preferred of preferredNames) {
            const match = urls.find(url => url.toLowerCase().endsWith('/' + preferred));
            if (match) return match;
        }
        return urls.length === 1 ? urls[0] : null;
    }

    async fetchMainBranchInfo(deadline) {
        const { apiBase, webBase, rawBase, codeloadBase } = this.endpoints;
        let manifestBody;
        try {
            const res = await fetchTrusted(`${rawBase}/${this.repo}/main/plugin.json`, this.fetchOptions(deadline, { maxBytes: 65536 }));
            manifestBody = res.body;
        } catch {
            const res = await fetchTrusted(`${webBase}/${this.repo}/raw/refs/heads/main/plugin.json`, this.fetchOptions(deadline, { maxBytes: 65536 }));
            manifestBody = res.body;
        }
        const manifest = JSON.parse(manifestBody.toString('utf8').replace(/^\uFEFF/, ''));
        if (manifest?.name !== PLUGIN_NAME || !parseSemver(manifest?.version)) {
            throw new UpdateError('verification');
        }
        const latestVersion = manifest.version;

        let commitInfo = null;
        try {
            const res = await fetchTrusted(`${apiBase}/repos/${this.repo}/commits/main`, this.fetchOptions(Math.min(deadline, Date.now() + 10000), {
                headers: { Accept: 'application/vnd.github+json' },
                maxBytes: MAX_METADATA_BYTES,
            }));
            const commit = JSON.parse(res.body.toString('utf8'));
            if (typeof commit?.sha === 'string' && SHA_RE.test(commit.sha)) {
                commitInfo = {
                    sha: commit.sha.toLowerCase(),
                    message: sanitizeText(commit.commit?.message || ''),
                    url: `${webBase}/${this.repo}/commit/${commit.sha.toLowerCase()}`,
                };
            }
        } catch (error) {
            if (error?.detail === 'certificate') throw error;
        }

        if (!commitInfo) {
            const atomRes = await fetchTrusted(`${webBase}/${this.repo}/commits/main.atom`, this.fetchOptions(deadline, {
                headers: { Accept: 'application/atom+xml, application/xml, text/xml' },
                maxBytes: MAX_METADATA_BYTES,
            }));
            commitInfo = parseAtomLatestCommit(atomRes.body.toString('utf8'), this.repo, webBase);
        }

        return {
            sourceKind: 'main',
            tag: null,
            latestVersion,
            latestCommit: commitInfo.sha,
            releaseUrl: null,
            commitUrl: commitInfo.url,
            notes: commitInfo.message,
            packageKind: 'tarball',
            archiveName: `${PLUGIN_NAME}-${commitInfo.sha.slice(0, 7)}.tar.gz`,
            url: `${codeloadBase}/${this.repo}/tar.gz/${commitInfo.sha}`,
            checksumUrl: null,
            size: null,
        };
    }

    async check({ force = false } = {}) {
        if (this.job || this.applyPending || ['installing', 'installed', 'reloading'].includes(this.state.state)) {
            return this.publicState();
        }
        if (this.checkPending) return this.checkPending;
        if (!force && this.lastCheck && this.now() - this.lastCheck < CHECK_COOLDOWN_MS && ['current', 'available'].includes(this.state.state)) {
            return this.publicState();
        }

        this.checkPending = (async () => {
            this.plan = null;
            const target = this.inspectTargetEligibility();
            this.state = {
                ...this.state,
                state: 'checking',
                hasUpdate: false,
                updateReason: null,
                error: undefined,
                errorDetail: undefined,
                canApply: target.canApply,
                applyDisabledReason: target.reason || undefined,
                progress: { phase: 'check' },
            };

            try {
                const { currentVersion, currentCommit } = await this.readLocalState();
                this.state.currentVersion = currentVersion;
                this.state.currentCommit = currentCommit;

                const deadline = Date.now() + CHECK_BUDGET_MS;
                let remote = await this.tryFetchLatestRelease(currentVersion, deadline);
                if (!remote) remote = await this.fetchMainBranchInfo(deadline);

                const cmp = compareSemver(remote.latestVersion, currentVersion);
                let hasUpdate = false;
                let updateReason = null;
                if (cmp > 0) {
                    hasUpdate = true;
                    updateReason = 'version';
                } else if (cmp === 0 && remote.sourceKind === 'main' && currentCommit && remote.latestCommit && currentCommit !== remote.latestCommit) {
                    hasUpdate = true;
                    updateReason = 'commit';
                }

                this.plan = hasUpdate ? {
                    ...remote,
                    currentVersion,
                    currentCommit,
                    expectedVersion: remote.latestVersion,
                    expires: this.now() + PLAN_TTL_MS,
                } : null;

                this.state = {
                    ...this.state,
                    state: hasUpdate ? 'available' : 'current',
                    sourceKind: remote.sourceKind,
                    latestVersion: remote.latestVersion,
                    latestCommit: remote.latestCommit,
                    releaseUrl: remote.releaseUrl,
                    commitUrl: remote.commitUrl,
                    hasUpdate,
                    updateReason,
                    notes: remote.notes || '',
                    progress: undefined,
                    error: undefined,
                    errorDetail: undefined,
                    checkedAt: new Date(this.now()).toISOString(),
                };
            } catch (error) {
                const classified = error instanceof UpdateError ? error : classifyNetworkError(error);
                this.state = {
                    ...this.state,
                    state: 'error',
                    progress: undefined,
                    error: ALLOWED_ERROR_CODES.has(classified.code) ? classified.code : 'install',
                    errorDetail: classified.detail,
                };
            }
            this.lastCheck = this.now();
            return this.publicState();
        })().finally(() => { this.checkPending = null; });

        return this.checkPending;
    }

    requestCheck(options = {}) {
        void this.check(options).catch(() => {});
        return this.publicState();
    }

    async apply(input = {}) {
        if (this.job) return this.publicState();
        if (this.applyPending) return this.applyPending;
        this.applyPending = this.startApply(input);
        try {
            return await this.applyPending;
        } finally {
            this.applyPending = null;
        }
    }

    async startApply(input = {}) {
        const plan = this.plan;
        if (!plan || this.state.state !== 'available') throw new UpdateError('verification');
        if (input.version !== plan.latestVersion) throw new UpdateError('verification');
        if (plan.sourceKind === 'main' && input.commit !== plan.latestCommit) throw new UpdateError('verification');

        const target = this.inspectTargetEligibility();
        if (!target.canApply) {
            this.plan = null;
            this.state = {
                ...this.state,
                state: 'error',
                canApply: false,
                applyDisabledReason: target.reason || 'location',
                error: 'location',
                errorDetail: target.reason === 'dev-workspace' ? 'dev-workspace' : 'install-location',
                progress: undefined,
            };
            return this.publicState();
        }

        try {
            if (plan.expires <= this.now()) {
                throw new UpdateError('verification', 'plan-expired');
            }
            const local = await this.readLocalState();
            this.state.currentVersion = local.currentVersion;
            this.state.currentCommit = local.currentCommit;
            if (local.currentVersion !== plan.currentVersion || local.currentCommit !== plan.currentCommit) {
                throw new UpdateError('verification', 'plan-expired');
            }
        } catch (error) {
            this.plan = null;
            const err = error instanceof UpdateError ? error : new UpdateError('verification');
            this.state = { ...this.state, state: 'error', error: err.code, errorDetail: err.detail, progress: undefined };
            return this.publicState();
        }

        this.plan = null;
        this.state = {
            ...this.state,
            state: 'installing',
            error: undefined,
            errorDetail: undefined,
            persistenceUpdated: false,
            progress: { phase: 'verify' },
        };

        this.job = this.performInstall(plan)
            .catch(error => {
                const err = error instanceof UpdateError ? error : classifyNetworkError(error);
                this.state = {
                    ...this.state,
                    state: 'error',
                    error: ALLOWED_ERROR_CODES.has(err.code) ? err.code : 'install',
                    errorDetail: err.detail || (['EACCES', 'EPERM', 'EBUSY'].includes(error?.code) ? 'permission' : undefined),
                };
            })
            .finally(() => { this.job = null; });

        return this.publicState();
    }

    async performInstall(plan) {
        const deadline = Date.now() + APPLY_BUDGET_MS;
        await mkdir(this.updatesDir, { recursive: true });
        const lockPath = join(dirname(this.pluginDir), `.${PLUGIN_NAME}-update.lock`);
        let lockHandle;
        try {
            lockHandle = await open(lockPath, 'wx');
        } catch (error) {
            if (error.code === 'EEXIST') throw new UpdateError('busy');
            throw new UpdateError('install', ['EACCES', 'EPERM'].includes(error.code) ? 'permission' : undefined);
        }

        const txDir = join(this.updatesDir, `tx-${randomUUID()}`);
        try {
            await this.recoverInterruptedTransactions();
            let expectedSha256 = null;
            if (plan.packageKind === 'release-zip' && plan.checksumUrl) {
                this.state = { ...this.state, progress: { phase: 'verify' } };
                const shaRes = await fetchTrusted(plan.checksumUrl, this.fetchOptions(deadline, { maxBytes: 8192 }));
                expectedSha256 = parseChecksumFile(shaRes.body.toString('utf8'), plan.archiveName);
            }

            this.state = { ...this.state, progress: { phase: 'download', received: 0, total: plan.size || undefined } };
            const archiveRes = await fetchTrusted(plan.url, this.fetchOptions(deadline, {
                maxBytes: MAX_ARCHIVE_BYTES,
                timeoutMs: 60000,
                onProgress: (received, total) => {
                    if (this.state.state !== 'installing') return;
                    this.state = {
                        ...this.state,
                        progress: { phase: 'download', received, ...(total ? { total } : {}) },
                    };
                },
            }));

            this.state = { ...this.state, progress: { phase: 'verify' } };
            if (expectedSha256) {
                if (plan.size && archiveRes.body.length !== plan.size) throw new UpdateError('verification');
                if (digestSha256(archiveRes.body) !== expectedSha256) throw new UpdateError('verification');
            }

            this.state = { ...this.state, progress: { phase: 'extract' } };
            await mkdir(txDir, { recursive: true });
            const stageDir = join(txDir, 'stage');
            const archiveKind = plan.packageKind === 'release-zip' ? 'zip' : 'tar.gz';
            let stagedFiles;
            try {
                stagedFiles = await stageRuntimeArchive(archiveRes.body, archiveKind, stageDir, plan.expectedVersion);
            } catch {
                throw new UpdateError('verification');
            }

            const oldPersistenceHash = await fileSha256(join(this.pluginDir, 'plugin', 'persistence.cjs'));
            const newPersistenceHash = await fileSha256(join(stageDir, 'plugin', 'persistence.cjs'));
            const persistenceUpdated = Boolean(oldPersistenceHash && newPersistenceHash && oldPersistenceHash !== newPersistenceHash);

            releaseRuntimeDirectory(this.pluginDir);

            this.state = { ...this.state, progress: { phase: 'backup' } };
            const oldFiles = await listRuntimeFiles(this.pluginDir);
            const backupDir = join(txDir, 'backup');
            await mkdir(backupDir, { recursive: true });
            for (const rel of oldFiles) {
                const dest = join(backupDir, ...rel.split('/'));
                await mkdir(dirname(dest), { recursive: true });
                await copyFile(join(this.pluginDir, ...rel.split('/')), dest);
            }
            const oldSourcePath = join(this.pluginDir, '.install-source.json');
            const hadSourceMeta = existsSync(oldSourcePath);
            if (hadSourceMeta) {
                await copyFile(oldSourcePath, join(backupDir, '.install-source.json'));
            }

            const journal = {
                schema: 1,
                phase: 'installing',
                currentVersion: plan.currentVersion,
                expectedVersion: plan.expectedVersion,
                oldFiles,
                stagedFiles,
                hadSourceMeta,
            };
            const journalPath = join(txDir, 'journal.json');
            await writeAtomicFile(journalPath, JSON.stringify(journal));

            try {
                this.state = { ...this.state, progress: { phase: 'install' } };
                for (const rel of stagedFiles) {
                    await copyAtomicFile(join(stageDir, ...rel.split('/')), join(this.pluginDir, ...rel.split('/')));
                }
                const stagedSet = new Set(stagedFiles.map(item => item.toLowerCase()));
                for (const oldRel of oldFiles) {
                    if (!stagedSet.has(oldRel.toLowerCase())) {
                        await rm(join(this.pluginDir, ...oldRel.split('/')), { force: true });
                    }
                }
                const sourceMeta = {
                    repo: this.repo,
                    channel: plan.sourceKind,
                    version: plan.expectedVersion,
                    commit: plan.latestCommit || null,
                    tag: plan.tag || null,
                    updatedAt: new Date(this.now()).toISOString(),
                };
                await writeAtomicFile(oldSourcePath, JSON.stringify(sourceMeta, null, 2) + '\n');

                const verified = await this.readLocalState();
                if (verified.currentVersion !== plan.expectedVersion) {
                    throw new UpdateError('verification');
                }
                for (const required of REQUIRED_RUNTIME_FILES) {
                    const info = await stat(join(this.pluginDir, ...required.split('/'))).catch(() => null);
                    if (!info?.isFile()) throw new UpdateError('verification');
                }
                await writeAtomicFile(journalPath, JSON.stringify({ schema: 1, phase: 'committed' }));
            } catch (installError) {
                this.state = { ...this.state, progress: { phase: 'recover' } };
                await this.restoreBackupSnapshot(backupDir, journalPath, journal);
                if (installError instanceof UpdateError) throw installError;
                throw new UpdateError('install', ['EACCES', 'EPERM', 'EBUSY'].includes(installError?.code) ? 'permission' : undefined);
            }

            await rm(txDir, { recursive: true, force: true }).catch(() => {});
            this.state = {
                ...this.state,
                state: 'installed',
                currentVersion: plan.expectedVersion,
                currentCommit: plan.latestCommit || null,
                hasUpdate: false,
                persistenceUpdated,
                progress: { phase: 'complete' },
                error: undefined,
                errorDetail: undefined,
            };
        } finally {
            if (this.state.state !== 'error' || this.state.error !== 'rollback') {
                await rm(txDir, { recursive: true, force: true }).catch(() => {});
            }
            await lockHandle.close().catch(() => {});
            await rm(lockPath, { force: true }).catch(() => {});
        }
    }

    async restoreBackupSnapshot(backupDir, journalPath, journal) {
        try {
            const oldSet = new Set(journal.oldFiles.map(item => item.toLowerCase()));
            for (const rel of journal.oldFiles) {
                await copyAtomicFile(join(backupDir, ...rel.split('/')), join(this.pluginDir, ...rel.split('/')));
            }
            for (const stagedRel of journal.stagedFiles) {
                if (!oldSet.has(stagedRel.toLowerCase())) {
                    await rm(join(this.pluginDir, ...stagedRel.split('/')), { force: true });
                }
            }
            const sourceMetaPath = join(this.pluginDir, '.install-source.json');
            if (journal.hadSourceMeta) {
                await copyAtomicFile(join(backupDir, '.install-source.json'), sourceMetaPath);
            } else {
                await rm(sourceMetaPath, { force: true });
            }
            await writeAtomicFile(journalPath, JSON.stringify({ ...journal, phase: 'restored' }));
        } catch {
            throw new UpdateError('rollback');
        }
    }

    async recoverInterruptedTransactions() {
        const entries = await readdir(this.updatesDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('tx-')) continue;
            const txDir = join(this.updatesDir, entry.name);
            const journalPath = join(txDir, 'journal.json');
            if (!existsSync(journalPath)) {
                await rm(txDir, { recursive: true, force: true }).catch(() => {});
                continue;
            }
            let journal;
            try {
                journal = JSON.parse(await readFile(journalPath, 'utf8'));
            } catch {
                throw new UpdateError('rollback');
            }
            if (journal?.phase === 'committed' || journal?.phase === 'restored') {
                await rm(txDir, { recursive: true, force: true }).catch(() => {});
                continue;
            }
            if (journal?.phase !== 'installing' || !Array.isArray(journal.oldFiles) || !Array.isArray(journal.stagedFiles)) {
                throw new UpdateError('rollback');
            }
            await this.restoreBackupSnapshot(join(txDir, 'backup'), journalPath, journal);
            await rm(txDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    requestReload() {
        if (this.state.state === 'reloading') return this.publicState();
        if (this.state.state !== 'installed' || !this.onReload) throw new UpdateError('verification');
        this.state = { ...this.state, state: 'reloading' };
        const timer = setTimeout(() => { void this.onReload(); }, 350);
        timer.unref?.();
        return this.publicState();
    }
}
