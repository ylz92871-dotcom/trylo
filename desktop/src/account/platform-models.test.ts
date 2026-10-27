import { expect, it, vi } from 'vitest';
import { bindPlatformModels, readPlatformModels, platformModelConnection } from './platform-models';
import { ServiceManager } from '../services-host/service-manager';
import type { RelayModelCatalog } from '../services-host/methods';

it('coalesces simultaneous Work menu and context reads, but the next refresh sees fresh metadata', async () => {
  let resolveFirst!: (value: RelayModelCatalog) => void, resolveNext!: (value: RelayModelCatalog) => void;
  const firstReply=new Promise<RelayModelCatalog>(done=>{resolveFirst=done;}),nextReply=new Promise<RelayModelCatalog>(done=>{resolveNext=done;});
  const manager=new ServiceManager({invoke:async()=>undefined,listen:async()=>()=>{}});
  const request=vi.spyOn(manager.client,'request').mockResolvedValue({owner:'fixture',models:[]}).mockReturnValueOnce(firstReply).mockReturnValueOnce(nextReply);
  const dispose=bindPlatformModels(manager);
  try{
    const first=readPlatformModels(),second=readPlatformModels();expect(request).toHaveBeenCalledTimes(1);
    resolveFirst({owner:'fixture',models:[]});await Promise.all([first,second]);
    const next=readPlatformModels();expect(request).toHaveBeenCalledTimes(2);
    resolveNext({owner:'fixture',models:[{id:'text',chat:true,pool:'free',remaining:1000,contextLength:131072}]});
    expect((await next).models[0]?.contextLength).toBe(131072);
  }finally{dispose();}
});
it('an older running Service Host still supplies authoritative capacity through its model catalog',async()=>{
  const manager=new ServiceManager({invoke:async()=>undefined,listen:async()=>()=>{}});
  vi.spyOn(manager.client,'request').mockResolvedValueOnce({apiHost:'http://127.0.0.1:1234/v1',apiKey:'synthetic-capability',apiModel:'MiniCPM5-2B',providerId:'openai-compatible',apiFormat:'openai'}).mockResolvedValueOnce({owner:'fixture',models:[{id:'MiniCPM5-2B',chat:true,pool:'free',remaining:1000,contextLength:131072}]});
  const dispose=bindPlatformModels(manager);
  try{expect((await platformModelConnection('MiniCPM5-2B')).modelContextWindow).toBe(131072);}finally{dispose();}
});
