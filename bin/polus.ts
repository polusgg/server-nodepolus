/**
 * This file is the main entrypoint for the NodePolus server.
 *
 * You should not need to make any changes to this file. If you do need to
 * modify it, and you feel that your changes would be useful to everyone else,
 * then please submit a pull request on GitHub with your changes along with an
 * explanation for why they were necessary. There is no guarantee that it will
 * be merged, but all contributions are welcome.
 */

Error.stackTraceLimit = 25;

import { AnnouncementServer } from "@nodepolus/framework/src/announcementServer";
import { ServerConfig } from "@nodepolus/framework/src/api/config/serverConfig";
import { DEFAULT_CONFIG } from "@nodepolus/framework/src/util/constants";
import { BasePlugin } from "@nodepolus/framework/src/api/plugin";
import { Logger } from "@nodepolus/framework/src/logger";
import { Server } from "@nodepolus/framework/src/server";
import meta from "../package.json";
import toposort from "toposort";
import fs from "fs/promises";
import path from "path";
import * as Sentry from "@sentry/node";

const logger = new Logger("NodePolus", [process.env.NP_LOG_LEVEL].find(Logger.isValidLevel) ?? DEFAULT_CONFIG.logging.level);

Sentry.init({
  dsn: "https://e6f294cc0cd64e24a297e86576f37b68@o1016669.ingest.sentry.io/5985155",

  // Set tracesSampleRate to 1.0 to capture 100%
  // of transactions for performance monitoring.
  // We recommend adjusting this value in production
  tracesSampleRate: 1.0,
});

process.on("uncaughtException", err => {
  console.log(err.stack);
  logger.catch(err);
});

/**
 * Gets the contents of the config file at the given path.
 *
 * @param configPath - The path to the config file (default `__dirname/config.json`)
 */
async function loadConfig(configPath: string = path.join(__dirname, "config.json")): Promise<ServerConfig> {
  logger.info("Loading config.json");

  return JSON.parse(await fs.readFile(configPath, "utf-8"));
}

declare const server: Server;
declare const announcementServer: AnnouncementServer;

/**
 * Sets the server and announcement server as properties on the global object
 * so that they may be used in plugins.
 *
 * @param serverConfig - The server configuration
 */
function createServers(serverConfig: ServerConfig): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (global as any).server = new Server(serverConfig);
  (global as any).announcementServer = new AnnouncementServer(server.getAddress(), server.getLogger("Announcements"));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

let calls = 0;

async function cleanupHandler(code: number): Promise<void> {
  calls++;

  if (calls > 1) {
    if (calls > 2 && code > 0) {
      process.exit(code);
    }

    return;
  }

  console.log();
  logger.info("Shutting down. Press Ctrl+C to quit immediately.");
  await server.close();

  if (code > 0) {
    process.exit(code);
  }
}

/**
 * Registers shutdown handlers to gracefully stop the server and all plugins.
 */
function listenForShutdown(): void {
  process.on("exit", cleanupHandler.bind(null, 0));
  process.on("SIGINT", cleanupHandler.bind(null, 2));
  process.on("SIGTERM", cleanupHandler.bind(null, 15));
}

/**
 * Loads all plugins installed via npm by iterating through the dependencies in
 * the `package.json` file.
 */
async function loadPluginPackages(pluginConfigs: Record<string, Record<string, unknown>>): Promise<void> {
  const dependencies = Object.keys(meta.dependencies);
  const lonePlugins: string[] = [];
  const graph: [string, string][] = [];

  for (let i = 0; i < dependencies.length; i++) {
    try {
      const packageMeta = await import(`${dependencies[i]}/package.json`);

      if (packageMeta["np-plugin"] ?? false) {
        const childDependencies = Object.keys(packageMeta.dependencies);
        let hasDependencies = false;

        for (let j = 0; j < childDependencies.length; j++) {
          try {
            const childMeta = await import(`${childDependencies[j]}/package.json`);

            if (childMeta["np-plugin"] ?? false) {
              hasDependencies = true;

              graph.push([childDependencies[j], dependencies[i]]);
            }
          } catch (childError) {
            logger.error(`An error occured while loading the package.json for ${childDependencies[j]}`);
            logger.catch(childError as Error);

            continue;
          }
        }

        if (!hasDependencies) {
          lonePlugins.push(dependencies[i]);
        }
      }
    } catch (parentError) {
      logger.error(`An error occured while loading the package.json for ${dependencies[i]}`);
      logger.catch(parentError as Error);

      continue;
    }
  }

  const pluginsToLoad = [...new Set([...lonePlugins, ...toposort(graph)])];

  for (let i = 0; i < pluginsToLoad.length; i++) {
    try {
      const pluginMeta = await import(`${pluginsToLoad[i]}/package.json`);

      if (pluginMeta["np-plugin"] ?? false) {
        logger.verbose(`Loading "${pluginsToLoad[i]}" v${pluginMeta.version}`);

        const exported = await import(pluginsToLoad[i]);
        let name = pluginsToLoad[i];
        let version = pluginMeta.version;
        let pluginConfig: Record<string, unknown> = {};

        if (name in pluginConfigs) {
          pluginConfig = pluginConfigs[name];
        }

        if (exported.default !== undefined) {
          try {
            // eslint-disable-next-line new-cap
            const plugin: BasePlugin = new exported.default(pluginConfig);

            name = plugin.getPluginName();
            version = plugin.getPluginVersionString();
          } catch (error) {}
        }

        logger.info(`Loaded plugin: ${name} v${version}`);
      }
    } catch (error) {
      logger.error(`An error occured while loading ${pluginsToLoad[i]}`);
      logger.catch(error as Error);

      continue;
    }
  }
}

