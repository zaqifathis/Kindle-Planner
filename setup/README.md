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

If the Kindle has no KUAL yet, the app can prepare it. The person clicks Prepare my Kindle:

1. The app copies the Kindle's `documents` folder to `Documents/Kindle backup <date>` on the computer. Then it downloads WinterBreak, copies it to the Kindle, and fills the Kindle storage so that the Kindle cannot download an Amazon update.
2. The person runs WinterBreak from the Kindle Store on the Kindle.
3. The app removes the filler and the `.bin` update files, then copies KUAL to `documents/` and creates `extensions/`.

The downloads are pinned to one version and one SHA-256 hash in `steps.js` (`JB`). If WinterBreak or PEKI release a new version, update the URL and the hash there. The app does not install MRPI, because Kid Planner does not need it. After another jailbreak, the person clicks only Install KUAL. The app does not check the firmware version. The person reads it on the Kindle.

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

`npm run dist` builds the app for the current system: an Apple silicon `.dmg` on macOS, or an installer `.exe` on Windows. Build each system on that system (for example with a GitHub Actions matrix), because wrangler's esbuild and workerd binaries are different for each system. The `.dmg` is about 215 MB. Most of it is workerd, which wrangler loads at startup even though Setup never runs it.

To test without signing:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac -c.mac.notarize=false
```

### Signing and notarization (macOS)

An app that other people download must be signed with a Developer ID certificate and notarized by Apple. Otherwise macOS blocks it. You do these two steps once:

1. Create the certificate. In Xcode, open Settings > Accounts, select your team, and click Manage Certificates. Click + and select Developer ID Application. Only the Account Holder of the team can create it.
2. Save the notarization login in the keychain. Create an app-specific password at account.apple.com (Sign-In and Security > App-Specific Passwords), then run:

   ```sh
   xcrun notarytool store-credentials kidplanner-notary --apple-id <your Apple ID> --team-id <your team ID>
   ```

   The command asks for the app-specific password. Your team ID is on developer.apple.com > Account > Membership.

Then build. electron-builder signs with the Developer ID certificate, uses the hardened runtime with `build/entitlements.mac.plist`, and sends the app to Apple for notarization:

```sh
APPLE_KEYCHAIN_PROFILE=kidplanner-notary npm run dist
```

### Publishing the downloads

The web page `docs/index.html` (GitHub Pages) links to the newest GitHub Release. The links work only when the release has files with these exact names. `package.json` sets them (`artifactName`):

- `KidPlannerSetup-mac.dmg`
- `KidPlannerSetup-windows.exe`

To publish a new version:

1. Raise `version` in `package.json`.
2. Build the signed `.dmg` on the Mac, and the `.exe` with the Windows workflow.
3. On GitHub, open Releases > Draft a new release. Make a tag such as `v1.1.0`, attach both files, and click Publish release.

To turn on the web page, open Settings > Pages on GitHub. Under Build and deployment, select Deploy from a branch, then `main` and `/docs`. The repository must be public, or the GitHub plan must allow Pages for private repositories. Release downloads work for other people only when the repository is public.

### Windows

GitHub Actions builds the Windows installer, because esbuild and workerd must be the Windows builds. On GitHub, open Actions > Build Setup (Windows) > Run workflow. When the run is done, download `kid-planner-setup-windows` under Summary > Artifacts. It holds the `.exe`.

The workflow runs `npm test` first. The test fails if a Kindle script has Windows line endings (CRLF), because the Kindle cannot run such a script. `.gitattributes` keeps the `kindle/` files unchanged on Windows checkouts.

The `.exe` is not signed. When a person opens it, Windows SmartScreen shows "Windows protected your PC". The person must click More info, then Run anyway. To remove this warning, sign the installer with a Windows code signing certificate (for example Azure Trusted Signing).

