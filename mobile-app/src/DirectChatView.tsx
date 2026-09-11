import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonNote,
  IonRange,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToast,
  IonToggle,
  IonToolbar,
} from '@ionic/react';
import {
  addOutline,
  alertCircleOutline,
  attachOutline,
  chatbubbleEllipsesOutline,
  checkmarkOutline,
  closeOutline,
  createOutline,
  documentTextOutline,
  eyeOffOutline,
  eyeOutline,
  imageOutline,
  keyOutline,
  menuOutline,
  openOutline,
  paperPlane,
  refreshOutline,
  settingsOutline,
  sparklesOutline,
  stopCircleOutline,
  trashOutline,
} from 'ionicons/icons';
import {
  AttachmentStrip,
  BrandMark,
  EmptyState,
  MarkdownMessage,
  UiLanguage,
  formatBytes,
  formatChatTime,
  formatRecentTime,
  hasWideMarkdownBlock,
  uiText,
} from './ui';
import {
  DIRECT_PROVIDERS,
  DirectAttachment,
  DirectConfig,
  DirectConversation,
  DirectImageConfig,
  DirectMessage,
  MAX_ATTACHMENTS_PER_MESSAGE,
  PROVIDER_GROUP_LABELS,
  ProviderGroup,
  applyProviderConfig,
  buildAttachment,
  clearApiKey,
  clearImageApiKey,
  configComplete,
  createConversation,
  defaultConfig,
  defaultImageConfig,
  deriveTitle,
  generateImage,
  imageConfigComplete,
  loadApiKey,
  loadConfig,
  loadConversations,
  loadImageApiKey,
  loadImageConfig,
  looksLikeImageRequest,
  makeId,
  modelSupportsVision,
  persistConversations,
  saveApiKey,
  saveConfig,
  saveImageApiKey,
  saveImageConfig,
  streamChat,
  validateDirectConfig,
} from './directChat';

const SUGGESTIONS: Record<UiLanguage, string[]> = {
  zh: [
    '帮我写一封礼貌的请假邮件',
    '用通俗的话解释什么是递归',
    '给我一个高效的周计划模板',
    '帮我润色一段自我介绍',
  ],
  en: [
    'Draft a polite time-off request email',
    'Explain recursion in plain language',
    'Give me a focused weekly plan template',
    'Polish a short self-introduction',
  ],
};

