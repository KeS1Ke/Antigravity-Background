'use strict';

const fs = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PERSIST_MARKER = '/*antigravity-ui-persist*/';
const PERSIST_END_MARKER = '/*end-antigravity-ui-persist*/';
const PERSIST_ENTRY_PATH = 'dist/antigravity-ui/persist.json';
const ASAR_BLOCK_SIZE = 4194304;
const DEBUG_FLAGS = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function renameSyncWithRetry(from, to, attempts = 5) {
    for (let attempt = 1; ; attempt++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (error) {
            if (attempt >= attempts || !RETRYABLE_RENAME_CODES.has(error?.code)) throw error;
            Atomics.wait(SLEEP_BUFFER, 0, 0, 25 * attempt);
        }
    }
}

function replaceAtomic(target, bytes) {
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temporary, bytes, { flag: 'wx' });
        renameSyncWithRetry(temporary, target);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

/** Parses an Electron ASAR archive header and data offset. */
function parseAsar(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 16) throw new Error('ASAR 归档无效或已损坏。');
    const headerPickleSize = bytes.readUInt32LE(4);
    const jsonLen = bytes.readUInt32LE(12);
    const dataOffset = 8 + headerPickleSize;
    if (dataOffset > bytes.length || 16 + jsonLen > dataOffset) throw new Error('ASAR 头部结构无效。');
    const header = JSON.parse(bytes.subarray(16, 16 + jsonLen).toString('utf8'));
    return { header, dataOffset };
}

/** Reads a single packed file entry buffer from an ASAR byte buffer. */
function readAsarEntry(bytes, entryPath) {
    const { header, dataOffset } = parseAsar(bytes);
    const entry = entryPath.split('/').reduce((folder, key) => folder?.files?.[key], header);
    if (!entry || entry.offset === undefined) return undefined;
    const offset = dataOffset + Number(entry.offset);
    return bytes.subarray(offset, offset + entry.size);
}

function buildIntegrity(buffer) {
    const blocks = [];
    for (let offset = 0; offset < buffer.length; offset += ASAR_BLOCK_SIZE) {
        blocks.push(digest(buffer.subarray(offset, Math.min(buffer.length, offset + ASAR_BLOCK_SIZE))));
    }
    if (blocks.length === 0) blocks.push(digest(Buffer.alloc(0)));
    return { algorithm: 'SHA256', hash: digest(buffer), blockSize: ASAR_BLOCK_SIZE, blocks };
}

/** Rebuilds an ASAR archive with selective file replacements/additions. */
function repackAsar(sourceBytes, replacements = {}) {
    const { header, dataOffset } = parseAsar(sourceBytes);
    const chunks = [];
    let cursor = 0;

    function cloneNode(node, prefix = '') {
        if (!node || typeof node !== 'object') return node;
        if (!isPlainObject(node.files)) return { ...node };
        const files = {};
        for (const [key, child] of Object.entries(node.files)) {
            const fullPath = prefix ? prefix + '/' + key : key;
            if (isPlainObject(child.files)) {
                files[key] = cloneNode(child, fullPath);
                continue;
            }
            if (child.unpacked || child.link !== undefined || child.offset === undefined) {
                files[key] = { ...child };
                continue;
            }
            const nextBuffer = Object.hasOwn(replacements, fullPath)
                ? replacements[fullPath]
                : sourceBytes.subarray(dataOffset + Number(child.offset), dataOffset + Number(child.offset) + child.size);
            if (nextBuffer === null) continue;
            const entry = {
                ...child,
                size: nextBuffer.length,
                offset: String(cursor),
                ...(Object.hasOwn(replacements, fullPath) ? { integrity: buildIntegrity(nextBuffer) } : {}),
            };
            files[key] = entry;
            chunks.push(nextBuffer);
            cursor += nextBuffer.length;
        }
        return { ...node, files };
    }

    const nextHeader = cloneNode(header);
    for (const [fullPath, nextBuffer] of Object.entries(replacements)) {
        if (nextBuffer === null) continue;
        const segments = fullPath.split('/');
        let folder = nextHeader;
        for (let i = 0; i < segments.length - 1; i++) {
            folder.files ??= {};
            folder.files[segments[i]] ??= { files: {} };
            folder = folder.files[segments[i]];
        }
        const leaf = segments[segments.length - 1];
        if (!folder.files?.[leaf]) {
            folder.files ??= {};
            folder.files[leaf] = {
                size: nextBuffer.length,
                offset: String(cursor),
                integrity: buildIntegrity(nextBuffer),
            };
            chunks.push(nextBuffer);
            cursor += nextBuffer.length;
        }
    }

    const jsonBytes = Buffer.from(JSON.stringify(nextHeader), 'utf8');
    const alignedSize = (jsonBytes.length + 3) & ~3;
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(alignedSize + 8, 4);
    prefix.writeUInt32LE(alignedSize + 4, 8);
    prefix.writeUInt32LE(jsonBytes.length, 12);
    const pad = Buffer.alloc(alignedSize - jsonBytes.length);
    return Buffer.concat([prefix, jsonBytes, pad, ...chunks]);
}

