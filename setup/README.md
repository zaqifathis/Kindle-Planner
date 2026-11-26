# Kid Planner Setup

A desktop app (Electron) that installs Kid Planner for a person who does not code. The person:

1. Clicks Connect Cloudflare and logs in to Cloudflare in the browser.
2. Types the child's name, the Kindle language, and a dashboard password, then clicks Install.
3. Connects the jailbroken Kindle with USB and clicks Copy to Kindle.

The app does the rest:

- If the account has no workers.dev address, the app creates one.
- It deploys the Worker. Wrangler creates the KV namespace.
- It saves the password record and the first settings.
- It writes `dash.conf` on the Kindle.

Later, the app can change the password or install on the Kindle again.

The jailbreak and KUAL are not automatic. The person must do them first.

## Development

```sh
cd setup
npm install
npm test     # copies the payload, then runs offline checks of steps.js
npm start    # opens the app
```

Warning: Do not click Install with your own Cloudflare account. The app refuses to install over an account that already has a `kid-planner` Worker, so that the data stays safe. Use a second Cloudflare account to test a real install.

## Files

| File | Purpose |
|------|---------|
| `main.js` | Window and handlers. Runs wrangler on Electron's own Node, so the user needs nothing else installed. |
| `steps.js` | The install steps, without Electron. `test_setup.mjs` runs them. |
| `ui.html`, `preload.js` | The wizard screens and the bridge to `main.js`. |
| `prepare.mjs` | Copies the git-tracked Worker and Kindle files to `payload/`, and removes the KV id from `wrangler.toml`. |
| `node-shim.cjs` | Lets wrangler read its arguments correctly on Electron's Node. |

## Building

`npm run dist` builds the app for the current system: a `.dmg` on macOS, or an installer `.exe` on Windows. Build each system on that system (for example with a GitHub Actions matrix), because wrangler's esbuild binary is different for each system.

Without code signing, macOS says that the app is from an unidentified developer. The person must right-click the app and select Open. Windows SmartScreen asks once in the same way. An Apple Developer ID removes the macOS warning.
