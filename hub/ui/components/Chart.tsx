import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject} from 'react';
import {clock, countdown, day, num, shortDay, stamp} from '../lib/format';
import {t} from '../i18n';
import type {Line} from '../lib/lines';
import {hubNow, MINUTE, useNow} from '../lib/api';
import {gapText, gapTone, readout as readCell, valueAt, type ForecastLine, type PlanLine} from '../lib/readout';
import {draggedRange, type TimeRange} from '../lib/timeRange';
import {SWIPE, swiped} from '../lib/swipe';

/**
 * A moment on the time axis: ahead, a known window reset or an announced extra one;
 * behind (`past`), something that happened to a source, such as an early reset.
 */
export type Marker = {key: string; at: number; label: string; color: string; strong?: boolean; past?: boolean; detail?: string};

/** How long a finger rests on the chart before it starts a range. */
const HOLD_MS = 450;

/** The mark of a past event: a small diamond centred at (x, y). */
const diamond = (x: number, y: number, r = 4) => `M${x},${y - r}l${r},${r}l${-r},${r}l${-r},${-r}z`;

/** How wide an announcement's label is taken to be, and how near an edge a value hides under it (percent). */
const LABEL_WIDTH = 220;
const LABEL_BAND = 15;
/** How far apart labels stacked at the right edge stand. */
const LABEL_STEP = 22;

/** Made when first needed: a browser without it (Firefox before 125) still draws the board. */
let segmenter: Intl.Segmenter | null | undefined;
const defaultSegmenter = () =>
  (segmenter ??= typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null);

/**
 * The characters of a text as a reader counts them: a flag, an emoji with its skin tone or
 * a letter with its accent is one. Without a segmenter the common clusters are held
 * together by hand: a pair of regional indicators, and a character with the marks,
 * variation selector, skin tones and joined characters after it.
 */
export function graphemes(text: string, by: Intl.Segmenter | null = defaultSegmenter()) {
  return by ? Array.from(by.segment(text), part => part.segment) : (text.match(CLUSTER) ?? []);
}
const CLUSTER = /\p{Regional_Indicator}{2}|[\s\S](?:[\p{M}\u{FE0F}\u{1F3FB}-\u{1F3FF}]|\u200d[\s\S])*/gu;

/**
 * What never hangs before the ellipsis: spaces, and punctuation and maths signs that open,
 * join or separate. Closing marks stay with what they close, and symbols with the name, as
 * an emoji is one.
 */
const HANGING = /[\s\p{Z}\p{Ps}\p{Pi}\p{Pd}\p{Pc}\p{Po}\p{Sm}]+$/u;

/** A name shortened to its first `keep` characters and an ellipsis, with no space, separator or opening mark hanging before it. */
export function shortName(name: string, keep: number) {
  const letters = graphemes(name);
  return keep >= letters.length ? name : `${letters.slice(0, Math.max(0, keep)).join('').replace(HANGING, '')}…`;
}

/**
 * How many characters of `name` fit when the text around it takes `rest` and an ellipsis
 * `ellipsis`: the most whose widths (`widths`, one a character) leave the whole within
 * `room`. All of them when the name fits whole.
 */
export function fitting(widths: number[], rest: number, ellipsis: number, room: number) {
  const whole = widths.reduce((sum, width) => sum + width, 0);
  if (rest + whole <= room) return widths.length;
  let used = rest + ellipsis;
  let keep = 0;
  while (keep < widths.length && used + widths[keep] <= room) used += widths[keep++];
  return keep;
}

/**
 * The rows of the labels at the chart's right edge: those past it (`past`), and with them
 * every announcement inside the chart (`inside`), first, so each has a row of its own
 * however wide they are. They go from `from` down the plot, or up it. Without labels past
 * the edge there is no stack, and an announcement stands where it would alone.
 */
export function edgeRows(inside: string[], past: string[], from: number, down: boolean): Map<string, number> {
  const keys = past.length ? [...inside, ...past] : [];
  return new Map(keys.map((key, row) => [key, from + row * (down ? LABEL_STEP : -LABEL_STEP)]));
}

/**
 * A label on the chart on a backing sized to its text, so no line under it gets in the way.
 * One pointing past the right edge tells its exact time under the pointer or on a tap
 * (`onTip`).
 */
