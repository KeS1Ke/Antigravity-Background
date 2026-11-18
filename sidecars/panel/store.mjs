import { open, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import appearance from '../../plugin/appearance.cjs';

export class SettingsStore {
    constructor(directory, legacyProfile) {
        this.directory = directory;
        this.path = join(directory, 'settings.json');
        this.legacyPath = join(legacyProfile, 'antigravity-ui-wallpaper.json');
        this.queue = Promise.resolve();
        this.signature = undefined;
    }

    async _inspect() {
        for (const [source, file] of [['main', this.path], ['legacy', this.legacyPath]]) {
            try {
                const info = await stat(file);
                return `${source}:${info.mtimeMs}:${info.size}`;
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
                const raw = await handle.readFile('utf8');
                this.settings = appearance.normalize(JSON.parse(raw));
                this.signature = `${source}:${info.mtimeMs}:${info.size}`;
                return this.settings;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            } finally {
                await handle?.close();
            }
        }
        this.settings = appearance.normalize();
        this.signature = 'default';
        return this.settings;
    }

    load() {
        const operation = this.queue.then(() => this._load());
        this.queue = operation.catch(() => {});
        return operation;
    }

    reloadIfChanged() {
        const operation = this.queue.then(async () => {
            if ((await this._inspect()) === this.signature) return false;
            await this._load();
            return true;
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    save(input) {
        const settings = appearance.normalize(input);
        const operation = this.queue.then(async () => {
            await mkdir(this.directory, { recursive: true });
            const temporary = this.path + '.' + randomUUID() + '.tmp';
            try {
                await writeFile(temporary, JSON.stringify(settings), { flag: 'wx' });
                await rename(temporary, this.path);
            } finally { await rm(temporary, { force: true }); }
            this.settings = settings;
            const info = await stat(this.path);
            this.signature = `main:${info.mtimeMs}:${info.size}`;
            return settings;
        });
        this.queue = operation.catch(() => {});
        return operation;
    }
}
