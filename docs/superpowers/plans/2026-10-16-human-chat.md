# Human chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the live call, the human types a line in the page and it is typed into the tmux pane of the Claude Code session the call follows.

**Architecture:** A new `reply.js` (same style as `codex.js` / `vibe.js`: one file, no dependency) finds the pane of a session (`~/.claude/sessions/<pid>.json`, then the parent chain of that pid against `tmux list-panes`) and types the text with `tmux send-keys -l`. `server.js` exposes it as `GET/POST /api/reply`, behind the existing local guards plus a start-time token. `public/index.html` shows a composer in the `<footer>` row in live mode.

**Tech Stack:** Node 18+ (no dependency), `node:test`, vanilla JS page, tmux, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-16-human-chat-design.md`

## Global Constraints

- Feature off unless `AGENT_STANDUP_REPLY=on` (also accepted: `1`, `yes`, `true`).
- `execFile` only, never a shell. tmux binary: `AGENT_STANDUP_TMUX` (default `tmux`). Sessions folder: `AGENT_STANDUP_CC_SESSIONS` (default `<CLAUDE_CONFIG_DIR or ~/.claude>/sessions`).
- Text: string, control characters replaced by a space, trimmed, 1 to 4000 characters.
- Only Claude Code sessions (not `_codex`, `_vibe`, `_cowork`), only in live mode, never in the demo.
- Page text through `L(fr, en)`; existing CSS tokens only (`--panel2`, `--line`, `--accent`, `--gold`, `--red`, `--dim`).
- No em dash or en dash in any file (user's rule).
- Comments in English, one line, same tone as the file around them.
- Change from the spec: the "You tile talks after a send" animation is dropped. `startTalk` is tied to the speech queue, and the real line arrives from the transcript a moment later anyway and makes the tile talk.

---

### Task 1: Check tmux in the container talks to the host server

Decides between the socket mount (spec) and the host relay (fallback). No code kept.

**Files:** none.

- [ ] **Step 1: Start a throwaway tmux server on the host**

```bash
tmux new-session -d -s as-probe 'sleep 600'
tmux -V    # expect: tmux 3.4
```

- [ ] **Step 2: Run tmux from an Alpine container against the host socket**

```bash
docker run --rm --user 1000:1000 -v /tmp/tmux-1000:/tmp/tmux-1000 node:22-alpine \
  sh -c 'apk add --no-cache tmux >/dev/null 2>&1 || true; tmux -V; tmux list-panes -a -F "#{pane_id} #{pane_pid}"'
```

`apk add` needs root: if it fails as uid 1000, rerun with `--user 0:0` for `apk add`, then `su node -s /bin/sh -c 'tmux list-panes -a ...'`.
Expected: one line `%N <pid>` for `as-probe`. If the output is `protocol version mismatch` or `no server running`: STOP, report to the user, the fallback (host relay) needs its own design.

- [ ] **Step 3: Note the apk tmux version for the pin, then clean up**

```bash
tmux kill-session -t as-probe
```

---

### Task 2: `reply.js`, find the pane and type the text

**Files:**
- Create: `reply.js`
- Test: `test/reply.test.js`

**Interfaces:**
- Produces:
  - `on(): boolean`
  - `lookup(id: string): Promise<{ ok: true, pane: string, status: string, name: string } | { ok: false, why: 'none'|'notmux'|'tmux', status?: string, name?: string }>`
  - `send(id: string, text: unknown): Promise<{ ok: true } | { error: 'text'|'none'|'notmux'|'tmux' }>`
  - `clean(text: unknown): string`

- [ ] **Step 1: Write the failing test**

`test/reply.test.js`:

```js
// test/reply.test.js: the human's line, typed into the tmux pane of a session, with a stand-in tmux and a stand-in sessions folder
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-reply-')), SESS = path.join(tmp, 'sessions'), LOG = path.join(tmp, 'tmux.log'), TMUX = path.join(tmp, 'tmux');
fs.mkdirSync(SESS);
fs.writeFileSync(TMUX, `#!/usr/bin/env node
const a = process.argv.slice(2); require('fs').appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(a) + '\\n');
if (process.env.FAKE_TMUX_FAIL) process.exit(1);
if (a[0] === 'list-panes') console.log('%7 ' + process.env.FAKE_PANE_PID);
`, { mode: 0o755 });
Object.assign(process.env, { AGENT_STANDUP_TMUX: TMUX, AGENT_STANDUP_CC_SESSIONS: SESS, FAKE_TMUX_LOG: LOG, FAKE_PANE_PID: String(process.pid) });
const reply = require('../reply.js');
const ID = '11111111-2222-3333-4444-555555555555';
const calls = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// A stand-in for claude: a child of this test process, so its parent chain reaches the fake pane pid
const claude = spawn('sleep', ['60']); test.after(() => claude.kill());
fs.writeFileSync(path.join(SESS, claude.pid + '.json'), JSON.stringify({ pid: claude.pid, sessionId: ID, status: 'busy', name: 'agents-19' }));

