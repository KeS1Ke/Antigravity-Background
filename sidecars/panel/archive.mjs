import { gunzipSync, inflateRawSync, crc32 } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const PLUGIN_NAME = 'antigravity-ui';
export const RUNTIME_ROOTS = ['plugin.json', 'plugin', 'sidecars', 'assets'];
export const EXCLUDED_RUNTIME_DIRS = new Set(['data', 'sdk']);
export const REQUIRED_RUNTIME_FILES = [
    'plugin.json',
    'plugin/appearance.cjs',
    'plugin/persistence.cjs',
    'sidecars/panel/main.mjs',
    'sidecars/panel/app.js',
    'sidecars/panel/index.html',
    'sidecars/panel/styles.css',
    'sidecars/panel/runtime.mjs',
    'sidecars/panel/renderer.mjs',
    'sidecars/panel/store.mjs',
    'sidecars/panel/sdk.mjs',
    'sidecars/panel/updater.mjs',
    'sidecars/panel/archive.mjs',
    'sidecars/panel/sidecar.json',
    'assets/logo.png',
];

export function isExcludedRuntimeSegment(segment) {
    return EXCLUDED_RUNTIME_DIRS.has(String(segment || '').toLowerCase());
}

export function isRuntimeRelativePath(parts) {
    if (!Array.isArray(parts) || !parts.length) return false;
    if (parts[0] === 'plugin.json') return parts.length === 1;
    return parts.length >= 2 && RUNTIME_ROOTS.includes(parts[0]);
}

export function isProtectedRuntimePath(pathOrParts) {
    const parts = Array.isArray(pathOrParts) ? pathOrParts : String(pathOrParts || '').split('/');
    return parts.some(isExcludedRuntimeSegment);
}

