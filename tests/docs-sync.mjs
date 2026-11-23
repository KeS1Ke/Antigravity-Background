import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENDERER_VERSION, RENDERER_REVISION } from '../sidecars/panel/renderer.mjs';
import { RUNTIME_ROOTS, REQUIRED_RUNTIME_FILES } from '../sidecars/panel/archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DOC_FILES = [
    'README.md',
    'ARCHITECTURE.md',
    'AGENTS.md',
    'GLOSSARY.md',
    'docs/adr/0001-live-preview.md',
];

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function stripFencedCodeBlocks(markdown) {
    return markdown.replace(/```[\s\S]*?```/g, '');
}

function extractBacktickMatches(text, regex) {
    const hits = new Set();
    const codeSpanRe = /`([^`\r\n]+)`/g;
    let span;
    while ((span = codeSpanRe.exec(text)) !== null) {
        const content = span[1];
        const localRe = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
        let m;
        while ((m = localRe.exec(content)) !== null) {
            hits.add(m[0]);
        }
    }
    return hits;
}

function collectRuntimeSourceFiles() {
    const files = ['manage.cjs'];
    for (const dirRel of ['plugin', 'sidecars/panel']) {
        const dirAbs = path.join(REPO_ROOT, dirRel);
        for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
            if (entry.isFile() && /\.(?:cjs|mjs|js)$/.test(entry.name)) {
                files.push(path.posix.join(dirRel, entry.name));
            }
        }
    }
    return files;
}

// 1. 清单与渲染器版本同步
{
    const manifest = JSON.parse(readRepoFile('plugin.json'));
    const sidecar = JSON.parse(readRepoFile('sidecars/panel/sidecar.json'));
    const readme = readRepoFile('README.md');

    assert.ok(manifest.version, 'plugin.json must declare a version');
    assert.ok(
        readme.includes(`version-${manifest.version}-`),
        `README.md version badge is out of sync with plugin.json (${manifest.version})`,
    );
    assert.ok(
        manifest.logo && fs.existsSync(path.join(REPO_ROOT, manifest.logo)),
        `plugin.json logo does not exist: ${manifest.logo}`,
    );

    assert.ok(
        Array.isArray(sidecar.args) && sidecar.args[0],
        'sidecars/panel/sidecar.json must declare args[0]',
    );
    assert.ok(
        fs.existsSync(path.join(REPO_ROOT, 'sidecars/panel', sidecar.args[0])),
        `sidecars/panel/sidecar.json entrypoint missing: ${sidecar.args[0]}`,
    );

    assert.ok(
        readme.includes(`version = ${RENDERER_VERSION} / revision = ${RENDERER_REVISION}`),
        `README.md renderer version/revision is out of sync with renderer.mjs (${RENDERER_VERSION} / ${RENDERER_REVISION})`,
    );
}

// 2. 运行时文件清单同步
{
    for (const relPath of REQUIRED_RUNTIME_FILES) {
        assert.ok(
            fs.existsSync(path.join(REPO_ROOT, relPath)),
            `REQUIRED_RUNTIME_FILES entry missing on disk: ${relPath}`,
        );
    }

    const manageSource = readRepoFile('manage.cjs');
    const runtimeFilesMatch = manageSource.match(/const\s+runtimeFiles\s*=\s*\[([^\]]+)\]/);
    assert.ok(runtimeFilesMatch, 'Could not locate runtimeFiles array in manage.cjs');
    const manageRoots = [...runtimeFilesMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(
        [...new Set(manageRoots)].sort(),
        [...new Set(RUNTIME_ROOTS)].sort(),
        'manage.cjs runtimeFiles does not match archive.mjs RUNTIME_ROOTS',
    );

    const readme = readRepoFile('README.md');
    const repoTreeSection = readme.split('## 仓库结构')[1] || '';
    for (const relPath of REQUIRED_RUNTIME_FILES) {
        const baseName = path.posix.basename(relPath);
        assert.ok(
            repoTreeSection.includes(baseName),
            `README.md 仓库结构 is missing runtime file "${baseName}" (${relPath})`,
        );
    }
}

// 3. Sidecar HTTP API 路由双向同步 (sidecars/panel/main.mjs <-> ARCHITECTURE.md)
{
    const mainSource = readRepoFile('sidecars/panel/main.mjs');
    const routeBlockRe = /^    app\.api\('(\/api\/[^']+)',[\s\S]*?\n    \}\)?,\s*'(GET|POST)'\);/gm;
    const sourceRoutes = new Set();
    let match;
    while ((match = routeBlockRe.exec(mainSource)) !== null) {
        sourceRoutes.add(`${match[2]} ${match[1]}`);
    }
    assert.ok(sourceRoutes.size > 0, 'Expected at least one /api/* route in sidecars/panel/main.mjs');

    const archProse = stripFencedCodeBlocks(readRepoFile('ARCHITECTURE.md'));
    const docRoutes = extractBacktickMatches(archProse, /\b(?:GET|POST)\s+\/api\/[a-z0-9/_-]+\b/);

    for (const route of sourceRoutes) {
        assert.ok(docRoutes.has(route), `ARCHITECTURE.md is missing HTTP API route \`${route}\``);
    }
    for (const route of docRoutes) {
        assert.ok(sourceRoutes.has(route), `ARCHITECTURE.md documents unknown HTTP API route \`${route}\``);
    }
}

