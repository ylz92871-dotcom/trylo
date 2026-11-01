/** Versioned opaque algorithm facts. The Board owns sequence; domains decode their own payload schema. */
export type RewardV2FactKind = 'opportunity' | 'feedback' | 'preference' | 'projection' | 'learning_decision' | 'consolidation';
export interface RewardV2Draft {
  readonly id: string; readonly scope: string; readonly algorithmVersion: string;
  readonly kind: RewardV2FactKind; readonly payloadJson: string;
}
export interface RewardV2Fact extends RewardV2Draft { readonly sequence: number }
export const MAX_REWARD_V2_FACTS=16384;
const KINDS: readonly string[]=['opportunity','feedback','preference','projection','learning_decision','consolidation'];
function json(value: unknown,depth=0): boolean {
  if(depth>32)return false;
  if(value===null||typeof value==='string'||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.length<=16384&&value.every(item=>json(item,depth+1));
  return typeof value==='object'&&value!==null&&Object.values(value).every(item=>json(item,depth+1));
}
export function isRewardV2Draft(value: unknown): value is RewardV2Draft {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const row=value as Record<string,unknown>;
  for(const key of ['id','scope','algorithmVersion'])if(typeof row[key]!=='string'||!row[key]||row[key].length>256)return false;
  if(typeof row.kind!=='string'||!KINDS.includes(row.kind)||typeof row.payloadJson!=='string'||row.payloadJson.length>131072)return false;
  try {const body: unknown=JSON.parse(row.payloadJson);return typeof body==='object'&&body!==null&&!Array.isArray(body)&&json(body);}
  catch {return false;}
}
export function isRewardV2Fact(value: unknown): value is RewardV2Fact {
  return isRewardV2Draft(value)&&'sequence' in value&&Number.isSafeInteger(value.sequence)&&Number(value.sequence)>0;
}
export function validRewardV2Prefix(facts: readonly RewardV2Fact[],boardSequence: number): boolean {
  return facts.length<=MAX_REWARD_V2_FACTS&&new Set(facts.map(f=>f.id)).size===facts.length
    &&facts.every((f,i)=>f.sequence<=boardSequence&&(i===0||f.sequence>facts[i-1]!.sequence))
    &&facts.reduce((n,f)=>n+f.payloadJson.length,0)<=16*1024*1024;
}
