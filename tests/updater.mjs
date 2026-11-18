import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import net from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { parseTarGz, parseZip, REQUIRED_RUNTIME_FILES, stageRuntimeArchive } from '../sidecars/panel/archive.mjs';
import { Connection } from '../sidecars/panel/runtime.mjs';
import { PluginUpdater, releaseRuntimeDirectory, resolveSystemProxy } from '../sidecars/panel/updater.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));

function buildTarBuffer(entries) {
    const blocks = [];
    for (const { name, content = Buffer.alloc(0), type = '0' } of entries) {
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const header = Buffer.alloc(512);
        const nameBytes = Buffer.from(name, 'utf8');
        if (nameBytes.length > 99) {
            const paxPayload = Buffer.from(`path=${name}\n`, 'utf8');
            let recLen = paxPayload.length + 2;
            while (Buffer.byteLength(`${recLen} `, 'utf8') + paxPayload.length !== recLen) {
                recLen = Buffer.byteLength(`${recLen} `, 'utf8') + paxPayload.length;
            }
            const paxRecord = Buffer.concat([Buffer.from(`${recLen} `, 'utf8'), paxPayload]);
            const paxHeader = Buffer.alloc(512);
            Buffer.from('PaxHeaders.0/file', 'utf8').copy(paxHeader, 0);
            Buffer.from('0000644\0', 'ascii').copy(paxHeader, 100);
            Buffer.from('0000000\0', 'ascii').copy(paxHeader, 108);
            Buffer.from('0000000\0', 'ascii').copy(paxHeader, 116);
            Buffer.from(paxRecord.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(paxHeader, 124);
            Buffer.from('00000000000\0', 'ascii').copy(paxHeader, 136);
            paxHeader[156] = 'x'.charCodeAt(0);
            Buffer.from('ustar\0', 'ascii').copy(paxHeader, 257);
            Buffer.from('00', 'ascii').copy(paxHeader, 263);
            let sum = 0;
            for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : paxHeader[i];
            Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(paxHeader, 148);
            blocks.push(paxHeader, paxRecord, Buffer.alloc((512 - (paxRecord.length % 512)) % 512));
            nameBytes.subarray(0, 99).copy(header, 0);
        } else {
            nameBytes.copy(header, 0);
        }
        Buffer.from('0000644\0', 'ascii').copy(header, 100);
        Buffer.from('0000000\0', 'ascii').copy(header, 108);
        Buffer.from('0000000\0', 'ascii').copy(header, 116);
        Buffer.from(data.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(header, 124);
        Buffer.from('00000000000\0', 'ascii').copy(header, 136);
        header[156] = type.charCodeAt(0);
        Buffer.from('ustar\0', 'ascii').copy(header, 257);
        Buffer.from('00', 'ascii').copy(header, 263);
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
        Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
        blocks.push(header);
        if (data.length > 0 && type !== '5') {
            blocks.push(data);
            const pad = (512 - (data.length % 512)) % 512;
            if (pad) blocks.push(Buffer.alloc(pad));
        }
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}

function buildZipBuffer(entries, { compress = true } = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, content = Buffer.alloc(0), externalAttr = 0 } of entries) {
        const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const nameBuf = Buffer.from(name, 'utf8');
        const isDir = name.endsWith('/');
        const method = !isDir && compress ? 8 : 0;
        const compressed = isDir ? Buffer.alloc(0) : (method === 8 ? deflateRawSync(raw) : raw);
        const sum = isDir ? 0 : crc32(raw);

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(sum >>> 0, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        nameBuf.copy(local, 30);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x031e, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(sum >>> 0, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(externalAttr >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);

        locals.push(local, compressed);
        centrals.push(central);
        offset += local.length + compressed.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, eocd]);
}

async function collectPluginRuntimeEntries(sourceDir, { versionOverride = null, persistenceSuffix = '', prefix = '' } = {}) {
    const entries = [];
    for (const rel of REQUIRED_RUNTIME_FILES) {
        let data = await readFile(join(sourceDir, ...rel.split('/')));
        if (rel === 'plugin.json' && versionOverride) {
            const manifest = JSON.parse(data.toString('utf8'));
            manifest.version = versionOverride;
            data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        }
        if (rel === 'plugin/persistence.cjs' && persistenceSuffix) {
            data = Buffer.concat([data, Buffer.from('\n' + persistenceSuffix, 'utf8')]);
        }
        entries.push({ name: prefix ? `${prefix}/${rel}` : rel, content: data });
    }
    entries.push({ name: prefix ? `${prefix}/README.md` : 'README.md', content: 'ignored repo file' });
    return entries;
}

const tempRoot = await mkdtemp(join((await import('node:os')).tmpdir(), 'antigravity-ui-updater-'));
try {
    // 1. Archive parsing & security validation
    const validEntries = await collectPluginRuntimeEntries(project, { versionOverride: '0.3.9', prefix: 'Antigravity-Background-v0.3.9' });
    const paxEntries = [
        { name: 'pax-global', type: 'g', content: '52 comment=51e427b541f635c62eab3c977ab4d2109dbd4a5d\n' },
        ...validEntries,
        { name: 'Antigravity-Background-v0.3.9/sidecars/panel/very-long-directory-name-segment-that-exceeds-hundred-bytes-for-pax-testing/extra.txt', content: 'ok' },
    ];
    const parsedTar = parseTarGz(buildTarBuffer(paxEntries));
    assert.ok(parsedTar.some(e => e.parts.join('/') === 'Antigravity-Background-v0.3.9/plugin.json'));

    const realGitTar = execFileSync('git', ['-C', project, 'archive', '--format=tar.gz', '--prefix=Antigravity-Background-HEAD/', 'HEAD'], { maxBuffer: 16 * 1024 * 1024 });
    const parsedRealGitTar = parseTarGz(realGitTar);
    assert.ok(parsedRealGitTar.some(e => e.parts.join('/') === 'Antigravity-Background-HEAD/plugin.json'));

    const stageOkDir = join(tempRoot, 'stage-ok');
    const stagedList = await stageRuntimeArchive(buildTarBuffer(paxEntries), 'tar.gz', stageOkDir, '0.3.9');
    assert.ok(stagedList.includes('plugin.json'));
    assert.equal(stagedList.includes('README.md'), false, 'Non-runtime files must not be staged');

    const zipBuf = buildZipBuffer(validEntries);
    assert.ok(parseZip(zipBuf).some(e => e.parts.join('/') === 'Antigravity-Background-v0.3.9/plugin.json'));
    const stageZipDir = join(tempRoot, 'stage-zip-ok');
    await stageRuntimeArchive(zipBuf, 'zip', stageZipDir, '0.3.9');

    // Reject path traversal, symlinks, reserved names, duplicate case-insensitive entries, and version mismatch
    assert.throws(() => parseTarGz(buildTarBuffer([{ name: '../escape.txt', content: 'x' }])), /Unsafe archive path/);
    assert.throws(() => parseTarGz(buildTarBuffer([{ name: 'link', type: '2', content: '' }])), /Unsupported tar entry type/);
    assert.throws(() => parseZip(buildZipBuffer([{ name: 'CON.txt', content: 'x' }])), /Unsafe archive path/);
    assert.throws(() => parseZip(buildZipBuffer([{ name: 'sym', content: 'x', externalAttr: (0o120777 << 16) }])), /Unsupported zip entry mode/);
    assert.throws(() => parseZip(buildZipBuffer([{ name: 'Plugin.json', content: '{}' }, { name: 'plugin.json', content: '{}' }])), /Duplicate archive path/);
    await assert.rejects(
        stageRuntimeArchive(buildZipBuffer(validEntries), 'zip', join(tempRoot, 'stage-bad-ver'), '0.9.9'),
        /Package manifest mismatch/
    );
    await assert.rejects(
        stageRuntimeArchive(buildZipBuffer(validEntries.filter(e => !e.name.endsWith('main.mjs'))), 'zip', join(tempRoot, 'stage-incomplete'), '0.3.9'),
        /Incomplete runtime package/
    );

    // 2. Proxy resolution precedence
    const winProxyReader = async () => ({ server: '127.0.0.1:45331', bypass: ['localhost', '127.*', '<local>'] });
    assert.equal(await resolveSystemProxy('https://api.github.com/repos/a/b', {}, winProxyReader), 'http://127.0.0.1:45331');
    assert.equal(await resolveSystemProxy('https://api.github.com/repos/a/b', { NO_PROXY: 'localhost' }, winProxyReader), 'http://127.0.0.1:45331');
    assert.equal(await resolveSystemProxy('https://api.github.com/repos/a/b', { HTTPS_PROXY: '' }, winProxyReader), null);
    assert.equal(await resolveSystemProxy('https://api.github.com/repos/a/b', { HTTPS_PROXY: 'http://127.0.0.1:8888' }, winProxyReader), 'http://127.0.0.1:8888');
    assert.equal(await resolveSystemProxy('http://127.0.0.1:12345/api', { HTTPS_PROXY: 'http://127.0.0.1:8888' }, winProxyReader), null);

    // 3. releaseRuntimeDirectory on Windows
    let chdirTarget = null;
    assert.equal(
        releaseRuntimeDirectory('C:\\Users\\demo\\.gemini\\config\\plugins\\antigravity-ui', {
            platform: 'win32',
            cwd: () => 'C:\\Users\\demo\\.gemini\\config\\plugins\\antigravity-ui\\sidecars\\panel',
            chdir: dir => { chdirTarget = dir; },
        }),
        true
    );
    assert.equal(chdirTarget, 'C:\\Users\\demo\\.gemini\\config\\plugins\\antigravity-ui');

    // 4. Local mock GitHub HTTP Server exercising Release ZIP+SHA256, Tag Tarball + 429 HTML fallback, and main branch fallback
    let scenario = { mode: 'main', commit: '1111111111111111111111111111111111111111', version: '0.3.8', notes: 'initial main commit', rateLimitApi: false, corruptSha: false };
    let githubHitCount = 0;
    const mockAssets = new Map();

    const ghServer = createServer((req, res) => {
        githubHitCount++;
        const url = new URL(req.url, 'http://127.0.0.1');
        const base = `http://127.0.0.1:${ghServer.address().port}`;

        if (url.pathname === '/repos/KeS1Ke/Antigravity-Background/releases/latest') {
            if (scenario.rateLimitApi) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end('{"message":"rate limit"}');
                return;
            }
            if (scenario.mode === 'main') {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end('{"message":"Not Found"}');
                return;
            }
            const tag = `v${scenario.version}`;
            const assets = scenario.mode === 'release-zip'
                ? [
                    { name: `antigravity-background-${scenario.version}.zip`, size: mockAssets.get('zip').length, browser_download_url: `${base}/KeS1Ke/Antigravity-Background/releases/download/${tag}/antigravity-background-${scenario.version}.zip` },
                    { name: `antigravity-background-${scenario.version}.zip.sha256`, size: mockAssets.get('sha').length, browser_download_url: `${base}/KeS1Ke/Antigravity-Background/releases/download/${tag}/antigravity-background-${scenario.version}.zip.sha256` },
                ]
                : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tag_name: tag, draft: false, prerelease: false, body: scenario.notes, assets }));
            return;
        }

        if (url.pathname === '/KeS1Ke/Antigravity-Background/releases/latest') {
            if (scenario.mode === 'main') {
                res.writeHead(302, { Location: `${base}/KeS1Ke/Antigravity-Background/releases` });
                res.end();
                return;
            }
            res.writeHead(302, { Location: `${base}/KeS1Ke/Antigravity-Background/releases/tag/v${scenario.version}` });
            res.end();
            return;
        }
        if (url.pathname === '/KeS1Ke/Antigravity-Background/releases' || url.pathname.startsWith('/KeS1Ke/Antigravity-Background/releases/tag/')) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>releases</body></html>');
            return;
        }
        if (url.pathname.startsWith('/KeS1Ke/Antigravity-Background/releases/expanded_assets/')) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<div></div>');
            return;
        }
        if (url.pathname === '/KeS1Ke/Antigravity-Background/main/plugin.json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ name: 'antigravity-ui', version: scenario.version }));
            return;
        }
        if (url.pathname === '/repos/KeS1Ke/Antigravity-Background/commits/main') {
            if (scenario.rateLimitApi) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end('{"message":"API rate limit exceeded"}');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sha: scenario.commit, commit: { message: scenario.notes } }));
            return;
        }
        if (url.pathname === '/KeS1Ke/Antigravity-Background/commits/main.atom') {
            res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
            res.end(`<?xml version="1.0" encoding="UTF-8"?><feed><entry><id>tag:github.com,2008:Grit::Commit/${scenario.commit}</id><link href="/KeS1Ke/Antigravity-Background/commit/${scenario.commit}"/><title>${scenario.notes}</title></entry></feed>`);
            return;
        }
        if (url.pathname.endsWith('.zip')) {
            const buf = mockAssets.get('zip');
            res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(buf.length) });
            res.end(buf);
            return;
        }
        if (url.pathname.endsWith('.zip.sha256')) {
            const sha = scenario.corruptSha ? Buffer.from('0'.repeat(64) + '\n') : mockAssets.get('sha');
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(sha.length) });
            res.end(sha);
            return;
        }
        if (url.pathname.includes('/tar.gz/')) {
            const tarBuf = mockAssets.get('tar');
            res.writeHead(200, { 'Content-Type': 'application/gzip' });
            res.end(tarBuf);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise(resolve => ghServer.listen(0, '127.0.0.1', resolve));
    const ghBase = `http://127.0.0.1:${ghServer.address().port}`;
    const endpoints = { apiBase: ghBase, webBase: ghBase, rawBase: ghBase, codeloadBase: ghBase };

    const installHome = join(tempRoot, 'home');
    const installedPlugin = join(installHome, '.gemini', 'config', 'plugins', 'antigravity-ui');
    const installDataDir = join(tempRoot, 'sidecar-data');
    await mkdir(installedPlugin, { recursive: true });
    await mkdir(installDataDir, { recursive: true });
    for (const rootEntry of ['plugin.json', 'plugin', 'sidecars', 'assets']) {
        await cp(join(project, rootEntry), join(installedPlugin, rootEntry), { recursive: true });
    }
    await writeFile(join(installDataDir, 'settings.json'), JSON.stringify({ opacity: 55 }));

    // 4a. Dev workspace check -> canApply false
    const defaultUpdater = new PluginUpdater({ pluginDir: project, dataDir: join(tempRoot, 'def-data'), home: installHome });
    assert.equal(defaultUpdater.publicState().repoUrl, 'https://github.com/KeS1Ke/Antigravity-Background');
    const devUpdater = new PluginUpdater({ pluginDir: project, dataDir: join(tempRoot, 'dev-data'), home: installHome, endpoints });
    const devCheck = await devUpdater.check({ force: true });
    assert.equal(devCheck.state, 'current');
    assert.equal(devCheck.canApply, false);
    assert.equal(devCheck.applyDisabledReason, 'dev-workspace');
    assert.equal(devCheck.sourceKind, 'main');

    // 4b. Installed plugin without .install-source.json, same version 0.3.8 on main -> no false positive ('current')
    let reloadFired = false;
    const updater = new PluginUpdater({
        pluginDir: installedPlugin,
        dataDir: installDataDir,
        home: installHome,
        endpoints,
        onReload: () => { reloadFired = true; },
    });
    const sameVerCheck = await updater.check({ force: true });
    assert.equal(sameVerCheck.state, 'current');
    assert.equal(sameVerCheck.canApply, true);
    assert.equal(sameVerCheck.hasUpdate, false);

    // 4c. Release ZIP + SHA-256 corrupt checksum -> verification error & intact original files
    const zip039 = buildZipBuffer(await collectPluginRuntimeEntries(project, {
        versionOverride: '0.3.9',
        persistenceSuffix: '// updated persistence marker',
        prefix: 'antigravity-ui',
    }));
    const sha039 = Buffer.from(`${createHash('sha256').update(zip039).digest('hex')}  antigravity-background-0.3.9.zip\n`, 'utf8');
    mockAssets.set('zip', zip039);
    mockAssets.set('sha', sha039);
    scenario = { mode: 'release-zip', version: '0.3.9', notes: 'Release 0.3.9\n<img src="x">', rateLimitApi: false, corruptSha: true };
    const availZip = await updater.check({ force: true });
    assert.equal(availZip.state, 'available');
    assert.equal(availZip.sourceKind, 'release');
    await updater.apply({ version: '0.3.9' });
    while (updater.publicState().state === 'installing') await delay(30);
    assert.equal(updater.publicState().state, 'error');
    assert.equal(updater.publicState().error, 'verification');
    assert.equal(JSON.parse(await readFile(join(installedPlugin, 'plugin.json'), 'utf8')).version, '0.3.8');

    // 4d. Release ZIP + valid SHA-256 -> installs 0.3.9, flags persistenceUpdated, retains user settings.json
    scenario.corruptSha = false;
    await updater.check({ force: true });
    await updater.apply({ version: '0.3.9' });
    while (updater.publicState().state === 'installing') await delay(30);
    const afterZip = updater.publicState();
    assert.equal(afterZip.state, 'installed');
    assert.equal(afterZip.currentVersion, '0.3.9');
    assert.equal(afterZip.persistenceUpdated, true);
    assert.equal(JSON.parse(await readFile(join(installedPlugin, 'plugin.json'), 'utf8')).version, '0.3.9');
    assert.equal(JSON.parse(await readFile(join(installDataDir, 'settings.json'), 'utf8')).opacity, 55);

    // 4e. Tag-only Release (no zip asset) + API 429 rate limit -> HTML fallback + Tag .tar.gz install to 0.4.0
    updater.state.state = 'idle';
    mockAssets.set('tar', buildTarBuffer(await collectPluginRuntimeEntries(project, { versionOverride: '0.4.0', prefix: 'Antigravity-Background-v0.4.0' })));
    scenario = { mode: 'release-tar', version: '0.4.0', notes: '', rateLimitApi: true, corruptSha: false };
    const availTar = await updater.check({ force: true });
    assert.equal(availTar.state, 'available');
    assert.equal(availTar.latestVersion, '0.4.0');
    await updater.apply({ version: '0.4.0' });
    while (updater.publicState().state === 'installing') await delay(30);
    assert.equal(updater.publicState().state, 'installed');
    assert.equal(JSON.parse(await readFile(join(installedPlugin, 'plugin.json'), 'utf8')).version, '0.4.0');

    // 4f. Main branch commit-only update (0.4.0 -> 0.4.0 with new commit via Atom fallback)
    updater.state.state = 'idle';
    const oldCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const newCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await writeFile(join(installedPlugin, '.install-source.json'), JSON.stringify({ repo: 'KeS1Ke/Antigravity-Background', channel: 'main', version: '0.4.0', commit: oldCommit }));
    mockAssets.set('tar', buildTarBuffer(await collectPluginRuntimeEntries(project, { versionOverride: '0.4.0', prefix: `Antigravity-Background-${newCommit}` })));
    scenario = { mode: 'main', version: '0.4.0', commit: newCommit, notes: 'fix: commit update via atom', rateLimitApi: true, corruptSha: false };
    const availCommit = await updater.check({ force: true });
    assert.equal(availCommit.state, 'available');
    assert.equal(availCommit.updateReason, 'commit');
    assert.equal(availCommit.latestCommit, newCommit);
    await updater.apply({ version: '0.4.0', commit: newCommit });
    while (updater.publicState().state === 'installing') await delay(30);
    assert.equal(updater.publicState().state, 'installed');
    assert.equal(updater.publicState().currentCommit, newCommit);
    updater.state.state = 'idle';
    const settledCheck = await updater.check({ force: true });
    assert.equal(settledCheck.state, 'current');
    assert.equal(settledCheck.hasUpdate, false);

    // 4g. Reload invocation & HTTP proxy error classification (407 -> proxy without credential leaks)
    updater.state.state = 'installed';
    const reloadRes = updater.requestReload();
    assert.equal(reloadRes.state, 'reloading');
    await delay(450);
    assert.equal(reloadFired, true);

    // 4h. Interrupted transaction journal recovery + manage.cjs install .install-source.json
    const crashedTx = join(installDataDir, 'updates', 'tx-crashed-test');
    await mkdir(join(crashedTx, 'backup'), { recursive: true });
    await cp(join(installedPlugin, 'plugin.json'), join(crashedTx, 'backup', 'plugin.json'));
    await writeFile(join(crashedTx, 'backup', '.install-source.json'), await readFile(join(installedPlugin, '.install-source.json')));
    await writeFile(join(installedPlugin, 'plugin.json'), '{"name":"antigravity-ui","version":"0.0.0"}');
    await writeFile(join(installedPlugin, 'stale-orphan.txt'), 'remove me');
    await writeFile(join(crashedTx, 'journal.json'), JSON.stringify({
        schema: 1,
        phase: 'installing',
        oldFiles: ['plugin.json'],
        stagedFiles: ['plugin.json', 'stale-orphan.txt'],
        hadSourceMeta: true,
    }));
    await updater.recoverInterruptedTransactions();
    assert.equal(JSON.parse(await readFile(join(installedPlugin, 'plugin.json'), 'utf8')).version, '0.4.0');
    await assert.rejects(readFile(join(installedPlugin, 'stale-orphan.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(crashedTx, 'journal.json')), { code: 'ENOENT' });

    const cliHome = join(tempRoot, 'cli-home');
    const cliInstall = join(tempRoot, 'cli-app');
    await mkdir(cliInstall, { recursive: true });
    execFileSync(process.execPath, [join(project, 'manage.cjs'), 'install', cliInstall, cliHome], { stdio: 'pipe' });
    const cliSource = JSON.parse(await readFile(join(cliHome, '.gemini', 'config', 'plugins', 'antigravity-ui', '.install-source.json'), 'utf8'));
    assert.equal(cliSource.version, JSON.parse(await readFile(join(project, 'plugin.json'), 'utf8')).version);
    assert.equal(cliSource.commit, execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());

    const proxyAuthServer = net.createServer(socket => {
        socket.once('data', () => {
            socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        });
    });
    await new Promise(resolve => proxyAuthServer.listen(0, '127.0.0.1', resolve));
    const proxyPort = proxyAuthServer.address().port;
    try {
        const proxiedUpdater = new PluginUpdater({
            pluginDir: installedPlugin,
            dataDir: installDataDir,
            home: installHome,
            proxyResolver: async () => `http://user:secret-pass@127.0.0.1:${proxyPort}`,
        });
        const proxyFail = await proxiedUpdater.check({ force: true });
        assert.equal(proxyFail.state, 'error');
        assert.equal(proxyFail.error, 'network');
        assert.equal(proxyFail.errorDetail, 'proxy');
        assert.equal(JSON.stringify(proxyFail).includes('secret-pass'), false, 'Proxy credentials must never enter updater state');
    } finally {
        await new Promise(resolve => proxyAuthServer.close(resolve));
    }

    // 5. Real Sidecar HTTP + Headless Chrome browser UI integration (desktop + 320px narrow viewport)
    // Reset installed plugin to 0.3.8 for end-to-end UI flow
    await rm(installedPlugin, { recursive: true, force: true });
    await mkdir(installedPlugin, { recursive: true });
    for (const rootEntry of ['plugin.json', 'plugin', 'sidecars', 'assets']) {
        await cp(join(project, rootEntry), join(installedPlugin, rootEntry), { recursive: true });
    }
    const zip039Ui = buildZipBuffer(await collectPluginRuntimeEntries(project, { versionOverride: '0.3.9', prefix: 'antigravity-ui' }));
    mockAssets.set('zip', zip039Ui);
    mockAssets.set('sha', Buffer.from(`${createHash('sha256').update(zip039Ui).digest('hex')}  antigravity-background-0.3.9.zip\n`, 'utf8'));
    scenario = { mode: 'release-zip', version: '0.3.9', notes: 'UI release test\n<img src="https://evil.example/x.png">', rateLimitApi: false, corruptSha: false };

    const lsServer = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><body>host</body>'); });
    await new Promise(resolve => lsServer.listen(0, '127.0.0.1', resolve));
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const webPort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));

    const sidecarHitsBeforeClick = githubHitCount;
    const sidecarData = join(tempRoot, 'ui-sidecar-data');
    const sidecar = spawn(process.execPath, [join(installedPlugin, 'sidecars', 'panel', 'main.mjs')], {
        env: {
            ...process.env,
            AG_UI_HOME: installHome,
            AG_UI_PROFILE: join(tempRoot, 'ui-profile'),
            AG_UI_RESOURCES: process.env.AG_UI_RESOURCES || join(homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'resources'),
            AG_UI_UPDATE_ENDPOINTS: JSON.stringify(endpoints),
            ANTIGRAVITY_LS_ADDRESS: `http://127.0.0.1:${lsServer.address().port}/`,
            ANTIGRAVITY_CSRF_TOKEN: 'test',
            ANTIGRAVITY_SIDECAR_WEB_PORT: String(webPort),
            ANTIGRAVITY_SIDECAR_UI_TOKEN: 'test-updater',
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: sidecarData,
        },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let sidecarErr = '';
    sidecar.stderr.on('data', chunk => { sidecarErr += chunk; });

    const browserProfile = join(tempRoot, 'chrome-profile');
    const browser = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
        '--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
        '--remote-debugging-port=0', '--window-size=1000,750', '--user-data-dir=' + browserProfile,
        `http://127.0.0.1:${webPort}/?token=test-updater`,
    ], { windowsHide: true, stdio: 'ignore' });

    let pageClient;
    const until = async (fn, msg) => {
        for (let i = 0; i < 80; i++) {
            try { const v = await fn(); if (v) return v; } catch {}
            await delay(100);
        }
        throw new Error(msg + ' ' + sidecarErr.slice(-300));
    };
    const evalOn = async expr => {
        const res = await pageClient.command('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
        return res.result.value;
    };

    try {
        const cdpPort = await until(async () => Number((await readFile(join(browserProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chrome DevTools unavailable');
        const target = await until(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(r => r.json())).find(t => t.url.includes(`:${webPort}/`)), 'Panel target missing');
        pageClient = new Connection(target.webSocketDebuggerUrl);
        await pageClient.open();

        await until(() => evalOn('document.querySelector("#plugin-version")?.textContent === "v0.3.8"'), 'Initial version badge missing');
        assert.equal(githubHitCount, sidecarHitsBeforeClick, 'Opening panel must not trigger automatic GitHub network requests');
        assert.equal(await evalOn('document.querySelector("#github-link").getAttribute("href")'), `${ghBase}/KeS1Ke/Antigravity-Background`);

        // Narrow 320px sidebar layout check
        await pageClient.command('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
        const narrowLayout = await evalOn('({ overflow: document.documentElement.scrollWidth > window.innerWidth, btnRect: document.querySelector("#check-update").getBoundingClientRect().toJSON() })');
        assert.equal(narrowLayout.overflow, false, 'Header must not cause horizontal overflow at 320px');
        assert.ok(narrowLayout.btnRect.right <= 320.5 && narrowLayout.btnRect.width > 40);
        await pageClient.command('Emulation.clearDeviceMetricsOverride');

        // Click Check Update -> modal opens, shows Release 0.3.9, safe text notes, clickable GitHub release link
        await evalOn('document.querySelector("#check-update").click()');
        await until(() => evalOn('!document.querySelector("#update-modal").hidden && document.querySelector("#update-status-text").textContent === "发现新版本"'), 'Update modal did not show available release');
        assert.equal(await evalOn('document.querySelector("#update-source-badge").textContent'), 'Release');
        assert.equal(await evalOn('document.querySelector("#update-notes img")'), null, 'Release notes must render strictly as plain text');
        assert.ok((await evalOn('document.querySelector("#update-notes").textContent')).includes('<img'));
        assert.match(await evalOn('document.querySelector("#update-github-link").href'), /\/releases\/tag\/v0\.3\.9$/);

        // Apply update -> wait for installed -> click Reload plugin -> sidecar exits cleanly
        await evalOn('document.querySelector("#update-action").click()');
        await until(() => evalOn('document.querySelector("#update-status-text").textContent === "更新已完成"'), 'In-app update did not finish installing');
        assert.equal(JSON.parse(await readFile(join(installedPlugin, 'plugin.json'), 'utf8')).version, '0.3.9');
        assert.equal(await evalOn('document.querySelector("#update-action").textContent'), '重新加载插件');
        await evalOn('document.querySelector("#update-action").click()');
        await until(() => evalOn('document.querySelector("#update-status-text").textContent === "正在重新加载…"'), 'Reload button did not enter reloading state');
        await until(async () => sidecar.exitCode !== null, 'Sidecar did not exit on reload');
        assert.equal(sidecar.exitCode, 0);
    } finally {
        pageClient?.close();
        try { await pageClient?.command('Browser.close'); } catch {}
        browser.kill('SIGTERM');
        if (sidecar.exitCode === null) sidecar.kill('SIGTERM');
        await Promise.all([
            new Promise(r => sidecar.exitCode !== null ? r() : sidecar.once('exit', r)),
            new Promise(r => browser.exitCode !== null ? r() : browser.once('exit', r)),
        ]);
        await new Promise(r => lsServer.close(r));
        await new Promise(r => ghServer.close(r));
    }

    console.log('Passed: archive security, proxy resolution, Release ZIP/SHA256 & Tag tarball, main branch & Atom fallback, rollback guard, and Sidecar/Chrome updater UI.');
} finally {
    await rm(tempRoot, { recursive: true, force: true });
}
