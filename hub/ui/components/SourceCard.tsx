import {memo, useEffect, useRef, useState, type CSSProperties} from 'react';
import {useNow} from '../lib/api';
import type {SourceState, Win} from '../lib/types';
import {windowKey} from '../lib/types';
import {countdown, duration, num, stamp} from '../lib/format';
import {cadenceOf, dotOf, errorText, level, problemOf, resetLine, sourceLabel, windowName} from '../lib/quota';
import {t, useLocale} from '../i18n';
import {DEFAULT_PLAN, isValidPlan, planAt, planNote, planTotal, type WeeklyPlan} from '../lib/plan';
import {LOGOS} from './logos';
import {cardId, colorOf, isWindowHidden, planOf, weeklyPlanOf, withColor, withHidden, withName, withPlan, withPlanned, withWindowHidden, type Arrange} from '../lib/view';
import {CARD_COLORS, MIDDLE_STEP, PROVIDERS} from '../lib/providers';
import {call} from '../lib/http';
import type {Board} from '../lib/session';
import {resetLabel, type ResetStatus} from '../lib/resets';
import {FreeResets, ResetMark} from './ResetMarks';
import {Tray} from './Tray';
import {EyeOffIcon, HideRow, Popover, SlidersIcon, SwitchRow, TakeOffIcon} from './Popover';
import {ErrorLine} from './Kit';

function Meter({w, measuredAt, now, weekly}: {w: Win; measuredAt: number | null; now: number; weekly: WeeklyPlan | null}) {
  const state = level(w.remaining);
  const plan = planAt(w, measuredAt, now, weekly);
  const pace = plan && !plan.done ? plan.remaining : null;
  return (
    <div className="meter" role="progressbar" aria-label={windowName(w)} aria-valuenow={Math.round(w.remaining)} aria-valuemin={0} aria-valuemax={100}>
      <span className="meter-track">
        <i className={`fill fill-${state}`} style={{width: `${Math.max(w.remaining, 1)}%`}} />
      </span>
      {pace !== null && <b className="pace" style={{left: `${pace}%`}} title={t('limit.paceHint', {value: num(pace)})} />}
    </div>
  );
}

