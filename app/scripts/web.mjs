import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, missingOAuthSettings } from '../server/config.mjs';
import { createSiteServer } from '../server/site.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'dev';
if (!['dev', 'build', 'preview'].includes(mode)) throw new Error('Use dev, build, or preview.');
const env = { ...process.env, EXPO_NO_DOTENV: '1', BROWSER: 'none' };
for (const key of ['EXPO_PUBLIC_GITHUB_TOKEN', 'EXPO_PUBLIC_GITHUB_TEST_REPO', 'GITHUB_CLIENT_SECRET']) delete env[key];
let child;
let server;
if (mode === 'build') {
  child = spawn(process.execPath, [resolve(app, 'node_modules/expo/bin/cli'), 'export', '--platform', 'web', '--output-dir', 'dist-web'], { cwd: app, env, stdio: 'inherit' });
} else {
  const config = loadConfig(app);
  const root = resolve(app, 'dist-web');
  if (mode === 'preview' && !existsSync(resolve(root, 'index.html'))) throw new Error('Run npm run build:web first.');
  const devPort = mode === 'dev' ? config.port + 1 : undefined;
  server = createSiteServer(config, { root, devPort });
  server.on('error', (error) => { console.error(error.message); child?.kill(); process.exitCode = 1; });
  server.listen(config.port, config.host, () => {
    console.log(`GitGallery web: ${config.origin}`);
    const missing = missingOAuthSettings(config);
    console.log(missing.length ? `Local preview only: GitHub sign-in needs ${missing.join(' and ')}. Website operator setup: docs/WEB-AUTH-SETUP.md. Run npm run check:web for details.` : 'GitHub sign-in: configured. Visitors can continue with their own GitHub account.');
    if (devPort) child = launchDev(devPort);
  });
}
function launchDev(port) {
  const metro = spawn(process.execPath, [resolve(app, 'node_modules/expo/bin/cli'), 'start', '--web', '--host', 'localhost', '--port', String(port)], { cwd: app, env, stdio: 'inherit' });
  metro.on('exit', (code) => { server?.close(); process.exitCode = code ?? 1; });
  return metro;
}
child?.on('exit', (code) => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child?.kill(signal); server?.close(); server?.closeAllConnections(); });