test('clean flattens control characters and trims', () => {
  assert.equal(reply.clean('  a\nb\r\tc\u001b[2J  '), 'a b c [2J');
  assert.equal(reply.clean(42), '');
});

test('lookup finds the pane through the parent chain', async () => {
  assert.deepEqual(await reply.lookup(ID), { ok: true, pane: '%7', status: 'busy', name: 'agents-19' });
  assert.deepEqual(await reply.lookup('not-an-id'), { ok: false, why: 'none' });
  assert.deepEqual(await reply.lookup('99999999-2222-3333-4444-555555555555'), { ok: false, why: 'none' });
  process.env.FAKE_PANE_PID = '999999999';
  try { assert.equal((await reply.lookup(ID)).why, 'notmux'); } finally { process.env.FAKE_PANE_PID = String(process.pid); }
  process.env.FAKE_TMUX_FAIL = '1';
  try { assert.equal((await reply.lookup(ID)).why, 'tmux'); } finally { delete process.env.FAKE_TMUX_FAIL; }
});

test('send types the text literally, then Enter on its own', async () => {
  fs.rmSync(LOG, { force: true });
  assert.deepEqual(await reply.send(ID, '-rf\nhello'), { ok: true });
  const c = calls().filter((a) => a[0] === 'send-keys');
  assert.deepEqual(c, [['send-keys', '-t', '%7', '-l', '--', '-rf hello'], ['send-keys', '-t', '%7', 'Enter']]);
  assert.deepEqual(await reply.send(ID, '   '), { error: 'text' });
  assert.deepEqual(await reply.send(ID, 'x'.repeat(4001)), { error: 'text' });
  assert.deepEqual(await reply.send(ID, { a: 1 }), { error: 'text' });
});

