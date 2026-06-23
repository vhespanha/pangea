import { parseArgs } from "@std/cli";
import { printf } from "@std/fmt/printf";
import { Hono } from "hono";

async function getHonoApp(entryPointPath: string): Promise<Hono> {
  const { default: app } = await import(entryPointPath);

  if (!(app instanceof Hono)) {
    throw new Error("Entry point must default-export a `Hono` instance.");
  }

  return app;
}

async function main(): Promise<void> {
  const { _: [entryPointPath] } = parseArgs(Deno.args);

  if (entryPointPath === undefined) {
    console.error("Usage: pangea <entrypoint>");
    Deno.exit(1);
  }

  let app;

  try {
    app = await getHonoApp(String(entryPointPath));
  } catch (error) {
    console.error(`Failed to load app from ${entryPointPath}: `, error);
    throw error;
  }

  printf("Hello, Pangea!\n");
  printf("Entry point app is valid!\n");

  Deno.serve(app.fetch);
}

if (import.meta.main) main();
