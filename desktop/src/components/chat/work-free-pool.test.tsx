import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ChatPanel, type ChatPanelProps } from './ChatPanel';
vi.mock('./AgentConversationSurface',()=>({AgentConversationSurface:(props:{bannerSlot?:ReactNode;starterSlot?:ReactNode;composer?:ReactNode})=><>{props.bannerSlot}{props.starterSlot}{props.composer}</>}));
vi.mock('../../account/use-platform-models',()=>({usePlatformModels:()=>({models:[{id:'Qwen3.8-Flash-Next',chat:true,pool:'free',remaining:1000}],loading:false,message:''})}));
afterEach(cleanup);
it('Work lists account models and starters without requiring a personal API key',()=>{
  const select=vi.fn();
  // The timeline/host is isolated; the real Work composer and model picker run.
  const ignore=vi.fn();
  const props:ChatPanelProps={topMode:'work',workspaceRoot:'D:/fixture',activeSession:null,workMessages:[],messages:[],workAttachments:[],attachments:[],workInput:'',text:'',workRunning:false,workError:false,hasApiKey:false,workCanSend:true,permissionLevel:'read_only',permissionSource:'settings',contextUsed:0,contextWindow:200000,model:'Qwen3.8-Flash-Next',configuredModel:'',poolModel:'Qwen3.8-Flash-Next',onSelectPool:select,onSelectConfigured:ignore,onWorkInputChange:ignore,onWorkSend:ignore,onCodeModeChange:ignore,onPermissionLevelChange:ignore,onCompact:ignore,onTextChange:ignore,onSend:ignore,
    context:{} as ChatPanelProps['context'],artifactHost:{} as ChatPanelProps['artifactHost'],codeMode:'agent',onApplyPlan:ignore,compacting:false,activeProcessId:null,onAddAttachment:ignore,onRemoveAttachment:ignore,attachmentLoading:0,failed:[],onDismissFailed:ignore,onAddWorkAttachment:ignore,onRemoveWorkAttachment:ignore,workAttachmentLoading:0,workFailed:[],onDismissWorkFailed:ignore,isDragging:false,editingMessageId:null,onEditMessage:ignore,onSaveEdit:ignore,onCancelEdit:ignore};
  render(<ChatPanel {...props}/>);
  expect(screen.getByRole('button',{name:'研究资料'})).toBeDefined();
  expect(screen.queryByText(/配置 API Key/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Model: Qwen3.8-Flash-Next'}));
  fireEvent.click(screen.getByRole('option',{name:/Qwen3.8-Flash-Next.*Trylo 免费池/}));
  expect(select).toHaveBeenCalledWith('Qwen3.8-Flash-Next');
});
