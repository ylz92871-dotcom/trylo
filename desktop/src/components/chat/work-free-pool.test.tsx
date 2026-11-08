import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ChatPanel, type ChatPanelProps } from './ChatPanel';
vi.mock('./AgentConversationSurface',()=>({AgentConversationSurface:(props:{bannerSlot?:ReactNode;emptyState?:ReactNode;composer?:ReactNode})=><>{props.bannerSlot}{props.emptyState}{props.composer}</>}));
vi.mock('../../account/use-platform-models',()=>({usePlatformModels:()=>({models:[{id:'Qwen3.8-Flash-Next',chat:true,pool:'free',remaining:1000}],loading:false,message:''})}));
afterEach(cleanup);
it('Work keeps account models without a personal API key and omits removed starter suggestions',()=>{
  const select=vi.fn();
  // The timeline/host is isolated; the real Work composer and model picker run.
  const ignore=vi.fn();
  const props:ChatPanelProps={topMode:'work',workspaceRoot:'D:/fixture',activeSession:null,workMessages:[],messages:[],workAttachments:[],attachments:[],workInput:'',text:'',workRunning:false,workError:false,hasApiKey:false,workCanSend:true,permissionLevel:'read_only',permissionSource:'settings',contextUsed:0,contextWindow:200000,model:'Qwen3.8-Flash-Next',configuredModel:'',poolModel:'Qwen3.8-Flash-Next',onSelectPool:select,onSelectConfigured:ignore,onWorkInputChange:ignore,onWorkSend:ignore,onCodeModeChange:ignore,onPermissionLevelChange:ignore,onCompact:ignore,onTextChange:ignore,onSend:ignore,
    context:{} as ChatPanelProps['context'],artifactHost:{} as ChatPanelProps['artifactHost'],codeMode:'agent',onApplyPlan:ignore,compacting:false,activeProcessId:null,onAddAttachment:ignore,onRemoveAttachment:ignore,attachmentLoading:0,failed:[],onDismissFailed:ignore,onAddWorkAttachment:ignore,onRemoveWorkAttachment:ignore,workAttachmentLoading:0,workFailed:[],onDismissWorkFailed:ignore,isDragging:false,editingMessageId:null,onEditMessage:ignore,onSaveEdit:ignore,onCancelEdit:ignore};
  render(<ChatPanel {...props}/>);
  expect(screen.getByRole('heading',{name:'今天，想完成什么？'})).toBeDefined();
  expect(screen.queryByRole('button',{name:'研究资料'})).toBeNull();
  expect(screen.queryByText(/配置 API Key/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Model: Qwen3.8-Flash-Next'}));
  fireEvent.click(screen.getByRole('option',{name:/Qwen3.8-Flash-Next.*Trylo 免费池/}));
  expect(select).toHaveBeenCalledWith('Qwen3.8-Flash-Next');
});
