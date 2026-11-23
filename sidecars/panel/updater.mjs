import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';
import * as archive from './archive.mjs';

const execFileAsync = promisify(execFile);
const { PLUGIN_NAME, REQUIRED_RUNTIME_FILES, RUNTIME_ROOTS, stageRuntimeArchive } = archive;
// Interrupted rollback can restore an older archive module before it restores the updater.
const isExcludedRuntimeSegment = archive.isExcludedRuntimeSegment ??
    (segment => ['data', 'sdk'].includes(segment.toLowerCase()));

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
const ALLOWED_ERROR_CODES = new Set(['network', 'verification', 'location', 'busy', 'install', 'rollback']);
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const SOCKET_TIMEOUT_MS = 10000;
const CHECK_BUDGET_MS = 30000;
const APPLY_BUDGET_MS = 120000;
const CHECK_COOLDOWN_MS = 5000;
const PLAN_TTL_MS = 15 * 60 * 1000;
const LOCK_OWNER_RE = /^owner-(\d+)-[a-f\d-]{36}$/;
const FILE_RETRY_DELAYS_MS = [30, 80, 150, 220];
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

function safeFromCodePoint(codePoint, fallback) {
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return fallback;
    }
    return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(text) {
    return String(text)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/gi, "'")
        .replace(/&#(\d+);/g, (match, num) => safeFromCodePoint(Number(num), match))
        .replace(/&#x([0-9a-f]+);/gi, (match, hex) => safeFromCodePoint(Number.parseInt(hex, 16), match));
}

function parseJsonStrict(raw) {
    try {
        return JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    } catch {
        throw new UpdateError('verification');
    }
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

function normalizeProxyUrl(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return null;
    return raw.includes('://') ? raw : `http://${raw}`;
}

function stripIpv6Brackets(hostname) {
    const host = String(hostname || '');
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function parseProxyServerValue(rawValue, scheme) {
    const raw = String(rawValue || '').trim();
    if (!raw) return null;
    if (!raw.includes('=')) {
        return normalizeProxyUrl(raw);
    }
    const map = {};
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) map[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
    }
    const selected = map[scheme] || map.https || map.http;
    if (!selected) return null;
    return normalizeProxyUrl(selected);
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
        return normalizeProxyUrl(readEnv(schemeKey));
    }
    const hasEnvAll = Object.keys(env).some(key => key.toLowerCase() === 'all_proxy');
    if (hasEnvAll) {
        return normalizeProxyUrl(readEnv('all_proxy'));
    }

    const win = await windowsProxyReader();
    if (!win?.server) return null;
    if (win.bypass?.some(rule => hostMatchesRule(parsed.hostname, rule))) return null;
    return parseProxyServerValue(win.server, scheme);
}

function classifyNetworkError(error) {
    if (error instanceof UpdateError) return error;
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
    if (Number.isInteger(error?.statusCode)) {
        return new UpdateError('network', error.statusCode === 407 ? 'proxy' : 'http', error.statusCode);
    }
    if (text.includes('Tunnel connection failed') || error?.proxyError) {
        return new UpdateError('network', 'proxy');
    }
    return new UpdateError('network', 'connection');
}

function isRetryableTlsError(error) {
    const code = String(error?.code || '');
    const msg = String(error?.message || '');
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code.includes('CERT') || msg.includes('certificate')) return false;
    return code.startsWith('ERR_SSL') || code === 'ECONNRESET' || msg.includes('TLS') || msg.includes('SSL');
}

