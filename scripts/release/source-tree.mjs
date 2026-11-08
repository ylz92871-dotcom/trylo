// Produce a local review tree from an explicit allowlist. This is not a release gate.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const layout = JSON.parse(readFileSync(path.join(root, 'scripts/release/source-layout.json'), 'utf8'));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!['--preview', '--report'].includes(key) || !process.argv[index + 1] || options[key]) {
    throw new Error('Usage: node scripts/release/source-tree.mjs [--preview _workspace/artifacts/source-preview/new-directory] [--report _workspace/artifacts/source-preview/report.json]');
  }
  options[key] = process.argv[index + 1];
}
if (layout.schemaVersion !== 1) throw new Error('Unsupported source layout schema');

const posix = value => value.split(path.sep).join('/');
const below = (value, prefix) => value === prefix || value.startsWith(prefix + '/');
const digest = data => createHash('sha256').update(data).digest('hex');
function localPath(relative) {
  if (path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Use relative forward-slash paths');
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) throw new Error('Path escapes workcopy');
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Redirected path refused: ' + relative);
  }
  return absolute;
}
function outputPath(relative) {
  const absolute = localPath(relative);
  const releaseRoot = path.join(root, '_workspace/artifacts/source-preview');
  if (!absolute.startsWith(releaseRoot + path.sep)) throw new Error('Outputs must stay below _workspace/artifacts/source-preview/');
  return absolute;
}
const preview = options['--preview'] ? outputPath(options['--preview']) : null;
const report = options['--report'] ? outputPath(options['--report']) : null;
if (preview && existsSync(preview)) throw new Error('Refuse to overwrite an existing preview');
if (report && existsSync(report)) throw new Error('Refuse to overwrite an existing report');
if (preview && report && (report === preview || report.startsWith(preview + path.sep))) {
  throw new Error('Keep the private report outside the source preview');
}

const generatedSegments = new Set(['.git', 'node_modules', 'target', '__pycache__', '.gradle', '.venv', 'dist', 'build', '.cache']);
const excludedSuffixes = /\.(?:exe|msi|apk|aab|zip|tgz|7z|keystore|jks|pfx|p12|db|sqlite|sqlite3|mp4|wav|mp3|pyc|pdb|tsbuildinfo)$/i;
const excludedName = /^(?:\.env(?:\..+)?|credentials\.json|providers\.json|signing\.properties|key\.properties)$/i;
function omission(relative, rule) {
  if (relative.split('/').some(segment => generatedSegments.has(segment))) return 'generated dependency/build/cache directory';
  if (excludedSuffixes.test(relative)) return 'binary release, recording, local data or signing artifact';
  const basename = path.posix.basename(relative);
  if (excludedName.test(basename) && basename !== '.env.example') return 'local environment, credentials or signing configuration';
  if (rule.excludePrefixes.some(prefix => below(relative, prefix))) return 'excluded subtree: ' + rule.reason;
  if (rule.excludeFiles.includes(relative)) return 'excluded internal document/local configuration';
  return null;
}

const selected = new Map();
const excluded = [];
const tracked = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
for (const entry of tracked.split('\0')) {
  if (!entry) continue;
  const [metadata, source] = entry.split('\t');
  const [mode, , stage] = metadata.split(' ');
  if (stage !== '0') throw new Error('Unmerged index cannot be exported');
  if (mode === '160000') { excluded.push({ source, reason: 'research Git checkout' }); continue; }
  const rule = layout.roots.find(candidate => below(source, candidate.source));
  if (!rule) { excluded.push({ source, reason: 'outside product allowlist' }); continue; }
  const relative = source.slice(rule.source.length + 1);
  const reason = omission(relative, rule);
  if (reason) { excluded.push({ source, reason }); continue; }
  selected.set(source, { source, target: rule.target + '/' + relative, category: rule.id });
}
const extraSources = new Set();
for (const extra of layout.extraFiles) {
  if (extraSources.has(extra.source)) throw new Error('Duplicate explicit source: ' + extra.source);
  extraSources.add(extra.source);
  // Explicit mappings override generic roots, for example native helper relocation.
  selected.set(extra.source, { ...extra, category: 'explicit' });
}

