import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createToolPackageManager, resolveNpmCommand, nodeScriptPath } from '../../src/tooling/tool-package-manager.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test('npm runs when the native shell supplied a verbatim Node executable path', {skip:process.platform!=='win32'}, () => {
  const npm = resolveNpmCommand(path.toNamespacedPath(process.execPath));
  assert.ok(npm, 'test Node distribution includes npm');
  const version=execFileSync(npm.command,[...npm.args,'--version'],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.match(version.trim(),/^\d+\.\d+\.\d+$/);
  assert.ok(!npm.args[0].startsWith('\\\\?\\'));
});

test('Node script path normalization preserves spaces, UNC shares and unrelated devices', () => {
  assert.equal(nodeScriptPath('\\\\?\\C:\\路径 with spaces\\npm-cli.js'),'C:\\路径 with spaces\\npm-cli.js');
  assert.equal(nodeScriptPath('\\\\?\\UNC\\server\\share\\npm-cli.js'),'\\\\server\\share\\npm-cli.js');
  assert.equal(nodeScriptPath('\\\\?\\Volume{123}\\entry.js'),'\\\\?\\Volume{123}\\entry.js');
  assert.equal(nodeScriptPath('C:/normal/entry.js'),'C:/normal/entry.js');
});

async function fixture(t, runCommand) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-install-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldUv = process.env.UV_PATH;
  process.env.UV_PATH = process.execPath; // Only resolution is real; runner below is injected.
  t.after(() => oldUv === undefined ? delete process.env.UV_PATH : process.env.UV_PATH = oldUv);
  const manifest = {id:'test-python', version:'1.0.0', artifact:{installStrategy:'pinned-python-env',
    downloadUrl:'https://example.invalid/pinned.tgz', archiveSha256:digest('archive'),
    uvLockSha256:digest('locked'), executableRelativePath:'.venv/Scripts/test.exe'}};
  const packages = createToolPackageManager({installRoot:root, catalog:{get:()=>manifest},
    download:(_url,dest)=>fs.writeFile(dest,'archive'),
    extract:async (_archive,dest)=> {await fs.writeFile(path.join(dest,'uv.lock'),'locked');},
    runCommand});
  return {packages, root};
}

test('online fallback reports the online failure rather than the expected cold-cache error', async t => {
  const calls=[];
  const {packages}=await fixture(t, async (_exe,args)=>{
    calls.push(args);
    throw new Error(args.includes('--offline') ? 'CACHE_MISS_OFFLINE' : 'ONLINE_DOWNLOAD_FAILED');
  });
  const result=await packages.install({id:'test-python'});
  assert.equal(result.ok,false);
  assert.match(result.error,/ONLINE_DOWNLOAD_FAILED/);
  assert.doesNotMatch(result.error,/CACHE_MISS_OFFLINE/);
  assert.equal(calls.length,2);
});

test('all Python sync phases use short private scratch directories without changing global temp', async t => {
  const oldTemp=process.env.TEMP;
  const oldTmp=process.env.TMP;
  const calls=[];
  const {packages,root}=await fixture(t, async (_exe,args,_timeout,opts)=>{
    calls.push({args,opts});
    assert.equal(path.dirname(opts?.env?.TEMP),os.tmpdir());
    assert.match(path.basename(opts.env.TEMP),/^trylo-it-/);
    assert.equal(opts.env.TMP,opts.env.TEMP);
    assert.equal((await fs.stat(opts.env.TEMP)).isDirectory(),true);
    if(calls.length===1) throw new Error('cold cache');
  });
  const result=await packages.install({id:'test-python'});
  assert.equal(result.ok,true,result.error);
  assert.equal(calls.length,3,'offline, locked online, final-location repair');
  assert.ok(calls.every(call=>call.args.includes('--locked')));
  assert.equal(process.env.TEMP,oldTemp);
  assert.equal(process.env.TMP,oldTmp);
  assert.ok(calls.every(call=>call.opts.env.UV_CACHE_DIR.startsWith(root+path.sep)), 'owned cache avoids shared-cache lock failures');
  assert.ok(calls.every(call=>call.opts.env[Object.keys(call.opts.env).find(key=>key.toLowerCase()==='path')].startsWith(path.dirname(process.execPath)+path.delimiter)), 'build subprocesses find the packaged node');
  for(const call of calls) await assert.rejects(fs.stat(call.opts.env.TEMP), {code:'ENOENT'});
  const state=JSON.parse(await fs.readFile(path.join(root,'test-python/1.0.0/install-state.json')));
  assert.equal(state.offlineSync,false);
});

test('repeated installation requests share one in-flight package transaction', async t => {
  let releases;
  const gate=new Promise(resolve=>{releases=resolve;});
  let runs=0;
  const {packages}=await fixture(t,async()=>{runs++;await gate;});
  const first=packages.install({id:'test-python'});
  const second=packages.install({id:'test-python'});
  releases();
  const results=await Promise.all([first,second]);
  assert.ok(results.every(result=>result.ok),JSON.stringify(results));
  assert.equal(runs,2,'one staged sync and one final-location repair, no duplicate writer');
  await packages.install({id:'test-python'});
  assert.equal(runs,4,'a completed install may be explicitly retried');
});
