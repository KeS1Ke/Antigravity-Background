import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Connection, WallpaperRuntime } from '../sidecars/panel/runtime.mjs';
import { installWallpaper } from '../sidecars/panel/renderer.mjs';
import { SettingsStore } from '../sidecars/panel/store.mjs';
import appearance from '../plugin/appearance.cjs';
import persistence from '../plugin/persistence.cjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(join((await import('node:os')).tmpdir(), 'antigravity-ui-test-'));
const profile = join(directory, 'profile-' + process.pid);
const data = join(directory, 'data-' + process.pid);
await mkdir(profile, { recursive: true });
await mkdir(data, { recursive: true });

const bitmap = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5S8AAAAASUVORK5CYII=';
const settings = appearance.normalize({ image: 'data:image/png;base64,' + bitmap, opacity: 100, mode: 'stretch', fade: 0, brightness: 100 });
const expectedImageHash = createHash('sha256').update(settings.image).digest('hex');

assert.equal(appearance.normalize({ sidebarTransparent: true }).sidebarCover, false);
assert.equal(appearance.normalize({ composerOpacity: 500 }).composerOpacity, 100);
assert.equal(appearance.normalize().composerOuterColor, '');
assert.equal(appearance.normalize().overviewOuterColor, '');
assert.equal(appearance.normalize().overviewInnerColor, '');
assert.equal(appearance.normalize().composerLayered, true);
assert.equal(appearance.normalize().bubbleLayered, true);
assert.equal(appearance.normalize({ composerInnerColor: '#AABBCC' }).composerInnerColor, '#aabbcc');
assert.deepEqual(
    (() => {
        const s = appearance.normalize({
            composerCover: false, composerLayered: false, composerOpacity: 42, composerBlur: 9,
            composerOuterColor: '#112233', composerInnerColor: '#AABBCC',
            overviewOpacity: 90, overviewBlur: 2, overviewOuterColor: '#ff0000',
        });
        return [
            s.bubbleCover, s.bubbleLayered, s.bubbleOpacity, s.bubbleBlur, s.bubbleOuterColor, s.bubbleInnerColor,
            s.overviewCover, s.overviewOpacity, s.overviewBlur, s.overviewOuterColor, s.overviewInnerColor,
        ];
    })(),
    [false, false, 42, 9, '#112233', '#aabbcc', true, 90, 2, '#ff0000', '']
);
assert.deepEqual(
    (() => {
        const s = appearance.normalize({
            composerCover: true, composerLayered: false, composerOpacity: 42, composerBlur: 9,
            bubbleCover: false, bubbleLayered: true, bubbleOpacity: 11, bubbleBlur: 3,
            overviewSync: true,
            overviewCover: false, overviewOpacity: 75, overviewBlur: 12,
            overviewOuterColor: '#445566', overviewInnerColor: '#778899',
        });
        return [
            s.bubbleCover, s.bubbleLayered, s.bubbleOpacity, s.bubbleBlur,
            s.overviewCover, s.overviewOpacity, s.overviewBlur, s.overviewOuterColor, s.overviewInnerColor,
            'overviewSync' in s, 'leftSidebarLayered' in s, 'sidebarLayered' in s, 'overviewLayered' in s,
        ];
    })(),
    [true, false, 42, 9, false, 75, 12, '#445566', '#778899', false, false, false, false]
);
assert.throws(() => appearance.normalize(null), /背景设置无效/);
assert.match(appearance.wallpaperStyle({ ...settings, mode: 'fill', scale: 50 }), /transform:\s*scale\(1\)/);
assert.match(appearance.wallpaperStyle({ ...settings, mode: 'stretch', scale: 40 }), /transform:\s*scale\(1\)/);
assert.match(appearance.wallpaperStyle({ ...settings, mode: 'fit', scale: 40 }), /transform:\s*scale\(1\)/);
assert.match(appearance.wallpaperStyle({ ...settings, mode: 'tile', scale: 50 }), /background-size:\s*256px 256px/);
assert.throws(() => appearance.normalize({ composerOuterColor: 'red; background:url(test)' }), /颜色/);
assert.throws(() => appearance.normalize({ composerInnerColor: 123 }), /颜色/);
assert.throws(() => appearance.normalize({ bubbleOuterColor: 'red' }), /颜色/);
assert.throws(() => appearance.normalize({ overviewOuterColor: 'blue' }), /颜色/);
assert.throws(() => appearance.normalize({ overviewInnerColor: '#123' }), /颜色/);
assert.equal(JSON.parse(await readFile(join(project, 'sidecars/panel/sidecar.json'), 'utf8')).ui_config.views[0].title, 'Antigravity Background');
await writeFile(join(data, 'settings.json'), '\uFEFF' + JSON.stringify(settings));

const fixture = '<!doctype html><style>body{margin:0;background:#18191c}.agy-inset-shell{position:absolute;inset:35px 0 0}.agy-sheet{height:100%;position:relative;z-index:0}.outline-none{display:flex;height:100%}.main{flex:1;position:relative;display:flex;flex-direction:column}.pane{width:300px;height:100%;background:#121315}.closed .pane{width:0;overflow:hidden}.surface-composer-card{backdrop-filter:none!important}.z-\\[1\\]{z-index:1}[data-testid="autoscroll-viewport"]{width:100%;height:160px;overflow:auto;isolation:isolate;mask-image:linear-gradient(to bottom,transparent,black 24px);-webkit-mask-image:linear-gradient(to bottom,transparent,black 24px)}[data-testid="overview-panel-overlay-backdrop"]{position:absolute;top:8px;right:8px;width:230px;height:100px;z-index:40}[data-testid="overview-panel-host-overlay"]{position:absolute;top:8px;right:8px;width:220px;height:90px;background:white;border:1px solid rgba(128,128,128,0.22);z-index:50}body[data-has-browser-hole="true"] .agy-sheet[data-sheet-inset] :is([data-main-content-body], [data-side-panel-body]){box-shadow:0 0 0 20px #121315;clip-path:inset(0 0 -8px 0)}body[data-has-browser-hole="true"] [data-split-sash]{background:#444343;background-image:linear-gradient(#ffffff,#ffffff)}body[data-has-three-layer-browser-hole="true"] [data-split-root="true"][data-split-three-layer-slide="true"][data-has-browser-hole="true"][data-split-transition] > [data-split-fill-edge]:not([data-has-browser-hole="true"]){clip-path:inset(0%)}</style>' +
    '<script>window.electronNative={setTitleBarOverlay:async options=>{window.titlebarOptions=options;}};window.__installLog=[];Object.defineProperty(window,"nativeStorage",{configurable:true,get(){window.__installLog.push({hasRenderer:Boolean(window.__antigravityUiRenderer),hasLayer:Boolean(document.querySelector("#antigravity-ui-background"))});return {};}});window.testRoots=new WeakMap();const original=Element.prototype.attachShadow;Element.prototype.attachShadow=function(o){const r=original.call(this,o);window.testRoots.set(this,r);return r;};</script>' +
    '<div class="agy-inset-shell"><div class="agy-sheet" data-sheet-inset="true"><div class="outline-none" data-split-root="true" data-split-three-layer-slide="true"><div data-split-fill-edge="right" style="flex:1;display:flex;min-width:0"><div class="main" data-main-content-body="true">' +
    '<div data-testid="autoscroll-viewport"><div style="height:260px;padding:12px">' +
    '<div class="agy-user-bubble-frame" id="regular-bubble-frame" style="background:white;padding:1px;border-radius:12px;margin-bottom:8px"><div data-testid="user-message-bubble" class="agy-user-bubble" id="regular-bubble" style="background:white;box-shadow:0 0 0 1px rgba(255,255,255,0.25);padding:8px 12px">User message</div></div>' +
    '<div class="agy-user-bubble-frame" id="proceeded-bubble-frame" style="background:white;padding:1px;border-radius:12px"><div class="agy-user-bubble" id="proceeded-bubble" style="background:white;box-shadow:0 0 0 1px rgba(255,255,255,0.25);padding:8px 12px">Proceeded with command</div></div>' +
    '</div></div>' +
    '<div class="relative z-10" style="position:relative;z-index:10;margin-top:24px"><div data-testid="agent-input-box"><div class="surface-composer" style="background:white"><div class="surface-composer-card" style="background:white;box-shadow:0 0 0 1px rgba(255,255,255,0.25);padding:20px"><div contenteditable="true" id="editor">Draft</div></div></div></div></div>' +
    '<div class="z-[1]" style="margin-top:16px"><div data-testid="agent-input-box"><div class="surface-composer" id="home-composer" style="background:rgba(20,20,24,0.8)"><div data-testid="input-box-bottom-toolbar" style="padding:6px 10px">Temp | Local Checkout</div><div class="surface-composer-card" id="home-composer-card" style="background:white;box-shadow:0 0 0 1px rgba(255,255,255,0.25);padding:12px"><div contenteditable="true" id="home-editor">Home draft</div></div></div></div></div>' +
    '<div data-testid="overview-panel-overlay-backdrop"></div>' +
    '<div data-testid="overview-panel-host-overlay">Overview</div>' +
    '</div></div><div data-split-sash="true" style="position:relative;z-index:30;width:1px;height:100%"><div data-testid="side-panel-sash" data-sash-handle="true" style="position:absolute;top:0;left:-4px;width:8px;height:100%"></div></div><div class="pane"><div class="h-full w-full" style="position:absolute;inset:0;z-index:10"><div class="browser-hole-ancestor"><div id="tabs" style="height:40px"><button id="tab">README.md</button></div><div class="flex-grow overflow-hidden" data-side-panel-body="true" style="height:calc(100% - 40px)"></div></div></div></div></div></div>' +
    '<div class="absolute right-0" style="position:absolute;right:0;top:0;z-index:50"><div id="window-tools" style="background:black"><div class="right-full" style="background:linear-gradient(to right,transparent,black)"></div><button id="toggle-side" style="width:40px;height:32px" onclick="document.querySelector(\'.outline-none\').classList.toggle(\'closed\')">Toggle</button></div></div></div>';

const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const host = 'http://127.0.0.1:' + server.address().port + '/';

const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const webPort = probe.address().port;
await new Promise(resolve => probe.close(resolve));

const embedServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><body style="margin:0;background:#1d1c1c"><iframe id="panel-frame" src="http://127.0.0.1:${webPort}/?token=test" style="width:320px;height:640px;border:0"></iframe></body>`);
});
await new Promise(resolve => embedServer.listen(0, 'localhost', resolve));
const embedUrl = 'http://localhost:' + embedServer.address().port + '/';

const environment = {
    ...process.env,
    USERPROFILE: join(directory, 'user'),
    AG_UI_RESOURCES: process.env.AG_UI_RESOURCES || join(homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'resources'),
    AG_UI_PROFILE: profile,
    ANTIGRAVITY_LS_ADDRESS: host,
    ANTIGRAVITY_CSRF_TOKEN: 'test',
    ANTIGRAVITY_SIDECAR_WEB_PORT: String(webPort),
    ANTIGRAVITY_SIDECAR_UI_TOKEN: 'test',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: data,
};
const sidecar = spawn(process.execPath, [join(project, 'sidecars', 'panel', 'main.mjs')], {
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
});
let errors = '';
sidecar.stderr.on('data', chunk => { errors += chunk; });

async function until(read, hint) {
    for (let n = 0; n < 100; n++) {
        try {
            const result = await read();
            if (result) return result;
        } catch {}
        await delay(100);
    }
    throw new Error(hint + ' ' + errors.slice(-300));
}

const browser = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
    '--remote-debugging-port=0', '--window-size=1000,750', '--user-data-dir=' + profile, host,
], { windowsHide: true, stdio: 'ignore' });

let client;
let panelClient;
let panelClient2;
let embedClient;
let iframeClient;
let host2Client;
let host3Client;
let duplicate;

async function evalOn(connection, expression, label = 'Browser expression') {
    const result = await connection.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(label + ' failed: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'exception'));
    return result.result.value;
}
const evaluate = expression => evalOn(client, expression, 'Host expression');

try {
    const port = await until(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Browser inspector unavailable');
    const target = await until(async () => (await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).find(t => t.url === host), 'Host target missing');
    client = new Connection(target.webSocketDebuggerUrl);
    await client.open();
    await until(() => evaluate('Boolean(document.querySelector("#antigravity-ui-background"))'), 'Runtime did not create background');

    const painted = await evaluate("(()=>{const layer=document.querySelector('#antigravity-ui-background');const image=window.testRoots.get(layer).querySelector('.image');const s=getComputedStyle(image);const r=image.getBoundingClientRect();return {background:s.backgroundImage,opacity:s.opacity,width:r.width,height:r.height}})()");
    assert(painted.background.startsWith('url("data:image/png;base64,'), 'Wallpaper must have an image in the rendered element');
    assert.equal(painted.opacity, '1');
    assert(painted.width > 0 && painted.height > 0);

    const settingsUrl = 'http://127.0.0.1:' + webPort + '/api/settings';
    await writeFile(join(data, 'settings.json'), '{broken');
    const damaged = await fetch(settingsUrl).then(reply => reply.json());
    assert.match(damaged.runtime.error, /设置文件已损坏/);
    assert.deepEqual(damaged.settings, settings);
    const repair = input => fetch(settingsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sidecar-token': 'test' },
        body: JSON.stringify(input),
    });
    assert.equal((await repair({ opacity: 50 })).status, 400);
    assert.equal(await readFile(join(data, 'settings.json'), 'utf8'), '{broken');
    const repaired = await repair({ ...damaged.settings, image: undefined, imageHash: damaged.imageHash });
    assert.equal(repaired.status, 200);
    assert.equal((await repaired.json()).runtime.error, '');
    assert.deepEqual(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')), settings);

    const nextProbe = createServer();
    await new Promise(resolve => nextProbe.listen(0, '127.0.0.1', resolve));
    const duplicatePort = nextProbe.address().port;
    await new Promise(resolve => nextProbe.close(resolve));
    duplicate = spawn(process.execPath, [join(project, 'sidecars', 'panel', 'main.mjs')], {
        env: { ...environment, ANTIGRAVITY_SIDECAR_WEB_PORT: String(duplicatePort) },
        windowsHide: true,
        stdio: 'ignore',
    });
    await until(async () => (await fetch('http://127.0.0.1:' + duplicatePort + '/api/settings')).ok, 'Second sidecar did not start');
    await evaluate("window.testLayer=document.querySelector('#antigravity-ui-background')");

    async function stable(opacity) {
        for (let i = 0; i < 15; i++) {
            const measured = await evaluate("(()=>{const layer=document.querySelector('#antigravity-ui-background');const image=window.testRoots.get(layer)?.querySelector('.image');return {same:layer===window.testLayer,hasImage:image&&getComputedStyle(image).backgroundImage.startsWith('url('),opacity:image&&getComputedStyle(image).opacity}})()");
            assert.equal(measured.same, true, 'Ownership handoff must reuse the visible layer');
            assert.equal(measured.hasImage, true, 'Wallpaper must stay visible between competing heartbeats');
            assert.equal(measured.opacity, opacity, 'A standby process must not overwrite the selected settings');
            await delay(150);
        }
    }
    await stable('1');

    async function save(targetPort, opacity, sidebarTransparent = false, overrides = {}) {
        const reply = await fetch('http://127.0.0.1:' + targetPort + '/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-sidecar-token': 'test' },
            body: JSON.stringify({ ...settings, opacity, sidebarTransparent, sidebarCover: !sidebarTransparent, ...overrides }),
        });
        assert.equal(reply.status, 200);
    }

    await save(webPort, 60);
    await stable('0.6');
    await save(duplicatePort, 40);
    await stable('0.4');

    const geometry = () => evaluate("(()=>{const layer=document.querySelector('#antigravity-ui-background');const image=window.testRoots.get(layer).querySelector('.image');const b=image.getBoundingClientRect();return {left:b.left,top:b.top,width:b.width,height:b.height}})()");
    const initialGeometry = await geometry();
    assert.equal(initialGeometry.top, 0);
    assert.equal(await evaluate('window.titlebarOptions.color'), '#00000000');

    await save(webPort, 40, true);
    assert.match(await evaluate("getComputedStyle(document.querySelector('.pane .flex-grow')).backgroundColor"), /(?:rgba\(0,\s*0,\s*0,\s*0\)|\/\s*0\))$/);
    assert.deepEqual(await geometry(), initialGeometry);

    await save(webPort, 40, false);
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.pane .flex-grow')).backgroundColor"), 'rgba(0, 0, 0, 0)');
    assert.deepEqual(await geometry(), initialGeometry);

    await save(webPort, 40, false, { sidebarOpacity: 35, sidebarBlur: 10, composerOpacity: 55, composerBlur: 6 });
    const surfaceState = () => evaluate("(()=>{const sidebar=getComputedStyle(document.querySelector('.pane .flex-grow'));const composer=getComputedStyle(document.querySelector('.surface-composer-card'));const outer=getComputedStyle(document.querySelector('.surface-composer'));const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');function rgba(color){g.clearRect(0,0,1,1);g.fillStyle=color;g.fillRect(0,0,1,1);return [...g.getImageData(0,0,1,1).data]}return{sidebarAlpha:rgba(sidebar.backgroundColor)[3],sidebarBlur:sidebar.backdropFilter,composerAlpha:rgba(composer.backgroundColor)[3],composerRgb:rgba(composer.backgroundColor).slice(0,3),composerBlur:composer.backdropFilter,composerShadow:composer.boxShadow,outerBg:outer.backgroundColor,outerBgAlpha:rgba(outer.backgroundColor)[3],outerBlur:outer.backdropFilter,outerShadow:outer.boxShadow,tools:getComputedStyle(document.querySelector('#window-tools')).backgroundColor}})()");
    const surfaces = await surfaceState();
    assert(Math.abs(surfaces.sidebarAlpha - 89) <= 1);
    assert.equal(surfaces.sidebarBlur, 'blur(10px)');
    assert(Math.abs(surfaces.composerAlpha - 140) <= 1);
    assert(Math.abs(surfaces.outerBgAlpha - 140) <= 1);
    assert.equal(surfaces.outerBlur, 'blur(6px)');
    assert.equal(surfaces.composerBlur, 'none');
    assert.notEqual(surfaces.composerShadow, 'none');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#tabs')).backgroundColor"), 'rgba(0, 0, 0, 0)');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane')).zIndex"), 'auto');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane > .h-full')).zIndex"), 'auto');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane .flex-grow')).zIndex"), '1001');
    const tabHit = await evaluate("(()=>{const e=document.querySelector('#tab'),b=e.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===e})()");
    assert.equal(tabHit, true, 'Wallpaper must not block tab clicks');

    await save(webPort, 40, false, { composerOuterColor: '#ff0000', composerInnerColor: '#00ff00' });
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.surface-composer-card')).backgroundColor"), 'color(srgb 0 1 0)');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.surface-composer')).backgroundColor"), 'color(srgb 1 0 0)');
    assert.match(await evaluate("getComputedStyle(document.querySelector('.surface-composer')).boxShadow"), /color\(srgb 1 0 0\).*inset/);
    assert.equal(surfaces.tools, 'rgba(0, 0, 0, 0)');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#window-tools > .right-full')).backgroundImage"), 'none');

    // Q3: Default empty composerOuterColor retains layered frame & inset border; composerCover: false removes fill while keeping transparent layered rim
    const insetBorder = /(?:0px ){3}1px.*inset|inset.*(?:0px ){3}1px/;
    await save(webPort, 40, false, { composerCover: true, composerOuterColor: '' });
    const defaultOuter = await surfaceState();
    assert.notEqual(defaultOuter.outerBg, 'rgba(0, 0, 0, 0)');
    assert.match(defaultOuter.outerShadow, insetBorder);

    await save(webPort, 40, false, { sidebarOpacity: 35, sidebarBlur: 10, composerCover: false, composerOpacity: 55, composerBlur: 6 });
    const uncovered = await surfaceState();
    assert.equal(uncovered.composerAlpha, 0);
    assert.equal(uncovered.outerBlur, 'blur(0px)');
    assert.equal(uncovered.outerBg, 'rgba(0, 0, 0, 0)');
    assert.match(uncovered.outerShadow, insetBorder);
    assert.notEqual(uncovered.composerShadow, 'none', 'Layered transparent mode must retain inner glass highlight/shadow');
    assert.equal(uncovered.sidebarAlpha, surfaces.sidebarAlpha);
    assert.deepEqual(await geometry(), initialGeometry);

    await save(webPort, 40, false, { sidebarOpacity: 35, sidebarBlur: 10, composerCover: false, composerOuterColor: '#ffffff', composerOpacity: 55, composerBlur: 6 });
    const uncoveredWithColor = await surfaceState();
    assert.equal(uncoveredWithColor.outerBg, 'rgba(0, 0, 0, 0)');
    assert.match(uncoveredWithColor.outerShadow, insetBorder);
    assert.equal(uncoveredWithColor.outerShadow, uncovered.outerShadow);

    await save(webPort, 40, false, { sidebarOpacity: 35, sidebarBlur: 10, composerCover: false, composerLayered: false, composerOuterColor: '#ffffff', composerOpacity: 55, composerBlur: 6 });
    const flatUncovered = await surfaceState();
    assert.equal(flatUncovered.outerBg, 'rgba(0, 0, 0, 0)');
    assert.equal(flatUncovered.composerShadow, 'none');
    assert.equal(flatUncovered.composerBlur, 'blur(0px)');

    const editorHit = await evaluate("(()=>{const e=document.querySelector('#editor'),b=e.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===e})()");
    assert.equal(editorHit, true, 'Composer must remain interactive above wallpaper');
    assert.equal(await evaluate("document.querySelector('#editor').textContent"), 'Draft');

    await save(webPort, 40, false);
    const hit = await evaluate("(()=>{const b=document.querySelector('#toggle-side').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,target:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.id}})()");
    assert.equal(hit.target, 'toggle-side', 'Opaque sidebar must not cover the close control');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await client.command('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    }
    assert.equal(await evaluate("document.querySelector('.outline-none').classList.contains('closed')"), true, 'Actual pointer click must close the sidebar');
    assert.deepEqual(await geometry(), initialGeometry);
    await evaluate("document.querySelector('.outline-none').classList.remove('closed')");
    const shot = await client.command('Page.captureScreenshot', { format: 'png' });
    assert(shot.data.length > 100);
    await evaluate("(async()=>{document.querySelector('.outline-none').classList.add('closed');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()");
    const closed = await evaluate("(()=>{const b=document.querySelector('#antigravity-ui-background').getBoundingClientRect();return {top:b.top,right:innerWidth-b.right}})()");
    assert.deepEqual(closed, { top: 0, right: 0 });
    assert.deepEqual(await geometry(), initialGeometry);
    await evaluate("(async()=>{document.querySelector('.outline-none').classList.remove('closed');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()");
    assert.deepEqual(await geometry(), initialGeometry);

    // Open standalone panel
    const pageTarget = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('http://127.0.0.1:' + webPort + '/?token=test'), { method: 'PUT' }).then(r => r.json());
    panelClient = new Connection(pageTarget.webSocketDebuggerUrl);
    await panelClient.open();
    const panel = expression => evalOn(panelClient, expression, 'Settings UI');
    const waitReady = (hint = 'Settings UI did not initialize') => until(() => panel("document.querySelector('#save')&&!document.querySelector('#save').disabled"), hint);
    const waitDiscard = () => until(() => panel("document.querySelector('#status').textContent.includes('已还原已保存设置')&&document.querySelector('#discard').disabled"), 'Discard did not restore saved settings');

    await waitReady();
    assert.equal(await panel('document.documentElement.dataset.embedded'), undefined);
    assert.equal(await panel('document.querySelector("#discard").disabled'), true);
    assert.notEqual(await panel('getComputedStyle(document.body).backgroundColor'), 'rgba(0, 0, 0, 0)');
    assert.notEqual(await panel('getComputedStyle(document.querySelector("footer")).backgroundColor'), 'rgba(0, 0, 0, 0)');
    const beforePreview = await readFile(join(data, 'settings.json'), 'utf8');

    // Q1: Direct 409 IMAGE_CACHE_MISS check + incremental preview omitting image + 409 frontend retry
    const missResponse = await fetch('http://127.0.0.1:' + webPort + '/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sidecar-token': 'test' },
        body: JSON.stringify({ ...settings, image: undefined, imageHash: '0'.repeat(64) }),
    });
    assert.equal(missResponse.status, 409);
    assert.equal((await missResponse.json()).code, 'IMAGE_CACHE_MISS');

    await panel("(()=>{const t=window.sidecar||window;window.__origFetch=t.fetch.bind(t);window.__previewLogs=[];window.__tamperNextMiss=false;t.fetch=async(path,options)=>{if(path==='/api/preview'&&options?.body){const parsed=JSON.parse(options.body);window.__previewLogs.push({hasImage:'image' in parsed,image:parsed.image,imageHash:parsed.imageHash,opacity:parsed.opacity});if(window.__tamperNextMiss&&!('image' in parsed)){window.__tamperNextMiss=false;options={...options,body:JSON.stringify({...parsed,imageHash:'0'.repeat(64)})};}}return window.__origFetch(path,options);};})()");
    await panel("(()=>{const i=document.querySelector('#wallpaper-opacity');i.value=55;i.dispatchEvent(new Event('input'));})()");
    await until(() => panel("window.__previewLogs.length>=1&&document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), 'Incremental preview did not apply');
    const firstLog = await panel('window.__previewLogs[0]');
    assert.equal(firstLog.hasImage, false, 'Incremental preview must omit image when unchanged');
    assert.equal(firstLog.imageHash, expectedImageHash);
    assert.equal(await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity"), '0.55');

    await panel("(()=>{window.__previewLogs=[];window.__tamperNextMiss=true;const i=document.querySelector('#wallpaper-opacity');i.value=63;i.dispatchEvent(new Event('input'));})()");
    await until(() => panel("window.__previewLogs.length>=2&&document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), '409 retry preview did not apply');
    const retryLogs = await panel('window.__previewLogs');
    assert.equal(retryLogs[0].hasImage, false);
    assert.equal(retryLogs[0].imageHash, expectedImageHash);
    assert.equal(retryLogs[1].hasImage, true, '409 IMAGE_CACHE_MISS must trigger automatic full-image retry');
    assert.equal(retryLogs[1].image, settings.image);
    assert.equal(await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity"), '0.63');
    await panel("(()=>{const t=window.sidecar||window;t.fetch=window.__origFetch;delete window.__origFetch;})()");
    await panel("document.querySelector('#discard').click()");
    await waitDiscard();

    // Existing live dragging, latest slider burst, and no persistence
    await panel("window.liveDragCount=0;window.liveDragTimer=setInterval(()=>{const input=document.querySelector('#wallpaper-opacity');input.value=20+(window.liveDragCount++%20);input.dispatchEvent(new Event('input'));},20)");
    await until(async () => Number(await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity")) < 0.4, 'Continuous dragging must update before pointer release');
    await panel('clearInterval(window.liveDragTimer)');
    await panel("(()=>{for(const value of [12,48,68]){const input=document.querySelector('#wallpaper-opacity');input.value=value;input.dispatchEvent(new Event('input'));}const color=document.querySelector('#composerInnerColor');color.value='#00ff00';color.dispatchEvent(new Event('input'));const blur=document.querySelector('#wallpaper-sidebarBlur');blur.value=9;blur.dispatchEvent(new Event('input'));})()");
    await until(async () => await panel("document.querySelector('#status').textContent.includes('实时预览')") && (await surfaceState()).sidebarBlur === 'blur(9px)' && await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity") === '0.68', 'Live preview did not apply');
    assert.equal(await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity"), '0.68');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.surface-composer-card')).backgroundColor"), 'color(srgb 0 1 0)');
    assert.equal((await surfaceState()).sidebarBlur, 'blur(9px)');
    await stable('0.68');
    assert.equal(await readFile(join(data, 'settings.json'), 'utf8'), beforePreview, 'Preview must never write settings');

    // Q4: Switching #theme updates panel data-theme locally without incrementing host generation
    const genBeforeTheme = await evaluate('window.__antigravityUiRenderer.generation');
    await panel("(()=>{const t=document.querySelector('#theme');t.value='light';t.dispatchEvent(new Event('change'));window.__themeAfterLight=document.documentElement.dataset.theme;})()");
    assert.equal(await panel('window.__themeAfterLight'), 'light');
    await panel("(()=>{const t=document.querySelector('#theme');t.value='dark';t.dispatchEvent(new Event('change'));window.__themeAfterDark=document.documentElement.dataset.theme;})()");
    assert.equal(await panel('window.__themeAfterDark'), 'dark');
    await delay(250);
    assert.equal(await panel("document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), true);
    assert.equal(await evaluate('window.__antigravityUiRenderer.generation'), genBeforeTheme, 'Theme-only preview must not trigger host CDP');

    // Q2: enabled: false clears all layers (including surfaces & titlebar) and standby heartbeat does not restore
    await panel("document.querySelector('#enabled').click()");
    await until(async () => !await evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), 'Disable preview did not apply');
    const disabledHost = await surfaceState();
    assert.equal(disabledHost.composerBlur, 'none');
    assert.deepEqual(disabledHost.composerRgb, [255, 255, 255]);
    assert.equal(disabledHost.sidebarBlur, 'none');
    assert.equal(disabledHost.outerShadow, 'none');
    assert.equal(await evaluate('window.titlebarOptions.color'), 'rgb(24, 25, 28)');
    assert.equal(await evaluate('window.__antigravityUiRenderer.empty'), true);
    assert.equal(await panel('getComputedStyle(document.documentElement).getPropertyValue("--ag-ui-sidebar-alpha").trim()'), '100%');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.z-\\\\[1\\\\]')).zIndex"), '1');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-testid=\"autoscroll-viewport\"]')).isolation"), 'isolate');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-testid=\"overview-panel-host-overlay\"]')).zIndex"), '50');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-outer').trim()"), 'var(--ag-ui-border)');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-overview-outer').trim()"), 'var(--ag-ui-border)');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-composer-blur').trim()"), '0px');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-overview-blur').trim()"), '0px');
    await delay(1800);
    assert.equal(await evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), false, 'Standby heartbeat must not undo disabled preview');
    assert.deepEqual((await surfaceState()).composerRgb, [255, 255, 255]);

    // Q4: Page.reload preserves in-memory draft, repopulates controls, enables #discard; clicking #discard restores saved state
    await panelClient.command('Page.reload');
    await waitReady('Reload with draft did not initialize');
    assert.equal(await panel("document.querySelector('#enabled').checked"), false);
    assert.equal(await panel("document.querySelector('#wallpaper-opacity').value"), '68');
    assert.equal(await panel("document.querySelector('#composerInnerColor').value"), '#00ff00');
    assert.equal(await panel("document.querySelector('#wallpaper-sidebarBlur').value"), '9');
    assert.equal(await panel("document.querySelector('#theme').value"), 'dark');
    assert.equal(await panel("document.documentElement.dataset.theme"), 'dark');
    assert.equal(await panel("document.querySelector('#discard').disabled"), false);
    assert.equal(await panel("document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), true);
    assert.equal(await evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), false);
    assert.equal(await readFile(join(data, 'settings.json'), 'utf8'), beforePreview);

    await panel("document.querySelector('#discard').click()");
    await waitDiscard();
    await until(() => evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), 'Discard did not restore saved appearance');
    assert.equal(await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity"), '0.4');
    assert.equal(await panel("document.querySelector('#enabled').checked"), true);
    assert.equal(await panel("document.querySelector('#composerInnerColor').value"), '#131313');
    assert.equal(await panel("document.querySelector('#theme').value"), 'system');

    // Q2 + Q3: opacity: 0 & #remove remove wallpaper layer while surfaces keep updating; color 'change' event works
    await panel("(()=>{const o=document.querySelector('#wallpaper-opacity');o.value=0;o.dispatchEvent(new Event('input'));const sb=document.querySelector('#wallpaper-sidebarBlur');sb.value=11;sb.dispatchEvent(new Event('input'));const c=document.querySelector('#composerInnerColor');c.value='#228844';c.dispatchEvent(new Event('change'));})()");
    await until(async () => !await evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), 'Opacity 0 did not remove background layer');
    let zeroSurface = await surfaceState();
    assert.equal(zeroSurface.sidebarBlur, 'blur(11px)');
    assert.deepEqual(zeroSurface.composerRgb, [34, 136, 68]);
    await panel("(()=>{const cb=document.querySelector('#wallpaper-composerBlur');cb.value=4;cb.dispatchEvent(new Event('input'));})()");
    await until(async () => (await surfaceState()).outerBlur === 'blur(4px)', 'Composer blur did not live-update at opacity 0');
    assert.equal(await evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), false);

    await panel("(()=>{const o=document.querySelector('#wallpaper-opacity');o.value=40;o.dispatchEvent(new Event('input'));})()");
    await until(() => evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), 'Restoring opacity above 0 did not bring back wallpaper');
    await panel("document.querySelector('#remove').click()");
    await until(async () => !await evaluate("Boolean(document.querySelector('#antigravity-ui-background'))") && await panel("document.querySelector('#remove').disabled&&!document.querySelector('#empty').hidden"), 'Remove did not clear background layer');
    await panel("(()=>{const sb=document.querySelector('#wallpaper-sidebarBlur');sb.value=13;sb.dispatchEvent(new Event('input'));const oc=document.querySelector('#composerOuterColor');oc.value='#ff0000';oc.dispatchEvent(new Event('change'));})()");
    await until(async () => (await surfaceState()).sidebarBlur === 'blur(13px)', 'Surfaces did not live-update after image removal');
    const removedSurface = await surfaceState();
    assert.match(removedSurface.outerShadow, /color\(srgb 1 0 0\).*inset/);
    assert.equal(await evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), false);
    await panel("document.querySelector('#discard').click()");
    await waitDiscard();
    await until(() => evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), 'Discard after remove did not restore wallpaper');

    // Q3: Subcontrol disabled states & removed layered/color controls for leftSidebar/sidebar
    assert.deepEqual(
        await panel("['#left-sidebar-layered','#leftSidebarOuterColor','#leftSidebarInnerColor','#sidebar-layered','#sidebarOuterColor','#sidebarInnerColor','#overview-sync','#overview-layered','#dialog-cover'].map(s=>document.querySelector(s)===null)"),
        [true, true, true, true, true, true, true, true, true]
    );
    assert.equal(await panel("document.querySelector('[data-reset-color=composerOuterColor]').disabled"), true);
    await panel("document.querySelector('#left-sidebar-cover').click()");
    assert.equal(await panel("document.querySelector('#wallpaper-leftSidebarOpacity').disabled"), true);
    assert.equal(await panel("document.querySelector('#wallpaper-leftSidebarBlur').disabled"), true);
    await panel("document.querySelector('#sidebar-cover').click()");
    assert.equal(await panel("document.querySelector('#wallpaper-sidebarOpacity').disabled"), true);
    assert.equal(await panel("document.querySelector('#wallpaper-sidebarBlur').disabled"), true);
    await panel("(()=>{const oc=document.querySelector('#composerOuterColor');oc.value='#2468ac';oc.dispatchEvent(new Event('input'));})()");
    assert.equal(await panel("document.querySelector('[data-reset-color=composerOuterColor]').disabled"), false);
    await panel("document.querySelector('#composer-cover').click()");
    assert.deepEqual(await panel("[document.querySelector('#composer-layered').disabled,document.querySelector('#composerOuterColor').disabled,document.querySelector('#composerInnerColor').disabled,document.querySelector('[data-reset-color=composerOuterColor]').disabled,document.querySelector('[data-reset-color=composerInnerColor]').disabled,document.querySelector('#wallpaper-composerOpacity').disabled,document.querySelector('#wallpaper-composerBlur').disabled]"), [false, true, true, true, true, true, true]);
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-outer').trim()"), 'var(--ag-ui-border)');
    await panel("document.querySelector('#overview-cover').click()");
    assert.deepEqual(await panel("[document.querySelector('#overviewOuterColor').disabled,document.querySelector('#overviewInnerColor').disabled,document.querySelector('[data-reset-color=overviewOuterColor]').disabled,document.querySelector('[data-reset-color=overviewInnerColor]').disabled,document.querySelector('#wallpaper-overviewOpacity').disabled,document.querySelector('#wallpaper-overviewBlur').disabled]"), [true, true, true, true, true, true]);
    await panel("document.querySelector('#discard').click()");
    await waitDiscard();

    // Existing accordion, color save, default outer border save, independent controls save, delayed preview/save, invalid 400
    assert.equal(await panel("document.querySelectorAll('input[type=range]').length"), 15);
    assert.equal(await panel("document.querySelectorAll('details').length"), 8);
    assert.equal(await panel("document.querySelector('#composer-cover').closest('details').open"), false);
    await panel("document.querySelector('#composer-cover').closest('details').querySelector('summary').click()");
    assert.equal(await panel("document.querySelector('#composer-cover').closest('details').open"), true);
    await panel("document.querySelector('#sidebar-cover').closest('details').querySelector('summary').click()");
    await panel("(()=>{for(const [id,color] of [['composerOuterColor','#2468ac'],['composerInnerColor','#13579b']]){const input=document.getElementById(id);input.value=color;input.dispatchEvent(new Event('input'));}document.querySelector('#save').click();})()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已保存')"), 'Colors did not save');
    await panelClient.command('Page.reload');
    await waitReady('Colors did not reload');
    assert.equal(await panel("document.querySelector('#composerOuterColor').value"), '#2468ac');
    assert.equal(await panel("document.querySelector('#composerInnerColor').value"), '#13579b');
    await panel("document.querySelector('[data-reset-color=composerOuterColor]').click();document.querySelector('#save').click()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已保存')"), 'Default color did not save');
    assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).composerOuterColor, '');
    assert.match((await surfaceState()).outerShadow, /(?:0px ){3}1px.*inset|inset.*(?:0px ){3}1px/);

    await panel("(()=>{document.querySelector('#composer-cover').click();const slider=document.querySelector('#wallpaper-sidebarBlur');slider.value=7;slider.dispatchEvent(new Event('input'));document.querySelector('#save').click();})()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已保存')"), 'Independent controls did not save');
    const persisted = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
    assert.equal(persisted.composerCover, false);
    assert.equal(persisted.sidebarBlur, 7);
    assert.equal(persisted.composerInnerColor, '#13579b');
    await panelClient.command('Page.reload');
    await waitReady('Settings UI did not reload');
    assert.equal(await panel("document.querySelector('#composer-cover').checked"), false);
    assert.equal(await panel("document.querySelector('#wallpaper-sidebarBlur').value"), '7');
    assert.equal(await panel("document.querySelector('#composerInnerColor').disabled"), true);
    assert.equal(await panel("document.querySelector('[data-reset-color=composerInnerColor]').disabled"), true);

    await panel(`(() => {
        const transport = window.sidecar || window;
        const original = transport.fetch.bind(transport);
        window.previewCount = 0;
        transport.fetch = async (path, options) => {
            if (path === '/api/preview') {
                window.previewCount++;
                if (window.previewCount === 1) await new Promise(resolve => { window.releasePreview = resolve; });
            }
            return original(path, options);
        };
        const input = document.querySelector('#wallpaper-opacity');
        input.value = 61;
        input.dispatchEvent(new Event('input'));
    })()`);
    await until(() => panel('Boolean(window.releasePreview)'), 'Delayed preview did not start');
    await panel("(()=>{const input=document.querySelector('#wallpaper-opacity');input.value=79;input.dispatchEvent(new Event('input'));document.querySelector('#save').click();})()");
    await panel(`(() => {
        const input = document.querySelector('#wallpaper-opacity');
        input.value = 76;
        input.dispatchEvent(new Event('input'));
        window.releasePreview();
    })()`);
    await until(() => panel("document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), 'Post-save edit did not preview');
    assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).opacity, 79);
    await delay(100);
    assert.equal(await panel('window.previewCount'), 2, 'Edits during save should post one follow-up preview');
    await panel("document.querySelector('#discard').click()");
    await waitDiscard();
    await delay(1800);
    assert.equal(await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity"), '0.79', 'Delayed preview must not overwrite saved values');

    const invalid = await fetch('http://127.0.0.1:' + webPort + '/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sidecar-token': 'test' },
        body: JSON.stringify({ ...settings, composerInnerColor: 'invalid' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).opacity, 79);

    // Drag preview modal only: inline #preview stays read-only & matches host aspect/layout
    await panelClient.command('Page.bringToFront');
    const hostDims = await evaluate('({w:window.innerWidth,h:window.innerHeight})');
    await panel("(()=>{document.querySelector('[data-mode=fill]').click();document.querySelector('#open-drag-preview').closest('details').open=true;})()");
    await until(() => panel("document.querySelector('#wallpaper-scale').min==='100'&&!document.querySelector('#open-drag-preview').disabled"), 'Drag preview button and scale floor did not initialize');
    const previewLayoutCheck = await panel("(()=>{const p=document.querySelector('#preview');return{draggable:p.dataset.draggable,hasBadge:Boolean(p.querySelector('.drag-stage-badge')),aspect:p.style.getPropertyValue('--ag-host-aspect').trim()}})()");
    assert.equal(previewLayoutCheck.draggable, undefined, 'Inline #preview must not be draggable');
    assert.equal(previewLayoutCheck.hasBadge, false, 'Inline #preview must not show drag badge');
    assert.equal(previewLayoutCheck.aspect, `${hostDims.w} / ${hostDims.h}`, 'Inline #preview aspect ratio must match live host window');
    const inlinePoint = await panel("(()=>{const el=document.querySelector('#preview');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: inlinePoint.x, y: inlinePoint.y, deltaX: 0, deltaY: -120 });
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: inlinePoint.x, y: inlinePoint.y });
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: inlinePoint.x, y: inlinePoint.y, button: 'left', clickCount: 1 });
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: inlinePoint.x + 25, y: inlinePoint.y + 20, button: 'left', buttons: 1 });
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inlinePoint.x + 25, y: inlinePoint.y + 20, button: 'left', clickCount: 1 });
    await delay(50);
    assert.deepEqual(
        await panel("[document.querySelector('#wallpaper-x').value,document.querySelector('#wallpaper-y').value,document.querySelector('#wallpaper-scale').value]"),
        ['50', '50', '100'],
        'Wheel/drag on inline #preview must not alter x, y, or scale'
    );

    assert.equal(await panel("document.querySelector('#open-drag-preview').closest('details').open"), true);
    await panel("document.querySelector('#open-drag-preview').click()");
    await until(() => panel("!document.querySelector('#drag-preview-modal').hidden&&document.querySelector('#drag-preview-stage').clientWidth>0"), 'Drag preview modal did not open');
    assert.equal(await panel('document.activeElement.id'), 'close-drag-preview');
    assert.equal(await panel("document.querySelector('#drag-preview-stage').style.getPropertyValue('--ag-host-aspect').trim()"), `${hostDims.w} / ${hostDims.h}`);
    assert.equal(await panel("document.querySelector('#drag-preview-stage').dataset.draggable"), 'true');
    await panel("(()=>{const m=document.querySelector('#drag-preview-mask');m.click();})()");
    assert.equal(await panel("document.querySelector('#drag-preview-stage').dataset.hideMask"), 'true');
    await panel("(()=>{const m=document.querySelector('#drag-preview-mask');m.click();})()");
    assert.equal(await panel("document.querySelector('#drag-preview-stage').dataset.hideMask"), 'false');
    const stagePoint = await panel("(()=>{const r=document.querySelector('#drag-preview-stage').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: stagePoint.x, y: stagePoint.y, deltaX: 0, deltaY: 120 });
    await delay(80);
    assert.equal(await panel("document.querySelector('#wallpaper-scale').value"), '100', 'Wheel zoom out must clamp at 100% minimum to protect viewport coverage');
    for (let i = 0; i < 4; i++) {
        await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: stagePoint.x, y: stagePoint.y, deltaX: 0, deltaY: -120 });
    }
    await until(() => panel("document.querySelector('#wallpaper-scale').value==='120'"), 'Wheel zoom in did not reach 120%');
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stagePoint.x, y: stagePoint.y });
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: stagePoint.x, y: stagePoint.y, button: 'left', clickCount: 1 });
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stagePoint.x + 40, y: stagePoint.y + 25, button: 'left', buttons: 1 });
    await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stagePoint.x + 40, y: stagePoint.y + 25, button: 'left', clickCount: 1 });
    const dragged = await panel("({x:Number(document.querySelector('#wallpaper-x').value),y:Number(document.querySelector('#wallpaper-y').value)})");
    assert(dragged.x < 50 && dragged.y < 50, `Expected drag right/down to shift x,y below 50%, got (${dragged.x}, ${dragged.y})`);
    await until(async () => await evaluate(`getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).backgroundPosition`) === `${dragged.x}% ${dragged.y}%`, 'Host backgroundPosition did not sync after preview drag');

    // Boundary clamp: dragging far past edges clamps within [0%, 100%] and keeps host image covering entire viewport
    for (const [dx, dy, expected] of [[-1200, -1200, '100'], [1200, 1200, '0']]) {
        await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stagePoint.x, y: stagePoint.y });
        await panelClient.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: stagePoint.x, y: stagePoint.y, button: 'left', clickCount: 1 });
        await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stagePoint.x + dx, y: stagePoint.y + dy, button: 'left', buttons: 1 });
        await panelClient.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stagePoint.x + dx, y: stagePoint.y + dy, button: 'left', clickCount: 1 });
        assert.equal(await panel("document.querySelector('#wallpaper-x').value"), expected);
        assert.equal(await panel("document.querySelector('#wallpaper-y').value"), expected);
        await until(async () => await evaluate(`getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).backgroundPosition`) === `${expected}% ${expected}%`, 'Clamped position did not sync to host');
        const coverBounds = await evaluate("(()=>{const layer=document.querySelector('#antigravity-ui-background');const lr=layer.getBoundingClientRect();const r=window.testRoots.get(layer).querySelector('.image').getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,l:lr.left,t:lr.top,w:lr.right,h:lr.bottom}})()");
        assert(coverBounds.left <= coverBounds.l + 0.5 && coverBounds.top <= coverBounds.t + 0.5 && coverBounds.right >= coverBounds.w - 0.5 && coverBounds.bottom >= coverBounds.h - 0.5, 'Viewport border uncovered after drag clamp: ' + JSON.stringify(coverBounds));
    }

    await panel("document.querySelector('#drag-preview-reset').click()");
    assert.equal(await panel("document.querySelector('#wallpaper-x').value"), '78');
    assert.equal(await panel("document.querySelector('#wallpaper-y').value"), '50');
    assert.equal(await panel("document.querySelector('#wallpaper-scale').value"), '100');
    await panel("document.querySelector('#close-drag-preview').click()");
    assert.equal(await panel("document.querySelector('#drag-preview-modal').hidden"), true);
    assert.equal(await panel('document.activeElement.id'), 'open-drag-preview');
    await panel("document.querySelector('#open-drag-preview').click();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    assert.equal(await panel("document.querySelector('#drag-preview-modal').hidden"), true);
    await panel("document.querySelector('#open-drag-preview').click();document.querySelector('#drag-preview-modal').click()");
    assert.equal(await panel("document.querySelector('#drag-preview-modal').hidden"), true);

    await panel(`(() => {
        document.querySelector('[data-mode="tile"]').click();
        document.querySelector('#open-drag-preview').click();
        document.querySelector('#drag-preview-stage').dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    })()`);
    assert.equal(await panel("document.querySelector('#wallpaper-scale').value"), '95');
    await panel("document.querySelector('#close-drag-preview').click();document.querySelector('#reset').click()");
    assert.equal(await panel("document.querySelector('[data-mode=tile]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await panel("document.querySelector('#wallpaper-x').value"), '78');

    await panel(`(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 3200;
        canvas.height = 1600;
        canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], 'wallpaper.png', { type: 'image/png' }));
        const input = document.querySelector('#image');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));
    })()`);
    await until(async () => {
        const { settings: resized } = await fetch(settingsUrl).then(reply => reply.json());
        return resized.imageWidth === 2560 && resized.imageHeight === 1280 && resized.image.startsWith('data:image/webp;');
    }, 'Local PNG upload did not preserve its aspect ratio when resized to WebP');

    await panel("document.querySelector('#discard').click()");
    await waitDiscard();

    // Q4 + Q5: Embedded iframe dark CSS var detection (color(srgb 0.115 0.111 0.111)) and transparent body/footer
    const embedTarget = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(embedUrl), { method: 'PUT' }).then(r => r.json());
    embedClient = new Connection(embedTarget.webSocketDebuggerUrl);
    await embedClient.open();
    const iframeTarget = await until(async () => (await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).find(t => t.type === 'iframe' && t.url.startsWith('http://127.0.0.1:' + webPort)), 'Embedded iframe target missing');
    iframeClient = new Connection(iframeTarget.webSocketDebuggerUrl);
    await iframeClient.open();
    await iframeClient.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await iframeClient.command('Page.enable');
    await iframeClient.command('Page.addScriptToEvaluateOnNewDocument', {
        source: "window.__reloadedWithCss=true;const apply=()=>document.documentElement?.style.setProperty('--background','color(srgb 0.115 0.111 0.111)');if(document.documentElement)apply();else new MutationObserver((_,o)=>{if(document.documentElement){apply();o.disconnect();}}).observe(document,{childList:true});",
    });
    await iframeClient.command('Runtime.evaluate', { expression: 'location.reload()' });
    const iframe = expression => evalOn(iframeClient, expression, 'Embedded panel');
    await until(() => iframe("window.__reloadedWithCss&&document.querySelector('#save')&&!document.querySelector('#save').disabled"), 'Embedded panel did not initialize');
    const embeddedState = await iframe("(()=>{const card=getComputedStyle(document.querySelector('.card'));const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');g.fillStyle=card.backgroundColor;g.fillRect(0,0,1,1);return{embedded:document.documentElement.dataset.embedded,theme:document.documentElement.dataset.theme,prefersLight:matchMedia('(prefers-color-scheme: light)').matches,bodyBg:getComputedStyle(document.body).backgroundColor,footerBg:getComputedStyle(document.querySelector('footer')).backgroundColor,cardAlpha:g.getImageData(0,0,1,1).data[3],overflow:document.documentElement.scrollWidth>window.innerWidth}})()");
    assert.equal(embeddedState.embedded, 'true');
    assert.equal(embeddedState.prefersLight, true);
    assert.equal(embeddedState.theme, 'dark', 'Initial host color(srgb 0.115 0.111 0.111) must resolve to dark even under light prefers-color-scheme');
    assert.equal(embeddedState.bodyBg, 'rgba(0, 0, 0, 0)', 'Embedded body must be transparent to avoid double opacity');
    assert.equal(embeddedState.footerBg, 'rgba(0, 0, 0, 0)', 'Embedded footer must be transparent');
    assert.equal(embeddedState.overflow, false, '320px embedded footer with discard button must not overflow horizontally');
    assert.equal(await iframe("(()=>{for(const d of document.querySelectorAll('details'))d.open=true;return document.documentElement.scrollWidth>window.innerWidth})()"), false, '320px embedded panel with all cards expanded must not overflow horizontally');

    await iframe("(()=>{const s=document.querySelector('#wallpaper-sidebarOpacity');s.value=20;s.dispatchEvent(new Event('input'));})()");
    await delay(160);
    const softCardAlpha = await iframe("(()=>{const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');g.fillStyle=getComputedStyle(document.querySelector('.card')).backgroundColor;g.fillRect(0,0,1,1);return g.getImageData(0,0,1,1).data[3]})()");
    assert(softCardAlpha < embeddedState.cardAlpha && softCardAlpha > 100, 'Embedded card should smoothly track sidebar alpha without double stacking');
    assert.equal(await iframe('getComputedStyle(document.body).backgroundColor'), 'rgba(0, 0, 0, 0)');
    await evalOn(embedClient, "document.querySelector('#panel-frame').contentWindow.postMessage({type:'theme-change',payload:{cssVariables:{'--background':'color(srgb 0.96 0.96 0.97)'}}},'*')", 'Parent theme-change light');
    await until(() => iframe("document.documentElement.dataset.theme==='light'"), 'Embedded iframe did not react to light theme-change');
    await evalOn(embedClient, "document.querySelector('#panel-frame').contentWindow.postMessage({type:'theme-change',payload:{cssVariables:{'--background':'color(srgb 0.115 0.111 0.111)'}}},'*')", 'Parent theme-change dark');
    await until(() => iframe("document.documentElement.dataset.theme==='dark'"), 'Embedded iframe did not react to dark theme-change');
    await iframe("document.querySelector('#discard').click()");
    await until(() => iframe("document.querySelector('#status').textContent.includes('已还原已保存设置')&&document.querySelector('#discard').disabled"), 'Embedded discard failed');

    // Q1: Host Page.reload clears renderer cache; sidecar recovers wallpaper & runtime handles NEED_IMAGE by resending full image once
    await client.command('Page.reload');
    await until(() => evaluate("Boolean(document.querySelector('#antigravity-ui-background'))"), 'Sidecar did not restore wallpaper after host reload');
    assert.equal(await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity"), '0.79');

    // Close embed page cleanly before multi-panel & 0.3.8 surface tests
    embedClient?.close();
    iframeClient?.close();
    embedClient = undefined;
    iframeClient = undefined;
    await fetch('http://127.0.0.1:' + port + '/json/close/' + embedTarget.id);
    await panelClient.command('Page.reload');
    await waitReady('Panel reload before 0.3.8 suite failed');

    const closeTarget = async (targetId, connection) => {
        connection?.close();
        if (!targetId) return;
        await fetch('http://127.0.0.1:' + port + '/json/close/' + targetId);
        await until(async () => !(await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).some(t => t.id === targetId), 'Target did not close: ' + targetId);
    };
    const approxRgba = (actual, expected, tolerance = 2) => {
        assert(Array.isArray(actual) && actual.length === 4, 'Expected RGBA array, got: ' + JSON.stringify(actual));
        for (let i = 0; i < 4; i++) {
            assert(Math.abs(actual[i] - expected[i]) <= tolerance, `RGBA[${i}] expected ~${expected[i]}, got ${actual[i]}`);
        }
    };
    const readHostSurfaces = connection => evalOn(connection, `(()=>{
        const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');
        const rgba=color=>{g.clearRect(0,0,1,1);g.fillStyle=color;g.fillRect(0,0,1,1);return[...g.getImageData(0,0,1,1).data]};
        const shadowRgba=shadow=>{const m=shadow&&shadow.match(/color\\([^)]+\\)|rgba?\\([^)]+\\)/);return m?rgba(m[0]):null};
        const layer=document.querySelector('#antigravity-ui-background');
        const img=layer&&window.testRoots.get(layer)?.querySelector('.image');
        const vp=document.querySelector('[data-testid="autoscroll-viewport"]');
        const vps=getComputedStyle(vp);
        const readBubble=(frameSel,bubbleSel)=>{
            const f=getComputedStyle(document.querySelector(frameSel));
            const b=getComputedStyle(document.querySelector(bubbleSel));
            return{frameBg:f.backgroundColor,frameBgRgba:rgba(f.backgroundColor),frameBlur:f.backdropFilter,frameShadow:f.boxShadow,frameRgba:shadowRgba(f.boxShadow),bgRgba:rgba(b.backgroundColor),blur:b.backdropFilter,shadow:b.boxShadow};
        };
        const bd=getComputedStyle(document.querySelector('[data-testid="overview-panel-overlay-backdrop"]'));
        const ov=getComputedStyle(document.querySelector('[data-testid="overview-panel-host-overlay"]'));
        const zw=getComputedStyle(document.querySelector('.z-\\\\[1\\\\]'));
        const hc=getComputedStyle(document.querySelector('#home-composer'));
        const hcc=getComputedStyle(document.querySelector('#home-composer-card'));
        const nc=getComputedStyle(document.querySelector('.relative.z-10 .surface-composer'));
        const ncc=getComputedStyle(document.querySelector('.relative.z-10 .surface-composer-card'));
        return{
            wallpaperOpacity:img?getComputedStyle(img).opacity:null,
            viewport:{isolation:vps.isolation,zIndex:vps.zIndex,maskImage:vps.maskImage,webkitMaskImage:vps.webkitMaskImage},
            regularBubble:readBubble('#regular-bubble-frame','#regular-bubble'),
            proceededBubble:readBubble('#proceeded-bubble-frame','#proceeded-bubble'),
            overview:{backdropZ:bd.zIndex,hostZ:ov.zIndex,bgRgba:rgba(ov.backgroundColor),blur:ov.backdropFilter,shadow:ov.boxShadow,borderColor:ov.borderTopColor,borderRgba:rgba(ov.borderTopColor)},
            homeComposer:{wrapperZ:zw.zIndex,outerBg:hc.backgroundColor,outerBgRgba:rgba(hc.backgroundColor),outerBlur:hc.backdropFilter,outerShadow:hc.boxShadow,outerShadowRgba:shadowRgba(hc.boxShadow),cardBg:hcc.backgroundColor,cardBgRgba:rgba(hcc.backgroundColor),cardBlur:hcc.backdropFilter,cardShadow:hcc.boxShadow},
            normalComposer:{outerBg:nc.backgroundColor,outerBgRgba:rgba(nc.backgroundColor),outerBlur:nc.backdropFilter,outerShadow:nc.boxShadow,outerShadowRgba:shadowRgba(nc.boxShadow),cardBg:ncc.backgroundColor,cardBgRgba:rgba(ncc.backgroundColor),cardBlur:ncc.backdropFilter,cardShadow:ncc.boxShadow},
        };
    })()`, 'Read host surfaces');

    // (c) Bound "输入框与对话框" card: composer + user bubbles + HOME_VIEW .z-[1] two-layer frame/card & flat toggle, never syncing Overview
    await panel("(()=>{const d=document.querySelector('#composer-cover').closest('details');if(!d.open)d.querySelector('summary').click();const cov=document.querySelector('#composer-cover');if(!cov.checked)cov.click();const set=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event('input'));};set('#composerOuterColor','#ff0000');set('#composerInnerColor','#00ff00');set('#wallpaper-composerOpacity',55);set('#wallpaper-composerBlur',6);})()");
    await until(async () => {
        const s = await readHostSurfaces(client);
        return s.homeComposer.outerBlur === 'blur(6px)' && s.regularBubble.frameBlur === 'blur(6px)';
    }, 'Bound composer + bubble layered preview did not update');
    const unifiedHome = await readHostSurfaces(client);
    assert.equal(unifiedHome.homeComposer.wrapperZ, '1001');
    approxRgba(unifiedHome.homeComposer.outerBgRgba, [255, 0, 0, 140]);
    assert.equal(unifiedHome.homeComposer.outerBlur, 'blur(6px)');
    assert.match(unifiedHome.homeComposer.outerShadow, insetBorder);
    approxRgba(unifiedHome.homeComposer.outerShadowRgba, [255, 0, 0, 140]);
    approxRgba(unifiedHome.homeComposer.cardBgRgba, [0, 255, 0, 140]);
    assert.equal(unifiedHome.homeComposer.cardBlur, 'none');
    assert.notEqual(unifiedHome.homeComposer.cardShadow, 'none');
    approxRgba(unifiedHome.normalComposer.outerBgRgba, [255, 0, 0, 140]);
    assert.equal(unifiedHome.normalComposer.outerBlur, 'blur(6px)');
    assert.match(unifiedHome.normalComposer.outerShadow, insetBorder);
    approxRgba(unifiedHome.normalComposer.outerShadowRgba, [255, 0, 0, 140]);
    approxRgba(unifiedHome.normalComposer.cardBgRgba, [0, 255, 0, 140]);
    assert.equal(unifiedHome.normalComposer.cardBlur, 'none');
    assert.notEqual(unifiedHome.normalComposer.cardShadow, 'none');
    for (const bubble of [unifiedHome.regularBubble, unifiedHome.proceededBubble]) {
        approxRgba(bubble.frameBgRgba, [255, 0, 0, 140]);
        assert.equal(bubble.frameBlur, 'blur(6px)');
        assert.match(bubble.frameShadow, insetBorder);
        approxRgba(bubble.frameRgba, [255, 0, 0, 140]);
        approxRgba(bubble.bgRgba, [0, 255, 0, 140]);
        assert.equal(bubble.blur, 'none');
        assert.notEqual(bubble.shadow, 'none');
    }
    assert.equal(unifiedHome.overview.blur, 'blur(0px)', 'Composer changes must never sync to Overview panel');
    assert.equal(unifiedHome.overview.shadow, 'none', 'Overview panel must remain flat');
    const homeEditorHit = await evaluate("(()=>{const e=document.querySelector('#home-editor'),b=e.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===e})()");
    assert.equal(homeEditorHit, true, 'HOME_VIEW composer editor must be interactive above wallpaper');

    // Toggle #composer-layered off -> flattens BOTH composers and user bubbles together
    await panel("document.querySelector('#composer-layered').click()");
    await until(async () => {
        const s = await readHostSurfaces(client);
        return s.homeComposer.cardShadow === 'none' && s.regularBubble.shadow === 'none';
    }, 'Disabling composerLayered did not flatten composer + bubbles');
    const flatHome = await readHostSurfaces(client);
    approxRgba(flatHome.homeComposer.outerBgRgba, [0, 255, 0, 140]);
    assert.equal(flatHome.homeComposer.cardBg, 'rgba(0, 0, 0, 0)');
    assert.equal(flatHome.normalComposer.outerBg, 'rgba(0, 0, 0, 0)');
    assert.equal(flatHome.normalComposer.cardBlur, 'blur(6px)');
    assert.equal(flatHome.normalComposer.cardShadow, 'none');
    for (const bubble of [flatHome.regularBubble, flatHome.proceededBubble]) {
        assert.equal(bubble.frameBg, 'rgba(0, 0, 0, 0)');
        assert.equal(bubble.frameBlur, 'none');
        approxRgba(bubble.bgRgba, [0, 255, 0, 140]);
        assert.equal(bubble.blur, 'blur(6px)');
        assert.equal(bubble.shadow, 'none');
    }
    await panel("document.querySelector('#composer-layered').click()");
    await until(async () => {
        const s = await readHostSurfaces(client);
        return s.homeComposer.cardShadow !== 'none' && s.regularBubble.shadow !== 'none';
    }, 'Re-enabling composerLayered did not restore layered depth');

    await panel("document.querySelector('#composer-cover').click()");
    await until(async () => {
        const s = await readHostSurfaces(client);
        return s.homeComposer.outerBgRgba[3] === 0 && s.regularBubble.bgRgba[3] === 0;
    }, 'Disabling composerCover did not clear composer + bubble colors');
    const uncoveredHome = await readHostSurfaces(client);
    assert.equal(uncoveredHome.homeComposer.outerBlur, 'blur(0px)');
    assert.match(uncoveredHome.homeComposer.outerShadow, insetBorder);
    assert.notDeepEqual(uncoveredHome.homeComposer.outerShadowRgba.slice(0, 3), [255, 0, 0]);
    assert.equal(uncoveredHome.homeComposer.cardBg, 'rgba(0, 0, 0, 0)');
    assert.notEqual(uncoveredHome.homeComposer.cardShadow, 'none', 'Layered transparent HOME_VIEW composer retains raised glass rim/shadow');
    for (const bubble of [uncoveredHome.regularBubble, uncoveredHome.proceededBubble]) {
        assert.equal(bubble.frameBg, 'rgba(0, 0, 0, 0)');
        assert.equal(bubble.bgRgba[3], 0);
        assert.equal(bubble.frameBlur, 'blur(0px)');
        assert.match(bubble.frameShadow, insetBorder);
        assert.notDeepEqual(bubble.frameRgba.slice(0, 3), [255, 0, 0]);
        assert.notEqual(bubble.shadow, 'none', 'Layered transparent bubble retains inner rim/shadow');
    }
    await panel("document.querySelector('#discard').click()");
    await waitDiscard();

    // (a) Independent "Overview 面板" card: flat rendering, zero composer/bubble coupling & non-leaking disabled controls
    await panel("(()=>{const d=document.querySelector('#overview-cover').closest('details');if(!d.open)d.querySelector('summary').click();})()");
    assert.equal(await panel("document.querySelector('#overview-cover').closest('details').open"), true);
    await panel("(()=>{const set=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event('input'));};set('#overviewOuterColor','#0000ff');set('#overviewInnerColor','#ffff00');set('#wallpaper-overviewOpacity',30);set('#wallpaper-overviewBlur',12);})()");
    await until(async () => (await readHostSurfaces(client)).overview.blur === 'blur(12px)', 'Independent Overview adjustment did not apply');
    const splitHost = await readHostSurfaces(client);
    assert.equal(splitHost.overview.backdropZ, '1002');
    assert.equal(splitHost.overview.hostZ, '1002');
    approxRgba(splitHost.overview.bgRgba, [255, 255, 0, 77]);
    approxRgba(splitHost.overview.borderRgba, [0, 0, 255, 77]);
    assert.equal(splitHost.overview.blur, 'blur(12px)');
    assert.equal(splitHost.overview.shadow, 'none', 'Overview panel must remain flat without layered box-shadow');
    const overviewHit = await evaluate("(()=>{const e=document.querySelector('[data-testid=\"overview-panel-host-overlay\"]'),b=e.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===e})()");
    assert.equal(overviewHit, true, 'Overview panel at z-index 1002 must be interactive above wallpaper');
    for (const bubble of [splitHost.regularBubble, splitHost.proceededBubble]) {
        assert.equal(bubble.frameBlur, 'blur(0px)', 'Overview adjustment must never affect user bubbles');
    }
    assert.equal(splitHost.homeComposer.outerBlur, 'blur(0px)', 'Overview adjustment must never affect composer');

    const overviewPreviewVars = await panel("(()=>{const s=document.querySelector('#preview').style;const get=k=>s.getPropertyValue(k).trim();return{oOut:get('--preview-overview-outer'),oIn:get('--preview-overview-inner'),oBlur:get('--preview-overview-blur'),cBlur:get('--preview-composer-blur')}})()");
    assert.match(overviewPreviewVars.oOut, /#0000ff.*30%/);
    assert.match(overviewPreviewVars.oIn, /#ffff00.*30%/);
    assert.notEqual(overviewPreviewVars.oBlur, '0px');
    assert.equal(overviewPreviewVars.cBlur, '0px');

    // Turn off #overview-cover -> subcontrols disabled & hidden colors do not leak
    await panel("document.querySelector('#overview-cover').click()");
    assert.deepEqual(await panel("[document.querySelector('#overviewOuterColor').disabled,document.querySelector('#overviewInnerColor').disabled,document.querySelector('[data-reset-color=\"overviewOuterColor\"]').disabled,document.querySelector('[data-reset-color=\"overviewInnerColor\"]').disabled,document.querySelector('#wallpaper-overviewOpacity').disabled,document.querySelector('#wallpaper-overviewBlur').disabled]"), [true, true, true, true, true, true]);
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-overview-outer').trim()"), 'var(--ag-ui-border)');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-overview-blur').trim()"), '0px');
    await until(async () => (await readHostSurfaces(client)).overview.blur === 'blur(0px)', 'Disabling overviewCover did not clear Overview blur');
    const uncoveredOverview = await readHostSurfaces(client);
    assert.equal(uncoveredOverview.overview.bgRgba[3], 0);
    assert.equal(uncoveredOverview.overview.blur, 'blur(0px)');
    assert.notDeepEqual(uncoveredOverview.overview.borderRgba.slice(0, 3), [0, 0, 255]);
    await panel("document.querySelector('#discard').click()");
    await waitDiscard();

    // (b) Scrollable autoscroll-viewport mask-image vs Backdrop Filter (driven by composerBlur -> bound composer + bubble blur)
    await evaluate("document.querySelector('[data-testid=\"autoscroll-viewport\"]').scrollTop = 20");
    const blurZeroState = await readHostSurfaces(client);
    assert.equal(blurZeroState.viewport.isolation, 'auto');
    assert.equal(blurZeroState.viewport.zIndex, '1001');
    assert.match(blurZeroState.viewport.maskImage, /linear-gradient/);
    assert.match(blurZeroState.viewport.webkitMaskImage, /linear-gradient/);

    await panel("(()=>{const c=document.querySelector('#composer-cover');if(!c.checked)c.click();const b=document.querySelector('#wallpaper-composerBlur');b.value=10;b.dispatchEvent(new Event('input'));})()");
    await until(async () => (await readHostSurfaces(client)).regularBubble.frameBlur === 'blur(10px)', 'composerBlur > 0 did not apply to bubbles');
    const blurActiveState = await readHostSurfaces(client);
    assert.equal(blurActiveState.viewport.isolation, 'auto');
    assert.equal(blurActiveState.viewport.zIndex, '1001');
    assert.equal(blurActiveState.viewport.maskImage, 'none');
    assert.equal(blurActiveState.viewport.webkitMaskImage, 'none');
    assert.equal(blurActiveState.proceededBubble.frameBlur, 'blur(10px)');
    assert.equal(blurActiveState.homeComposer.outerBlur, 'blur(10px)');

    await panel("(()=>{const b=document.querySelector('#wallpaper-composerBlur');b.value=0;b.dispatchEvent(new Event('input'));const c=document.querySelector('#composer-cover');if(c.checked)c.click();})()");
    await until(async () => (await readHostSurfaces(client)).regularBubble.frameBlur === 'blur(0px)', 'Resetting composerBlur to 0 did not clear blur');
    assert.match((await readHostSurfaces(client)).viewport.maskImage, /linear-gradient/);
    await until(() => panel("document.querySelector('#discard').disabled"), 'Reverting composerBlur and composerCover to saved values should clear draft');

    // (e) Left Sidebar & Right Panel flat rendering (no top-left inset seam, aligned right tab strip) + transparent mode + native themes
    await evaluate(`(()=>{
        const shell=document.querySelector('.agy-inset-shell');
        const sheet=document.querySelector('.agy-sheet');
        const split=document.createElement('div');
        split.id='test-sidebar-split';
        split.setAttribute('data-testid','sidebar-split');
        split.setAttribute('data-split-root','true');
        split.style.cssText='display:flex;width:100%;height:100%;';
        const leftDock=document.createElement('div');
        leftDock.id='test-left-dock';
        leftDock.className='flex';
        leftDock.style.cssText='width:180px;height:100%;flex-shrink:0;';
        leftDock.innerHTML='<div class="h-full w-full flex flex-col pb-2 bg-sidebar" id="test-left-shell"><div class="px-2">Nav</div><div class="flex-1 min-h-0 overflow-y-auto outline-none flex flex-col py-3" id="test-left-inner"><div class="w-full relative flex-1 min-h-0 h-full"><div data-testid="conversation-list-sidebar" class="relative w-full h-full overflow-y-auto px-2"><div class="bg-sidebar" id="test-left-sticky" style="background:rgb(60,60,60)">Sticky</div><div class="agy-sidebar-row bg-sidebar-secondary" data-selected="true" id="test-left-selected"><span class="agy-row-actions">Row</span></div></div></div></div></div>';
        shell.insertBefore(split, sheet);
        split.append(leftDock, sheet);
        document.querySelector('#tabs').setAttribute('data-side-panel-strip','true');
    })()`);
    try {
        await panel(`(()=>{
            for (const sel of ['#left-sidebar-cover', '#sidebar-cover', '#composer-cover']) {
                const d = document.querySelector(sel).closest('details');
                if (!d.open) d.querySelector('summary').click();
            }
            const set = (s, v) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('input')); };
            set('#wallpaper-leftSidebarOpacity', 40);
            set('#wallpaper-leftSidebarBlur', 8);
            set('#wallpaper-sidebarOpacity', 50);
            set('#wallpaper-sidebarBlur', 10);
        })()`);
        const readSideSurfaces = () => evaluate(`(()=>{
            const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');
            const rgba=color=>{g.clearRect(0,0,1,1);g.fillStyle=color;g.fillRect(0,0,1,1);return[...g.getImageData(0,0,1,1).data]};
            const ld=getComputedStyle(document.querySelector('#test-left-dock'));
            const ls=getComputedStyle(document.querySelector('#test-left-shell'));
            const lstick=getComputedStyle(document.querySelector('#test-left-sticky'));
            const li=getComputedStyle(document.querySelector('#test-left-inner'));
            const lsel=getComputedStyle(document.querySelector('#test-left-selected'));
            const rs=getComputedStyle(document.querySelector('.pane .browser-hole-ancestor'));
            const rtEl=document.querySelector('#tabs');
            const rt=getComputedStyle(rtEl);
            const rbEl=document.querySelector('.pane [data-side-panel-body]');
            const rb=getComputedStyle(rbEl);
            const mainEl=document.querySelector('[data-main-content-body]');
            return {
                left:{dockZ:ld.zIndex,shellBg:rgba(ls.backgroundColor),shellBlur:ls.backdropFilter,shellShadow:ls.boxShadow,stickyBg:lstick.backgroundColor,innerBg:rgba(li.backgroundColor),innerShadow:li.boxShadow,innerRadius:li.borderRadius,selectedShadow:lsel.boxShadow},
                right:{shellZ:rs.zIndex,shellBg:rgba(rs.backgroundColor),shellBlur:rs.backdropFilter,tabsBg:rt.backgroundColor,tabsTop:Math.round(rtEl.getBoundingClientRect().top),mainTop:Math.round(mainEl.getBoundingClientRect().top),bodyTop:Math.round(rbEl.getBoundingClientRect().top),bodyBg:rgba(rb.backgroundColor),bodyBlur:rb.backdropFilter,bodyShadow:rb.boxShadow,bodyRadius:rb.borderRadius},
            };
        })()`);
        await until(async () => (await readSideSurfaces()).right.bodyBlur === 'blur(10px)' && (await readSideSurfaces()).left.shellBlur === 'blur(8px)', 'Left sidebar & right panel flat styles did not apply');
        const flatSides = await readSideSurfaces();
        assert.equal(flatSides.left.dockZ, '1001');
        approxRgba(flatSides.left.shellBg, [19, 19, 19, 102]);
        assert.equal(flatSides.left.shellBlur, 'blur(8px)');
        assert.equal(flatSides.left.shellShadow, 'none', 'Left sidebar shell must not render an inset border/shadow seam below titlebar');
        assert.equal(flatSides.left.stickyBg, 'rgba(0, 0, 0, 0)');
        assert.equal(flatSides.left.innerBg[3], 0);
        assert.equal(flatSides.left.innerShadow, 'none');
        assert.equal(flatSides.left.innerRadius, '0px');
        assert.equal(flatSides.left.selectedShadow, 'none');
        assert.equal(flatSides.right.shellZ, 'auto');
        assert.equal(flatSides.right.shellBg[3], 0);
        assert.equal(flatSides.right.shellBlur, 'none');
        assert.equal(flatSides.right.tabsBg, 'rgba(0, 0, 0, 0)');
        assert.equal(flatSides.right.tabsTop, flatSides.right.mainTop, 'Right panel tab strip top must stay aligned with main header');
        assert.equal(flatSides.right.bodyTop - flatSides.right.tabsTop, 40, 'Right panel body must begin flush under tab strip');
        approxRgba(flatSides.right.bodyBg, [19, 19, 19, 128]);
        assert.equal(flatSides.right.bodyBlur, 'blur(10px)');
        assert.equal(flatSides.right.bodyShadow, 'none');
        assert.equal(flatSides.right.bodyRadius, '0px');

        // Turn off #left-sidebar-cover & #sidebar-cover -> completely transparent flat surfaces with no card rim/shadow
        await panel("(()=>{document.querySelector('#left-sidebar-cover').click();document.querySelector('#sidebar-cover').click();})()");
        await until(async () => (await readSideSurfaces()).left.shellBlur === 'blur(0px)' && (await readSideSurfaces()).right.bodyBlur === 'blur(0px)', 'Disabling sidebar covers did not clear blur');
        const clearSides = await readSideSurfaces();
        assert.equal(clearSides.left.shellBg[3], 0);
        assert.equal(clearSides.left.shellShadow, 'none');
        assert.equal(clearSides.left.innerBg[3], 0);
        assert.equal(clearSides.left.innerShadow, 'none');
        assert.equal(clearSides.right.bodyBg[3], 0);
        assert.equal(clearSides.right.bodyShadow, 'none');

        // Default empty OuterColor/InnerColor under native Antigravity dark & light body[data-agy-theme] produces two-tone depth
        await panel(`(()=>{
            const d=document.querySelector('#composer-cover').closest('details');
            if(!d.open)d.querySelector('summary').click();
            if(!document.querySelector('#composer-cover').checked)document.querySelector('#composer-cover').click();
            for(const key of ['composerOuterColor','composerInnerColor']){
                const btn=document.querySelector('[data-reset-color="'+key+'"]');
                if(!btn.disabled)btn.click();
            }
        })()`);
        await until(async () => (await readHostSurfaces(client)).homeComposer.outerBgRgba[3] > 0 && (await readHostSurfaces(client)).homeComposer.cardBgRgba[3] > 0, 'Composer cover with default colors did not apply');
        const checkNativeThemes = await evaluate(`(()=>{
            const root=document.documentElement;
            const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');
            const rgba=color=>{g.clearRect(0,0,1,1);g.fillStyle=color;g.fillRect(0,0,1,1);return[...g.getImageData(0,0,1,1).data]};
            document.body.dataset.agyTheme='';
            document.body.classList.add('dark');
            root.style.setProperty('--onyx-frame','#424141');
            root.style.setProperty('--onyx-raised','#4a4949');
            const darkOuter=rgba(getComputedStyle(document.querySelector('#home-composer')).backgroundColor);
            const darkInner=rgba(getComputedStyle(document.querySelector('#home-composer-card')).backgroundColor);
            document.body.classList.remove('dark');
            root.style.setProperty('--onyx-frame','#f1f3f6');
            root.style.setProperty('--onyx-raised','#ffffff');
            const lightOuter=rgba(getComputedStyle(document.querySelector('#home-composer')).backgroundColor);
            const lightInner=rgba(getComputedStyle(document.querySelector('#home-composer-card')).backgroundColor);
            delete document.body.dataset.agyTheme;
            root.style.removeProperty('--onyx-frame');
            root.style.removeProperty('--onyx-raised');
            return {darkOuter,darkInner,lightOuter,lightInner};
        })()`);
        assert(checkNativeThemes.darkOuter[3] > 0 && checkNativeThemes.darkOuter[0] < checkNativeThemes.darkInner[0], `Dark default outer frame (${checkNativeThemes.darkOuter}) must be darker than raised inner card (${checkNativeThemes.darkInner})`);
        assert(checkNativeThemes.lightOuter[3] > 0 && checkNativeThemes.lightOuter[0] < checkNativeThemes.lightInner[0], `Light default outer frame (${checkNativeThemes.lightOuter}) must be softer than bright white inner card (${checkNativeThemes.lightInner})`);
    } finally {
        await evaluate(`(()=>{
            const shell=document.querySelector('.agy-inset-shell');
            const sheet=document.querySelector('.agy-sheet');
            const split=document.querySelector('#test-sidebar-split');
            if(split&&sheet)shell.insertBefore(sheet,split);
            split?.remove();
            document.querySelector('#tabs').removeAttribute('data-side-panel-strip');
        })()`);
        await panel("document.querySelector('#discard').click()");
        await waitDiscard();
    }

    // (d) Multi-window & multi-panel sync: BroadcastChannel (no loopback), 250ms/0ms multi-window discovery, external reloadIfChanged() + focus/visibilitychange
    const panel2Target = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('http://127.0.0.1:' + webPort + '/?token=test'), { method: 'PUT' }).then(r => r.json());
    panelClient2 = new Connection(panel2Target.webSocketDebuggerUrl);
    await panelClient2.open();
    const panel2 = expression => evalOn(panelClient2, expression, 'Settings UI #2');
    await until(() => panel2("document.querySelector('#save')&&!document.querySelector('#save').disabled"), 'Second panel did not initialize');
    assert.equal(await panel2("document.querySelector('#wallpaper-opacity').value"), '79');
    assert.equal(await panel2("document.querySelector('#discard').disabled"), true);
    await panel2("(()=>{const t=window.sidecar||window;const orig=t.fetch.bind(t);window.__fetchLog=[];t.fetch=(p,o)=>{window.__fetchLog.push({path:p,method:o?.method||'GET'});return orig(p,o);};})()");

    // Panel 1 live modify -> BroadcastChannel -> Panel 2 (zero loopback HTTP requests)
    await panel("(()=>{const c=document.querySelector('#composer-cover');if(!c.checked)c.click();const set=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event('input'));};set('#wallpaper-opacity',47);set('#wallpaper-composerBlur',5);set('#composerInnerColor','#336699');})()");
    await until(() => panel("document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), 'Panel 1 preview did not finish');
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='47'&&document.querySelector('#wallpaper-composerBlur').value==='5'&&document.querySelector('#composerInnerColor').value==='#336699'&&!document.querySelector('#discard').disabled&&document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), 'BroadcastChannel modify did not sync to Panel 2');
    assert.equal(await panel2('window.__fetchLog.length'), 0, 'BroadcastChannel modify sync must not trigger loopback requests on Panel 2');
    assert.match(await panel2("document.querySelector('#preview').style.getPropertyValue('--preview-inner')"), /#336699/);

    // Panel 1 save -> BroadcastChannel -> Panel 2 (zero loopback)
    await panel("document.querySelector('#save').click()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已保存')"), 'Panel 1 save did not finish');
    await until(() => panel2("document.querySelector('#discard').disabled&&document.querySelector('#status').textContent.includes('已保存')"), 'BroadcastChannel save did not sync to Panel 2');
    assert.equal(await panel2('window.__fetchLog.length'), 0, 'BroadcastChannel save sync must not trigger loopback requests on Panel 2');
    const savedMulti = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
    assert.equal(savedMulti.opacity, 47);
    assert.equal(savedMulti.composerBlur, 5);
    assert.equal(savedMulti.bubbleBlur, 5);
    assert.equal(savedMulti.composerInnerColor, '#336699');
    assert.equal(savedMulti.bubbleInnerColor, '#336699');

    // Panel 1 modify + discard -> BroadcastChannel -> Panel 2 (zero loopback)
    await panel("(()=>{const o=document.querySelector('#wallpaper-opacity');o.value=82;o.dispatchEvent(new Event('input'));})()");
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='82'&&!document.querySelector('#discard').disabled"), 'BroadcastChannel draft did not reach Panel 2');
    await panel("document.querySelector('#discard').click()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已还原已保存设置')"), 'Panel 1 discard did not finish');
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='47'&&document.querySelector('#discard').disabled&&document.querySelector('#status').textContent.includes('已还原已保存设置')"), 'BroadcastChannel discard did not sync to Panel 2');
    assert.equal(await panel2('window.__fetchLog.length'), 0, 'BroadcastChannel discard sync must not trigger loopback requests on Panel 2');

    await panel2(`(() => {
        const transport = window.sidecar || window;
        const fetchSettings = transport.fetch.bind(transport);
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        crypto.subtle.digest = (...args) => {
            window.broadcastDigest = true;
            return digest(...args);
        };
        transport.fetch = async (path, options) => {
            if (path === '/api/settings' && options.method === 'GET' && !window.releaseSync) {
                await new Promise(resolve => { window.releaseSync = resolve; });
            }
            return fetchSettings(path, options);
        };
        window.dispatchEvent(new Event('focus'));
    })()`);
    await until(() => panel2('Boolean(window.releaseSync)'), 'Settings sync did not enter the fetch gate');
    await panel(`(() => {
        const channel = new BroadcastChannel('antigravity-ui-panel-sync');
        channel.postMessage({ source: 'cache-miss-test', settings: { opacity: 99 }, imageHash: 'uncached' });
        channel.close();
    })()`);
    await until(() => panel2('window.broadcastDigest'), 'Panel 2 did not try matching the broadcast image locally');
    await panel2('window.releaseSync()');
    await until(() => panel2("window.__fetchLog.filter(entry => entry.method === 'GET').length >= 2"), 'A cache miss during an existing sync must queue a fresh GET');
    assert.equal(await panel2("document.querySelector('#wallpaper-opacity').value"), '47');

    // Second host window: 250ms preview discovery window + 0ms save/discard immediate discovery
    await panel("document.querySelector('#save').click()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已保存')"), 'Baseline save before Host 2 failed');
    const host2Target = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(host + '?window=2'), { method: 'PUT' }).then(r => r.json());
    host2Client = new Connection(host2Target.webSocketDebuggerUrl);
    await host2Client.open();
    await until(() => evalOn(host2Client, "document.readyState==='complete'&&Boolean(window.electronNative)", 'Host 2 ready'), 'Host 2 did not become ready');
    await delay(270);
    await panel("(()=>{const o=document.querySelector('#wallpaper-opacity');o.value=58;o.dispatchEvent(new Event('input'));})()");
    await until(() => panel("document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), 'Preview for Host 2 discovery did not finish');
    assert.equal((await readHostSurfaces(client)).wallpaperOpacity, '0.58');
    assert.equal((await readHostSurfaces(host2Client)).wallpaperOpacity, '0.58', '250ms discovery window must sync Host 2 during preview');

    // 0ms immediate discovery on Save
    const host3Target = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(host + '?window=3'), { method: 'PUT' }).then(r => r.json());
    host3Client = new Connection(host3Target.webSocketDebuggerUrl);
    await host3Client.open();
    await until(() => evalOn(host3Client, "document.readyState==='complete'&&Boolean(window.electronNative)", 'Host 3 ready'), 'Host 3 did not become ready');
    await panel("document.querySelector('#save').click()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已保存')"), 'Save with Host 3 failed');
    assert.equal((await readHostSurfaces(client)).wallpaperOpacity, '0.58');
    assert.equal((await readHostSurfaces(host2Client)).wallpaperOpacity, '0.58');
    assert.equal((await readHostSurfaces(host3Client)).wallpaperOpacity, '0.58', 'Save must immediately discover and update Host 3');
    await closeTarget(host3Target.id, host3Client);
    host3Client = undefined;

    // 0ms immediate discovery on Discard
    await panel("(()=>{const o=document.querySelector('#wallpaper-opacity');o.value=73;o.dispatchEvent(new Event('input'));})()");
    await until(() => panel("document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), 'Preview before Host 3b discard failed');
    const host3bTarget = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(host + '?window=3b'), { method: 'PUT' }).then(r => r.json());
    host3Client = new Connection(host3bTarget.webSocketDebuggerUrl);
    await host3Client.open();
    await until(() => evalOn(host3Client, "document.readyState==='complete'&&Boolean(window.electronNative)", 'Host 3b ready'), 'Host 3b did not become ready');
    await panel("document.querySelector('#discard').click()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已还原已保存设置')"), 'Discard with Host 3b failed');
    assert.equal((await readHostSurfaces(client)).wallpaperOpacity, '0.58');
    assert.equal((await readHostSurfaces(host2Client)).wallpaperOpacity, '0.58');
    assert.equal((await readHostSurfaces(host3Client)).wallpaperOpacity, '0.58', 'Discard must immediately discover and restore Host 3b');
    await closeTarget(host3bTarget.id, host3Client);
    host3Client = undefined;

    // External disk settings.json rewrite -> reloadIfChanged() + high-generation host activation via Panel 2 focus (GET /api/settings)
    const highGenA = (await evaluate('window.__antigravityUiRenderer.generation')) + 20;
    await evaluate(`window.__antigravityUiRenderer.generation = ${highGenA}`);
    await evalOn(host2Client, `window.__antigravityUiRenderer.generation = ${highGenA}`, 'Bump Host 2 generation A');
    await delay(50);
    await writeFile(join(data, 'settings.json'), JSON.stringify(appearance.normalize({
        ...settings, opacity: 23, composerBlur: 11, composerOuterColor: '#abcdef', overviewOpacity: 88,
    })));
    await panel2("window.dispatchEvent(new Event('focus'))");
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='23'&&document.querySelector('#wallpaper-composerBlur').value==='11'&&document.querySelector('#composerOuterColor').value==='#abcdef'&&document.querySelector('#wallpaper-overviewOpacity').value==='88'"), 'Panel 2 focus resync did not reload external settings.json');
    assert((await panel2('window.__fetchLog')).some(entry => entry.path === '/api/settings' && entry.method === 'GET'));
    await until(async () => (await readHostSurfaces(client)).wallpaperOpacity === '0.23' && (await readHostSurfaces(host2Client)).wallpaperOpacity === '0.23', 'Both high-generation host windows did not sync external settings.json');
    for (const conn of [client, host2Client]) {
        const s = await readHostSurfaces(conn);
        assert.equal(s.viewport.maskImage, 'none');
        assert.equal(s.regularBubble.frameBlur, 'blur(11px)');
        assert.equal(s.proceededBubble.frameBlur, 'blur(11px)');
        assert.equal(s.homeComposer.outerBlur, 'blur(11px)');
        approxRgba(s.overview.bgRgba, [19, 19, 19, 224], 5);
        assert.equal(s.overview.shadow, 'none');
    }

    // Heartbeat syncStore() runs before GET /api/settings on high-generation host -> pendingActivate triggers activateRuntime(true)
    const highGenB = (await evaluate('window.__antigravityUiRenderer.generation')) + 20;
    await evaluate(`window.__antigravityUiRenderer.generation = ${highGenB}`);
    await evalOn(host2Client, `window.__antigravityUiRenderer.generation = ${highGenB}`, 'Bump Host 2 generation B');
    await delay(50);
    await writeFile(join(data, 'settings.json'), JSON.stringify(appearance.normalize({
        ...settings, opacity: 34, composerBlur: 15, composerOuterColor: '#112233',
    })));
    await delay(1650);
    assert.equal((await readHostSurfaces(client)).wallpaperOpacity, '0.23', 'Non-activated heartbeat must not override high-generation host');
    await panel2("window.dispatchEvent(new Event('focus'))");
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='34'&&document.querySelector('#wallpaper-composerBlur').value==='15'"), 'Panel 2 focus did not sync after heartbeat reload');
    await until(async () => (await readHostSurfaces(client)).wallpaperOpacity === '0.34' && (await readHostSurfaces(host2Client)).wallpaperOpacity === '0.34', 'High-generation host windows did not activate via pendingActivate on GET /api/settings');
    assert.equal((await readHostSurfaces(client)).regularBubble.frameBlur, 'blur(15px)');
    assert.equal((await readHostSurfaces(host2Client)).regularBubble.frameBlur, 'blur(15px)');

    // Stale draft cleared by external rewrite + Panel 1 visibilitychange resync
    await panel("(()=>{const o=document.querySelector('#wallpaper-opacity');o.value=71;o.dispatchEvent(new Event('input'));})()");
    await until(() => panel("document.querySelector('#status').textContent.includes('实时预览 · 未保存')&&!document.querySelector('#discard').disabled"), 'Panel 1 stale draft did not activate');
    await delay(50);
    await writeFile(join(data, 'settings.json'), JSON.stringify(appearance.normalize({
        ...settings, opacity: 79, composerBlur: 0, composerCover: false, composerInnerColor: '#13579b', sidebarBlur: 7,
    })));
    if (await panel('document.hidden')) await panelClient.command('Page.bringToFront');
    else await panel("document.dispatchEvent(new Event('visibilitychange'))");
    await until(() => panel("document.querySelector('#wallpaper-opacity').value==='79'&&document.querySelector('#wallpaper-composerBlur').value==='0'&&document.querySelector('#discard').disabled"), 'Panel 1 visibilitychange resync did not clear stale draft and reload settings.json');
    await until(async () => (await readHostSurfaces(client)).wallpaperOpacity === '0.79' && (await readHostSurfaces(host2Client)).wallpaperOpacity === '0.79', 'Host windows did not sync after visibilitychange reload');
    assert.match((await readHostSurfaces(client)).viewport.maskImage, /linear-gradient/);
    assert.match((await readHostSurfaces(host2Client)).viewport.maskImage, /linear-gradient/);

    await closeTarget(panel2Target.id, panelClient2);
    panelClient2 = undefined;
    await closeTarget(host2Target.id, host2Client);
    host2Client = undefined;
    await until(async () => (await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).filter(t => t.type === 'page' && t.url.startsWith(host)).length === 1, 'Extra host page did not close before standalone runtime test');

    const waitExit = child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
    const exits = [waitExit(sidecar), waitExit(duplicate)];
    sidecar.kill('SIGTERM');
    duplicate.kill('SIGTERM');
    await Promise.all(exits);

    const evaluated = [];
    let hideWallpaper = false;
    const runtime = new WallpaperRuntime(profile, () => ({
        enabled: true,
        css: hideWallpaper ? '' : appearance.wallpaperStyle(settings, 'var(--ag-ui-image)'),
        image: settings.image,
        imageHash: expectedImageHash,
        surfaces: { sidebarCover: true, sidebarOpacity: 100, sidebarBlur: 8, composerCover: true, composerOpacity: 100, composerBlur: 0, composerOuterColor: '', composerInnerColor: '' },
    }), async () => true, String(server.address().port));
    runtime.generation = Date.now() + 60000;
    const originalEvaluate = runtime.evaluate.bind(runtime);
    runtime.evaluate = async (connection, payload) => {
        const result = await originalEvaluate(connection, payload);
        evaluated.push({ hasImage: payload.image !== undefined, imageHash: payload.imageHash, result });
        return result;
    };
    await runtime.update(true, true);
    await runtime.update(true, false);
    await client.command('Page.reload');
    await until(() => evaluate("document.readyState==='complete'"), 'Host did not finish reloading');
    await runtime.update(true, false);
    assert.equal(evaluated.length, 4);
    assert.equal(evaluated[0].hasImage, true);
    assert.equal(evaluated[0].result, 'OK');
    assert.equal(evaluated[1].hasImage, false);
    assert.equal(evaluated[1].result, 'OK');
    assert.equal(evaluated[2].hasImage, false);
    assert.equal(evaluated[2].result, 'NEED_IMAGE');
    assert.equal(evaluated[3].hasImage, true, 'Runtime must resend full image once after receiving NEED_IMAGE');
    assert.equal(evaluated[3].result, 'OK');
    const reloadInstallLog = await evaluate('window.__installLog');
    assert.deepEqual(reloadInstallLog.slice(0, 2), [{ hasRenderer: false, hasLayer: false }, { hasRenderer: false, hasLayer: false }]);
    assert.equal(await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity"), '1');

    // Regression: side panel switching to [data-browser-hole] must not trap [data-main-content-body] under #antigravity-ui-background
    assert.equal(await evaluate('window.__antigravityUiRenderer.version'), 18);
    assert.equal(await evaluate('window.__antigravityUiRenderer.revision'), 23);
    const activeGeneration = await evaluate('window.__antigravityUiRenderer.generation');
    const installInHost = payload => evaluate(`(${installWallpaper.toString()})(${JSON.stringify(payload)})`);
    await evaluate("window.oldLayer = document.querySelector('#antigravity-ui-background'); delete window.__antigravityUiRenderer.revision");
    assert.equal(await installInHost({ enabled: false, generation: activeGeneration - 1 }), 'IGNORED');
    assert.equal(await installInHost({ enabled: true, css: 'color:red', imageHash: expectedImageHash, generation: activeGeneration + 1 }), 'NEED_IMAGE');
    assert.equal(await evaluate("window.oldLayer === document.querySelector('#antigravity-ui-background') && window.titlebarOptions.color === '#00000000'"), true);
    await runtime.update(true, false);
    assert.equal(await evaluate('window.__antigravityUiRenderer.revision'), 23);
    assert.equal(runtime.health.layout?.width, await evaluate('window.innerWidth'));
    assert.equal(runtime.health.layout?.height, await evaluate('window.innerHeight'));
    const sashHits = await evaluate(`(()=>{
        const h=document.querySelector('[data-testid="side-panel-sash"]');
        const b=h.getBoundingClientRect();
        const cx=b.left+b.width/2, y=b.top+100;
        return {
            sashZ:getComputedStyle(h.parentElement).zIndex,
            left:document.elementFromPoint(cx-2,y)===h,
            center:document.elementFromPoint(cx,y)===h,
            right:document.elementFromPoint(cx+2,y)===h,
        };
    })()`);
    assert.deepEqual(sashHits, { sashZ: '1003', left: true, center: true, right: true }, 'Side-panel sash handle must sit above z-index 1001 main/side panes');
    await client.command('Page.bringToFront');
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const beforeHoleShot = await client.command('Page.captureScreenshot', { format: 'png' });
    const holeState = await evaluate(`(async()=>{
        document.documentElement.dataset.hasBrowserHole='true';
        document.body.dataset.hasBrowserHole='true';
        document.body.dataset.hasThreeLayerBrowserHole='true';
        const sheet=document.querySelector('.agy-sheet');
        const outline=document.querySelector('.outline-none');
        const pane=document.querySelector('.pane');
        const sideBody=document.querySelector('.pane .flex-grow');
        sheet.dataset.hasBrowserHole='true';
        outline.dataset.hasBrowserHole='true';
        outline.dataset.splitTransition='true';
        pane.dataset.hasBrowserHole='true';
        sideBody.dataset.hasBrowserHole='true';
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const mainBody=document.querySelector('[data-main-content-body]');
        const splitEdge=document.querySelector('[data-split-fill-edge="right"]');
        const sash=document.querySelector('[data-split-sash]');
        const mainStyle=getComputedStyle(mainBody);
        const splitStyle=getComputedStyle(splitEdge);
        const sideStyle=getComputedStyle(sideBody);
        const sashStyle=getComputedStyle(sash);
        const hit=sel=>{const el=document.querySelector(sel),b=el.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===el};
        const rect=mainBody.getBoundingClientRect();
        return{
            mainClip:mainStyle.clipPath,
            mainShadow:mainStyle.boxShadow,
            splitClip:splitStyle.clipPath,
            sideClip:sideStyle.clipPath,
            sideBg:sideStyle.backgroundColor,
            sideBlur:sideStyle.backdropFilter,
            sashBg:sashStyle.backgroundColor,
            sashBgImage:sashStyle.backgroundImage,
            mainHasHoleAttr:mainBody.hasAttribute('data-has-browser-hole'),
            splitHasHoleAttr:splitEdge.hasAttribute('data-has-browser-hole'),
            splitMatchedHostRule:splitEdge.matches('body[data-has-three-layer-browser-hole="true"] [data-split-root="true"][data-split-three-layer-slide="true"][data-has-browser-hole="true"][data-split-transition] > [data-split-fill-edge]:not([data-has-browser-hole="true"])'),
            hits:{bubble:hit('#regular-bubble'),editor:hit('#editor'),overview:hit('[data-testid="overview-panel-host-overlay"]')},
            rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom},
        };
    })()`);
    assert.equal(holeState.mainHasHoleAttr, false);
    assert.equal(holeState.splitHasHoleAttr, false);
    assert.notEqual(holeState.sideClip, 'none', 'Host browser-hole rule must activate on [data-side-panel-body]');
    assert.equal(holeState.sideBg, 'rgba(0, 0, 0, 0)', 'Browser hole side panel body must stay transparent');
    assert.equal(holeState.sideBlur, 'none', 'Browser hole side panel body must not apply backdrop blur');
    assert.equal(holeState.sashBg, 'rgba(0, 0, 0, 0)', 'Split sash must stay transparent when browser hole is active');
    assert.equal(holeState.sashBgImage, 'none', 'Split sash background image must stay none when browser hole is active');
    assert.equal(holeState.splitMatchedHostRule, true, 'Host three-layer split rule must match [data-split-fill-edge="right"]');
    assert.equal(holeState.mainClip, 'none');
    assert.equal(holeState.mainShadow, 'none');
    assert.equal(holeState.splitClip, 'none');
    assert.deepEqual(holeState.hits, { bubble: true, editor: true, overview: true });
    const afterHoleShot = await client.command('Page.captureScreenshot', { format: 'png' });
    const changedPixels = await evalOn(client, `(async()=>{
        const load=b64=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src='data:image/png;base64,'+b64;});
        const [beforeImg,afterImg]=await Promise.all([load(${JSON.stringify(beforeHoleShot.data)}),load(${JSON.stringify(afterHoleShot.data)})]);
        const w=beforeImg.naturalWidth,h=beforeImg.naturalHeight;
        if(afterImg.naturalWidth!==w||afterImg.naturalHeight!==h)throw new Error('Screenshot size mismatch');
        const draw=img=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.drawImage(img,0,0);return g.getImageData(0,0,w,h).data;};
        const a=draw(beforeImg),b=draw(afterImg);
        const sx=w/window.innerWidth,sy=h/window.innerHeight;
        const r=${JSON.stringify(holeState.rect)};
        const x0=Math.max(0,Math.ceil(r.left*sx)),y0=Math.max(0,Math.ceil(r.top*sy));
        const x1=Math.min(w,Math.floor(r.right*sx)),y1=Math.min(h,Math.floor(r.bottom*sy));
        let changed=0;
        for(let y=y0;y<y1;y++){
            for(let x=x0;x<x1;x++){
                const i=(y*w+x)*4;
                if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3])changed++;
            }
        }
        return{changed,width:x1-x0,height:y1-y0};
    })()`, 'Compare browser-hole screenshots');
    assert(changedPixels.width > 0 && changedPixels.height > 0);
    assert.equal(changedPixels.changed, 0, 'Switching side panel to [data-browser-hole] must not change any pixel inside [data-main-content-body]');
    const cleanedHole = await evaluate(`(async()=>{
        delete document.documentElement.dataset.hasBrowserHole;
        delete document.body.dataset.hasBrowserHole;
        delete document.body.dataset.hasThreeLayerBrowserHole;
        const sheet=document.querySelector('.agy-sheet');
        const outline=document.querySelector('.outline-none');
        const pane=document.querySelector('.pane');
        const sideBody=document.querySelector('.pane .flex-grow');
        delete sheet.dataset.hasBrowserHole;
        delete outline.dataset.hasBrowserHole;
        delete outline.dataset.splitTransition;
        delete pane.dataset.hasBrowserHole;
        delete sideBody.dataset.hasBrowserHole;
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        return{
            attrs:[document.documentElement,document.body,sheet,outline,pane,sideBody].every(el=>!el.hasAttribute('data-has-browser-hole'))&&!document.body.hasAttribute('data-has-three-layer-browser-hole')&&!outline.hasAttribute('data-split-transition'),
            sideClip:getComputedStyle(sideBody).clipPath,
            mainClip:getComputedStyle(document.querySelector('[data-main-content-body]')).clipPath,
            splitClip:getComputedStyle(document.querySelector('[data-split-fill-edge="right"]')).clipPath,
        };
    })()`);
    assert.equal(cleanedHole.attrs, true, 'Browser-hole simulation attributes must be cleaned up');
    assert.equal(cleanedHole.sideClip, 'none');
    assert.equal(cleanedHole.mainClip, 'none');
    assert.equal(cleanedHole.splitClip, 'none');

    // Regression: interactive overlays, navigators, scrollbars, peek sidebar, drawer, split fork & terminal handle must remain clickable
    const stackingChecks = await evaluate(`(()=>{
        const shell = document.querySelector('.agy-inset-shell');
        const sheet = document.querySelector('.agy-sheet');
        const outline = sheet.querySelector('.outline-none');
        const mainBody = document.querySelector('[data-main-content-body]');
        const sideBody = document.querySelector('[data-side-panel-body]');
        const rightPane = outline.querySelector('.pane');
        const sideTabs = document.querySelector('#tabs');
        sideTabs.setAttribute('data-side-panel-strip', 'true');
        const cleanup = [];
        const hit = el => {
            const r = el.getBoundingClientRect();
            const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return target === el || el.contains(target);
        };
        try {
            // 1. Conversation view: navigator dots, overlay scrollbar, scroll-to-bottom button, find bar
            const convo = document.createElement('div');
            convo.setAttribute('data-testid', 'conversation-view');
            convo.style.cssText = 'position:absolute;left:0;top:40px;width:360px;height:165px;display:flex;flex-direction:column;';
            convo.innerHTML =
                '<div class="sticky top-0 z-20" style="position:sticky;top:0;z-index:20;height:26px;pointer-events:none"><div class="agy-pill" style="pointer-events:auto;height:24px"><span data-testid="find-bar-match-count">1 of 1</span></div></div>' +
                '<div class="pointer-events-none absolute inset-y-0 left-0 z-10 w-7" style="pointer-events:none;position:absolute;inset:0 auto 0 0;z-index:10;width:28px"><nav data-testid="conversation-navigator" class="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-7" style="pointer-events:none;position:absolute;inset:0;z-index:10;width:28px"><ol style="pointer-events:auto;margin:40px 0 0;padding:0;list-style:none"><li style="height:16px"><button type="button" data-testid="conversation-navigator-turn" style="width:28px;height:16px;display:block"></button></li></ol></nav></div>' +
                '<div class="relative flex-grow min-h-0" style="position:relative;flex:1;min-height:0">' +
                '  <div class="relative flex flex-col h-full w-full" style="position:relative;height:100%;width:100%">' +
                '    <div data-testid="autoscroll-viewport" style="height:100%;width:100%"></div>' +
                '    <div data-testid="overlay-scrollbar" style="position:absolute;top:2px;bottom:2px;right:2px;width:12px;z-index:30;pointer-events:auto"></div>' +
                '    <button type="button" class="agy-scroll-bottom" style="position:absolute;bottom:16px;left:50%;width:32px;height:32px;z-index:20;pointer-events:auto"></button>' +
                '  </div>' +
                '</div>';
            mainBody.appendChild(convo);
            cleanup.push(() => convo.remove());

            // 2. Bottom terminal resize handle overlapping bottom of conversation / composer
            const term = document.createElement('div');
            term.id = 'bottom-terminal-panel';
            term.setAttribute('data-testid', 'bottom-terminal-panel');
            term.style.cssText = 'position:absolute;left:0;top:205px;width:360px;height:60px;';
            term.innerHTML = '<div data-testid="bottom-terminal-panel-resize-handle" style="position:absolute;top:-4px;left:0;right:0;height:8px;z-index:10"></div>';
            mainBody.appendChild(term);
            cleanup.push(() => term.remove());

            // 3. Forked split view close button & right [data-split-sized]
            const forkWrap = document.createElement('div');
            forkWrap.style.cssText = 'position:absolute;left:400px;top:40px;width:260px;height:165px;';
            forkWrap.innerHTML =
                '<div class="absolute top-4 right-4 z-50" style="position:absolute;top:8px;right:8px;width:24px;height:24px;z-index:50"><button type="button" id="fork-close" aria-label="Close" style="width:24px;height:24px"></button></div>' +
                '<div data-split-root="true" style="position:relative;display:flex;width:100%;height:100%">' +
                '  <div style="flex:1;position:relative"><div data-testid="autoscroll-viewport" id="fork-left-vp" style="height:100%"></div></div>' +
                '  <div style="flex:1;position:relative"><div data-split-sized="fork" style="position:absolute;inset:0;z-index:10"><div data-testid="autoscroll-viewport" id="fork-right-vp" style="height:100%"></div></div></div>' +
                '</div>';
            mainBody.appendChild(forkWrap);
            cleanup.push(() => forkWrap.remove());

            // 4. Peek sidebar hot-zone, peek surface, left-0 header cluster, narrow modal drawer
            const sidebarSplit = document.createElement('div');
            sidebarSplit.setAttribute('data-testid', 'sidebar-split');
            sidebarSplit.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
            sidebarSplit.innerHTML =
                '<div style="position:relative;height:100%">' +
                '  <div data-split-sized="peek" style="position:absolute;top:0;left:0;width:180px;height:100%;z-index:10;pointer-events:none">' +
                '    <div data-peek-surface="closed" style="position:relative;width:100%;height:100%;pointer-events:none"><button type="button" id="peek-btn" style="position:absolute;left:24px;top:110px;width:100px;height:28px;pointer-events:auto">Peek</button></div>' +
                '  </div>' +
                '</div>';
            shell.insertBefore(sidebarSplit, shell.firstChild);
            cleanup.push(() => sidebarSplit.remove());

            const hotZone = document.createElement('div');
            hotZone.setAttribute('data-testid', 'sidebar-peek-hot-zone');
            hotZone.className = 'absolute left-0 bottom-4 w-2 z-40';
            hotZone.style.cssText = 'position:absolute;left:0;top:40px;bottom:16px;width:8px;z-index:40;';
            shell.appendChild(hotZone);
            cleanup.push(() => hotZone.remove());

            const leftHeader = document.createElement('div');
            leftHeader.className = 'absolute left-0 top-0 flex items-center shrink-0 z-50';
            leftHeader.style.cssText = 'position:absolute;left:0;top:0;height:40px;width:140px;z-index:50;';
            leftHeader.innerHTML = '<button type="button" id="left-header-btn" style="width:28px;height:28px"></button>';
            shell.appendChild(leftHeader);
            cleanup.push(() => leftHeader.remove());

            const backdrop = document.createElement('div');
            backdrop.setAttribute('data-testid', 'sidebar-popover-backdrop');
            backdrop.className = 'absolute inset-0 z-40';
            backdrop.style.cssText = 'position:absolute;inset:0;z-index:40;';
            const drawer = document.createElement('div');
            drawer.setAttribute('role', 'dialog');
            drawer.className = 'surface-opaque absolute inset-y-0 left-0 z-50';
            drawer.style.cssText = 'position:absolute;top:0;bottom:0;left:0;width:180px;z-index:50;';
            drawer.innerHTML = '<button type="button" id="modal-drawer-btn" style="position:absolute;left:40px;top:150px;width:80px;height:28px"></button>';
            shell.insertBefore(backdrop, leftHeader);
            shell.insertBefore(drawer, leftHeader);
            cleanup.push(() => { backdrop.remove(); drawer.remove(); });

            // 5. Floating voice pill, selection/comment popovers, floating scrollbar
            const voicePill = document.createElement('div');
            voicePill.className = 'fixed z-40 flex flex-col items-start gap-1.5 select-none';
            voicePill.style.cssText = 'position:fixed;right:20px;bottom:20px;width:100px;height:36px;z-index:40;';
            voicePill.innerHTML = '<div data-testid="voice-dock-composer"></div><button type="button" id="voice-btn" style="width:100%;height:100%"></button>';
            document.body.appendChild(voicePill);
            cleanup.push(() => voicePill.remove());

            const selPopup = document.createElement('div');
            selPopup.className = 'selection-popup z-50';
            selPopup.style.cssText = 'position:fixed;left:420px;top:260px;width:80px;height:28px;z-index:50;';
            const commentPop = document.createElement('div');
            commentPop.setAttribute('data-comment-bubble-popover', 'true');
            commentPop.className = 'z-50';
            commentPop.style.cssText = 'position:fixed;left:510px;top:260px;width:80px;height:28px;z-index:50;';
            const pdfPop = document.createElement('div');
            pdfPop.setAttribute('data-testid', 'pdf-selected-annotation-popover');
            pdfPop.className = 'z-50';
            pdfPop.style.cssText = 'position:fixed;left:600px;top:260px;width:80px;height:28px;z-index:50;';
            const commentFloat = document.createElement('div');
            commentFloat.setAttribute('data-testid', 'comment-box');
            commentFloat.className = 'absolute z-50';
            commentFloat.style.cssText = 'position:absolute;left:600px;top:300px;width:80px;height:28px;z-index:50;';
            const commentInline = document.createElement('div');
            commentInline.setAttribute('data-testid', 'comment-box');
            commentInline.className = 'w-full';
            const floatSbLow = document.createElement('div');
            floatSbLow.setAttribute('data-overlay-scrollbar-track', '');
            floatSbLow.style.cssText = 'position:fixed;right:4px;top:80px;width:8px;height:120px;z-index:51;';
            const floatSbModal = document.createElement('div');
            floatSbModal.setAttribute('data-overlay-scrollbar-track', '');
            floatSbModal.style.cssText = 'position:fixed;right:16px;top:80px;width:8px;height:120px;z-index:5001;';
            document.body.append(selPopup, commentPop, pdfPop, commentFloat, commentInline, floatSbLow, floatSbModal);
            cleanup.push(() => { selPopup.remove(); commentPop.remove(); pdfPop.remove(); commentFloat.remove(); commentInline.remove(); floatSbLow.remove(); floatSbModal.remove(); });

            const dotBtn = convo.querySelector('[data-testid="conversation-navigator-turn"]');
            const ovSb = convo.querySelector('[data-testid="overlay-scrollbar"]');
            const scrollBtn = convo.querySelector('.agy-scroll-bottom');
            const findPill = convo.querySelector('.agy-pill');
            const findWrapper = convo.querySelector('.sticky.top-0');
            const termHandle = term.querySelector('[data-testid="bottom-terminal-panel-resize-handle"]');
            const forkClose = forkWrap.querySelector('#fork-close');
            const forkRightSized = forkWrap.querySelector('[data-split-sized="fork"]');
            const peekSized = sidebarSplit.querySelector('[data-split-sized="peek"]');
            const peekSurf = sidebarSplit.querySelector('[data-peek-surface]');
            const peekBtn = sidebarSplit.querySelector('#peek-btn');
            const leftHdrBtn = leftHeader.querySelector('#left-header-btn');
            const modalBtn = drawer.querySelector('#modal-drawer-btn');
            const voiceBtn = voicePill.querySelector('#voice-btn');

            const dockedTabZ = getComputedStyle(sideTabs).zIndex;
            sheet.setAttribute('data-side-panel-maximized', 'true');
            const maxTabZ = getComputedStyle(sideTabs).zIndex;
            const maxBodyZ = getComputedStyle(sideBody).zIndex;
            sheet.removeAttribute('data-side-panel-maximized');
            const splitEdge = outline.querySelector('[data-split-fill-edge]');
            splitEdge.setAttribute('data-split-overlaid', 'true');
            const overlaidTabZ = getComputedStyle(sideTabs).zIndex;
            splitEdge.removeAttribute('data-split-overlaid');

            // State A: collapsed sidebar (hotZone visible, peek closed, modal hidden)
            backdrop.style.display = 'none';
            drawer.style.display = 'none';
            sidebarSplit.style.display = 'none';
            const peekClosedZ = getComputedStyle(peekSized).zIndex;
            // Temporarily hide hotZone when testing dotBtn at x=14 (dots span w-7=28px, center x=14 > hotZone 8px anyway!)
            const convoHits = {
                dot: hit(dotBtn),
                scrollbar: hit(ovSb),
                scrollBottom: hit(scrollBtn),
                findBar: hit(findPill),
                findZ: getComputedStyle(findWrapper).zIndex,
                termHandle: hit(termHandle),
                termZ: getComputedStyle(term).zIndex,
                forkClose: hit(forkClose),
                forkRightSizedZ: getComputedStyle(forkRightSized).zIndex,
                peekHotZone: hit(hotZone),
                peekClosedZ,
                leftHeaderBtn: hit(leftHdrBtn),
                leftHeaderZ: getComputedStyle(leftHeader).zIndex,
            };

            // State B: peek open over conversation (hotZone hidden just like native)
            hotZone.style.display = 'none';
            sidebarSplit.style.display = '';
            peekSurf.setAttribute('data-peek-surface', 'open');
            peekSurf.style.pointerEvents = 'auto';
            const peekOpenZ = getComputedStyle(peekSized).zIndex;
            const peekBtnHit = hit(peekBtn);
            const leftHeaderOverPeekHit = hit(leftHdrBtn);

            // State C: narrow-window modal drawer open
            sidebarSplit.style.display = 'none';
            backdrop.style.display = '';
            drawer.style.display = '';
            const modalDrawerHit = hit(modalBtn);
            const modalHeaderHit = hit(leftHdrBtn);

            return {
                ...convoHits,
                peekOpenZ,
                peekBtn: peekBtnHit,
                leftHeaderOverPeekHit,
                modalDrawerHit,
                modalHeaderHit,
                voiceBtnHit: hit(voiceBtn),
                voiceZ: getComputedStyle(voicePill).zIndex,
                selPopupZ: getComputedStyle(selPopup).zIndex,
                commentPopZ: getComputedStyle(commentPop).zIndex,
                pdfPopZ: getComputedStyle(pdfPop).zIndex,
                commentFloatZ: getComputedStyle(commentFloat).zIndex,
                commentInlineZ: getComputedStyle(commentInline).zIndex,
                floatSbLowZ: getComputedStyle(floatSbLow).zIndex,
                floatSbModalZ: getComputedStyle(floatSbModal).zIndex,
                dockedTabZ,
                maxTabZ,
                maxBodyZ,
                overlaidTabZ,
            };
        } finally {
            while (cleanup.length) cleanup.pop()();
            sideTabs.removeAttribute('data-side-panel-strip');
            sheet.removeAttribute('data-side-panel-maximized');
            outline.querySelector('[data-split-fill-edge]')?.removeAttribute('data-split-overlaid');
        }
    })()`);
    assert.equal(stackingChecks.dot, true, 'Conversation navigator dot must be directly clickable above autoscroll-viewport');
    assert.equal(stackingChecks.scrollbar, true, 'Overlay scrollbar must be directly clickable/draggable above autoscroll-viewport');
    assert.equal(stackingChecks.scrollBottom, true, 'Scroll-to-bottom button must be directly clickable above autoscroll-viewport');
    assert.equal(stackingChecks.findBar, true, 'Find-in-conversation bar must be interactive');
    assert.equal(stackingChecks.findZ, '1002');
    assert.equal(stackingChecks.termHandle, true, 'Bottom terminal resize handle must be interactive above conversation/composer');
    assert.equal(stackingChecks.termZ, 'auto', 'Bottom terminal body must preserve existing wallpaper overlay treatment');
    assert.equal(stackingChecks.forkClose, true, 'Forked split view close button must be clickable above autoscroll-viewport');
    assert.equal(stackingChecks.forkRightSizedZ, 'auto', 'Forked split view right [data-split-sized] must not trap pane at z-index 10');
    assert.equal(stackingChecks.peekHotZone, true, 'Collapsed sidebar peek hot-zone must be hoverable above z-index 1001');
    assert.equal(stackingChecks.peekBtn, true, 'Peeked left sidebar must be interactive above chat/wallpaper');
    assert.equal(stackingChecks.peekOpenZ, '1003');
    assert.equal(stackingChecks.peekClosedZ, '10');
    assert.equal(stackingChecks.leftHeaderBtn, true, 'Top-left floating header buttons must remain clickable above peek/wallpaper');
    assert.equal(stackingChecks.leftHeaderOverPeekHit, true, 'Top-left floating header buttons must stay above open peek surface');
    assert.equal(stackingChecks.leftHeaderZ, '1003');
    assert.equal(stackingChecks.modalDrawerHit, true, 'Narrow-window modal sidebar drawer must be interactive above chat/overview');
    assert.equal(stackingChecks.modalHeaderHit, true, 'Top-left header button must sit above modal drawer');
    assert.equal(stackingChecks.voiceBtnHit, true, 'Floating voice pill must be interactive above wallpaper/chat/overview');
    assert.equal(stackingChecks.voiceZ, '1003');
    assert.equal(stackingChecks.selPopupZ, '1002');
    assert.equal(stackingChecks.commentPopZ, '1002');
    assert.equal(stackingChecks.pdfPopZ, '1002');
    assert.equal(stackingChecks.commentFloatZ, '1002');
    assert.equal(stackingChecks.commentInlineZ, 'auto');
    assert.equal(stackingChecks.floatSbLowZ, '1001');
    assert.equal(stackingChecks.floatSbModalZ, '5001');
    assert.equal(stackingChecks.dockedTabZ, 'auto');
    assert.equal(stackingChecks.maxTabZ, '1002');
    assert.equal(stackingChecks.maxBodyZ, '1002');
    assert.equal(stackingChecks.overlaidTabZ, '1002');

    // Regression: floating body > [data-overlay-scrollbar-track] on scrollable working-status blocks must stay clipped to autoscroll-viewport
    const floatingClipChecks = await evaluate(`(async () => {
        const mainBody = document.querySelector('[data-main-content-body]');
        const vp = document.querySelector('[data-testid="autoscroll-viewport"]');
        const vpParent = vp.parentElement;
        const cleanup = [];
        try {
            const splitEdge = mainBody.parentElement;
            const prevDir = splitEdge.style.flexDirection;
            const prevMinH = mainBody.style.minHeight;
            splitEdge.style.flexDirection = 'column';
            mainBody.style.minHeight = '0';
            cleanup.push(() => { splitEdge.style.flexDirection = prevDir; mainBody.style.minHeight = prevMinH; });

            const paneHeader = document.createElement('div');
            paneHeader.setAttribute('data-main-content-header', 'true');
            paneHeader.style.cssText = 'height:40px;flex-shrink:0;position:relative;';
            const hdrBtn = document.createElement('button');
            hdrBtn.textContent = 'Header';
            hdrBtn.style.cssText = 'position:absolute;right:0;top:0;width:80px;height:40px;';
            paneHeader.append(hdrBtn);
            splitEdge.insertBefore(paneHeader, mainBody);
            cleanup.push(() => paneHeader.remove());

            const spacerTop = document.createElement('div');
            spacerTop.style.height = '180px';
            const stepBox = document.createElement('div');
            stepBox.className = 'overflow-y-auto bleed-contain';
            stepBox.style.cssText = 'max-height:110px;height:110px;overflow-y:auto;width:100%;';
            const stepInner = document.createElement('div');
            stepInner.style.height = '320px';
            stepBox.append(stepInner);
            const spacerBot = document.createElement('div');
            spacerBot.style.height = '260px';
            vp.firstElementChild.prepend(spacerTop, stepBox, spacerBot);
            cleanup.push(() => { spacerTop.remove(); stepBox.remove(); spacerBot.remove(); });

            const track = document.createElement('div');
            track.setAttribute('data-overlay-scrollbar-track', '');
            track.dataset.orientation = 'vertical';
            track.style.cssText = 'position:fixed;width:12px;z-index:1002;';
            document.body.append(track);
            cleanup.push(() => track.remove());

            const placeTrack = () => {
                const r = stepBox.getBoundingClientRect();
                track.style.top = (r.top + stepBox.clientTop + 2) + 'px';
                track.style.left = (r.left + stepBox.clientLeft + stepBox.clientWidth - 14) + 'px';
                track.style.height = (stepBox.clientHeight - 4) + 'px';
            };

            // 1. Scroll stepBox partway above autoscroll-viewport top (covering header at y=40..75)
            vp.scrollTop = 225;
            placeTrack();
            await new Promise(r => setTimeout(r, 40));
            const topClip = track.style.clipPath;
            const trTop = track.getBoundingClientRect();
            const vpR = vp.getBoundingClientRect();
            const hdrHit = document.elementFromPoint(Math.round(trTop.left + 6), Math.round(paneHeader.getBoundingClientRect().top + 10));
            const insideHit = document.elementFromPoint(Math.round(trTop.left + 6), Math.round(vpR.top + 14));

            // 2. Scroll stepBox partway below autoscroll-viewport bottom
            vp.scrollTop = 95;
            placeTrack();
            await new Promise(r => setTimeout(r, 40));
            const botClip = track.style.clipPath;
            const trBot = track.getBoundingClientRect();
            const belowHit = document.elementFromPoint(Math.round(trBot.left + 6), Math.round(vp.getBoundingClientRect().bottom + 12));

            // 3. Scroll stepBox completely inside autoscroll-viewport
            vp.scrollTop = 165;
            placeTrack();
            await new Promise(r => setTimeout(r, 40));
            const insideClip = track.style.clipPath;

            // Keep an active clipped track to confirm dispose() clears clipPath cleanly afterwards
            vp.scrollTop = 0;
            return {
                topClip,
                botClip,
                insideClip,
                hdrBlocked: hdrBtn.contains(hdrHit) || paneHeader.contains(hdrHit),
                insideTrackHit: track.contains(insideHit),
                belowUnblocked: !track.contains(belowHit),
                vpTop: Math.round(vpR.top),
                trTopY: Math.round(trTop.top),
            };
        } finally {
            while (cleanup.length) cleanup.pop()();
        }
    })()`);
    assert.match(floatingClipChecks.topClip, /^inset\(\d+px/, 'Floating track extending above autoscroll-viewport must be top-clipped');
    assert.equal(floatingClipChecks.hdrBlocked, true, 'Clipped top portion must pass pointer hits through to pane header');
    assert.equal(floatingClipChecks.insideTrackHit, true, 'Visible portion inside autoscroll-viewport must remain interactive');
    assert.match(floatingClipChecks.botClip, /^inset\(0px 0px \d+px(?: 0px)?\)/, 'Floating track extending below autoscroll-viewport must be bottom-clipped');
    assert.equal(floatingClipChecks.belowUnblocked, true, 'Clipped bottom portion must not block elements below autoscroll-viewport');
    assert.equal(floatingClipChecks.insideClip, '', 'Fully visible floating track must clear clip-path');

    // Regression: host theme recompute or direct setTitleBarOverlay overwrite must restore transparent titlebar
    await evaluate(`(()=>{
        document.documentElement.style.setProperty('--sidebar', '#444343');
        void window.electronNative.setTitleBarOverlay({ color: '#444343', symbolColor: '#ffffff' });
    })()`);
    await until(async () => (await evaluate('window.titlebarOptions?.color')) === '#00000000', 'MutationObserver did not immediately restore transparent titlebar overlay');
    await evaluate(`(()=>{
        document.documentElement.style.removeProperty('--sidebar');
    })()`);
    await delay(50);
    await evaluate(`(()=>{
        void window.electronNative.setTitleBarOverlay({ color: '#444343', symbolColor: '#ffffff' });
        document.documentElement.style.transition = 'background-color 150ms ease';
    })()`);
    await delay(50);
    assert.equal(await evaluate('window.titlebarOptions.color'), '#444343', 'Unrelated style.transition mutation must not trigger setTitleBarOverlay');
    await evaluate(`document.body.dataset.agyTheme = 'light'`);
    await until(async () => (await evaluate('window.titlebarOptions?.color')) === '#00000000', 'MutationObserver on body[data-agy-theme] did not restore transparent titlebar overlay');
    await evaluate(`(()=>{
        document.documentElement.style.removeProperty('transition');
        delete document.body.dataset.agyTheme;
    })()`);
    await delay(1050);
    await evaluate(`void window.electronNative.setTitleBarOverlay({ color: '#444343', symbolColor: '#ffffff' })`);
    assert.equal(await evaluate('window.titlebarOptions.color'), '#444343');
    runtime.start();
    await until(async () => (await evaluate('window.titlebarOptions?.color')) === '#00000000', 'Periodic heartbeat did not restore transparent titlebar overlay');
    await evaluate(`document.body.style.background = 'color-mix(in srgb, #ffffff 10%, #3c3b3b)'`);
    assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor.startsWith('color(srgb')`), true);
    hideWallpaper = true;
    await runtime.update(true, true);
    assert.match(await evaluate('window.titlebarOptions?.color'), /^rgb\(\d+, \d+, \d+\)$/, '!hasCss must normalize color(srgb ...) shell background to rgb(...)');
    hideWallpaper = false;
    await runtime.update(true, true);
    assert.equal(await evaluate('window.titlebarOptions?.color'), '#00000000');
    await evaluate(`(()=>{
        const box = document.querySelector('[data-testid="autoscroll-viewport"]');
        const track = document.createElement('div');
        track.id = 'dispose-clip-check';
        track.setAttribute('data-overlay-scrollbar-track', '');
        track.style.cssText = 'position:fixed;top:-20px;left:10px;width:12px;height:120px;clip-path:inset(30px 0px 0px 0px);';
        document.body.append(track);
        void box;
    })()`);
    await runtime.stop();
    assert.equal(await evaluate(`(() => { const t = document.querySelector('#dispose-clip-check'); const v = t.style.clipPath; t.remove(); return v; })()`), '', 'dispose() must clear clip-path on floating scrollbar tracks');
    assert.match(await evaluate('window.titlebarOptions?.color'), /^rgb\(\d+, \d+, \d+\)$/, 'dispose() must normalize color(srgb ...) shell background to rgb(...)');
    await evaluate(`document.body.style.removeProperty('background')`);

    const storeTestDir = join(directory, 'store-reload-check');
    const store = new SettingsStore(storeTestDir, profile);
    await store.save({ ...settings, opacity: 31 });
    assert.equal(await store.reloadIfChanged(), false);
    await delay(50);
    await writeFile(join(storeTestDir, 'settings.json'), JSON.stringify(appearance.normalize({ ...settings, opacity: 64, composerBlur: 7 })));
    assert.equal(await store.reloadIfChanged(), true);
    assert.equal(store.settings.opacity, 64);
    assert.equal(store.settings.composerBlur, 7);
    assert.equal(store.settings.bubbleBlur, 7);
    assert.equal(await store.reloadIfChanged(), false);

    // Regression: persistence.cjs ASAR boot-switch install/idempotency/restore, shortcut backup/repair/restore & MISSING_DEVTOOLS_PORT UI flow
    const persistTestRoot = join(directory, 'persist-check');
    const fakeInstall = join(persistTestRoot, 'app');
    const fakeRes = join(fakeInstall, 'resources');
    const fakeHome = join(persistTestRoot, 'home');
    const fakeDesktop = join(fakeHome, 'Desktop');
    const fakeStart = join(fakeHome, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    await mkdir(fakeRes, { recursive: true });
    await mkdir(fakeDesktop, { recursive: true });
    await mkdir(fakeStart, { recursive: true });
    await writeFile(join(fakeInstall, 'Antigravity.exe'), '');
    const sampleMain = Buffer.from('"use strict";\nconst electron_1 = require("electron");\nelectron_1.app.whenReady().then(()=>{});\n', 'utf8');
    const samplePkg = Buffer.from('{"name":"antigravity"}', 'utf8');
    const buildTestAsar = entries => {
        const chunks = [];
        let cursor = 0;
        const header = { files: {} };
        const hashOf = buf => createHash('sha256').update(buf).digest('hex');
        for (const [p, buf] of Object.entries(entries)) {
            const parts = p.split('/');
            let cur = header;
            for (let i = 0; i < parts.length - 1; i++) {
                cur.files[parts[i]] ??= { files: {} };
                cur = cur.files[parts[i]];
            }
            cur.files[parts[parts.length - 1]] = {
                size: buf.length,
                offset: String(cursor),
                integrity: { algorithm: 'SHA256', hash: hashOf(buf), blockSize: 4194304, blocks: [hashOf(buf)] },
            };
            chunks.push(buf);
            cursor += buf.length;
        }
        const json = Buffer.from(JSON.stringify(header), 'utf8');
        const aligned = (json.length + 3) & ~3;
        const prefix = Buffer.alloc(16);
        prefix.writeUInt32LE(4, 0);
        prefix.writeUInt32LE(aligned + 8, 4);
        prefix.writeUInt32LE(aligned + 4, 8);
        prefix.writeUInt32LE(json.length, 12);
        return Buffer.concat([prefix, json, Buffer.alloc(aligned - json.length), ...chunks]);
    };
    const origAsar = buildTestAsar({ 'package.json': samplePkg, 'dist/main.js': sampleMain });
    const fakeAsarPath = join(fakeRes, 'app.asar');
    await writeFile(fakeAsarPath, origAsar);
    const patch1 = persistence.installAsarPersist(fakeInstall);
    assert.equal(patch1.status, 'patched');
    const patchedMainText = persistence.readAsarEntry(await readFile(fakeAsarPath), 'dist/main.js').toString('utf8');
    assert.match(patchedMainText, /\/\*antigravity-ui-persist\*\/[\s\S]*appendSwitch\('remote-debugging-port','0'\)/);
    assert.equal(patchedMainText.indexOf('/*antigravity-ui-persist*/') < patchedMainText.indexOf('whenReady'), true);
    assert.equal(persistence.installAsarPersist(fakeInstall).status, 'already-patched');
    assert.equal(persistence.inspectAsarPersist(fakeInstall).patched, true);
    assert.equal(persistence.restoreAsarPersist(fakeInstall).status, 'restored');
    assert.equal(Buffer.compare(await readFile(fakeAsarPath), origAsar), 0, 'Restored app.asar must match original bytes');
    assert.equal(persistence.inspectAsarPersist(fakeInstall).patched, false);

    // Shortcut patch & restore + Sidecar MISSING_DEVTOOLS_PORT repair UI
    const launcherDir = join(persistTestRoot, 'proxy');
    await mkdir(launcherDir, { recursive: true });
    await writeFile(join(launcherDir, 'AntigravityLauncher.exe'), '');
    await writeFile(join(persistTestRoot, 'OtherApp.exe'), '');
    const desktopLnk = join(fakeDesktop, 'Antigravity.lnk');
    const startLnk = join(fakeStart, 'Antigravity.lnk');
    const otherLnk = join(fakeDesktop, 'OtherApp.lnk');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$req = [Console]::In.ReadToEnd() | ConvertFrom-Json; $ws = New-Object -ComObject WScript.Shell; ' +
        'foreach ($i in $req) { $s = $ws.CreateShortcut($i.p); $s.TargetPath = $i.t; $s.Arguments = $i.a; $s.Save() }',
    ], {
        input: JSON.stringify([
            { p: desktopLnk, t: join(launcherDir, 'AntigravityLauncher.exe'), a: '--proxy-flag' },
            { p: startLnk, t: join(fakeInstall, 'Antigravity.exe'), a: '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1' },
            { p: otherLnk, t: join(persistTestRoot, 'OtherApp.exe'), a: '--keep-me' },
        ]),
        windowsHide: true,
    });
    const fakeBackupJson = join(fakeHome, '.gemini', 'config', 'antigravity-ui.shortcuts.bak.json');
    const scRes1 = persistence.patchShortcuts({ home: fakeHome, installation: fakeInstall, backupPath: fakeBackupJson });
    assert.equal(scRes1.total, 2);
    assert.equal(scRes1.repaired, 1);
    assert.equal(scRes1.ready, 2);
    assert.match(scRes1.shortcuts.find(s => s.path === desktopLnk).args, /--proxy-flag.*--remote-debugging-port=0.*--remote-debugging-address=127\.0\.0\.1/);
    const otherArgs = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$ws = New-Object -ComObject WScript.Shell; $ws.CreateShortcut([Console]::In.ReadToEnd().Trim()).Arguments',
    ], { input: otherLnk, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(otherArgs, '--keep-me', 'Unrelated shortcuts must never be altered');

    const missRuntime = new WallpaperRuntime(join(persistTestRoot, 'missing-profile'), () => ({ enabled: false }), async () => true, '9999');
    await missRuntime.update(true, true);
    assert.equal(missRuntime.health.errorCode, 'MISSING_DEVTOOLS_PORT');
    assert.doesNotMatch(missRuntime.health.error, /ENOENT/);

    // Launch a lightweight Sidecar pointing at missing DevToolsActivePort to verify /api/repair-shortcuts + #repair-launch UI
    const missProbe = createServer();
    await new Promise(resolve => missProbe.listen(0, '127.0.0.1', resolve));
    const missPort = missProbe.address().port;
    await new Promise(resolve => missProbe.close(resolve));
    let missErr = '';
    const missSidecar = spawn(process.execPath, [join(project, 'sidecars', 'panel', 'main.mjs')], {
        env: {
            ...environment,
            USERPROFILE: fakeHome,
            AG_UI_HOME: fakeHome,
            AG_UI_INSTALLATION: fakeInstall,
            AG_UI_PROFILE: join(persistTestRoot, 'missing-profile'),
            ANTIGRAVITY_LS_ADDRESS: host,
            ANTIGRAVITY_CSRF_TOKEN: 'test',
            ANTIGRAVITY_SIDECAR_WEB_PORT: String(missPort),
            ANTIGRAVITY_SIDECAR_UI_TOKEN: 'test-miss',
            ANTIGRAVITY_EXECUTABLE_DATA_DIR: join(persistTestRoot, 'miss-data'),
        },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    missSidecar.stderr.on('data', chunk => { missErr += chunk; });
    let missClient;
    try {
        const missUrl = 'http://127.0.0.1:' + missPort + '/?token=test-miss';
        await until(async () => (await fetch('http://127.0.0.1:' + missPort + '/api/settings')).ok, 'Missing-port Sidecar did not start: ' + missErr);
        // Restore desktop shortcut first so button actually repairs 1 shortcut
        assert.equal(persistence.restoreShortcuts({ backupPath: fakeBackupJson }).restored, 1);
        const missTarget = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(missUrl), { method: 'PUT' }).then(r => r.json());
        missClient = new Connection(missTarget.webSocketDebuggerUrl);
        await missClient.open();
        await until(() => evalOn(missClient, 'Boolean(document.querySelector("#repair-launch")) && !document.querySelector("#repair-launch").hidden', 'Repair button'), '#repair-launch button did not appear when DevToolsActivePort is missing');
        await evalOn(missClient, 'document.querySelector("#repair-launch").click()', 'Click repair button');
        await until(() => evalOn(missClient, 'document.querySelector("#status").textContent.includes("已为 1 个快捷方式")', 'Repair status'), '#repair-launch did not update desktop shortcut via /api/repair-shortcuts');
        const restoredAfterUi = persistence.restoreShortcuts({ backupPath: fakeBackupJson });
        assert.equal(restoredAfterUi.restored, 1);
    } finally {
        missClient?.close();
        missSidecar.kill('SIGTERM');
        await new Promise(resolve => missSidecar.exitCode !== null ? resolve() : missSidecar.once('exit', resolve));
    }

    console.log('Passed: 0.3.8 bound composer/dialog layered depth, flat leftSidebar/rightPanel (seam-free & aligned tab strip), independent flat Overview panel, autoscroll-viewport mask/blur, HOME_VIEW z-[1] & unified top-toolbar composer, multi-window discovery & BroadcastChannel/focus/reloadIfChanged sync, floating scrollbar clipping, dual persistence (ASAR + shortcuts), plus all Q1-Q5 rendering/save interactions.');
    await Promise.race([client.command('Browser.close'), delay(300)]);
} finally {
    client?.close();
    panelClient?.close();
    panelClient2?.close();
    embedClient?.close();
    iframeClient?.close();
    host2Client?.close();
    host3Client?.close();
    browser.kill();
    sidecar.kill('SIGTERM');
    duplicate?.kill('SIGTERM');
    server.close();
    embedServer.close();
    await delay(500);
    await rm(directory, { recursive: true, force: true });
}
