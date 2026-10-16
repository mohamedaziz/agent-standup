# Human chat: talk to the live session from the call

Date: 2026-10-16. Branch `feature/human-chat`, based on v1.34.0 (`d4a198b`). Fork: `mohamedaziz/agent-standup`.

## Goal

In the live call, the human ("You" tile) types a message in the page and it reaches the Claude Code
session the call follows, as if typed in its terminal. The reply shows up in the call through the
transcript, as today.

Out of scope: replay mode, message history, attachments, talking to a sub-agent (a sub-agent has no
terminal; only the main session does), Codex and Mistral Vibe sessions.

## Delivery: tmux

Only sessions running inside tmux can receive a message. Text is typed into the session's pane:

```
tmux send-keys -t <pane_id> -l -- <text>     # -l: literal, never read as key names
tmux send-keys -t <pane_id> Enter
```

Rejected: `claude --resume <id> -p` (two processes would write the same session file while the
terminal is open) and the per-session `messagingSocketPath` (internal, undocumented protocol).

### Session to pane mapping

Claude Code (checked on 2.1.301) writes `~/.claude/sessions/<pid>.json` for each running session,
with `pid`, `procStart`, `sessionId`, `cwd`, `status` (`busy` / idle), `kind`.

1. Find the file whose `sessionId` is the session followed by the call. None: not running.
   `procStart` must equal field 22 (start time) of `/proc/<pid>/stat`: otherwise the pid was reused by
   another process and the session counts as not running (`none`).
2. `tmux list-panes -a -F '#{pane_id} #{pane_pid}'`.
3. Walk up the parents of the claude `pid` (`/proc/<pid>/stat`, field 4) until one is a `pane_pid`.
   Exact even when several sessions run in the same folder. No match: running outside tmux.

The lookup runs on each `GET /api/reply` (cheap: one small directory, one tmux call). No cache.

## Server (`server.js`)

- `GET /api/reply?id=<sessionId>` returns `{ ok, why, status, name }`.
  `why`: `none` (no running session with this id), `notmux` (running outside tmux), `tmux`
  (tmux missing or its socket unreachable). `status` and `name` come from the session file.
- `POST /api/reply` with `{ id, text, token }`: resolves the pane again, then the two `send-keys`.
  Returns `{ ok: true }` or `{ error: why }`.
- `text`: string, trimmed, 1 to 4000 characters, newlines and control characters replaced by spaces
  (a newline would send several messages). Anything else: 400.
- `execFile` only, never a shell. tmux binary from `AGENT_STANDUP_TMUX` (default `tmux`), sessions
  folder from `AGENT_STANDUP_CC_SESSIONS` (default `~/.claude/sessions`). Both also make tests possible.
- Guards: both paths join the existing `Sec-Fetch-Site` list. On top of the existing Host / Origin
  check, `POST` needs a random token made at start (`crypto.randomBytes(24)`), served in
  `/api/prefs.js` as `window.REPLY_TOKEN`, compared with `crypto.timingSafeEqual`.
- A text ending in `;` gets a trailing space before `send-keys`: tmux would read the final `;` as the end of the command and drop it.
- Off unless `AGENT_STANDUP_REPLY` is `on`, `1`, `yes` or `true`: the upstream default stays read-only.

## Page (`public/index.html`)

Placement: the `<footer>` row (44 px), today shown in replay only. In live mode it holds the composer;
in replay it keeps the seek bar. No new fixed element, so nothing overlaps the toasts or `#reactBar`.

Composer: small "You" avatar, visible label "To <session name>", `<textarea rows=1>` growing to 4
lines, "Send" button. Enter sends, Shift+Enter adds a line (flattened on send). `enterkeyhint="send"`.
Touch target 44 px minimum. Existing tokens only (`--panel2`, `--line`, `--accent`, `--gold`,
`--red`, the existing `focus-visible` outline).

| State | Look |
|---|---|
| Ready | border `--line`, `--accent` on focus |
| Agent busy | field enabled, gold chip "working, your message goes after" (Claude Code queues typed input) |
| Outside tmux / not running | field disabled, opacity .5, `cursor:not-allowed`, reason written under it |
| Sending | button disabled with a spinner, no double send |
| Error | message under the field in `--red`, typed text kept |

Accessibility: one `role="status" aria-atomic="true"` element announces "Sent to <name>" or the error.
Focus stays in the field. The feature is not shown at all when the server has it off.

After a send: field cleared (only if it still holds what was sent). The real line comes from the
transcript, which stays the only source of what was said; it makes the "You" tile talk.

Recipient guard: the page remembers which session a draft was started for. If the call has moved to
another session when Enter is pressed, nothing is sent: the text stays and the status line (error
style) says "Recipient changed: <name>. Press Enter again to send it there.". The next Enter sends.

The page asks `GET /api/reply` when the followed session changes and every 5 s while live.

Text in French and English, like the rest of the page (`L(fr, en)`).

## Docker (`~/tools/agent-standup-docker`, outside the fork)

- Derived image: `node:22-alpine` + `apk add tmux` at a pinned version.
- Mounts: `/tmp/tmux-1000` (socket), `~/.claude/sessions:ro`.
- `pid: host`, so the container sees host pids in `/proc` for the parent walk.
- `AGENT_STANDUP_REPLY=on`, `AGENT_STANDUP_CC_SESSIONS=/cc-sessions`.
- Kept: `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, uid 1000, listen on 127.0.0.1:4747.

Risk, accepted: the tmux socket lets the container run any command on the host as uid 1000
(`tmux new-window <cmd>`). `pid: host` adds nothing beyond that. The guard is the page origin and
the token, not the sandbox.

Risk to check first: the tmux client in the container must speak the protocol of the host server
(host: tmux 3.4). If they do not agree, fall back to a small host relay (one action: send text to a
session id), as discussed.

## Tests

- `test/reply.test.js`, against a real server on a free port, like `server.test.js`:
  - a fake sessions folder and a fake `tmux` script (`AGENT_STANDUP_TMUX`) that prints panes and
    records its arguments;
  - pane found from the parent walk (fake pane pid = the test process's parent chain);
  - `notmux`, `none`, bad text (empty, 4001 characters, not a string) give the expected answers;
  - newlines flattened, `-l` and `--` present, Enter sent separately;
  - `POST` without token or with a wrong one: 403; cross-site: 403; feature off: 404.
- Manual, before calling it done: a real Claude Code session in tmux, a message from the page,
  then the same with the session busy, then a session outside tmux. Screenshots of the four states.
- `npm test` green.
