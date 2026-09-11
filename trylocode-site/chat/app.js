/* =========================================================
   Trylo Web Agent — simulated but interactive
   ========================================================= */
const $ = s => document.querySelector(s);
const stream = $('#streamInner');
const empty = $('#empty');
const input = $('#input');
const sendBtn = $('#send');
const codeEl = $('#code');
const inspEmpty = $('#inspEmpty');
const inspHead = $('#inspHead');
const inspFile = $('#inspFile');
const inspBadge = $('#inspBadge');
const inspFoot = $('#inspFoot');
const inspStat = $('#inspStat');
const inspOk = $('#inspOk');
const logo = $('.rail .logo');
const toast = $('#toast');

let mode = 'plan';
let busy = false;

/* ---- mode switching ---- */
const modeHints = {plan:'当前模式：Plan · 先思考再动手',agent:'当前模式：Agent · 交给我执行',chat:'当前模式：Chat · 像问同事一样'};
function setMode(m){
  mode = m;
  document.querySelectorAll('.mode-pill').forEach(p=>p.classList.toggle('is-active', p.dataset.mode===m));
  $('#modeHint').textContent = modeHints[m];
}
document.querySelectorAll('.mode-pill').forEach(p=>p.addEventListener('click',()=>setMode(p.dataset.mode)));

/* ---- utilities ---- */
const sleep = ms => new Promise(r=>setTimeout(r, ms));
async function typeInto(el, text, speed=7){
  let i = 0; const cur = document.createElement('span'); cur.className='cursor';
  el.textContent=''; el.appendChild(cur);
  while(i<text.length){
    cur.insertAdjacentText('beforebegin', text[i++]);
    if(i%3===0) stream.parentElement.scrollTop = stream.parentElement.scrollHeight;
    await sleep(speed + (Math.random()*speed*0.4));
  }
  cur.remove();
}
function showToast(msg){
  toast.textContent=msg; toast.classList.add('show');
  clearTimeout(showToast._t); showToast._t=setTimeout(()=>toast.classList.remove('show'),2200);
}

/* ---- inspector: fake files ---- */
const FILES = {
  'src/events/bus.ts': {lang:'ts', lines:[
    ['c','// 旧实现：单例 + 回调数组'],
    [['k','type '],['n','Handler'],['',' = () => void;']],
    [''],
    [['k','const '],['n','listeners'],['',' = new Map<string, Handler[]>();']],
    [''],
    [['k','export function '],['f','emit'],['(event: string) {']],
    ['  listeners.get(event)?.forEach(h => h());'],
    ['}'],
  ]},
  'src/events/index.ts': {lang:'ts', lines:[
    ['c','// 事件驱动总线 — 带类型、once 与 off'],
    [['k','type '],['n','Handler'],['','<T> = (payload: T) => void;']],
    [''],
    ['k','export class '],['n','EventBus'],[' {'],
    ['  private channels = new Map<string, Set<Handler<any>>>();'],
    [''],
    ['  on<T>(event: string, h: Handler<T>) {'],
    ['    if (!this.channels.has(event)) this.channels.set(event, new Set());'],
    ['    this.channels.get(event)!.add(h);'],
    ['    return () => this.off(event, h);'],
    ['  }'],
    [''],
    ['  emit<T>(event: string, payload: T) {'],
    ['    this.channels.get(event)?.forEach(h => h(payload));'],
    ['  }'],
    ['}'],
  ]},
  'tests/date.test.ts': {lang:'ts', lines:[
    [['k',"import { describe, it, expect } from 'vitest';"]],
    [['k',"import { formatRelative } from '../src/utils/date';"]],
    [''],
    [['k','describe'],["('formatRelative', () => {"]],
    ["  it"],["('刚刚', () => {"],
    ["    expect(formatRelative(Date.now())).toBe('刚刚');"],
    ['  });'],
    ['});'],
  ]},
  'package.json': {lang:'json', lines:[
    ['{'],
    ['  "name": "trylo-demo",'],
    ['  "scripts": {'],
    ['    "test": "vitest run"'],
    ['  }'],
    ['}'],
  ]},
};

