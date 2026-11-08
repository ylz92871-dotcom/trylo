import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { stageCliOptions } from './stage-cli-options.mjs';

// Build-machine only: stage the audited CLI closure and exercise it outside the checkout.
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(desktop, '../new trylo cli');
const bundledResources = path.join(desktop, 'src-tauri/resources');
const options = stageCliOptions(process.argv.slice(2), { cwd: process.cwd(), source, resources: bundledResources });
const target = options.target;
const resources = path.dirname(target);
const node = path.join(bundledResources, 'runtime/node/win-x64/node.exe');
const entry = 'dist/cmd/trylo/main.js';
if (options.isolatedOutput) assert.ok(!existsSync(target), 'Candidate output already exists; choose a fresh --output');
mkdirSync(resources, { recursive: true });

/** Publish a verified candidate, keeping the old bundle recoverable on failure. */
function replaceStagedBundle(staged) {
  assert.equal(path.dirname(staged), resources);
  assert.equal(path.dirname(target), resources);
  assert.ok(
    !existsSync(target) || !lstatSync(target).isSymbolicLink(),
    'Refuse to replace a redirected staging directory',
  );
  const backupRoot = mkdtempSync(path.join(resources, 'cli-backup-'));
  assert.equal(path.dirname(backupRoot), resources);
  assert.ok(!lstatSync(backupRoot).isSymbolicLink());
  const backup = path.join(backupRoot, 'cli');
  try {
    if (existsSync(target)) renameSync(target, backup);
    try {
      renameSync(staged, target);
    } catch (error) {
      if (existsSync(backup)) {
        try {
          renameSync(backup, target);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `CLI replacement failed; old bundle retained at ${backup}`,
          );
        }
      }
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    // Never delete an old bundle whose restoration failed.
    if (!existsSync(backup)) rmSync(backupRoot, { recursive: true, force: true });
  }
}

const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
assert.deepEqual(
  lock.packages[''].dependencies,
  manifest.dependencies,
  'CLI manifest differs from its runtime lock',
);
assert.ok(existsSync(node), 'Stage the pinned Node runtime before the CLI');

// Reuse the CLI release pipeline, including verified sandbox/PTY helpers and SBOM.
// No install or downloads: all build inputs and locked packages must already exist.
if (!options.skipBuild) execFileSync(
  process.execPath,
  [path.join(source, 'node_modules/typescript/bin/tsc'), '-p', path.join(source, 'tsconfig.json'), '--outDir', options.dist],
  { cwd: source, stdio: 'inherit' },
);
for (const script of options.preparedClosure ? ['scripts/release-inventory.mjs'] : [
  'scripts/copy-vendor.mjs',
  'scripts/pty/copy-pty-vendor.mjs',
  'scripts/release-inventory.mjs',
]) {
  execFileSync(process.execPath, [path.join(source, script), `--out-dir=${options.dist}`,
    ...(options.preparedClosure ? ['--check-only'] : [])], { cwd: source, stdio: 'inherit' });
}
const sbom = JSON.parse(readFileSync(path.join(options.dist, 'sbom.json'), 'utf8'));
const dependencies = Object.entries(lock.packages)
  .filter(([location, locked]) => location.startsWith('node_modules/') && locked.dev !== true)
  .map(([location, locked]) => {
    assert.ok(!locked.link, `CLI runtime package must be a locked installation: ${location}`);
    const installedPath = path.resolve(source, location);
    assert.ok(
      installedPath.startsWith(path.join(source, 'node_modules') + path.sep),
      'Runtime package escapes node_modules',
    );
    const installed = JSON.parse(readFileSync(path.join(installedPath, 'package.json'), 'utf8'));
    assert.equal(installed.version, locked.version, `${location} differs from lockfile`);
    assert.ok(
      sbom.components.some(
        (component) =>
          component.type === 'library' &&
          component.name === installed.name &&
          component.version === installed.version,
      ),
      `${location} is missing from CLI release inventory`,
    );
    return {
      path: location,
      name: installed.name,
      version: installed.version,
      license: installed.license ?? 'unspecified',
    };
  });
