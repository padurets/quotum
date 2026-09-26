import {
  agentsWork,
  ALWAYS,
  DAY,
  fixed,
  HOUR,
  idle,
  alongPlan,
  MIN,
  rolling,
  SECOND,
  steady,
  through,
  noReset,
  waveWork,
  weekly,
  type Agent,
  type Answer,
  type DemoSet,
  type Scene,
  type Wave,
  type Work,
} from './model.js';

/**
 * The catalogue of the demo board: every state the dashboard knows today, one entry each.
 *
 * An entry is one object: a card (a subscription with its windows over time, the machines
 * that measure it, its agents and failures, and how it looks on each board), a scene of
 * the reset trackers, a board, a person or a machine with something of its own. People
 * and machines are made by the names entries refer to them by; a machine needs an entry
 * only for what sets it apart (its system, sleep, a code, a name given on the hub,
 * failures).
 *
 * Every entry says in `expect` what it shows, in codes the dashboard's own rules
 * (hub/ui/lib) compute from what the hub answers: `npm test` brings the set up on a hub
 * and checks each code over its span while time runs (the showcase, at `start`), so an
 * entry that stops showing its state fails the test. What only eyes can tell (an ellipsis, a colour, two cards in one
 * row) is `look`, checked by hand on the running board, in both languages.
 *
 * Time. Everything is in milliseconds from `start`, when the demo started, rounded down to
 * a minute; the data is the same for every start. A code holds by default over the
 * first twelve hours, [start, start + 12 h], so:
 * - a card's claimed state lives on weekly windows that reset after `start + 12 h 10 min`,
 *   within day 6 of the plan meanwhile;
 * - ahead of and behind the plan is 12–15 points either way, and levels keep a margin to
 *   their thresholds; five-hour windows of such cards are left out of `expect`, or stay
 *   `ok` with no note;
 * - a scene holds for twelve hours, its times from `start` too.
 *
 * Exceptions, by name: the last day of the plan (6–6.45 days into the week at `start`)
 * and the stale card (on a machine that never comes back, its five hours already over).
 * What lives by design holds only a short span from `start` and is checked in the first
 * minutes of a run, or by starting it again: the sleeping machine, agents that come and
 * go, a five-hour window ahead of its pace or foreseen between two of its resets, a week
 * begun too recently to be foreseen (8.4 hours). A code about a change of agents begins
 * 15 seconds after it at the earliest, when a list that shows it has gone out. The cards
 * measured at the hub's pace (`paced`) say what their dot tells of the next measurement
 * for minutes from `start`, one resetting ten minutes in: a test of their own asks every
 * 15 seconds as their machine does, while the long one measures them on its rhythm and
 * leaves those codes out.
 *
 * A new state gets an entry here with at least one code; the test picks it up.
 */

const WEEK_PLAN_FLAT = [15, 15, 15, 15, 15, 15, 10];

/** Agents working 12 of every 20 minutes, staggered by `shift` minutes. */
const shifts = (shift: number): Wave => ({period: 20 * MIN, on: 12 * MIN, phase: shift * MIN});

/** Work on and off, 12 of every 20 minutes, for a subscription without agents of its own. */
const onAndOff = (shift: number): Work => waveWork(shifts(shift));

/**
 * A five-hour window spending `perHour` points an hour of full work, back to back from
 * `offset`. Where a card has agents, its work is theirs once they start: the window goes while they work.
 */
const fiveHours = (offset: number, perHour: number, work: Work = waveWork(ALWAYS), label?: string) =>
  rolling({id: label ? `${label.split(' ')[0].toLowerCase()}:session` : 'session', label, offset, work, use: (_elapsed, busy) => (perHour * busy) / HOUR});

const LONG_PROJECT =
  'platform-monorepo/services/billing-reconciliation-worker/migrations/2026-09-backfill-invoices-with-missing-tax-regions-and-currency-rounding-fixes-for-eu';

const agents = (machine: string, list: [Agent['origin'], string | null, number, Wave?, string?][]): Agent[] =>
  list.map(([origin, project, since, works, folder]) => ({machine, origin, project, folder, since, works}));

// ---------- reset scenes ----------

const codex = (data: object): Answer => ({json: {meta: {api_version: 'v1', generated_at: null}, data: {latest_reset: null, scheduled_reset: null, active_watch: null, ...data}}});
const claude = (claudeEvents: object[], codexEvents: object[] = []): Answer => ({json: {providers: {claude: {events: claudeEvents}, codex: {events: codexEvents}}, meta: {}}});
const quiet = () => claude([]);

/**
 * Most scenes say two things at once, as the trackers do: what a card shows is the most
 * pressing of them (an announced reset, then a possible one, then one that just happened,
 * then a change of limits).
 */
