// Handoff to AI Agent — the rules that can't be eyeballed.
//
// Every case here was a stated trap, and each fails silently in production:
//   * a human takeover being revoked by an automation (the AI talks over a live rep)
//   * a binding to an agent on another account (the customer answered from the
//     wrong phone number)
//   * the flow continuing past the handoff (flow and agent both reply)
//
// The handler is exercised against a fake pg client, so no database is needed.

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// isConversationPaused and enqueueAgentRun are require()d lazily INSIDE the
// handler, so they can be swapped here. enqueueAgentRun especially: importing
// the real agentQueue opens a Redis connection that never closes.
let paused = false;
let enqueued = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../services/agentHandoff') {
    return { isConversationPaused: async () => paused };
  }
  if (request === '../queue/agentQueue') {
    return { enqueueAgentRun: async (job) => { enqueued.push(job); } };
  }
  return origLoad.apply(this, arguments);
};

const { executeAgentHandoffNode } = require('../src/engine/automationEngine');

// Minimal pg client: answers the handler's two queries and records writes.
function fakeClient({ agent = null } = {}) {
  const writes = [];
  const steps = [];
  return {
    writes,
    steps,
    async query(sql, params = []) {
      if (/FROM coexistence\.agents/.test(sql)) return { rows: agent ? [agent] : [] };
      if (/INSERT INTO coexistence\.contacts/.test(sql)) { writes.push({ sql, params }); return { rows: [] }; }
      if (/automation_execution_steps/.test(sql)) { steps.push(params); return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    },
  };
}

const AGENT = { id: 7, name: 'Sales Bot', status: 'active', agent_wa_number: '919876543210' };
const CONTEXT = {
  contact_number: '919111222333',
  message_body: 'what are your prices',
  trigger_data: { wa_number: '919876543210', message_id: 'wamid.X' },
  contact: { name: 'Priya' },
};

function reset() { paused = false; enqueued = []; }

test('binds the agent and ENDS the flow', async () => {
  reset();
  const c = fakeClient({ agent: AGENT });
  const r = await executeAgentHandoffNode(c, 1, { id: 'n1', agentId: 7 }, CONTEXT);
  assert.equal(r.status, 'success');
  // __endFlow is the walker's real termination signal. Without it the flow keeps
  // walking and both the flow and the agent answer the same inbound.
  assert.equal(r.__endFlow, true, 'the flow must stop here — the agent owns the conversation now');
  assert.equal(c.writes.length, 1, 'the binding must be written');
  assert.equal(c.writes[0].params[2], 7, 'bound to the chosen agent');
});

test('a human takeover outranks the node: bind, but stay SILENT', async () => {
  reset();
  paused = true;
  const c = fakeClient({ agent: AGENT });
  const r = await executeAgentHandoffNode(c, 1, { id: 'n1', agentId: 7, agentReplyNow: true }, CONTEXT);
  assert.equal(r.status, 'success');
  // Automations fire regardless of agent_paused, so without this a customer
  // saying "pricing" mid-chat would revoke a live human takeover and have the AI
  // talk over the rep.
  assert.equal(enqueued.length, 0, 'must not speak while a human owns the conversation');
  assert.equal(c.writes.length, 1, 'but the binding is still recorded for when the human hands back');
});

test('replyNow enqueues a run; the flag survives to the worker', async () => {
  reset();
  const c = fakeClient({ agent: AGENT });
  await executeAgentHandoffNode(c, 1, { id: 'n1', agentId: 7, agentReplyNow: true }, CONTEXT);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].agentId, 7);
  assert.equal(enqueued[0].contactNumber, '919111222333');
  // Without explicitlyBound the engine's own is_active check rejects the run —
  // a bound agent is usually NOT the account's active one.
  assert.equal(enqueued[0].explicitlyBound, true);
});

test('without replyNow the agent waits for the next message', async () => {
  reset();
  const c = fakeClient({ agent: AGENT });
  await executeAgentHandoffNode(c, 1, { id: 'n1', agentId: 7, agentReplyNow: false }, CONTEXT);
  // The flow has usually just sent its own message; replying now stacks two.
  assert.equal(enqueued.length, 0);
});

test('refuses an agent bound to a DIFFERENT WhatsApp number', async () => {
  reset();
  const c = fakeClient({ agent: { ...AGENT, agent_wa_number: '919999999999' } });
  const r = await executeAgentHandoffNode(c, 1, { id: 'n1', agentId: 7, agentReplyNow: true }, CONTEXT);
  // The agent replies from ITS number — binding across accounts answers the
  // customer from the wrong one.
  assert.equal(r.status, 'error');
  assert.equal(r.__endFlow, true);
  assert.equal(c.writes.length, 0, 'must not bind');
  assert.equal(enqueued.length, 0, 'must not send');
});

test('refuses a draft agent', async () => {
  reset();
  const c = fakeClient({ agent: { ...AGENT, status: 'draft' } });
  const r = await executeAgentHandoffNode(c, 1, { id: 'n1', agentId: 7 }, CONTEXT);
  // A draft is deliberately unfinished — answering from a half-written prompt is
  // worse than silence.
  assert.equal(r.status, 'error');
  assert.equal(c.writes.length, 0);
});

test('refuses when no agent is selected', async () => {
  reset();
  const c = fakeClient({ agent: AGENT });
  const r = await executeAgentHandoffNode(c, 1, { id: 'n1' }, CONTEXT);
  assert.equal(r.status, 'error');
  assert.equal(c.writes.length, 0);
});

test('refuses when the agent no longer exists', async () => {
  reset();
  const c = fakeClient({ agent: null });
  const r = await executeAgentHandoffNode(c, 1, { id: 'n1', agentId: 999 }, CONTEXT);
  assert.equal(r.status, 'error');
  assert.equal(r.__endFlow, true, 'must not silently walk on');
});

test('refuses without wa_number / contact_number', async () => {
  reset();
  const c = fakeClient({ agent: AGENT });
  const r = await executeAgentHandoffNode(c, 1, { id: 'n1', agentId: 7 }, { trigger_data: {} });
  assert.equal(r.status, 'error');
});

test('the brief resolves {{variables}} before the agent sees it', async () => {
  reset();
  const c = fakeClient({ agent: AGENT });
  await executeAgentHandoffNode(
    c, 1,
    { id: 'n1', agentId: 7, agentBrief: 'Qualified {{name}} — wants enterprise' },
    CONTEXT,
  );
  const brief = c.writes[0].params[3];
  assert.equal(brief, 'Qualified Priya — wants enterprise',
    'an unresolved {{name}} would reach the LLM as literal text');
});

test('a blank brief is stored as null, not an empty string', async () => {
  reset();
  const c = fakeClient({ agent: AGENT });
  await executeAgentHandoffNode(c, 1, { id: 'n1', agentId: 7, agentBrief: '' }, CONTEXT);
  assert.equal(c.writes[0].params[3], null,
    'an empty brief must not inject an empty "Handoff brief" section into the prompt');
});
