import { Moon, Sun, Monitor } from 'lucide-react';
import { setAppearance, useAppearance, type Appearance } from '../../settings/appearance-store';

const options = [
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'dark', label: '深色', Icon: Moon },
  { value: 'system', label: '跟随系统', Icon: Monitor },
] as const;

export function AppearanceSettings(): JSX.Element {
  const { preference } = useAppearance();
  return <fieldset className="settings-modal__section">
    <legend>外观</legend>
    <p className="appearance__description">选择适合你的界面，设置会自动保存。</p>
    <div className="appearance__options" role="group" aria-label="界面主题">
      {options.map(({ value, label, Icon }) => <button key={value} type="button"
        className="appearance__option" aria-pressed={preference === value}
        onClick={() => setAppearance(value as Appearance)}><Icon size={22} /><span>{label}</span></button>)}
    </div>
    <p className="settings-modal__hint">开场标题使用 MiSans 字体（小米）。</p>
  </fieldset>;
}