export const SCENES: Scene[] = [
  {
    kind: 'scene',
    id: 'announced',
    codex: at =>
      codex({
        scheduled_reset: {reset_type: 'regular', announced_at: at(-5 * HOUR), scheduled_for: at(26 * HOUR), text: 'Rate limits reset for all Plus and Pro plans tomorrow.'},
        latest_reset: {announced_at: at(-4 * HOUR), text: 'Limits were reset for everyone.'},
      }),
    claude: at => claude([{kind: 'reset', date: at(-3 * HOUR), scope: 'Max', note: 'Weekly limits reset for Max plans.'}, {kind: 'policy', date: at(-DAY), note: 'New weekly limits.'}]),
    expect: [
      {reset: 'codex', label: 'in'},
      {reset: 'claude', label: 'done', scope: 'Max'},
      {tracker: 'Codex Resets', health: 'ok'},
      {tracker: 'Claude Resets', health: 'ok'},
      {marked: 'codex', resets: 1},
      {marked: 'claude', resets: 1},
    ],
    look: [
      'Codex cards: an accent mark "in 25h" on the left of the tray (the time is rounded down), not the reset of four hours ago; its panel heads with "Reset in 25h" and the date and time under it, then why it matters, the tracker\'s text and "Data from Codex Resets"',
      'Claude cards: a quiet mark, an arrow round a tick, not the change of limits of yesterday; its panel heads with "Reset happened", a "Max" tag beside it and the time under it',
      'Both resets for everyone are marked on the charts',
      'On 24 hours with the plan or the forecast shown, the Codex reset is pointed at from the right edge ("… in 25h →"): pointing at it or tapping it tells its date and time',
    ],
  },
  {
    kind: 'scene',
    id: 'banked',
    codex: at =>
      codex({
        scheduled_reset: {reset_type: 'banked', announced_at: at(-HOUR), scheduled_for: at(20 * HOUR), text: 'Banked resets land tonight.'},
        active_watch: {observed_at: at(-2 * HOUR), expires_at: at(22 * HOUR), reset_chance_percent: 30, forecast_window: 'today', text: 'More resets may follow.'},
      }),
    claude: quiet,
    expect: [
      {reset: 'codex', label: 'bankedIn'},
      {reset: 'claude', label: null},
    ],
    look: ['Codex: "in 19h" on the mark, "Banked reset in 19h" in its panel; no mark on Claude cards'],
  },
  {
    kind: 'scene',
    id: 'unscheduled',
    codex: at => codex({scheduled_reset: {reset_type: 'regular', announced_at: at(-2 * HOUR), scheduled_for: null, text: 'Another reset is coming, time to be announced.'}}),
    claude: at => claude([{kind: 'policy', date: at(-DAY), note: 'Five-hour windows changed.'}]),
    expect: [
      {reset: 'codex', label: 'announced'},
      {reset: 'claude', label: 'policy'},
    ],
    look: ['Codex: an accent mark with no text, "Reset announced" in its panel', 'Claude: a quiet gauge, "Limits changed" with the time under it'],
  },
  {
    kind: 'scene',
    id: 'awaiting',
    codex: at =>
      codex({
        scheduled_reset: {reset_type: 'regular', announced_at: at(-2 * DAY), scheduled_for: at(-3 * HOUR), text: 'Reset scheduled for this morning.'},
        latest_reset: {announced_at: at(-10 * HOUR), text: 'Limits were reset for everyone.'},
      }),
    claude: at => claude([{kind: 'reset', date: at(-2 * HOUR), scope: 'all', note: 'Limits reset for everyone.'}]),
    expect: [
      {reset: 'codex', label: 'awaiting'},
      {reset: 'claude', label: 'done', scope: ''},
      {marked: 'codex', resets: 1},
    ],
    look: ['Codex: an accent mark with no text, "Reset: awaiting confirmation" with the announced time under it', 'The Claude mark\'s panel names no scope: the reset was for everyone'],
  },
  {
    kind: 'scene',
    id: 'possible',
    codex: at =>
      codex({
        active_watch: {observed_at: at(-2 * HOUR), expires_at: at(20 * HOUR), reset_chance_percent: 40, forecast_window: 'next 24 hours', text: 'Usage dashboards hint at another reset.'},
        latest_reset: {announced_at: at(-2 * HOUR), text: 'Limits were reset for some accounts.'},
      }),
    claude: at => claude([{kind: 'policy', date: at(-2 * DAY), note: 'New weekly limits.'}]),
    expect: [
      {reset: 'codex', label: 'possible', chance: 40},
      {reset: 'claude', label: 'policy'},
    ],
    look: ['Codex: a quiet dashed mark "40%"; its panel heads with "Possible reset", a "40%" tag beside it and "by <time>" under it'],
  },
  {
    kind: 'scene',
    id: 'possible-no-chance',
    codex: at => codex({active_watch: {observed_at: at(-HOUR), expires_at: null, reset_chance_percent: null, forecast_window: 'this week', text: 'People report resets on some accounts.'}}),
    claude: quiet,
    expect: [
      {reset: 'codex', label: 'possible', chance: null},
      {reset: 'claude', label: null},
    ],
    look: ['Codex: a quiet dashed mark with no text; its panel says "Possible reset" with no chance after it, and no time'],
  },
  {
    kind: 'scene',
    id: 'reset',
    codex: at => codex({latest_reset: {announced_at: at(-4 * HOUR), text: 'Limits were reset for everyone.'}}),
    claude: at => claude([{kind: 'reset', date: at(-HOUR), scope: 'Pro', note: 'Weekly limits reset for Pro plans.'}, {kind: 'policy', date: at(-2 * HOUR), note: 'New weekly limits.'}]),
    expect: [
      {reset: 'codex', label: 'done', scope: ''},
      {reset: 'claude', label: 'done', scope: 'Pro'},
      {marked: 'codex', resets: 1},
      {marked: 'claude', resets: 1},
    ],
  },
  {
    kind: 'scene',
    id: 'policy',
    // Codex Resets is down: Codex falls back on the Codex part of Claude Resets. Its resets
    // are older than a day, so the change of limits is the news.
    codex: () => ({status: 503}),
    claude: at =>
      claude(
        [{kind: 'policy', date: at(-DAY), note: 'New weekly limits.'}, {kind: 'reset', date: at(-80 * HOUR), scope: 'Max', note: 'Weekly limits reset for Max plans.'}],
        [{kind: 'policy', date: at(-6 * HOUR), note: 'Five-hour windows changed.'}, {kind: 'reset', date: at(-80 * HOUR), note: 'Limits were reset for everyone.'}],
      ),
    expect: [
      {reset: 'codex', label: 'policy'},
      {reset: 'claude', label: 'policy'},
      {tracker: 'Codex Resets', health: 'HTTP 503'},
      {tracker: 'Claude Resets', health: 'ok'},
      // Older than a day, the reset is off the 24-hour chart and on the week's.
      {marked: 'codex', resets: 0},
      {marked: 'codex', resets: 1, range: '7d'},
    ],
    look: ['The Codex mark\'s panel links its source, claude-resets.com, apart from the credit to Codex Resets'],
  },
  {
    kind: 'scene',
    id: 'quiet',
    codex: () => codex({}),
    claude: quiet,
    expect: [
      {reset: 'codex', label: null},
      {reset: 'claude', label: null},
      {tracker: 'Codex Resets', health: 'ok'},
    ],
  },
  {
    kind: 'scene',
    id: 'blocked',
    codex: () => 'challenge',
    claude: () => ({status: 429}),
    expect: [
      {tracker: 'Codex Resets', health: 'challenge'},
      {tracker: 'Claude Resets', health: 'HTTP 429'},
      {reset: 'codex', label: null},
    ],
    look: ['Account → reset trackers: both in trouble, named'],
  },
  {
    kind: 'scene',
    id: 'broken',
    codex: () => 'format',
    claude: () => 'network',
    expect: [
      {tracker: 'Codex Resets', health: 'format'},
      {tracker: 'Claude Resets', health: 'network'},
    ],
  },
  {
    kind: 'scene',
    id: 'timeout',
    codex: () => 'timeout',
    claude: () => 'timeout',
    expect: [
      {tracker: 'Codex Resets', health: 'timeout'},
      {tracker: 'Claude Resets', health: 'timeout'},
    ],
    look: ['The trackers show "checking" for the first 10 seconds, then "timeout"'],
  },
  {
    kind: 'scene',
    id: 'showcase',
    codex: at => codex({scheduled_reset: {reset_type: 'regular', announced_at: at(-5 * HOUR), scheduled_for: at(2 * DAY + 3 * HOUR), text: 'Rate limits reset for all plans on Friday.'}}),
    claude: quiet,
    expect: [
      {reset: 'codex', label: 'in'},
      {reset: 'claude', label: null},
    ],
  },
];

