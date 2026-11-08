/** Versioned opaque algorithm facts. The Board owns sequence; domains decode their own payload schema. */
export type RewardV2FactKind = 'opportunity' | 'feedback' | 'preference' | 'projection' | 'learning_decision' | 'consolidation';

export interface RewardV2Draft {
  readonly id: string; readonly scope: string; readonly algorithmVersion: string;
  readonly kind: RewardV2FactKind; readonly payloadJson: string;
}

export interface RewardV2Fact extends RewardV2Draft { readonly sequence: number }

const KINDS: readonly string[]=['opportunity','feedback','preference','projection','learning_decision','consolidation'];
// All domain projections validate the same immutable JSON strings. Reusing
// only this generic representation check avoids parsing the entire lifetime
// ledger again for every projection; domain schemas and fact metadata still
// run at their existing boundaries. No identity, authority or outcome is cached.
const validPayloads = new Map<string, number>();
const PAYLOAD_MEMO_BYTES = 128 * 1024 * 1024;
let payloadMemoBytes = 0;

function validPayload(payload: string): boolean {
  const remembered = validPayloads.get(payload);
  if (remembered !== undefined) {
    validPayloads.delete(payload);
    validPayloads.set(payload, remembered);
    return true;
  }

  let body: unknown;

  try { body = JSON.parse(payload); } catch { return false; }

  if (typeof body !== 'object' || body === null || Array.isArray(body) || !json(body)) return false;

  const bytes = payload.length * 2;

  while (validPayloads.size >= 8192 || payloadMemoBytes + bytes > PAYLOAD_MEMO_BYTES) {
    const oldest = validPayloads.entries().next().value;
    if (oldest === undefined) break;
    validPayloads.delete(oldest[0]);
    payloadMemoBytes -= oldest[1];
  }

  validPayloads.set(payload, bytes);
  payloadMemoBytes += bytes;
  return true;
}

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
  return validPayload(row.payloadJson);
}

export function isRewardV2Fact(value: unknown): value is RewardV2Fact {
  return isRewardV2Draft(value)&&'sequence' in value&&Number.isSafeInteger(value.sequence)&&Number(value.sequence)>0;
}

export function validRewardV2Prefix(facts: readonly RewardV2Fact[],boardSequence: number): boolean {
  // Durable history is cumulative. Per-fact JSON/representation limits belong
  // to isRewardV2Draft; a valid lifetime prefix has no separate quota here.
  return new Set(facts.map(f=>f.id)).size===facts.length
    &&facts.every((f,i)=>f.sequence<=boardSequence&&(i===0||f.sequence>facts[i-1]!.sequence));
}