function MarkerLabel({
  x,
  y,
  end,
  color,
  children,
  shorten,
  fonts,
  onTip,
}: {
  x: number;
  y: number;
  end: boolean;
  color?: string;
  children: string;
  /** Wider than `room`, the text is said again with `name` in it shortened to what fits. */
  shorten?: {name: string; say: (name: string) => string; room: number};
  /** Counts the web fonts loaded: what was measured before one came is measured again. */
  fonts: number;
  onTip?: (shown: boolean, tapped: boolean) => void;
}) {
  const text = useRef<SVGTextElement>(null);
  const whole = useRef<SVGTextElement>(null);
  const [box, setBox] = useState<{x: number; width: number} | null>(null);
  // How many characters of the name it keeps, for the text, room and fonts it was measured
  // with (`input`): a fit found for anything else is not used, and the text shows whole.
  const input = shorten ? `${children}|${shorten.room}|${fonts}` : '';
  const [fit, setFit] = useState<{input: string; keep: number | null} | null>(null);
  const keep = fit?.input === input ? fit.keep : null;
  const shown = shorten && keep !== null ? shorten.say(shortName(shorten.name, keep)) : children;
  // Measured once for each input, on a hidden copy of the whole text with an ellipsis after
  // it: its width, each character of the name as drawn in it, and the ellipsis. Where the
  // copy does not hold the text character for character (the name not in it, spaces drawn
  // as one), or the browser will not measure, the text shows whole: a label a little wide
  // is better than a board that is not drawn.
  useLayoutEffect(() => {
    const element = whole.current;
    if (!shorten || !element) return;
    let found: number | null = null;
    try {
      const start = children.indexOf(shorten.name);
      const length = element.getSubStringLength(0, children.length);
      if (length > shorten.room && start >= 0 && element.getNumberOfChars() === children.length + 1) {
        let at = start;
        const widths = graphemes(shorten.name).map(letter => {
          const width = element.getSubStringLength(at, letter.length);
          at += letter.length;
          return width;
        });
        const name = widths.reduce((sum, width) => sum + width, 0);
        found = fitting(widths, length - name, element.getSubStringLength(children.length, 1), shorten.room);
      }
    } catch {
      found = null;
    }
    setFit(fit => (fit?.input === input && fit.keep === found ? fit : {input, keep: found}));
  }, [input]);
  useLayoutEffect(() => {
    const measured = text.current?.getBBox();
    if (measured) setBox({x: measured.x, width: measured.width});
  }, [x, y, end, shown, fonts]);
  return (
    <g
      className={`marker-label ${onTip ? 'is-pointed' : ''} ${color ? 'is-forecast' : ''}`}
      style={color ? ({'--label-color': color} as CSSProperties) : undefined}
      onPointerEnter={onTip && (event => event.pointerType !== 'touch' && onTip(true, false))}
      onPointerLeave={onTip && (event => event.pointerType !== 'touch' && onTip(false, false))}
      onPointerUp={onTip && (event => event.pointerType === 'touch' && onTip(true, true))}
    >
      {box && <rect x={box.x - 6} y={y - 13} width={box.width + 12} height={19} rx={5} />}
      <text ref={text} x={x} y={y} textAnchor={end ? 'end' : 'start'}>
        {shown}
      </text>
      {shorten && (
        <text ref={whole} x={x} y={y} textAnchor={end ? 'end' : 'start'} visibility="hidden" aria-hidden="true">
          {`${children}…`}
        </text>
      )}
    </g>
  );
}

function niceTicks(from: number, to: number, count: number) {
  const span = to - from;
  const steps = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map(minutes => minutes * 60_000);
  const step = steps.find(candidate => span / candidate <= count) ?? steps.at(-1)!;
  const offset = new Date().getTimezoneOffset() * 60_000;
  const ticks: number[] = [];
  for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) ticks.push(t);
  return {ticks, daily: step >= 86_400_000};
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * A cell's times under its day. Cells are laid on UTC, so one may cross midnight here, and
 * then each end names its day; a time within a cell, shorter than a day, then reads as one
 * moment, save for the hour the clocks go back.
 */
export function cellLabel(at: number, cellMs: number) {
  if (!cellMs) return stamp(at);
  const end = at + cellMs;
  return sameDay(at, end - 1) ? `${day(at)} ${clock(at)}–${clock(end)}` : `${stamp(at)} – ${stamp(end)}`;
}