// ---------- agents, and the work they do on their cards ----------

// Ana's quotum, as the agent tells it: on the laptop in its main folder, a worktree and a
// folder inside it; on the build server a clone under another name.
const MAX_AGENTS: Agent[] = [
  ...agents('laptop', [
    ['terminal', 'quotum', -3 * HOUR, shifts(0)],
    ['terminal', 'quotum', -70 * MIN, shifts(4), 'quotum.feat-18-desktop-app'],
    ['terminal', 'infra', -2 * HOUR],
    ['editor', 'mobile-app', -5 * HOUR],
    ['app', null, -40 * MIN],
    ['terminal', LONG_PROJECT, -25 * MIN, shifts(8)],
  ]),
  ...agents('build-01', [
    ['terminal', 'docs-site', -4 * HOUR, shifts(2)],
    ['terminal', 'Quotum', -90 * MIN, shifts(10)],
    ['terminal', 'nightly-release', -6 * HOUR],
    ['editor', 'design-tokens-and-theme-migration-for-web', -30 * MIN],
  ]),
];

/** Eleven, one more than a tray draws; within the first quarter of an hour one more starts and one stops. */
const PRO_AGENTS: Agent[] = [
  {machine: 'laptop', origin: 'terminal', project: 'checkout', since: -2 * HOUR, until: 10 * MIN, works: shifts(1)},
  {machine: 'laptop', origin: 'terminal', project: 'hotfix-4821', since: 5 * MIN, works: ALWAYS},
  ...agents('laptop', [
    ['terminal', null, -3 * HOUR, shifts(5)],
    ['terminal', 'quotum', -50 * MIN, shifts(9), 'hub'],
    ['editor', 'admin-console', -4 * HOUR],
    ['app', 'support-bot', -1 * HOUR],
    ['terminal', 'notifications', -15 * MIN, {period: 4 * MIN, on: 2 * MIN, phase: 0}],
  ]),
  ...agents('win-desktop', [
    ['terminal', 'desktop-client', -5 * HOUR, shifts(6)],
    ['terminal', 'installer', -80 * MIN, shifts(11)],
    ['editor', 'telemetry-dashboard', -2 * HOUR],
    ['terminal', 'localization', -35 * MIN],
    ['app', null, -10 * MIN],
  ]),
];

/** One long job, at work all the time: the five hours run ahead of an even pace. */
const AHEAD_AGENTS: Agent[] = agents('build-01', [['terminal', 'billing', -90 * MIN, ALWAYS]]);

const IOS_AGENTS: Agent[] = agents('mac-mini', [
  ['terminal', 'ios-app', -30 * MIN, shifts(0)],
  ['editor', 'ios-app', -2 * HOUR],
]);

/** A narrow card with a full tray: reset news, free resets and ten agents on two machines. */
const ON_CALL_AGENTS: Agent[] = [
  ...agents('win-desktop', [
    ['terminal', 'on-call', -3 * HOUR, shifts(1)],
    ['terminal', 'incident-4412', -40 * MIN],
    ['terminal', 'runbooks', -2 * HOUR, shifts(7)],
    ['editor', 'alerts', -5 * HOUR],
    ['terminal', 'terraform', -90 * MIN, shifts(13)],
  ]),
  ...agents('build-01', [
    ['terminal', 'deploys', -4 * HOUR, shifts(3)],
    ['terminal', 'canary', -25 * MIN],
    ['terminal', 'status-page', -70 * MIN, shifts(9)],
    ['app', null, -2 * HOUR],
    ['terminal', 'postmortems', -6 * HOUR, shifts(15)],
  ]),
];

const TEAM_AGENTS: Agent[] = [
  ...agents('laptop', [
    ['terminal', 'shared-infra', -HOUR, shifts(3)],
    ['terminal', 'shared-docs', -20 * MIN],
  ]),
  ...agents('ben-mac', [['terminal', 'shared-infra', -3 * HOUR, shifts(9)]]),
];

// ---------- the whole catalogue ----------