function showInspector(file, state){
  inspEmpty.style.display='none';
  codeEl.style.display='block';
  inspFoot.style.display='flex';
  inspHead.classList.add('s9');
  inspFile.textContent = file;
  inspBadge.textContent = state||'open';
  const f = FILES[file] || {lines:[['',file]]};
  // Build the code view from real DOM nodes: class names are whitelisted and
  // line text is set via textContent, so nothing here can inject markup.
  const ALLOWED_TOKEN_CLASSES = ['k','s','c','f','n','t','p','o','d'];
  const frag = document.createDocumentFragment();
  f.lines.forEach((parts,i)=>{
    let text='', firstCls='';
    for(const p of parts){
      if(Array.isArray(p)){ if(!firstCls) firstCls=p[0]; text+=p[1]||''; }
      else if(typeof p==='string') text+=p;
    }
    const changed = state==='edited' && i>= f.lines.length-4;
    const line=document.createElement('div');
    line.className = changed ? 'line changed' : 'line';
    const ln=document.createElement('span'); ln.className='ln'; ln.textContent=String(i+1);
    const lc=document.createElement('span');
    lc.className = ALLOWED_TOKEN_CLASSES.indexOf(firstCls)>=0 ? 'lc '+firstCls : 'lc';
    lc.textContent = text;
    line.appendChild(ln); line.appendChild(lc);
    frag.appendChild(line);
  });
  codeEl.replaceChildren(frag);
  codeEl.scrollTop = 0;
}
function setInspSaved(file){
  const f = FILES[file];
  if(f) showInspector(file,'edited');
  inspBadge.textContent='saved';
  inspFile.textContent=file;
  inspOk.style.opacity='1'; inspStat.textContent=file;
}
function resetInspector(){
  inspEmpty.style.display='grid'; codeEl.style.display='none'; inspFoot.style.display='none';
  inspHead.classList.remove('s9'); inspFile.textContent='工作区空闲'; inspBadge.textContent='idle';
}
function esc(s){return String(s).replace(/[&<>"'`=]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;','=':'&#61;'}[c]))}

/* ---- DOM builders ---- */
function userMsg(text){
  const el=document.createElement('div'); el.className='msg user';
  // Role header is static markup; the user string is injected as a text node
  // only, so no crafted input can become markup.
  el.innerHTML=`<div class="msg-role"><span class="av"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>你</div>`;
  const bubble=document.createElement('div'); bubble.className='msg-bubble';
  bubble.textContent=text;
  el.appendChild(bubble);
  return el;
}
function assistantTurn(){
  const el=document.createElement('div'); el.className='msg assistant';
  el.innerHTML=`<div class="msg-role"><span class="av"><svg viewBox="0 0 1024 1024" fill="none" stroke="currentColor" stroke-width="120" stroke-linecap="round" stroke-linejoin="round"><path d="M462 236 L462 420 L624 420"/><path d="M276 732 L424 644 L356 512"/><path d="M540 676 L622 546 L786 640"/></svg></span>Trylo</div>`;
  const body=document.createElement('div'); body.className='msg-bubble'; el.appendChild(body);
  return {el,body};
}
function thinkingBlock(){
  const wrap=document.createElement('div'); wrap.className='think';
  wrap.innerHTML=`<div class="think-head"><span class="tw"><i></i><i></i><i></i></span><span class="lbl">思考流</span><span class="chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></div><div class="think-body"></div>`;
  wrap.querySelector('.think-head').addEventListener('click',()=>wrap.classList.toggle('collapsed'));
  return {wrap, body: wrap.querySelector('.think-body'), label: wrap.querySelector('.lbl')};
}
function toolsContainer(){
  const t=document.createElement('div'); t.className='tools'; return t;
}
function toolRow(kind, label, detail){
  const icons = {
    read:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
    edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    run:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 3 14 9-14 9z"/></svg>',
  };
  const row=document.createElement('div'); row.className='tool '+kind;
  // Static icon markup only. Every caller-supplied caption is written with
  // textContent / explicit element nodes, so nothing is HTML-parsed.
  row.innerHTML=`<div class="ic">${icons[kind]||''}</div><div class="t-main"><div class="t-cmd"></div></div><div class="status running">执行中</div>`;
  renderLabel(row.querySelector('.t-cmd'), label);
  if(detail){
    const d=document.createElement('div'); d.className='t-detail';
    d.textContent=detail;
    row.querySelector('.t-main').appendChild(d);
  }
  return row;
}
/* Renders "读取 <b>path</b>" style captions as real text + <b> nodes,
   never handing the string to an HTML parser. */
function renderLabel(target, label){
  String(label).split(/<b>([\s\S]*?)<\/b>/).forEach((part,i)=>{
    if(!part) return;
    if(i%2===1){ const b=document.createElement('b'); b.textContent=part; target.appendChild(b); }
    else target.appendChild(document.createTextNode(part));
  });
}
async function finishTool(row, ok=true, detail){
  const s=row.querySelector('.status'); s.className='status '+(ok?'done':'ok'); s.textContent= ok?'完成':'通过';
  if(detail){ const d=row.querySelector('.t-detail'); if(d) d.textContent=detail; }
  await sleep(260);
}

/* ---- scenarios ---- */
function pickScenario(text){
  const t=text.toLowerCase();
  if(/缓存|写时失效|87/.test(text)) return 'cache';
  if(/测试|test|单测/.test(text)) return 'tests';
  if(/技术栈|什么|项目结构|了解/.test(text)) return 'stack';
  if(/事件|总线|重构|架构/.test(text)) return 'events';
  if(mode==='chat') return 'chat-generic';
  return 'generic';
}

/* PLAN: events refactor */
async function runPlanEvents(body, prompt){
  const tb=thinkingBlock(); body.appendChild(tb.wrap);
  logo.classList.add('spin');
  await typeInto(tb.body, '读取项目结构… src/events/ 下只有 bus.ts：单例 + 全局回调数组，无类型约束，也没有 off/once。\n\n建议引入类型化 EventBus：新建 src/events/index.ts，提供 on/once/off/emit，on 返回取消函数；用事件名到 payload 类型的映射表约束事件；旧 bus.ts 保留为默认实例的 re-export，减少改动面。\n\n新增 1 个文件、修改 1 个文件，不影响现有调用。', 6);
  tb.label.textContent='思考完成'; tb.wrap.classList.add('collapsed');
  logo.classList.remove('spin');
  const final=document.createElement('div'); final.className='final'; body.appendChild(final);
  await typeInto(final, '我先想了一下，方案如下：\n\n**类型化事件总线**，新增 src/events/index.ts，旧 bus.ts 保留为默认实例的 re-export，调用方几乎不用改。', 10);
  const actions=document.createElement('div'); actions.className='plan-actions';
  actions.innerHTML=`<button class="plan-btn" id="implBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>一键实施</button><button class="plan-btn ghost">再想想</button>`;
  body.appendChild(actions);
  const impl=actions.querySelector('#implBtn');
  impl.addEventListener('click', async()=>{
    impl.disabled=true; actions.querySelector('.ghost').disabled=true;
    impl.textContent='执行中…';
    await runAgentEvents(body, true);
    actions.remove();
  });
}

/* AGENT: events refactor execution */
async function runAgentEvents(body, fromPlan){
  const tools=toolsContainer(); body.appendChild(tools);
  logo.classList.add('spin');
  let row;
  row=toolRow('read','读取 <b>src/events/bus.ts</b>'); tools.appendChild(row);
  showInspector('src/events/bus.ts','reading'); await sleep(650);
  await finishTool(row, true, '14 行 · 单例 Map，无类型约束');
  row=toolRow('edit','新建 <b>src/events/index.ts</b>','写入 EventBus 类（on/once/off/emit）'); tools.appendChild(row);
  showInspector('src/events/index.ts','writing'); await sleep(850);
  setInspSaved('src/events/index.ts'); await finishTool(row, true,'+28 行');
  row=toolRow('edit','修改 <b>src/events/bus.ts</b>','改为 re-export 默认实例'); tools.appendChild(row);
  showInspector('src/events/bus.ts','edited'); await sleep(650);
  setInspSaved('src/events/bus.ts'); await finishTool(row, true,'3 处改动');
  row=toolRow('run','<b>tsc --noEmit</b>'); tools.appendChild(row); await sleep(1000);
  await finishTool(row, true,'Found 0 errors');
  logo.classList.remove('spin');
  const final=document.createElement('div'); final.className='final'; body.appendChild(final);
  await typeInto(final, (fromPlan?'按方案实施完成。':'重构完成。')+' 新增了类型化 `EventBus`，旧的 `bus.ts` 现在只 re-export 默认实例，现有调用无需改动。`tsc --noEmit` 通过，0 个类型错误。', 12);
}

/* CHAT: cache explanation */
async function runChatCache(body){
  const tb=thinkingBlock(); body.appendChild(tb.wrap); logo.classList.add('spin');
  await typeInto(tb.body, '定位到 src/cache/store.ts 第 87 行：写入后调用 delete(key)，下次读取时回源重建。这是写时失效（write-invalidate），不是写时更新。');
  tb.label.textContent='思考完成'; tb.wrap.classList.add('collapsed'); logo.classList.remove('spin');
  const final=document.createElement('div'); final.className='final'; body.appendChild(final);
  await typeInto(final, '第 87 行用的是**写时失效（write-invalidate）**：写入数据后不主动更新缓存，而是 `delete(key)` 把旧值删掉，下一次读取时回源重建。\n\n这么做而不是写时更新，是因为多个地方可能写同一份数据，让缓存自己"猜"新值容易出错；删掉最简单，也一定不会脏。代价是写完后的第一次读取会慢一点（回源一次），之后又命中缓存。', 9);
}

/* AGENT: tests */
async function runAgentTests(body){
  const tools=toolsContainer(); body.appendChild(tools); logo.classList.add('spin');
  let row;
  row=toolRow('read','读取 <b>src/utils/date.ts</b>'); tools.appendChild(row);
  showInspector('package.json','reading'); await sleep(900);
  await finishTool(row,true,'formatRelative(delta)：刚刚 / 分钟 / 小时 / 日期');
  row=toolRow('edit','新建 <b>tests/date.test.ts</b>','覆盖 刚刚、分钟、跨天 三种情况'); tools.appendChild(row);
  showInspector('tests/date.test.ts','writing'); await sleep(1300);
  setInspSaved('tests/date.test.ts'); await finishTool(row,true,'+19 行');
  row=toolRow('run','<b>npx vitest run</b>'); tools.appendChild(row); await sleep(1900);
  await finishTool(row,true,'Test Files  1 passed (1)\n     Tests  3 passed (3)');
  logo.classList.remove('spin');
  const final=document.createElement('div'); final.className='final'; body.appendChild(final);
  await typeInto(final,'测试补好了，覆盖了刚刚、分钟、跨天三种相对时间。`vitest run` 全部通过：3 个用例，0 失败。',11);
}

/* AGENT: stack */
async function runStack(body){
  const tools=toolsContainer(); body.appendChild(tools); logo.classList.add('spin');
  let row;
  row=toolRow('read','读取 <b>package.json</b>'); tools.appendChild(row);
  showInspector('package.json','reading'); await sleep(900);
  await finishTool(row,true,'vite + typescript + @capacitor/core');
  row=toolRow('read','读取 <b>capacitor.config.ts</b>','tsconfig.json · vite.config.ts'); tools.appendChild(row); await sleep(1000);
  await finishTool(row,true,'appId: com.trylo.remote');
  logo.classList.remove('spin');
  const final=document.createElement('div'); final.className='final'; body.appendChild(final);
  await typeInto(final,'这是一个 **Vite + TypeScript** 的移动端工程，用 **Capacitor 8** 打包成 Android App（`com.trylo.remote`）。UI 层是 Ionic React，安全存储用 `@aparajita/capacitor-secure-storage`，走 Android Keystore。构建命令是 `npm run build && cap sync`。',10);
}

async function runGeneric(body, prompt){
  const tb=thinkingBlock(); body.appendChild(tb.wrap); logo.classList.add('spin');
  await typeInto(tb.body, `收到请求："${prompt}"。在真实环境里我会先搜索相关代码、读取关键文件，再决定是直接回答还是动手修改。演示环境里我先不执行实际改动，给你一个像样的回应节奏。`);
  tb.label.textContent='思考完成'; tb.wrap.classList.add('collapsed'); logo.classList.remove('spin');
  const final=document.createElement('div'); final.className='final'; body.appendChild(final);
  await typeInto(final,`我收到了："${prompt}"。\n\n这是网页演示，我没法真的改动你的文件——但在桌面端的 Trylo Code 里，我会先在侧边栏展开思考流，给出方案后等你确认，再一步步执行。可以试试上面的几个建议提示词，它们会触发完整的 Plan / Agent / Chat 流程。`,9);
}

/* ---- runner ---- */
const MAX_INPUT_CHARS = 2000;
async function run(text){
  if(busy) return;
  text = String(text).slice(0, MAX_INPUT_CHARS);
  busy=true;
  sendBtn.disabled=true; input.disabled=true;
  empty.style.display='none'; stream.style.display='flex';
  stream.parentElement.scrollTop=0;
  stream.appendChild(userMsg(text));
  const {el,body}=assistantTurn(); stream.appendChild(el);
  stream.parentElement.scrollTop = stream.parentElement.scrollHeight;
  resetInspector();
  try{
    const sc=pickScenario(text);
    if(mode==='plan' && sc==='events') await runPlanEvents(body,text);
    else if(mode==='chat' || sc==='cache') await runChatCache(body);
    else if(sc==='tests') await runAgentTests(body);
    else if(sc==='stack') await runStack(body);
    else if(sc==='events') await runAgentEvents(body,false);
    else await runGeneric(body,text);
  }catch(e){ console.error(e); showToast('执行出错：'+e.message); }
  busy=false; sendBtn.disabled=false; input.disabled=false; input.focus();
  stream.parentElement.scrollTop = stream.parentElement.scrollHeight;
}

/* ---- composer ---- */
function autosize(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,160)+'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); const v=input.value.trim(); if(v){ input.value=''; autosize(); run(v);} }
});
sendBtn.addEventListener('click', ()=>{ const v=input.value.trim(); if(v){input.value='';autosize();run(v);} });
document.querySelectorAll('.sugg').forEach(b=>b.addEventListener('click',()=>{ input.value=b.dataset.prompt; autosize(); run(b.dataset.prompt); input.value=''; autosize(); }));
$('#newChat').addEventListener('click',()=>{
  if(busy){showToast('Agent 正在工作，稍等…');return;}
  stream.replaceChildren(); stream.style.display='none'; empty.style.display='grid'; resetInspector();
});

/* ---- rail buttons: CSP-safe listeners, no inline handlers, no global exposure ---- */
document.querySelectorAll('.rail-btn[data-mode]').forEach(btn=>{
  btn.addEventListener('click',()=>setMode(btn.dataset.mode));
});
autosize();
