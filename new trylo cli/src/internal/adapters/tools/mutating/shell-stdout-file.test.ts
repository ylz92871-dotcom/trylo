import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "./index.js";
import type { ShellSpawner } from "./shell-spawn.js";

const OUTPUT = '{"count":4,"revenue":15.5,"paidCount":2}\n';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "trylo-shell-stdout-"));
  writeFileSync(join(root,"result.json"),"old");
  return {root,close:()=>rmSync(root,{recursive:true,force:true})};
}

test("a foreground command can publish its exact stdout as a file through the production sandbox",async()=>{
  const fx=fixture();
  try {
    const spawner:ShellSpawner=async()=>({stdout:OUTPUT,stderr:"diagnostic text",exitCode:0,timedOut:false,aborted:false,truncated:false});
    const tools=createMutatingTools({sandbox:createWorkspaceSandbox({workspaceRoot:fx.root}),spawner});
    const result=await tools.execute({toolCallId:"c",name:"run_shell",arguments:{command:"node producer.mjs",stdoutFile:"result.json"}},new AbortController().signal);
    assert.equal(result.outcome,"result");
    assert.equal(readFileSync(join(fx.root,"result.json"),"utf8"),OUTPUT);
    if(result.outcome==="result")assert.equal(result.value.fileWrite!==undefined,true);
  } finally {fx.close();}
});

test("stdout destinations are admitted before any command runs and retain the write ceiling",async()=>{
  const fx=fixture();
  let calls=0;

  try {
    const spawner:ShellSpawner=async()=>{
      calls++;
      return {stdout:OUTPUT,stderr:"",exitCode:0,timedOut:false,aborted:false,truncated:false};
    };
    const tools=createMutatingTools({sandbox:createWorkspaceSandbox({workspaceRoot:fx.root,maxWriteBytes:4}),spawner});
    const escaped=await tools.execute({toolCallId:"c",name:"run_shell",arguments:{command:"node producer.mjs",stdoutFile:"../outside.json"}},new AbortController().signal);

    assert.equal(escaped.outcome,"error");
    assert.equal(calls,0);
    const large=await tools.execute({toolCallId:"c",name:"run_shell",arguments:{command:"node producer.mjs",stdoutFile:"result.json"}},new AbortController().signal);

    assert.equal(large.outcome,"error");
    if(large.outcome==="error")assert.equal(large.code,"write_too_large");

    assert.equal(readFileSync(join(fx.root,"result.json"),"utf8"),"old");
  } finally {fx.close();}
});

test("failed, truncated and cancelled producers never publish a partial stdout file",async()=>{
  const fx=fixture();
  try {
    for(const mode of ["failed","truncated","cancelled"] as const){
      const spawner:ShellSpawner=async()=>({stdout:OUTPUT,stderr:"",exitCode:mode==="failed"?1:0,timedOut:false,aborted:mode==="cancelled",truncated:mode==="truncated"});
      const tools=createMutatingTools({sandbox:createWorkspaceSandbox({workspaceRoot:fx.root}),spawner});
      const result=await tools.execute({toolCallId:mode,name:"run_shell",arguments:{command:"node producer.mjs",stdoutFile:"result.json"}},new AbortController().signal);
      assert.notEqual(result.outcome,"result");
      assert.equal(readFileSync(join(fx.root,"result.json"),"utf8"),"old");
    }
  } finally {fx.close();}
});

test("stdoutFile is refused for background sessions and multi-command steps",async()=>{
  const fx=fixture();
  try {
    const sandbox=createWorkspaceSandbox({workspaceRoot:fx.root});
    for(const extra of [{runInBackground:true},{steps:["node other.mjs"]}]){
      const result=sandbox.evaluate({toolCallId:"c",name:"run_shell",arguments:{command:"node producer.mjs",stdoutFile:"result.json",...extra}});
      assert.equal(result.ok,false);
      if(!result.ok)assert.equal(result.code,"invalid_arguments");
    }
  } finally {fx.close();}
});