const files = [];
const targets = new Set();
const credentialSignals = [];
const reviewedCredentialFixtures = [];
const pathSignals = [];
const rootPattern = /[dD]:[\\/]+[cC][cC][\\/]+trylo/;
const legacyPattern = /CLAUDE_CODE_|(?<!new )trylo cli[\\/]|DEFAULT_CLI_RUNTIME_PROTOCOL[^\n]*= ['"]legacy-stream-json/;
const credentialPattern = /\b(?:sk-[A-Za-z0-9_-]{28,}|ark-[A-Za-z0-9_-]{28,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
for (const item of [...selected.values()].sort((a, b) => a.target.localeCompare(b.target, 'en'))) {
  if (['trylocode-site', 'website', '_workspace', 'remote-relay'].some(prefix => below(item.source, prefix) || below(item.target, prefix))) {
    throw new Error('Private source cannot be exported: ' + item.source);
  }
  const sourcePath = localPath(item.source);
  localPath(item.target);
  const targetKey = item.target.toLowerCase();
  if (targets.has(targetKey)) throw new Error('Duplicate public target: ' + item.target);
  targets.add(targetKey);
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) throw new Error('Selected source is missing: ' + item.source);
  const bytes = readFileSync(sourcePath);
  const text = bytes.includes(0) ? null : bytes.toString('utf8');
  if (text !== null) {
    text.split(/\r?\n/).forEach((line, index) => {
      // Only locations are recorded; never print or retain matched credential text.
      if (credentialPattern.test(line)) {
        const location = { source: item.source, line: index + 1 };
        const reviewed = (layout.reviewedCredentialFixtures ?? []).find(
          entry => entry.source === item.source && entry.line === index + 1 && entry.lineSha256 === digest(Buffer.from(line, 'utf8')),
        );
        if (reviewed) reviewedCredentialFixtures.push({ ...location, lineSha256: reviewed.lineSha256, reason: reviewed.reason });
        else credentialSignals.push(location);
      }
      if (/\.(?:[cm]?js|tsx?|rs|ps1|py|json)$/.test(item.source) &&
          (rootPattern.test(line) || legacyPattern.test(line))) {
        pathSignals.push({ source: item.source, line: index + 1, testOrFixture: /test|fixture|testdata/.test(item.source) });
      }
    });
  }
  files.push({ ...item, bytes: bytes.length, sha256: digest(bytes) });
}
const summary = {
  schemaVersion: 1, status: 'preview-only', readyForSubmission: false,
  selectedFiles: files.length, selectedBytes: files.reduce((sum, item) => sum + item.bytes, 0),
  excludedTrackedEntries: excluded.length, credentialSignalCount: credentialSignals.length,
  reviewedCredentialFixtureCount: reviewedCredentialFixtures.length,
  pathSignalCount: pathSignals.length, releaseBlockers: layout.blockers,
  roots: Object.fromEntries([...new Set(files.map(item => item.target.split('/')[0]))].sort().map(name => [name, files.filter(item => item.target === name || item.target.startsWith(name + '/')).length])),
  note: 'A successful preview proves inventory/copy integrity only. It does not prove build, licensing, privacy or runtime acceptance.',
};
const result = { summary, files, excluded, credentialSignals, reviewedCredentialFixtures, pathSignals, excludedRoots: layout.excludedRoots };
if (report) { mkdirSync(path.dirname(report), { recursive: true }); writeFileSync(report, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); }
if (preview && credentialSignals.length) throw new Error('Preview blocked by possible credential material; inspect only the private report locations');
if (preview) {
  mkdirSync(preview); // Do not merge with any previous preview.
  for (const item of files) {
    const data = readFileSync(localPath(item.source));
    if (digest(data) !== item.sha256) throw new Error('Source changed after planning: ' + item.source);
    const target = path.resolve(preview, item.target);
    if (!target.startsWith(preview + path.sep)) throw new Error('Target escapes preview');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: 'wx' });
    if (digest(readFileSync(target)) !== item.sha256) throw new Error('Preview copy differs: ' + item.target);
  }
}
console.log(JSON.stringify({ ...summary, preview: preview ? posix(path.relative(root, preview)) : null, report: report ? posix(path.relative(root, report)) : null }, null, 2));
