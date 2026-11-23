import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { open, readFile, mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MAX_SDK_BYTES = 40000;
const MAX_PRELOAD_BYTES = 40000;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const SCAN_OVERLAP_BYTES = 64 * 1024;
const SDK_IMPORT_MARKER = "import { execFileSync } from 'node:child_process';";
const SDK_CLASS_MARKER = 'export class SidecarApp';
const SDK_ENDING = 'return provided === this.#token;\n  }\n}\n';
const SDK_ENDING_BYTES = Buffer.byteLength(SDK_ENDING);
const PRELOAD_BRIDGE_MARKER = 'window.sidecar =';
const PRELOAD_IIFE_MARKER = '(function() {';
const PRELOAD_END_MARKER = '\n})();';
const SHA256_RE = /^[0-9a-f]{64}$/;

async function renameWithRetry(from, to, attempts = 5) {
    for (let attempt = 1; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            if (attempt >= attempts || !RETRYABLE_RENAME_CODES.has(error?.code)) throw error;
            await new Promise(done => setTimeout(done, 25 * attempt));
        }
    }
}

async function writeAtomic(target, content) {
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temporary, content, { flag: 'wx' });
        await renameWithRetry(temporary, target);
    } finally {
        await rm(temporary, { force: true }).catch(() => {});
    }
}

async function readCachedFile(path, maxBytes) {
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.size > maxBytes) throw new Error('Sidecar SDK 缓存文件无效。');
    return readFile(path);
}

async function extractEmbeddedSdk(executablePath) {
    let sdk;
    let preload;
    const handle = await open(executablePath, 'r');
    try {
        const readBuffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
        let tail = Buffer.alloc(0);
        while (true) {
            const { bytesRead } = await handle.read(readBuffer, 0, SCAN_CHUNK_BYTES, null);
            if (bytesRead === 0) break;
            const chunk = readBuffer.subarray(0, bytesRead);
            const window = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;

            if (!sdk) {
                const marker = window.indexOf(SDK_CLASS_MARKER);
                if (marker > 0) {
                    const start = window.lastIndexOf(SDK_IMPORT_MARKER, marker);
                    const end = window.indexOf(SDK_ENDING, marker);
                    if (start >= 0 && start < marker && end >= marker && end - start <= MAX_SDK_BYTES) {
                        sdk = window.toString('utf8', start, end + SDK_ENDING_BYTES);
                    }
                }
            }

            if (!preload) {
                const bridge = window.indexOf(PRELOAD_BRIDGE_MARKER);
                if (bridge > 0) {
                    const inner = window.lastIndexOf(PRELOAD_IIFE_MARKER, bridge);
                    const outer = inner > 0 ? window.lastIndexOf(PRELOAD_IIFE_MARKER, inner - 1) : -1;
                    const preloadEnd = window.indexOf(PRELOAD_END_MARKER, bridge);
                    if (inner > 0 && outer >= 0 && outer < inner && inner < bridge &&
                        preloadEnd > bridge && preloadEnd - outer <= MAX_PRELOAD_BYTES) {
                        preload = window.toString('utf8', outer, preloadEnd + 6);
                    }
                }
            }

            if (sdk && preload) break;
            tail = window.length > SCAN_OVERLAP_BYTES
                ? Buffer.from(window.subarray(window.length - SCAN_OVERLAP_BYTES))
                : Buffer.from(window);
        }
    } finally {
        await handle.close();
    }

    if (!sdk || !preload) {
        throw new Error('无法识别此版本的 Sidecar SDK。');
    }
    return { sdk, preload };
}

export async function loadSdk(executable, dataDirectory) {
    try {
        return await import('sidecar_sdk');
    } catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    try {
        const path = createRequire(import.meta.url).resolve('sidecar_sdk');
        return await import(pathToFileURL(path).href);
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
    // Some Windows builds expose the SDK as embedded resources without an ESM resolver.
    // Recover the installed resources into plugin-owned data, including the outer IIFE.
    const executablePath = resolve(executable);
    const info = await stat(executablePath);
    const sdkRoot = join(dataDirectory, 'sdk');
    const cachePath = join(sdkRoot, 'cache.json');
    try {
        const cached = JSON.parse(await readFile(cachePath, 'utf8'));
        if (cached && typeof cached === 'object' &&
            cached.executable === executablePath &&
            cached.size === info.size &&
            cached.mtimeMs === info.mtimeMs &&
            typeof cached.digest === 'string' &&
            SHA256_RE.test(cached.digest)) {
            const cachedDir = join(sdkRoot, cached.digest);
            const cachedIndex = join(cachedDir, 'index.mjs');
            const cachedPreload = join(cachedDir, 'preload.js');
            const [cachedSdk, preload] = await Promise.all([
                readCachedFile(cachedIndex, MAX_SDK_BYTES + 64),
                readCachedFile(cachedPreload, MAX_PRELOAD_BYTES + 8),
            ]);
            if (createHash('sha256').update(cachedSdk).update('\0').update(preload).digest('hex') === cached.digest) {
                return import(pathToFileURL(cachedIndex).href);
            }
        }
    } catch {
        // Cache miss or corrupted cache manifest; fall through to re-extract from executable.
    }

    const { sdk, preload } = await extractEmbeddedSdk(executablePath);
    if (!/const BIND_HOST = ['"]127\.0\.0\.1['"]/.test(sdk) ||
        !sdk.includes('server.listen(this.#port, BIND_HOST') ||
        !preload.startsWith('(function() {\n  // Extract configuration')) {
        throw new Error('Sidecar SDK 的本机监听或界面资源不兼容。');
    }
    const digest = createHash('sha256').update(sdk).update('\0').update(preload).digest('hex');
    const directory = join(sdkRoot, digest);
    await mkdir(directory, { recursive: true });
    const preloadPath = join(directory, 'preload.js');
    const indexPath = join(directory, 'index.mjs');
    await writeAtomic(preloadPath, preload);
    await writeAtomic(indexPath, sdk);
    await writeAtomic(cachePath, JSON.stringify({
        executable: executablePath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        digest,
    }));
    return import(pathToFileURL(indexPath).href);
}
