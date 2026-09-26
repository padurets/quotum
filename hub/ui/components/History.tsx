import {memo, useMemo} from 'react';
import {MINUTE, useNow} from '../lib/api';
import type {History as HistoryData, Overview} from '../lib/types';
import {num} from '../lib/format';
import {sourceLabel} from '../lib/quota';
import {planAt, started, weeklyPlanLine} from '../lib/plan';
import {forecastLine, outlook} from '../lib/forecast';
import {PROVIDERS} from '../lib/providers';
import {HORIZONS, setMuted, setPrefs, usePrefs} from '../lib/prefs';
import {goTo, setTimeRange, timeRangeKey, useTimeRange} from '../lib/timeRange';
import {frameOf, step} from '../lib/periods';
import {HISTORY, planOf, withHidden, type Arrange} from '../lib/view';
import {chartEvents, chartResets, linesOf} from '../lib/lines';
import {Chart, type Marker} from './Chart';
import type {ForecastLine, PlanLine} from '../lib/readout';
import type {PastResets, Resets} from '../lib/resets';
import {t, useLocale} from '../i18n';
import {Segmented} from './Kit';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';

/**
 * The chart's own settings: whether it draws the plan and the forecast (where either has
 * something to draw), how far it looks ahead, and (for the board's owner) hiding it.
 * Its note says the look ahead needs the plan or the forecast, where a period ending now
 * has neither; a range in the past has no future at all.
 */
function HistorySettings({arrange, planAvailable, forecastAvailable, horizonNote}: {arrange: Arrange; planAvailable: boolean; forecastAvailable: boolean; horizonNote: boolean}) {
  const {horizon, showPlan, showForecast} = usePrefs();
  return (
    <Popover label={t('history.settings')} icon={<SlidersIcon />}>
      {(planAvailable || forecastAvailable) && (
        <div className="popover-section">
          <div className="popover-title">{t('history.show')}</div>
          {planAvailable && (
            <SwitchRow on={showPlan} onChange={on => setPrefs({showPlan: on})}>
              {t('history.plan')}
            </SwitchRow>
          )}
          {forecastAvailable && (
            <SwitchRow on={showForecast} onChange={on => setPrefs({showForecast: on})}>
              {t('history.forecast')}
            </SwitchRow>
          )}
          {planAvailable && <div className="popover-note">{t('history.planHint')}</div>}
        </div>
      )}
      <div className="popover-section">
        <div className="popover-title">{t('history.horizon')}</div>
        <div className="popover-pad">
          <Segmented
            value={horizon}
            onChange={value => setPrefs({horizon: value})}
            options={HORIZONS.map(h => [h, h === 'auto' ? t('history.horizonAuto') : t('history.daysShort', {count: parseInt(h)})])}
            label={t('history.horizon')}
          />
        </div>
        {horizonNote && <div className="popover-note">{t('history.horizonNote')}</div>}
      </div>
      {arrange.owner && <HideRow onHide={() => arrange.update(view => withHidden(view, HISTORY, true))}>{t('widget.hide')}</HideRow>}
    </Popover>
  );
}