/**
 * How far the tooltip under a narrow chart rises over it to stay whole in the window: as
 * far as its bottom (`top`, where it stands unraised, plus its `height`) would pass the
 * window's, less a margin, and never above what covers the top of the page (`cover`, the
 * bars that stick there).
 */
export function liftOf(top: number, height: number, windowHeight: number, cover: number) {
  return Math.max(0, Math.min(top + height - (windowHeight - 8), top - cover - 8));
}

/** How long the chart's content takes to slide in after a step through time. */
const SLIDE_MS = 220;

/**
 * How far the chart's content slides in after it steps through time, in pixels: from
 * where it was drawn to where it is now, so the eye follows which way it went. None
 * unless the period kept about its length (`end` is where measurements end, which for a
 * period ending now may be the hub's clock rather than the page's) and moved by a tenth of
 * it or more: a step, not a live period's clock moving on, nor another period.
 */
export function slideOf(before: {from: number; end: number}, after: {from: number; end: number; to: number}, plotWidth: number) {
  const length = after.end - after.from;
  const moved = after.from - before.from;
  if (length <= 0 || Math.abs(before.end - before.from - length) > length * 0.1 || Math.abs(moved) < length * 0.1 || Math.abs(moved) > length) return 0;
  return (moved / (after.to - after.from)) * plotWidth;
}

/**
 * Remaining quota over time for every selected window. All series share one time
 * grid, so hovering anywhere snaps to a cell and reads every series for it — no
 * pixel hunting. Lines break only where a whole cell is empty.
 */
