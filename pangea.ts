import { Hono } from "hono";

export class Pangea {
  private app: Hono;

  constructor(app: Hono) {
    this.app = app;
  }

  buildRouter(): Hono {
    const router = new Hono();

    router.get("/_pangea/islands/:name{.+\.js}", (c) => {
      return c.text("TODO");
    });

    router.route("/", this.app);

    return router;
  }

  serve() {
    Deno.serve(this.buildRouter().fetch);
  }
}
