import test from 'node:test';import assert from 'node:assert/strict';
import {ensureDevelopmentCli} from './ensure-dev-cli.mjs';
const current='trylo - learning agent CLI\n  --context-window <tokens>\n  --model-context-window <tokens>\n';
test('a current CLI is checked without rebuilding',()=>{const calls=[];ensureDevelopmentCli({log:()=>{},run:(program,args)=>{calls.push(args);return{status:0,stdout:current};}});assert.equal(calls.length,1);});
test('an older checkout dist is rebuilt once and rechecked before Desktop starts',()=>{let probes=0;const builds=[];ensureDevelopmentCli({log:()=>{},run:(program,args)=>{if(args.at(-1)==='--help')return{status:0,stdout:++probes===1?'old help':current};builds.push(args);return{status:0};}});assert.equal(probes,2);assert.equal(builds.length,4);assert.ok(builds[0][0].endsWith('/typescript/bin/tsc')||builds[0][0].endsWith('\\typescript\\bin\\tsc'));});
test('a failed build prevents launch instead of hiding unsupported flags',()=>{assert.throws(()=>ensureDevelopmentCli({log:()=>{},run:(program,args)=>args.at(-1)==='--help'?{status:0,stdout:'old help'}:{status:1}}),/build failed/);});