// 4. 环境变量双向同步 (源码 <-> ARCHITECTURE.md)
{
    const sourceVars = new Set();
    const envRe = /\bprocess\.env\.(AG_UI_[A-Z0-9_]+|ANTIGRAVITY_[A-Z0-9_]+)\b/g;
    for (const relPath of collectRuntimeSourceFiles()) {
        const content = readRepoFile(relPath);
        for (const match of content.matchAll(envRe)) {
            sourceVars.add(match[1]);
        }
    }
    assert.ok(sourceVars.size > 0, 'Expected at least one AG_UI_* or ANTIGRAVITY_* env var in source');

    const archProse = stripFencedCodeBlocks(readRepoFile('ARCHITECTURE.md'));
    const docVars = new Set();
    const codeSpanRe = /`([^`\r\n]+)`/g;
    let span;
    while ((span = codeSpanRe.exec(archProse)) !== null) {
        const token = span[1].trim();
        if (token.includes('*')) continue;
        if (/^(?:AG_UI_[A-Z0-9_]+|ANTIGRAVITY_[A-Z0-9_]+)$/.test(token)) {
            docVars.add(token);
        }
    }

    for (const envVar of sourceVars) {
        assert.ok(docVars.has(envVar), `ARCHITECTURE.md is missing env var \`${envVar}\``);
    }
    for (const envVar of docVars) {
        assert.ok(sourceVars.has(envVar), `ARCHITECTURE.md documents unused env var \`${envVar}\``);
    }
}

// 5. 测试脚本与 CLI 子命令同步
{
    const readme = readRepoFile('README.md');
    const agents = readRepoFile('AGENTS.md');
    const testFiles = fs
        .readdirSync(path.join(REPO_ROOT, 'tests'), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
        .map(entry => `tests/${entry.name}`);

    assert.ok(testFiles.length > 0, 'Expected at least one test script under tests/');
    for (const testRel of testFiles) {
        assert.ok(readme.includes(testRel), `README.md is missing test script "${testRel}"`);
        assert.ok(agents.includes(testRel), `AGENTS.md is missing test script "${testRel}"`);
    }

    for (const subcommand of ['install', 'uninstall', 'status']) {
        assert.ok(
            readme.includes(`manage.cjs ${subcommand}`),
            `README.md is missing CLI subcommand "manage.cjs ${subcommand}"`,
        );
        assert.ok(
            agents.includes(`manage.cjs ${subcommand}`),
            `AGENTS.md is missing CLI subcommand "manage.cjs ${subcommand}"`,
        );
    }
}

// 6. 相对链接、图片路径与源码引用存在性
{
    const mdLinkRe = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    const codePathRe = /`((?:plugin|sidecars|tests|docs|assets)\/[A-Za-z0-9._/-]+\.[a-z0-9]+)`/g;

    for (const docRel of DOC_FILES) {
        const raw = readRepoFile(docRel);
        const prose = stripFencedCodeBlocks(raw);
        const docDir = path.dirname(path.join(REPO_ROOT, docRel));

        let m;
        while ((m = mdLinkRe.exec(prose)) !== null) {
            const target = m[1];
            if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
            const clean = decodeURIComponent(target.split('#')[0].split('?')[0]);
            if (!clean) continue;
            const resolved = path.resolve(docDir, clean);
            assert.ok(
                fs.existsSync(resolved),
                `${docRel} has broken Markdown link "${target}" (resolved to ${resolved})`,
            );
        }

        while ((m = codePathRe.exec(prose)) !== null) {
            const relTarget = m[1];
            if (/[*<>{}]|\.\.\./.test(relTarget)) continue;
            const resolved = path.resolve(REPO_ROOT, relTarget);
            assert.ok(
                fs.existsSync(resolved),
                `${docRel} references non-existent repo file \`${relTarget}\``,
            );
        }
    }

    const readmeRaw = readRepoFile('README.md');
    for (const match of readmeRaw.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
        const src = match[1];
        if (/^(?:https?:|data:)/i.test(src)) continue;
        const resolved = path.resolve(REPO_ROOT, src);
        assert.ok(fs.existsSync(resolved), `README.md <img> src missing on disk: ${src}`);
    }
}

console.log('Passed: docs-sync (manifests, renderer version, runtime files, HTTP routes, env vars, scripts, and links).');