test('on reads AGENT_STANDUP_REPLY', () => {
  delete process.env.AGENT_STANDUP_REPLY; assert.equal(reply.on(), false);
  process.env.AGENT_STANDUP_REPLY = 'on'; assert.equal(reply.on(), true);
  delete process.env.AGENT_STANDUP_REPLY;
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `node --test test/reply.test.js`
Expected: FAIL, `Cannot find module '../reply.js'`.

- [ ] **Step 3: Write `reply.js`**

```js
// reply.js: the human's line, typed into the tmux pane of a running Claude Code session. Off unless AGENT_STANDUP_REPLY=on.
// Claude Code writes <config>/sessions/<pid>.json for each running session (pid, sessionId, status, name); the pane is the tmux pane whose shell is an ancestor of that pid.
const fs = require('fs'), path = require('path'), os = require('os'), { execFile } = require('child_process');
const on = () => /^(1|on|yes|true)$/i.test(process.env.AGENT_STANDUP_REPLY || '');
const dir = () => process.env.AGENT_STANDUP_CC_SESSIONS || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
const tmux = (args) => new Promise((resolve) => execFile(process.env.AGENT_STANDUP_TMUX || 'tmux', args, { timeout: 3000, windowsHide: true }, (err, out) => resolve(err ? null : String(out))));
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function session(id) {   // the running session with this id, or null
  let names = []; try { names = fs.readdirSync(dir()); } catch {}
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try { const s = JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8')); if (s && s.sessionId === id && Number.isInteger(s.pid)) return s; } catch {}
  }
  return null;
}
const ppid = (pid) => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return +st.slice(st.lastIndexOf(')') + 2).split(' ')[1] || 0; } catch { return 0; } };   // field 4; the name in field 2 may hold spaces and brackets
async function lookup(id) {
  const s = ID.test(String(id || '')) ? session(id) : null; if (!s) return { ok: false, why: 'none' };
  const who = { status: String(s.status || ''), name: String(s.name || '') }, out = await tmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}']);
  if (out == null) return { ok: false, why: 'tmux', ...who };
  const panes = new Map(out.trim().split('\n').map((l) => l.split(' ')).filter((p) => /^%\d+$/.test(p[0])).map(([p, pid]) => [+pid, p]));
  for (let pid = s.pid, n = 0; pid > 1 && n < 64; pid = ppid(pid), n++) if (panes.has(pid)) return { ok: true, pane: panes.get(pid), ...who };
  return { ok: false, why: 'notmux', ...who };
}
const clean = (t) => (typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '');   // a newline would send a second message, an escape sequence would drive the terminal
async function send(id, text) {
  const t = clean(text); if (!t || t.length > 4000) return { error: 'text' };
  const r = await lookup(id); if (!r.ok) return { error: r.why };
  if ((await tmux(['send-keys', '-t', r.pane, '-l', '--', t])) == null) return { error: 'tmux' };   // -l: literal text, never read as key names
  if ((await tmux(['send-keys', '-t', r.pane, 'Enter'])) == null) return { error: 'tmux' };
  return { ok: true };
}
module.exports = { on, lookup, send, clean };
```

- [ ] **Step 4: Run it, expect pass**

Run: `node --test test/reply.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add reply.js test/reply.test.js
git commit -m "feat(reply): find the tmux pane of a running session and type a line into it"
```

---

### Task 3: `/api/reply` routes, token, guards

**Files:**
- Modify: `server.js` (require near line 12, token near line 16, Sec-Fetch-Site list line 962, routes before `/api/session` line 1039, `/api/prefs.js` line 998)
- Test: `test/reply.test.js` (append)

**Interfaces:**
- Consumes: `reply.on()`, `reply.lookup(id)`, `reply.send(id, text)` from Task 2.
- Produces:
  - `GET /api/reply?id=<sessionId>` returns `{ ok, why?, status?, name? }` (never `pane`); 404 when off.
  - `POST /api/reply` body `{ id, text, token }` returns `{ ok: true }` (200), `{ error: 'text' }` (400), `{ error: 'token' }` (403), `{ error: 'none'|'notmux'|'tmux' }` (409); 404 when off.
  - `/api/prefs.js` also sets `window.REPLY_TOKEN = "<hex>";` when on.

- [ ] **Step 1: Append the failing HTTP test**

```js
const http = require('http');
const get = (port, p, headers = {}, method = 'GET', body) => new Promise((res, rej) => { const r = http.request({ port, path: p, method, headers }, (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res({ status: x.statusCode, body: b })); }); r.on('error', rej); if (body) r.write(body); r.end(); });
test('/api/reply: off by default, token and cross-site guards, answers', async () => {
  process.env.AGENT_STANDUP_PREFS = path.join(tmp, 'prefs.json'); process.env.AGENT_STANDUP_PROJECTS = path.join(tmp, 'projects');
  const server = require('../server.js'), srv = server.start(0); await new Promise((r) => srv.once('listening', r)); const port = srv.address().port;
  const post = (o, h = {}) => get(port, '/api/reply', { 'content-type': 'application/json', ...h }, 'POST', JSON.stringify(o));
  try {
    delete process.env.AGENT_STANDUP_REPLY;
    assert.equal((await get(port, '/api/reply?id=' + ID)).status, 404);
    assert.doesNotMatch((await get(port, '/api/prefs.js')).body, /REPLY_TOKEN/);
    process.env.AGENT_STANDUP_REPLY = 'on';
    const token = /REPLY_TOKEN = "([0-9a-f]{48})"/.exec((await get(port, '/api/prefs.js')).body)[1];
    assert.deepEqual(JSON.parse((await get(port, '/api/reply?id=' + ID)).body), { ok: true, status: 'busy', name: 'agents-19' });
    assert.equal((await post({ id: ID, text: 'hi' })).status, 403);
    assert.equal((await post({ id: ID, text: 'hi', token: 'x'.repeat(48) })).status, 403);
    assert.equal((await post({ id: ID, text: 'hi', token }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await get(port, '/api/reply?id=' + ID, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post({ id: ID, text: '', token })).status, 400);
    assert.equal((await post({ id: '99999999-2222-3333-4444-555555555555', text: 'hi', token })).status, 409);
    fs.rmSync(LOG, { force: true });
    const ok = await post({ id: ID, text: 'hi', token }); assert.equal(ok.status, 200); assert.deepEqual(JSON.parse(ok.body), { ok: true });
    assert.deepEqual(calls().filter((a) => a[0] === 'send-keys').map((a) => a.at(-1)), ['hi', 'Enter']);
  } finally { delete process.env.AGENT_STANDUP_REPLY; srv.close(); server.shutdown(); }
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `node --test test/reply.test.js`
Expected: FAIL, `TypeError: Cannot read properties of null` (no `REPLY_TOKEN` in `/api/prefs.js` yet).

- [ ] **Step 3: Wire it in `server.js`**

After `const vibe = require('./vibe.js');` (line 10):

```js
const reply = require('./reply.js');     // the human's line, typed into the session's tmux pane (see reply.js); off unless AGENT_STANDUP_REPLY=on
```

After `const PORT = ...` (line 16):

```js
const REPLY_TOKEN = crypto.randomBytes(24).toString('hex'), replyTokenOk = (t) => typeof t === 'string' && t.length === REPLY_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(REPLY_TOKEN));   // made at each start, given only to the page through /api/prefs.js
```

In the Sec-Fetch-Site list (line 962), add `'/api/reply'` after `'/api/packs'`.

Replace the `/api/prefs.js` line (998) with:

```js
    if (url.pathname === '/api/prefs.js') { res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); return res.end('window.SAVED_PREFS = ' + JSON.stringify(readPrefs()).replace(/</g, '\\u003c') + ';' + (reply.on() ? 'window.REPLY_TOKEN = "' + REPLY_TOKEN + '";' : '')); }
