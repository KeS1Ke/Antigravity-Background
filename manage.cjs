const fs = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { homedir } = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const name = 'antigravity-ui';
const runtimeFiles = ['plugin.json', 'plugin', 'sidecars', 'assets'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function json(path, fallback) {
    try { return JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function replace(path, data) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temporary, data, { flag: 'wx' });
        fs.renameSync(temporary, path);
    } finally { fs.rmSync(temporary, { force: true }); }
}

function readArchive(bytes, path) {
    const header = JSON.parse(bytes.toString('utf8', 16, 16 + bytes.readUInt32LE(12)));
    const entry = path.split('/').reduce((folder, key) => folder?.files?.[key], header);
    if (!entry || entry.offset === undefined) return undefined;
    const offset = 8 + bytes.readUInt32LE(4) + Number(entry.offset);
    return bytes.subarray(offset, offset + entry.size);
}

function desktopClosed(installation) {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
        'foreach ($item in @(Get-Process -Name Antigravity -ErrorAction SilentlyContinue)) { ' +
        '$details = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $item.Id) -ErrorAction SilentlyContinue; ' +
        '[pscustomobject]@{ path = $item.Path; commandLine = $details.CommandLine } | ConvertTo-Json -Compress }; exit 0',
    ], { encoding: 'utf8', windowsHide: true });
    const executable = resolve(installation, 'Antigravity.exe').toLowerCase();
    const running = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const helpers = command => typeof command === 'string' &&
        /(?:^|\s)--import(?:\s+|=)(?:"[^"]*[\\/]register_loader\.js"|[^\s"]*[\\/]register_loader\.js)(?=\s|$)/i.test(command) &&
        /(?:^|[\\/"\s])(?:launch|main)\.mjs(?=["\s]|$)/i.test(command) &&
        !/[\\/]app\.asar(?:[\\/"\s]|$)/i.test(command);
    if (running.some(process => process.path?.toLowerCase() === executable && !helpers(process.commandLine))) {
        throw new Error('请先从托盘退出 Antigravity，再安装或卸载。');
    }
}

function restoreLegacy(installation) {
    const path = join(installation, 'resources', 'app.asar');
    const current = fs.readFileSync(path);
    const marker = readArchive(current, 'dist/antigravity-ui/original.json');
    if (!marker) return;
    const { sha256 } = JSON.parse(marker);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('旧补丁的恢复记录无效。');
    const original = fs.readFileSync(path + '.antigravity-ui.' + sha256 + '.bak');
    if (digest(original) !== sha256) throw new Error('旧补丁的原始资源备份校验失败。');
    replace(path, original);
    if (digest(fs.readFileSync(path)) !== sha256) throw new Error('恢复旧补丁失败。');
    console.log('已迁移旧背景补丁，原始应用资源恢复完成。');
}

function safeDirectory(path) {
    const parent = dirname(path);
    fs.mkdirSync(parent, { recursive: true });
    if (fs.realpathSync(parent).toLowerCase() !== resolve(parent).toLowerCase()) throw new Error('插件父目录包含重定向。');
    if (!fs.existsSync(path)) return;
    if (fs.lstatSync(path).isSymbolicLink() ||
        fs.realpathSync(path).toLowerCase() !== resolve(path).toLowerCase() ||
        json(join(path, 'plugin.json'), {}).name !== name) throw new Error('目标目录归属不匹配。');
}

function manage() {
    const [command, appOverride, homeOverride] = process.argv.slice(2);
    if (!['install', 'uninstall', 'status'].includes(command)) throw new Error('用法：node manage.cjs install|uninstall|status [安装目录] [用户目录]');
    const home = homeOverride || homedir();
    const installation = appOverride || join(home, 'AppData', 'Local', 'Programs', 'antigravity');
    const configuration = join(home, '.gemini', 'config', 'config.json');
    const destination = join(home, '.gemini', 'config', 'plugins', name);
    if (command === 'status') {
        const manifest = json(join(destination, 'plugin.json'), null);
        const config = json(configuration, {});
        const plugin = config.plugins?.[name]?.enabled !== false;
        const sidecar = config.sidecars?.[name + '/panel']?.enabled === true;
        console.log(manifest
            ? 'Antigravity Background ' + manifest.version + ' ｜ 自定义插件已安装 ｜ ' + (plugin && sidecar ? '已启用' : '已停用')
            : 'Antigravity Background 尚未安装到自定义目录。');
        return;
    }
    desktopClosed(installation);
    safeDirectory(destination);
    fs.mkdirSync(dirname(configuration), { recursive: true });
    const lock = configuration + '.antigravity-ui.lock';
    const handle = fs.openSync(lock, 'wx');
    const staged = destination + '.staging-' + randomUUID();
    const previous = destination + '.previous-' + randomUUID();
    let oldMoved = false;
    let newMoved = false;
    try {
        const before = fs.existsSync(configuration) ? fs.readFileSync(configuration) : null;
        const config = before ? JSON.parse(before.toString('utf8').replace(/^\uFEFF/, '')) : {};
        if (!config || typeof config !== 'object' || Array.isArray(config) ||
            (config.plugins && (typeof config.plugins !== 'object' || Array.isArray(config.plugins))) ||
            (config.sidecars && (typeof config.sidecars !== 'object' || Array.isArray(config.sidecars)))) {
            throw new Error('现有自定义配置格式不兼容。');
        }
        config.plugins ??= {};
        config.sidecars ??= {};
        if (command === 'install') {
            fs.mkdirSync(staged);
            for (const file of runtimeFiles) fs.cpSync(join(__dirname, file), join(staged, file), { recursive: true });
            restoreLegacy(installation);
            if (fs.existsSync(destination)) { fs.renameSync(destination, previous); oldMoved = true; }
            fs.renameSync(staged, destination);
            newMoved = true;
            config.plugins[name] = { ...config.plugins[name], enabled: true };
            config.sidecars[name + '/panel'] = { ...config.sidecars[name + '/panel'], enabled: true };
        } else {
            restoreLegacy(installation);
            if (fs.existsSync(destination)) { fs.renameSync(destination, previous); oldMoved = true; }
            delete config.plugins[name];
            delete config.sidecars[name + '/panel'];
        }
        const now = fs.existsSync(configuration) ? fs.readFileSync(configuration) : null;
        if (Boolean(before) !== Boolean(now) || (before && !before.equals(now))) throw new Error('配置已被其他操作修改，请重试。');
        if (before) fs.writeFileSync(configuration + '.antigravity-ui.' + randomUUID() + '.bak', before, { flag: 'wx' });
        replace(configuration, JSON.stringify(config, null, 2) + '\n');
    } catch (error) {
        if (newMoved) fs.rmSync(destination, { recursive: true, force: true });
        if (oldMoved) fs.renameSync(previous, destination);
        throw error;
    } finally {
        fs.closeSync(handle);
        fs.rmSync(lock, { force: true });
        fs.rmSync(staged, { recursive: true, force: true });
    }
    if (oldMoved) fs.rmSync(previous, { recursive: true });
    console.log(command === 'install'
        ? '已安装到 ' + destination + '。重启后从右侧 Extensions → Antigravity Background 打开设置页。'
        : '已卸载。背景图片与设置保留在 Sidecar 数据目录。');
}

try { manage(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