function buildBootSnippet(electronIdent) {
    return PERSIST_MARKER +
        `try{if(!${electronIdent}.app.commandLine.hasSwitch('remote-debugging-port'))${electronIdent}.app.commandLine.appendSwitch('remote-debugging-port','0');` +
        `if(!${electronIdent}.app.commandLine.hasSwitch('remote-debugging-address'))${electronIdent}.app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');}catch{}` +
        PERSIST_END_MARKER;
}

function injectMainBootSwitch(mainSource) {
    const clean = mainSource.replace(/\r?\n?\/\*antigravity-ui-persist\*\/[\s\S]*?\/\*end-antigravity-ui-persist\*\//g, '');
    const match = clean.match(/((?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']electron["']\s*\)\s*;)/);
    if (!match) throw new Error('无法在主进程入口定位 electron 模块导入。');
    const snippet = buildBootSnippet(match[2]);
    return {
        patched: clean.slice(0, match.index + match[1].length) + '\n' + snippet + clean.slice(match.index + match[1].length),
        snippet,
    };
}

/** Checks whether resources/app.asar currently carries the persistence boot switch. */
function inspectAsarPersist(installation) {
    const asarPath = join(installation, 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) return { exists: false, patched: false, backupOk: false };
    let marker;
    let mainBytes;
    try {
        const bytes = fs.readFileSync(asarPath);
        marker = readAsarEntry(bytes, PERSIST_ENTRY_PATH);
        mainBytes = readAsarEntry(bytes, 'dist/main.js');
    } catch (error) {
        return { exists: true, patched: false, backupOk: false, error: error.message };
    }
    const hasMarkerInMain = Boolean(mainBytes && mainBytes.toString('utf8').includes(PERSIST_MARKER));
    if (!marker) return { exists: true, patched: hasMarkerInMain, backupOk: false };
    let sha256 = '';
    try { sha256 = JSON.parse(marker.toString('utf8')).sha256 || ''; } catch {}
    const backupPath = sha256 ? asarPath + '.antigravity-ui.persist.' + sha256 + '.bak' : '';
    return {
        exists: true,
        patched: hasMarkerInMain,
        sha256,
        backupPath,
        backupOk: Boolean(backupPath && fs.existsSync(backupPath)),
    };
}

/** Patches resources/app.asar to always enable loopback CDP across any launch path. */
function installAsarPersist(installation) {
    const asarPath = join(installation, 'resources', 'app.asar');
    let current;
    try { current = fs.readFileSync(asarPath); }
    catch (error) { if (error.code === 'ENOENT') return { status: 'absent' }; throw error; }

    let baseBytes = current;
    const existingMarker = readAsarEntry(current, PERSIST_ENTRY_PATH);
    if (existingMarker) {
        const { sha256 } = JSON.parse(existingMarker.toString('utf8'));
        if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('持久化恢复记录无效。');
        const backupPath = asarPath + '.antigravity-ui.persist.' + sha256 + '.bak';
        if (!fs.existsSync(backupPath)) throw new Error('持久化原始备份缺失，无法安全重修补：' + backupPath);
        const restored = fs.readFileSync(backupPath);
        if (digest(restored) !== sha256) throw new Error('持久化备份校验失败，请先手动校验或恢复 app.asar。');
        const mainText = readAsarEntry(current, 'dist/main.js')?.toString('utf8') || '';
        const { snippet } = injectMainBootSwitch(mainText);
        if (mainText.includes(snippet)) return { status: 'already-patched', sha256 };
        baseBytes = restored;
    }

    const originalSha = digest(baseBytes);
    const backupPath = asarPath + '.antigravity-ui.persist.' + originalSha + '.bak';
    if (fs.existsSync(backupPath)) {
        if (digest(fs.readFileSync(backupPath)) !== originalSha) throw new Error('现有 app.asar 备份与当前原文件校验不一致。');
    } else {
        replaceAtomic(backupPath, baseBytes);
    }

    const mainEntry = readAsarEntry(baseBytes, 'dist/main.js');
    if (!mainEntry) throw new Error('未找到 app.asar 中的 dist/main.js。');
    const { patched } = injectMainBootSwitch(mainEntry.toString('utf8'));
    const nextAsar = repackAsar(baseBytes, {
        'dist/main.js': Buffer.from(patched, 'utf8'),
        [PERSIST_ENTRY_PATH]: Buffer.from(JSON.stringify({ sha256: originalSha }), 'utf8'),
    });
    if (!readAsarEntry(nextAsar, PERSIST_ENTRY_PATH)) throw new Error('重建 app.asar 校验失败。');
    replaceAtomic(asarPath, nextAsar);

    // Clean stale backups from older Antigravity versions after verified replacement
    const resourceDir = dirname(asarPath);
    try {
        for (const file of fs.readdirSync(resourceDir)) {
            if (file.startsWith('app.asar.antigravity-ui.persist.') && file.endsWith('.bak') && join(resourceDir, file) !== backupPath) {
                try { fs.rmSync(join(resourceDir, file), { force: true }); } catch {}
            }
        }
    } catch {}
    return { status: 'patched', sha256: originalSha };
}

