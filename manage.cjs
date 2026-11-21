'use strict';

const fs = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { homedir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const readline = require('node:readline/promises');
const {
    readAsarEntry,
    replaceAtomic: replace,
    digest,
    inspectAsarPersist,
    installAsarPersist,
    restoreAsarPersist,
    inspectShortcuts,
    patchShortcuts,
    restoreShortcuts,
} = require('./plugin/persistence.cjs');

const name = 'antigravity-ui';
const runtimeFiles = ['plugin.json', 'plugin', 'sidecars', 'assets'];
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function json(path, fallback) {
    try { return JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function isHelperProcess(command) {
    return typeof command === 'string' &&
        /(?:^|\s)--import(?:\s+|=)(?:"[^"]*[\\/]register_loader\.js"|[^\s"]*[\\/]register_loader\.js)(?=\s|$)/i.test(command) &&
        /(?:^|[\\/"\s])(?:launch|main)\.mjs(?=["\s]|$)/i.test(command) &&
        !/[\\/]app\.asar(?:[\\/"\s]|$)/i.test(command);
}

function runningAntigravity() {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
        'foreach ($item in @(Get-Process -Name Antigravity -ErrorAction SilentlyContinue)) { ' +
        '$details = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $item.Id) -ErrorAction SilentlyContinue; ' +
        '$exe = if ($item.Path) { $item.Path } else { $details.ExecutablePath }; ' +
        '[pscustomobject]@{ path = $exe; commandLine = $details.CommandLine } | ConvertTo-Json -Compress }; exit 0',
    ], { encoding: 'utf8', windowsHide: true });
    return output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function hasInstallation(directory) {
    return fs.existsSync(join(directory, 'Antigravity.exe')) || fs.existsSync(join(directory, 'resources', 'app.asar'));
}

async function askInstallation(fallback) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question('未在默认目录检测到 Antigravity，请输入安装目录（直接回车跳过旧补丁检查）：');
        const trimmed = answer.trim().replace(/^"(.*)"$/, '$1');
        if (!trimmed) return fallback;
        return trimmed.toLowerCase().endsWith('antigravity.exe') ? dirname(trimmed) : trimmed;
    } catch {
        return fallback;
    } finally {
        rl.close();
    }
}

async function resolveInstallation(command, appOverride, home, running) {
    if (appOverride) return appOverride;
    const activeDir = running.find(process => process.path && !isHelperProcess(process.commandLine))?.path;
    if (activeDir) return dirname(activeDir);
    const defaultInstallation = join(home, 'AppData', 'Local', 'Programs', 'antigravity');
    const candidates = [
        defaultInstallation,
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'antigravity'),
        process.env.ProgramFiles && join(process.env.ProgramFiles, 'Antigravity'),
        process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Antigravity'),
    ].filter(Boolean);
    const seen = new Set();
    for (const candidate of candidates) {
        const key = resolve(candidate).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (hasInstallation(candidate)) return candidate;
    }
    if (command === 'install' && process.stdin.isTTY) return askInstallation(defaultInstallation);
    return defaultInstallation;
}

function desktopClosed(installation, running) {
    const executable = resolve(installation, 'Antigravity.exe').toLowerCase();
    if (running.some(process => !isHelperProcess(process.commandLine) &&
        (!process.path || process.path.toLowerCase() === executable))) {
        throw new Error('请先从托盘退出 Antigravity，再安装或卸载。');
    }
}