const all: DemoSet = {
  id: 'all',
  about: 'every state the dashboard knows',
  scene: 'announced',
  entries: [
    // People and boards. Ana is the first person: her personal board holds almost everything.
    {
      kind: 'person',
      id: 'ana',
      name: 'Ana',
      agents: true,
      projects: {'docs-site': 'docs'},
      // Each group has a working agent that works within the first twenty minutes.
      expect: [
        {state: 'widgets'},
        {weeklySeries: 10},
        {project: 'quotum', machines: ['laptop'], reported: [], from: 20 * MIN},
        {project: 'hub', absent: true, from: 20 * MIN},
        {project: 'quotum.feat-18-desktop-app', absent: true, from: 20 * MIN},
        {project: 'Quotum', machines: ['Build server'], from: 20 * MIN},
        {project: 'billing', machines: ['Build server'], from: 20 * MIN},
        {project: 'docs', machines: ['Build server'], reported: ['docs-site'], from: 20 * MIN},
        {project: null, from: 20 * MIN},
        // The table of agents: the project, and under it the folder where that is another,
        // the corrected name too (docs-site is where docs works).
        {agentsOf: 'quotum', folders: [null, 'hub', 'quotum.feat-18-desktop-app']},
        {agentsOf: 'docs', folders: ['docs-site']},
      ],
      look: [
        'The table of agents lists many rows, by activity',
        'The chart\'s tooltip has a row for every line in the legend\'s order, with what is left, the plan and the gap in columns, and ahead of now where each forecast leads in a column of its own; on a phone it stays whole on the screen',
        'The chart\'s settings switch the plan and the forecast on and off, under "On the chart"',
        'My machines → Projects: quotum once, on the laptop, though three agents work in three folders (the tray and the table show quotum three times, with hub and quotum.feat-18-desktop-app under two of them)',
        'Renamed or merged in My machines, a project is shown under its new name in the tray and the table too',
        'Merge Quotum into quotum: one row, with both machines and "from: Quotum"; give Quotum back its name: as it was',
        'docs gathers docs-site, and gives it back',
        'Escape in the merge menu closes only the menu',
        'The merge menu with many selected, at the bottom of the dialog: its glass is whole',
        'My machines → Projects shows no agent time',
      ],
    },
    {kind: 'person', id: 'ben', name: 'Ben', agents: true, expect: [{state: 'widgets'}, {rows: 1}]},
    {kind: 'person', id: 'cleo', name: 'Cleo', expect: [{state: 'onboarding'}], look: ['Cleo has no machines: her board asks her to connect one']},
    {
      kind: 'board',
      id: 'team',
      name: 'Team',
      owner: 'ana',
      members: ['ben'],
      agents: true,
      expect: [{state: 'widgets'}, {rows: 3}],
      look: ['Cards are named with their owners', 'Ben sees Team as a member: no arranging, no invites'],
    },
    {kind: 'board', id: 'quiet', name: 'Quiet corner', owner: 'ana', members: [], agents: true, expect: [{rows: 'none'}]},
    {kind: 'board', id: 'night', name: 'Night shift', owner: 'ana', members: [], agents: true, expect: [{rows: 'noneShown'}]},
    {kind: 'board', id: 'empty', name: 'Empty board', owner: 'ana', members: ['cleo'], expect: [{state: 'onboarding'}]},

    // Machines with something of their own; the rest are Ana's, on Linux, with her machine token.
    {kind: 'machine', id: 'laptop', expect: [{os: 'linux'}, {via: 'token'}]},
    {kind: 'machine', id: 'build-01', renamed: 'Build server', expect: [{name: 'Build server'}]},
    {kind: 'machine', id: 'mac-mini', os: 'macos', sleeps: true, expect: [{os: 'macos'}], look: ['Asleep at night in the history: gaps on the 7-day chart']},
    {kind: 'machine', id: 'win-desktop', os: 'windows', byCode: true, expect: [{via: 'code'}, {os: 'windows'}]},
    {
      kind: 'machine',
      id: 'ci-runner',
      failures: [
        {provider: 'claude', error: 'not_installed'},
        {provider: 'antigravity', error: 'invalid_output'},
      ],
      expect: [{failure: {provider: 'claude', error: 'not_installed'}}, {failure: {provider: 'antigravity', error: 'invalid_output'}}],
    },
    {
      kind: 'machine',
      id: 'old-nuc',
      gone: -3 * HOUR,
      expect: [{via: 'token'}],
      look: ['«My machines» shows it seen when the demo started, not three hours ago: the hub dates every contact by its own clock'],
    },
    {kind: 'machine', id: 'ben-mac', person: 'ben', os: 'macos', failures: [{provider: 'antigravity', error: 'failed'}], expect: [{failure: {provider: 'antigravity', error: 'failed'}}]},

    // Cards. Their order is the board's, and the order in which they come to the hub.
    {
      kind: 'card',
      id: 'claude-max',
      provider: 'claude',
      plan: 'Claude Max',
      machines: ['laptop', 'build-01'],
      // The longest history of the demo: 30 days are full, and ‹ goes back half a month more.
      history: 45 * DAY,
      windows: [
        fiveHours(20 * MIN, 25, agentsWork(MAX_AGENTS, shifts(0))),
        weekly({since: -1.5 * DAY, use: alongPlan(0)}),
        weekly({id: 'weekly:fable', label: 'Fable', since: -1.5 * DAY, use: through([0, 0], [0.5, 6], [1.5, 12])}),
      ],
      agents: MAX_AGENTS,
      on: {ana: {}, team: {hidden: true}},
      expect: [
        {title: 'Claude'},
        {error: null},
        {stale: false},
        {agents: 10, drawn: true},
        {window: 'weekly', name: 'Weekly', level: 'ok', note: null, reset: 'resetsIn', started: true},
        {window: 'weekly:fable', name: 'Fable · weekly', note: 'behind'},
        {window: 'session', name: '5 hours', note: null},
        {forecast: 'weekly', outlook: 'onPacePlan'},
        {forecast: 'weekly:fable', outlook: 'leftPlan', plan: 'behind'},
        {reachesBack: 45},
      ],
      look: [
        'Its reset news is a mark on the left of the tray; the Antigravity card in its row has none',
        'Its Fable forecast line bends where the plan\'s days end, above the dotted plan it shares with the weekly window, whose own forecast lies on the plan',
        'On 30 days the chart is full; ‹ goes back twice, the second time to where history starts, and is off there',
        'Ten marks in the tray, in two groups (two machines); the panel names working, waiting and open-window agents',
        'The long project name ends in an ellipsis; the agent without a project says so',
      ],
    },
    {
      kind: 'card',
      id: 'antigravity',
      provider: 'antigravity',
      plan: 'Ultra',
      machines: ['laptop'],
      history: 14 * DAY,
      windows: [
        fiveHours(50 * MIN, 8, onAndOff(15), 'Gemini Pro'),
        // A seventh of the week a day: on pace to spend it all by the reset.
        weekly({id: 'gemini:weekly', label: 'Gemini', since: -3 * DAY, use: steady(0, 100 / 7)}),
        // A client that does not say when this one resets.
        noReset(weekly({id: 'claude:weekly', label: 'Claude', since: -3 * DAY, use: steady(0, 8)})),
        rolling({id: 'flash:window-1440', kind: 'other', label: 'Flash', minutes: 1440, offset: -8 * HOUR, use: elapsed => (1.5 * elapsed) / HOUR}),
        fixed({id: 'credits', label: 'Credits', used: 40}),
      ],
      on: {ana: {plan: 'off'}},
      expect: [
        {title: 'Antigravity'},
        {window: 'gemini:session', name: 'Gemini Pro · 5 hours'},
        {window: 'claude:weekly', name: 'Claude · weekly', note: null, reset: 'resetUnknown'},
        {window: 'flash:window-1440', name: 'Flash · 1d'},
        {window: 'credits', name: 'Credits', reset: 'resetUnknown'},
        {forecast: 'gemini:weekly', outlook: 'onPaceReset', plan: 'none'},
        {forecast: 'claude:weekly', outlook: 'none'},
      ],
      look: ['Its plan is switched off: no pace marks on its meters', 'No reset news in its tray'],
    },
    {
      kind: 'card',
      id: 'antigravity-2',
      provider: 'antigravity',
      account: {name: 'Work'},
      plan: 'Pro',
      machines: ['mac-mini'],
      history: 14 * DAY,
      windows: [
        fiveHours(0, 7, agentsWork(IOS_AGENTS, ALWAYS), 'Gemini Pro'),
        // A tenth faster than the default plan every day: it runs out on the fifth day, past half of the time left to the plan's end.
        weekly({id: 'gemini:weekly', label: 'Gemini', since: -2 * DAY, use: through([0, 0], [1, 33], [2, 60.5], [3, 77])}),
      ],
      agents: IOS_AGENTS,
      on: {ana: {}},
      expect: [
        {title: 'Antigravity 2'},
        {stale: false, to: 3 * MIN},
        {stale: true, from: 4 * MIN, to: 13 * MIN},
        {stale: false, from: 15 * MIN, to: 46 * MIN},
        {agents: 2, drawn: true, to: 6 * MIN},
        {agents: 0, drawn: true, from: 7 * MIN, to: 14 * MIN},
        {agents: 2, drawn: true, from: 15 * MIN, to: 46 * MIN},
        {stale: true, from: 49 * MIN, to: 58 * MIN},
        {agents: 0, drawn: true, from: 52 * MIN, to: 59 * MIN},
        // Asleep or not, the forecast stays.
        {forecast: 'gemini:weekly', outlook: 'runsOut', tone: 'v-warn'},
      ],
      look: [
        'Its machine sleeps from the 2nd minute to the 14th, and so every 45 minutes: the card goes stale (its dot, no line under the limits) and comes back, its agents go and come back, a gap stays on the 24-hour chart',
        'Its Gemini week runs out past the chart\'s right edge: "Antigravity 2 · Gemini: runs out in 2d →" stands there, in its colour, stacked with the other labels and never over the Codex reset\'s; pointing at it tells the date and time',
      ],
    },
    {
      kind: 'card',
      id: 'codex-pro',
      provider: 'codex',
      plan: 'Pro',
      machines: ['laptop'],
      history: 14 * DAY,
      windows: [
        fiveHours(40 * MIN, 10, agentsWork(PRO_AGENTS, shifts(3))),
        // A free reset used six hours ago: the week before was due in two days.
        weekly({since: -6 * HOUR, early: 2 * DAY, use: steady(0, 20), before: (elapsed, n) => (n === -1 ? steady(10, 18)(elapsed) : steady(5, 12)(elapsed))}),
      ],
      resets: t =>
        t < -30 * HOUR
          ? {available: 0}
          : t < -6 * HOUR
            ? {available: 1, expiring: [{count: 1, expiresAt: 20 * DAY}]}
            : t < -3 * HOUR
              ? {available: 0, expiring: []}
              : // Granted at different times, they expire at different times; one the client gives no time for.
                {
                  available: 3,
                  expiring: [
                    {count: 1, expiresAt: 8 * DAY},
                    {count: 1, expiresAt: 18 * DAY},
                    {count: 1, expiresAt: null},
                  ],
                },
      agents: PRO_AGENTS,
      on: {ana: {}, night: {hidden: true}},
      expect: [
        {title: 'Codex'},
        {agents: 11, drawn: false, to: 5 * MIN},
        {agents: 12, drawn: false, from: 5 * MIN + 15 * SECOND, to: 10 * MIN},
        {agents: 11, drawn: false, from: 10 * MIN + 15 * SECOND},
        {event: 'early_reset'},
        {event: 'resets_granted'},
        {window: 'weekly', level: 'ok', note: null},
      ],
      look: [
        'Three free resets: a ticket "3" in the tray, before the agents; its name and panel say when each expires: one in 8 days, one in 18, one with no end date',
        'Shares a row with Antigravity 2, the same two windows: with reset news or without (Account → this browser → announcements), the two are as tall',
        'The chart marks the early reset six hours ago and the free resets granted',
        'Within 15 minutes: an agent starts (5th minute), one stops (10th), "notifications" switches working every 2 minutes',
      ],
    },
    {
      kind: 'card',
      id: 'claude-ahead',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['build-01'],
      history: 2 * DAY,
      windows: [fiveHours(-60 * MIN, 36, agentsWork(AHEAD_AGENTS, shifts(9))), weekly({since: -2.5 * DAY, use: through([0, 0], [1.5, 62.5], [2.5, 77.5])})],
      agents: AHEAD_AGENTS,
      on: {ana: {name: 'Ahead of the plan', span: 4}},
      expect: [
        {title: 'Ahead of the plan'},
        {agents: 1, drawn: true},
        {window: 'weekly', level: 'warn', note: 'ahead', hint: 'weekly'},
        {window: 'session', note: 'ahead', hint: 'reset', to: 20 * MIN},
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-crit', plan: 'ahead'},
        {forecast: 'session', outlook: 'runsOut', tone: 'v-crit', to: 90 * MIN},
      ],
      look: [
        'A third of the row wide, with the next two cards',
        'The five hours are ahead of an even pace for the first minutes: its own tooltip',
        'Its week runs out past the right edge of the 24-hour chart: a label there says in how many hours',
      ],
    },
    {
      kind: 'card',
      id: 'codex-behind',
      provider: 'codex',
      plan: 'Pro',
      machines: ['win-desktop'],
      history: 14 * DAY,
      windows: [fiveHours(90 * MIN, 6, agentsWork(ON_CALL_AGENTS, shifts(12))), weekly({since: -2 * DAY, use: alongPlan(-15, WEEK_PLAN_FLAT)})],
      resets: () => ({available: 3, expiring: [{count: 3, expiresAt: 25 * DAY}]}),
      agents: ON_CALL_AGENTS,
      on: {ana: {name: 'Codex Pro for the platform team and the on-call rotation', color: '#43aca1', plan: WEEK_PLAN_FLAT, span: 4}},
      expect: [
        {title: 'Codex Pro for the platform team and the on-call rotation'},
        {agents: 10, drawn: true},
        {window: 'weekly', level: 'ok', note: 'behind'},
        {forecast: 'weekly', outlook: 'leftPlan', plan: 'behind'},
      ],
      look: [
        'Its long name ends in an ellipsis',
        'Teal on the card, the chart and the table',
        'Its own plan: 15% a day, 10% the last',
        'A third of the row wide, its tray full: the reset news on the left, three free resets and ten agent marks in two groups on the right, whole at a window 1260 px wide or more; narrower, the marks go all at once and the count stays',
        'Its three free resets expire together: one row in the panel\'s table',
      ],
    },
    {
      kind: 'card',
      id: 'codex-low',
      provider: 'codex',
      plan: 'Plus',
      machines: ['laptop'],
      history: 2 * DAY,
      windows: [fiveHours(10 * MIN, 5, onAndOff(14)), weekly({since: -4 * DAY, use: through([0, 0], [3, 87.2], [4, 93])})],
      on: {ana: {name: 'Running low', span: 4}, quiet: {}},
      expect: [
        {title: 'Running low'},
        {agents: 0, drawn: true},
        {window: 'weekly', level: 'crit', note: null},
        {forecast: 'weekly', outlook: 'runsOut', tone: 'v-crit'},
        // Its five hours reset ten minutes in: a forecast from 40 minutes on.
        {forecast: 'session', outlook: 'leftReset', from: 45 * MIN, to: 5 * HOUR},
      ],
      look: ['The weekly forecast line reaches zero within the hours ahead, where the table says it runs out'],
    },
    {
      kind: 'card',
      id: 'codex-used-up',
      provider: 'codex',
      plan: 'Plus',
      machines: ['win-desktop'],
      history: 14 * DAY,
      windows: [fiveHours(0, 4), weekly({since: -(5 * DAY + 21 * HOUR), use: through([0, 0], [5.79, 100])})],
      on: {ana: {name: 'Used up'}},
      expect: [
        {title: 'Used up'},
        {window: 'weekly', level: 'crit', note: null},
        {forecast: 'weekly', outlook: 'usedUp', spent: 'points'},
      ],
    },
    {
      kind: 'card',
      id: 'claude-last-day',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['build-01'],
      history: 14 * DAY,
      windows: [fiveHours(30 * MIN, 5, onAndOff(5)), weekly({since: -6.2 * DAY, use: through([0, 0], [5.2, 67.6], [7, 91])})],
      on: {ana: {name: 'Last day of the week'}},
      expect: [
        {title: 'Last day of the week'},
        {window: 'weekly', level: 'warn', note: null},
        {forecast: 'weekly', outlook: 'leftReset'},
      ],
      look: ['The plan has ended: no pace mark on the weekly meter'],
    },
    {
      kind: 'card',
      id: 'claude-idle',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['laptop'],
      history: 2 * DAY,
      windows: [idle(), weekly({since: -3 * DAY, use: steady(0, 5)})],
      on: {ana: {name: 'Idle five hours'}},
      expect: [
        {title: 'Idle five hours'},
        {window: 'session', started: false, note: null, reset: 'resetsIn'},
        {forecast: 'session', outlook: 'idle'},
      ],
      look: ['The five hours have not started: no pace mark, and it always resets in 5h', 'On the five-hour chart and table: no forecast for them, the tooltip says they start when first used'],
    },
    {
      kind: 'card',
      id: 'claude-hidden-windows',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['build-01'],
      history: 2 * DAY,
      windows: [fiveHours(70 * MIN, 5), weekly({since: -2 * DAY, use: steady(0, 12)})],
      on: {ana: {name: 'Every limit hidden', windows: ['session', 'weekly']}},
      expect: [
        {title: 'Every limit hidden'},
        {window: 'session', hidden: true},
        {window: 'weekly', hidden: true},
      ],
      look: ['In the middle of the card: an eye struck through, "All limits are hidden", that measurements go on, and "Show limits", which brings them back (put them away again in its settings)'],
    },
    {
      kind: 'card',
      id: 'claude-signed-out',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['win-desktop'],
      history: 3 * DAY,
      until: -2 * DAY,
      failure: {error: 'not_logged_in', from: -2 * DAY + 10 * MIN},
      windows: [fiveHours(0, 6), weekly({since: -3.5 * DAY, use: steady(5, 10)})],
      on: {ana: {name: 'Signed out'}},
      expect: [{title: 'Signed out'}, {error: 'not_logged_in'}, {stale: true}],
      look: ['Its last values stay, with no line under them: its dot is in trouble, and its tooltip says why they are old'],
    },
    {
      kind: 'card',
      id: 'codex-timeout',
      provider: 'codex',
      plan: 'Pro',
      machines: ['build-01'],
      history: 2 * DAY,
      until: -6 * HOUR,
      failure: {error: 'timeout', from: -6 * HOUR + 5 * MIN},
      // Almost used up when it was last measured, and going fast.
      windows: [fiveHours(0, 5), weekly({since: -3 * DAY, use: through([0, 0], [2.75, 97])})],
      on: {ana: {name: 'Too slow to answer'}},
      expect: [{title: 'Too slow to answer'}, {error: 'timeout'}, {stale: true}, {forecast: 'weekly', outlook: 'pastZero'}],
      look: ['No forecast for its week: the tooltip says it should have run out hours ago, and waits for a new measurement'],
    },
    {
      kind: 'card',
      id: 'antigravity-unsupported',
      provider: 'antigravity',
      account: {name: 'Home'},
      plan: 'Pro',
      machines: ['win-desktop'],
      history: 3 * DAY,
      until: -DAY,
      failure: {error: 'unsupported', from: -DAY + 5 * MIN},
      windows: [weekly({id: 'gemini:weekly', label: 'Gemini', since: -2 * DAY, use: steady(5, 8)})],
      on: {ana: {name: 'Antigravity at home'}},
      expect: [{title: 'Antigravity at home'}, {error: 'unsupported'}],
    },
    {
      kind: 'card',
      id: 'codex-stale',
      provider: 'codex',
      plan: 'Plus',
      machines: ['old-nuc'],
      history: 2 * DAY,
      windows: [fiveHours(-6 * HOUR, 8), weekly({since: -2 * DAY, use: steady(0, 11)})],
      on: {ana: {name: 'Quiet machine'}},
      expect: [
        {title: 'Quiet machine'},
        {stale: true},
        {error: null},
        {window: 'session', reset: 'resetPassed'},
        {window: 'weekly', reset: 'resetsIn'},
        {forecast: 'weekly', outlook: 'leftPlan'},
      ],
      look: ['Not heard from for three hours: its five hours have reset since, waiting for a measurement'],
    },
    {
      kind: 'card',
      id: 'codex-eco',
      provider: 'codex',
      plan: 'Team',
      machines: ['ci-runner'],
      eco: true,
      history: 2 * DAY,
      windows: [idle(), weekly({since: -3 * DAY, use: steady(12, 0)})],
      // Its client gives how many, not when they expire.
      resets: () => ({available: 1}),
      on: {ana: {name: 'CI runners (eco)'}},
      expect: [
        {title: 'CI runners (eco)'},
        {stale: false},
        {fresh: 'grey', from: 6 * MIN, to: 14 * MIN},
        {forecast: 'weekly', spent: 'unused'},
      ],
      look: ['Measured every quarter of an hour: its dot fades to grey and pulses again, never a warning', 'One free reset: a ticket "1" in the tray, and its panel gives no end date'],
    },
    {
      kind: 'card',
      id: 'codex-new',
      provider: 'codex',
      plan: 'Plus',
      machines: ['laptop'],
      history: 10 * MIN,
      // Its week began an hour before the demo.
      windows: [fiveHours(0, 6), weekly({since: -HOUR, use: steady(0, 10)})],
      on: {ana: {name: 'New subscription'}},
      expect: [
        {title: 'New subscription'},
        {forecast: 'weekly', outlook: 'needData', to: 7 * HOUR},
      ],
      look: ['Until its week has run 8.4 hours the table has no forecast for it, with a tooltip why, and the chart no forecast line'],
    },
    {
      kind: 'card',
      id: 'team-claude',
      provider: 'claude',
      plan: 'Claude Team',
      machines: ['laptop', 'ben-mac'],
      history: 14 * DAY,
      windows: [fiveHours(2 * HOUR, 9, agentsWork(TEAM_AGENTS, shifts(6))), weekly({since: -2 * DAY, use: alongPlan(-5)})],
      agents: TEAM_AGENTS,
      on: {ana: {name: 'Team'}, team: {}},
      expect: [
        {title: 'Team'},
        {agents: 2, drawn: true},
        // Five points behind the plan: marked in the table, not worth a word on the card.
        {window: 'weekly', note: null},
        {forecast: 'weekly', plan: 'behind'},
        {board: 'team', title: 'Claude · Ana, Ben'},
        {board: 'team', agents: 3, drawn: true},
        {board: 'ben', title: 'Claude'},
      ],
    },
    {
      kind: 'card',
      id: 'ben-codex',
      provider: 'codex',
      plan: 'Plus',
      machines: ['ben-mac'],
      history: 2 * DAY,
      windows: [fiveHours(HOUR, 5), weekly({since: -4 * DAY, use: alongPlan(1)})],
      on: {team: {}},
      expect: [
        {forecast: 'weekly', plan: 'even'},
        {board: 'team', title: 'Codex · Ben'},
        {title: 'Codex'},
      ],
    },
    {
      kind: 'card',
      id: 'ben-claude',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['ben-mac'],
      history: 2 * DAY,
      windows: [fiveHours(3 * HOUR, 5), weekly({since: -DAY, use: steady(0, 15)})],
      expect: [{title: 'Claude 2'}],
      look: ['Ben keeps this one off Team'],
    },

    // Measured at the hub's pace, one reason each, all by one machine asking every 15 seconds.
    {
      kind: 'card',
      id: 'paced-low',
      provider: 'codex',
      plan: 'pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: -5 * DAY, use: steady(84, 2)})],
      expect: [
        {window: 'weekly', level: 'crit'},
        {from: 15 * SECOND, to: 15 * SECOND, cadence: 'nextIn', why: 'low'},
        {from: 45 * SECOND, to: 45 * SECOND, cadence: 'nextSoon', why: 'low'},
      ],
      look: [
        'The tooltip of the dot says when it was measured, when the next measurement comes (in so long, then the time) and why, a line each, in both languages',
        'It opens below the logo, whole on a card in the top row and on a narrow screen',
      ],
    },
    {
      kind: 'card',
      id: 'paced-in-use',
      provider: 'codex',
      plan: 'pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: -3 * DAY, use: () => 60})],
      agents: [{machine: 'pacer', origin: 'terminal', project: 'paced', since: -HOUR, works: ALWAYS}],
      expect: [{error: null}, {from: 15 * SECOND, to: 75 * SECOND, cadence: 'nextIn', why: 'inUse'}],
    },
    {
      kind: 'card',
      id: 'paced-changed',
      provider: 'codex',
      plan: 'pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: -2 * HOUR, use: steady(5, 150)})],
      expect: [{error: null}, {from: 15 * SECOND, to: 75 * SECOND, cadence: 'nextIn', why: 'changed'}],
    },
    {
      kind: 'card',
      id: 'paced-idle',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: -3 * DAY, use: () => 35})],
      expect: [
        {error: null},
        {from: 15 * SECOND, to: 14 * MIN + 15 * SECOND, cadence: 'nextIn', why: 'idle'},
        {from: 14 * MIN + 45 * SECOND, to: 14 * MIN + 45 * SECOND, cadence: 'nextSoon', why: 'idle'},
      ],
    },
    {
      kind: 'card',
      id: 'paced-reset',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['pacer'],
      history: DAY,
      paced: true,
      windows: [weekly({since: 10 * MIN - 7 * DAY, use: () => 50})],
      expect: [
        {error: null},
        {from: 15 * SECOND, to: 9 * MIN + 45 * SECOND, cadence: 'nextIn', why: 'reset'},
        {from: 10 * MIN + 15 * SECOND, to: 10 * MIN + 15 * SECOND, cadence: 'nextSoon', why: 'reset'},
      ],
    },
  ],
};

