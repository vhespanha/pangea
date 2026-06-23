import { parseArgs } from "@std/cli";
import { printf } from "@std/fmt/printf";

function main(): void {
  const { _: [entryPointPath] } = parseArgs(Deno.args);

  if (entryPointPath === undefined) {
    console.error("Usage: pangea <entrypoint>");
    Deno.exit(1);
  }

  printf("Hello, Pangea!\n");
  printf("Entry point is: %s.\n", entryPointPath);
}

if (import.meta.main) main();
