import {formatLocale, t} from '../i18n';

const numbers = new Map<string, Intl.NumberFormat>();

export function num(value: number, digits: 0 | 1 | 2 = 0) {
  const locale = formatLocale();
  const key = `${locale}/${digits}`;
  let formatter = numbers.get(key);
  if (!formatter) numbers.set(key, (formatter = new Intl.NumberFormat(locale, {maximumFractionDigits: digits})));
  return formatter.format(value);
}

export function duration(ms: number, short = false) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return t('time.underMinute');
  if (minutes < 60) return t('time.minutes', {n: minutes});
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (hours < 24) return short || !(minutes % 60) ? t('time.hours', {n: hours}) : t('time.hoursMinutes', {h: hours, m: minutes % 60});
  return short || !(hours % 24) ? t('time.days', {n: days}) : t('time.daysHours', {d: days, h: hours % 24});
}

/**
 * How long until something, for a mark or a heading with little room: minutes within the
 * hour, hours for two days, days after that, always rounded down and never under a minute.
 * Two days are hours still, so a reset in 47 hours does not read as one day away.
 */
export function countdown(ms: number) {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return t('time.minutes', {n: minutes});
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t('time.hours', {n: hours});
  return t('time.days', {n: Math.floor(hours / 24)});
}

export function ago(time: number | null, now: number) {
  if (!time) return t('time.noData');
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return t('time.justNow');
  if (seconds < 3600) return t('time.minutesAgo', {n: Math.round(seconds / 60)});
  if (seconds < 86_400) return t('time.hoursAgo', {n: Math.floor(seconds / 3600)});
  return t('time.daysAgo', {n: Math.floor(seconds / 86_400)});
}

export const clock = (time: number) => new Date(time).toLocaleTimeString(formatLocale(), {hour: '2-digit', minute: '2-digit'});

/** "22 Sept": the scale along a chart's axis, which has little room; saying when is `stamp`. */
export const shortDay = (time: number) => new Date(time).toLocaleDateString(formatLocale(), {day: 'numeric', month: 'short'});

/** "26 September": the day, its month in a word. */
export const day = (time: number) => new Date(time).toLocaleDateString(formatLocale(), {day: 'numeric', month: 'long'});

/**
 * "26 September 14:00": the one way the board says when, with no dots or commas between
 * its parts. Where how soon or how long ago matters more and room is short, that is said
 * instead (`countdown`, `duration`, `ago`), with this beside it or in its tooltip.
 */
export const stamp = (time: number) => `${day(time)} ${clock(time)}`;
