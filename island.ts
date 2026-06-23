import { slugify } from "@/utils.ts";
import { html } from "hono/html";
import type { ReactElement } from "hono/jsx";

function getIslandName(c: ReactElement): string {
  if (typeof c.type === "string") return c.type;

  const component = c.type as { displayName?: string; name?: string };
  return component.displayName ?? component.name ?? "";
}

export function island(c: ReactElement) {
  const islandName = slugify(getIslandName(c));

  if (!islandName) {
    throw new Error("Island component needs name.");
  }

  let islandProps: string;

  try {
    islandProps = JSON.stringify(c.props);
  } catch {
    throw new Error("Island props must be JSON-serializable.");
  }

  const islandUrl = `/_pangea/islands/${islandName}.js`;

  return html`
    <div data-island data-name="${islandName}" data-props="${islandProps}">
      <script type="module" src="${islandUrl}"></script>
    </div>
  `;
}
