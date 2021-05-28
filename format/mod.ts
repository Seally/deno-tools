#! /bin/env deno run --allow-net --allow-read --allow-write
import type {
    Formatter,
    GlobalConfiguration,
} from "https://dprint.dev/formatter/v2.ts";

import { parse as parseArgs } from "https://deno.land/std@0.97.0/flags/mod.ts";
import {
    getColorEnabled,
    gray,
    red,
} from "https://deno.land/std@0.97.0/fmt/colors.ts";
import { walk } from "https://deno.land/std@0.97.0/fs/walk.ts";
import {
    extname,
    globToRegExp,
    resolve,
} from "https://deno.land/std@0.97.0/path/mod.ts";

import { DprintPluginManager, isDprintPluginsInfo } from "./dprint-helpers.ts";

async function getFormatters(formatterManager: DprintPluginManager) {
    const PLUGIN_INFOS_URL = "https://plugins.dprint.dev/info.json";
    const response = await fetch(PLUGIN_INFOS_URL);

    if (!response.ok) {
        throw Error(
            `Failed to load list of formatters from: ${PLUGIN_INFOS_URL}`,
        );
    }

    const json = await response.json();

    if (!isDprintPluginsInfo(json)) {
        throw Error(`Invalid plugin information format.`);
    }

    const formatters = await Promise.all(
        json.latest.map(async (formatterInfo) => {
            return {
                name: formatterInfo.configKey,
                formatter: await formatterManager.loadFormatterFromUrl(
                    formatterInfo.url,
                ),
                fileExtensions: formatterInfo.fileExtensions,
            };
        }),
    );

    const pluginsByName = new Map<string, Formatter>();
    const pluginsByExtension = new Map<string, Formatter>();

    const globalConfig: GlobalConfiguration = {
        indentWidth: 4,
        newLineKind: "lf",
        lineWidth: 80,
    };

    for (const plugin of formatters) {
        plugin.formatter.setConfig(globalConfig, {});
        pluginsByName.set(plugin.name, plugin.formatter);

        for (const fileExtension of plugin.fileExtensions) {
            pluginsByExtension.set(`.${fileExtension}`, plugin.formatter);
        }
    }

    return {
        pluginsByName,
        pluginsByExtension,
    };
}

function identity<T>(input: T) {
    return input;
}

export async function main() {
    const parsedArgs = parseArgs(Deno.args, {
        alias: {
            help: ["h"],
        },
        boolean: ["help", "dry-run", "verbose"],
        string: ["root"],
    });

    if (parsedArgs.help) {
        console.log([
            "USAGE:",
            "    deno run --allow-net --allow-read --allow-write format.ts [OPTIONS]",
            "",
            "OPTIONS:",
            "    -h, --help   Prints this help message.",
            "    --dry-run    Run the script as usual but don't actually format anything,",
            "                 but log things as if it did.",
            "    --root       Sets the root of the formatter. By default it uses the",
            "                 current working directory.",
            "",
            "                 Relative paths are still resolved relative to the",
            "                 current working directory.",
            "    --verbose    Prints longer output, including skipped files.",
        ].join("\n"));

        Deno.exit();
    }

    const DPRINT_CACHE_DIR = resolve(".dprint-cache");

    const pluginManager = new DprintPluginManager(DPRINT_CACHE_DIR);
    const { pluginsByName, pluginsByExtension } = await getFormatters(
        pluginManager,
    );

    const getFormatterForFile = (filePath: string) => {
        return pluginsByExtension.get(extname(filePath));
    };

    const createLogOutput = (
        tags: string[],
        message: string,
        color: (str: string) => string,
    ) => {
        let result = "";

        // Print the tags only when color mode is off or the mode is set to
        // verbose.
        if (!getColorEnabled() || parsedArgs.verbose) {
            result += tags.map(tag => `[${tag.toUpperCase()}]`).join(" ");
        }
        result += " " + message;

        // All color functions do nothing if color mode is off anyway, so doing
        // this should be safe.
        return color(result);
    };

    let root: string = Deno.cwd();

    if (typeof parsedArgs.root === "string") {
        root = resolve(parsedArgs.root);
    }

    const decoder = new TextDecoder("utf-8");
    const encoder = new TextEncoder();

    for await (
        const entry of walk(root, {
            // We don't want to format our dprint-cache directory.
            // Also causes issues if the lock file is corrupted.
            skip: [globToRegExp(`${DPRINT_CACHE_DIR}/**`)],
        })
    ) {
        if (entry.isFile) {
            const parser = getFormatterForFile(entry.path);

            if (parser === undefined) {
                if (parsedArgs.verbose) {
                    console.log(`[SKIPPED] ${entry.path}`);
                }

                continue;
            }

            const contents = decoder.decode(await Deno.readFile(entry.path));

            // Try to handle parsing issues gracefully.
            let formattedContents: string;
            try {
                formattedContents = parser.formatText(entry.path, contents);
            } catch (error) {
                console.log(createLogOutput(["error"], entry.path, red));
                console.error(error);

                // Just move on the next file.
                continue;
            }
            const hasChanges = contents !== formattedContents;

            if (!parsedArgs["dry-run"] && hasChanges) {
                Deno.writeFile(entry.path, encoder.encode(formattedContents));
            }

            const logText = hasChanges
                ? createLogOutput(["formatted"], entry.path, identity)
                : createLogOutput(["checked"], entry.path, gray);

            console.log(logText);
        }
    }

    pluginManager.cleanCacheDir();
    pluginManager.writeLockFile(pluginsByName.get("json"));
}
