// Multi-agent routing — the precedence matrix and the tag scope.
//
// Since migration 082 one WhatsApp number can have 1 'any' + 1 'new' + N
// keyword agents live AT ONCE, so "which bot answers?" became a real question.
// Every wrong answer here is a customer talking to the wrong bot — or to two.
//
// The decisions under test (made explicitly, not incidentally):
//   * a FIRST-EVER message goes to the 'new' agent even if it contains a
//     keyword agent's keyword ("New wins")
//   * with no 'new' agent live, the 'any' agent covers first-timers too
//     ("no newcomer gets silence")
//   * an agent mid-conversation KEEPS the conversation — a customer mentioning
//     another bot's keyword must not switch bots mid-flow
//   * tag scope: a scoped agent only ever engages contacts carrying one of its
//     tags, matched by id OR name (contact tag entries can carry stale ids)
//
// selectAgent/tagScopeAllows are pure, so no DB and no mocking here.

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// agentRouter requires the queue at module top; importing the real agentQueue
// opens a Redis connection that never closes and wedges the test process.
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '../queue/agentQueue') return { enqueueAgentRun: async () => {} };
  if (request === '../db') return { query: async () => ({ rows: [] }) };
  return origLoad.apply(this, arguments);
};

const { selectAgent, tagScopeAllows, matchesKeyword } = require('../src/services/agentRouter');

