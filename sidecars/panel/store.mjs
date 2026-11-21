import { open, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import appearance from '../../plugin/appearance.cjs';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from, to, attempts = 5) {
    for (let attempt = 1; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            if (attempt >= attempts || !RETRYABLE_RENAME_CODES.has(error?.code)) throw error;
            await new Promise(done => setTimeout(done, 25 * attempt));
        }
    }
}

function signatureOf(source, info) {
    return `${source}:${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
}

function isSameWrite(written, published) {
    return published && published.ino === written.ino && published.dev === written.dev &&
        published.birthtimeMs === written.birthtimeMs && published.mtimeMs === written.mtimeMs &&
        published.size === written.size;
}

export class InvalidSettingsError extends Error {}

export class SettingsStore {
    constructor(directory, legacyProfile) {
        this.directory = directory;
        this.path = join(directory, 'settings.json');
        this.legacyPath = join(legacyProfile, 'antigravity-ui-wallpaper.json');
        this.queue = Promise.resolve();
        this.settings = appearance.normalize();
        this.signature = undefined;
        this.failedSignature = undefined;
        this.failedError = undefined;
    }

    async _inspect() {
        for (const [source, file] of [['main', this.path], ['legacy', this.legacyPath]]) {
            try {
                const info = await stat(file);
                return signatureOf(source, info);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        return 'default';
    }

    async _load() {
        for (const [source, file] of [['main', this.path], ['legacy', this.legacyPath]]) {
            let handle;
            try {
                handle = await open(file, 'r');
                const info = await handle.stat();
                const signature = signatureOf(source, info);
                const raw = await handle.readFile('utf8');
                try {
                    this.settings = appearance.normalize(JSON.parse(raw.replace(/^\uFEFF/, '')));
                } catch (error) {
                    const invalid = new InvalidSettingsError('背景设置文件已损坏，请保存当前设置以修复。', { cause: error });
                    this.failedSignature = signature;
                    this.failedError = invalid;
                    throw invalid;
                }
                this.signature = signature;
                this.failedSignature = undefined;
                this.failedError = undefined;
                return this.settings;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            } finally {
                await handle?.close();
            }
        }
        this.settings = appearance.normalize();
        this.signature = 'default';
        this.failedSignature = undefined;
        this.failedError = undefined;
        return this.settings;
    }

    reloadIfChanged() {
        const operation = this.queue.then(async () => {
            const current = await this._inspect();
            if (current === this.signature) return false;
            if (current === this.failedSignature && this.failedError) throw this.failedError;
            await this._load();
            return true;
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    save(input) {
        const operation = this.queue.then(async () => {
            const settings = appearance.normalize(input);
            await mkdir(this.directory, { recursive: true });
            const temporary = this.path + '.' + randomUUID() + '.tmp';
            try {
                await writeFile(temporary, JSON.stringify(settings), { flag: 'wx' });
                const written = await stat(temporary);
                await renameWithRetry(temporary, this.path);
                // Another Sidecar may have replaced the shared path after our rename.
                const published = await stat(this.path).catch(error => {
                    if (error.code !== 'ENOENT') throw error;
                    return undefined;
                });
                this.signature = isSameWrite(written, published) ? signatureOf('main', published) : undefined;
                this.failedSignature = undefined;
                this.failedError = undefined;
                this.settings = settings;
            } finally {
                await rm(temporary, { force: true }).catch(() => {});
            }
            return settings;
        });
        this.queue = operation.catch(() => {});
        return operation;
    }
}
