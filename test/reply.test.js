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