/** Restores the original resources/app.asar from SHA-256 verified backup. */
function restoreAsarPersist(installation) {
    const asarPath = join(installation, 'resources', 'app.asar');
    let current;
    try { current = fs.readFileSync(asarPath); }
    catch (error) { if (error.code === 'ENOENT') return { status: 'absent' }; throw error; }

    const marker = readAsarEntry(current, PERSIST_ENTRY_PATH);
    if (!marker) return { status: 'clean' };
    const { sha256 } = JSON.parse(marker.toString('utf8'));
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('持久化恢复记录无效。');
    const backupPath = asarPath + '.antigravity-ui.persist.' + sha256 + '.bak';
    const original = fs.readFileSync(backupPath);
    if (digest(original) !== sha256) throw new Error('app.asar 原始备份校验失败。');
    replaceAtomic(asarPath, original);
    if (digest(fs.readFileSync(asarPath)) !== sha256) throw new Error('恢复 app.asar 失败。');
    fs.rmSync(backupPath, { force: true });
    return { status: 'restored', sha256 };
}

function shortcutRoots(home) {
    const candidates = [
        join(home, 'Desktop'),
        join(home, 'OneDrive', 'Desktop'),
        join(home, 'OneDrive', '桌面'),
        join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        join(home, 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
        join(home, 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'StartMenu'),
    ];
    if (process.env.OneDrive && resolve(process.env.OneDrive).toLowerCase().startsWith(resolve(home).toLowerCase() + '\\')) {
        candidates.push(join(process.env.OneDrive, 'Desktop'), join(process.env.OneDrive, '桌面'));
    }
    const seen = new Set();
    return candidates.filter(dir => {
        const key = resolve(dir).toLowerCase();
        if (seen.has(key) || !fs.existsSync(dir)) return false;
        seen.add(key);
        return true;
    });
}

function collectLnkFiles(dirs) {
    const found = [];
    const seen = new Set();
    const walk = dir => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) { walk(full); continue; }
            if (entry.isFile() && /\.lnk$/i.test(entry.name)) {
                const key = resolve(full).toLowerCase();
                if (!seen.has(key)) { seen.add(key); found.push(full); }
            }
        }
    };
    for (const dir of dirs) walk(dir);
    return found;
}

function isMatchingShortcut(item, installation) {
    if (!item?.target) return false;
    const expectedExe = resolve(installation, 'Antigravity.exe').toLowerCase();
    const targetLower = resolve(item.target).toLowerCase();
    if (targetLower === expectedExe) return true;
    const lnkBase = basename(item.path, '.lnk');
    const targetName = basename(targetLower);
    return /^antigravity(?:[\s._-]|$)/i.test(lnkBase) &&
        (targetName === 'antigravity.exe' || targetName === 'antigravitylauncher.exe');
}

function runShortcutScript(payload) {
    if (process.platform !== 'win32') return [];
    const script = `
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$out = @()
foreach ($item in @($req.items)) {
    if (-not (Test-Path -LiteralPath $item.path)) { continue }
    try {
        $sc = $ws.CreateShortcut($item.path)
        if ($item.PSObject.Properties['setArguments'] -and $null -ne $item.setArguments) {
            $sc.Arguments = [string]$item.setArguments
            $sc.Save()
        }
        $out += [pscustomobject]@{
            path = $item.path
            target = [string]$sc.TargetPath
            args = [string]$sc.Arguments
        }
    } catch {}
}
$out | ConvertTo-Json -Compress
`;
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        windowsHide: true,
    }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
}

function ensureFlags(currentArgs) {
    const tokens = [];
    const trimmed = (currentArgs || '').trim();
    if (trimmed) tokens.push(trimmed);
    if (!/(?:^|\s)--remote-debugging-port(?:=|\s|$)/i.test(trimmed)) tokens.push('--remote-debugging-port=0');
    if (!/(?:^|\s)--remote-debugging-address(?:=|\s|$)/i.test(trimmed)) tokens.push('--remote-debugging-address=127.0.0.1');
    return tokens.join(' ');
}

