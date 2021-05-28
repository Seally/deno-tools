import type { Message } from "https://deno.land/std@0.97.0/hash/hasher.ts";
import { createHash } from "https://deno.land/std@0.97.0/hash/mod.ts";
import {
    basename,
    posix,
    resolve,
} from "https://deno.land/std@0.97.0/path/mod.ts";

import {
    createFromBuffer,
    Formatter,
} from "https://dprint.dev/formatter/v2.ts";

import * as t from "https://raw.githubusercontent.com/arcanis/typanion/f6e44538692b33c9450c80e4fcc17df4e2997bf1/sources/index.ts";

export class LockFileParseError extends Error {
    constructor(message?: string) {
        super(message);

        this.name = "LockFileParseError";
    }
}

const LOCK_FILE_NAME = "plugin-lock.json";

const _isLockObjectEntry = t.isObject({
    fileName: t.isString(),
    sha512: t.isString(),
});

type _LockObjectEntry = t.InferType<typeof _isLockObjectEntry>;
type _LockObject = Record<string, _LockObjectEntry>;

// deno-lint-ignore no-explicit-any
function _isValidLockObject(lockObject: any): lockObject is _LockObject {
    for (const [key, value] of Object.entries(lockObject)) {
        if (!_isLockObjectEntry(value)) {
            return false;
        }
    }

    return true;
}

async function _getLockObject(lockFilePath: string) {
    const decoder = new TextDecoder("utf-8");

    try {
        const lockFileContents = decoder.decode(
            await Deno.readFile(lockFilePath),
        );
        const lockFileObject = JSON.parse(lockFileContents);

        if (!_isValidLockObject(lockFileObject)) {
            throw new LockFileParseError(`Invalid lock file: ${lockFilePath}`);
        }

        return lockFileObject;
    } catch (error) {
        // If file not found, just create a new one.
        if (
            error instanceof SyntaxError || error instanceof LockFileParseError
        ) {
            console.error(`Lock file corrupted. Regenerating...`);
        }

        // Start a new lock file from scratch upon encountering any error.
        return {};
    }
}

function _urlToFileName(url: string) {
    const parsedUrl = new URL(url);

    return posix.basename(parsedUrl.pathname);
}

function _hashSha512(data: Message) {
    return createHash("sha512").update(data).toString();
}

export const isDprintPluginsInfo = t.isObject({
    schemaVersion: t.isLiteral(2),
    pluginSystemSchemaVersion: t.isLiteral(3),
    latest: t.isArray(t.isObject({
        name: t.isString(),
        version: t.isString(),
        url: t.isString(),
        configKey: t.isString(),
        fileExtensions: t.isArray(t.isString()),
        configSchemaUrl: t.isString(),
        configExcludes: t.isArray(t.isString()),
    })),
});

/**
 * A plugin manager for dprint. This handles loading and caching downloaded
 * dprint plugins.
 *
 * Regarding plugin vs formatter:
 *
 * The only kind of plugin dprint seems to have are formatters. If dprint
 * introduces other kinds of plugins, this class should be adjusted to support
 * it.
 *
 * Thus, the class is called _plugin_ manager, but it currently only handles
 * _formatter_ plugins.
 */
export class DprintPluginManager {
    #cacheDir: string;
    #lockFilePath: string;
    #lockObject: Promise<_LockObject>;

    /**
     * Map of loaded formatters, using URLs as the keys.
     */
    #formatters = new Map<string, Formatter>();

    constructor(cacheDir: string) {
        this.#cacheDir = cacheDir;

        this.#lockFilePath = this._resolve(LOCK_FILE_NAME);
        this.#lockObject = _getLockObject(this.#lockFilePath);
    }

    private _resolve(...pathSegments: string[]) {
        return resolve(this.#cacheDir, ...pathSegments);
    }

    async loadFormatterFromUrl(url: string) {
        // Look up our formatter in the map and return it if it exists.
        const lockObject = await this.#lockObject;

        let formatter = this.#formatters.get(url);

        if (formatter !== undefined) {
            return formatter;
        }

        // Formatter has not been loaded. Consult our lock file.
        const fileName = _urlToFileName(url);

        const lockObjectEntry = lockObject[url];

        if (_isLockObjectEntry(lockObjectEntry)) {
            // We have a valid lock file entry.
            try {
                // Read the file pointed to by our lock file.
                const buffer = await Deno.readFile(
                    this._resolve(lockObjectEntry.fileName),
                );

                // Compare the hashes to see if they match.
                const wasmHash = _hashSha512(buffer);
                const cachedHash = lockObjectEntry.sha512;

                if (wasmHash === cachedHash) {
                    // Create a formatter and return it if they do.
                    formatter = createFromBuffer(buffer);
                    this.#formatters.set(url, formatter);
                    return formatter;
                } else {
                    // Throw a warning if they don't.
                    console.warn(
                        `Checksum mismatch occurred for '${lockObjectEntry.fileName}'. Redownloading from source...`,
                    );
                }
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) {
                    // We have a lock entry but there's no file. Delete it from
                    // our lock object.
                    delete lockObject[url];
                } else {
                    // If it's something else just rethrow.
                    throw error;
                }
            }
        }

        // We don't have a formatter mapped for the specified URL (for whatever
        // reason), so we need to download it.
        //
        // TODO: Handle the case where the download fails.
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();

        formatter = createFromBuffer(buffer);
        this.#formatters.set(url, formatter);
        lockObject[url] = {
            fileName,
            sha512: _hashSha512(buffer),
        };
        await Deno.mkdir(this.#cacheDir, { recursive: true });
        Deno.writeFile(this._resolve(fileName), new Uint8Array(buffer));

        return formatter;
    }

    /**
     * Remove all files in the cache directory that isn't listed in our lock
     * object.
     *
     * Pass `{ removeLockFile: true }` to remove the lock file as well (which
     * may be out of date anyway).
     */
    async cleanCacheDir({ removeLockFile = false } = {}) {
        const filesToKeep = new Set<string>();

        if (!removeLockFile) {
            filesToKeep.add(LOCK_FILE_NAME);
        }

        for (const [_, entry] of Object.entries(await this.#lockObject)) {
            filesToKeep.add(entry.fileName);
        }

        for await (const entry of Deno.readDir(this.#cacheDir)) {
            if (!filesToKeep.has(basename(entry.name))) {
                console.log(`Cleaning up: ${entry.name}`);
                Deno.remove(this._resolve(entry.name), { recursive: true });
            }
        }
    }

    /**
     * Writes the lock object to disk. Because `JSON.stringify()` may not match
     * the formatting, you can pass in the formatter for JSON to format the
     * written file. Otherwise it'll just use the standard 4-space indent.
     */
    async writeLockFile(jsonFormatter?: Formatter) {
        let jsonText = JSON.stringify(await this.#lockObject, undefined, 4);

        if (jsonFormatter) {
            jsonText = jsonFormatter?.formatText(this.#lockFilePath, jsonText);
        }

        const encoder = new TextEncoder();
        await Deno.writeFile(this.#lockFilePath, encoder.encode(jsonText));
    }
}