const NOW = new Date('2026-07-23T10:00:00Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000);

let nextId = 1;
const agent = (mode, over = {}) => ({
  id: nextId++, trigger_mode: mode, trigger_keyword: null,
  trigger_match_type: 'contains', trigger_case_sensitive: false,
  trigger_session_minutes: 30, trigger_tags: [], ...over,
});
const kw = (word, over = {}) => agent('keyword', { trigger_keyword: word, ...over });

const pick = (agents, over = {}) => selectAgent({
  agents, isFirstMessage: false, hasText: true, messageBody: 'hello there',
  sessions: new Map(), now: NOW, ...over,
});

// ── the decision the user made explicitly: New wins ─────────────────────────

test('a first-ever message goes to the NEW agent even when it matches a keyword', () => {
  const newAgent = agent('new');
  const priceBot = kw('price');
  const r = pick([priceBot, newAgent], { isFirstMessage: true, messageBody: 'what is the PRICE?' });
  assert.equal(r.agent.id, newAgent.id, 'BY DECISION the new-lead agent owns first-timers, keyword or not');
  assert.equal(r.via, 'new');
});

test('the same message from an EXISTING contact goes to the keyword agent', () => {
  const newAgent = agent('new');
  const priceBot = kw('price');
  const r = pick([priceBot, newAgent], { isFirstMessage: false, messageBody: 'what is the PRICE?' });
  assert.equal(r.agent.id, priceBot.id, 'the new agent never engages an existing conversation');
  assert.equal(r.via, 'keyword');
});

// ── the fallback the user chose: Any covers newcomers ───────────────────────

test('with no NEW agent live, the ANY agent answers a first-timer (no silence)', () => {
  const desk = agent('any');
  const r = pick([desk], { isFirstMessage: true, messageBody: 'hi' });
  assert.equal(r.agent.id, desk.id);
  assert.equal(r.via, 'any');
});

test('with a NEW agent live, the newcomer goes to it, not the ANY agent', () => {
  const desk = agent('any');
  const newAgent = agent('new');
  const r = pick([desk, newAgent], { isFirstMessage: true, messageBody: 'hi' });
  assert.equal(r.agent.id, newAgent.id, 'the split: new takes first-timers, any takes the rest');
});

test('an existing contact with no keyword goes to the ANY agent, never the NEW one', () => {
  const desk = agent('any');
  const newAgent = agent('new');
  const r = pick([desk, newAgent], { isFirstMessage: false, messageBody: 'hi again' });
  assert.equal(r.agent.id, desk.id);
});

// ── session continuity beats a fresh keyword ────────────────────────────────

test('MID-CONVERSATION, mentioning another bot\'s keyword does NOT switch bots', () => {
  const plansBot = kw('plans');
  const priceBot = kw('price');
  // The customer engaged plansBot 5 minutes ago and now says "and the price?"
  const sessions = new Map([[plansBot.id, minsAgo(5)]]);
  const r = pick([plansBot, priceBot], { messageBody: 'and the price?', sessions });
  assert.equal(r.agent.id, plansBot.id, 'switching bots mid-flow loses all conversation context');
  assert.equal(r.via, 'session');
});

test('an EXPIRED session does not hold the conversation', () => {
  const plansBot = kw('plans', { trigger_session_minutes: 30 });
  const priceBot = kw('price');
  const sessions = new Map([[plansBot.id, minsAgo(45)]]); // 45 > 30 — dead
  const r = pick([plansBot, priceBot], { messageBody: 'and the price?', sessions });
  assert.equal(r.agent.id, priceBot.id, 'a dead session must not zombie-hold the customer');
});

test('each agent\'s OWN window decides expiry, not a shared one', () => {
  const shortBot = kw('aaa', { trigger_session_minutes: 10 });
  const longBot = kw('bbb', { trigger_session_minutes: 120 });
  // Both ran 30 minutes ago; only the long-window bot still holds a session.
  const sessions = new Map([[shortBot.id, minsAgo(30)], [longBot.id, minsAgo(30)]]);
  const r = pick([shortBot, longBot], { messageBody: 'ok', sessions });
  assert.equal(r.agent.id, longBot.id);
});

test('two live sessions: the most recent one wins', () => {
  const a = kw('aaa');
  const b = kw('bbb');
  const sessions = new Map([[a.id, minsAgo(20)], [b.id, minsAgo(2)]]);
  const r = pick([a, b], { messageBody: 'ok', sessions });
  assert.equal(r.agent.id, b.id, 'the bot that was JUST talking keeps talking');
});

test('session continuity also beats the new-agent rule', () => {
  // Rare but possible: a keyword bot engaged, contact row was deleted, message
  // now reads as "first". Continuity must still win — the conversation exists.
  const newAgent = agent('new');
  const priceBot = kw('price');
  const sessions = new Map([[priceBot.id, minsAgo(3)]]);
  const r = pick([newAgent, priceBot], { isFirstMessage: true, messageBody: 'ok', sessions });
  assert.equal(r.agent.id, priceBot.id);
});

// ── keyword specificity ─────────────────────────────────────────────────────

test('two keyword agents match: the LONGER keyword wins ("PRICE LIST" over "PRICE")', () => {
  const priceBot = kw('price');
  const priceListBot = kw('price list');
  const r = pick([priceBot, priceListBot], { messageBody: 'send the price list please' });
  assert.equal(r.agent.id, priceListBot.id, 'the more specific intent wins');
});

test('an exact tie breaks by lowest id — stable, not random', () => {
  const first = kw('help');
  const second = kw('help');
  const r = pick([first, second], { messageBody: 'help' });
  assert.equal(r.agent.id, first.id);
});

test('no keyword match and no ANY agent → nobody answers (keyword bots stay scoped)', () => {
  const priceBot = kw('price');
  const r = pick([priceBot], { messageBody: 'good morning' });
  assert.equal(r, null, 'a keyword bot must never answer off-keyword chatter');
});

test('keyword matching needs text — a voice note cannot fresh-engage a keyword bot', () => {
  const priceBot = kw('price');
  const r = pick([priceBot], { hasText: false, messageBody: null });
  assert.equal(r, null);
});

// ── tag scope ───────────────────────────────────────────────────────────────

const CATALOG = new Map([[7, 'hot lead'], [9, 'vip']]);

test('an empty tag scope means everyone', () => {
  assert.equal(tagScopeAllows(agent('any'), [], CATALOG), true);
  assert.equal(tagScopeAllows(agent('any'), [{ id: 3, name: 'Cold' }], CATALOG), true);
});

test('a scoped agent engages a contact carrying the tag (by id)', () => {
  const scoped = agent('any', { trigger_tags: [7] });
  assert.equal(tagScopeAllows(scoped, [{ id: 7, name: 'Hot Lead' }], CATALOG), true);
});

test('a scoped agent REFUSES a contact without the tag — that is the whole feature', () => {
  const scoped = agent('any', { trigger_tags: [7] });
  assert.equal(tagScopeAllows(scoped, [{ id: 3, name: 'Cold' }], CATALOG), false);
  assert.equal(tagScopeAllows(scoped, [], CATALOG), false);
});

test('THE STALE-ID TRAP: a contact tag entry with a wrong id still matches by NAME', () => {
  // contacts.tags entries can carry stale/missing ids (automationEngine's
  // Remove Tag documents this). Matching by id alone silently shrinks the
  // agent's audience — invisible, because a non-reply looks like a choice.
  const scoped = agent('any', { trigger_tags: [7] });
  assert.equal(tagScopeAllows(scoped, [{ name: 'Hot Lead' }], CATALOG), true, 'no id at all');
  assert.equal(tagScopeAllows(scoped, [{ id: 9999, name: 'hot lead' }], CATALOG), true, 'stale id');
});

test('a deleted tag (not in the catalog) can still match by id', () => {
  const scoped = agent('any', { trigger_tags: [42] }); // 42 not in CATALOG
  assert.equal(tagScopeAllows(scoped, [{ id: 42, name: 'Legacy' }], CATALOG), true);
  assert.equal(tagScopeAllows(scoped, [{ name: 'Legacy' }], CATALOG), false,
    'name-only entry cannot match a deleted tag — there is no name to compare against');
});

test('tag-filtered candidates: the scoped ANY agent stays silent, nobody else answers', () => {
  // The caller (routeIfActive) filters candidates by tag scope BEFORE selection.
  // This asserts the composed behaviour: a lone scoped agent + untagged contact
  // = no reply at all, not a fallback to "reply anyway".
  const scoped = agent('any', { trigger_tags: [7] });
  const candidates = [scoped].filter(a => tagScopeAllows(a, [], CATALOG));
  assert.equal(pick(candidates), null);
});

// ── matchesKeyword parity (unchanged behaviour, pinned) ─────────────────────

test('matchesKeyword modes behave like the automation engine', () => {
  assert.equal(matchesKeyword('the PRICE please', 'price', 'contains', false), true);
  assert.equal(matchesKeyword('price please', 'price', 'starts', false), true);
  assert.equal(matchesKeyword('the price', 'price', 'starts', false), false);
  assert.equal(matchesKeyword('price', 'price', 'exact', false), true);
  assert.equal(matchesKeyword('price!', 'price', 'exact', false), false);
  assert.equal(matchesKeyword('PRICE', 'price', 'exact', true), false, 'case-sensitive');
});

// ── the regression that started all this ────────────────────────────────────

test('REGRESSION PIN: the route no longer silently rewrites \'new\' to \'any\'', () => {
  // routes/agents.js used `=== 'keyword' ? 'keyword' : 'any'` in three places,
  // so "New conversations only" agents were STORED as always-on and replied to
  // everybody. The editor and router supported 'new' the whole time — nothing
  // errored, nothing logged. Pin the source so the pattern cannot come back.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/routes/agents.js'), 'utf8');
  assert.ok(!src.includes("=== 'keyword' ? 'keyword' : 'any'"),
    "the trigger-mode coercion is back — 'new' agents will silently become 'any' again");
  assert.match(src, /cleanTriggerMode/, 'the allowlisting helper must be used instead');
  // And the allowlist itself must accept all three modes.
  assert.match(src, /\['any', 'new', 'keyword'\]/);
});
