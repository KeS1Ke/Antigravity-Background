import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Connection, WallpaperRuntime } from '../sidecars/panel/runtime.mjs';
import { SettingsStore } from '../sidecars/panel/store.mjs';
import appearance from '../plugin/appearance.cjs';

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
assert.equal(appearance.normalize({ composerInnerColor: '#AABBCC' }).composerInnerColor, '#aabbcc');
assert.deepEqual(
    (() => {
        const s = appearance.normalize({
            bubbleCover: false, bubbleOpacity: 42, bubbleBlur: 9,
            bubbleOuterColor: '#112233', bubbleInnerColor: '#AABBCC',
            overviewOpacity: 90, overviewBlur: 2, overviewOuterColor: '#ff0000',
        });
        return [s.overviewSync, s.overviewCover, s.overviewOpacity, s.overviewBlur, s.overviewOuterColor, s.overviewInnerColor];
    })(),
    [true, false, 42, 9, '#112233', '#aabbcc']
);
assert.deepEqual(
    (() => {
        const s = appearance.normalize({
            overviewSync: false, bubbleOpacity: 42,
            overviewCover: false, overviewOpacity: 75, overviewBlur: 12,
            overviewOuterColor: '#445566', overviewInnerColor: '#778899',
        });
        return [s.overviewSync, s.bubbleOpacity, s.overviewCover, s.overviewOpacity, s.overviewBlur, s.overviewOuterColor, s.overviewInnerColor];
    })(),
    [false, 42, false, 75, 12, '#445566', '#778899']
);
assert.throws(() => appearance.normalize({ composerOuterColor: 'red; background:url(test)' }), /颜色/);
assert.throws(() => appearance.normalize({ composerInnerColor: 123 }), /颜色/);
assert.throws(() => appearance.normalize({ bubbleOuterColor: 'red' }), /颜色/);
assert.throws(() => appearance.normalize({ overviewInnerColor: '#123' }), /颜色/);
assert.equal(JSON.parse(await readFile(join(project, 'sidecars/panel/sidecar.json'), 'utf8')).ui_config.views[0].title, 'Antigravity Background');
await writeFile(join(data, 'settings.json'), JSON.stringify(settings));

const fixture = '<!doctype html><style>body{margin:0;background:#18191c}.agy-inset-shell{position:absolute;inset:35px 0 0}.agy-sheet{height:100%;position:relative;z-index:0}.outline-none{display:flex;height:100%}.main{flex:1;position:relative;display:flex;flex-direction:column}.pane{width:300px;height:100%;background:#121315}.closed .pane{width:0;overflow:hidden}.surface-composer-card{backdrop-filter:none!important}.z-\\[1\\]{z-index:1}[data-testid="autoscroll-viewport"]{width:400px;height:160px;overflow:auto;isolation:isolate;mask-image:linear-gradient(to bottom,transparent,black 24px);-webkit-mask-image:linear-gradient(to bottom,transparent,black 24px)}[data-testid="overview-panel-overlay-backdrop"]{position:absolute;top:8px;right:8px;width:230px;height:100px;z-index:40}[data-testid="overview-panel-host-overlay"]{position:absolute;top:8px;right:8px;width:220px;height:90px;background:white;border:1px solid rgba(128,128,128,0.22);z-index:50}body[data-has-browser-hole="true"] .agy-sheet[data-sheet-inset] :is([data-main-content-body], [data-side-panel-body]){box-shadow:0 0 0 20px #121315;clip-path:inset(0 0 -8px 0)}body[data-has-three-layer-browser-hole="true"] [data-split-root="true"][data-split-three-layer-slide="true"][data-has-browser-hole="true"][data-split-transition] > [data-split-fill-edge]:not([data-has-browser-hole="true"]){clip-path:inset(0%)}</style>' +
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
    '</div></div><div></div><div class="pane"><div class="h-full w-full" style="position:absolute;inset:0;z-index:10"><div class="browser-hole-ancestor"><div id="tabs" style="height:40px"><button id="tab">README.md</button></div><div class="flex-grow overflow-hidden" data-side-panel-body="true" style="height:calc(100% - 40px)"></div></div></div></div></div></div>' +
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

const browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
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
    const surfaceState = () => evaluate("(()=>{const sidebar=getComputedStyle(document.querySelector('.pane .flex-grow'));const composer=getComputedStyle(document.querySelector('.surface-composer-card'));const outer=getComputedStyle(document.querySelector('.surface-composer'));const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');function rgba(color){g.clearRect(0,0,1,1);g.fillStyle=color;g.fillRect(0,0,1,1);return [...g.getImageData(0,0,1,1).data]}return{sidebarAlpha:rgba(sidebar.backgroundColor)[3],sidebarBlur:sidebar.backdropFilter,composerAlpha:rgba(composer.backgroundColor)[3],composerRgb:rgba(composer.backgroundColor).slice(0,3),composerBlur:composer.backdropFilter,outerBg:outer.backgroundColor,outerShadow:outer.boxShadow,tools:getComputedStyle(document.querySelector('#window-tools')).backgroundColor}})()");
    const surfaces = await surfaceState();
    assert(Math.abs(surfaces.sidebarAlpha - 89) <= 1);
    assert.equal(surfaces.sidebarBlur, 'blur(10px)');
    assert(Math.abs(surfaces.composerAlpha - 140) <= 1);
    assert.equal(surfaces.composerBlur, 'blur(6px)');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#tabs')).backgroundColor"), 'rgba(0, 0, 0, 0)');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane')).zIndex"), 'auto');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane > .h-full')).zIndex"), 'auto');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pane .flex-grow')).zIndex"), '1001');
    const tabHit = await evaluate("(()=>{const e=document.querySelector('#tab'),b=e.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===e})()");
    assert.equal(tabHit, true, 'Wallpaper must not block tab clicks');

    await save(webPort, 40, false, { composerOuterColor: '#ff0000', composerInnerColor: '#00ff00' });
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.surface-composer-card')).backgroundColor"), 'color(srgb 0 1 0)');
    assert.match(await evaluate("getComputedStyle(document.querySelector('.surface-composer')).boxShadow"), /color\(srgb 1 0 0\).*inset/);
    assert.equal(surfaces.tools, 'rgba(0, 0, 0, 0)');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#window-tools > .right-full')).backgroundImage"), 'none');

    // Q3: Default empty composerOuterColor and composerCover: false both retain 1px inset border without solid white background block
    const insetBorder = /(?:0px ){3}1px.*inset|inset.*(?:0px ){3}1px/;
    await save(webPort, 40, false, { composerCover: true, composerOuterColor: '' });
    const defaultOuter = await surfaceState();
    assert.equal(defaultOuter.outerBg, 'rgba(0, 0, 0, 0)');
    assert.match(defaultOuter.outerShadow, insetBorder);

    await save(webPort, 40, false, { sidebarOpacity: 35, sidebarBlur: 10, composerCover: false, composerOpacity: 55, composerBlur: 6 });
    const uncovered = await surfaceState();
    assert.equal(uncovered.composerAlpha, 0);
    assert.equal(uncovered.composerBlur, 'blur(0px)');
    assert.equal(uncovered.outerBg, 'rgba(0, 0, 0, 0)');
    assert.match(uncovered.outerShadow, insetBorder);
    assert.equal(uncovered.sidebarAlpha, surfaces.sidebarAlpha);
    assert.deepEqual(await geometry(), initialGeometry);

    await save(webPort, 40, false, { sidebarOpacity: 35, sidebarBlur: 10, composerCover: false, composerOuterColor: '#ffffff', composerOpacity: 55, composerBlur: 6 });
    const uncoveredWithColor = await surfaceState();
    assert.equal(uncoveredWithColor.outerBg, 'rgba(0, 0, 0, 0)');
    assert.match(uncoveredWithColor.outerShadow, insetBorder);
    assert.doesNotMatch(uncoveredWithColor.outerShadow, /255,\s*255,\s*255|srgb 1 1 1/);

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
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-bubble-outer').trim()"), 'var(--ag-ui-border)');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-overview-outer').trim()"), 'var(--ag-ui-border)');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-bubble-blur').trim()"), '0px');
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
    await until(async () => (await surfaceState()).composerBlur === 'blur(4px)', 'Composer blur did not live-update at opacity 0');
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

    // Q3: Subcontrol disabled states when sidebarCover / composerCover are false
    assert.equal(await panel("document.querySelector('[data-reset-color=composerOuterColor]').disabled"), true);
    await panel("document.querySelector('#sidebar-cover').click()");
    assert.equal(await panel("document.querySelector('#wallpaper-sidebarOpacity').disabled"), true);
    assert.equal(await panel("document.querySelector('#wallpaper-sidebarBlur').disabled"), true);
    await panel("(()=>{const oc=document.querySelector('#composerOuterColor');oc.value='#2468ac';oc.dispatchEvent(new Event('input'));})()");
    assert.equal(await panel("document.querySelector('[data-reset-color=composerOuterColor]').disabled"), false);
    await panel("document.querySelector('#composer-cover').click()");
    assert.deepEqual(await panel("[document.querySelector('#composerOuterColor').disabled,document.querySelector('#composerInnerColor').disabled,document.querySelector('[data-reset-color=composerOuterColor]').disabled,document.querySelector('[data-reset-color=composerInnerColor]').disabled,document.querySelector('#wallpaper-composerOpacity').disabled,document.querySelector('#wallpaper-composerBlur').disabled]"), [true, true, true, true, true, true]);
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-outer').trim()"), 'var(--ag-ui-border)');
    await panel("document.querySelector('#discard').click()");
    await waitDiscard();

    // Existing accordion, color save, default outer border save, independent controls save, delayed preview/save, invalid 400
    assert.equal(await panel("document.querySelectorAll('input[type=range]').length"), 13);
    assert.equal(await panel("document.querySelectorAll('details').length"), 7);
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

    await panel("(()=>{const transport=window.sidecar||window;const original=transport.fetch.bind(transport);transport.fetch=async(path,options)=>{if(path==='/api/preview'){window.previewStarted=true;await new Promise(r=>setTimeout(r,200));}return original(path,options);};const input=document.querySelector('#wallpaper-opacity');input.value=61;input.dispatchEvent(new Event('input'));})()");
    await until(() => panel('window.previewStarted'), 'Delayed preview did not start');
    await panel("(()=>{const input=document.querySelector('#wallpaper-opacity');input.value=79;input.dispatchEvent(new Event('input'));document.querySelector('#save').click();})()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已保存')"), 'Save did not follow pending preview');
    assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).opacity, 79);
    await delay(1800);
    assert.equal(await evaluate("getComputedStyle(window.testRoots.get(document.querySelector('#antigravity-ui-background')).querySelector('.image')).opacity"), '0.79', 'Delayed preview must not overwrite saved values');

    const invalid = await fetch('http://127.0.0.1:' + webPort + '/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sidecar-token': 'test' },
        body: JSON.stringify({ ...settings, composerInnerColor: 'invalid' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).opacity, 79);

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
            return{frameBg:f.backgroundColor,frameShadow:f.boxShadow,frameRgba:shadowRgba(f.boxShadow),bgRgba:rgba(b.backgroundColor),blur:b.backdropFilter,shadow:b.boxShadow};
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
            overview:{backdropZ:bd.zIndex,hostZ:ov.zIndex,bgRgba:rgba(ov.backgroundColor),blur:ov.backdropFilter,borderColor:ov.borderTopColor,borderRgba:rgba(ov.borderTopColor)},
            homeComposer:{wrapperZ:zw.zIndex,outerBgRgba:rgba(hc.backgroundColor),outerBlur:hc.backdropFilter,outerShadow:hc.boxShadow,outerShadowRgba:shadowRgba(hc.boxShadow),cardBg:hcc.backgroundColor,cardBlur:hcc.backdropFilter,cardShadow:hcc.boxShadow},
            normalComposer:{outerBg:nc.backgroundColor,outerBlur:nc.backdropFilter,outerShadow:nc.boxShadow,outerShadowRgba:shadowRgba(nc.boxShadow),cardBgRgba:rgba(ncc.backgroundColor),cardBlur:ncc.backdropFilter,cardShadow:ncc.boxShadow},
        };
    })()`, 'Read host surfaces');

    // (c) Cross-session composer unification: HOME_VIEW .z-[1] and toolbarPlacement="top" single-layer fill/blur/inset border
    await panel("(()=>{const d=document.querySelector('#composer-cover').closest('details');if(!d.open)d.querySelector('summary').click();document.querySelector('#composer-cover').click();const set=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event('input'));};set('#composerOuterColor','#ff0000');set('#composerInnerColor','#00ff00');set('#wallpaper-composerOpacity',55);set('#wallpaper-composerBlur',6);})()");
    await until(async () => (await readHostSurfaces(client)).homeComposer.outerBlur === 'blur(6px)', 'HOME_VIEW top-toolbar composer did not update');
    const unifiedHome = await readHostSurfaces(client);
    assert.equal(unifiedHome.homeComposer.wrapperZ, '1001');
    approxRgba(unifiedHome.homeComposer.outerBgRgba, [0, 255, 0, 140]);
    assert.equal(unifiedHome.homeComposer.outerBlur, 'blur(6px)');
    assert.match(unifiedHome.homeComposer.outerShadow, insetBorder);
    approxRgba(unifiedHome.homeComposer.outerShadowRgba, [255, 0, 0, 140]);
    assert.equal(unifiedHome.homeComposer.cardBg, 'rgba(0, 0, 0, 0)');
    assert.equal(unifiedHome.homeComposer.cardBlur, 'none');
    assert.equal(unifiedHome.homeComposer.cardShadow, 'none');
    assert.equal(unifiedHome.normalComposer.outerBg, 'rgba(0, 0, 0, 0)');
    assert.equal(unifiedHome.normalComposer.outerBlur, 'none');
    assert.match(unifiedHome.normalComposer.outerShadow, insetBorder);
    approxRgba(unifiedHome.normalComposer.outerShadowRgba, [255, 0, 0, 140]);
    approxRgba(unifiedHome.normalComposer.cardBgRgba, [0, 255, 0, 140]);
    assert.equal(unifiedHome.normalComposer.cardBlur, 'blur(6px)');
    assert.equal(unifiedHome.normalComposer.cardShadow, 'none');
    const homeEditorHit = await evaluate("(()=>{const e=document.querySelector('#home-editor'),b=e.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===e})()");
    assert.equal(homeEditorHit, true, 'HOME_VIEW composer editor must be interactive above wallpaper');

    await panel("document.querySelector('#composer-cover').click()");
    await until(async () => (await readHostSurfaces(client)).homeComposer.outerBgRgba[3] === 0, 'Disabling composerCover did not clear HOME_VIEW composer');
    const uncoveredHome = await readHostSurfaces(client);
    assert.equal(uncoveredHome.homeComposer.outerBlur, 'blur(0px)');
    assert.match(uncoveredHome.homeComposer.outerShadow, insetBorder);
    assert.notDeepEqual(uncoveredHome.homeComposer.outerShadowRgba.slice(0, 3), [255, 0, 0]);
    assert.equal(uncoveredHome.homeComposer.cardBg, 'rgba(0, 0, 0, 0)');
    assert.equal(uncoveredHome.homeComposer.cardShadow, 'none');
    await panel("document.querySelector('#discard').click()");
    await waitDiscard();

    // (a) Shared "对话框与面板" card, overviewSync, independent Overview toggle, and non-leaking disabled controls
    assert.equal(await panel("document.querySelector('#overview-sync').checked"), true);
    assert.equal(await panel("document.querySelector('#dialog-target-switch').hidden"), true);
    assert.equal(await panel("getComputedStyle(document.querySelector('#dialog-target-switch')).display"), 'none');
    assert.deepEqual(await panel("[...document.querySelectorAll('[data-dialog-target]')].map(b=>b.disabled)"), [true, true]);

    await panel("(()=>{const d=document.querySelector('#dialog-cover').closest('details');if(!d.open)d.querySelector('summary').click();})()");
    assert.equal(await panel("document.querySelector('#dialog-cover').closest('details').open"), true);
    await panel("(()=>{const set=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event('input'));};set('#dialogOuterColor','#ff0000');set('#dialogInnerColor','#00ff00');set('#wallpaper-dialogOpacity',60);set('#wallpaper-dialogBlur',8);})()");
    await until(async () => {
        const s = await readHostSurfaces(client);
        return s.regularBubble.blur === 'blur(8px)' && s.overview.blur === 'blur(8px)';
    }, 'Synced dialog + Overview live preview did not apply');
    const syncedHost = await readHostSurfaces(client);
    for (const bubble of [syncedHost.regularBubble, syncedHost.proceededBubble]) {
        assert.equal(bubble.frameBg, 'rgba(0, 0, 0, 0)');
        assert.match(bubble.frameShadow, insetBorder);
        approxRgba(bubble.frameRgba, [255, 0, 0, 153]);
        approxRgba(bubble.bgRgba, [0, 255, 0, 153]);
        assert.equal(bubble.blur, 'blur(8px)');
        assert.equal(bubble.shadow, 'none');
    }
    assert.equal(syncedHost.overview.backdropZ, '1002');
    assert.equal(syncedHost.overview.hostZ, '1002');
    approxRgba(syncedHost.overview.bgRgba, [0, 255, 0, 153]);
    assert.equal(syncedHost.overview.blur, 'blur(8px)');
    approxRgba(syncedHost.overview.borderRgba, [255, 0, 0, 153]);
    const overviewHit = await evaluate("(()=>{const e=document.querySelector('[data-testid=\"overview-panel-host-overlay\"]'),b=e.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===e})()");
    assert.equal(overviewHit, true, 'Overview panel at z-index 1002 must be interactive above wallpaper');

    const syncedPreviewVars = await panel("(()=>{const s=document.querySelector('#preview').style;const get=k=>s.getPropertyValue(k).trim();return{bOut:get('--preview-bubble-outer'),bIn:get('--preview-bubble-inner'),bBlur:get('--preview-bubble-blur'),oOut:get('--preview-overview-outer'),oIn:get('--preview-overview-inner'),oBlur:get('--preview-overview-blur')}})()");
    assert.match(syncedPreviewVars.bOut, /#ff0000.*60%/);
    assert.match(syncedPreviewVars.bIn, /#00ff00.*60%/);
    assert.notEqual(syncedPreviewVars.bBlur, '0px');
    assert.equal(syncedPreviewVars.oOut, syncedPreviewVars.bOut);
    assert.equal(syncedPreviewVars.oIn, syncedPreviewVars.bIn);
    assert.equal(syncedPreviewVars.oBlur, syncedPreviewVars.bBlur);

    // Disable overviewSync -> target switch appears -> independently edit Overview without affecting bubbles
    await panel("document.querySelector('#overview-sync').click()");
    assert.equal(await panel("document.querySelector('#overview-sync').checked"), false);
    assert.equal(await panel("document.querySelector('#dialog-target-switch').hidden"), false);
    assert.notEqual(await panel("getComputedStyle(document.querySelector('#dialog-target-switch')).display"), 'none');
    await panelClient.command('Emulation.setDeviceMetricsOverride', { width: 480, height: 750, deviceScaleFactor: 1, mobile: false });
    try {
        const tabs480 = await panel("(()=>{const btns=[...document.querySelectorAll('#dialog-target-switch [data-dialog-target]')];return{overflow:document.documentElement.scrollWidth>window.innerWidth,buttons:btns.map(b=>({sw:b.scrollWidth,cw:b.clientWidth,top:Math.round(b.getBoundingClientRect().top)}))}})()");
        assert.equal(tabs480.overflow, false, '480px panel with #dialog-target-switch must not overflow horizontally');
        assert.equal(tabs480.buttons.length, 2);
        for (const btn of tabs480.buttons) assert(btn.sw <= btn.cw, `Target button text truncated at 480px: scrollWidth=${btn.sw} > clientWidth=${btn.cw}`);
        assert.equal(tabs480.buttons[0].top, tabs480.buttons[1].top, 'Target switch buttons at 480px should remain on same row');
    } finally {
        await panelClient.command('Emulation.clearDeviceMetricsOverride');
    }
    await panel("document.querySelector('[data-dialog-target=\"overview\"]').click()");
    assert.equal(await panel("document.querySelector('[data-dialog-target=\"overview\"]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await panel("document.querySelector('[data-dialog-target=\"bubble\"]').getAttribute('aria-pressed')"), 'false');
    await panel("(()=>{const set=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event('input'));};set('#dialogOuterColor','#0000ff');set('#dialogInnerColor','#ffff00');set('#wallpaper-dialogOpacity',30);set('#wallpaper-dialogBlur',12);})()");
    await until(async () => (await readHostSurfaces(client)).overview.blur === 'blur(12px)', 'Independent Overview adjustment did not apply');
    const splitHost = await readHostSurfaces(client);
    approxRgba(splitHost.overview.bgRgba, [255, 255, 0, 77]);
    approxRgba(splitHost.overview.borderRgba, [0, 0, 255, 77]);
    assert.equal(splitHost.overview.blur, 'blur(12px)');
    assert.equal(splitHost.overview.hostZ, '1002');
    for (const bubble of [splitHost.regularBubble, splitHost.proceededBubble]) {
        approxRgba(bubble.frameRgba, [255, 0, 0, 153]);
        approxRgba(bubble.bgRgba, [0, 255, 0, 153]);
        assert.equal(bubble.blur, 'blur(8px)');
    }
    const splitPreviewVars = await panel("(()=>{const s=document.querySelector('#preview').style;const get=k=>s.getPropertyValue(k).trim();return{bOut:get('--preview-bubble-outer'),bIn:get('--preview-bubble-inner'),oOut:get('--preview-overview-outer'),oIn:get('--preview-overview-inner')}})()");
    assert.match(splitPreviewVars.bOut, /#ff0000.*60%/);
    assert.match(splitPreviewVars.bIn, /#00ff00.*60%/);
    assert.match(splitPreviewVars.oOut, /#0000ff.*30%/);
    assert.match(splitPreviewVars.oIn, /#ffff00.*30%/);

    // Re-check overviewSync -> Overview immediately mirrors back to bubbles
    await panel("document.querySelector('#overview-sync').click()");
    assert.equal(await panel("document.querySelector('#overview-sync').checked"), true);
    assert.equal(await panel("document.querySelector('#dialog-target-switch').hidden"), true);
    await until(async () => (await readHostSurfaces(client)).overview.blur === 'blur(8px)', 'Re-enabling overviewSync did not mirror back');
    const resyncedHost = await readHostSurfaces(client);
    approxRgba(resyncedHost.overview.bgRgba, [0, 255, 0, 153]);
    approxRgba(resyncedHost.overview.borderRgba, [255, 0, 0, 153]);

    // Turn off #dialog-cover -> subcontrols disabled & hidden colors do not leak
    await panel("document.querySelector('#dialog-cover').click()");
    assert.deepEqual(await panel("[document.querySelector('#dialogOuterColor').disabled,document.querySelector('#dialogInnerColor').disabled,document.querySelector('[data-reset-dialog-color=\"outer\"]').disabled,document.querySelector('[data-reset-dialog-color=\"inner\"]').disabled,document.querySelector('#wallpaper-dialogOpacity').disabled,document.querySelector('#wallpaper-dialogBlur').disabled]"), [true, true, true, true, true, true]);
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-bubble-outer').trim()"), 'var(--ag-ui-border)');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-overview-outer').trim()"), 'var(--ag-ui-border)');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-bubble-blur').trim()"), '0px');
    assert.equal(await panel("document.querySelector('#preview').style.getPropertyValue('--preview-overview-blur').trim()"), '0px');
    await until(async () => (await readHostSurfaces(client)).regularBubble.blur === 'blur(0px)', 'Disabling dialogCover did not clear bubble blur');
    const uncoveredDialog = await readHostSurfaces(client);
    for (const bubble of [uncoveredDialog.regularBubble, uncoveredDialog.proceededBubble]) {
        assert.equal(bubble.bgRgba[3], 0);
        assert.equal(bubble.blur, 'blur(0px)');
        assert.match(bubble.frameShadow, insetBorder);
        assert.notDeepEqual(bubble.frameRgba.slice(0, 3), [255, 0, 0]);
    }
    assert.equal(uncoveredDialog.overview.bgRgba[3], 0);
    assert.equal(uncoveredDialog.overview.blur, 'blur(0px)');
    assert.notDeepEqual(uncoveredDialog.overview.borderRgba.slice(0, 3), [255, 0, 0]);

    // Independent cover: enable bubble cover only while Overview remains uncovered without color leak
    await panel("(()=>{document.querySelector('#overview-sync').click();document.querySelector('[data-dialog-target=\"bubble\"]').click();document.querySelector('#dialog-cover').click();})()");
    await until(async () => (await readHostSurfaces(client)).regularBubble.blur === 'blur(8px)', 'Re-enabling bubble cover independently did not apply');
    const bubbleOnlyHost = await readHostSurfaces(client);
    approxRgba(bubbleOnlyHost.regularBubble.bgRgba, [0, 255, 0, 153]);
    assert.equal(bubbleOnlyHost.overview.bgRgba[3], 0);
    assert.notDeepEqual(bubbleOnlyHost.overview.borderRgba.slice(0, 3), [255, 0, 0]);
    await panel("document.querySelector('#discard').click()");
    await waitDiscard();

    // (b) Scrollable autoscroll-viewport mask-image vs Backdrop Filter
    await evaluate("document.querySelector('[data-testid=\"autoscroll-viewport\"]').scrollTop = 20");
    const blurZeroState = await readHostSurfaces(client);
    assert.equal(blurZeroState.viewport.isolation, 'auto');
    assert.equal(blurZeroState.viewport.zIndex, '1001');
    assert.match(blurZeroState.viewport.maskImage, /linear-gradient/);
    assert.match(blurZeroState.viewport.webkitMaskImage, /linear-gradient/);

    await panel("(()=>{const b=document.querySelector('#wallpaper-dialogBlur');b.value=10;b.dispatchEvent(new Event('input'));})()");
    await until(async () => (await readHostSurfaces(client)).regularBubble.blur === 'blur(10px)', 'bubbleBlur > 0 did not apply');
    const blurActiveState = await readHostSurfaces(client);
    assert.equal(blurActiveState.viewport.isolation, 'auto');
    assert.equal(blurActiveState.viewport.zIndex, '1001');
    assert.equal(blurActiveState.viewport.maskImage, 'none');
    assert.equal(blurActiveState.viewport.webkitMaskImage, 'none');
    assert.equal(blurActiveState.proceededBubble.blur, 'blur(10px)');

    await panel("(()=>{const b=document.querySelector('#wallpaper-dialogBlur');b.value=0;b.dispatchEvent(new Event('input'));})()");
    await until(async () => (await readHostSurfaces(client)).regularBubble.blur === 'blur(0px)', 'Resetting bubbleBlur to 0 did not clear blur');
    assert.match((await readHostSurfaces(client)).viewport.maskImage, /linear-gradient/);
    await until(() => panel("document.querySelector('#discard').disabled"), 'Reverting bubbleBlur to saved value should clear draft');

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
    await panel("(()=>{const set=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event('input'));};set('#wallpaper-opacity',47);set('#wallpaper-dialogBlur',5);set('#dialogInnerColor','#336699');})()");
    await until(() => panel("document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), 'Panel 1 preview did not finish');
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='47'&&document.querySelector('#wallpaper-dialogBlur').value==='5'&&document.querySelector('#dialogInnerColor').value==='#336699'&&!document.querySelector('#discard').disabled&&document.querySelector('#status').textContent.includes('实时预览 · 未保存')"), 'BroadcastChannel modify did not sync to Panel 2');
    assert.equal(await panel2('window.__fetchLog.length'), 0, 'BroadcastChannel modify sync must not trigger loopback requests on Panel 2');
    assert.match(await panel2("document.querySelector('#preview').style.getPropertyValue('--preview-bubble-inner')"), /#336699/);

    // Panel 1 save -> BroadcastChannel -> Panel 2 (zero loopback)
    await panel("document.querySelector('#save').click()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已保存')"), 'Panel 1 save did not finish');
    await until(() => panel2("document.querySelector('#discard').disabled&&document.querySelector('#status').textContent.includes('已保存')"), 'BroadcastChannel save did not sync to Panel 2');
    assert.equal(await panel2('window.__fetchLog.length'), 0, 'BroadcastChannel save sync must not trigger loopback requests on Panel 2');
    const savedMulti = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
    assert.equal(savedMulti.opacity, 47);
    assert.equal(savedMulti.bubbleBlur, 5);
    assert.equal(savedMulti.bubbleInnerColor, '#336699');

    // Panel 1 modify + discard -> BroadcastChannel -> Panel 2 (zero loopback)
    await panel("(()=>{const o=document.querySelector('#wallpaper-opacity');o.value=82;o.dispatchEvent(new Event('input'));})()");
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='82'&&!document.querySelector('#discard').disabled"), 'BroadcastChannel draft did not reach Panel 2');
    await panel("document.querySelector('#discard').click()");
    await until(() => panel("document.querySelector('#status').textContent.includes('已还原已保存设置')"), 'Panel 1 discard did not finish');
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='47'&&document.querySelector('#discard').disabled&&document.querySelector('#status').textContent.includes('已还原已保存设置')"), 'BroadcastChannel discard did not sync to Panel 2');
    assert.equal(await panel2('window.__fetchLog.length'), 0, 'BroadcastChannel discard sync must not trigger loopback requests on Panel 2');

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
        ...settings, opacity: 23, bubbleBlur: 11, bubbleOuterColor: '#abcdef', overviewSync: false, overviewOpacity: 88,
    })));
    await panel2("window.dispatchEvent(new Event('focus'))");
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='23'&&document.querySelector('#wallpaper-dialogBlur').value==='11'&&document.querySelector('#dialogOuterColor').value==='#abcdef'&&!document.querySelector('#overview-sync').checked"), 'Panel 2 focus resync did not reload external settings.json');
    assert((await panel2('window.__fetchLog')).some(entry => entry.path === '/api/settings' && entry.method === 'GET'));
    await until(async () => (await readHostSurfaces(client)).wallpaperOpacity === '0.23' && (await readHostSurfaces(host2Client)).wallpaperOpacity === '0.23', 'Both high-generation host windows did not sync external settings.json');
    for (const conn of [client, host2Client]) {
        const s = await readHostSurfaces(conn);
        assert.equal(s.viewport.maskImage, 'none');
        assert.equal(s.regularBubble.blur, 'blur(11px)');
        assert.equal(s.proceededBubble.blur, 'blur(11px)');
        approxRgba(s.overview.bgRgba, [19, 19, 19, 224], 5);
    }

    // Heartbeat syncStore() runs before GET /api/settings on high-generation host -> pendingActivate triggers activateRuntime(true)
    const highGenB = (await evaluate('window.__antigravityUiRenderer.generation')) + 20;
    await evaluate(`window.__antigravityUiRenderer.generation = ${highGenB}`);
    await evalOn(host2Client, `window.__antigravityUiRenderer.generation = ${highGenB}`, 'Bump Host 2 generation B');
    await delay(50);
    await writeFile(join(data, 'settings.json'), JSON.stringify(appearance.normalize({
        ...settings, opacity: 34, bubbleBlur: 15, bubbleOuterColor: '#112233',
    })));
    await delay(1650);
    assert.equal((await readHostSurfaces(client)).wallpaperOpacity, '0.23', 'Non-activated heartbeat must not override high-generation host');
    await panel2("window.dispatchEvent(new Event('focus'))");
    await until(() => panel2("document.querySelector('#wallpaper-opacity').value==='34'&&document.querySelector('#wallpaper-dialogBlur').value==='15'"), 'Panel 2 focus did not sync after heartbeat reload');
    await until(async () => (await readHostSurfaces(client)).wallpaperOpacity === '0.34' && (await readHostSurfaces(host2Client)).wallpaperOpacity === '0.34', 'High-generation host windows did not activate via pendingActivate on GET /api/settings');
    assert.equal((await readHostSurfaces(client)).regularBubble.blur, 'blur(15px)');
    assert.equal((await readHostSurfaces(host2Client)).regularBubble.blur, 'blur(15px)');

    // Stale draft cleared by external rewrite + Panel 1 visibilitychange resync
    await panel("(()=>{const o=document.querySelector('#wallpaper-opacity');o.value=71;o.dispatchEvent(new Event('input'));})()");
    await until(() => panel("document.querySelector('#status').textContent.includes('实时预览 · 未保存')&&!document.querySelector('#discard').disabled"), 'Panel 1 stale draft did not activate');
    await delay(50);
    await writeFile(join(data, 'settings.json'), JSON.stringify(appearance.normalize({
        ...settings, opacity: 79, bubbleBlur: 0, composerCover: false, composerInnerColor: '#13579b', sidebarBlur: 7,
    })));
    if (await panel('document.hidden')) await panelClient.command('Page.bringToFront');
    else await panel("document.dispatchEvent(new Event('visibilitychange'))");
    await until(() => panel("document.querySelector('#wallpaper-opacity').value==='79'&&document.querySelector('#wallpaper-dialogBlur').value==='0'&&document.querySelector('#discard').disabled"), 'Panel 1 visibilitychange resync did not clear stale draft and reload settings.json');
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
    const runtime = new WallpaperRuntime(profile, () => ({
        enabled: true,
        css: appearance.wallpaperStyle(settings, 'var(--ag-ui-image)'),
        image: settings.image,
        imageHash: expectedImageHash,
        surfaces: { sidebarCover: true, sidebarOpacity: 100, sidebarBlur: 0, composerCover: true, composerOpacity: 100, composerBlur: 0, composerOuterColor: '', composerInnerColor: '' },
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
    assert.equal(await evaluate('window.__antigravityUiRenderer.version'), 14);
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
        const mainStyle=getComputedStyle(mainBody);
        const splitStyle=getComputedStyle(splitEdge);
        const sideStyle=getComputedStyle(sideBody);
        const hit=sel=>{const el=document.querySelector(sel),b=el.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===el};
        const rect=mainBody.getBoundingClientRect();
        return{
            mainClip:mainStyle.clipPath,
            mainShadow:mainStyle.boxShadow,
            splitClip:splitStyle.clipPath,
            sideClip:sideStyle.clipPath,
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
    await runtime.stop();

    const storeTestDir = join(directory, 'store-reload-check');
    const store = new SettingsStore(storeTestDir, profile);
    await store.save({ ...settings, opacity: 31 });
    assert.equal(await store.reloadIfChanged(), false);
    await delay(50);
    await writeFile(join(storeTestDir, 'settings.json'), JSON.stringify(appearance.normalize({ ...settings, opacity: 64, bubbleBlur: 7 })));
    assert.equal(await store.reloadIfChanged(), true);
    assert.equal(store.settings.opacity, 64);
    assert.equal(store.settings.bubbleBlur, 7);
    assert.equal(await store.reloadIfChanged(), false);

    console.log('Passed: 0.3.8 unified dialog/Overview card & overviewSync, autoscroll-viewport mask/blur, HOME_VIEW z-[1] & top-toolbar composer, multi-window discovery & BroadcastChannel/focus/reloadIfChanged sync, plus all Q1-Q5 rendering/save interactions.');
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