```

Before `if (url.pathname === '/api/session') {` (line 1039):

```js
    if (url.pathname === '/api/reply') {   // the human's line: can this session hear it (GET), type it into its terminal (POST)
      if (!reply.on()) { res.writeHead(404); return res.end('not found'); }
      if (req.method === 'POST') return readBody((body) => { let b = {}; try { b = JSON.parse(body) || {}; } catch {} if (!replyTokenOk(b.token)) return json({ error: 'token' }, 403); reply.send(String(b.id || ''), b.text).then((r) => json(r, r.ok ? 200 : r.error === 'text' ? 400 : 409), (e) => { logError('reply', e); json({ error: 'tmux' }, 500); }); }, 16384);
      return reply.lookup(url.searchParams.get('id') || '').then(({ pane, ...r }) => json(r), (e) => { logError('reply', e); json({ ok: false, why: 'tmux' }); });
    }
```

- [ ] **Step 4: Run the new test and the whole suite**

Run: `node --test test/reply.test.js && npm test`
Expected: all pass (`# fail 0`; 2 skipped as before).

- [ ] **Step 5: Commit**

```bash
git add server.js test/reply.test.js
git commit -m "feat(reply): /api/reply behind the local guards and a start-time token"
```

---

### Task 4: Composer in the page

**Files:**
- Modify: `public/index.html` (CSS after line 165, footer markup lines 399 to 403, JS: new block after `syncUI` near line 1302, call in `syncUI`)

**Interfaces:**
- Consumes: `GET/POST /api/reply` and `window.REPLY_TOKEN` from Task 3; page globals `S.live`, `S.demo`, `S.cur = { proj, id }`, `TOOL`, `L`, `$`.

- [ ] **Step 1: CSS, after line 165**

```css
  #say { display:none; flex:1; min-width:0; align-items:flex-end; gap:8px } body.can-say:not(.replay) footer { display:flex; height:auto; min-height:44px; padding:6px 14px } body.can-say:not(.replay) footer > :not(#say) { display:none } body.can-say:not(.replay) #say { display:flex }   /* live: the footer row is the human's line; replay: the seek bar */
  #say label { flex:none; align-self:center; color:var(--dim); font-size:12px; white-space:nowrap; max-width:30vw; overflow:hidden; text-overflow:ellipsis }
  #sayT { flex:1; min-width:0; min-height:36px; max-height:96px; resize:none; background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; font-size:14px; line-height:1.4 } #sayT:focus { border-color:var(--accent) } #sayT:disabled { opacity:.5; cursor:not-allowed }
  #sayB { flex:none; min-width:44px; min-height:36px; background:var(--accent); color:#0b1020; font-weight:700; border:0; border-radius:8px; padding:0 14px; cursor:pointer } #sayB:disabled { opacity:.5; cursor:not-allowed } #sayB.busy { cursor:progress }
  #sayChip { flex:none; align-self:center; font-size:11.5px; padding:2px 8px; border-radius:99px; border:1px solid var(--gold); color:var(--gold); white-space:nowrap } #sayChip:empty { display:none }
  #sayS { flex-basis:100%; font-size:12px; color:var(--dim) } #sayS.err { color:var(--red) } #sayS:empty { display:none } #say { flex-wrap:wrap }
  @media (max-width:520px) { #say label, #sayChip { display:none } }
```

- [ ] **Step 2: Markup, inside `<footer>` before `</footer>` (line 403)**

```html
  <form id="say" autocomplete="off"><label for="sayT" id="sayL"></label><textarea id="sayT" rows="1" enterkeyhint="send" maxlength="4000"></textarea><span id="sayChip"></span><button id="sayB" type="submit"></button><div id="sayS" role="status" aria-atomic="true"></div></form>
```

- [ ] **Step 3: JS, a new block right after `function syncUI() { ... }`**

```js
// ---------- the human's line: typed into the session's terminal through tmux (server: reply.js, off unless AGENT_STANDUP_REPLY=on) ----------
const SAY = { name: '', why: '' };
const sayWhy = (w) => ({ none: L('Session fermée : rien ne peut recevoir le message', 'Session closed: nothing can receive the message'), notmux: L('Session lancée hors tmux : lance-la dans tmux pour lui parler', 'Session started outside tmux: start it in tmux to talk to it'), tmux: L('tmux injoignable', 'tmux unreachable'), text: L('Message vide ou trop long (4000 caractères au plus)', 'Empty or too long message (4000 characters at most)'), token: L('Page périmée : recharge-la', 'Stale page: reload it') }[w] || L('Envoi impossible', 'Could not send'));
const sayStatus = (msg, err) => { const s = $('#sayS'); s.textContent = msg; s.classList.toggle('err', !!err); };
const sayGrow = () => { const f = $('#sayT'); f.style.height = 'auto'; f.style.height = Math.min(f.scrollHeight + 2, 96) + 'px'; };
async function sayCheck() {   // can the followed session hear us: asked when the session changes and every 5 s while live
  const on = !!window.REPLY_TOKEN && S.live && !S.demo && !!S.cur && !TOOL[S.cur.proj]; document.body.classList.toggle('can-say', on); if (!on) return;
  const id = S.cur.id; let r = { ok: false, why: 'tmux' }; try { r = await (await fetch('/api/reply?id=' + encodeURIComponent(id))).json(); } catch {}
  if (!S.cur || S.cur.id !== id) return;
  SAY.name = r.name || L('la session', 'the session'); $('#sayL').textContent = L('À ', 'To ') + SAY.name; $('#sayB').textContent = L('Envoyer', 'Send');
  $('#sayT').disabled = !r.ok; if (!$('#sayB').classList.contains('busy')) $('#sayB').disabled = !r.ok;
  $('#sayChip').textContent = r.ok && r.status === 'busy' ? L('travaille, ton message passera après', 'working, your message goes after') : '';
  if (!r.ok) sayStatus(sayWhy(r.why), false); else if (SAY.why) sayStatus('', false); SAY.why = r.ok ? '' : r.why;
}
setInterval(sayCheck, 5000);
$('#say').onsubmit = async (ev) => {
  ev.preventDefault(); const f = $('#sayT'), b = $('#sayB'), text = f.value.trim(); if (!text || b.disabled || !S.cur) return;
  b.disabled = true; b.classList.add('busy'); let r;
  try { r = await (await fetch('/api/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: S.cur.id, text, token: window.REPLY_TOKEN }) })).json(); } catch { r = { error: 'net' }; }
  b.classList.remove('busy'); b.disabled = false;
  if (r && r.ok) { f.value = ''; sayGrow(); sayStatus(L('Envoyé à ', 'Sent to ') + SAY.name, false); } else sayStatus(sayWhy(r && r.error), true);   // the typed text stays when it failed
  f.focus(); sayCheck();
};
$('#sayT').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#say').requestSubmit(); } };   // Shift+Enter: a new line, flattened by the server
$('#sayT').oninput = sayGrow;
```

In `syncUI()`, after `document.body.classList.toggle('replay', !S.live);` add `sayCheck();`.

The global shortcuts (line 2971) already ignore keys typed in a `TEXTAREA`: no change there.

- [ ] **Step 4: Check the page by hand**

```bash
AGENT_STANDUP_REPLY=on PORT=4790 node server.js
```

Open `http://localhost:4790`, follow a live Claude Code session started in tmux, then:
- composer shown in the footer row, label "À <name>";
- Enter sends, the line appears in the terminal and, a moment later, in the call;
- session busy: gold chip;
- session outside tmux: field disabled, reason written;
- replay: seek bar back, no composer;
- `AGENT_STANDUP_REPLY` unset: no composer at all.
Screenshot each state (ready, busy, outside tmux, error) and look at them.

- [ ] **Step 5: Run the suite, commit**

```bash
npm test
git add public/index.html
git commit -m "feat(reply): composer in the footer row of the live call"
```

---

### Task 5: Docker (outside the fork) and end-to-end check

**Files:**
- Create: `~/tools/agent-standup-docker/Dockerfile`
- Modify: `~/tools/agent-standup-docker/docker-compose.yml`

- [ ] **Step 1: Dockerfile, with the tmux version noted in Task 1**

```dockerfile
# node:22-alpine + tmux, so the app can type the human's line into the session's pane (agent-standup reply.js)
FROM node:22-alpine
RUN apk add --no-cache tmux=<version from Task 1>
```

- [ ] **Step 2: Compose changes**

Replace `image: node:22-alpine` with `build: .` and `image: agent-standup-local:tmux`. Add:

```yaml
    pid: host            # host pids in /proc: reply.js walks from the claude pid up to the tmux pane
```

under `environment`:

```yaml
      AGENT_STANDUP_REPLY: "on"
      AGENT_STANDUP_CC_SESSIONS: /cc-sessions
```

under `volumes`:

```yaml
      - ${HOME}/.claude/sessions:/cc-sessions:ro
      - /tmp/tmux-1000:/tmp/tmux-1000
```

Update the header comment: the container can now run commands on the host as uid 1000 through the tmux socket; the guards are the page origin and the start-time token.

- [ ] **Step 3: Point the mounted clone at the branch and restart**

The compose mounts `~/tools/agent-standup` read-only: it runs whatever the working tree holds, so `feature/human-chat` must be checked out (it is).

```bash
cd ~/tools/agent-standup-docker && docker compose build && docker compose up -d && docker compose logs --tail 5
```

- [ ] **Step 4: End to end**

In a tmux pane: `claude` in some folder. Open `http://localhost:4747`, follow that session, send "dis bonjour". Expect the line in the terminal, then the answer in the call. Repeat while the session works (chip), and with a session outside tmux (disabled). Screenshots.

- [ ] **Step 5: Push the branch to the fork**

```bash
git -C ~/tools/agent-standup push fork feature/human-chat
```
