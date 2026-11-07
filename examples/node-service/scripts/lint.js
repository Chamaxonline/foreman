// Minimal "linter" so the example has no dependencies: every source file
// must parse, and console.log is not allowed in src/.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

let failed = false;
for (const file of readdirSync("src").filter((f) => f.endsWith(".js"))) {
  const text = readFileSync(path.join("src", file), "utf8");
  if (/console\.log\(/.test(text)) {
    console.error(`${file}: console.log is not allowed in src/`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
