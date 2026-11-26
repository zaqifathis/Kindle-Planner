// Loaded with --require when wrangler runs on Electron's Node: yargs sees process.versions.electron
// and drops one argument too many unless defaultApp is set.
process.defaultApp = true;