// ---------- the README images ----------

const PLATFORM_AGENTS: Agent[] = [
  ...agents('laptop', [
    ['editor', 'mobile-app', -5 * HOUR],
    ['terminal', 'api-gateway', -3 * HOUR, ALWAYS],
    ['terminal', 'billing', -HOUR, ALWAYS],
  ]),
  ...agents('ws-2631-linux', [
    ['terminal', 'infra', -2 * HOUR, ALWAYS],
    ['terminal', 'docs-site', -25 * MIN],
  ]),
];
const RESEARCH_AGENTS = agents('ws-2631-linux', [['terminal', 'eval-harness', -40 * MIN]]);
const WORK_AGENTS = agents('laptop', [['terminal', 'checkout', -3 * HOUR, ALWAYS]]);
const CI_AGENTS = agents('ws-2631-linux', [
  ['terminal', 'ci-flaky-tests', -3 * HOUR, ALWAYS],
  ['terminal', 'ci-release', -2 * HOUR, ALWAYS],
  ['terminal', 'ci-lint', -2 * HOUR, ALWAYS],
]);
const ANNA_AGENTS = agents('ws-2631-linux', [
  ['terminal', 'thesis', -3 * HOUR, ALWAYS],
  ['terminal', 'notes', -HOUR],
]);
const PERSONAL_AGENTS = agents('laptop', [['terminal', 'dotfiles', -5 * HOUR, ALWAYS]]);

