import type { ReactElement } from 'react';

/** Settings entry for a CLI-backed conversation without a configured provider. */
export function ProviderSetupNotice(props: {
  readonly onOpenSettings?: () => void;
}): ReactElement {
  return (
    <div className="provider-notice" role="status">
      <div className="provider-notice__body">
        <strong className="provider-notice__title">尚未配置模型服务</strong>
        <p className="provider-notice__text">
          选择可用模型，或在设置中配置模型服务后开始对话。
        </p>
      </div>
      <button type="button" className="provider-notice__cta"
        onClick={props.onOpenSettings} disabled={!props.onOpenSettings}>
        打开设置
      </button>
    </div>
  );
}