export const MAX_ARCHIVE_ENTRIES = 2048;
export const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const WINDOWS_RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function validateEntryPath(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 1024) {
        throw new Error('Unsafe archive path');
    }
    if (rawPath.includes('\\') || rawPath.includes(':') || rawPath.includes('\0') || rawPath.startsWith('/')) {
        throw new Error('Unsafe archive path');
    }
    const trimmed = rawPath.replace(/\/+$/, '');
    if (!trimmed) return [];
    const parts = trimmed.split('/');
    for (const part of parts) {
        if (!part || part === '.' || part === '..') throw new Error('Unsafe archive path');
        if (part.replace(/[ .]+$/, '') !== part) throw new Error('Unsafe archive path');
        if (/[\x00-\x1f<>"|?*]/.test(part)) throw new Error('Unsafe archive path');
        const stem = part.split('.')[0].toUpperCase();
        if (WINDOWS_RESERVED.has(stem)) throw new Error('Unsafe archive path');
    }
    return parts;
}

function parseOctalOrBase256(slice) {
    if (slice[0] & 0x80) {
        let value = 0;
        for (let i = 1; i < slice.length; i++) value = value * 256 + slice[i];
        return value;
    }
    const text = slice.toString('ascii').replace(/\0.*$/, '').trim();
    if (!text) return 0;
    if (!/^[0-7]+$/.test(text)) throw new Error('Invalid tar entry size');
    return Number.parseInt(text, 8);
}

function parsePaxRecords(buffer) {
    const records = {};
    let offset = 0;
    while (offset < buffer.length) {
        const space = buffer.indexOf(0x20, offset);
        if (space <= offset) break;
        const length = Number.parseInt(buffer.subarray(offset, space).toString('ascii'), 10);
        if (!Number.isSafeInteger(length) || length < 5 || offset + length > buffer.length) break;
        const line = buffer.subarray(space + 1, offset + length - 1).toString('utf8');
        const eq = line.indexOf('=');
        if (eq > 0) records[line.slice(0, eq)] = line.slice(eq + 1);
        offset += length;
    }
    return records;
}

/** Parses a `.tar.gz` buffer into validated file entries (`[{ parts, data }]`). */
export function parseTarGz(buffer, { maxEntries = MAX_ARCHIVE_ENTRIES, maxExpandedBytes = MAX_EXPANDED_BYTES } = {}) {
    let tar;
    try {
        tar = gunzipSync(buffer, { maxOutputLength: maxExpandedBytes });
    } catch {
        throw new Error('Archive decompression failed or exceeds budget');
    }
    const entries = [];
    const seen = new Set();
    let headerCount = 0;
    const maxHeaders = maxEntries * 4;
    let totalBytes = 0;
    let offset = 0;
    let nextPax = null;
    let nextLongName = null;

    while (offset + 512 <= tar.length) {
        const block = tar.subarray(offset, offset + 512);
        offset += 512;
        if (block.every(byte => byte === 0)) break;
        headerCount++;
        if (headerCount > maxHeaders) throw new Error('Archive entry count exceeds budget');

        const rawType = block[156];
        const type = rawType === 0 ? '0' : String.fromCharCode(rawType);
        const headerSize = parseOctalOrBase256(block.subarray(124, 136));
        if (!Number.isSafeInteger(headerSize) || headerSize < 0) {
            throw new Error('Invalid tar entry bounds');
        }

        if (type === 'x' || type === 'g' || type === 'L') {
            if (offset + headerSize > tar.length) throw new Error('Invalid tar entry bounds');
            totalBytes += headerSize;
            if (totalBytes > maxExpandedBytes) throw new Error('Expanded archive exceeds budget');
            const extData = tar.subarray(offset, offset + headerSize);
            offset += Math.ceil(headerSize / 512) * 512;
            if (type === 'x') nextPax = parsePaxRecords(extData);
            else if (type === 'L') nextLongName = extData.toString('utf8').replace(/\0+$/, '');
            continue;
        }

        const pax = nextPax;
        const longName = nextLongName;
        nextPax = null;
        nextLongName = null;

        let actualSize = headerSize;
        if (pax?.size !== undefined) {
            if (!/^\d+$/.test(pax.size)) throw new Error('Invalid tar pax size');
            const parsedPaxSize = Number(pax.size);
            if (!Number.isSafeInteger(parsedPaxSize) || parsedPaxSize < 0) {
                throw new Error('Invalid tar pax size');
            }
            if (headerSize !== 0 && parsedPaxSize !== headerSize) {
                throw new Error('Tar entry size mismatch');
            }
            actualSize = parsedPaxSize;
        }
        if (offset + actualSize > tar.length) {
            throw new Error('Invalid tar entry bounds');
        }
        const data = tar.subarray(offset, offset + actualSize);
        offset += Math.ceil(actualSize / 512) * 512;

        if (!['0', '5'].includes(type)) {
            throw new Error('Unsupported tar entry type');
        }
        const rawName = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const rawPrefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
        const entryName = pax?.path ?? longName ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
        if (!entryName || entryName === '.' || entryName === './') continue;
        const cleanName = entryName.replace(/^\.\//, '');
        if (!cleanName) continue;
        const parts = validateEntryPath(cleanName);
        if (!parts.length) continue;
        const key = parts.join('/').toLowerCase();
        if (seen.has(key)) throw new Error('Duplicate archive path');
        seen.add(key);

        if (entries.length + 1 > maxEntries) throw new Error('Archive entry count exceeds budget');
        if (type === '5') {
            entries.push({ parts, dir: true, data: null });
            continue;
        }
        totalBytes += actualSize;
        if (totalBytes > maxExpandedBytes) throw new Error('Expanded archive exceeds budget');
        entries.push({ parts, dir: false, data });
    }
    return entries;
}

/** Parses a `.zip` buffer into validated file entries (`[{ parts, data }]`). */
export function parseZip(buffer, { maxEntries = MAX_ARCHIVE_ENTRIES, maxExpandedBytes = MAX_EXPANDED_BYTES } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('Invalid zip archive');
    const searchStart = Math.max(0, buffer.length - 65557);
    let eocd = -1;
    for (let pos = buffer.length - 22; pos >= searchStart; pos--) {
        if (buffer.readUInt32LE(pos) === 0x06054b50 && buffer.readUInt16LE(pos + 20) === buffer.length - pos - 22) {
            eocd = pos;
            break;
        }
    }
    if (eocd < 0) throw new Error('Missing zip central directory');
    const disk = buffer.readUInt16LE(eocd + 4);
    const cdDisk = buffer.readUInt16LE(eocd + 6);
    const countOnDisk = buffer.readUInt16LE(eocd + 8);
    const totalCount = buffer.readUInt16LE(eocd + 10);
    const cdSize = buffer.readUInt32LE(eocd + 12);
    const cdOffset = buffer.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0 || countOnDisk !== totalCount ||
        totalCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new Error('Unsupported multi-disk or Zip64 archive');
    }
    if (totalCount > maxEntries) throw new Error('Archive entry count exceeds budget');
    if (cdOffset + cdSize > eocd) throw new Error('Corrupt zip central directory');

    const entries = [];
    const seen = new Set();
    let totalBytes = 0;
    let cursor = cdOffset;
    for (let i = 0; i < totalCount; i++) {
        if (cursor + 46 > cdOffset + cdSize || buffer.readUInt32LE(cursor) !== 0x02014b50) {
            throw new Error('Corrupt zip central directory entry');
        }
        const flags = buffer.readUInt16LE(cursor + 8);
        const method = buffer.readUInt16LE(cursor + 10);
        const expectedCrc = buffer.readUInt32LE(cursor + 16);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLen = buffer.readUInt16LE(cursor + 28);
        const extraLen = buffer.readUInt16LE(cursor + 30);
        const commentLen = buffer.readUInt16LE(cursor + 32);
        const externalAttr = buffer.readUInt32LE(cursor + 38);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        if (cursor + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) {
            throw new Error('Truncated zip entry metadata');
        }
        if (flags & 0x0001) throw new Error('Encrypted zip archive is unsupported');
        const mode = (externalAttr >>> 16) & 0o170000;
        if (mode === 0o120000 || (mode !== 0 && mode !== 0o100000 && mode !== 0o040000)) {
            throw new Error('Unsupported zip entry mode');
        }
        const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
        cursor += 46 + nameLen + extraLen + commentLen;
        const isDir = rawName.endsWith('/') || mode === 0o040000;
        const parts = validateEntryPath(rawName);
        if (!parts.length) continue;
        const key = parts.join('/').toLowerCase();
        if (seen.has(key)) throw new Error('Duplicate archive path');
        seen.add(key);

        if (isDir) {
            entries.push({ parts, dir: true, data: null });
            continue;
        }
        const remainingBudget = maxExpandedBytes - totalBytes;
        if (uncompressedSize > remainingBudget) throw new Error('Expanded archive exceeds budget');
        totalBytes += uncompressedSize;
        if (localOffset + 30 > cdOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error('Corrupt zip local header');
        }
        const localNameLen = buffer.readUInt16LE(localOffset + 26);
        const localExtraLen = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const dataEnd = dataStart + compressedSize;
        if (dataEnd > cdOffset) throw new Error('Truncated zip entry payload');
        const payload = buffer.subarray(dataStart, dataEnd);
        let data;
        if (method === 0) {
            data = payload;
        } else if (method === 8) {
            try {
                data = inflateRawSync(payload, { maxOutputLength: Math.max(1, Math.min(uncompressedSize, remainingBudget)) });
            } catch {
                throw new Error('Zip entry decompression failed');
            }
        } else {
            throw new Error('Unsupported zip compression method');
        }
        if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
            throw new Error('Zip entry checksum mismatch');
        }
        entries.push({ parts, dir: false, data });
    }
    return entries;
}

