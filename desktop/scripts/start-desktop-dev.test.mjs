// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('./start-desktop-dev.mjs', import.meta.url));
const checkoutCli = fileURLToPath(new URL('../../new trylo cli/dist/cmd/trylo/main.js', import.meta.url));

/** Run the actual launcher with its child-spawn boundary replaced, so no app is opened or closed. */
function launch(override, args = [], missingBuild = false, nodeOverride = '') {
  const preload = `
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    ${missingBuild ? `fs.existsSync = path => !String(path).includes('new trylo cli');` : ''}
    childProcess.spawnSync = (command, argv, options) => {
      console.log(JSON.stringify({ cliScript: options.env.TRYLO_CLI_SCRIPT ?? null, nodeBinary: options.env.TRYLO_NODE_BINARY ?? null, argv }));
      return { status: 0 };
    };
    syncBuiltinESMExports();
  `;
  const stdout = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, launcher, ...args], {
    env: { ...process.env, TRYLO_CLI_SCRIPT: override, TRYLO_NODE_BINARY: nodeOverride }, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

it('launches dev against this checkout even when old bundled resources exist', () => {
  expect(launch('').cliScript).toBe(checkoutCli);
});

it('preserves an explicit operator CLI override', () => {
  expect(launch('D:/operator/trylo/main.js').cliScript).toBe('D:/operator/trylo/main.js');
});

it('uses the launching Node for dev services rather than an old Low integrity staged runtime', () => {
  expect(launch('').nodeBinary).toBe(process.execPath);
  expect(launch('', [], false, 'D:/operator/node.exe').nodeBinary).toBe('D:/operator/node.exe');
});

it('help keeps its read-only startup path without requiring a CLI build', () => {
  expect(launch('', ['--help'], true).cliScript).toBe('');
});

it('a missing dev build refuses instead of falling through to an old bundled CLI', () => {
  expect(() => launch('', [], true)).toThrow(/Build the new CLI/);
});
