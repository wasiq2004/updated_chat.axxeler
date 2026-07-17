// The two node-type lists must agree.
//
// routes/chatbots.js VALID_NODE_TYPES is a DESTRUCTIVE gate: a node whose type
// isn't in it is dropped on save with a bare `continue` — no error, no log, and
// the response is still 200/201. Worse, the dropped node's id never enters the
// `seen` set, so the edge filter then removes every edge into AND out of it. A
// flow doesn't lose a node; it is silently BISECTED, and everything downstream
// is orphaned. The only symptom is the node vanishing on reload.
//
// engine/automationEngine.js NODE_HANDLERS is the runtime list. A type there but
// not in VALID_NODE_TYPES can never survive being saved, so it is dead code.
// A type in VALID_NODE_TYPES but not in NODE_HANDLERS saves fine and then
// silently does nothing at runtime (logged as a 'skipped' step).
//
// Either way the failure is silent, which is why this test exists.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

// Parsed from source rather than imported: chatbots.js exports sanitizeConfig but
// not the Set, and automationEngine.js pulls in the DB pool + queues on import.
function validNodeTypes() {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'chatbots.js'), 'utf8');
  const m = src.match(/const VALID_NODE_TYPES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'VALID_NODE_TYPES not found in routes/chatbots.js — did it move?');
  return [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map(x => x[1]);
}

function nodeHandlerTypes() {
  const src = fs.readFileSync(path.join(SRC, 'engine', 'automationEngine.js'), 'utf8');
  const m = src.match(/const NODE_HANDLERS = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'NODE_HANDLERS not found in engine/automationEngine.js — did it move?');
  return [...m[1].matchAll(/^\s*([a-zA-Z]+)\s*:/gm)].map(x => x[1]);
}

test('every executable node type can survive being saved', () => {
  const valid = validNodeTypes();
  const handlers = nodeHandlerTypes();
  const unsavable = handlers.filter(t => !valid.includes(t));
  assert.deepEqual(unsavable, [],
    `These types have a handler but are NOT in VALID_NODE_TYPES, so routes/chatbots.js `
    + `DELETES them on save along with every edge that touched them — silently bisecting `
    + `the flow. Add them to VALID_NODE_TYPES in routes/chatbots.js.`);
});

test('every savable node type actually does something at runtime', () => {
  const valid = validNodeTypes();
  const handlers = nodeHandlerTypes();
  const inert = valid.filter(t => !handlers.includes(t));
  assert.deepEqual(inert, [],
    `These types save fine but have no handler, so the walker logs a 'skipped' step and `
    + `moves on — the node appears to work and does nothing. Add a handler to `
    + `NODE_HANDLERS in engine/automationEngine.js.`);
});

test('the two lists are exactly equal', () => {
  assert.deepEqual(validNodeTypes().sort(), nodeHandlerTypes().sort());
});

test('agentHandoff is registered in BOTH lists', () => {
  // The specific node added for "Handoff to AI Agent". Registering it in one
  // list only is the single easiest way to lose an afternoon here.
  assert.ok(validNodeTypes().includes('agentHandoff'), 'agentHandoff missing from VALID_NODE_TYPES — it would be deleted on save');
  assert.ok(nodeHandlerTypes().includes('agentHandoff'), 'agentHandoff missing from NODE_HANDLERS — it would silently do nothing');
});

test('the core node types are all still present', () => {
  // Guards against a careless edit to either list removing a live type — which
  // would delete those nodes out of every existing saved flow on next save.
  const valid = validNodeTypes();
  for (const t of ['trigger', 'message', 'condition', 'delay', 'action', 'handoff', 'ai', 'api', 'subflow']) {
    assert.ok(valid.includes(t), `core node type '${t}' vanished from VALID_NODE_TYPES`);
  }
});

// ── The drop is genuinely silent — proving the premise ───────────────────────

test('sanitizeConfig drops an unknown node type without complaint', () => {
  const { sanitizeConfig } = require('../src/routes/chatbots');
  const out = sanitizeConfig({
    nodes: [
      { id: 'n1', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
      { id: 'n2', type: 'totallyMadeUp' },
      { id: 'n3', type: 'message', messageMode: 'direct' },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ],
  });
  assert.deepEqual(out.nodes.map(n => n.id), ['n1', 'n3'], 'the unknown node should be dropped');
  // The real damage: n1 -> n2 -> n3 was a chain. Both edges are gone, so n3 is
  // now unreachable even though it survived. No error is raised anywhere.
  assert.deepEqual(out.edges, [], 'both edges touching the dropped node are removed — the flow is bisected');
});

test('sanitizeConfig keeps agentHandoff and its edges intact', () => {
  const { sanitizeConfig } = require('../src/routes/chatbots');
  const out = sanitizeConfig({
    nodes: [
      { id: 'n1', type: 'trigger', triggerKind: 'keyword', keyword: 'demo' },
      { id: 'n2', type: 'agentHandoff', agentId: 7, agentBrief: 'Qualified: {{name}} wants enterprise', agentReplyNow: true },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  });
  assert.deepEqual(out.nodes.map(n => n.id), ['n1', 'n2']);
  assert.equal(out.edges.length, 1, 'the edge into agentHandoff must survive');
  // Node config is flat on the node (A2) — every field must round-trip.
  const node = out.nodes.find(n => n.id === 'n2');
  assert.equal(node.agentId, 7);
  assert.equal(node.agentBrief, 'Qualified: {{name}} wants enterprise');
  assert.equal(node.agentReplyNow, true);
});