/** Extracts validated runtime entries from an archive buffer into a clean staging directory. */
export async function stageRuntimeArchive(archiveBuffer, archiveKind, stageDir, expectedVersion) {
    const entries = archiveKind === 'zip' ? parseZip(archiveBuffer) : parseTarGz(archiveBuffer);
    const hasRootManifest = entries.some(entry => !entry.dir && entry.parts.length === 1 && entry.parts[0] === 'plugin.json');
    let stripFirst = false;
    if (!hasRootManifest) {
        const topDirs = new Set(entries.map(entry => entry.parts[0]));
        const hasNestedManifest = topDirs.size === 1 && entries.some(entry => !entry.dir && entry.parts.length === 2 && entry.parts[1] === 'plugin.json');
        if (!hasNestedManifest) throw new Error('Archive missing plugin.json');
        stripFirst = true;
    }

    const stageRoot = resolve(stageDir);
    await mkdir(stageRoot, { recursive: false });
    const stagedFiles = new Map();
    for (const entry of entries) {
        if (entry.dir) continue;
        const relative = stripFirst ? entry.parts.slice(1) : entry.parts;
        if (!isRuntimeRelativePath(relative)) continue;
        if (isProtectedRuntimePath(relative)) {
            throw new Error('Archive touches protected path');
        }
        const relPosix = relative.join('/');
        if (stagedFiles.has(relPosix.toLowerCase())) throw new Error('Duplicate runtime path');
        const target = resolve(stageRoot, ...relative);
        if (!target.startsWith(stageRoot + (process.platform === 'win32' ? '\\' : '/')) && target !== stageRoot) {
            throw new Error('Archive path escaped staging');
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.data, { flag: 'wx' });
        stagedFiles.set(relPosix.toLowerCase(), relPosix);
    }

    const manifestBytes = await readFile(join(stageRoot, 'plugin.json'), 'utf8');
    const manifest = JSON.parse(manifestBytes.replace(/^\uFEFF/, ''));
    if (manifest?.name !== PLUGIN_NAME || manifest?.version !== expectedVersion) {
        throw new Error('Package manifest mismatch');
    }
    for (const required of REQUIRED_RUNTIME_FILES) {
        if (!stagedFiles.has(required.toLowerCase())) {
            throw new Error(`Incomplete runtime package: missing ${required}`);
        }
    }
    return [...stagedFiles.values()].sort();
}