const showcase: DemoSet = {
  id: 'showcase',
  about: 'a clean board for the README images',
  scene: 'showcase',
  entries: [
    {kind: 'person', id: 'demo', name: 'Demo', expect: [{state: 'widgets'}]},
    {kind: 'machine', id: 'laptop', expect: [{via: 'token'}]},
    {kind: 'machine', id: 'ws-2631-linux', expect: [{os: 'linux'}]},
    {
      kind: 'card',
      id: 'platform',
      provider: 'claude',
      plan: 'max',
      machines: ['laptop'],
      history: 7 * DAY,
      windows: [
        fiveHours(-3 * HOUR - 54 * MIN, 20, agentsWork(PLATFORM_AGENTS, shifts(0))),
        weekly({since: -(3 * DAY + 21 * HOUR), use: through([0, 0], [3, 40], [4, 44])}),
        weekly({id: 'weekly:fable', label: 'Fable', since: -(3 * DAY + 21 * HOUR), use: through([0, 0], [3, 42], [4, 45])}),
      ],
      agents: PLATFORM_AGENTS,
      on: {demo: {name: 'Platform team', span: 8}},
      expect: [{title: 'Platform team'}, {agents: 5, drawn: true}, {error: null}],
    },
    {
      kind: 'card',
      id: 'research',
      provider: 'antigravity',
      plan: 'ultra',
      machines: ['ws-2631-linux'],
      history: 7 * DAY,
      windows: [
        fiveHours(-3 * HOUR - 8 * MIN, 5, agentsWork(RESEARCH_AGENTS, shifts(7)), 'Gemini Pro'),
        weekly({id: 'gemini:weekly', label: 'Gemini', since: -(3 * DAY + HOUR), use: through([0, 0], [3, 53], [4, 60])}),
        weekly({id: 'claude:weekly', label: 'Claude', since: -(3 * DAY + HOUR), use: through([0, 0], [3, 62], [4, 70])}),
      ],
      agents: RESEARCH_AGENTS,
      on: {demo: {name: 'Research', span: 4, plan: 'off'}},
      expect: [{title: 'Research'}, {agents: 1, drawn: true}],
    },
    {
      kind: 'card',
      id: 'work',
      provider: 'codex',
      plan: 'pro',
      machines: ['laptop'],
      history: 7 * DAY,
      windows: [fiveHours(-3 * HOUR - 34 * MIN, 15, agentsWork(WORK_AGENTS, ALWAYS)), weekly({since: -(DAY + 3 * HOUR), use: steady(0, 31)})],
      resets: t =>
        t < -6 * HOUR
          ? {available: 0, expiring: []}
          : {
              available: 2,
              expiring: [
                {count: 1, expiresAt: 11 * DAY},
                {count: 1, expiresAt: 18 * DAY},
              ],
            },
      agents: WORK_AGENTS,
      on: {demo: {name: 'Work'}},
      expect: [{title: 'Work'}, {agents: 1, drawn: true}],
    },
    {
      kind: 'card',
      id: 'ci',
      provider: 'codex',
      plan: 'team',
      machines: ['ws-2631-linux'],
      history: 7 * DAY,
      windows: [fiveHours(-2 * HOUR - 14 * MIN, 12, agentsWork(CI_AGENTS, ALWAYS)), weekly({since: -(5 * DAY + HOUR), use: through([0, 0], [4, 55], [5, 61])})],
      agents: CI_AGENTS,
      on: {demo: {name: 'CI runners'}},
      expect: [{title: 'CI runners'}, {agents: 3, drawn: true}],
    },
    {
      kind: 'card',
      id: 'anna',
      provider: 'claude',
      plan: 'Claude Pro',
      machines: ['ws-2631-linux'],
      history: 7 * DAY,
      windows: [fiveHours(-2 * HOUR - 44 * MIN, 8, agentsWork(ANNA_AGENTS, ALWAYS)), weekly({since: -(2 * DAY + HOUR), use: through([0, 0], [1, 12], [2, 20])})],
      agents: ANNA_AGENTS,
      on: {demo: {name: 'Anna', span: 5}},
      expect: [{title: 'Anna'}, {agents: 2, drawn: true}],
    },
    {
      kind: 'card',
      id: 'personal',
      provider: 'codex',
      plan: 'plus',
      machines: ['laptop'],
      history: 7 * DAY,
      windows: [fiveHours(-4 * HOUR - 14 * MIN, 8, agentsWork(PERSONAL_AGENTS, ALWAYS)), weekly({since: -(5 * DAY + 15 * HOUR), use: through([0, 0], [4.6, 80], [5.6, 88])})],
      agents: PERSONAL_AGENTS,
      on: {demo: {name: 'Personal', span: 7}},
      expect: [{title: 'Personal'}, {agents: 1, drawn: true}],
    },
  ],
};

