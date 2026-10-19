import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createToolHealthService} from '../../src/tooling/tool-health-service.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {toolInstallDir, toolRuntimeIdentity} from '../../src/tooling/tool-runtime-identity.mjs';
import {createToolProfileService} from '../../src/tooling/tool-profile-service.mjs';
import {OFFICECLI_MANIFEST} from '../../src/tooling/manifests/officecli.mjs';

const manifest={id:'officecli',version:'1.0.145',healthCheck:'version-handshake',
  mcp:{serverName:'office',expectedTools:[]},artifact:{}};

test('switching an override invalidates health before the five-minute TTL',async()=>{
  let executable='C:/fixture/good.exe';
  const inspected=[];
  const service=createToolHealthService({
    packages:{resolve:async()=>({state:'installed',executable,autoUpdate:false})},
    probe:async file=>{inspected.push(file);return file.endsWith('good.exe')?'1.0.145':'9.9.9';},
  });
  assert.equal((await service.check(manifest)).available,true);
  executable='C:/fixture/bad.exe';
  assert.equal((await service.check(manifest)).available,false);
  assert.deepEqual(inspected,['C:/fixture/good.exe','C:/fixture/bad.exe']);
});

test('an executable disappearing is not hidden by cached healthy status',async()=>{
  let installed={state:'installed',executable:'C:/fixture/good.exe',autoUpdate:false};
  const service=createToolHealthService({packages:{resolve:async()=>installed},probe:async()=> '1.0.145'});
  assert.equal((await service.check(manifest)).available,true);
  installed={state:'not-installed',executable:null,autoUpdate:false};
  assert.equal((await service.check(manifest)).available,false);
});

test('replacing bytes at the same entry path rechecks health',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'trylo-health-replace-'));
  const executable=path.join(root,'entry.exe');
  fs.writeFileSync(executable,'1.0.145');
  const service=createToolHealthService({
    packages:{resolve:async()=>({state:'installed',executable})},
    probe:async file=>fs.readFileSync(file,'utf8'),
  });
  assert.equal((await service.check(manifest)).available,true);
  fs.writeFileSync(executable,'9.9.9-invalid');
  assert.equal((await service.check(manifest)).available,false);
});

test('Python source-run overrides retain the package root',()=>{
  assert.equal(toolInstallDir({artifact:{executableRelativePath:'.venv/Scripts/python.exe'}},
    'D:/tools/solidworks/.venv/Scripts/python.exe'),path.normalize('D:/tools/solidworks'));
});

test('profile cannot launch a runtime different from the one health checked',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'trylo-profile-changed-'));
  const checked={state:'installed',executable:path.join(root,'checked.exe'),installDir:root};
  const current={...checked,executable:path.join(root,'changed.exe')};
  const service=createToolProfileService({storageRoot:root,
    catalog:{get:id=>id==='officecli'?OFFICECLI_MANIFEST:undefined,list:()=>[OFFICECLI_MANIFEST]},
    packages:{resolve:async()=>current},
    health:{check:async()=>({available:true,runtimeIdentity:toolRuntimeIdentity(OFFICECLI_MANIFEST,checked)})},
  });
  const result=await service.resolve({surface:'work',projectRoot:root,conversationId:'changed'});
  assert.equal(result.ok,true);
  assert.ok(result.unavailableCapabilities.some(item=>item.id==='officecli'&&item.reasonCode==='runtime_changed'));
  assert.equal(result.serverNames.includes(OFFICECLI_MANIFEST.mcp.serverName),false);
});

test('a stable runtime identity is forwarded into the actual MCP environment',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'trylo-profile-identity-'));
  const checked={state:'installed',executable:path.join(root,'checked.exe'),installDir:root};
  const identity=toolRuntimeIdentity(OFFICECLI_MANIFEST,checked);
  const service=createToolProfileService({storageRoot:root,
    catalog:{get:id=>id==='officecli'?OFFICECLI_MANIFEST:undefined,list:()=>[OFFICECLI_MANIFEST]},
    packages:{resolve:async()=>checked},health:{check:async()=>({available:true,runtimeIdentity:identity})},
  });
  const result=await service.resolve({surface:'work',projectRoot:root,conversationId:'same'});
  const config=JSON.parse(fs.readFileSync(result.mcpConfigPath,'utf8'));
  assert.equal(config.mcpServers[OFFICECLI_MANIFEST.mcp.serverName].env.TRYLO_TOOL_RUNTIME_ID,identity);
});

test('an in-place runtime repair changes config identity while an unchanged run stays stable',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'trylo-profile-repair-'));
  const executable=path.join(root,'entry.exe');
  fs.writeFileSync(executable,'before');
  const packages={resolve:async()=>({state:'installed',executable,installDir:root})};
  const health=createToolHealthService({packages,probe:async()=>OFFICECLI_MANIFEST.version});
  const service=createToolProfileService({storageRoot:root,packages,health,
    catalog:{get:id=>id==='officecli'?OFFICECLI_MANIFEST:undefined,list:()=>[OFFICECLI_MANIFEST]}});
  const params={surface:'work',projectRoot:root,conversationId:'same'};
  const first=await service.resolve(params);
  const same=await service.resolve(params);
  assert.equal(first.ok,true);
  assert.equal(same.mcpConfigHash,first.mcpConfigHash);
  fs.writeFileSync(executable,'after-runtime-repair');
  const repaired=await service.resolve(params);
  assert.equal(repaired.ok,true);
  assert.notEqual(repaired.mcpConfigHash,first.mcpConfigHash);
});
