import { open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSdk } from './sdk.mjs';
import { WallpaperRuntime } from './runtime.mjs';
import { InvalidSettingsError, SettingsStore } from './store.mjs';
import appearance from '../../plugin/appearance.cjs';

function releaseRuntimeDirectory(rootDir) {
    if (process.platform !== 'win32') return false;
    const root = win32.resolve(rootDir);
    const current = win32.resolve(process.cwd());
    for (const segment of ['assets', 'plugin', 'sidecars']) {
        const relative = win32.relative(win32.join(root, segment), current);
        if (relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative))) {
            process.chdir(root);
            return true;
        }
    }
    return false;
}

const directory = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(directory, '..', '..');
try { releaseRuntimeDirectory(pluginDir); } catch {}
const home = process.env.AG_UI_HOME || homedir();
const profile = process.env.AG_UI_PROFILE || join(home, 'AppData', 'Roaming', 'Antigravity');
const data = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    join(home, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-ui', 'panel', 'data');
const resources = process.env.AG_UI_RESOURCES || join(home, 'AppData', 'Local', 'Programs', 'antigravity', 'resources');
const installation = process.env.AG_UI_INSTALLATION ||
    (basename(process.execPath).toLowerCase() === 'antigravity.exe' ? dirname(process.execPath) : dirname(resources));
const shortcutBackup = join(home, '.gemini', 'config', 'antigravity-ui.shortcuts.bak.json');
const store = new SettingsStore(data, profile);
const configPath = join(home, '.gemini', 'config', 'config.json');
let configSignature;
let configEnabled = true;
const enabled = async () => {
    try {
        const info = await stat(configPath);
        const signature = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
        if (signature === configSignature) return configEnabled;
        const configuration = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
        configEnabled = configuration.plugins?.['antigravity-ui']?.enabled !== false &&
            configuration.sidecars?.['antigravity-ui/panel']?.enabled !== false;
        configSignature = signature;
        return configEnabled;
    } catch (error) {
        if (error.code === 'ENOENT') {
            configSignature = 'ENOENT';
            configEnabled = true;
            return true;
        }
        configSignature = undefined;
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
let app;
let SdkResponse;
let exiting = false;
async function shutdown() {
    if (exiting) return;
    exiting = true;
    const timer = setTimeout(() => process.exit(0), 4000);
    timer.unref();
    await runtime.stop();
    await app?.close();
    process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

function jsonResponse(status, body) {
    return new SdkResponse(JSON.stringify(body), { contentType: 'application/json', status });
}
function updateErrorResponse(error) {
    if (['verification', 'location', 'busy', 'install', 'rollback', 'network'].includes(error?.code)) {
        return jsonResponse(400, { error: error.code, code: error.code, errorDetail: error.detail });
    }
    return jsonResponse(500, { error: 'install', code: 'install' });
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
async function syncStore({ initial = false } = {}) {
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
    if (!initial) pendingActivate = true;
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
let cachedStyleKey;
let cachedStyleValue;
const runtime = new WallpaperRuntime(profile, () => {
    const settings = draft || store.settings;
    if (settings === cachedStyleKey && cachedStyleValue) return cachedStyleValue;
    cachedStyleKey = settings;
    cachedStyleValue = {
        enabled: settings.enabled,
        css: appearance.wallpaperStyle(settings, 'var(--ag-ui-image)'),
        image: settings.image,
        imageHash: imageDigest(settings.image),
        surfaces: appearance.surfaceConfig(settings),
    };
    return cachedStyleValue;
}, enabled, hostPort);
function parseLoopbackEndpoints() {
    const raw = process.env.AG_UI_UPDATE_ENDPOINTS;
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result = {};
        for (const key of ['apiBase', 'webBase', 'rawBase', 'codeloadBase']) {
            if (typeof parsed[key] !== 'string') continue;
            const url = new URL(parsed[key]);
            if (['127.0.0.1', 'localhost'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) {
                result[key] = url.origin;
            }
        }
        return result;
    } catch {
        return {};
    }
}
async function recoverWithLegacyUpdater(instance) {
    const lockPath = join(dirname(pluginDir), '.antigravity-ui-update.lock');
    let lock;
    try {
        lock = await open(lockPath, 'wx');
        await instance.recoverInterruptedTransactions();
    } catch (error) {
        if (error.code !== 'EEXIST') console.warn('旧版更新恢复失败：' + (error.code || 'rollback'));
    } finally {
        if (lock) {
            await lock.close();
            await unlink(lockPath);
        }
    }
}
async function hasPendingUpdateTx(updatesDir) {
    try {
        const entries = await readdir(updatesDir, { withFileTypes: true });
        return entries.some(entry => entry.isDirectory() && entry.name.startsWith('tx-'));
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn('检查待恢复更新事务失败：' + (error?.code || error?.message || error));
        }
        return false;
    }
}
let updaterPromise;
function getUpdater() {
    updaterPromise ??= (async () => {
        const { PluginUpdater } = await import('./updater.mjs');
        const instance = new PluginUpdater({
            pluginDir,
            dataDir: data,
            home,
            endpoints: parseLoopbackEndpoints(),
            onReload: shutdown,
        });
        // An interrupted upgrade from 0.3.8 can leave the older updater next to this entry point.
        if (typeof instance.acquireUpdateLock !== 'function' && instance.inspectTargetEligibility().canApply) {
            await recoverWithLegacyUpdater(instance);
        }
        await instance.initializeLocalInfo();
        return instance;
    })().catch(error => {
        updaterPromise = undefined;
        throw error;
    });
    return updaterPromise;
}
let persistencePromise;
function loadPersistence() {
    persistencePromise ??= import('../../plugin/persistence.cjs').then(mod => mod.default || mod);
    return persistencePromise;
}
const files = {
    '/': ['index.html', 'text/html'],
    '/app.js': ['app.js', 'text/javascript'],
    '/styles.css': ['styles.css', 'text/css'],
    '/appearance.js': ['../../plugin/appearance.cjs', 'text/javascript'],
};
function preloadStaticAssets() {
    return Promise.all(Object.entries(files).map(async ([route, [path, type]]) => [
        route,
        { body: await readFile(join(directory, path)), contentType: type + '; charset=utf-8' },
    ]));
}
if (await hasPendingUpdateTx(join(data, 'updates'))) {
    await getUpdater();
}
const sdkPromise = loadSdk(join(resources, 'bin', 'language_server.exe'), data);
const assetsPromise = preloadStaticAssets();
void sdkPromise.catch(() => {});
void assetsPromise.catch(() => {});
await syncStore({ initial: true });
let heartbeatPending = false;
runtime.start(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    return enqueueRequest(async () => {
        await syncStore();
        await runtime.update(false, true);
    }).catch(error => {
        runtime.health = { ...runtime.health, error: error.message };
    }).finally(() => { heartbeatPending = false; });
});
try {
    const [sdk, staticAssets] = await Promise.all([sdkPromise, assetsPromise]);
    const { SidecarApp } = sdk;
    SdkResponse = sdk.Response;
    const staticHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    app = new SidecarApp();
    for (const [route, asset] of staticAssets) {
        app.api(route, () => new SdkResponse(asset.body, {
            contentType: asset.contentType,
            headers: staticHeaders,
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
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) {
            return jsonResponse(400, { error: '背景设置无效。' });
        }
        await syncStore();
        const resolved = resolveImage(input, store.settings);
        if (resolved === null) return jsonResponse(409, { error: '图片缓存未命中，请重新同步。', code: 'IMAGE_CACHE_MISS' });
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
    app.api('/api/repair-shortcuts', () => enqueueRequest(async () => {
        try {
            const persistence = await loadPersistence();
            const result = process.platform === 'win32'
                ? persistence.patchShortcuts({ home, installation, backupPath: shortcutBackup })
                : { total: 0, repaired: 0, ready: 0, shortcuts: [] };
            const asarPatched = persistence.inspectAsarPersist(installation).patched;
            return { ...result, asarPatched };
        } catch (error) {
            return jsonResponse(500, { error: error.message });
        }
    }), 'POST');
    app.api('/api/update', async () => {
        try {
            return (await getUpdater()).publicState();
        } catch (error) {
            return updateErrorResponse(error);
        }
    }, 'GET');
    app.api('/api/update/check', async () => {
        try {
            return (await getUpdater()).requestCheck();
        } catch (error) {
            return updateErrorResponse(error);
        }
    }, 'POST');
    app.api('/api/update/apply', async input => {
        try {
            const updater = await getUpdater();
            return await updater.apply(input || {});
        } catch (error) {
            return updateErrorResponse(error);
        }
    }, 'POST');
    app.api('/api/update/reload', async () => {
        try {
            const updater = await getUpdater();
            return updater.requestReload();
        } catch (error) {
            return updateErrorResponse(error);
        }
    }, 'POST');
    await app.run();
} catch (error) {
    await runtime.stop().catch(() => {});
    console.error(error);
    process.exit(1);
}
