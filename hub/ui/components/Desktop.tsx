import {useRef, useState} from 'react';
import {stamp} from '../lib/format';
import {PROVIDERS} from '../lib/providers';
import {errorText} from '../lib/quota';
import {
  app,
  asksToTakeOver,
  failedTitle,
  inApp,
  intervalMenu,
  onboardingText,
  takeOverText,
  takeOverTitle,
  type AgentState,
  type AppState,
  type Patch,
  type ProviderSettings,
} from '../lib/app';
import {rich, t} from '../i18n';
import {Brand, Modal} from './Kit';
import {SwitchRow} from './Popover';

/** What the desktop app says, under a title of the page's own words: its text is English, for people who look closer. */
function Detail({text}: {text: string}) {
  return <code className="app-detail">{text}</code>;
}

const quotum = <code>quotum</code>;

export function QuitButton({className = 'button'}: {className?: string}) {
  return (
    <button type="button" className={className} onClick={() => void app.quit()}>
      {t('local.quit')}
    </button>
  );
}

/**
 * The board of the desktop app's hub without the app's session: a browser that found its
 * port, or the app's window after the hub started again. The window can enter again, or
 * quit; a browser only learns where the board is.
 */
export function OpenInApp() {
  return (
    <div className="auth">
      <Brand />
      <div className="auth-card">
        <h1>{t('local.openApp')}</h1>
        <p className="auth-note">{t('local.openAppText')}</p>
        {inApp() && (
          <div className="button-row is-start">
            <button type="button" className="button primary" onClick={() => void app.reenter()}>
              {t('local.reenter')}
            </button>
            <QuitButton />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * `quotum` on the command line measures this machine: the app asks, once, whether to take
 * over. The question cannot be closed: the answers are to take over or to quit (closing
 * the window quits too). After a failed attempt it says why and offers another.
 */
export function TakeOver({agent, onState}: {agent: AgentState | undefined; onState: (state: AppState) => void}) {
  const [busy, setBusy] = useState(false);
  if (!asksToTakeOver(agent)) return null;
  const text = takeOverText(agent.holder);
  const takeOver = async () => {
    setBusy(true);
    try {
      onState(await app.takeOver());
    } catch {
      // The app keeps asking, with why it failed: the state read next says so.
      onState(await app.state());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t(takeOverTitle(agent))}>
      <div className="takeover">
        {agent.error && <Detail text={agent.error} />}
        <p>{rich(text.who, {quotum}, {pid: agent.holder.pid ?? ''})}</p>
        <p>{t('takeover.offer')}</p>
        {text.hub && <p>{rich(text.hub, {hub: <code>{agent.holder.hub ?? ''}</code>})}</p>}
        <p>{rich(text.after, {quotum})}</p>
        <div className="button-row">
          <QuitButton />
          <button type="button" className="button primary" disabled={busy} onClick={() => void takeOver()}>
            {busy ? t('takeover.busy') : agent.error ? t('takeover.retry') : t('takeover.confirm')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The agent cannot measure: why, in the page's words, and what to do. */
export function AgentBanner({state}: {state: AppState | null}) {
  if (state?.agent.state !== 'failed') return null;
  const {cause, error} = state.agent;
  return (
    <section className="panel app-banner" role="alert">
      <h2>{t(failedTitle(cause))}</h2>
      <Detail text={error} />
      <p>
        {cause === 'config'
          ? rich('failed.configText', {path: <code>{state.configPath}</code>})
          : rich('failed.logText', {path: <code>{state.logPath}</code>})}
      </p>
      {cause === 'panic' && <p>{rich('failed.panicText', {quotum})}</p>}
    </section>
  );
}

/** An empty board in the app: whether numbers come soon, and where the settings are. */
export function LocalOnboarding({agent, onSettings}: {agent: AgentState | undefined; onSettings: () => void}) {
  return (
    <section className="panel onboarding">
      <h2>{t('local.onboardingTitle')}</h2>
      <p>{t(onboardingText(agent))}</p>
      <button type="button" className="button" onClick={onSettings}>
        {t('local.openSettings')}
      </button>
    </section>
  );
}

type Saving = {field: string; error: string} | null;

/** A change the app refused, under the field it was made in. */
function SaveError({saving, field}: {saving: Saving; field: string}) {
  if (saving?.field !== field) return null;
  return (
    <div className="form-error" role="alert">
      {t('measure.saveFailed')}
      <Detail text={saving.error} />
    </div>
  );
}

/** What is known of a provider's client here: where it is and how the last measurement went. */
function Status({provider, configPath}: {provider: ProviderSettings; configPath: string}) {
  const last = provider.last;
  const result = !last
    ? t('measure.never')
    : last.ok
      ? t('measure.measured', {at: stamp(last.at)})
      : t('measure.failed', {error: errorText(last.error ?? 'failed'), at: stamp(last.at)});
  // Without a client, how its last try went says nothing more.
  if (!provider.client) {
    return (
      <>
        <small className="measure-status">{t('measure.notFound')}</small>
        <p className="drawer-note">
          {rich('measure.notFoundHelp', {key: <code className="is-key">{`[providers.${provider.id}] path`}</code>, file: <code>{configPath}</code>})}
        </p>
      </>
    );
  }
  return (
    <small className="measure-status" title={last?.detail}>
      {rich('measure.client', {path: <code>{provider.client}</code>})} · {result}
    </small>
  );
}

/** Antigravity names no account: a name tells two subscriptions apart. Saved on leaving the field or Enter. */
function AccountName({provider, onSave}: {provider: ProviderSettings; onSave: (account: string) => Promise<boolean>}) {
  // Only typed text is a draft. An untouched field follows changes made in config.toml.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const name = draft ?? provider.account ?? '';
  const save = async () => {
    if (pending.current || draft === null) return;
    if (draft.trim() === (provider.account ?? '')) {
      setDraft(null);
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      await onSave(draft.trim());
      // Success shows the accepted value; failure restores the authoritative one.
      setDraft(null);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <label className="field measure-account">
      <span>{t('measure.account')}</span>
      <input
        value={name}
        maxLength={120}
        disabled={busy}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={event => event.key === 'Enter' && void save()}
      />
      <small>{t('measure.accountHint')}</small>
    </label>
  );
}

/**
 * Which providers are measured and how often, with how each client is doing; and whether
 * running agents are shown. The settings are `quotum`'s own (config.toml): the app saves
 * each change at once and measures with it in a moment.
 */
export function Measuring({state, onState}: {state: AppState; onState: (state: AppState) => void}) {
  const [saving, setSaving] = useState<Saving>(null);
  const save = async (patch: Patch, field: string) => {
    setSaving(null);
    try {
      onState(await app.saveSettings(patch));
      return true;
    } catch (error) {
      // The field shows what the app has: the value falls back by itself.
      setSaving({field, error: (error as Error).message});
      return false;
    }
  };
  const idle = state.agent.state === 'idle';
  return (
    <section className="drawer-section">
      <h3>{t('measure.title')}</h3>
      <p className="drawer-note is-first">{rich('measure.shared', {quotum})}</p>
      {state.providers.some(p => intervalMenu(p).hint?.key === 'measure.autoHint') && <p className="drawer-note">{t('measure.autoHint')}</p>}
      {state.providers.map(provider => {
        const name = PROVIDERS[provider.id]?.name ?? provider.id;
        const menu = intervalMenu(provider);
        // Said once for the section; where the interval is set is said by the provider it holds for.
        const where = menu.hint && menu.hint.key !== 'measure.autoHint' ? menu.hint : null;
        return (
          <div key={provider.id} className="measure-provider">
            <div className="measure-head">
              <SwitchRow on={provider.enabled} onChange={on => void save({providers: {[provider.id]: {enabled: on}}}, provider.id)}>
                {name}
              </SwitchRow>
              <label className="measure-interval">
                <span className="sr-only">{t('measure.interval')}</span>
                <select
                  value={String(menu.selected)}
                  disabled={!provider.enabled}
                  onChange={event => {
                    const choice = event.target.value;
                    void save({providers: {[provider.id]: {intervalS: choice === 'first' ? null : Number(choice) * 60}}}, provider.id);
                  }}
                >
                  <option value="first" disabled={!menu.firstAvailable}>
                    {menu.first === 'auto' ? t('measure.auto') : t('measure.inherited', {count: (provider.inheritedS ?? 0) / 60})}
                  </option>
                  {menu.choices.map(minutes => (
                    <option key={minutes} value={minutes}>
                      {t('measure.atMost', {count: minutes})}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {where && <p className="drawer-note">{t(where.key, where.vars)}</p>}
            <Status provider={provider} configPath={state.configPath} />
            {provider.id === 'antigravity' && provider.enabled && (
              <AccountName provider={provider} onSave={account => save({providers: {antigravity: {account}}}, `${provider.id}.account`)} />
            )}
            <SaveError saving={saving} field={provider.id} />
            <SaveError saving={saving} field={`${provider.id}.account`} />
          </div>
        );
      })}
      <div className="drawer-switch">
        <SwitchRow on={state.sessions} onChange={on => void save({sessions: on}, 'sessions')}>
          {t('measure.sessions')}
        </SwitchRow>
      </div>
      <SaveError saving={saving} field="sessions" />
      {idle && <p className="drawer-note">{t('measure.idle')}</p>}
    </section>
  );
}

/** Start at login, which build this is, and quitting. */
export function AppSection({state, onState}: {state: AppState; onState: (state: AppState) => void}) {
  const [error, setError] = useState<string | null>(null);
  const autostart = async (on: boolean) => {
    setError(null);
    try {
      onState(await app.setAutostart(on));
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <section className="drawer-section">
      <h3>{t('appSection.title')}</h3>
      <div className="drawer-switch">
        <SwitchRow on={state.autostart} onChange={on => void autostart(on)}>
          {t('appSection.autostart')}
        </SwitchRow>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {t('appSection.autostartFailed')}
          <Detail text={error} />
        </div>
      )}
      <div className="drawer-actions is-split">
        <span className="drawer-note">{t('appSection.version', {version: state.version, commit: state.commit})}</span>
        <QuitButton />
      </div>
    </section>
  );
}