function restoreLegacy(installation) {
    const path = join(installation, 'resources', 'app.asar');
    let current;
    try { current = fs.readFileSync(path); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const marker = readAsarEntry(current, 'dist/antigravity-ui/original.json');
    if (!marker) return;
    const { sha256 } = JSON.parse(marker.toString('utf8'));
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('旧补丁的恢复记录无效。');
    const original = fs.readFileSync(path + '.antigravity-ui.' + sha256 + '.bak');
    if (digest(original) !== sha256) throw new Error('旧补丁的原始资源备份校验失败。');
    replace(path, original);
    if (digest(fs.readFileSync(path)) !== sha256) throw new Error('恢复旧补丁失败。');
    console.log('已迁移旧背景补丁，原始应用资源恢复完成。');
}

function writeInstallSource(staged) {
    const manifest = json(join(__dirname, 'plugin.json'), null);
    if (!manifest?.version) return;
    let commit = null;
    if (fs.existsSync(join(__dirname, '.git'))) {
        try {
            const head = execFileSync('git', ['-C', __dirname, 'rev-parse', 'HEAD'], {
                encoding: 'utf8',
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            if (/^[0-9a-f]{40}$/i.test(head)) commit = head.toLowerCase();
        } catch {}
    }
    if (!commit) return;
    fs.writeFileSync(join(staged, '.install-source.json'), JSON.stringify({
        repo: 'KeS1Ke/Antigravity-Background',
        channel: 'main',
        version: manifest.version,
        commit,
        updatedAt: new Date().toISOString(),
    }, null, 2) + '\n');
}

function safeDirectory(path) {
    const parent = dirname(path);
    fs.mkdirSync(parent, { recursive: true });
    if (fs.realpathSync(parent).toLowerCase() !== resolve(parent).toLowerCase()) throw new Error('插件父目录包含重定向。');
    const info = fs.lstatSync(path, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink() ||
        !info.isDirectory() ||
        fs.realpathSync(path).toLowerCase() !== resolve(path).toLowerCase() ||
        json(join(path, 'plugin.json'), {})?.name !== name) throw new Error('目标目录归属不匹配。');
}

const LOCK_OWNER_RE = /^owner-(\d+)-[a-f\d-]{36}$/;

function isPidAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code !== 'ESRCH'; }
}

function removeUpdateDirLock(lockPath, owner) {
    if (owner) {
        try { fs.rmSync(join(lockPath, owner), { force: true }); } catch {}
    }
    try { fs.rmdirSync(lockPath); } catch {}
}

function acquireUpdateDirLock(lockPath) {
    const existing = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (existing) {
        if (!existing.isDirectory()) {
            throw new Error('检测到旧版在线更新锁：' + lockPath + '。请等待更新完成，或确认旧进程退出后清理该文件重试。');
        }
        const owners = fs.readdirSync(lockPath);
        const owner = owners[0];
        const pid = Number(LOCK_OWNER_RE.exec(owner || '')?.[1]);
        if (owners.length > 1 || (owner && (!Number.isInteger(pid) || pid <= 0 || isPidAlive(pid)))) {
            throw new Error('在线更新正在进行：' + lockPath + '。请等待更新完成后再试。');
        }
        removeUpdateDirLock(lockPath, owner);
    }
    const token = randomUUID();
    const owner = 'owner-' + process.pid + '-' + token;
    const stagedLock = lockPath + '.' + token + '.tmp';
    try {
        fs.mkdirSync(stagedLock);
        fs.writeFileSync(join(stagedLock, owner), '', { flag: 'wx' });
        fs.renameSync(stagedLock, lockPath);
    } catch (error) {
        removeUpdateDirLock(stagedLock, owner);
        if (fs.lstatSync(lockPath, { throwIfNoEntry: false }) || ['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
            throw new Error('在线更新正在进行：' + lockPath + '。请等待更新完成后再试。');
        }
        throw error;
    }
    return () => removeUpdateDirLock(lockPath, owner);
}

function acquireLock(lock) {
    try {
        return fs.openSync(lock, 'wx');
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new Error('安装或卸载锁已存在：' + lock + '。请等待当前操作完成。若上次异常中断，请关闭所有安装器窗口，删除此锁文件后重试。');
    }
}

async function manage() {
    const [command, rawAppOverride, homeOverride] = process.argv.slice(2);
    if (!['install', 'uninstall', 'status'].includes(command)) throw new Error('用法：node manage.cjs install|uninstall|status [安装目录] [用户目录]');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请使用 Node.js 22 或更高版本。');
    const appOverride = rawAppOverride?.trim() || '';
    const home = homeOverride || homedir();
    const configDir = join(home, '.gemini', 'config');
    const configuration = join(configDir, 'config.json');
    const shortcutBackup = join(configDir, 'antigravity-ui.shortcuts.bak.json');
    const destination = join(configDir, 'plugins', name);
    if (command === 'status') {
        const manifestRaw = json(join(destination, 'plugin.json'), null);
        const manifest = isPlainObject(manifestRaw) ? manifestRaw : null;
        const configRaw = json(configuration, {});
        const config = isPlainObject(configRaw) ? configRaw : {};
        const plugin = isPlainObject(config.plugins) ? config.plugins[name]?.enabled !== false : true;
        const sidecar = isPlainObject(config.sidecars) ? config.sidecars[name + '/panel']?.enabled === true : false;
        console.log(manifest
            ? 'Antigravity Background ' + manifest.version + ' ｜ 自定义插件已安装 ｜ ' + (plugin && sidecar ? '已启用' : '已停用')
            : 'Antigravity Background 尚未安装到自定义目录。');
        const running = process.platform === 'win32' ? runningAntigravity() : [];
        const installation = await resolveInstallation(command, appOverride, home, running);
        const asarInfo = inspectAsarPersist(installation);
        const shortcuts = process.platform === 'win32' ? inspectShortcuts({ home, installation }) : [];
        const readyShortcuts = shortcuts.filter(item => item.ready).length;
        const portFile = join(home, 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort');
        const hasPort = fs.existsSync(portFile);
        if (asarInfo.exists || shortcuts.length > 0) {
            console.log(
                '持久化状态：app.asar 自启开关 ' + (asarInfo.patched ? '已注入' : '未注入') +
                ' ｜ 快捷方式 ' + readyShortcuts + '/' + shortcuts.length + ' 已配置' +
                ' ｜ 当前调试端口 ' + (hasPort ? '已就绪' : '未检测到')
            );
        }
        return;
    }
    const running = runningAntigravity();
    const installation = await resolveInstallation(command, appOverride, home, running);
    desktopClosed(installation, runningAntigravity());
    safeDirectory(destination);
    fs.mkdirSync(dirname(configuration), { recursive: true });
    const lock = configuration + '.antigravity-ui.lock';
    const updateLock = join(dirname(destination), '.' + name + '-update.lock');
    const handle = acquireLock(lock);
    let releaseUpdateLock = null;
    const staged = destination + '.staging-' + randomUUID();
    const previous = destination + '.previous-' + randomUUID();
    let oldMoved = false;
    let newMoved = false;
    let persistInfo;
    let shortcutInfo;
    try {
        releaseUpdateLock = acquireUpdateDirLock(updateLock);
        safeDirectory(destination);
        const before = fs.existsSync(configuration) ? fs.readFileSync(configuration) : null;
        const config = before ? JSON.parse(before.toString('utf8').replace(/^\uFEFF/, '')) : {};
        if (!isPlainObject(config) ||
            (config.plugins != null && !isPlainObject(config.plugins)) ||
            (config.sidecars != null && !isPlainObject(config.sidecars))) {
            throw new Error('现有自定义配置格式不兼容。');
        }
        config.plugins ??= {};
        config.sidecars ??= {};
        if (command === 'install') {
            fs.mkdirSync(staged);
            for (const file of runtimeFiles) fs.cpSync(join(__dirname, file), join(staged, file), { recursive: true });
            writeInstallSource(staged);
        }
        restoreLegacy(installation);
        if (fs.lstatSync(destination, { throwIfNoEntry: false })) { fs.renameSync(destination, previous); oldMoved = true; }
        if (command === 'install') {
            fs.renameSync(staged, destination);
            newMoved = true;
            config.plugins[name] = { ...(isPlainObject(config.plugins[name]) ? config.plugins[name] : null), enabled: true };
            config.sidecars[name + '/panel'] = { ...(isPlainObject(config.sidecars[name + '/panel']) ? config.sidecars[name + '/panel'] : null), enabled: true };
            persistInfo = installAsarPersist(installation);
            shortcutInfo = process.platform === 'win32'
                ? patchShortcuts({ home, installation, backupPath: shortcutBackup })
                : { total: 0, repaired: 0, ready: 0 };
        } else {
            delete config.plugins[name];
            delete config.sidecars[name + '/panel'];
            persistInfo = restoreAsarPersist(installation);
            shortcutInfo = process.platform === 'win32'
                ? restoreShortcuts({ backupPath: shortcutBackup })
                : { restored: 0 };
        }
        const now = fs.existsSync(configuration) ? fs.readFileSync(configuration) : null;
        if (Boolean(before) !== Boolean(now) || (before && !before.equals(now))) throw new Error('配置已被其他操作修改，请重试。');
        if (before) fs.writeFileSync(configuration + '.antigravity-ui.' + randomUUID() + '.bak', before, { flag: 'wx' });
        replace(configuration, JSON.stringify(config, null, 2) + '\n');
    } catch (error) {
        if (command === 'install' && persistInfo?.status === 'patched') {
            try { restoreAsarPersist(installation); } catch {}
        }
        if (command === 'install' && shortcutInfo?.repaired > 0) {
            try { restoreShortcuts({ backupPath: shortcutBackup }); } catch {}
        }
        if (newMoved) fs.rmSync(destination, { recursive: true, force: true });
        if (oldMoved) fs.renameSync(previous, destination);
        throw error;
    } finally {
        releaseUpdateLock?.();
        fs.closeSync(handle);
        fs.rmSync(lock, { force: true });
        fs.rmSync(staged, { recursive: true, force: true });
    }
    if (oldMoved) {
        try { fs.rmSync(previous, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
        catch (error) { console.warn('旧目录清理未完成，可手动删除 ' + previous + '：' + error.message); }
    }
    if (command === 'install') {
        const persistNote = persistInfo?.status === 'patched' || persistInfo?.status === 'already-patched'
            ? '已配置 app.asar 持久化自启开关（仅 127.0.0.1），'
            : '';
        const shortcutNote = shortcutInfo?.total > 0
            ? '快捷方式已配置 ' + shortcutInfo.ready + '/' + shortcutInfo.total + ' 个，'
            : '';
        console.log('已安装到 ' + destination + '。' + persistNote + shortcutNote + '重启后从右侧 Extensions → Antigravity Background 打开设置页。');
    } else {
        const restoreNote = (persistInfo?.status === 'restored' ? '已恢复原版 app.asar，' : '') +
            (shortcutInfo?.restored > 0 ? '已还原 ' + shortcutInfo.restored + ' 个快捷方式，' : '');
        console.log('已卸载。' + restoreNote + '背景图片与设置保留在 Sidecar 数据目录。');
    }
}

manage().catch(error => { console.error(error.message); process.exitCode = 1; });
