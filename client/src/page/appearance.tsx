import { useContext, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { AppearanceContext, AppearanceSettings } from '../state/appearance';
import { ProfileContext } from '../state/profile';
import { client } from '../main';
import { headersWithAuth } from '../utils/auth';
import { ButtonWithLoading } from '../components/button';

type SettingKey = keyof AppearanceSettings;

const controls: Array<{
  key: SettingKey;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  { key: 'backgroundBlur', label: '背景模糊', description: '轻轻柔化背景，不影响内容清晰度。', min: 0, max: 16, step: 1, format: value => `${value}px` },
  { key: 'backgroundBrightness', label: '背景亮度', description: '调整背景光感，夜间阅读也更舒适。', min: 0.55, max: 1.45, step: 0.05, format: value => `${Math.round(value * 100)}%` },
  { key: 'backgroundSaturation', label: '背景饱和度', description: '控制画面的色彩浓淡。', min: 0.5, max: 1.8, step: 0.05, format: value => `${Math.round(value * 100)}%` },
  { key: 'glassOpacity', label: '玻璃不透明度', description: '数值越低，背景的呼吸感越明显。', min: 0.12, max: 0.9, step: 0.02, format: value => `${Math.round(value * 100)}%` },
  { key: 'glassBlur', label: '玻璃模糊', description: '让内容卡片与背景更自然地分层。', min: 0, max: 36, step: 1, format: value => `${value}px` },
];

export function AppearancePage() {
  const profile = useContext(ProfileContext);
  const appearance = useContext(AppearanceContext);
  const [draft, setDraft] = useState<AppearanceSettings>(appearance.settings);
  const [saving, setSaving] = useState<'personal' | 'default' | 'reset' | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setDraft(appearance.settings);
  }, [appearance.settings]);

  // A slider previews immediately. Clear an unsaved preview only when this
  // page closes, not on every context re-render.
  useEffect(() => () => appearance.setPreview(null), []);

  const update = (key: SettingKey, value: number) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    appearance.setPreview(next);
    setMessage('');
  };

  if (!profile) {
    return (
      <main className="appearance-page">
        <section className="appearance-panel appearance-empty">
          <p className="appearance-kicker">APPEARANCE</p>
          <h1>登录后即可保存外观</h1>
          <p>背景与玻璃效果可按你的设备和阅读习惯独立保存。</p>
          <Link className="appearance-link" href="/">返回首页</Link>
        </section>
      </main>
    );
  }

  const savePersonal = async () => {
    setSaving('personal');
    setMessage('');
    const { data, error } = await client.appearance.index.put(draft, { headers: headersWithAuth() });
    setSaving(null);
    if (error || !data || typeof data === 'string') {
      setMessage('保存失败，请稍后重试。');
      return;
    }
    appearance.savePersonal(data.settings);
    setMessage('已保存为你的外观偏好。');
  };

  const resetPersonal = async () => {
    setSaving('reset');
    setMessage('');
    const { error } = await client.appearance.index.delete({ headers: headersWithAuth() });
    setSaving(null);
    if (error) {
      setMessage('恢复默认失败，请稍后重试。');
      return;
    }
    setDraft(appearance.defaults);
    appearance.clearPersonal();
    setMessage('已恢复网站默认外观。');
  };

  const saveDefault = async () => {
    setSaving('default');
    setMessage('');
    const { data, error } = await client.appearance.default.put(draft, { headers: headersWithAuth() });
    setSaving(null);
    if (error || !data || typeof data === 'string') {
      setMessage('更新网站默认外观失败。');
      return;
    }
    appearance.saveDefaults(data.settings);
    setMessage('已更新网站默认外观。');
  };

  return (
    <main className="appearance-page">
      <Helmet><title>外观设置 - {process.env.NAME}</title></Helmet>
      <section className="appearance-panel">
        <p className="appearance-kicker">APPEARANCE</p>
        <h1>外观设置</h1>
        <p className="appearance-intro">调整只会即时预览；保存后，你的偏好会跟随账号保留。</p>
        <div className="appearance-controls">
          {controls.map(control => (
            <label className="appearance-control" key={control.key}>
              <span className="appearance-control-heading">
                <span>
                  <strong>{control.label}</strong>
                  <small>{control.description}</small>
                </span>
                <b>{control.format(draft[control.key])}</b>
              </span>
              <input
                type="range"
                min={control.min}
                max={control.max}
                step={control.step}
                value={draft[control.key]}
                onChange={event => update(control.key, Number(event.target.value))}
              />
            </label>
          ))}
        </div>
        <div className="appearance-actions">
          <ButtonWithLoading title="保存我的偏好" loading={saving === 'personal'} onClick={savePersonal} />
          <ButtonWithLoading title="恢复网站默认" secondary loading={saving === 'reset'} onClick={resetPersonal} />
          {profile.role === 'owner' && (
            <ButtonWithLoading title="设为网站默认" secondary loading={saving === 'default'} onClick={saveDefault} />
          )}
        </div>
        {message && <p className="appearance-message" role="status">{message}</p>}
      </section>
    </main>
  );
}