function Limit({w, measuredAt, now, weekly}: {w: Win; measuredAt: number | null; now: number; weekly: WeeklyPlan | null}) {
  const state = level(w.remaining);
  const note = planNote(w, measuredAt, now, weekly);
  const reset = resetLine(w, now);
  return (
    <div className="limit">
      <div className="limit-top">
        <span className="limit-name">{windowName(w)}</span>
        <span className={`limit-value v-${state}`}>
          {num(w.remaining)}
          <small>%</small>
        </span>
      </div>
      <Meter w={w} measuredAt={measuredAt} now={now} weekly={weekly} />
      <div className="limit-bottom">
        <span title={w.resetAt ? stamp(w.resetAt) : ''}>
          {reset.key === 'resetsIn' ? t('limit.resetsIn', {time: duration(reset.inMs)}) : t(`limit.${reset.key}`)}
        </span>
        {note?.key === 'ahead' && (
          <span className="ahead" title={t(note.weekly ? 'limit.aheadHint' : 'limit.aheadHintReset')}>
            {t('limit.ahead', {value: num(note.value)})}
          </span>
        )}
        {note?.key === 'behind' && (
          <span className="plan-note" title={t('limit.behindHint')}>
            {t('limit.behind', {value: num(note.value)})}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The weekly spending plan of one source, one whole percent per day. It is saved only
 * when it adds up to exactly 100%; a day at 0 has no spending planned.
 */
function PlanEditor({source, arrange}: {source: SourceState; arrange: Arrange}) {
  const saved = weeklyPlanOf(arrange.view, source.id);
  const [draft, setDraft] = useState<WeeklyPlan>(saved);
  useEffect(() => setDraft(saved), [saved.join(',')]);
  const total = planTotal(draft);

  const change = (day: number, raw: string) => {
    const value = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
    const next = draft.map((share, i) => (i === day ? value : share));
    setDraft(next);
    if (isValidPlan(next)) arrange.update(view => withPlan(view, source.id, next));
  };

  return (
    <div className="plan-editor">
      <div className="plan-days">
        {draft.map((share, day) => (
          <label key={day} className={share === 0 ? 'is-zero' : ''}>
            <span>{day + 1}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={share}
              aria-label={t('plan.day', {day: day + 1})}
              onChange={event => change(day, event.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="plan-foot">
        <span className={total === 100 ? 'muted' : 'v-warn'}>{total === 100 ? t('plan.total') : t('plan.totalWrong', {total})}</span>
        {saved.join() !== DEFAULT_PLAN.join() && (
          <button type="button" className="link-button" onClick={() => arrange.update(view => withPlan(view, source.id, null))}>
            {t('plan.default')}
          </button>
        )}
      </div>
    </div>
  );
}

/** A card's name as the board's owner sets it; empty gives back the automatic one. */
function CardName({source, arrange}: {source: SourceState; arrange: Arrange}) {
  const saved = arrange.view.names[source.id] ?? '';
  const [name, setName] = useState(saved);
  useEffect(() => setName(saved), [saved]);
  // A click outside closes the panel before the field blurs: what was typed is also
  // saved when the field goes away with it.
  const latest = useRef({name, saved, arrange});
  latest.current = {name, saved, arrange};
  const save = () => {
    const {name, saved, arrange} = latest.current;
    if (name.trim() !== saved) arrange.update(view => withName(view, source.id, name));
  };
  useEffect(() => save, []);
  return (
    <div className="popover-pad card-name">
      <input
        value={name}
        maxLength={60}
        placeholder={t('source.namePlaceholder')}
        aria-label={t('source.name')}
        onChange={event => setName(event.target.value)}
        onBlur={save}
        onKeyDown={event => event.key === 'Enter' && save()}
      />
    </div>
  );
}

/** The hues of CARD_COLORS, in its order. */
const HUE_NAMES = ['source.hue.blue', 'source.hue.teal', 'source.hue.purple', 'source.hue.orange', 'source.hue.grey'] as const;

/**
 * A card's colour on the chart and in the table: a row of hues, and under it the steps
 * of lightness of the chosen one. The provider's colour is where the card starts; picking
 * it again, or resetting, gives the card back the provider's.
 */
function CardColor({source, arrange}: {source: SourceState; arrange: Arrange}) {
  const own = PROVIDERS[source.provider]?.color;
  const chosen = arrange.view.colors[source.id];
  const current = chosen ?? own;
  const hue = CARD_COLORS.findIndex(steps => current !== undefined && steps.includes(current));
  const choose = (color: string) => arrange.update(view => withColor(view, source.id, color === own ? null : color));
  return (
    <div className="popover-pad">
      <div className="color-hues" role="group" aria-label={t('source.color')}>
        {CARD_COLORS.map((steps, i) => {
          const color = i === hue ? current! : steps[MIDDLE_STEP];
          return (
            <button
              key={steps[MIDDLE_STEP]}
              type="button"
              className="color-choice"
              style={{background: color}}
              aria-pressed={i === hue}
              aria-label={t(HUE_NAMES[i])}
              onClick={() => choose(color)}
            />
          );
        })}
        {chosen && (
          <button type="button" className="link-button" onClick={() => arrange.update(view => withColor(view, source.id, null))}>
            {t('source.colorReset')}
          </button>
        )}
      </div>
      {hue >= 0 && (
        <div className="color-steps" role="group" aria-label={t('source.colorSteps')}>
          {CARD_COLORS[hue].map((color, step) => (
            <button
              key={color}
              type="button"
              style={{background: color}}
              aria-pressed={color === current}
              aria-label={t('source.colorStep', {step: step + 1, count: CARD_COLORS[hue].length})}
              onClick={() => choose(color)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A card's menu. The board's owner names the card, gives it a colour, picks its limits,
 * sets the weekly plan or switches it off, hides it; on a shared board the owner, or whoever's devices measure it, also
 * takes it off the board.
 */
function SourceSettings({source, arrange, board, onChanged}: {source: SourceState; arrange: Arrange; board: Board; onChanged: () => void}) {
  const [error, setError] = useState<unknown>(null);
  const hidden = new Set(arrange.view.windows);
  const hasWeekly = source.windows.some(w => w.kind === 'weekly');
  const planned = planOf(arrange.view, source.id) !== null;
  const owner = arrange.owner;
  const takeOff = !board.personal && (owner || source.mine);

  const unshare = async () => {
    setError(null);
    try {
      await call('DELETE', `/api/boards/${encodeURIComponent(board.id)}/shares/${encodeURIComponent(source.id)}`);
      onChanged();
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <Popover label={t('source.settings', {source: sourceLabel(source)})} icon={<SlidersIcon />}>
      {owner && (
        <>
          <div className="popover-title">{t('source.name')}</div>
          <CardName source={source} arrange={arrange} />
        </>
      )}
      {owner && source.windows.length > 1 && (
        <>
          <div className="popover-title popover-section">{t('source.show')}</div>
          {source.windows.map(w => {
            const key = windowKey(source.id, w.id);
            return (
              <SwitchRow key={w.id} on={!hidden.has(key)} onChange={on => arrange.update(view => withWindowHidden(view, key, !on))} value={`${num(w.remaining)}%`}>
                {windowName(w)}
              </SwitchRow>
            );
          })}
        </>
      )}
      {owner && (
        <>
          <div className="popover-title popover-section">{t('source.color')}</div>
          <CardColor source={source} arrange={arrange} />
        </>
      )}
      {owner && (
        <div className="popover-section">
          <SwitchRow on={planned} onChange={on => arrange.update(view => withPlanned(view, source.id, on))}>
            {t('source.plan')}
          </SwitchRow>
          {planned && hasWeekly && (
            <>
              <PlanEditor source={source} arrange={arrange} />
              <div className="popover-note">{t('source.planNote')}</div>
            </>
          )}
        </div>
      )}
      {owner && <HideRow onHide={() => arrange.update(view => withHidden(view, cardId(source.id), true))}>{t('widget.hide')}</HideRow>}
      {takeOff && (
        <div className={owner ? '' : 'popover-section'}>
          <button type="button" className="popover-row is-danger" onClick={unshare}>
            <TakeOffIcon />
            <span>{t('source.takeOff')}</span>
          </button>
          <ErrorLine error={error} />
        </div>
      )}
    </Popover>
  );
}

/**
 * A card whose every limit its board hides: it says so where the limits would be, that
 * the measurements go on, and lets the board's owner bring them back in one go.
 */
function AllHidden({source, arrange}: {source: SourceState; arrange: Arrange}) {
  const showAll = () => arrange.update(view => source.windows.reduce((next, w) => withWindowHidden(next, windowKey(source.id, w.id), false), view));
  return (
    <div className="card-empty">
      <EyeOffIcon />
      <b>{t('card.allHidden')}</b>
      <span>{t(arrange.owner ? 'card.allHiddenNote' : 'card.allHiddenByOwner')}</span>
      {arrange.owner && (
        <button type="button" className="text-button card-empty-action" onClick={showAll}>
          {t('card.showAll')}
        </button>
      )}
    </div>
  );
}

export const SourceCard = memo(function SourceCard({
  source,
  resets,
  arrange,
  board,
  onChanged,
}: {
  source: SourceState;
  resets?: ResetStatus;
  arrange: Arrange;
  board: Board | null;
  onChanged: () => void;
}) {
  useLocale();
  const now = useNow();
  const problem = problemOf(source);
  const visible = source.windows.filter(w => !isWindowHidden(arrange.view, source.id, w.id));
  const weekly = planOf(arrange.view, source.id);
  const dot = dotOf(source, now);
  // How the measurements go lives in the logo's dot alone: its colour (how fresh, or in
  // trouble) and its tooltip; a line of its own would only repeat it and make the card taller.
  const status = problem ?? (source.successAt ? t('source.measured', {at: stamp(source.successAt)}) : errorText('waiting'));
  // Then when the next measurement comes (how soon, and the time) and why, each a line of its own.
  const cadence = cadenceOf(source, now);
  const lines = [
    status,
    ...(cadence
      ? cadence.when === 'nextSoon'
        ? [t('source.nextSoon')]
        : [t('source.nextIn', {time: countdown(cadence.next - now)}), stamp(cadence.next)]
      : []),
    ...(cadence ? [t(`source.why.${cadence.why}`)] : []),
  ];
  const news = resetLabel(resets, now);
  // The dot's tooltip is one bubble everywhere: under the pointer on a desktop (style.css),
  // and for a while after a tap on a touch screen, which has nothing to hover.
  const [tip, setTip] = useState(false);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(false);
    const timer = setTimeout(hide, 4000);
    document.addEventListener('pointerdown', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', hide);
    };
  }, [tip]);

  return (
    <article className="card" style={{'--card-color': colorOf(arrange.view, source.id, source.provider)} as CSSProperties}>
      <div className="card-head">
        <span
          className={`provider-mark ${dot.warn ? 'is-warn' : ''} ${tip ? 'is-tipped' : ''}`}
          aria-label={lines.join('\n')}
          role="img"
          onPointerUp={event => event.pointerType === 'touch' && setTip(true)}
        >
          <img className="provider-logo" src={LOGOS[source.provider]} alt="" />
          {dot.warn ? (
            <i className="dot dot-warn" />
          ) : (
            <i className={`dot dot-fresh ${dot.pulsing ? 'is-pulsing' : ''}`} style={{'--fresh': dot.fresh} as CSSProperties} />
          )}
          <span className="dot-tip glass" aria-hidden="true">
            {lines.map(line => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </span>
        <div className="card-title">
          <h2>{sourceLabel(source)}</h2>
          {source.plan && <span className="plan">{source.plan.replace(/^Claude\s+/i, '')}</span>}
        </div>
        {board && (arrange.owner || (!board.personal && source.mine)) && <SourceSettings source={source} arrange={arrange} board={board} onChanged={onChanged} />}
      </div>

      <div className="limits">
        {visible.map(w => (
          <Limit key={w.id} w={w} measuredAt={source.successAt} now={now} weekly={weekly} />
        ))}
        {!source.windows.length && <div className="card-empty">{errorText(source.error ?? 'waiting')}</div>}
        {!!source.windows.length && !visible.length && <AllHidden source={source} arrange={arrange} />}
      </div>
      <Tray
        news={news && resets && <ResetMark label={news} credit={resets.credit} now={now} />}
        current={!!source.resets?.available && <FreeResets resets={source.resets} />}
        sessions={source.sessions ?? []}
        now={now}
      />
    </article>
  );
});