function hasDebugFlags(args) {
    return /(?:^|\s)--remote-debugging-port(?:=|\s|$)/i.test(args || '') &&
        /(?:^|\s)--remote-debugging-address(?:=|\s|$)/i.test(args || '');
}

/** Inspects Antigravity shortcuts under user profile dirs without modifying them. */
function inspectShortcuts({ home, installation, roots } = {}) {
    const lnks = collectLnkFiles(roots || shortcutRoots(home));
    if (lnks.length === 0) return [];
    const inspected = runShortcutScript({ items: lnks.map(path => ({ path })) });
    return inspected.filter(item => isMatchingShortcut(item, installation)).map(item => ({
        path: item.path,
        target: item.target,
        args: item.args,
        ready: hasDebugFlags(item.args),
    }));
}

/** Ensures Antigravity shortcuts include loopback remote-debugging flags and backs up original args. */
function patchShortcuts({ home, installation, backupPath, roots } = {}) {
    const shortcuts = inspectShortcuts({ home, installation, roots });
    let backup = {};
    if (backupPath && fs.existsSync(backupPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
            if (isPlainObject(parsed)) backup = parsed;
        } catch {}
    }

    const updates = [];
    let backupDirty = false;
    for (const item of shortcuts) {
        const key = resolve(item.path).toLowerCase();
        const nextArgs = ensureFlags(item.args);
        if (nextArgs !== (item.args || '').trim()) {
            if (!Object.hasOwn(backup, key)) {
                backup[key] = { path: item.path, target: item.target, args: item.args || '' };
                backupDirty = true;
            }
            updates.push({ path: item.path, setArguments: nextArgs });
        }
    }

    if (backupPath && backupDirty) {
        fs.mkdirSync(dirname(backupPath), { recursive: true });
        replaceAtomic(backupPath, Buffer.from(JSON.stringify(backup, null, 2) + '\n', 'utf8'));
    }
    if (updates.length > 0) runShortcutScript({ items: updates });

    const finalShortcuts = updates.length > 0 ? inspectShortcuts({ home, installation, roots }) : shortcuts;
    return {
        total: finalShortcuts.length,
        repaired: updates.length,
        ready: finalShortcuts.filter(item => item.ready).length,
        shortcuts: finalShortcuts,
    };
}

/** Restores shortcut arguments backed up by patchShortcuts(). */
function restoreShortcuts({ backupPath } = {}) {
    if (!backupPath || !fs.existsSync(backupPath)) return { restored: 0 };
    let backup = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        if (isPlainObject(parsed)) backup = parsed;
    } catch {
        return { restored: 0 };
    }
    const entries = Object.values(backup).filter(entry => entry?.path && fs.existsSync(entry.path));
    const current = entries.length > 0
        ? runShortcutScript({ items: entries.map(entry => ({ path: entry.path })) })
        : [];
    const byPath = new Map(current.map(item => [resolve(item.path).toLowerCase(), item]));
    const updates = [];
    for (const entry of entries) {
        const cur = byPath.get(resolve(entry.path).toLowerCase());
        if (!cur || resolve(cur.target).toLowerCase() !== resolve(entry.target).toLowerCase()) continue;
        updates.push({ path: entry.path, setArguments: entry.args || '' });
    }
    const saved = updates.length > 0 ? runShortcutScript({ items: updates }) : [];
    const savedPaths = new Set(saved.map(item => resolve(item.path).toLowerCase()));
    const remaining = {};
    for (const entry of entries) {
        const key = resolve(entry.path).toLowerCase();
        const cur = byPath.get(key);
        if (!cur) {
            remaining[key] = entry;
            continue;
        }
        if (resolve(cur.target).toLowerCase() !== resolve(entry.target).toLowerCase()) continue;
        if (!savedPaths.has(key)) remaining[key] = entry;
    }
    const remainingCount = Object.keys(remaining).length;
    if (remainingCount > 0) {
        replaceAtomic(backupPath, Buffer.from(JSON.stringify(remaining, null, 2) + '\n', 'utf8'));
    } else {
        fs.rmSync(backupPath, { force: true });
    }
    return { restored: savedPaths.size, failed: remainingCount };
}

module.exports = {
    PERSIST_MARKER,
    PERSIST_ENTRY_PATH,
    DEBUG_FLAGS,
    readAsarEntry,
    repackAsar,
    replaceAtomic,
    digest,
    injectMainBootSwitch,
    inspectAsarPersist,
    installAsarPersist,
    restoreAsarPersist,
    inspectShortcuts,
    patchShortcuts,
    restoreShortcuts,
};
