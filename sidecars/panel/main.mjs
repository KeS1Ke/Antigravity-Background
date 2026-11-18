import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSdk } from './sdk.mjs';
import { WallpaperRuntime } from './runtime.mjs';
import { InvalidSettingsError, SettingsStore } from './store.mjs';
import appearance from '../../plugin/appearance.cjs';

const directory = dirname(fileURLToPath(import.meta.url));
const profile = process.env.AG_UI_PROFILE || join(homedir(), 'AppData', 'Roaming', 'Antigravity');
const data = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'antigravity-ui', 'panel', 'data');
const resources = process.env.AG_UI_RESOURCES || join(homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'resources');
const { SidecarApp, Response } = await loadSdk(join(resources, 'bin', 'language_server.exe'), data);
const store = new SettingsStore(data, profile);
const configPath = join(homedir(), '.gemini', 'config', 'config.json');
const enabled = async () => {
    try {
        const configuration = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
        return configuration.plugins?.['antigravity-ui']?.enabled !== false &&
            configuration.sidecars?.['antigravity-ui/panel']?.enabled !== false;
    } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error;
    }
};
const lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
const hostPort = new URL(lsAddress.includes('://') ? lsAddress : 'https://' + lsAddress).port;
const digestCache = new Map();
function imageDigest(image) {
    if (!image) return '';
    let digest = digestCache.get(image);
    if (!digest) {
        if (digestCache.size >= 4) digestCache.clear();
        digest = createHash('sha256').update(image).digest('hex');
        digestCache.set(image, digest);
    }
    return digest;
}
function sameSettings(a, b, ignoreTheme = false) {
    for (const key of Object.keys(a)) {
        if (ignoreTheme && key === 'theme') continue;
        if (a[key] !== b[key]) return false;
    }
    return true;
}
function resolveImage(input, saved) {
    if (input?.image !== undefined || typeof input?.imageHash !== 'string') return input;
    for (const candidate of [draft?.image, saved.image]) {
        if (candidate !== undefined && imageDigest(candidate) === input.imageHash) {
            return { ...input, image: candidate };
        }
    }
    return null;
}
function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { contentType: 'application/json', status });
}
let draft;
let settingsError;
let pendingActivate = false;
let requests = Promise.resolve();
function enqueueRequest(task) {
    const operation = requests.then(task);
    requests = operation.catch(() => {});
    return operation;
}
async function syncStore() {
    let reloaded;
    try {
        reloaded = await store.reloadIfChanged();
        settingsError = undefined;
    } catch (error) {
        if (!(error instanceof InvalidSettingsError)) throw error;
        settingsError = error.message;
        return false;
    }
    if (!reloaded) return false;
    draft = undefined;
    pendingActivate = true;
    return true;
}
async function activateRuntime(discover) {
    pendingActivate = false;
    await runtime.update(true, discover);
}
function stateResponse(extra = {}) {
    const active = draft || store.settings;
    return {
        settings: active,
        ...extra,
        hasDraft: Boolean(draft),
        imageHash: imageDigest(active.image),
        runtime: settingsError ? { ...runtime.health, error: settingsError } : runtime.health,
    };
}
const runtime = new WallpaperRuntime(profile, () => {
    const settings = draft || store.settings;
    const {
        sidebarCover, sidebarOpacity, sidebarBlur,
        composerCover, composerOpacity, composerBlur, composerOuterColor, composerInnerColor,
        bubbleCover, bubbleOpacity, bubbleBlur, bubbleOuterColor, bubbleInnerColor,
        overviewSync, overviewCover, overviewOpacity, overviewBlur, overviewOuterColor, overviewInnerColor,
    } = settings;
    return {
        enabled: settings.enabled,
        css: appearance.wallpaperStyle(settings, 'var(--ag-ui-image)'),
        image: settings.image,
        imageHash: imageDigest(settings.image),
        surfaces: {
            sidebarCover, sidebarOpacity, sidebarBlur,
            composerCover, composerOpacity, composerBlur, composerOuterColor, composerInnerColor,
            bubbleCover, bubbleOpacity, bubbleBlur, bubbleOuterColor, bubbleInnerColor,
            overviewSync, overviewCover, overviewOpacity, overviewBlur, overviewOuterColor, overviewInnerColor,
        },
    };
}, enabled, hostPort);
const app = new SidecarApp();
const files = {
    '/': ['index.html', 'text/html'],
    '/app.js': ['app.js', 'text/javascript'],
    '/styles.css': ['styles.css', 'text/css'],
    '/appearance.js': ['../../plugin/appearance.cjs', 'text/javascript'],
};
for (const [route, [path, type]] of Object.entries(files)) {
    app.api(route, async () => new Response(await readFile(join(directory, path)), {
        contentType: type + '; charset=utf-8',
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    }), 'GET');
}
app.api('/api/settings', () => enqueueRequest(async () => {
    const reloaded = await syncStore();
    if (reloaded || pendingActivate) await activateRuntime(true);
    return stateResponse({ saved: store.settings });
}), 'GET');
app.api('/api/preview', input => enqueueRequest(async () => {
    const reloaded = await syncStore();
    const saved = store.settings;
    const resolved = resolveImage(input, saved);
    if (resolved === null && input !== null) return jsonResponse(409, { error: '图片缓存未命中，请重新同步。', code: 'IMAGE_CACHE_MISS' });
    let next;
    try {
        next = appearance.normalize(resolved);
    } catch (error) {
        return jsonResponse(400, { error: error.message });
    }
    const previous = draft || saved;
    draft = sameSettings(next, saved) ? undefined : next;
    if (reloaded || pendingActivate || !sameSettings(previous, next, true) || runtime.dirty) {
        await activateRuntime(reloaded || pendingActivate);
    }
    return stateResponse();
}), 'POST');
app.api('/api/preview/discard', () => enqueueRequest(async () => {
    const previous = draft || store.settings;
    const reloaded = await syncStore();
    const saved = store.settings;
    draft = undefined;
    if (reloaded || pendingActivate || !sameSettings(previous, saved, true) || runtime.dirty) {
        await activateRuntime(true);
    }
    return stateResponse();
}), 'POST');
app.api('/api/settings', input => enqueueRequest(async () => {
    await syncStore();
    const resolved = resolveImage(input, store.settings);
    if (resolved === null && input !== null) return jsonResponse(409, { error: '图片缓存未命中，请重新同步。', code: 'IMAGE_CACHE_MISS' });
    if (settingsError && (!resolved || !Object.keys(store.settings).every(key => Object.hasOwn(resolved, key)))) {
        return jsonResponse(400, { error: settingsError });
    }
    try {
        await store.save(resolved);
        settingsError = undefined;
        draft = undefined;
        await activateRuntime(true);
        return stateResponse();
    } catch (error) {
        return jsonResponse(400, { error: error.message });
    }
}), 'POST');
await syncStore();
await app.run();
let heartbeatPending = false;
runtime.start(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    void enqueueRequest(async () => {
        await syncStore();
        await runtime.update(false, true);
    }).catch(error => {
        runtime.health = { ...runtime.health, error: error.message };
    }).finally(() => { heartbeatPending = false; });
});
let exiting = false;
async function shutdown() {
    if (exiting) return;
    exiting = true;
    const timer = setTimeout(() => process.exit(0), 4000);
    timer.unref();
    await runtime.stop();
    await app.close();
    process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