function DirectChatView({ language }: { language: UiLanguage }) {
  const [conversations, setConversations] = useState<DirectConversation[]>([]);
  const [activeId, setActiveId] = useState('');
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<DirectAttachment[]>([]);
  const [processingAttachments, setProcessingAttachments] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [streaming, setStreaming] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<DirectConfig>(defaultConfig());
  const [apiKey, setApiKey] = useState('');
  const [imageConfig, setImageConfig] = useState<DirectImageConfig>(defaultImageConfig());
  const [imageApiKey, setImageApiKey] = useState('');
  const [toast, setToast] = useState<{ message: string; color?: string } | null>(null);
  const [viewerImage, setViewerImage] = useState<DirectAttachment | null>(null);
  // Diagnostics: shows exactly how many history messages each request carries.
  const [lastDebug, setLastDebug] = useState<{ rawCount: number; sentCount: number; roles: string[]; model: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  const activeConversation = useMemo(
    () => conversations.find(item => item.id === activeId) || null,
    [conversations, activeId],
  );
  const messages = activeConversation?.messages || [];

  useEffect(() => {
    const loadedConfig = loadConfig();
    setConfig(loadedConfig);
    void loadApiKey(loadedConfig.providerId).then(setApiKey);
    const loadedImageConfig = loadImageConfig();
    setImageConfig(loadedImageConfig);
    void loadImageApiKey().then(setImageApiKey);
    const stored = loadConversations();
    if (stored.length) {
      setConversations(stored);
      setActiveId(stored[0].id);
    }
    return () => { abortRef.current?.abort(); };
  }, []);

  // Only glue the view to the newest token while the reader is already at the
  // bottom, so scrolling back through a long answer is not yanked away.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, messages[messages.length - 1]?.text, activeId]);

  const patchConversation = (
    id: string,
    updater: (conversation: DirectConversation) => DirectConversation,
    persist = true,
  ) => {
    setConversations(current => {
      const next = current.map(item => (item.id === id ? updater(item) : item));
      if (persist) persistConversations(next);
      return next;
    });
  };

  const startNewChat = () => {
    if (streaming) return;
    const conversation = createConversation();
    setConversations(current => {
      const next = [conversation, ...current];
      persistConversations(next);
      return next;
    });
    setActiveId(conversation.id);
    setDrawerOpen(false);
    setComposer('');
  };

  const selectConversation = (id: string) => {
    if (streaming) return;
    setActiveId(id);
    setDrawerOpen(false);
  };

  const renameConversation = (id: string) => {
    const conversation = conversations.find(item => item.id === id);
    if (!conversation) return;
    const currentTitle = conversation.title || '';
    const value = window.prompt(uiText(language, '给这段对话起个名字', 'Name this conversation'), currentTitle);
    if (value === null) return;
    const title = value.trim();
    if (!title) return;
    patchConversation(id, item => ({ ...item, title }));
  };

  const deleteConversation = (id: string) => {
    setConversations(current => {
      const next = current.filter(item => item.id !== id);
      persistConversations(next);
      if (id === activeId) {
        setActiveId(next[0]?.id || '');
      }
      return next;
    });
  };

  const stopGeneration = () => {
    abortRef.current?.abort();
  };

  /**
   * Reads the files chosen through the hidden `<input type="file">`. Capacitor's
   * BridgeWebChromeClient implements onShowFileChooser, so this opens Android's
   * native picker (and camera) with no extra plugin.
   */
  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
    if (room <= 0) {
      setToast({
        message: uiText(language, `最多只能附带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个文件`, `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`),
        color: 'warning',
      });
      return;
    }
    setProcessingAttachments(true);
    const accepted: DirectAttachment[] = [];
    const failures: string[] = [];
    for (const file of Array.from(files).slice(0, room)) {
      try {
        accepted.push(await buildAttachment(file));
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : file.name);
      }
    }
    if (accepted.length) setAttachments(current => [...current, ...accepted]);
    if (failures.length) setToast({ message: failures[0], color: 'warning' });
    setProcessingAttachments(false);
  };

  const openPicker = (accept: string) => {
    const input = fileInputRef.current;
    if (!input) return;
    input.accept = accept;
    input.value = ''; // Allows re-picking the same file twice in a row.
    input.click();
  };

  const removeAttachment = (id: string) => {
    setAttachments(current => current.filter(item => item.id !== id));
  };

  /**
   * Re-sends the user turn that precedes a failed reply. Without this a network
   * blip forced the user to retype the whole message.
   */
  const retryMessage = (failedId: string) => {
    if (streaming) return;
    const index = messages.findIndex(message => message.id === failedId);
    if (index < 0) return;
    const priorUser = [...messages.slice(0, index)].reverse().find(message => message.role === 'user');
    if (!priorUser) return;
    const failed = messages[index];
    const forceImage = Boolean(failed.isImage);
    // Drop the failed reply *and* the original question, because send() appends
    // the question again; leaving it would duplicate it in the transcript.
    patchConversation(activeId, item => ({
      ...item,
      messages: item.messages.filter(message => message.id !== failedId && message.id !== priorUser.id),
    }));
    void send(priorUser.text, priorUser.attachments, [failedId, priorUser.id], forceImage ? { forceImage: true } : undefined);
  };

  const send = async (
    promptText?: string,
    replayAttachments?: DirectAttachment[],
    excludeIds?: string[],
    opts?: { forceImage?: boolean },
  ) => {
    const text = (promptText ?? composer).trim();
    // A retry replays the original attachments; a suggestion chip sends none.
    const outgoing = replayAttachments ?? (promptText ? [] : attachments);
    // An attachment on its own is a valid message (e.g. "what is this?" photo).
    if ((!text && !outgoing.length) || streaming) return;

    let conversationId = activeId;
    if (!conversationId) {
      const conversation = createConversation();
      conversationId = conversation.id;
      setConversations(current => {
        const next = [conversation, ...current];
        persistConversations(next);
        return next;
      });
      setActiveId(conversationId);
    }

    const userMessage: DirectMessage = {
      id: makeId('m'),
      role: 'user',
      text,
      at: Date.now(),
      status: 'done',
      attachments: outgoing.length ? outgoing : undefined,
    };
    const responseId = makeId('m');
    const assistantMessage: DirectMessage = { id: responseId, role: 'assistant', text: '', at: Date.now(), status: 'streaming' };

    patchConversation(conversationId, item => ({
      ...item,
      title: item.title || deriveTitle(text || uiText(language, '图片消息', 'Image message')),
      updatedAt: Date.now(),
      messages: [...item.messages, userMessage, assistantMessage],
    }));
    setComposer('');
    setAttachments([]);
    setStreaming(true);
    pinnedToBottomRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const imageReady = imageConfigComplete(imageConfig) && Boolean(imageApiKey.trim());
      const autoImage = imageConfig.mode === 'auto' && looksLikeImageRequest(text);
      const wantImage = Boolean(opts?.forceImage) || (autoImage && imageReady);

      if (wantImage) {
        if (!imageReady) {
          throw new Error(uiText(
            language,
            '生图功能还没配置好：请在「API 设置 → 生图」里填写生图 API 与 Key。',
            'Image generation is not set up: add the image API and key under API settings → Image generation.',
          ));
        }
        const result = await generateImage({
          config: imageConfig,
          apiKey: imageApiKey,
          prompt: text,
          signal: controller.signal,
        });
        const imageAttachment: DirectAttachment = {
          id: makeId('att'),
          kind: 'image',
          name: result.name,
          mimeType: 'image/png',
          size: Math.max(0, Math.round((result.dataUrl.length - 'data:image/png;base64,'.length) * 0.75)),
          dataUrl: result.dataUrl,
          sendData: result.dataUrl,
        };
        patchConversation(conversationId, item => ({
          ...item,
          updatedAt: Date.now(),
          messages: item.messages.map(message =>
            message.id === responseId
              ? {
                  ...message,
                  text: uiText(language, '已为你生成图片：', 'Here is your generated image:'),
                  status: 'done',
                  isImage: true,
                  attachments: [imageAttachment],
                }
              : message,
          ),
        }));
        return;
      }

      // On a retry the removed turns are still in this closure's `messages`,
      // so they are filtered out before building the request context.
      const priorMessages = excludeIds?.length
        ? messages.filter(message => !excludeIds.includes(message.id))
        : messages;
      const history = [...priorMessages, userMessage];
      const full = await streamChat({
        config,
        apiKey,
        messages: history,
        signal: controller.signal,
        onDebug: setLastDebug,
        onDelta: delta => {
          patchConversation(conversationId, item => ({
            ...item,
            updatedAt: Date.now(),
            messages: item.messages.map(message =>
              message.id === responseId ? { ...message, text: message.text + delta } : message,
            ),
          }), false);
        },
      });
      patchConversation(conversationId, item => ({
        ...item,
        updatedAt: Date.now(),
        messages: item.messages.map(message =>
          message.id === responseId ? { ...message, text: full || message.text, status: 'done' } : message,
        ),
      }));
    } catch (error) {
      if (controller.signal.aborted) {
        patchConversation(conversationId, item => ({
          ...item,
          messages: item.messages.map(message =>
            message.id === responseId
              ? { ...message, status: (message.text ? 'done' : 'error') as DirectMessage['status'] }
              : message,
          ).filter(message => message.id !== responseId || message.text),
        }));
        setToast({ message: uiText(language, '已停止生成', 'Generation stopped'), color: 'medium' });
      } else {
        // Keep the failed turn in place with its reason attached. Deleting it
        // (and relying on a 2s toast) made failures look like the app had
        // silently swallowed the question.
        const reason = error instanceof Error && error.message
          ? error.message
          : uiText(language, '发送失败，请检查网络或 API 设置。', 'Send failed. Check your network or API settings.');
        patchConversation(conversationId, item => ({
          ...item,
          messages: item.messages.map(message =>
            message.id === responseId
              ? { ...message, status: 'error' as DirectMessage['status'], error: reason }
              : message,
          ),
        }));
        setToast({ message: reason, color: 'danger' });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const needsSetup = !configComplete(config) || !apiKey.trim();
  const showWelcome = messages.length === 0;

  return (
    <>
      <div className="direct-chat">
        <div className="direct-chat-bar">
          <button type="button" className="direct-chat-bar__btn" aria-label={uiText(language, '会话列表', 'Conversations')} onClick={() => setDrawerOpen(true)}>
            <IonIcon icon={menuOutline} />
          </button>
          <div className="direct-chat-bar__title">
            <strong>{activeConversation?.title || uiText(language, '新对话', 'New chat')}</strong>
            <small>
              <span className="direct-provider-dot" />
              {config.model || uiText(language, '未配置模型', 'No model')}
            </small>
          </div>
          <div className="direct-chat-bar__actions">
            <button
              type="button"
              className={`direct-chat-bar__btn${needsSetup ? ' direct-chat-bar__btn--alert' : ''}`}
              aria-label={uiText(language, 'API 设置', 'API settings')}
              onClick={() => setSettingsOpen(true)}
            >
              <IonIcon icon={settingsOutline} />
            </button>
            <button type="button" className="direct-chat-bar__btn" aria-label={uiText(language, '新建对话', 'New chat')} onClick={startNewChat} disabled={streaming}>
              <IonIcon icon={addOutline} />
            </button>
          </div>
        </div>

        <div className="direct-message-list" ref={messagesRef}>
          {needsSetup ? (
            <div className="direct-setup-nudge">
              <EmptyState
                icon={keyOutline}
                title={uiText(language, '先连接你的 AI', 'Connect your AI first')}
                detail={uiText(language, '填写模型服务商和 API Key，聊天记录只保存在这台手机上。', 'Add a provider and API key. Conversations stay on this phone.')}
              />
              <IonButton expand="block" className="direct-setup-button" onClick={() => setSettingsOpen(true)}>
                <IonIcon slot="start" icon={settingsOutline} />
                {uiText(language, '打开 API 设置', 'Open API settings')}
              </IonButton>
            </div>
          ) : showWelcome ? (
            <div className="direct-welcome">
              <div className="direct-welcome__mark"><BrandMark small /></div>
              <h1>{uiText(language, '你好，我是 Trylo', 'Hi, I am Trylo')}</h1>
              <p>{uiText(language, '直连你自己的模型，随便聊点什么。', 'Connected straight to your own model. Ask me anything.')}</p>
              <div className="direct-suggestions">
                {SUGGESTIONS[language].map(suggestion => (
                  <button type="button" key={suggestion} onClick={() => void send(suggestion)} disabled={streaming}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="direct-messages">
              {messages.map(message => (
                <div className={`direct-message direct-message--${message.role}`} key={message.id}>
                  {message.role === 'assistant' && (
                    <span className="direct-message__avatar"><BrandMark small /></span>
                  )}
                  <div className={`direct-message__bubble${message.role === 'assistant' && hasWideMarkdownBlock(message.text) ? ' direct-message__bubble--wide' : ''}`}>
                    {message.attachments?.length ? (
                      <AttachmentStrip
                        attachments={message.attachments}
                        language={language}
                        onOpenImage={setViewerImage}
                      />
                    ) : null}
                    {message.text
                      ? <MarkdownMessage text={message.text} language={language} />
                      : message.status === 'error'
                        ? null
                        : (message.role === 'user' || message.attachments?.length)
                          ? null
                          : <span className="direct-typing"><i /><i /><i /></span>}
                    {message.status === 'error' && (
                      <div className="direct-message__failure">
                        <span className="direct-message__error">
                          <IonIcon icon={alertCircleOutline} />
                          {message.error || uiText(language, '回复失败', 'Reply failed')}
                        </span>
                        <button
                          type="button"
                          className="direct-retry-btn"
                          disabled={streaming}
                          onClick={() => retryMessage(message.id)}
                        >
                          <IonIcon icon={refreshOutline} />
                          {uiText(language, '重试', 'Retry')}
                        </button>
                      </div>
                    )}
                    <time>{message.status === 'streaming' ? uiText(language, '正在回复', 'Replying') : formatChatTime(message.at, language)}</time>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="direct-composer">
          {needsSetup ? (
            <IonButton expand="block" className="direct-composer-setup" onClick={() => setSettingsOpen(true)}>
              <IonIcon slot="start" icon={keyOutline} />{uiText(language, '配置 API 后开始聊天', 'Add your API key to start chatting')}
            </IonButton>
          ) : (
            <>
              {attachments.length > 0 && (
                <div className="direct-attach-tray">
                  {attachments.map(item => (
                    <div className={`direct-attach-chip direct-attach-chip--${item.kind}`} key={item.id}>
                      {item.kind === 'image' && item.dataUrl
                        ? <img src={item.dataUrl} alt={item.name} />
                        : <span className="direct-attach-chip__icon"><IonIcon icon={documentTextOutline} /></span>}
                      <span className="direct-attach-chip__meta">
                        <strong>{item.name}</strong>
                        <small>{formatBytes(item.size)}</small>
                      </span>
                      <button
                        type="button"
                        className="direct-attach-chip__remove"
                        aria-label={uiText(language, '移除附件', 'Remove attachment')}
                        onClick={() => removeAttachment(item.id)}
                      >
                        <IonIcon icon={closeOutline} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="direct-composer__row">
                <div className="direct-attach-actions">
                  <button
                    type="button"
                    className="direct-attach-btn"
                    aria-label={uiText(language, '添加图片', 'Add image')}
                    disabled={streaming || processingAttachments}
                    onClick={() => openPicker('image/*')}
                  >
                    <IonIcon icon={processingAttachments ? sparklesOutline : imageOutline} />
                  </button>
                  <button
                    type="button"
                    className="direct-attach-btn"
                    aria-label={uiText(language, '添加文件', 'Add file')}
                    disabled={streaming || processingAttachments}
                    onClick={() => openPicker('.txt,.md,.json,.csv,.log,.yml,.yaml,.ts,.tsx,.js,.jsx,.py,.java,.kt,.go,.rs,.c,.h,.cpp,.cs,.php,.rb,.swift,.sql,.sh,.ps1,.html,.css,.xml,text/*')}
                  >
                    <IonIcon icon={attachOutline} />
                  </button>
                  <button
                    type="button"
                    className="direct-attach-btn direct-attach-btn--gen"
                    aria-label={uiText(language, '生图', 'Generate image')}
                    disabled={streaming || !composer.trim()}
                    onClick={() => void send(undefined, undefined, undefined, { forceImage: true })}
                  >
                    <IonIcon icon={sparklesOutline} />
                  </button>
                </div>
                <IonTextarea
                  value={composer}
                  autoGrow
                  rows={1}
                  maxlength={4000}
                  enterkeyhint="send"
                  disabled={streaming}
                  placeholder={streaming
                    ? uiText(language, '正在回复…', 'Replying…')
                    : uiText(language, '给 Trylo 发消息…', 'Message Trylo…')}
                  onIonInput={event => setComposer(String(event.detail.value || ''))}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                {streaming ? (
                  <IonButton
                    shape="round"
                    color="danger"
                    className="direct-stop-round"
                    aria-label={uiText(language, '停止生成', 'Stop generating')}
                    onClick={stopGeneration}
                  >
                    <IonIcon slot="icon-only" icon={stopCircleOutline} />
                  </IonButton>
                ) : (
                  <IonButton
                    shape="round"
                    aria-label={uiText(language, '发送', 'Send')}
                    disabled={!composer.trim() && !attachments.length}
                    onClick={() => void send()}
                  >
                    <IonIcon slot="icon-only" icon={paperPlane} />
                  </IonButton>
                )}
              </div>
            </>
          )}
          <p className="direct-composer__hint">{uiText(language, '手机直连模型服务商，对话仅保存在本机', 'Connects directly to the provider; chats stay on this device')}</p>
          {lastDebug && (
            <p className="direct-composer__debug">
              {uiText(language, `上下文调试：本请求发送 ${lastDebug.sentCount} 条（原始 ${lastDebug.rawCount} 条）· 角色 ${lastDebug.roles.join('→')} · 模型 ${lastDebug.model}`, `Context debug: sent ${lastDebug.sentCount} (raw ${lastDebug.rawCount}) · roles ${lastDebug.roles.join('→')} · ${lastDebug.model}`)}
            </p>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        onChange={event => void pickFiles(event.target.files)}
      />

      <DirectOverlays>
        <DirectDrawer
          language={language}
          open={drawerOpen}
          conversations={conversations}
          activeId={activeId}
          onDismiss={() => setDrawerOpen(false)}
          onNew={startNewChat}
          onSelect={selectConversation}
          onRename={renameConversation}
          onDelete={deleteConversation}
          onOpenSettings={() => { setDrawerOpen(false); setSettingsOpen(true); }}
        />

        <DirectSettingsModal
          language={language}
          open={settingsOpen}
          config={config}
          apiKey={apiKey}
          imageConfig={imageConfig}
          imageApiKey={imageApiKey}
          onDismiss={() => setSettingsOpen(false)}
          onSave={async (nextConfig, nextApiKey) => {
            if (nextApiKey.trim()) await saveApiKey(nextConfig.providerId, nextApiKey);
            else await clearApiKey(nextConfig.providerId);
            saveConfig(nextConfig);
            const savedConfig = loadConfig();
            setConfig(savedConfig);
            setApiKey(nextApiKey.trim());
            setSettingsOpen(false);
            setToast({ message: uiText(language, '模型设置已保存', 'Model settings saved'), color: 'success' });
          }}
          onSaveImage={async (nextImageConfig, nextImageKey) => {
            if (nextImageKey.trim()) await saveImageApiKey(nextImageKey);
            else await clearImageApiKey();
            saveImageConfig(nextImageConfig);
            setImageConfig(loadImageConfig());
            setImageApiKey(nextImageKey.trim());
          }}
        />

        <IonToast
          isOpen={Boolean(toast)}
          message={toast?.message}
          color={toast?.color}
          duration={2600}
          position="top"
          onDidDismiss={() => setToast(null)}
        />

        {/* Tapping a thumbnail opens the image full-screen. Lives inside the
            overlay host so it gets a real viewport-sized containing block. */}
        <IonModal
          isOpen={Boolean(viewerImage)}
          onDidDismiss={() => setViewerImage(null)}
          className="direct-image-viewer"
        >
          <div className="direct-image-viewer__body">
            {viewerImage?.dataUrl && (
              <img src={viewerImage.dataUrl} alt={viewerImage.name} />
            )}
            <button
              type="button"
              className="direct-image-viewer__close"
              aria-label={uiText(language, '关闭', 'Close')}
              onClick={() => setViewerImage(null)}
            >
              <IonIcon icon={closeOutline} />
            </button>
            <p className="direct-image-viewer__note">
              {uiText(language, '历史记录中只保留缩略图，因此这里画质较低。', 'History keeps a thumbnail only, so this preview is low-res.')}
            </p>
          </div>
        </IonModal>
      </DirectOverlays>
    </>
  );
}

/**
 * Ionic overlays must not live inside the chat's scrolling `ion-content`: that
 * element establishes its own containing block, which shifts the fixed-position
 * modal and leaves its controls outside the tappable area. This portal
 * re-parents them next to Ionic's own overlay root (`ion-app`, matching
 * `getAppRoot()` in @ionic/core) so sizing and stacking behave normally.
 */
function DirectOverlays({ children }: { children: React.ReactNode }) {
  const [host] = useState(() => (typeof document === 'undefined' ? null : document.createElement('div')));

  useEffect(() => {
    if (!host) return;
    host.className = 'direct-overlay-host';
    const root = document.querySelector('ion-app') || document.body;
    root.appendChild(host);
    return () => { host.remove(); };
  }, [host]);

  if (!host) return null;
  return createPortal(children, host);
}

function DirectDrawer({
  language,
  open,
  conversations,
  activeId,
  onDismiss,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onOpenSettings,
}: {
  language: UiLanguage;
  open: boolean;
  conversations: DirectConversation[];
  activeId: string;
  onDismiss: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}) {
  return (
    <IonModal isOpen={open} onDidDismiss={onDismiss} className="direct-drawer-modal">
      <IonHeader>
        <IonToolbar>
          <IonTitle>{uiText(language, '对话记录', 'Conversations')}</IonTitle>
          <IonButtons slot="end"><IonButton onClick={onDismiss}>{uiText(language, '完成', 'Done')}</IonButton></IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="direct-drawer-content">
        <div className="direct-drawer-actions">
          <button type="button" onClick={onNew}>
            <IonIcon icon={addOutline} />{uiText(language, '新建对话', 'New chat')}
          </button>
          <button type="button" onClick={onOpenSettings}>
            <IonIcon icon={settingsOutline} />{uiText(language, 'API 设置', 'API settings')}
          </button>
        </div>
        {conversations.length === 0 ? (
          <EmptyState
            icon={chatbubbleEllipsesOutline}
            title={uiText(language, '还没有对话', 'No conversations yet')}
            detail={uiText(language, '发送第一条消息后会自动出现在这里。', 'Your first message will start a new conversation here.')}
          />
        ) : (
          <IonList className="direct-conversation-list" lines="none">
            {conversations.map(conversation => (
              <IonItem button detail={false} key={conversation.id} className={conversation.id === activeId ? 'direct-conversation--active' : ''} onClick={() => onSelect(conversation.id)}>
                <div className="direct-conversation-icon" slot="start"><IonIcon icon={chatbubbleEllipsesOutline} /></div>
                <div className="direct-conversation-copy">
                  <strong>{conversation.title || uiText(language, '新对话', 'New chat')}</strong>
                  <small>
                    {conversation.messages.length} {uiText(language, '条消息', 'messages')} · {formatRecentTime(conversation.updatedAt, language)}
                  </small>
                </div>
                <div className="direct-conversation-ops" slot="end">
                  <button type="button" aria-label={uiText(language, '重命名', 'Rename')} onClick={event => { event.stopPropagation(); onRename(conversation.id); }}>
                    <IonIcon icon={createOutline} />
                  </button>
                  <button type="button" aria-label={uiText(language, '删除', 'Delete')} onClick={event => { event.stopPropagation(); onDelete(conversation.id); }}>
                    <IonIcon icon={trashOutline} />
                  </button>
                </div>
              </IonItem>
            ))}
          </IonList>
        )}
      </IonContent>
    </IonModal>
  );
}

function DirectSettingsModal({
  language,
  open,
  config,
  apiKey,
  imageConfig,
  imageApiKey,
  onDismiss,
  onSave,
  onSaveImage,
}: {
  language: UiLanguage;
  open: boolean;
  config: DirectConfig;
  apiKey: string;
  imageConfig: DirectImageConfig;
  imageApiKey: string;
  onDismiss: () => void;
  onSave: (config: DirectConfig, apiKey: string) => Promise<void>;
  onSaveImage: (config: DirectImageConfig, apiKey: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DirectConfig>(config);
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingKey, setLoadingKey] = useState(false);
  const [imageDraft, setImageDraft] = useState<DirectImageConfig>(imageConfig);
  const [imageKeyDraft, setImageKeyDraft] = useState(imageApiKey);
  const [showImageKey, setShowImageKey] = useState(false);
  const keyRequestRef = useRef(0);

  useEffect(() => {
    if (open) {
      setDraft(config);
      setKeyDraft(apiKey);
      setError('');
      setShowKey(false);
      setSaving(false);
      setLoadingKey(false);
      setImageDraft(imageConfig);
      setImageKeyDraft(imageApiKey);
      setShowImageKey(false);
    }
  }, [open, config, apiKey, imageConfig, imageApiKey]);

  // Fall back to the OpenAI-compatible custom entry by id, not by array
  // position, so reordering the provider list cannot change the fallback.
  const provider = DIRECT_PROVIDERS.find(item => item.id === draft.providerId)
    || DIRECT_PROVIDERS.find(item => item.id === 'custom')
    || DIRECT_PROVIDERS[0];
  const keyConfigured = Boolean(keyDraft.trim());
  const visionReady = modelSupportsVision(draft);

  const changeProvider = async (providerId: string) => {
    const requestId = ++keyRequestRef.current;
    setDraft(current => applyProviderConfig(current, providerId));
    setKeyDraft('');
    setError('');
    setLoadingKey(true);
    const providerKey = await loadApiKey(providerId);
    if (requestId === keyRequestRef.current) {
      setKeyDraft(providerKey);
      setLoadingKey(false);
    }
  };

  const save = async () => {
    try {
      validateDirectConfig(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uiText(language, '模型设置无效', 'Invalid model settings'));
      return;
    }
    if (!keyDraft.trim() && !keyConfigured) {
      setError(uiText(language, '请填写 API Key', 'API key is required'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(draft, keyDraft.trim());
      await onSaveImage(imageDraft, imageKeyDraft.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uiText(language, '保存失败', 'Unable to save'));
      setSaving(false);
    }
  };

  return (
    <IonModal isOpen={open} onDidDismiss={onDismiss} className="direct-settings-modal">
      <IonHeader>
        <IonToolbar>
          <IonTitle>{uiText(language, 'API 设置', 'API settings')}</IonTitle>
          <IonButtons slot="start"><IonButton onClick={onDismiss}>{uiText(language, '取消', 'Cancel')}</IonButton></IonButtons>
          <IonButtons slot="end"><IonButton strong disabled={saving || loadingKey} onClick={() => void save()}>{saving ? <IonSpinner name="crescent" /> : uiText(language, '保存', 'Save')}</IonButton></IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="direct-settings-content">
        <section className="direct-settings-card">
          <span className="eyebrow">PROVIDER</span>
          <h3>{uiText(language, '模型服务商', 'Provider')}</h3>
          <IonSelect
            interface="action-sheet"
            interfaceOptions={{
              cssClass: 'direct-provider-sheet',
              header: uiText(language, '选择模型服务商', 'Choose a provider'),
            }}
            aria-label={uiText(language, '模型服务商', 'Provider')}
            value={draft.providerId}
            onIonChange={event => void changeProvider(String(event.detail.value))}
          >
            {/* Sorted by region so related vendors sit together; the region name
                is prefixed onto each label because Ionic's action sheet has no
                group headers and disabled divider rows render unreadably dim. */}
            {(['cn', 'global', 'custom'] as ProviderGroup[]).flatMap(group =>
              DIRECT_PROVIDERS.filter(item => item.group === group).map(item => (
                <IonSelectOption key={item.id} value={item.id}>
                  {`${uiText(language, PROVIDER_GROUP_LABELS[group].zh, PROVIDER_GROUP_LABELS[group].en)} · ${item.label}`}
                </IonSelectOption>
              )),
            )}
          </IonSelect>
          {provider.docs && (
            <a className="direct-settings-link" href={provider.docs} target="_blank" rel="noreferrer">
              <IonIcon icon={openOutline} />
              {uiText(language, '打开控制台获取 API Key', 'Open console to get an API key')}
            </a>
          )}
        </section>

        <section className="direct-settings-card">
          <IonInput
            label={uiText(language, 'API 地址', 'Endpoint')}
            labelPlacement="stacked"
            value={draft.endpoint}
            placeholder={provider.endpoint || 'https://api.example.com/v1'}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            inputmode="url"
            onIonInput={event => setDraft({ ...draft, endpoint: String(event.detail.value || '') })}
          />
          <div className="direct-settings-row">
            <p className="direct-settings-hint">
              {uiText(
                language,
                '可改成自建代理或其他区域地址（需 HTTPS，不含 /chat/completions）。',
                'Point this at a proxy or regional host (HTTPS, without /chat/completions).',
              )}
            </p>
            {provider.endpoint && draft.endpoint !== provider.endpoint && (
              <button
                type="button"
                className="direct-settings-reset"
                onClick={() => setDraft({ ...draft, endpoint: provider.endpoint })}
              >
                {uiText(language, '恢复默认', 'Reset')}
              </button>
            )}
          </div>
          <IonInput
            label={uiText(language, '模型名称', 'Model')}
            labelPlacement="stacked"
            value={draft.model}
            placeholder={provider.model || 'model-name'}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            onIonInput={event => setDraft({ ...draft, model: String(event.detail.value || '') })}
          />
          {provider.models?.length ? (
            <div className="direct-model-picker">
              <p className="direct-model-picker__title">
                {uiText(language, '常用模型（点击填入，也可手动输入任意模型）', 'Common models (tap to fill, or type any id)')}
              </p>
              <div className="direct-model-chips">
                {provider.models.map(preset => (
                  <button
                    type="button"
                    key={preset.id}
                    className={`direct-model-chip${draft.model === preset.id ? ' is-active' : ''}`}
                    onClick={() => setDraft({ ...draft, model: preset.id })}
                  >
                    <span className="direct-model-chip__id">{preset.id}</span>
                    <span className="direct-model-chip__note">
                      {preset.vision && <IonIcon icon={imageOutline} />}
                      {preset.note}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {visionReady && (
            <p className="direct-settings-hint direct-settings-hint--ok">
              <IonIcon icon={imageOutline} />
              {uiText(language, '当前模型支持图片，可以在聊天里上传图片。', 'This model accepts images; you can attach photos in chat.')}
            </p>
          )}
        </section>

        <section className="direct-settings-card">
          <IonInput
            label={uiText(language, 'API Key', 'API key')}
            labelPlacement="stacked"
            type={showKey ? 'text' : 'password'}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            value={keyDraft}
            disabled={loadingKey}
            placeholder={loadingKey ? uiText(language, '正在读取安全存储…', 'Loading secure storage…') : 'sk-...'}
            onIonInput={event => setKeyDraft(String(event.detail.value || ''))}
          />
          <button
            type="button"
            className="direct-key-toggle"
            onClick={() => setShowKey(value => !value)}
          >
            <IonIcon icon={showKey ? eyeOffOutline : eyeOutline} />
            {showKey ? uiText(language, '隐藏 Key', 'Hide key') : uiText(language, '显示 Key', 'Show key')}
          </button>
          <p className="direct-settings-hint">
            <IonIcon icon={checkmarkOutline} />
            {uiText(language, 'Key 保存在 Android Keystore（系统安全存储），普通对话记录只写入本机。', 'Keys live in Android Keystore; conversation history stays on this device.')}
          </p>
        </section>

        <section className="direct-settings-card">
          <div className="direct-settings-heading">
            <h3>{uiText(language, '生图（图片生成）', 'Image generation')}</h3>
          </div>
          <IonToggle
            checked={imageDraft.enabled}
            onIonChange={event => setImageDraft({ ...imageDraft, enabled: Boolean(event.detail.checked) })}
            labelPlacement="start"
          >
            {uiText(language, '启用生图功能', 'Enable image generation')}
          </IonToggle>
          {imageDraft.enabled && (
            <>
              <IonInput
                label={uiText(language, '生图 API 地址', 'Image API endpoint')}
                labelPlacement="stacked"
                value={imageDraft.endpoint}
                placeholder="https://api.openai.com/v1"
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                inputmode="url"
                onIonInput={event => setImageDraft({ ...imageDraft, endpoint: String(event.detail.value || '') })}
              />
              <IonInput
                label={uiText(language, '生图模型', 'Image model')}
                labelPlacement="stacked"
                value={imageDraft.model}
                placeholder="gpt-image-1"
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                onIonInput={event => setImageDraft({ ...imageDraft, model: String(event.detail.value || '') })}
              />
              <IonSelect
                label={uiText(language, '图片尺寸', 'Size')}
                interface="action-sheet"
                value={imageDraft.size}
                onIonChange={event => setImageDraft({ ...imageDraft, size: String(event.detail.value) })}
              >
                <IonSelectOption value="1024x1024">1024 × 1024</IonSelectOption>
                <IonSelectOption value="1792x1024">{uiText(language, '横版 1792 × 1024', 'Landscape 1792 × 1024')}</IonSelectOption>
                <IonSelectOption value="1024x1792">{uiText(language, '竖版 1024 × 1792', 'Portrait 1024 × 1792')}</IonSelectOption>
              </IonSelect>
              <IonSelect
                label={uiText(language, '触发方式', 'Trigger')}
                interface="action-sheet"
                value={imageDraft.mode}
                onIonChange={event => setImageDraft({ ...imageDraft, mode: event.detail.value === 'auto' ? 'auto' : 'manual' })}
              >
                <IonSelectOption value="manual">{uiText(language, '手动（点生图按钮）', 'Manual (tap Generate)')}</IonSelectOption>
                <IonSelectOption value="auto">{uiText(language, '自动（按内容判断）', 'Auto (by intent)')}</IonSelectOption>
              </IonSelect>
              <IonInput
                label={uiText(language, '生图 API Key', 'Image API key')}
                labelPlacement="stacked"
                type={showImageKey ? 'text' : 'password'}
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                value={imageKeyDraft}
                placeholder="sk-..."
                onIonInput={event => setImageKeyDraft(String(event.detail.value || ''))}
              />
              <button
                type="button"
                className="direct-key-toggle"
                onClick={() => setShowImageKey(value => !value)}
              >
                <IonIcon icon={showImageKey ? eyeOffOutline : eyeOutline} />
                {showImageKey ? uiText(language, '隐藏 Key', 'Hide key') : uiText(language, '显示 Key', 'Show key')}
              </button>
              <p className="direct-settings-hint">
                <IonIcon icon={imageOutline} />
                {uiText(language, '使用 OpenAI 兼容的图片接口（/images/generations），可与聊天模型用不同服务商。', 'Uses an OpenAI-compatible image API (/images/generations); can be a different provider than chat.')}
              </p>
            </>
          )}
        </section>

        <section className="direct-settings-card">
          <div className="direct-settings-heading">
            <h3>{uiText(language, '创造性', 'Creativity')}</h3>
            <strong>{draft.temperature.toFixed(1)}</strong>
          </div>
          <IonRange min={0} max={1.2} step={0.1} snaps value={draft.temperature} onIonInput={event => setDraft({ ...draft, temperature: Number(event.detail.value) })} />
          <div className="direct-settings-range-labels">
            <span>{uiText(language, '严谨', 'Focused')}</span>
            <span>{uiText(language, '发散', 'Creative')}</span>
          </div>
        </section>

        <section className="direct-settings-card">
          <IonTextarea
            label={uiText(language, '系统提示词', 'System prompt')}
            labelPlacement="stacked"
            value={draft.systemPrompt}
            autoGrow
            rows={4}
            maxlength={4000}
            onIonInput={event => setDraft({ ...draft, systemPrompt: String(event.detail.value || '') })}
          />
        </section>

        {error && <p className="direct-settings-error">{error}</p>}
        <IonButton
          expand="block"
          className="direct-settings-save"
          disabled={saving || loadingKey}
          onClick={() => void save()}
        >
          {saving
            ? <IonSpinner name="crescent" />
            : <>
                <IonIcon slot="start" icon={checkmarkOutline} />
                {uiText(language, '保存设置', 'Save settings')}
              </>}
        </IonButton>
        <IonNote className="direct-settings-footnote">
          {uiText(language, '直连模式不经过你的电脑，请求直接从手机发送到所选服务商。', 'Direct mode does not route through your computer; requests go straight from this phone to the provider.')}
        </IonNote>
      </IonContent>
    </IonModal>
  );
}

export default DirectChatView;
