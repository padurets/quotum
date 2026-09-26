import {memo, useMemo} from 'react';
import {MINUTE, useNow} from '../lib/api';
import type {History as HistoryData, Overview} from '../lib/types';
import {countdown, num, stamp} from '../lib/format';
import {level} from '../lib/quota';
import {forecastRow, spentOf, type Outlook, type Pace, type Spent} from '../lib/forecast';
import {FORECAST, planOf, withHidden, type Arrange} from '../lib/view';
import {linesOf} from '../lib/lines';
import {usePrefs} from '../lib/prefs';
import {ofTimeRange} from '../lib/timeRange';
import {t, useLocale} from '../i18n';
import {HideRow, Popover, SlidersIcon} from './Popover';

/** How fast the window goes, as the tooltip of its forecast says it. */
const paceText = (pace: Pace) =>
  pace.by === 'plan' ? t('forecast.planPace', {k: num(pace.k, 2)}) : t('forecast.rate', {rate: pace.rate < 0.05 ? '≈ 0' : num(pace.rate, 1)});

/** The last column's text and tooltip, a part a line; its colour is the outlook's tone. */
function outlookCell(ahead: Outlook): {text: string; title: string} {
  switch (ahead.key) {
    case 'none':
      return {text: '—', title: ''};
    case 'idle':
    case 'needData':
      return {text: '—', title: t(`forecast.${ahead.key}`)};
    case 'pastZero':
      return {text: '—', title: [t('forecast.pastZero', {time: stamp(ahead.at)}), t('forecast.awaiting')].join('\n')};
    case 'usedUp':
      return {text: t('forecast.usedUp'), title: ''};
  }
  const title = paceText(ahead.pace);
  switch (ahead.key) {
    case 'runsOut':
      return {text: t('forecast.runsOut', {time: countdown(ahead.inMs)}), title: [title, t('forecast.runsOutAt', {time: stamp(ahead.at)})].join('\n')};
    case 'onPacePlan':
    case 'onPaceReset':
      return {text: t(`forecast.${ahead.key}`), title};
    case 'leftPlan':
    case 'leftReset':
      return {text: t(`forecast.${ahead.key}`, {value: num(ahead.left)}), title};
  }
}

const spentText = (spent: Spent) => (spent.key === 'points' ? t('table.points', {value: num(spent.value, 1)}) : spent.key === 'unused' ? t('table.unused') : '—');

/** How long a line must have been measured without gaps for its pace to mean something. */
const PACE_FROM = 10 * 60_000;

/**
 * The windows of one kind: what is left, what the plan expects, what the period spent,
 * and where each window's own pace leads, whatever the period. Its period and window type are the analytics', as the chart's. Over a
 * time range selected on the chart, which is in the past, it shows that range instead:
 * what was left at its start and its end, what it spent and how fast.
 */
export const Forecast = memo(function Forecast({
  history,
  loading,
  overview,
  arrange,
}: {
  history: HistoryData | null;
  /** Another period is loading; `history` is the previous one until it comes. */
  loading: boolean;
  overview: Overview | null;
  arrange: Arrange;
}) {
  const now = useNow(MINUTE);
  const {view} = arrange;
  const {kind} = usePrefs();
  const selected = ofTimeRange(history);
  // Window names are text: they are rebuilt when the language changes.
  const locale = useLocale();
  const lines = useMemo(() => linesOf(history, overview, view, kind), [history, overview, view.windows, view.hidden, view.colors, kind, locale]);

  return (
    <section className={`panel forecast ${selected ? 'is-range' : ''} ${loading ? 'is-loading' : ''}`} aria-label={t('forecast.title')} aria-busy={loading}>
      <div className="panel-head">
        <h2>{t('forecast.title')}</h2>
        {arrange.owner && (
          <Popover label={t('forecast.settings')} icon={<SlidersIcon />}>
            <HideRow onHide={() => arrange.update(next => withHidden(next, FORECAST, true))}>{t('widget.hide')}</HideRow>
          </Popover>
        )}
      </div>
      {!history ? (
        <div className="panel-loading">{t('history.loading')}</div>
      ) : !lines.length ? (
        <p className="panel-empty">{t('forecast.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              {selected ? (
                <tr>
                  <th>{t('table.limit')}</th>
                  <th>{t('table.atStart')}</th>
                  <th>{t('table.atEnd')}</th>
                  <th>{t('table.spentInRange')}</th>
                  <th title={t('table.paceHint')}>{t('table.pace')}</th>
                </tr>
              ) : (
                <tr>
                  <th>{t('table.limit')}</th>
                  <th>{t('table.now')}</th>
                  <th title={t('table.planHint')}>{t('table.plan')}</th>
                  <th>{t('table.spent')}</th>
                  <th title={t('table.forecastHint')}>{t('table.forecast')}</th>
                </tr>
              )}
            </thead>
            <tbody>
              {lines.map(line => {
                const name = (
                  <td>
                    <span className="swatch" style={{background: line.color}} />
                    {line.name}
                  </td>
                );
                if (selected) {
                  const spent = <td>{spentText(spentOf(line))}</td>;
                  const edge = (value: number | null) => (value === null ? <td>—</td> : <td className={`v-${level(value)}`}>{num(value)}%</td>);
                  return (
                    <tr key={line.key}>
                      {name}
                      {edge(line.remainingAtStart)}
                      {edge(line.remainingAtEnd)}
                      {spent}
                      <td>{line.coveredMs >= PACE_FROM ? t('table.perHour', {value: num(line.consumed / (line.coveredMs / 3_600_000), 1)}) : '—'}</td>
                    </tr>
                  );
                }
                const source = overview?.sources.find(s => s.id === line.sourceId);
                const live = source?.windows.find(w => w.id === line.windowId);
                const measuredAt = source?.successAt ?? null;
                const row = forecastRow(line, live, measuredAt, now, planOf(view, line.sourceId));
                const {plan} = row;
                const spent = <td>{spentText(row.spent)}</td>;
                const ahead = outlookCell(row.outlook);
                return (
                  <tr key={line.key}>
                    {name}
                    <td className={`v-${level(line.current)}`}>{num(line.current)}%</td>
                    <td title={plan?.notable ? t(plan.delta >= 0 ? 'table.behindBy' : 'table.aheadBy', {value: num(Math.abs(plan.delta))}) : ''}>
                      {plan ? (
                        <>
                          {num(plan.remaining)}%
                          {plan.notable && (
                            <small className={plan.delta < 0 ? 'v-warn' : 'muted'}>
                              {' '}
                              {plan.delta > 0 ? '+' : '−'}
                              {num(Math.abs(plan.delta))}
                            </small>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    {spent}
                    <td className={row.outlook.tone} title={ahead.title}>
                      {ahead.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
