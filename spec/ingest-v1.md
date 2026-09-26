# Ingest format v1

How an agent connects to a hub, asks whether to measure, and delivers measurements.
Anything may implement it; the reference implementation is `agent/` (Rust).

## Tokens

Every device belongs to a person on the hub. An agent delivers with one of:

| Token | Prefix | How it is obtained | Who the device belongs to |
|---|---|---|---|
| Device token | `qt_d_` | One-time code confirmed by a signed-in person ([below](#connecting-with-a-one-time-code)) | That person |
| Machine token | `qt_m_` | Created by a person in the dashboard, shown once; meant for images, VMs, containers | Whoever created it |

With a machine token a machine joins on its first request; its `machine.id` tells it
from the person's other machines from then on. A machine removed in the dashboard
cannot come back with the same token, only with a new one; revoking a token
disconnects every machine that joined with it.

Nothing in this format picks a board. What a person's devices measure shows on that
person's own board; they share it with shared boards in the dashboard.

## Request

```
POST /v1/ingest
Authorization: Bearer <device token>
Content-Type: application/json
```

```json
{
  "version": 1,
  "agent": "quotum/0.2.0",
  "machine": {"id": "3f9a…", "name": "workstation", "os": "linux", "arch": "x86_64"},
  "sentAt": "2026-09-22T18:43:45.120Z",
  "snapshots": [
    {
      "provider": "claude",
      "account": "9c1e5a0b7d2f4e6a8b0c1d2e",
      "plan": "max",
      "observedAt": "2026-09-22T18:43:44.870Z",
      "via": "claude-code/get_usage",
      "client": "2.1.280",
      "staleAfterMs": 204000,
      "windows": [
        {"id": "session", "kind": "session", "minutes": 300, "usedPercent": 5, "resetsAt": "2026-09-22T20:20:00.921Z"},
        {"id": "weekly", "kind": "weekly", "minutes": 10080, "usedPercent": 10, "resetsAt": "2026-09-28T06:00:00Z"},
        {"id": "weekly:fable", "kind": "weekly", "minutes": 10080, "label": "Fable", "usedPercent": 0, "resetsAt": "2026-09-28T06:00:00Z"}
      ]
    }
  ],
  "failures": [
    {"provider": "antigravity", "observedAt": "2026-09-22T18:43:52Z", "error": "not_logged_in", "detail": "…"}
  ]
}
```

Timestamps are RFC 3339 strings. Optional fields may be omitted or `null`. A hub
ignores fields it does not know (older agents sent an `owner`).

**Limits.** Text fields (names, ids, labels, plan, versions) are 1 to 120 characters.
A batch holds at most 500 snapshots and 500 failures, a snapshot at most 32 windows. A
hub refuses a batch that breaks any rule of this format whole, so an agent should make
what it sends fit (the reference agent trims and cuts before sending).

**Clocks.** `sentAt` is the agent's clock at sending. When it differs from the hub's by
more than 30 seconds, the hub moves every time of the batch by the difference, so a
machine with a wrong clock still lands in the right place. A measurement that is still
more than 30 seconds in the future after that makes the batch invalid.

### Machine

| Field | Meaning |
|---|---|
| `id` | Random id generated once per installation. Not derived from hardware. |
| `name` | The name the machine reports, the host name by default (configurable). Its person can rename the machine in the dashboard; that name wins. |
| `os`, `arch` | As reported by the agent's runtime (`linux`, `macos`, `windows`; `x86_64`, `aarch64`). |

### Snapshot

One successful measurement of one provider account on one machine.

| Field | Meaning |
|---|---|
| `provider` | `claude`, `codex` or `antigravity`. |
| `account` | Pseudonym of the account: the first 24 hex characters of `sha256("quotum/account/v1\n<provider>\n<stable account id, trimmed, lower-case>")`, see [Stable account ids](#stable-account-ids). The same account on two machines gets the same pseudonym. Absent when the client does not say which account it is (Antigravity); see [Subscriptions](#subscriptions). |
| `accountName` | For a client that does not identify its account: a name the device's person gave this subscription, to tell two of them apart. |
| `plan` | The provider's plan name (`max`, `pro`), if reported. |
| `observedAt` | When the client answered. |
| `via` | How the value was obtained (`claude-code/get_usage`, `codex/app-server`, `agy/usage`). |
| `client` | Version of the agent's client that answered. |
| `staleAfterMs` | How long this measurement stays representative. The agent promises the next measurement of this provider before then; a later one is a gap. At most 24 h. |
| `windows` | At least one window. |
| `resets` | Free resets of the limits the account holds, if the client reports them: `{"available": 3, "expiring": [{"count": 1, "expiresAt": "2026-10-03T09:00:00Z"}, {"count": 2}]}`. `available`: how many, at most 1000. `expiring` (optional): the available resets by when they expire, soonest first, one group per time; a group without `expiresAt` (or with `null`) expires at a time the client does not give, and comes last. Each `count` is at least 1, the counts add up to `available` at most (a client may give only how many), and there are at most 50 groups. Only reported, never used. |

#### Stable account ids

| Provider | Stable id | Where it comes from |
|---|---|---|
| Claude | `<email>/<organization name>` | `initialize` of Claude Code (the same values its `~/.claude.json` keeps as `oauthAccount`) |
| Codex | the account id | `account/rateLimits/read` of `codex app-server` |
| Antigravity | — | `agy` does not say; see [Subscriptions](#subscriptions) |

Example: Claude's `user@example.com` in the organization `Example` is
`sha256("quotum/account/v1\nclaude\nuser@example.com/example")`, pseudonym
`73d68562e0a4449082684fee`. A pseudonym keeps the id itself off the hub, but it is not
a secret: whoever knows or guesses an id can compute its pseudonym and recognise it.

### Window

| Field | Meaning |
|---|---|
| `id` | Stable within the provider and unique within the snapshot: `session`, `weekly`, `<scope>:<kind>` (`weekly:fable`, `gemini:session`), `window-<minutes>` for other lengths, `window` when the length is unknown. |
| `kind` | `session` (5 hours), `weekly`, or `other`. The hub keeps it as given. |
| `minutes` | Window length, if known; greater than 0. |
| `label` | The provider's name for the scope of the window (a model or model group), if any. |
| `usedPercent` | 0–100, share of the window already used. |
| `resetsAt` | When the window resets, if known. An idle rolling window reports "now + length". |

### Failure

A measurement that did not succeed. `error` is one of `not_logged_in`, `unsupported`
(the client cannot report plan limits: too old, API-key login), `timeout`,
`invalid_output`, `failed`, `not_installed`. `detail` is free text for people, at most
200 characters. The reference agent does not report clients that are not installed.
A hub shows a failure only once the subscription has had no good measurement for as
long as the last one stays representative: another device may be measuring it fine.

### Subscriptions

The hub files snapshots under *subscriptions*: by `account` when the client names it
(one account measured on many machines, by one person or several, is one subscription),
else as the device's person's own subscription of that provider (plus `accountName`, if
given), never per machine. The same keys decide duty in check-ins.

## Response

`200` with `{"accepted": n, "duplicates": n, "failures": n, "device": {"id": …}}`.
A snapshot the hub already has (same account, not newer than the last one) counts as a
duplicate, so resending a batch after a lost answer is safe.

| Status | Meaning | Agent behaviour |
|---|---|---|
| `400` | The batch does not match this format (`{"error": "invalid_batch", "detail": "<field>"}`) | Drop what the hub will not take: the reference agent halves the batch until it finds the measurement at fault and delivers the rest |
| `401` | Unknown token | Keep the data, retry later, less and less often |
| `403` | `device_revoked`: this device was removed, or the token it delivers with was revoked. `device_conflict`: the machine is connected with a code already, and a machine token cannot take it over | Stop: nothing will be accepted from it again |
| `403` with another code | Something in front of the hub refused the request | Keep the data, retry later |
| `408` | `request_timeout`: the request did not arrive in full within 30 seconds | Keep the data, retry later, as for network errors |
| `413` | Body too large | Drop it, or split it as for `400` |
| `5xx`, network errors | Hub unavailable | Keep the data, retry later, less and less often |

The hub checks the token before it reads the body: `401` and `403 device_revoked` may come
before the agent has sent all of it.

Errors always come as `{"error": "<code>"}`, never with internal messages. The API never
redirects and always answers with JSON: a redirect or a web page means something else
answered, usually a sign-in page in front of the hub, and the agent should say so.

## Asking whether to measure

The same subscription is often signed in on several machines. Before measuring, an agent
asks the hub whether it is on duty for it; the hub lets one device per subscription
measure and tells the others when to ask again.

```
POST /v1/checkin
Authorization: Bearer <token>
```

```json
{
  "version": 1,
  "agent": "quotum/0.2.0",
  "machine": {"id": "3f9a…", "name": "workstation", "os": "linux", "arch": "x86_64"},
  "subscriptions": [
    {"provider": "claude", "account": "9c1e5a0b7d2f4e6a8b0c1d2e", "active": true},
    {"provider": "antigravity", "accountName": "work", "active": false}
  ]
}
```

`machine` is as in a batch; `account` and `accountName` are as in a
snapshot, as far as the agent knows them before measuring. `active` says whether someone
is using that client on this machine right now. At most 16 subscriptions.

An agent that follows the hub's pace (see below) adds `"paced": true` at the top level,
and to a subscription `minIntervalMs`, the most often it agrees to measure it (a whole
number from 60 000 to 86 400 000), when its person set one. A hub answers
`400 invalid_request` to either field of another type or out of range.

`200` with, in the same order:

```json
{"subscriptions": [
  {"provider": "claude", "measure": true, "until": "2026-09-22T18:43:45Z"},
  {"provider": "antigravity", "measure": false, "until": "2026-09-22T18:52:10Z"}
]}
```

`measure: true` means measure now and deliver. `measure: false` means another device is
on duty: don't measure this subscription before `until`, then ask again. The device on
duty keeps it while it delivers; a device where someone is working takes over from a
holder that has been idle for a while; a holder that stops delivering loses duty when
its last measurement goes stale; asking again does not extend a holder's time, only
delivering does. Errors are as for ingest (`400 invalid_request`, `401`, `403`). An agent
that cannot reach the hub, or gets any other answer, measures anyway: at worst two
devices measure the same subscription for a while.

### Following the hub's pace

With `"paced": true` the hub also decides when the device on duty measures, from what it
sees of the subscription everywhere: how much is left, whether its coding agents work on
any machine, whether its numbers just changed, when a window resets. The device asks
again when told, on duty too (every 15 seconds or so, one request for all its
subscriptions, without starting a client), and measures only when told. Each answer
also has:

| Field | Meaning |
|---|---|
| `onDuty` | This device is on duty for the subscription |
| `askInMs` | Ask again this many milliseconds after the answer arrived. Always there |
| `nextInMs` | With `measure: true` only: the next measurement comes no later than this long after this one (after its `observedAt`), 60 000 to 71 950 000 |

```json
{"subscriptions": [
  {"provider": "claude", "measure": false, "onDuty": true, "until": "2026-09-26T10:00:15Z", "askInMs": 15000},
  {"provider": "codex", "measure": true, "onDuty": true, "until": "2026-09-26T10:00:15Z", "askInMs": 15000, "nextInMs": 240000}
]}
```

- `measure: true`: measure now and deliver, promising the next measurement within
  `nextInMs`: its `staleAfterMs` is `nextInMs × 1.2 + 60 000` (at most a day).
- `measure: false, onDuty: true`: on duty, but not time yet; ask again in `askInMs`.
- `measure: false, onDuty: false`: another device measures it; ask again in `askInMs`.

Times in these fields are durations, not moments, so a device whose clock is off still
waits as long as it is told. The hub measures a subscription with any window at 10% or
less, above 0, every minute while it was active within the last hour (its numbers changed or it was
in use), every 2 minutes after an hour of quiet and every 5 minutes after three; one in
use, or whose numbers just changed, every 2 minutes; otherwise less and less often, up
to every 15 minutes, and 30 seconds after a known reset. Never more often than a
device's `minIntervalMs`, taken as at most 71 950 000 so that a measurement never goes
stale before the next.

A device whose measurements of a subscription fail delivers the failures as usual and
keeps asking: the hub waits them out, longer each time in a row (15 minutes for
`not_logged_in` and `unsupported`), and while it does, the device does not take duty;
a healthy device takes it as before. Such a device on duty, or with no other device on
duty, is answered `onDuty: true` until its pause is over.

A paced device that gets no answer keeps asking every 15 seconds, and measures on its own
once the hub has been silent for 4 minutes and the promised time has passed. An answer
that does not have `askInMs` is read as one without `"paced"`.

## Reporting running agents

An agent may also tell the hub which coding agents run on its machine right now, so a
board can show them on the cards of the subscriptions they spend.

```
POST /v1/sessions
Authorization: Bearer <token>
```

```json
{
  "version": 1,
  "agent": "quotum/0.3.0",
  "machine": {"id": "3f9a…", "name": "workstation", "os": "linux", "arch": "x86_64"},
  "sentAt": "2026-09-24T10:15:00Z",
  "sessions": [
    {"provider": "codex", "account": "4b7e…", "origin": "terminal", "project": "quotum", "folder": "quotum.feat-18-desktop-app", "startedAt": "2026-09-24T08:02:11Z", "working": true},
    {"provider": "claude", "account": "9c1e…", "origin": "editor", "startedAt": "2026-09-24T09:40:00Z", "working": false, "lastWorkedAt": "2026-09-24T10:12:00Z"}
  ]
}
```

Each request carries every session of the machine, replacing the ones before; an empty
list says none runs. The reference agent sends one when the list or a session's state
changes, and at least every two minutes while any runs. The hub keeps a machine's list
of running agents for five minutes after its last request, then forgets it.

| Field | Meaning |
|---|---|
| `provider` | As in a snapshot. |
| `account`, `accountName` | The subscription, as in a check-in, as far as the agent knows it. Without them the hub takes the subscription this machine last delivered for that provider; the reference agent leaves out a session of a client that names its account while it does not know which one that is (signed in anew since it measured). Either way, only a subscription the device's person holds (their devices measured it). |
| `origin` | Where it runs: `terminal`, `editor` (a client an editor runs, one per window) or `app` (a provider's desktop app, one client for all its chats). |
| `project` | The project it works in, never a path: the name of the git repository its folder is in (for a worktree, of the repository it belongs to), else the name of the folder. Absent when the folder that names it (the repository's main folder, else the folder itself) is the home folder, above it or temporary. A repository is looked for in the folder and the folders above it, stopping before the home folder (neither it nor anything above it is looked at), and on macOS not in or through the folders the system guards (Desktop, Documents, Downloads, iCloud Drive, other volumes): there the project is the folder. Paths are checked as git writes them; a chain of links made by hand may still lead there. The hub counts time under this name, and boards show it. A longer name than 120 characters is cut, not refused. |
| `folder` | The name of the folder it works in, when that is not `project` (a subfolder or a worktree), and the folder is not the home folder, above it or temporary. Boards show it under the project in the lists of running agents, so agents of one project stay apart; where the agent tells none and its person renamed the project, the name reported for the project is shown there instead. Cut like `project`. |
| `startedAt` | When it started; a time ahead of the hub's is taken as now. |
| `working` | Whether it is working now (the agent's judgement: its processes spend CPU time), or idle. |
| `lastWorkedAt` | Optional: when an idle session was last seen spending CPU like a working one. Absent while working or when unknown, including after the agent restarts or the clocks jump. The reference agent remembers the observation's wall time without recalculating it, and sends it only between `startedAt` and now. The hub corrects it for clock skew as it does `startedAt`, limits it to now and brings a time before `startedAt` up to `startedAt`; an invalid time is refused. |

The reference agent finds a repository by the `.git` in the folder and the folders above
it, stopping before the home folder and the folders above it, which are not looked at;
in a worktree, the `.git` file leads to the main repository's git folder through its
`commondir`. It runs no git and reads none of its settings.

At most 200 sessions (the reference agent keeps the working ones first, then those that
worked most recently, then the newest), in at most 512 KiB. Without `lastWorkedAt`,
working ones come first, then the newest. Clocks are as in a batch. `200` with `{"accepted": n}`:
sessions of a subscription the hub does not know, or the person does not hold, are left
out. Errors are as for check-ins; a hub without this request answers `404` with
`{"error": "not_found"}`, and the agent asks it again an hour later (it may have been
upgraded). A `404` without that body comes from something in front of the hub and is
tried again like any failure.

A board shows a session on the card of its subscription, with its project (as its person
named it in the dashboard, else as reported) and folder, and the name of its machine
(as its person named it in the dashboard, else as the machine reports it), only to the
members of a board where the session's person shows that subscription (their personal board, or a shared
board they are on).

The hub keeps when each session worked, with its machine, subscription, where it runs,
since when and its project and folder names: each list counts until the next one, for at
most 200 seconds. How long agents worked, and how long any of them did, are worked out
from that. The person whose machines they are can rename projects and merge them, which
applies to all time kept.

## Connecting with a one-time code

The OAuth 2.0 device authorization flow (RFC 8628) with JSON bodies:

1. `POST /v1/device/code` with `{"machine": {…}, "agent": "quotum/0.2.0"}` →
   `{"deviceCode", "userCode": "HVJG-XS8V", "verificationUri", "verificationUriComplete", "expiresIn": 600, "interval": 5}`,
   or `429 {"error": "too_many_attempts"}` when one address asks for too many codes.
2. The agent shows `userCode` and `verificationUriComplete`; a signed-in person opens it,
   sees the machine and confirms it. The machine becomes that person's.
3. The agent polls `POST /v1/device/token` with `{"deviceCode"}` every `interval` seconds:
   `400 {"error": "authorization_pending" | "slow_down" | "access_denied" | "expired_token"}`
   until `200 {"token": "qt_d_…", "device": {"id", "name"}, "account": {"name"}}`
   (`account.name`: the display name of the person the device now belongs to).
   A code gives one token; `slow_down` asks to poll 5 s less often.

## Privacy

What never leaves the machine: provider tokens, cookies, account ids and emails,
prompts, file contents, file paths.

What is sent: the pseudonym of each account, the plan name, percentages and reset times
of the windows, free resets and when each expires, the client's version, the machine's random id, its name
(the host name unless configured) and operating system, subscription names if
configured, and for a failed measurement its kind and a short
message of the client (at most 200 characters). With each check-in: whether the client is
in use on the machine (on duty, as often as every 15 seconds), and how often at most the
machine measures the subscription, if configured. Wherever the subscription is shown, by
anyone who holds its account, the members of the board see whether it is in use right now
(from that, and from the working agents of any machine), whatever the settings about
running agents say. About running agents (unless turned
off): which client, where it runs, since when, whether it works and when it last did,
and the name of its project (the repository its folder is in, else the folder) and of
its folder when that differs (unless that is turned off too). The members of a board
where you show a subscription see these, as they see its limits, with each project under
the name its person gave it, and with them the name of the machine each agent runs on.

What the hub keeps of running agents: when each worked, with the machine, subscription,
where it ran, since when and its project and folder names, as long as samples (90 days);
and the names a person gave or merged their projects under, until they undo it. The
person whose machines they are sees their projects, and corrects them, in *My machines*.
