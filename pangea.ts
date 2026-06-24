import { slugify } from "@/utils.ts";
import { LruCache } from "@std/cache";
import { basename, extname, join } from "@std/path";
import { Hono } from "hono";

const CACHE_SIZE = 50;
const EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js"]);

function syntheticEntry(name: string, srcUrl: string): string {
  return [
    `import Foo from "${srcUrl}";`,
    `import { createElement, render } from "@hono/hono/jsx/dom";`,
    `document.querySelectorAll('[data-island][data-name="${name}"]').forEach((el) => {`,
    `  render(createElement(Foo, JSON.parse(el.getAttribute("data-props") ?? "{}")), el);`,
    `});`,
  ].join("\n");
}

async function doBundle(name: string, srcUrl: string): Promise<Uint8Array> {
  const tmp = await Deno.makeTempFile({ suffix: ".js" });
  try {
    await Deno.writeTextFile(tmp, syntheticEntry(name, srcUrl));
    const result = await Deno.bundle({
      entrypoints: [tmp],
      platform: "browser",
      write: false,
    });
    const js = result.outputFiles?.[0]?.contents;
    if (!js) throw new Error(`Bundle produced no output for island "${name}"`);
    return js;
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

export class Pangea {
  private app: Hono;
  private paths = new Map<string, string>();
  private cache = new LruCache<string, Uint8Array>(CACHE_SIZE);
  private fsWatcher?: Deno.FsWatcher;

  constructor(app: Hono) {
    this.app = app;
  }

  registerIsland(name: string, srcPath: string): void {
    this.paths.set(name, srcPath);
    this.cache.delete(name);
  }

  invalidateIsland(name: string): void {
    this.cache.delete(name);
  }

  hasIsland(name: string): boolean {
    return this.paths.has(name);
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

  stopWatcher(): void {
    this.fsWatcher?.close();
  }

  private async scanIslands(islandsDir: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(islandsDir)) {
        if (!entry.isFile) continue;
        const ext = extname(entry.name);
        if (!EXTENSIONS.has(ext)) continue;
        const stem = basename(entry.name, ext);
        this.registerIsland(
          slugify(stem),
          join(islandsDir, entry.name),
        );
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
        if (!EXTENSIONS.has(ext)) continue;
        const name = slugify(basename(p, ext));
        if (event.kind === "remove") {
          this.paths.delete(name);
          this.cache.delete(name);
        } else if (event.kind === "create" || event.kind === "rename") {
          this.registerIsland(name, p);
        } else if (event.kind === "modify") {
          this.invalidateIsland(name);
        }
      }
    }
  }

  private async getBundle(name: string): Promise<Uint8Array> {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const path = this.paths.get(name)!;
    const js = await doBundle(name, path);
    this.cache.set(name, js);
    return js;
  }

  buildRouter(): Hono {
    const router = new Hono();
    router.get("/_pangea/islands/:name{.+\.js}", async (c) => {
      const name = c.req.param("name") as string;
      if (!this.paths.has(name)) return c.body(null, 404);
      try {
        const js = await this.getBundle(name);
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
