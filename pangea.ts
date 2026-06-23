import type { Hono } from "hono";

export class Pangea {
  private app: Hono;

  constructor(app: Hono) {
    this.app = app;
  }

  serve() {
    Deno.serve(this.app.fetch);
  }
}
