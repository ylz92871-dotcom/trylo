/** This runner shares the candidate's restricted child, never the trusted broker's powers. */
export const NPM_LIBRARY_RUNNER = String.raw`
const fs=require('node:fs');
const emit=value=>fs.writeSync(1,JSON.stringify(value)+'\n');
const json=(value,depth=0)=>depth<=32&&(value===null||typeof value==='string'||typeof value==='boolean'||
 (typeof value==='number'&&Number.isFinite(value))||
 (Array.isArray(value)?value.every(item=>json(item,depth+1)):typeof value==='object'&&Object.values(value).every(item=>json(item,depth+1))));
(async()=>{
 try{
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  const adapter=require('./__trylo_adapter__.cjs');
  if(typeof adapter!=='function')return emit({kind:'tool_error',code:'npm_adapter_export_required'});
  const value=await adapter(input);
  if(!json(value)||Buffer.byteLength(JSON.stringify(value))>32768)return emit({kind:'tool_error',code:'npm_adapter_invalid_result'});
  emit({kind:'value',value});
 }catch(error){emit({kind:'tool_error',code:typeof error?.code==='string'&&/^[a-zA-Z0-9_.-]{1,200}$/.test(error.code)?error.code:'npm_adapter_error'});}
})();
`;
