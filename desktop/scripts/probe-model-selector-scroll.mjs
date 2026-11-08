// Isolated browser fixture: production component/styles, synthetic model data.
// No provider, account tokens, settings writes or chat requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop-services/node_modules/esbuild/lib/main.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.join(repo, '_workspace/artifacts/output/model-selector-scroll-20261026');
const before = process.argv.includes('--before');
const folder = path.join(root, before ? 'browser-before' : 'browser-after');
await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(folder, 'models.tsx'), `import {useState,useEffect} from 'react';
export function usePlatformModels(open){const[models,setModels]=useState([]);useEffect(()=>{if(!open)return;const timer=setTimeout(()=>setModels(${JSON.stringify(['DeepSeek-V4.1-Flash','DeepSeek-V4-Flash','Gemma-4-31B-IT','GLM-5.3-Flash','MiMo-V2.6-Flash','MiniCPM5-2B','MiniCPM-V-4.7-1B','MiniCPM-V-4.7-35B-A3B','Qwen3.8-27B','Qwen3.8-Flash-Next'].map(id=>({id,chat:true,pool:'free',remaining:1000})))}),650);return()=>clearTimeout(timer)},[open]);return{models,loading:open&&!models.length,message:''}}`);
await fs.writeFile(path.join(folder, 'main.tsx'), `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ModelSelector}from'production-model-selector';
function Fixture(){const[model,setModel]=useState('');return <main><h1>模型选择 · 滚动检查</h1><p>生产组件与样式，5 个个人配置 + 10 个异步文本模型</p><label>显示主题 <select onChange={e=>document.documentElement.dataset.theme=e.target.value}><option value="light">浅色</option><option value="dark">深色</option></select></label><section className="composer"><textarea aria-label="测试输入" placeholder="描述你想完成的工作"/><div className="row"><span>Work</span><ModelSelector configuredModel="ark-code-latest" poolModel={model} savedProfiles={${JSON.stringify(['火山','B.AI','火山GLM-5.3flash','GLM-5.3 flash','火山OA'].map((label,i)=>({id:'fixture-'+i,label,hint:'ark-code-latest'})))}} onSelectConfigured={()=>setModel('')} onSelectPool={setModel} onSelectProfile={setModel}/></div></section><output aria-label="当前选择">{model||'ark-code-latest'}</output></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`);
await build({entryPoints:[path.join(folder,'main.tsx')],bundle:true,platform:'browser',format:'esm',jsx:'automatic',outfile:path.join(folder,'bundle.js'),nodePaths:[path.join(repo,'desktop/node_modules')],plugins:[{name:'isolated-models',setup(build){build.onResolve({filter:/^production-model-selector$/},()=>({path:path.join(repo,before?'_workspace/artifacts/output/model-selector-scroll-20261026/before/desktop/src/components/chat/ModelSelector.tsx':'desktop/src/components/chat/ModelSelector.tsx')}));build.onResolve({filter:/use-platform-models$/},()=>({path:path.join(folder,'models.tsx')}));}}]});
const styles=[];for(const file of ['desktop/src/styles/tokens.css','desktop/src/styles/base.css','desktop/src/styles/components/mode-popover.css',before?'_workspace/artifacts/output/model-selector-scroll-20261026/before/desktop/src/styles/components/model-selector.css':'desktop/src/styles/components/model-selector.css'])styles.push(await fs.readFile(path.join(repo,file),'utf8'));
styles.push('main{height:100%;padding:40px;display:flex;flex-direction:column;gap:16px}h1,p{margin:0}h1{font-size:24px}label{font-size:14px}select{margin-left:8px}.composer{margin-top:auto;align-self:center;width:min(680px,90vw);padding:20px;border:1px solid var(--border-strong);border-radius:16px}.composer textarea{background:transparent;color:var(--fg);width:100%;height:90px;border:0;resize:none}.row{display:flex;gap:16px;align-items:center}output{text-align:center;font-size:13px;color:var(--fg-muted)}');
await fs.writeFile(path.join(folder,'styles.css'),styles.join('\n'));
await fs.writeFile(path.join(folder,'index.html'),'<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><title>Trylo 模型菜单滚动验证</title><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>');
const server=http.createServer(async(request,response)=>{const file=({'/':'index.html','/bundle.js':'bundle.js','/styles.css':'styles.css'})[request.url];if(!file){response.writeHead(404);response.end();return;}response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');response.end(await fs.readFile(path.join(folder,file)));});
server.listen(5326,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:5326/',productionComponent:!before,syntheticModels:true,before})));
