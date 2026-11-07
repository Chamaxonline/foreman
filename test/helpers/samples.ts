import { configTemplate } from "../../src/templates.js";

/** The config `foreman init` writes for a typical npm project. */
export function templatesConfigSample(): string {
  return configTemplate({
    kind: "node (npm)",
    checks: [
      { name: "build", run: "npm run build" },
      { name: "test", run: "npm test" },
    ],
  });
}
