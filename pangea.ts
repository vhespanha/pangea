import { slugify } from "@/utils.ts";
import { denoPlugin } from "@deno/esbuild-plugin";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  toFileUrl,
} from "@std/path";
import * as esbuild from "esbuild";
import { Hono } from "hono";

const JS_EXTENSIONS = new Set([".ts", ".js"]);
const JSX_EXTENSIONS = new Set([".tsx", ".jsx"]);
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const ENTRY_NAMESPACE = "pangea-entry";

interface IslandEntry {
  srcPath: string;
  exportName: string;
}

type IslandRegistry = Map<string, IslandEntry>;

async function islandExports(srcPath: string): Promise<IslandRegistry> {
  const mod = await import(toFileUrl(srcPath).href);
  const fileBase = basename(srcPath, extname(srcPath));
  const found = new Map<string, IslandEntry>();
  for (const [key, val] of Object.entries(mod)) {
    if (typeof val !== "function") continue;
    if (key === "default") {
      found.set(fileBase, { srcPath, exportName: "default" });
    } else if (PASCAL_CASE.test(key)) {
      found.set(key, { srcPath, exportName: key });
    }
  }
  return found;
}

function syntheticEntry(
  name: string,
  srcUrl: string,
  exportName: string,
): string {
  const importStmt = exportName === "default"
    ? `import ${name} from "${srcUrl}";`
    : `import { ${exportName} } from "${srcUrl}";`;
  return [
    importStmt,
    `import { createElement, render } from "hono/jsx/dom";`,
    `document.querySelectorAll('[data-island][data-name="${name}"]').forEach((el) => {`,
    `  render(createElement(${name}, JSON.parse(el.getAttribute("data-props") ?? "{}")), el);`,
    `});`,
  ].join("\n");
}

function multiEntryPlugin(registry: IslandRegistry): esbuild.Plugin {
  return {
    name: "pangea-virtual-entry",
    setup(build) {
      build.onResolve(
        { filter: new RegExp(`^${ENTRY_NAMESPACE}:`) },
        (args) => ({
          path: args.path.slice(ENTRY_NAMESPACE.length + 1),
          namespace: ENTRY_NAMESPACE,
        }),
      );
      build.onLoad(
        { filter: /.*/, namespace: ENTRY_NAMESPACE },
        (args) => {
          const name = args.path;
          const entry = registry.get(name);
          if (!entry) return null;
          return {
            contents: syntheticEntry(name, entry.srcPath, entry.exportName),
            loader: "js",
            resolveDir: dirname(entry.srcPath),
          };
        },
      );
    },
  };
}

function capturePlugin(bundles: Map<string, Uint8Array>): esbuild.Plugin {
  return {
    name: "pangea-capture",
    setup(build) {
      build.onEnd((result) => {
        const outputs = result.metafile?.outputs;
        const files = result.outputFiles;
        if (!outputs || !files) return;
        const cwd = Deno.cwd();
        bundles.clear();
        for (const file of files) {
          const entry = outputs[relative(cwd, file.path)]?.entryPoint;
          if (!entry?.startsWith(`${ENTRY_NAMESPACE}:`)) continue;
          bundles.set(entry.slice(ENTRY_NAMESPACE.length + 1), file.contents);
        }
      });
    },
  };
}

export class Pangea {
  private app: Hono;
  private registry = new Map<string, IslandEntry>();
  private slugIndex = new Map<string, string>();
  private bundles = new Map<string, Uint8Array>();
  private ctx?: esbuild.BuildContext;
  private dirty = true;
  private fsWatcher?: Deno.FsWatcher;

  constructor(app: Hono) {
    this.app = app;
  }

  registerIsland(
    name: string,
    srcPath: string,
    exportName: string = "default",
  ): void {
    this.registry.set(name, { srcPath, exportName });
    this.slugIndex.set(slugify(name), name);
    this.dirty = true;
  }

  invalidateIsland(_name: string): void {
    this.dirty = true;
  }

  hasIsland(name: string): boolean {
    return this.registry.has(name);
  }

  async startIslandWatcher(islandsDir: string): Promise<void> {
    await this.scanIslands(islandsDir);
    try {
      await Deno.stat(islandsDir);
    } catch {
      return;
    }
    this.fsWatcher = Deno.watchFs(islandsDir);
    this.runWatchLoop().catch((err) =>
      console.error("[pangea] watcher error:", err)
    );
  }

  async stopWatcher(): Promise<void> {
    this.fsWatcher?.close();
    await this.ctx?.dispose();
    this.ctx = undefined;
    esbuild.stop();
  }

  private async scanIslands(islandsDir: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(islandsDir)) {
        if (!entry.isFile) continue;
        if (!JSX_EXTENSIONS.has(extname(entry.name))) continue;
        const srcPath = join(islandsDir, entry.name);
        for (const [name, { exportName }] of await islandExports(srcPath)) {
          this.registerIsland(name, srcPath, exportName);
        }
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }

  private async runWatchLoop(): Promise<void> {
    if (!this.fsWatcher) return;
    for await (const event of this.fsWatcher) {
      for (const p of event.paths) {
        const ext = extname(p);
        if (!JS_EXTENSIONS.has(ext)) continue;
        const name = basename(p, ext);
        if (event.kind === "remove") {
          this.registry.delete(name);
          this.slugIndex.delete(slugify(name));
          this.dirty = true;
        } else if (event.kind === "create" || event.kind === "rename") {
          this.registerIsland(name, p);
        } else if (event.kind === "modify") {
          this.dirty = true;
        }
      }
    }
  }

  private async rebuildContext(): Promise<void> {
    await this.ctx?.dispose();
    this.ctx = undefined;
    this.bundles.clear();
    if (this.registry.size === 0) return;
    this.ctx = await esbuild.context({
      entryPoints: [...this.registry.keys()].map((n) =>
        `${ENTRY_NAMESPACE}:${n}`
      ),
      plugins: [
        multiEntryPlugin(this.registry),
        denoPlugin({ preserveJsx: true }),
        capturePlugin(this.bundles),
      ],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      metafile: true,
      outdir: ".pangea",
      jsx: "automatic",
      jsxImportSource: "hono/jsx/dom",
    });
    await this.ctx.rebuild();
  }

  private async ensureBundles(): Promise<void> {
    if (!this.dirty) return;
    await this.rebuildContext();
    this.dirty = false;
  }

  buildRouter(): Hono {
    const router = new Hono();
    router.get("/_pangea/islands/:name{.+\.js}", async (c) => {
      const slug = c.req.param("name").replace(/\.js$/, "");
      const name = this.slugIndex.get(slug);
      if (!name) return c.body(null, 404);
      try {
        await this.ensureBundles();
        const js = this.bundles.get(name);
        if (!js) return c.body(null, 404);
        c.header("Content-Type", "text/javascript; charset=utf-8");
        c.header("Cache-Control", "no-store");
        return c.body(js.buffer as ArrayBuffer);
      } catch (error) {
        console.error(`[pangea] bundle error for island "${name}":`, error);
        return c.body(null, 500);
      }
    });
    router.route("/", this.app);
    return router;
  }

  serve() {
    Deno.serve(this.buildRouter().fetch);
  }
}