export function Chart({
  lines,
  plans = [],
  forecasts = [],
  markers = [],
  from,
  now,
  to,
  cellMs,
  empty,
  onSelect,
  onStep,
}: {
  lines: Line[];
  plans?: PlanLine[];
  forecasts?: ForecastLine[];
  markers?: Marker[];
  from: number;
  /** Where measurements end; everything right of it is the future. */
  now: number;
  to: number;
  cellMs: number;
  /** Said over an empty chart; none when the legend already says it. */
  empty: string | null;
  /** A time range dragged across the chart, as in Grafana. */
  onSelect?: (range: TimeRange) => void;
  /** A swipe sideways on a touchpad, or Shift with the wheel: back (-1) or forward (1) through time. */
  onStep?: (direction: -1 | 1) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  /** CSS pixels to a unit of the chart: under 1 where the chart is narrower than it is drawn (280). */
  const [scale, setScale] = useState(1);
  /** Start of the hovered cell. */
  const [hover, setHover] = useState<number | null>(null);
  /** Where a drag across the chart started and where it is now, in chart pixels. */
  const [drag, setDrag] = useState<{start: number; end: number} | null>(null);
  /** A finger held on the chart, before it starts a range. */
  const holding = useRef<{px: number; timer: ReturnType<typeof setTimeout>} | null>(null);
  useEffect(() => () => cancelHold(), []);
  /** Where the pointer last was over the chart, in chart pixels: a step reads the values under it anew. */
  const pointer = useRef<number | null>(null);

  // The wheel is heard natively, so the chart can keep a swipe from scrolling the page
  // sideways or going back in the browser. Nothing renders until the gesture steps.
  const svg = useRef<SVGSVGElement>(null);
  const swipe = useRef(SWIPE);
  const stepped = useRef(onStep);
  stepped.current = onStep;
  const dragging = useRef(false);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!stepped.current || dragging.current) return;
      const result = swiped(swipe.current, event);
      swipe.current = result.state;
      if (result.own) event.preventDefault();
      if (result.step) stepped.current(result.step);
    };
    element.addEventListener('wheel', wheel, {passive: false});
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(entries => {
      const measured = entries[0].contentRect.width;
      const drawn = Math.max(280, Math.round(measured));
      setWidth(drawn);
      setScale(measured ? measured / drawn : 1);
    });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const height = width < 560 ? 220 : 300;
  const left = 40;
  const right = 12;
  const top = 12;
  const bottom = 28;
  const span = Math.max(60_000, to - from);
  const x = (at: number) => left + ((Math.min(to, Math.max(from, at)) - from) / span) * (width - left - right);
  /** A cell is drawn at its middle (the last, partial one at "now"). */
  const bx = (cell: number) => x(Math.min(now, cell + cellMs / 2));
  const y = (value: number) => top + (1 - value / 100) * (height - top - bottom);
  const {ticks, daily} = niceTicks(from, to, width < 560 ? 4 : 7);

  const paths = useMemo(
    () =>
      lines.map(line => {
        const runs: [number, number][][] = [];
        let segment = -1;
        let previousX = -1;
        for (const [at, remaining, group] of line.points) {
          if (at + cellMs < from) continue;
          // The answer on screen may be of another period while the next loads: what lies past the end is not drawn.
          if (at > now) break;
          const px = bx(at);
          const py = y(remaining);
          if (group !== segment) {
            runs.push([]);
            segment = group;
          } else if (px - previousX < 0.5) continue;
          runs.at(-1)!.push([px, py]);
          previousX = px;
        }
        const fixed = (value: number) => value.toFixed(1);
        return {
          line: runs.map(run => run.map(([px, py], i) => `${i ? 'L' : 'M'}${fixed(px)},${fixed(py)}`).join('')).join(''),
          last: runs.at(-1)?.at(-1) ?? null,
        };
      }),
    [lines, from, now, span, width, height, cellMs],
  );

  const none = {left: false, plan: false, gap: false, forecast: false};
  const {rows, columns} = hover === null ? {rows: [], columns: none} : readCell(lines, plans, hover, cellMs, now, to, forecasts);
  const columnCount = Object.values(columns).filter(Boolean).length;
  // A cell ahead of now where no line reads anything says only what happens in it.
  const grid = rows.length > 0 && columnCount > 0;
  const markerReadout = hover === null ? [] : markers.filter(m => m.at >= hover && m.at < hover + cellMs);
  // Past the right edge: an announcement, then where windows run out, each said there,
  // how soon by the page's clock as the table says it, a series' name shortened to the plot.
  const pageNow = useNow(MINUTE);
  // Labels are measured: a web font that arrives later makes them as wide as they are drawn.
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    const loaded = () => setFonts(count => count + 1);
    document.fonts?.addEventListener('loadingdone', loaded);
    return () => document.fonts?.removeEventListener('loadingdone', loaded);
  }, []);
  const beyond = [
    ...markers
      .filter(m => m.strong && !m.past && m.at > to)
      .map(m => ({key: m.key, label: m.label, time: stamp(m.at), text: t('chart.ahead', {label: m.label, time: countdown(m.at - pageNow)}), color: undefined, say: undefined})),
    ...forecasts.flatMap(f => {
      if (f.at === null || f.at <= to) return [];
      // Spaces drawn as one: a name typed with two in a row reads, and measures, as SVG draws it.
      const name = f.name.replace(/\s+/g, ' ');
      const say = (label: string) => t('chart.runsOut', {label, time: countdown(f.at! - pageNow)});
      return [{key: `forecast-${f.key}`, label: name, time: t('forecast.runsOutAt', {time: stamp(f.at)}), text: say(name), color: f.color, say}];
    }),
  ];
  /** A label past the right edge pointed at or tapped: the tooltip tells its time instead of the cell's values. */
  const [edge, setEdge] = useState<{key: string; tapped: boolean} | null>(null);
  const edgeMarker = edge && beyond.find(m => m.key === edge.key);
  // A label taken away under the pointer (a step to a range, which has no future) says nothing
  // of it: what it told is forgotten, so the tooltip reads the cells again.
  useEffect(() => {
    if (edge && !edgeMarker) setEdge(null);
  }, [edge, edgeMarker]);
  useEffect(() => {
    if (!edge?.tapped) return;
    const hide = () => setEdge(null);
    const timer = setTimeout(hide, 4000);
    document.addEventListener('pointerdown', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', hide);
    };
  }, [edge]);

  const toChart = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * width;
  };
  const timeAt = (px: number) => from + ((px - left) / (width - left - right)) * span;
  dragging.current = drag !== null;
  // After a step the pointer stands over another time: the tooltip reads that.
  useEffect(() => {
    const px = pointer.current;
    if (px !== null && px >= left && px <= width - right) setHover(Math.floor(timeAt(px) / cellMs) * cellMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, cellMs]);
  // A label hides what runs under it: it stands at the bottom of the plot, or at the top
  // when more of the lines run near the bottom there (a limit about to run out).
  const labelY = (anchor: number, end: boolean) => {
    const [a, b] = (end ? [anchor - LABEL_WIDTH, anchor] : [anchor, anchor + LABEL_WIDTH]).map(timeAt);
    let low = 0;
    let high = 0;
    for (const line of lines) {
      for (const [at, value] of line.points) {
        if (at < a || at > b) continue;
        if (value < LABEL_BAND) low++;
        else if (value > 100 - LABEL_BAND) high++;
      }
    }
    return low > high ? top + 18 : height - bottom - 8;
  };
  // With labels past the right edge, an announcement inside the chart takes the first
  // place in their stack: a row of its own, so none lies over it, however wide they are.
  const announced = markers.filter(m => m.strong && !m.past && m.at <= to);
  const stacked = beyond.length ? announced.length + beyond.length : 0;
  // The stack stands at the top or the bottom of the plot, where it hides less of what
  // runs under it by the edge: the lines measured, planned and foreseen.
  const stackTop = (() => {
    if (!stacked) return false;
    const band = ((stacked * LABEL_STEP + 6) / (height - top - bottom)) * 100;
    const [a, b] = [width - right - LABEL_WIDTH, width - right].map(timeAt);
    let low = 0;
    let high = 0;
    const count = (value: number | undefined) => {
      if (value === undefined) return;
      if (value < band) low++;
      else if (value > 100 - band) high++;
    };
    for (const line of lines) for (const [at, value] of line.points) if (at >= a && at <= b) count(value);
    const across = [0, 0.25, 0.5, 0.75, 1].map(share => a + (b - a) * share);
    for (const forecast of forecasts) for (const at of across) count(valueAt([forecast.points], at));
    for (const plan of plans) for (const at of across) count(valueAt(plan.runs, at));
    return high < low;
  })();
  // Stacked from the first one away from the edge of the plot it stands by.
  const stackRows = edgeRows(
    announced.map(m => m.key),
    beyond.map(label => label.key),
    stackTop ? top + 18 : height - bottom - 8,
    stackTop,
  );
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const px = toChart(event);
    pointer.current = px;
    const held = holding.current;
    // A finger that moves before the hold is up reads values instead.
    if (held && Math.abs(px - held.px) > 8) cancelHold();
    if (drag) setDrag({...drag, end: Math.min(width - right, Math.max(left, px))});
    if (px < left || px > width - right) return setHover(null);
    setHover(Math.floor(timeAt(px) / cellMs) * cellMs);
  };
  const cancelHold = () => {
    if (holding.current) clearTimeout(holding.current.timer);
    holding.current = null;
  };
  // A mouse or a pen drags a range at once. A finger sliding along the chart reads its
  // values, as it always did; holding it still for a moment starts a range instead.
  const press = (event: PointerEvent<SVGSVGElement>) => {
    const px = toChart(event);
    // A label telling a time is read, not dragged from.
    if (!onSelect || event.button !== 0 || px < left || px > width - right || (event.target as Element).closest('.is-pointed')) return;
    const svg = event.currentTarget;
    const {pointerId} = event;
    const start = () => {
      holding.current = null;
      svg.setPointerCapture(pointerId);
      setDrag({start: px, end: px});
    };
    if (event.pointerType !== 'touch') return start();
    cancelHold();
    holding.current = {px, timer: setTimeout(start, HOLD_MS)};
  };
  // A drag of a few pixels is a click.
  const release = () => {
    cancelHold();
    if (!drag || !onSelect) return;
    setDrag(null);
    const range = Math.abs(drag.end - drag.start) >= 6 ? draggedRange(timeAt(drag.start), timeAt(drag.end), Math.min(now, hubNow())) : null;
    if (range) onSelect(range);
  };
  // A cell ahead of now is read at its middle; the one holding now, at now.
  const hoverX = hover === null ? 0 : hover > now ? x(Math.min(to, hover + cellMs / 2)) : bx(hover);
  // A step through time slides what the chart shows in from the side it came from. The
  // layers that move are clipped to the plot meanwhile, so nothing passes over the scale.
  const clip = useId();
  const shown = useRef<{from: number; end: number} | null>(null);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = {from, end: now};
    const element = svg.current;
    if (!before || !element || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dx = slideOf(before, {from, end: now, to}, width - left - right);
    if (!dx) return;
    for (const layer of element.querySelectorAll<SVGGElement>('.slides')) {
      const frame = layer.parentElement!;
      // A step taken while the last one still slides goes on from where that one is, not back.
      const moving = getComputedStyle(layer).transform;
      const start = dx + (moving === 'none' ? 0 : new DOMMatrix(moving).m41);
      layer.getAnimations().forEach(animation => animation.cancel());
      frame.setAttribute('clip-path', `url(#${CSS.escape(clip)})`);
      const animation = layer.animate([{transform: `translateX(${start}px)`}, {transform: 'none'}], {duration: SLIDE_MS, easing: 'cubic-bezier(.2, .7, .3, 1)'});
      animation.onfinish = () => frame.removeAttribute('clip-path');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, now]);

  // On a narrow chart it spans the chart's width under the plot, over what comes below, and
  // rises over the plot as far as keeps it whole in the window (a phone with many lines),
  // though never under the bars that stick at the top.
  // It is measured after every render while it shows, whatever changed it (its rows, a new
  // answer moving the chart, the pointer), and as the page scrolls under a pointer that stays.
  const tip = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(200);
  const [lift, setLift] = useState(0);
  const narrow = width < 560;
  const measureTip = useRef(() => {});
  measureTip.current = () => {
    const element = tip.current;
    if (!element) return;
    // Its own width, not as narrowed to the side it stands on: where it goes depends on it.
    const cap = element.style.maxWidth;
    element.style.maxWidth = '';
    setTipWidth(element.offsetWidth);
    element.style.maxWidth = cap;
    // Only the one under a narrow chart rises; a marker's time stands over its label.
    if (!narrow || edgeMarker || !svg.current) return setLift(0);
    // Where it stands unraised is read from the chart, never from itself, so what it finds
    // does not depend on what it found before.
    const top = svg.current.getBoundingClientRect().bottom + parseFloat(getComputedStyle(element).marginTop);
    const bars = [...document.querySelectorAll<HTMLElement>('.topbar, .analytics-head')].filter(bar => getComputedStyle(bar).position === 'sticky');
    const cover = Math.max(0, ...bars.map(bar => bar.getBoundingClientRect().bottom));
    setLift(liftOf(top, element.getBoundingClientRect().height, innerHeight, cover));
  };
  // No dependencies: the same values found again change nothing, so it settles in one pass.
  useLayoutEffect(() => measureTip.current());
  useEffect(() => {
    if (!narrow) return;
    const scrolled = () => measureTip.current();
    addEventListener('scroll', scrolled, {passive: true});
    return () => removeEventListener('scroll', scrolled);
  }, [narrow]);
  // Beside the pointer: right of it, or left, or where there is more room when it fits
  // neither side, narrowed to that room (its names wrap) rather than over the pointer.
  const roomRight = width - hoverX - 12;
  const roomLeft = hoverX - 12;
  const onRight = tipWidth <= roomRight || (tipWidth > roomLeft && roomRight >= roomLeft);
  const tipRoom = Math.min(360, Math.max(0, onRight ? roomRight : roomLeft));
  const tipLeft = onRight ? hoverX + 12 : Math.max(0, hoverX - 12 - Math.min(tipWidth, tipRoom));
  const bandWidth = Math.max(1, x(Math.min(to, (hover ?? 0) + cellMs)) - x(hover ?? 0));

  return (
    <div className="chart" ref={box}>
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('chart.label')}
        className={onSelect ? 'is-selectable' : undefined}
        onPointerMove={move}
        onPointerLeave={() => {
          pointer.current = null;
          setHover(null);
        }}
        onPointerDown={press}
        onPointerUp={release}
        onPointerCancel={() => {
          cancelHold();
          setDrag(null);
        }}
        // A held finger starts a range, not the page's menu.
        onContextMenu={event => (holding.current || drag) && event.preventDefault()}
      >
        <defs>
          <clipPath id={clip}>
            <rect x={left} y={0} width={width - left - right} height={height} />
          </clipPath>
        </defs>
        <g>
          <g className="slides">
            {to > now && (
              <g className="future">
                <rect x={x(now)} width={x(to) - x(now)} y={top} height={height - top - bottom} className="future-zone" />
                <line x1={x(now)} x2={x(now)} y1={top} y2={height - bottom} className="now-line" />
              </g>
            )}
          </g>
        </g>
        <line x1={left} x2={width - right} y1={y(30)} y2={y(30)} className="threshold warn" />
        <line x1={left} x2={width - right} y1={y(10)} y2={y(10)} className="threshold crit" />
        {[0, 25, 50, 75, 100].map(value => (
          <g key={value}>
            <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={value === 0 ? 'axis-line' : 'grid'} />
            <text x={left - 8} y={y(value) + 4} textAnchor="end" className="tick">
              {value}%
            </text>
          </g>
        ))}
        <g>
          <g className="slides">
            {ticks.map(tick => (
              <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="tick">
                {daily ? shortDay(tick) : clock(tick)}
              </text>
            ))}
          </g>
        </g>

        <g>
          <g className="slides">
            {plans.map(plan => (
              <path
                key={plan.key}
                className="plan-line"
                stroke={plan.color}
                d={plan.runs.map(run => run.map(([at, value], i) => `${i ? 'L' : 'M'}${x(at).toFixed(1)},${y(value).toFixed(1)}`).join('')).join('')}
              />
            ))}
            {forecasts.map(forecast => (
              <path
                key={forecast.key}
                className="forecast-line"
                stroke={forecast.color}
                strokeDasharray={forecast.dash || undefined}
                d={forecast.points.map(([at, value], i) => `${i ? 'L' : 'M'}${x(at).toFixed(1)},${y(value).toFixed(1)}`).join('')}
              />
            ))}
            {markers.map(marker => {
              if (marker.at > to) return null;
              const mx = x(marker.at);
              if (marker.past) {
                return (
                  <g key={marker.key} className="marker is-event">
                    <line x1={mx} x2={mx} y1={top} y2={height - bottom} stroke={marker.color} />
                    <path d={diamond(mx, top)} fill={marker.color} />
                    <title>{[`${marker.label} · ${cellLabel(marker.at, 0)}`, marker.detail].filter(Boolean).join('\n')}</title>
                  </g>
                );
              }
              return (
                <g key={marker.key} className={`marker ${marker.strong ? 'is-strong' : ''}`}>
                  <line x1={mx} x2={mx} y1={top} y2={height - bottom} stroke={marker.strong ? undefined : marker.color} />
                  {!marker.strong && <circle cx={mx} cy={y(100)} r={3} fill={marker.color} />}
                  <title>{`${marker.label} · ${cellLabel(marker.at, 0)}`}</title>
                </g>
              );
            })}
            {lines.map((line, i) => (
              <path key={line.key} d={paths[i].line} className="series" stroke={line.color} strokeDasharray={line.dash || undefined} />
            ))}
            {/* Announcements are read over the lines, each on its own backing. */}
            {announced.map(marker => {
              const mx = x(marker.at);
              const nearRight = mx > width - right - 150;
              const lx = nearRight ? mx - 6 : mx + 6;
              return (
                <MarkerLabel key={marker.key} x={lx} y={stackRows.get(marker.key) ?? labelY(lx, nearRight)} end={nearRight} fonts={fonts}>
                  {marker.label}
                </MarkerLabel>
              );
            })}
            {/* Beyond the visible future: at the right edge, with the distance, one under another. */}
            {beyond.map(label => (
              <MarkerLabel
                key={label.key}
                x={width - right}
                y={stackRows.get(label.key)!}
                end
                color={label.color}
                fonts={fonts}
                // It ends at the plot's right edge, and its backing, 6 wider than the text, starts within the plot.
                shorten={label.say && {name: label.label, say: label.say, room: width - left - right - 6}}
                onTip={(shown, tapped) => setEdge(shown ? {key: label.key, tapped} : null)}
              >
                {label.text}
              </MarkerLabel>
            ))}
            {hover === null &&
              lines.map((line, i) =>
                paths[i].last ? (
                  <g key={`${line.key}-end`} className="line-end">
                    <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={7} fill={line.color} opacity={0.18} />
                    <circle cx={paths[i].last![0]} cy={paths[i].last![1]} r={3} fill={line.color} />
                  </g>
                ) : null,
              )}
          </g>
        </g>
        {drag && (
          <rect x={Math.min(drag.start, drag.end)} width={Math.abs(drag.end - drag.start)} y={top} height={height - top - bottom} className="selection" />
        )}
        {hover !== null && (
          <g className="crosshair">
            <rect x={x(hover)} width={bandWidth} y={top} height={height - top - bottom} className="hover-band" />
            <line x1={hoverX} x2={hoverX} y1={top} y2={height - bottom} />
            {rows.map(row => row.value !== null && <circle key={row.line.key} cx={hoverX} cy={y(row.value)} r={4} fill={row.line.color} />)}
          </g>
        )}
      </svg>

      {edgeMarker ? (
        <Tooltip tip={tip} className="is-edge" style={{right: 0, bottom: `calc(100% - ${(stackRows.get(edgeMarker.key)! - 18) * scale}px)`}}>
          <div className={`tooltip-marker ${edgeMarker.color ? '' : 'is-strong'}`} style={edgeMarker.color ? {color: edgeMarker.color} : undefined}>
            {edgeMarker.label}
          </div>
          <div className="tooltip-time">{edgeMarker.time}</div>
        </Tooltip>
      ) : (
        hover !== null &&
        !drag &&
        (rows.some(row => row.left !== null || row.plan !== null || row.forecast !== null) || markerReadout.length > 0) && (
          <Tooltip tip={tip} className={narrow ? 'is-below' : ''} style={narrow ? {top: height * scale - lift} : {left: tipLeft, maxWidth: tipRoom}}>
            <div className="tooltip-time">{cellLabel(hover, cellMs)}</div>
            {grid && (
              <div className="tooltip-grid" style={{gridTemplateColumns: `14px minmax(0, 1fr) repeat(${columnCount}, auto)`}}>
                <span />
                <span />
                {columns.left && <span className="tooltip-head">{t('chart.left')}</span>}
                {columns.plan && <span className="tooltip-head">{t('chart.plan')}</span>}
                {columns.gap && <span className="tooltip-head">{t('chart.gap')}</span>}
                {columns.forecast && <span className="tooltip-head">{t('chart.forecast')}</span>}
                {rows.map(row => (
                  <div className="tooltip-row" key={row.line.key}>
                    <svg width="14" height="4" aria-hidden="true">
                      <line x1="0" x2="14" y1="2" y2="2" stroke={row.line.color} strokeWidth="2" strokeDasharray={row.line.dash || undefined} />
                    </svg>
                    <span className="tooltip-name">{row.line.name}</span>
                    {columns.left && <strong>{row.left !== null && `${num(row.left)}%`}</strong>}
                    {columns.plan && <span className="tooltip-plan">{row.plan !== null && `${num(row.plan)}%`}</span>}
                    {columns.gap && <span className={`tooltip-gap ${row.gap !== null ? gapTone(row.gap) : ''}`}>{row.gap !== null && gapText(row.gap)}</span>}
                    {columns.forecast && <span className="tooltip-forecast">{row.forecast !== null && `${num(row.forecast)}%`}</span>}
                  </div>
                ))}
              </div>
            )}
            {grid && markerReadout.length > 0 && <div className="tooltip-sep" />}
            {markerReadout.map(marker => (
              <div className={`tooltip-mark ${marker.strong ? 'is-strong' : ''}`} key={marker.key}>
                <svg width="14" height="10" aria-hidden="true">
                  {marker.past ? (
                    <path d={diamond(7, 5)} fill={marker.color} />
                  ) : (
                    <line x1="7" x2="7" y1="0" y2="10" stroke={marker.strong ? 'var(--accent)' : marker.color} strokeWidth="2" />
                  )}
                </svg>
                <strong>{clock(marker.at)}</strong>
                <span>{marker.label}</span>
                {marker.detail && <small className="tooltip-detail">{marker.detail}</small>}
              </div>
            ))}
          </Tooltip>
        )
      )}
      {!lines.length && empty && <div className="chart-empty">{empty}</div>}
    </div>
  );
}

/** The chart's own tooltip, glass as the popovers are; it lies over the widgets below, under the sticky bars. */
function Tooltip({tip, className, style, children}: {tip: RefObject<HTMLDivElement | null>; className: string; style: CSSProperties; children: ReactNode}) {
  return (
    <div className={`tooltip glass ${className}`} ref={tip} style={style}>
      {children}
    </div>
  );
}