for (const [name, version] of Object.entries(manifest.dependencies)) {
  assert.ok(
    dependencies.some(
      (dependency) => dependency.path === `node_modules/${name}` && dependency.version === version,
    ),
    `Direct runtime package missing from closure: ${name}`,
  );
}
// Keep the current bundle intact until the replacement passes its isolated smoke.
const staged = mkdtempSync(path.join(resources, 'cli-stage-'));
try {
  cpSync(options.dist, path.join(staged, 'dist'), {
    recursive: true,
    filter: (item) => {
      const relative = path.relative(options.dist, item).replaceAll(path.sep, '/');
      return (
        !/\.test\.|\.test$/.test(path.basename(item)) &&
        !/^(?:tests[^/]*\.tap|quality-report\.json|wp27-[^/]*\.json)$/.test(relative)
      );
    },
  });
  cpSync(path.join(source, 'package.json'), path.join(staged, 'package.json'));
  for (const dependency of dependencies) {
    cpSync(path.join(source, dependency.path), path.join(staged, dependency.path), {
      recursive: true,
      dereference: true,
    });
  }
  const digest = createHash('sha256')
    .update(readFileSync(path.join(staged, entry)))
    .digest('hex');
  const inventory = {
    buildInput: { path: options.dist, compilationSkipped: options.skipBuild },
    version: manifest.version,
    entry,
    sha256: digest,
    dependencies,
    sbomSha256: createHash('sha256')
      .update(readFileSync(path.join(staged, 'dist/sbom.json')))
      .digest('hex'),
    runtimeLockSha256: createHash('sha256')
      .update(readFileSync(path.join(source, 'package-lock.json')))
      .digest('hex'),
    nodeSha256: createHash('sha256').update(readFileSync(node)).digest('hex'),
    nodeVersion: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(),
  };

  const isolated = mkdtempSync(path.join(tmpdir(), 'trylo-cli-bundle-'));
  try {
    cpSync(staged, path.join(isolated, 'cli'), { recursive: true });
    cpSync(node, path.join(isolated, 'node.exe'));
    // The smoke runs with the build host's authority. A copied executable must
    // not silently downgrade that process through an inherited integrity label.
    // Only this owned temporary copy changes; the packaged runtime stays intact.
    let smokeIntegrity;
    if (process.platform === 'win32') {
      assert.equal(path.dirname(isolated), path.resolve(tmpdir()));
      const system = path.join(process.env.SystemRoot, 'System32');
      const groups = execFileSync(path.join(system, 'whoami.exe'), ['/groups'], { encoding: 'utf8', windowsHide: true });
      smokeIntegrity = groups.includes('S-1-16-12288') ? 'H' : 'M';
      execFileSync(path.join(system, 'icacls.exe'), [path.join(isolated, 'node.exe'), '/setintegritylevel', smokeIntegrity], { windowsHide: true });
    }
    const workspace = path.join(isolated, 'workspace');
    const home = path.join(isolated, 'home');
    mkdirSync(workspace);
    mkdirSync(home);
    const isolatedEnv = {
      ...process.env,
      // Resolve runtime dependencies only from the copied bundle, never caller overrides.
      NODE_PATH: '',
      PATH: '',
      TRYLO_HOME: home,
      USERPROFILE: home,
      HOME: home,
      TRYLO_API_KEY: '',
      TRYLO_OPENAI_API_KEY: '',
    };
    // Resolve every direct dependency from the copied tree, with system Node absent.
    const resolutionScript = `const requireFromCli = require('node:module').createRequire(${JSON.stringify(path.join(isolated, 'cli/package.json'))});
    for (const name of ${JSON.stringify(Object.keys(manifest.dependencies))}) requireFromCli.resolve(name);`;
    execFileSync(path.join(isolated, 'node.exe'), ['-e', resolutionScript], {
      cwd: workspace,
      env: isolatedEnv,
      timeout: 60_000,
    });
    writeFileSync(path.join(workspace, 'package.json'), '{"name":"installed-cli-proof"}');
    const child = spawn(
      path.join(isolated, 'node.exe'),
      [
        path.join(isolated, 'cli', entry),
        'run',
        '--provider',
        'fixture-write',
        '--format',
        'stream-json',
        '--permission-prompt-tool',
        'stdio',
        '--ask',
        'always',
        '--workspace',
        workspace,
        '-',
      ],
      {
        cwd: workspace,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: isolatedEnv,
      },
    );
    let buffer = '';
    let stdout = '';
    let stderr = '';
    const smokeStartedAt = Date.now();
    let approvalRequests = 0;
    const frames = [];
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (timedOut)
          reject(
            new Error(
              `Staged CLI approval smoke exceeded 60 seconds (${frames.length} frames): ${stderr}`,
            ),
          );
        else code === 0 ? resolve() : reject(new Error(`Staged CLI exit ${code}: ${stderr}`));
      });
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        buffer += String(chunk);
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0) break;
          try {
            const frame = JSON.parse(buffer.slice(0, end));
            frames.push(frame);
            buffer = buffer.slice(end + 1);
            if (frame.type === 'control_request') {
              approvalRequests += 1;
              assert.equal(existsSync(path.join(workspace, 'fixture-output.txt')), false);
              child.stdin.write(
                JSON.stringify({
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: frame.request_id,
                    response: { behavior: 'allow' },
                  },
                }) + '\n',
              );
            }
          } catch (error) {
            child.kill();
            reject(error);
            return;
          }
        }
      });
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60_000);
    try {
      child.stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Write and verify a fixture file' },
        }) + '\n',
      );
      await completion;
      assert.ok(approvalRequests > 0, 'Staged fixture write bypassed its required approval');
      assert.equal(
        readFileSync(path.join(workspace, 'fixture-output.txt'), 'utf8'),
        'the fixture wrote this line',
      );
      assert.equal(frames.filter((frame) => frame.type === 'run_result').length, 1);
      assert.equal(frames.find((frame) => frame.type === 'run_result').status, 'completed');
      inventory.isolatedSmoke = {
        passed: true,
        ...(smokeIntegrity === undefined ? {} : { integrity: smokeIntegrity }),
        elapsedMs: Date.now() - smokeStartedAt,
        noSystemNode: true,
        dependencyResolution: true,
        approvalBeforeWrite: true,
        approvalRequests,
        terminalCount: 1,
      };
    } catch (error) {
      // Keep the actual failure visible even though transient staging trees
      // are removed. The isolated smoke contains synthetic data and no key.
      const diagnostic = path.join(resources, `cli-smoke-failure-${smokeStartedAt}.json`);
      writeFileSync(diagnostic, JSON.stringify({ phase: 'permission-smoke',
        buildInput: options.dist, entrySha256: digest, nodeSha256: inventory.nodeSha256,
        startedAt: new Date(smokeStartedAt).toISOString(), elapsedMs: Date.now() - smokeStartedAt,
        timedOut, approvalRequests, frames, stdout, stderr,
        error: error instanceof Error ? error.message : String(error),
        fixtureOutputPresent: existsSync(path.join(workspace, 'fixture-output.txt')),
      }, null, 2) + '\n');
      throw error;
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
    }
  } finally {
    assert.equal(path.dirname(isolated), path.resolve(tmpdir()));
    rmSync(isolated, { recursive: true, force: true });
  }
  const files = [];
  function inventoryFiles(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) inventoryFiles(absolute);
      else {
        assert.ok(entry.isFile(), `Staged bundle contains a redirected entry: ${absolute}`);
        const bytes = readFileSync(absolute);
        files.push({
          path: path.relative(staged, absolute).replaceAll(path.sep, '/'),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  inventoryFiles(staged);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const fileInventory = JSON.stringify(files, null, 2) + '\n';
  inventory.fileInventory = {
    path: 'files.json',
    count: files.length,
    sha256: createHash('sha256').update(fileInventory).digest('hex'),
  };
  writeFileSync(path.join(staged, 'files.json'), fileInventory);
  writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(inventory, null, 2) + '\n');
  replaceStagedBundle(staged);
  console.log(JSON.stringify(inventory, null, 2));
} finally {
  assert.equal(path.dirname(staged), resources);
  rmSync(staged, { recursive: true, force: true });
}