function openConnectTunnel(proxyUrlString, targetHost, targetPort, timeoutMs, maxVersion, deadline) {
    const normalizedProxy = normalizeProxyUrl(proxyUrlString);
    let proxyUrl;
    try {
        proxyUrl = new URL(normalizedProxy);
    } catch {
        const err = new Error('Invalid proxy URL');
        err.proxyError = true;
        return Promise.reject(err);
    }
    if (!['http:', 'https:'].includes(proxyUrl.protocol)) {
        const err = new Error('Unsupported proxy protocol');
        err.proxyError = true;
        return Promise.reject(err);
    }
    const proxyHost = stripIpv6Brackets(proxyUrl.hostname);
    const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);
    const cleanTargetHost = stripIpv6Brackets(targetHost);
    const connectTargetHost = cleanTargetHost.includes(':') ? `[${cleanTargetHost}]` : cleanTargetHost;
    const effectiveDeadline = deadline ?? (Date.now() + timeoutMs);

    return new Promise((resolveSocket, rejectSocket) => {
        let settled = false;
        let buffer = Buffer.alloc(0);
        let tlsSocket = null;
        const socket = proxyUrl.protocol === 'https:'
            ? tls.connect({
                host: proxyHost,
                port: proxyPort,
                ...(net.isIP(proxyHost) ? {} : { servername: proxyHost }),
            })
            : net.connect({ host: proxyHost, port: proxyPort });
        const fail = error => {
            if (settled) return;
            settled = true;
            clearTimeout(tunnelTimer);
            tlsSocket?.destroy();
            socket.destroy();
            rejectSocket(error);
        };
        const tunnelTimeoutMs = Math.max(500, Math.min(timeoutMs, effectiveDeadline - Date.now()));
        const tunnelTimer = setTimeout(() => {
            fail(Object.assign(new Error('Proxy connect timed out'), { code: 'ETIMEDOUT' }));
        }, tunnelTimeoutMs);
        socket.setTimeout(tunnelTimeoutMs, () => fail(Object.assign(new Error('Proxy connect timed out'), { code: 'ETIMEDOUT' })));
        socket.once('error', error => fail(Object.assign(error, { proxyError: true })));
        socket.once('close', () => fail(Object.assign(new Error('Proxy socket closed during tunnel setup'), { proxyError: true })));

        const onConnect = () => {
            const headers = [
                `CONNECT ${connectTargetHost}:${targetPort} HTTP/1.1`,
                `Host: ${connectTargetHost}:${targetPort}`,
            ];
            if (proxyUrl.username || proxyUrl.password) {
                let user;
                let pass;
                try {
                    user = decodeURIComponent(proxyUrl.username);
                    pass = decodeURIComponent(proxyUrl.password);
                } catch {
                    fail(Object.assign(new Error('Invalid proxy credentials'), { proxyError: true }));
                    return;
                }
                const auth = Buffer.from(`${user}:${pass}`).toString('base64');
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
            const tlsRemaining = effectiveDeadline - Date.now();
            if (tlsRemaining <= 0) {
                fail(Object.assign(new Error('Proxy TLS handshake timed out'), { code: 'ETIMEDOUT' }));
                return;
            }
            socket.pause();
            const leftover = buffer.subarray(end + 4);
            if (leftover.length) socket.unshift(leftover);
            tlsSocket = tls.connect({
                socket,
                ...(net.isIP(cleanTargetHost) ? {} : { servername: cleanTargetHost }),
                ...(maxVersion ? { maxVersion } : {}),
            });
            tlsSocket.setTimeout(Math.max(500, Math.min(timeoutMs, tlsRemaining)), () => {
                fail(Object.assign(new Error('Proxy TLS handshake timed out'), { code: 'ETIMEDOUT' }));
            });
            tlsSocket.once('secureConnect', () => {
                clearTimeout(tunnelTimer);
                tlsSocket.setTimeout(0);
                if (settled) {
                    tlsSocket.destroy();
                    return;
                }
                settled = true;
                resolveSocket(tlsSocket);
            });
            tlsSocket.once('error', fail);
            tlsSocket.once('close', () => fail(new Error('TLS socket closed before handshake completed')));
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
    if (Date.now() >= deadline) {
        throw Object.assign(new Error('Update request timed out'), { code: 'ETIMEDOUT' });
    }
    const remaining = Math.max(1000, Math.min(timeoutMs, deadline - Date.now()));
    const rawProxyUrl = await proxyResolver(urlString);
    const proxyUrl = normalizeProxyUrl(rawProxyUrl);
    const isHttps = parsed.protocol === 'https:';
    const port = Number(parsed.port) || (isHttps ? 443 : 80);

    let tunnelSocket = null;
    if (proxyUrl && isHttps) {
        tunnelSocket = await openConnectTunnel(proxyUrl, parsed.hostname, port, remaining, maxVersion, deadline);
    }

    const requestUrl = (!isHttps && proxyUrl) ? proxyUrl : urlString;
    let reqParsed;
    try {
        reqParsed = new URL(requestUrl);
    } catch {
        tunnelSocket?.destroy();
        throw Object.assign(new Error('Invalid proxy URL'), { proxyError: Boolean(proxyUrl) });
    }
    const transport = reqParsed.protocol === 'https:' ? https : http;
    const requestOptions = {
        protocol: reqParsed.protocol,
        hostname: stripIpv6Brackets(reqParsed.hostname),
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
    const { extraTrustedOrigins, deadline = Date.now() + CHECK_BUDGET_MS } = options;
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
            try {
                currentUrl = new URL(response.location, currentUrl).href;
            } catch {
                throw new UpdateError('verification');
            }
            continue;
        }
        if (response.status >= 400) {
            throw new UpdateError('network', response.status === 407 ? 'proxy' : 'http', response.status);
        }
        if (response.status < 200 || response.status >= 300 || response.status === 204) {
            throw new UpdateError('network', 'http', response.status);
        }
        return { ...response, finalUrl: currentUrl };
    }
    throw new UpdateError('verification');
}

function parseChecksumFile(text, filename) {
    const matches = [];
    for (const rawLine of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
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
    if (!SHA_RE.test(sha)) throw new UpdateError('verification');
    const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? sanitizeText(decodeHtmlEntities(titleMatch[1]), 300) : '';
    return {
        sha,
        message: title,
        url: `${webBase}/${repo}/commit/${sha}`,
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

function isSymlink(targetPath) {
    const info = lstatSync(targetPath, { throwIfNoEntry: false });
    return Boolean(info?.isSymbolicLink());
}

function isValidPid(pid) {
    return Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        return true;
    }
}

async function removeLockOwner(lockPath, owner) {
    if (owner) {
        await retryFileOperation(() => unlink(join(lockPath, owner))).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
    // A newer contender may already have published a populated directory at lockPath.
    await rmdir(lockPath).catch(error => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
    });
}

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
                    if (isExcludedRuntimeSegment(item.name)) continue;
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

async function retryFileOperation(operation) {
    for (let attempt = 0; ; attempt++) {
        try {
            await operation();
            return;
        } catch (error) {
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === FILE_RETRY_DELAYS_MS.length) {
                throw error;
            }
            await new Promise(resolveTimer => setTimeout(resolveTimer, FILE_RETRY_DELAYS_MS[attempt]));
        }
    }
}

const JOURNAL_WINDOWS_RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function isSafeJournalRuntimePath(rel) {
    if (typeof rel !== 'string' || !rel || rel.length > 1024) return false;
    if (rel.includes('\\') || rel.includes(':') || rel.includes('\0') || rel.startsWith('/') || rel.endsWith('/')) {
        return false;
    }
    const parts = rel.split('/');
    for (const part of parts) {
        if (!part || part === '.' || part === '..') return false;
        if (part.replace(/[ .]+$/, '') !== part) return false;
        if (/[\x00-\x1f<>"|?*]/.test(part)) return false;
        if (JOURNAL_WINDOWS_RESERVED.has(part.split('.')[0].toUpperCase())) return false;
        if (isExcludedRuntimeSegment(part)) return false;
    }
    return parts.length >= 1;
}

async function ensureParentDir(targetPath, boundaryRoot = null) {
    const parent = dirname(targetPath);
    if (boundaryRoot) {
        const root = resolve(boundaryRoot);
        const resolvedParent = resolve(parent);
        const sep = process.platform === 'win32' ? '\\' : '/';
        const cmpRoot = process.platform === 'win32' ? root.toLowerCase() : root;
        const cmpParent = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
        if (cmpParent !== cmpRoot && !cmpParent.startsWith(cmpRoot + sep)) {
            throw new UpdateError('rollback');
        }
        if (cmpParent !== cmpRoot) {
            const relSegments = resolvedParent.slice(root.length + 1).split(/[\\/]/).filter(Boolean);
            let current = root;
            for (const segment of relSegments) {
                current = join(current, segment);
                const info = lstatSync(current, { throwIfNoEntry: false });
                if (info && !info.isDirectory()) {
                    await retryFileOperation(() => rm(current, { force: true }));
                }
            }
        }
    }
    await mkdir(parent, { recursive: true });
}

async function clearDirectoryConflict(targetPath) {
    const info = lstatSync(targetPath, { throwIfNoEntry: false });
    if (info?.isDirectory()) await removeEmptyRuntimeDirectory(targetPath);
}

async function removeEmptyRuntimeDirectory(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
        if (!entry.isDirectory() || isExcludedRuntimeSegment(entry.name)) {
            throw new UpdateError('install');
        }
        await removeEmptyRuntimeDirectory(join(path, entry.name));
    }
    await retryFileOperation(() => rmdir(path));
}

async function removeRuntimeFile(path) {
    try {
        const info = lstatSync(path, { throwIfNoEntry: false });
        if (info && !info.isDirectory()) await retryFileOperation(() => unlink(path));
    } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
}

async function writeAtomicFile(targetPath, content, boundaryRoot = null) {
    await ensureParentDir(targetPath, boundaryRoot);
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
        await writeFile(tempPath, content, { flag: 'wx' });
        await clearDirectoryConflict(targetPath);
        await retryFileOperation(() => rename(tempPath, targetPath));
    } finally {
        await rm(tempPath, { force: true }).catch(() => {});
    }
}

async function copyAtomicFile(sourcePath, targetPath, boundaryRoot = null) {
    await ensureParentDir(targetPath, boundaryRoot);
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
        await copyFile(sourcePath, tempPath);
        await clearDirectoryConflict(targetPath);
        await retryFileOperation(() => rename(tempPath, targetPath));
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
        let manifestRaw;
        try {
            manifestRaw = await readFile(join(this.pluginDir, 'plugin.json'), 'utf8');
        } catch (error) {
            if (['EACCES', 'EPERM', 'EBUSY'].includes(error?.code)) {
                throw new UpdateError('location', 'permission');
            }
            throw new UpdateError('location', 'install-location');
        }
        const manifest = parseJsonStrict(manifestRaw);
        if (manifest?.name !== PLUGIN_NAME || !parseSemver(manifest?.version)) {
            throw new UpdateError('verification');
        }
        let currentCommit = null;
        try {
            const sourceRaw = await readFile(join(this.pluginDir, '.install-source.json'), 'utf8');
            const source = parseJsonStrict(sourceRaw);
            if (source?.version === manifest.version && typeof source?.commit === 'string' && SHA_RE.test(source.commit)) {
                currentCommit = source.commit.toLowerCase();
            }
        } catch {}
        return { currentVersion: manifest.version, currentCommit };
    }

    inspectTargetEligibility() {
        try {
            if (existsSync(join(this.pluginDir, '.git'))) {
                return { canApply: false, reason: 'dev-workspace' };
            }
            if (isSymlink(this.pluginDir)) {
                return { canApply: false, reason: 'install-location' };
            }
            if (!this.allowCustomTarget) {
                if (!existsSync(this.expectedPluginDir) || isSymlink(this.expectedPluginDir)) {
                    return { canApply: false, reason: 'install-location' };
                }
                const actualReal = realpathSync(this.pluginDir);
                const expectedReal = realpathSync(this.expectedPluginDir);
                const samePath = process.platform === 'win32'
                    ? actualReal.toLowerCase() === expectedReal.toLowerCase()
                    : actualReal === expectedReal;
                if (!samePath) {
                    return { canApply: false, reason: 'install-location' };
                }
            }
            return { canApply: true, reason: null };
        } catch {
            return { canApply: false, reason: 'install-location' };
        }
    }

    async hasInterruptedTransactions() {
        try {
            const entries = await readdir(this.updatesDir, { withFileTypes: true });
            return entries.some(entry => entry.isDirectory() && entry.name.startsWith('tx-'));
        } catch (error) {
            return error?.code !== 'ENOENT';
        }
    }

    async initializeLocalInfo() {
        let target = { canApply: false, reason: 'install-location' };
        try {
            target = this.inspectTargetEligibility();
            if (target.canApply && await this.hasInterruptedTransactions()) {
                let lock = null;
                try {
                    lock = await this.acquireUpdateLock();
                    await this.recoverInterruptedTransactions();
                } catch {
                    // Best-effort startup recovery: never block initialization
                } finally {
                    if (lock) await lock.release();
                }
            }
        } catch {}
        try {
            const local = await this.readLocalState();
            this.state.currentVersion = local.currentVersion;
            this.state.currentCommit = local.currentCommit;
            this.state.canApply = target.canApply;
            this.state.applyDisabledReason = target.reason || undefined;
        } catch {}
        return this.publicState();
    }

    createCycleProxyResolver() {
        if (this.proxyResolver !== resolveSystemProxy) {
            return this.proxyResolver;
        }
        let winProxyPromise = null;
        const cachedWindowsReader = () => {
            if (!winProxyPromise) winProxyPromise = readWindowsProxy();
            return winProxyPromise;
        };
        return targetUrl => resolveSystemProxy(targetUrl, process.env, cachedWindowsReader);
    }

    fetchOptions(deadline, extra = {}) {
        return {
            extraTrustedOrigins: this.extraTrustedOrigins,
            proxyResolver: this.proxyResolver,
            deadline,
            ...extra,
        };
    }

    async tryFetchLatestRelease(currentVersion, deadline, proxyResolver = this.proxyResolver) {
        const { apiBase, webBase, codeloadBase } = this.endpoints;
        const apiUrl = `${apiBase}/repos/${this.repo}/releases/latest`;
        try {
            const res = await fetchTrusted(apiUrl, this.fetchOptions(Math.min(deadline, Date.now() + 10000), {
                proxyResolver,
                headers: { Accept: 'application/vnd.github+json' },
                maxBytes: MAX_METADATA_BYTES,
            }));
            const release = parseJsonStrict(res.body.toString('utf8'));
            if (!release || typeof release !== 'object' || Array.isArray(release)) {
                throw new UpdateError('verification');
            }
            if (release.draft || release.prerelease) return null;
            const rawTag = String(release.tag_name || '').trim();
            const versionMatch = rawTag.match(/^v?(\d+\.\d+\.\d+)$/);
            if (!versionMatch || !parseSemver(versionMatch[1])) throw new UpdateError('verification');
            const latestVersion = versionMatch[1];
            const assets = Array.isArray(release.assets) ? release.assets : [];
            const zipAsset = this.selectPreferredZip(assets, latestVersion, item => item?.name);
            const shaAsset = zipAsset ? assets.find(item => item?.name === `${zipAsset.name}.sha256`) : null;
            if ((zipAsset && !this.isTrustedDownloadAsset(zipAsset.browser_download_url)) ||
                (shaAsset && !this.isTrustedDownloadAsset(shaAsset.browser_download_url))) {
                throw new UpdateError('verification');
            }
            const hasPair = Boolean(zipAsset && shaAsset);
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
            if (error?.detail === 'certificate') throw error;
            if (error instanceof UpdateError && error.code === 'verification') throw error;
            if (error?.statusCode !== undefined && ![403, 429].includes(error.statusCode)) throw error;
        }

        // Fallback to public HTML page when API hits 403/429 rate-limit or transient API block.
        const htmlRes = await fetchTrusted(`${webBase}/${this.repo}/releases/latest`, this.fetchOptions(deadline, {
            proxyResolver,
            headers: { Accept: 'text/html' },
            maxBytes: MAX_METADATA_BYTES,
        }));
        const finalPath = new URL(htmlRes.finalUrl).pathname.replace(/\/+$/, '');
        if (finalPath === `/${this.repo}/releases`) return null;
        const tagPrefix = `/${this.repo}/releases/tag/`;
        if (!finalPath.startsWith(tagPrefix)) throw new UpdateError('verification');
        let rawTag;
        try {
            rawTag = decodeURIComponent(finalPath.slice(tagPrefix.length));
        } catch {
            throw new UpdateError('verification');
        }
        const versionMatch = rawTag.match(/^v?(\d+\.\d+\.\d+)$/);
        if (!versionMatch || !parseSemver(versionMatch[1])) throw new UpdateError('verification');
        const latestVersion = versionMatch[1];

        let zipAsset = null;
        let shaAsset = null;
        if (compareSemver(latestVersion, currentVersion) > 0) {
            try {
                const expandedRes = await fetchTrusted(`${webBase}/${this.repo}/releases/expanded_assets/${encodeURIComponent(rawTag)}`, this.fetchOptions(deadline, {
                    proxyResolver,
                    headers: { Accept: 'text/html' },
                    maxBytes: MAX_METADATA_BYTES,
                }));
                const expandedHtml = decodeHtmlEntities(expandedRes.body.toString('utf8'));
                const hrefs = [...expandedHtml.matchAll(/href="([^"]*\/releases\/download\/[^"]+)"/g)].map(m => m[1]);
                const resolvedAssets = hrefs.map(href => {
                    try {
                        return new URL(href, webBase).href;
                    } catch {
                        throw new UpdateError('verification');
                    }
                });
                const zipUrls = resolvedAssets.filter(href => href.toLowerCase().endsWith('.zip'));
                const chosenZip = this.selectPreferredZip(zipUrls, latestVersion, url => url.split('/').pop());
                const chosenSha = chosenZip ? resolvedAssets.find(href => href === `${chosenZip}.sha256`) : null;
                if (chosenZip && !this.isTrustedDownloadAsset(chosenZip)) throw new UpdateError('verification');
                if (chosenZip && chosenSha) {
                    zipAsset = chosenZip;
                    shaAsset = chosenSha;
                }
            } catch (error) {
                if (error?.statusCode !== 404) throw error;
            }
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

    selectPreferredZip(items, latestVersion, getName) {
        const zips = items.filter(item => {
            const name = getName(item);
            return typeof name === 'string' && name.toLowerCase().endsWith('.zip');
        });
        const preferredNames = [
            `antigravity-background-${latestVersion}.zip`,
            `antigravity-ui-${latestVersion}.zip`,
        ];
        for (const preferred of preferredNames) {
            const match = zips.find(item => getName(item).toLowerCase() === preferred);
            if (match) return match;
        }
        return zips.length === 1 ? zips[0] : null;
    }

    async fetchManifestAtUrls(urls, deadline, proxyResolver) {
        let lastError = null;
        for (let i = 0; i < urls.length; i++) {
            try {
                const res = await fetchTrusted(urls[i], this.fetchOptions(deadline, {
                    proxyResolver,
                    maxBytes: 65536,
                }));
                return res.body;
            } catch (error) {
                if (error?.detail === 'certificate') throw error;
                if (error instanceof UpdateError && error.code === 'verification') throw error;
                lastError = error;
            }
        }
        throw lastError;
    }

    async fetchMainBranchInfo(deadline, proxyResolver = this.proxyResolver) {
        const { apiBase, webBase, rawBase, codeloadBase } = this.endpoints;

        // Fetch commit SHA first so plugin.json can be pinned to the exact commit (eliminates raw CDN race).
        let commitInfo = null;
        try {
            const res = await fetchTrusted(`${apiBase}/repos/${this.repo}/commits/main`, this.fetchOptions(Math.min(deadline, Date.now() + 10000), {
                proxyResolver,
                headers: { Accept: 'application/vnd.github+json' },
                maxBytes: MAX_METADATA_BYTES,
            }));
            const commit = parseJsonStrict(res.body.toString('utf8'));
            if (typeof commit?.sha !== 'string' || !SHA_RE.test(commit.sha)) {
                throw new UpdateError('verification');
            }
            commitInfo = {
                sha: commit.sha.toLowerCase(),
                message: sanitizeText(commit.commit?.message || ''),
                url: `${webBase}/${this.repo}/commit/${commit.sha.toLowerCase()}`,
            };
        } catch (error) {
            if (error?.detail === 'certificate') throw error;
            if (error instanceof UpdateError && error.code === 'verification') throw error;
            if (error?.statusCode !== undefined && ![403, 429].includes(error.statusCode)) throw error;
        }

        if (!commitInfo) {
            const atomRes = await fetchTrusted(`${webBase}/${this.repo}/commits/main.atom`, this.fetchOptions(deadline, {
                proxyResolver,
                headers: { Accept: 'application/atom+xml, application/xml, text/xml' },
                maxBytes: MAX_METADATA_BYTES,
            }));
            commitInfo = parseAtomLatestCommit(atomRes.body.toString('utf8'), this.repo, webBase);
        }

        let manifestBody;
        try {
            manifestBody = await this.fetchManifestAtUrls([
                `${rawBase}/${this.repo}/${commitInfo.sha}/plugin.json`,
                `${webBase}/${this.repo}/raw/${commitInfo.sha}/plugin.json`,
            ], deadline, proxyResolver);
        } catch (error) {
            if (error?.statusCode !== 404) throw error;
            manifestBody = await this.fetchManifestAtUrls([
                `${rawBase}/${this.repo}/main/plugin.json`,
                `${webBase}/${this.repo}/raw/refs/heads/main/plugin.json`,
            ], deadline, proxyResolver);
        }

        const manifest = parseJsonStrict(manifestBody.toString('utf8'));
        if (manifest?.name !== PLUGIN_NAME || !parseSemver(manifest?.version)) {
            throw new UpdateError('verification');
        }
        const latestVersion = manifest.version;

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
                const proxyResolver = this.createCycleProxyResolver();
                let remote = await this.tryFetchLatestRelease(currentVersion, deadline, proxyResolver);
                if (!remote) remote = await this.fetchMainBranchInfo(deadline, proxyResolver);

                const cmp = compareSemver(remote.latestVersion, currentVersion);
                let hasUpdate = false;
                let updateReason = null;
                if (cmp > 0) {
                    hasUpdate = true;
                    updateReason = 'version';
                } else if (cmp === 0 && remote.sourceKind === 'main' && currentCommit && remote.latestCommit && currentCommit !== remote.latestCommit) {
                    // Published releases are authoritative over same-version main commits.
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
                let classified;
                if (error instanceof UpdateError) {
                    classified = error;
                } else if (['EACCES', 'EPERM', 'EBUSY'].includes(error?.code)) {
                    classified = new UpdateError('location', 'permission');
                } else if (error instanceof SyntaxError) {
                    classified = new UpdateError('verification');
                } else {
                    classified = classifyNetworkError(error);
                }
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
                applyDisabledReason: target.reason || 'install-location',
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
                let err;
                if (error instanceof UpdateError) {
                    err = error;
                } else if (['EACCES', 'EPERM', 'EBUSY'].includes(error?.code)) {
                    err = new UpdateError('install', 'permission');
                } else if (error instanceof SyntaxError) {
                    err = new UpdateError('verification');
                } else {
                    err = new UpdateError('install');
                }
                this.state = {
                    ...this.state,
                    state: 'error',
                    progress: undefined,
                    error: ALLOWED_ERROR_CODES.has(err.code) ? err.code : 'install',
                    errorDetail: err.detail,
                };
            })
            .finally(() => { this.job = null; });

        return this.publicState();
    }

    async recoverUpdateLock(lockPath) {
        try {
            const info = lstatSync(lockPath, { throwIfNoEntry: false });
            if (!info) return;
            if (info.isDirectory()) {
                const owners = await readdir(lockPath);
                const owner = owners[0];
                const pid = Number(LOCK_OWNER_RE.exec(owner || '')?.[1]);
                if (owners.length > 1 || (owner && (!isValidPid(pid) || isPidAlive(pid)))) {
                    throw new UpdateError('busy');
                }
                await removeLockOwner(lockPath, owner);
                return;
            }
            // A legacy process can still hold this file while it edits the installation.
            throw new UpdateError('busy', 'legacy-lock');
        } catch (error) {
            if (error.code === 'ENOENT') return;
            // Windows can temporarily report EPERM while another contender deletes the old lock.
            if (['EISDIR', 'EPERM', 'EBUSY'].includes(error.code)) {
                throw new UpdateError('busy');
            }
            throw error;
        }
    }

    async acquireUpdateLock() {
        const lockPath = join(dirname(this.pluginDir), `.${PLUGIN_NAME}-update.lock`);
        const cliLockPath = join(this.home, '.gemini', 'config', `config.json.${PLUGIN_NAME}.lock`);
        if (lstatSync(cliLockPath, { throwIfNoEntry: false })) {
            throw new UpdateError('busy');
        }
        const token = randomUUID();
        const owner = `owner-${process.pid}-${token}`;
        const stagedLock = `${lockPath}.${token}.tmp`;
        await this.recoverUpdateLock(lockPath);
        try {
            await mkdir(stagedLock);
            await writeFile(join(stagedLock, owner), '', { flag: 'wx' });
            // Publish a populated directory in one operation. Empty-directory cleanup can
            // never delete a new owner, even if another process already recovered the old one.
            await rename(stagedLock, lockPath);
        } catch (error) {
            await removeLockOwner(stagedLock, owner).catch(() => {});
            if (lstatSync(lockPath, { throwIfNoEntry: false }) ||
                ['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
                throw new UpdateError('busy');
            }
            throw new UpdateError('install', ['EACCES', 'EPERM', 'EBUSY'].includes(error?.code) ? 'permission' : undefined);
        }
        if (lstatSync(cliLockPath, { throwIfNoEntry: false })) {
            await removeLockOwner(lockPath, owner).catch(() => {});
            throw new UpdateError('busy');
        }
        return { release: () => removeLockOwner(lockPath, owner) };
    }

    async performInstall(plan) {
        const deadline = Date.now() + APPLY_BUDGET_MS;
        await mkdir(this.updatesDir, { recursive: true });
        const lock = await this.acquireUpdateLock();
        const proxyResolver = this.createCycleProxyResolver();

        const txDir = join(this.updatesDir, `tx-${randomUUID()}`);
        let keepTxDir = false;
        let installFailed = false;
        try {
            await this.recoverInterruptedTransactions();
            const local = await this.readLocalState();
            if (local.currentVersion !== plan.currentVersion || local.currentCommit !== plan.currentCommit) {
                throw new UpdateError('verification', 'plan-expired');
            }
            let expectedSha256 = null;
            if (plan.packageKind === 'release-zip' && plan.checksumUrl) {
                this.state = { ...this.state, progress: { phase: 'verify' } };
                const shaRes = await fetchTrusted(plan.checksumUrl, this.fetchOptions(deadline, { proxyResolver, maxBytes: 8192 }));
                expectedSha256 = parseChecksumFile(shaRes.body.toString('utf8'), plan.archiveName);
            }

            this.state = { ...this.state, progress: { phase: 'download', received: 0, total: plan.size || undefined } };
            const archiveRes = await fetchTrusted(plan.url, this.fetchOptions(deadline, {
                proxyResolver,
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
                const stagedSet = new Set(stagedFiles.map(item => item.toLowerCase()));
                for (const oldRel of oldFiles) {
                    if (!stagedSet.has(oldRel.toLowerCase())) {
                        await removeRuntimeFile(join(this.pluginDir, ...oldRel.split('/')));
                    }
                }
                for (const rel of stagedFiles) {
                    await copyAtomicFile(
                        join(stageDir, ...rel.split('/')),
                        join(this.pluginDir, ...rel.split('/')),
                        this.pluginDir
                    );
                }
                const sourceMeta = {
                    repo: this.repo,
                    channel: plan.sourceKind,
                    version: plan.expectedVersion,
                    commit: plan.latestCommit || null,
                    tag: plan.tag || null,
                    updatedAt: new Date(this.now()).toISOString(),
                };
                await writeAtomicFile(oldSourcePath, JSON.stringify(sourceMeta, null, 2) + '\n', this.pluginDir);

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
                try {
                    await this.restoreBackupSnapshot(backupDir, journalPath, journal);
                } catch (rollbackError) {
                    keepTxDir = true;
                    throw rollbackError;
                }
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
        } catch (error) {
            installFailed = true;
            throw error;
        } finally {
            if (!keepTxDir) {
                await rm(txDir, { recursive: true, force: true }).catch(() => {});
            }
            await lock.release().catch(error => {
                if (!installFailed) throw error;
            });
        }
    }

    async restoreBackupSnapshot(backupDir, journalPath, journal) {
        if (!Array.isArray(journal?.oldFiles) || !Array.isArray(journal?.stagedFiles) ||
            journal.oldFiles.some(rel => !isSafeJournalRuntimePath(rel)) ||
            journal.stagedFiles.some(rel => !isSafeJournalRuntimePath(rel))) {
            throw new UpdateError('rollback');
        }
        const failures = [];
        const oldSet = new Set(journal.oldFiles.map(item => item.toLowerCase()));
        for (const stagedRel of journal.stagedFiles) {
            if (!oldSet.has(stagedRel.toLowerCase())) {
                try {
                    await removeRuntimeFile(join(this.pluginDir, ...stagedRel.split('/')));
                } catch (error) {
                    failures.push({ rel: stagedRel, error });
                }
            }
        }
        for (const rel of journal.oldFiles) {
            try {
                const src = join(backupDir, ...rel.split('/'));
                const dst = join(this.pluginDir, ...rel.split('/'));
                const [srcHash, dstHash] = await Promise.all([fileSha256(src), fileSha256(dst)]);
                if (srcHash && srcHash === dstHash) continue;
                await copyAtomicFile(src, dst, this.pluginDir);
            } catch (error) {
                failures.push({ rel, error });
            }
        }
        const sourceMetaPath = join(this.pluginDir, '.install-source.json');
        try {
            if (journal.hadSourceMeta) {
                await copyAtomicFile(join(backupDir, '.install-source.json'), sourceMetaPath, this.pluginDir);
            } else {
                await rm(sourceMetaPath, { force: true });
            }
        } catch (error) {
            failures.push({ rel: '.install-source.json', error });
        }
        if (failures.length > 0) {
            throw new UpdateError('rollback');
        }
        try {
            await writeAtomicFile(journalPath, JSON.stringify({ ...journal, phase: 'restored' }));
        } catch {
            throw new UpdateError('rollback');
        }
    }

    async recoverInterruptedTransactions() {
        const entries = await readdir(this.updatesDir, { withFileTypes: true }).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw new UpdateError('rollback');
        });
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('tx-')) continue;
            const txDir = join(this.updatesDir, entry.name);
            const journalPath = join(txDir, 'journal.json');
            let journal;
            try {
                journal = parseJsonStrict(await readFile(journalPath, 'utf8'));
            } catch (error) {
                if (error.code === 'ENOENT') {
                    await rm(txDir, { recursive: true, force: true }).catch(() => {});
                    continue;
                }
                throw new UpdateError('rollback');
            }
            if (journal?.phase === 'committed' || journal?.phase === 'restored') {
                await rm(txDir, { recursive: true, force: true }).catch(() => {});
                continue;
            }
            if (journal?.phase !== 'installing' || !Array.isArray(journal.oldFiles) || !Array.isArray(journal.stagedFiles) ||
                journal.oldFiles.some(rel => !isSafeJournalRuntimePath(rel)) ||
                journal.stagedFiles.some(rel => !isSafeJournalRuntimePath(rel))) {
                throw new UpdateError('rollback');
            }
            await this.restoreBackupSnapshot(join(txDir, 'backup'), journalPath, journal);
            await rm(txDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    requestReload() {
        if (this.state.state === 'reloading') return this.publicState();
        if (this.state.state !== 'installed' || !this.onReload) throw new UpdateError('verification');
        this.state = { ...this.state, state: 'reloading', error: undefined, errorDetail: undefined };
        const timer = setTimeout(() => {
            Promise.resolve()
                .then(() => this.onReload())
                .catch(() => {
                    if (this.state.state === 'reloading') {
                        this.state = {
                            ...this.state,
                            state: 'error',
                            progress: undefined,
                            error: 'install',
                            errorDetail: undefined,
                        };
                    }
                });
        }, 350);
        timer.unref?.();
        return this.publicState();
    }
}