/** The remaining share of every window of one kind over the period, with its legend. */
export const History = memo(function History({
  history,
  loading,
  overview,
  resets,
  past,
  arrange,
}: {
  history: HistoryData | null;
  /** Another period is loading; `history` is the previous one until it comes. */
  loading: boolean;
  overview: Overview | null;
  resets: Resets;
  past: PastResets;
  arrange: Arrange;
}) {
  const now = useNow(MINUTE);
  const prefs = usePrefs();
  const {view} = arrange;
  // Series names and markers are text: they are rebuilt when the language changes.
  const locale = useLocale();

  const lines = useMemo(() => linesOf(history, overview, view, prefs.kind), [history, overview, prefs.kind, view.windows, view.hidden, view.colors, locale]);

  const visible = useMemo(() => lines.filter(line => !prefs.muted[line.key]), [lines, prefs.muted]);
  // The chart moves to the period asked for at once, drawing the answer it has until the
  // next one comes. A time range is in the past: the chart shows just it, without the future.
  const selected = useTimeRange();
  const historyStart = overview?.historyStart ?? history?.historyStart ?? 0;
  const frame = frameOf(selected, prefs, now, historyStart);
  const {from, future} = frame;
  // Measurements end at the page's clock, or at the hub's when that is ahead and the answer
  // is of this very period: a browser a few minutes behind still draws the latest ones, up
  // to the end of a range dragged to the edge of a period ending now.
  const answered = history && history.range === (selected ? timeRangeKey(selected) : prefs.range) ? history : null;
  const measuredTo = answered ? Math.max(frame.to, selected ? Math.min(answered.to, selected.to) : answered.to) : frame.to;
  // An announced Codex reset matters only where Codex is on the chart.
  const announced = frame.live && visible.some(line => line.provider === 'codex') ? (resets.codex?.scheduled?.scheduledFor ?? null) : null;
  // The spending plan applies to weekly windows, when a line on the chart has a plan.
  const planAvailable = prefs.kind === 'weekly' && visible.some(line => planOf(view, line.sourceId) !== null);
  const planShown = planAvailable && prefs.showPlan;
  // Where each window's pace leads, for the lines that have a forecast to draw.
  const ahead = useMemo(
    () =>
      visible.flatMap(line => {
        const source = overview?.sources.find(s => s.id === line.sourceId);
        const live = source?.windows.find(w => w.id === line.windowId);
        const measuredAt = source?.successAt ?? null;
        const weekly = planOf(view, line.sourceId);
        const said = outlook(live, measuredAt, now, weekly);
        return 'pace' in said ? [{line, live, measuredAt, weekly, runsOut: said.key === 'runsOut' ? said.at : null}] : [];
      }),
    [visible, overview, now, view],
  );
  // A range in the past has no forecast, so nothing to switch.
  const forecastAvailable = frame.live && ahead.length > 0;
  const forecastShown = forecastAvailable && prefs.showForecast;
  // Without the plan or the forecast the chart ends now (an announced reset is pointed at
  // from the right edge). With either, on `auto` some future stays on the right,
  // stretched to include an announced reset when close, and to the last moment the
  // forecast says a window runs out within reach: it may take up to ~40% of the width,
  // anything further out is pointed at from the edge instead. A chosen horizon is kept as is.
  const reach = measuredTo + (measuredTo - from) * 0.75;
  const lastRunOut = forecastShown ? Math.max(0, ...ahead.map(a => (a.runsOut !== null && a.runsOut <= reach ? a.runsOut : 0))) : 0;
  const to = !(planShown || forecastShown) || !frame.live
    ? measuredTo
    : prefs.horizon === 'auto'
      ? Math.max(
          announced && announced > measuredTo && announced + future * 0.25 > measuredTo + future ? Math.min(reach, announced + future * 0.25) : measuredTo + future,
          lastRunOut,
        )
      : measuredTo + future;

  const markers: Marker[] = useMemo(() => {
    const list: Marker[] = [];
    if (announced && announced > from) {
      list.push({key: 'announced-codex', at: announced, label: t('chart.announcedCodex'), color: 'var(--accent)', strong: true});
    }
    const seen = new Set<string>();
    for (const line of visible) {
      const source = overview?.sources.find(s => s.id === line.sourceId);
      const live = source?.windows.find(w => w.id === line.windowId);
      // A reset is marked for a window that has started, whether or not the board plans it.
      if (!live?.resetAt || live.resetAt <= measuredTo || live.resetAt > to || !started(live, source?.successAt ?? null)) continue;
      const key = `${line.sourceId}@${Math.round(live.resetAt / 60_000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({key, at: live.resetAt, label: t('chart.reset', {source: source ? sourceLabel(source) : line.provider}), color: line.color});
    }
    // What happened to the sources on the chart: their limits came back early, or free resets were granted.
    for (const {event, lines: shown} of chartEvents(history?.events ?? [], visible, from)) {
      const source = overview?.sources.find(s => s.id === event.sourceId);
      const name = source ? sourceLabel(source) : shown[0].provider;
      list.push({
        key: `${event.kind}-${event.sourceId}-${event.at}`,
        at: event.at,
        label: event.kind === 'early_reset' ? t('chart.earlyReset', {source: name}) : t('chart.resetsGranted', {count: event.count, source: name}),
        color: shown[0].color,
        past: true,
      });
    }
    // Resets for everyone the trackers reported, on the providers the chart shows.
    for (const {provider, reset, line} of chartResets(past, visible, from, measuredTo)) {
      list.push({
        key: `announced-${provider}-${reset.at}`,
        at: reset.at,
        label: t('chart.resetForAll', {source: PROVIDERS[provider]?.name ?? provider}),
        detail: reset.text,
        color: line.color,
        past: true,
      });
    }
    return list;
  }, [announced, visible, overview, history, past, from, to, measuredTo, view, locale]);

  // One plan line per distinct weekly window; windows of a source that share a reset
  // (e.g. Claude weekly and Fable) share one plan.
  const plans: PlanLine[] = useMemo(() => {
    if (!planShown) return [];
    const seen = new Map<string, PlanLine>();
    for (const line of visible) {
      const source = overview?.sources.find(s => s.id === line.sourceId);
      const live = source?.windows.find(w => w.id === line.windowId);
      const plan = planOf(view, line.sourceId);
      // Idle rolling windows (reset = now + 7 days) have not started: no plan to show.
      if (!plan || !live?.resetAt || live.minutes !== 10080 || !planAt(live, source?.successAt ?? null, now, plan)) continue;
      const key = `${line.sourceId}@${Math.round(live.resetAt / 3_600_000)}`;
      const shared = seen.get(key);
      if (shared) {
        shared.lines.push(line.key);
        continue;
      }
      seen.set(key, {
        key,
        lines: [line.key],
        color: line.color,
        runs: weeklyPlanLine(live.resetAt, from, to, plan),
      });
    }
    return [...seen.values()];
  }, [visible, overview, from, to, now, planShown, view, locale]);

  const forecasts: ForecastLine[] = useMemo(
    () =>
      !forecastShown
        ? []
        : ahead.flatMap(({line, live, measuredAt, weekly}) => {
            const drawn = forecastLine(live, measuredAt, now, weekly, from, to);
            return drawn?.points.length ? [{key: line.key, name: line.name, color: line.color, dash: line.dash, points: drawn.points, at: drawn.at}] : [];
          }),
    [ahead, forecastShown, now, from, to],
  );

  return (
    <section className={`panel history ${loading ? 'is-loading' : ''}`} aria-label={t('history.label')} aria-busy={loading}>
      <div className="panel-head">
        <h2>{t('history.title')}</h2>
        <HistorySettings arrange={arrange} planAvailable={planAvailable} forecastAvailable={forecastAvailable} horizonNote={frame.live && !planShown && !forecastShown} />
      </div>

      <div className="legend">
        {lines.map(line => (
          <button
            key={line.key}
            type="button"
            className="legend-item"
            aria-pressed={!prefs.muted[line.key]}
            onClick={() => setMuted(line.key, !prefs.muted[line.key])}
          >
            <svg width="18" height="6" aria-hidden="true">
              <line x1="1" x2="17" y1="3" y2="3" stroke={line.color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={line.dash || undefined} />
            </svg>
            <span>{line.name}</span>
            <b>{num(line.current)}%</b>
          </button>
        ))}
        {!lines.length && <span className="legend-empty">{t('history.noLines')}</span>}
      </div>

      {history ? <Chart lines={visible} plans={plans} forecasts={forecasts} markers={markers} from={from} now={measuredTo} to={to} cellMs={history.cellMs} empty={lines.length ? t('chart.empty') : null} onSelect={setTimeRange} onStep={direction => goTo(step(selected, prefs.range, direction, now, historyStart))} /> : <div className="chart chart-loading">{t('history.loading')}</div>}
    </section>
  );
});
