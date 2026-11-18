import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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
    const binary = await readFile(executable);
    const marker = binary.indexOf('export class SidecarApp');
    const start = binary.lastIndexOf("import { execFileSync } from 'node:child_process';", marker);
    const ending = 'return provided === this.#token;\n  }\n}\n';
    const end = binary.indexOf(ending, marker);
    const bridge = binary.indexOf('window.sidecar =');
    const inner = binary.lastIndexOf('(function() {', bridge);
    const outer = binary.lastIndexOf('(function() {', inner - 1);
    const preloadEnd = binary.indexOf('\n})();', bridge);
    if (marker < 0 || start < 0 || end < marker || end - start > 40000 ||
        outer < 0 || bridge - outer > 40000 || preloadEnd < bridge) {
        throw new Error('无法识别此版本的 Sidecar SDK。');
    }
    const sdk = binary.toString('utf8', start, end + Buffer.byteLength(ending));
    const preload = binary.toString('utf8', outer, preloadEnd + 6);
    if (!/const BIND_HOST = ['"]127\.0\.0\.1['"]/.test(sdk) ||
        !sdk.includes('server.listen(this.#port, BIND_HOST') ||
        !preload.startsWith('(function() {\n  // Extract configuration')) {
        throw new Error('Sidecar SDK 的本机监听或界面资源不兼容。');
    }
    const digest = createHash('sha256').update(sdk + preload).digest('hex');
    const directory = join(dataDirectory, 'sdk', digest);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'preload.js'), preload);
    await writeFile(join(directory, 'index.mjs'), sdk);
    return import(pathToFileURL(join(directory, 'index.mjs')).href);
}