/**
 * Loads all top-level plugin files and folders within the given folder.
 *
 * - Files must end with either `.npplugin.ts` or `.npplugin.js`
 * - Folders must end with `.npplugin`
 *   - Folders must contain either an `index.ts` or `index.js` file
 *
 * @param pluginsPath - The path to the plugins folder (default `__dirname/plugins`)
 */
async function loadPluginsFolder(pluginConfigs: Record<string, Record<string, unknown>>, pluginsPath: string = path.join(__dirname, "plugins")): Promise<void> {
  try {
    await fs.access(pluginsPath);
  } catch (error) {
    logger.verbose(`Skipping non-existent "./plugins" folder`);

    return;
  }

  if (!(await fs.stat(pluginsPath)).isDirectory()) {
    logger.verbose(`Skipping "./plugins" as it should be a folder instead of a file`);

    return;
  }

  logger.verbose(`Loading plugins from "./plugins" folder`);

  const pluginFiles = await fs.readdir(pluginsPath);

  for (let i = 0; i < pluginFiles.length; i++) {
    const pathToPlugin = path.join(pluginsPath, pluginFiles[i]);
    const stat = await fs.stat(pathToPlugin);
    const fileName = path.basename(pathToPlugin);
    const extname = path.extname(fileName);
    const basename = path.basename(fileName, extname);

    if (stat.isDirectory()) {
      if (extname.toLowerCase() !== ".npplugin") {
        logger.verbose(`Skipping folder "${pluginFiles[i]}" as it does not end with ".npplugin"`);

        continue;
      }
    } else if (![".ts", ".js"].includes(extname.toLowerCase()) || !basename.toLowerCase().endsWith(".npplugin")) {
      logger.verbose(`Skipping file "${pluginFiles[i]}" as it does not end with ".npplugin.ts" or ".npplugin.js"`);

      continue;
    }

    logger.verbose(`Loading "./plugins/${fileName}"`);

    const exported = await import(pathToPlugin);

    if (exported.default === undefined || !(exported.default.prototype instanceof BasePlugin)) {
      logger.warn(`The plugin "./plugins/${fileName}" does not export a default class which extends BasePlugin (this is allowed but discouraged)`);

      continue;
    }

    let pluginConfig: Record<string, unknown> = {};

    if (fileName in pluginConfigs) {
      pluginConfig = pluginConfigs[fileName];
    }

    // eslint-disable-next-line new-cap
    const plugin: BasePlugin = new exported.default(pluginConfig);

    logger.info(`Loaded plugin: ${plugin.getPluginName()} v${plugin.getPluginVersionString()}`);
  }
}

async function loadPlugins(pluginConfigs: Record<string, Record<string, unknown>>): Promise<void> {
  logger.info("Loading plugins");

  await loadPluginPackages(pluginConfigs);
  await loadPluginsFolder(pluginConfigs);
}

/**
 * Starts the server and announcement server.
 *
 * @param enableAnnouncementServer - `true` if the announcement server should be started, `false` if not
 */
async function start(enableAnnouncementServer: boolean = server.getConfig().enableAnnouncementServer ?? DEFAULT_CONFIG.enableAnnouncementServer): Promise<void> {
  if (enableAnnouncementServer) {
    await announcementServer.listen();

    logger.info(`Announcement server listening on ${announcementServer.getAddress()}:${announcementServer.getPort()}`);
  }

  await server.listen();

  logger.info(`Server listening on ${server.getAddress()}:${server.getPort()}`);
}

/**
 * Let the magic happen.
 */
(async (): Promise<void> => {
  logger.info("Starting NodePolus");

  try {
    const serverConfig: ServerConfig = await loadConfig();
    const pluginConfigs: Record<string, Record<string, unknown>> = serverConfig.plugins ?? {};

    createServers(serverConfig);
    listenForShutdown();
    await loadPlugins(pluginConfigs);
    await start();
  } catch (error) {
    logger.catch(error as Error);

    process.exit(1);
  }
})();