/** The issue's example: recent work rises above a newer idle session, across three machines. */
const SORT_AGENTS: Agent[] = [
  ...agents('workstation', [
    ['terminal', 'api', -3 * HOUR, {period: DAY, on: HOUR, phase: MIN}],
    ['editor', 'web', -2 * HOUR, {period: DAY, on: HOUR, phase: MIN}],
    ['app', null, -10 * MIN],
    ['terminal', 'new-session', -MIN],
  ]),
  ...agents('laptop', Array.from({length: 4}, (_, i) => ['terminal', `recent-${i + 1}`, -HOUR - i * MIN, {period: DAY, on: MIN, phase: -(i + 2) * MIN}] as const)),
  ...agents('server', Array.from({length: 4}, (_, i) => ['terminal', `morning-${i + 1}`, -8 * HOUR - i * MIN, {period: DAY, on: MIN, phase: -(i + 4) * HOUR}] as const)),
];
const activity: DemoSet = {
  id: 'activity',
  about: 'twelve agents ordered by activity, as a table and a narrow list',
  scene: 'quiet',
  entries: [
    {kind: 'person', id: 'ana', name: 'Ana', agents: true, expect: [{rows: 12}, {firstMachines: ['workstation', 'workstation', 'laptop', 'laptop'], from: 2 * MIN, to: 10 * MIN}], look: ['At full width, sortable headers; two agents on workstation rise to the top after a minute']},
    {kind: 'board', id: 'compact', name: 'Compact agents', owner: 'ana', members: [], agents: true, agentsSpan: 4, expect: [{rows: 12}], look: ['At 4 of 12 columns the widget is a compact list, with a sort menu']},
    {
      kind: 'card', id: 'activity', provider: 'codex', plan: 'pro', machines: ['workstation', 'laptop', 'server'], history: DAY,
      windows: [weekly({since: -2 * DAY, use: steady(0, 10)})], agents: SORT_AGENTS,
      on: {ana: {name: 'Agent activity'}, compact: {name: 'Agent activity'}}, expect: [{title: 'Agent activity'}, {agents: 12, drawn: false}],
    },
  ],
};

export const SETS: DemoSet[] = [all, showcase, activity];
