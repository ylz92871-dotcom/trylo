import { useCallback, useEffect, useRef, useState } from 'react';
import type { RelayTextModel } from '../services-host/methods';
import { readPlatformModels, subscribePlatformModels } from './platform-models';

export function usePlatformModels(open: boolean) {
  const [models, setModels] = useState<readonly RelayTextModel[]>([]);
  const [message, setMessage] = useState('登录 Trylo 账号后同步免费模型');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const scope = ++generation.current; setLoading(true);
    try {
      const data = await readPlatformModels();
      if (scope !== generation.current) return;
      const unique = new Map(data.models.filter(model => model.chat === true && model.pool === 'free').map(model => [model.id, model]));
      setModels([...unique.values()]); setMessage(unique.size ? '' : data.reason || '当前账号暂无模型授权，请在控制台查看');
    } catch (error) {
      if (scope !== generation.current) return;
      setModels([]); setMessage(error instanceof Error ? error.message : '模型同步失败，请重新打开菜单重试');
    } finally { if (scope === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    // Invalidate every in-flight catalogue read, including reads started after mount.
    const invalidate = () => { generation.current++; };
    const reset = () => { invalidate(); setModels([]); setMessage('正在同步账号模型…'); if (open) void refresh(); };
    const unsubscribe = subscribePlatformModels(reset);
    if (open) void refresh();
    const focus = () => { if (open) void refresh(); };
    window.addEventListener('focus', focus);
    const timer = open ? window.setInterval(() => { void refresh(); }, 45000) : undefined;
    return () => { invalidate(); unsubscribe(); window.removeEventListener('focus', focus); window.clearInterval(timer); };
  }, [open, refresh]);
  return { models, message, loading };
}
