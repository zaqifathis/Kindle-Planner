// Copies the Worker and the Kindle extension into setup/payload, so the app ships them.
// Only files tracked by git are copied, so local secrets (dash.conf, .dev.vars, auth.json) never ship.
// The KV namespace id is removed: wrangler deploy then creates a new namespace in the user's account.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(import.meta.dirname, "payload");
rmSync(out, { recursive: true, force: true });

const tracked = execFileSync("git", ["ls-files", "cloud/src", "cloud/public", "cloud/wrangler.toml", "cloud/tools/auth.mjs", "kindle/extensions/kiddash"], { cwd: root, encoding: "utf8" })
  .split("\n").filter(Boolean);
for (const f of tracked) {
  const to = join(out, f.replace(/^kindle\/extensions\//, "kindle/"));
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(root, f), to);
}
const toml = join(out, "cloud/wrangler.toml");
const cleaned = readFileSync(toml, "utf8").replace(/^id\s*=.*\n/m, "");
if (/^id\s*=/m.test(cleaned)) throw new Error("wrangler.toml still has a KV id");
writeFileSync(toml, cleaned);
console.log(`payload: ${tracked.length} files`);
