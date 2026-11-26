// Makes the password record that the Worker reads from KV key "auth" (see password mode in src/index.js).
// The Setup app uses newAuth(); by hand:
//   node tools/auth.mjs "<parent password>"   -> writes auth.json and prints the Kindle key for dash.conf
//   npx wrangler kv key put --binding KV --remote auth --path auth.json && rm auth.json
import { webcrypto as crypto } from "node:crypto";
import { writeFileSync } from "node:fs";

export const MIN_PASSWORD = 10, MAX_PASSWORD = 200; // the Worker refuses longer ones at login
const ITER = 20000; // about 4 ms on a Worker, inside the free plan's 10 ms CPU
const hex = (b) => Buffer.from(b).toString("hex");
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

export async function passwordHash(password, salt = rand(16), iter = ITER) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(salt, "hex"), iterations: iter }, key, 256);
  return { salt, iter, hash: hex(bits) };
}

/** New record: new password, new session secret (logs out every browser), and a new Kindle key
 *  unless the current one is passed in (a password reset then needs no Kindle reinstall). */
export async function newAuth(password, kindleKey = rand(24)) {
  if (String(password).length < MIN_PASSWORD) throw new Error(`The password needs at least ${MIN_PASSWORD} characters.`);
  if (String(password).length > MAX_PASSWORD) throw new Error(`The password can have at most ${MAX_PASSWORD} characters.`);
  const kindle = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(kindleKey)));
  return { record: { v: 1, ...(await passwordHash(password)), kindle, session: rand(32) }, kindleKey };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { record, kindleKey } = await newAuth(process.argv[2] || "");
  writeFileSync("auth.json", JSON.stringify(record));
  console.log(`auth.json written. In dash.conf on the Kindle set:\nKINDLE_KEY="${kindleKey}"`);
}
