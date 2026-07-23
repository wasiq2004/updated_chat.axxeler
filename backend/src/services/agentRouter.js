// Agent router. Called from the webhook after evaluateTriggers() returns.
// Decides WHICH live agent (if any) an inbound message belongs to.
//
// Since migration 082 an account can have several agents live at once:
//   'any'      at most one  — the always-on desk
//   'new'      at most one  — takes a contact's FIRST-ever message
//   'keyword'  unlimited    — each scoped by its own keyword
// plus an optional TAG SCOPE on every agent: a non-empty trigger_tags means the
// agent only ever speaks to contacts carrying at least one of those tags.
//
// PRECEDENCE, in order — each rule exists to stop a specific wrong thing:
//
//   1. Explicit per-conversation binding (contacts.agent_id) — a flow already
//      decided. Skips every gate below, including tag scope.
//   2. Paused for human — the bot stays silent, whoever it is.
//   3. SESSION CONTINUITY — an agent already mid-conversation keeps it. Without
//      this, a customer mentioning another bot's keyword mid-chat would switch
//      bots mid-flow and lose all context.
//   4. First-ever message → the 'new' agent. BY DECISION this beats a keyword
//      match: a first-timer typing "PRICE" still belongs to the new-lead agent.
//   5. Keyword match → that keyword agent (longest keyword wins a tie — "PRICE
//      LIST" is more specific than "PRICE" — then lowest id, so it's stable).
//   6. The 'any' agent. BY DECISION it also covers first-timers when no 'new'
//      agent is live — a newcomer should get an answer, not silence.
//
// TAG SCOPE is applied to candidates BEFORE all of 3-6, deliberately including
// continuity: removing the tag from a contact stops the agent on their very
// next message. That makes "untag to mute the bot" work as an operator expects.
// Tags are matched by id OR lowercased name — contacts.tags entries can carry
// stale or missing ids (see automationEngine's Remove Tag).

const pool = require('../db');
const { enqueueAgentRun } = require('../queue/agentQueue');

// Keyword matcher — mirrors automationEngine's matchesKeyword so the agent's
// keyword trigger behaves identically to a keyword automation's.
function normalizeText(t) { return (t || '').toLowerCase().trim(); }
function matchesKeyword(messageBody, keyword, matchType, caseSensitive) {
  if (!messageBody || !keyword) return false;
  const msg = caseSensitive ? String(messageBody).trim() : normalizeText(messageBody);
  const kw = caseSensitive ? String(keyword).trim() : normalizeText(keyword);
  if (!kw) return false;
  switch (matchType) {
    case 'contains': return msg.includes(kw);
    case 'starts': return msg.startsWith(kw);
    case 'exact':
    default: return msg === kw;
  }
}

/**
 * Does this agent's tag scope allow this contact?
 *
 * @param agent       row with trigger_tags (array of tag ids)
 * @param contactTags the contact's tags JSONB (array of {id, name, ...})
 * @param tagCatalog  Map(tagId -> lowercased current name) for the ids agents reference
 *
 * Empty scope = everyone. A scoped agent NEVER matches a contact with no tags —
 * which is what makes tag scope useless-by-design for true first-timers (they
 * have no contact row yet), and that is fine: the UI says so.
 */
function tagScopeAllows(agent, contactTags, tagCatalog) {
  const scope = Array.isArray(agent.trigger_tags) ? agent.trigger_tags : [];
  if (scope.length === 0) return true;
  const tags = Array.isArray(contactTags) ? contactTags : [];
  if (tags.length === 0) return false;
  for (const id of scope) {
    const wantName = tagCatalog.get(Number(id)); // lowercased, or undefined if tag deleted
    for (const t of tags) {
      if (!t) continue;
      if (t.id != null && Number(t.id) === Number(id)) return true;
      if (wantName && String(t.name || '').toLowerCase() === wantName) return true;
    }
  }
  return false;
}

/**
 * Pure selection over pre-filtered candidates. No DB — testable like a clock.
 *
 * @param agents         candidates: live, tag-allowed, media-capable
 * @param isFirstMessage this inbound is the contact's first-ever incoming
 * @param hasText        the inbound carries usable text
 * @param messageBody    the text (for keyword matching)
 * @param sessions       Map(agentId -> last agent_runs.started_at as Date)
 * @param now            injectable clock
 * @returns { agent, via } | null
 */
function selectAgent({ agents, isFirstMessage, hasText, messageBody, sessions, now = new Date() }) {
  if (!agents || agents.length === 0) return null;

  // 3. Session continuity — most recent live session wins, so the bot that was
  // just talking keeps talking.
  let holder = null;
  for (const a of agents) {
    const last = sessions?.get(a.id);
    if (!last) continue;
    const windowMs = (a.trigger_session_minutes || 30) * 60 * 1000;
    if (now.getTime() - new Date(last).getTime() > windowMs) continue;
    if (!holder || new Date(last) > new Date(sessions.get(holder.id))) holder = a;
  }
  if (holder) return { agent: holder, via: 'session' };

  // 4. A first-timer belongs to the 'new' agent — even over a keyword match.
  if (isFirstMessage) {
    const fresh = agents.find(a => a.trigger_mode === 'new');
    if (fresh) return { agent: fresh, via: 'new' };
  }

  // 5. Keyword — most specific match first: longest keyword, then lowest id.
  if (hasText) {
    const matched = agents
      .filter(a => a.trigger_mode === 'keyword'
        && matchesKeyword(messageBody, a.trigger_keyword, a.trigger_match_type, a.trigger_case_sensitive))
      .sort((x, y) =>
        (String(y.trigger_keyword || '').trim().length - String(x.trigger_keyword || '').trim().length)
        || (x.id - y.id));
    if (matched.length) return { agent: matched[0], via: 'keyword' };
  }

  // 6. The always-on desk. Covers newcomers too when no 'new' agent took them.
  const anyAgent = agents.find(a => a.trigger_mode === 'any');
  if (anyAgent) return { agent: anyAgent, via: 'any' };

  return null;
}

const AGENT_COLUMNS = `
  a.id, a.wa_account_id, a.trigger_mode, a.trigger_keyword,
  a.trigger_match_type, a.trigger_case_sensitive, a.trigger_session_minutes,
  a.trigger_tags, a.transcribe_audio, a.accept_images,
  a.handoff_enabled, a.handoff_user_ids, a.handoff_keywords`;

/**
 * Route one inbound message. Returns run metadata, a skip marker, or null.
 */
async function routeIfActive(record) {
  if (!record || record.direction !== 'incoming') return null;
  if (record.message_type === 'status' || record.message_type === 'reaction') return null;
  if (!record.contact_number) return null;

  const isAudio = (record.message_type === 'audio' || record.message_type === 'voice') && !!record.media_url;
  const isImage = record.message_type === 'image' && !!record.media_url;
  // Audio/voice inbounds carry a placeholder body ("Audio message" / "Voice
  // message") set by the webhook — never a real caption (WhatsApp audio has no
  // caption field). Treat them as text-less so the transcribe_audio gate below
  // is actually honoured and the worker transcribes the audio instead of
  // running the agent on the literal placeholder string. Images CAN carry a
  // real caption (message_body), so an image's caption still counts as text.
  const hasText = !isAudio && !!(record.message_body && record.message_body.trim());
  if (!hasText && !isAudio && !isImage) return null; // text, voice note, or image

  // 1. An EXPLICIT per-conversation binding wins over everything.
  //
  // The is_active gate is deliberately relaxed here, and only here: an agent a
  // flow handed off to is usually NOT live by itself. Drafts are still refused
  // (status <> 'draft'). The account match is part of the WHERE: an agent
  // replies from its OWN bound number, so a binding pointing at a different
  // account would answer the customer from the wrong phone number — it is
  // ignored and we fall through to the account's live agents.
  const { rows: bound } = await pool.query(
    `SELECT ${AGENT_COLUMNS}, TRUE AS explicitly_bound
       FROM coexistence.contacts c
       JOIN coexistence.agents a ON a.id = c.agent_id
       JOIN coexistence.whatsapp_accounts w ON w.id = a.wa_account_id
      WHERE c.wa_number = $1 AND c.contact_number = $2
        AND a.status <> 'draft'
        AND (regexp_replace(w.display_phone_number, '\\D', '', 'g') = $1
             OR w.phone_number_id = $3)
      LIMIT 1`,
    [record.wa_number || '', record.contact_number, record.phone_number_id || ''],
  );

  // 2. Otherwise EVERY live agent on this account — since migration 082 there
  // can be one 'any', one 'new', and any number of keyword agents at once.
  const { rows: live } = bound.length ? { rows: [] } : await pool.query(
    `SELECT ${AGENT_COLUMNS}, FALSE AS explicitly_bound
       FROM coexistence.agents a
       JOIN coexistence.whatsapp_accounts w ON w.id = a.wa_account_id
      WHERE a.is_active = TRUE
        AND (regexp_replace(w.display_phone_number, '\\D', '', 'g') = $1
             OR w.phone_number_id = $2)
      ORDER BY a.id`,
    [record.wa_number || '', record.phone_number_id || ''],
  );
  if (!bound.length && live.length === 0) return null;

  // Human handoff: if this conversation has been handed to a human, every bot
  // stays silent until someone clicks "Return to bot".
  const { isConversationPaused } = require('./agentHandoff');
  if (await isConversationPaused(record.wa_number, record.contact_number)) {
    return { agentId: (bound[0] || live[0]).id, skipped: 'paused_for_human' };
  }

  let selected = null;
  if (bound.length) {
    // An explicit handoff IS the engagement decision — no gating, no tag scope.
    selected = { agent: bound[0], via: 'bound' };
  } else {
    // Tag scope first. One query resolves the current names of every tag id any
    // candidate references, so renamed tags still match by id and legacy
    // name-only contact entries still match by name.
    const scopedIds = [...new Set(live.flatMap(a => Array.isArray(a.trigger_tags) ? a.trigger_tags : []))]
      .map(Number).filter(Number.isFinite);
    const tagCatalog = new Map();
    if (scopedIds.length) {
      const { rows: tagRows } = await pool.query(
        'SELECT id, name FROM coexistence.tags WHERE id = ANY($1::bigint[])', [scopedIds],
      );
      for (const t of tagRows) tagCatalog.set(Number(t.id), String(t.name || '').toLowerCase());
    }
    let contactTags = [];
    if (scopedIds.length) {
      const { rows: crows } = await pool.query(
        'SELECT tags FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2',
        [record.wa_number || '', record.contact_number],
      );
      contactTags = (crows[0] && crows[0].tags) || [];
    }

    // Media capability is a candidate filter, not a post-hoc veto: an audio
    // note should go to the agent that CAN transcribe it, not silently die
    // because a text-only agent won the precedence race.
    const candidates = live.filter(a => {
      if (!tagScopeAllows(a, contactTags, tagCatalog)) return false;
      if (isAudio && !hasText && !a.transcribe_audio) return false;
      if (isImage && !hasText && !a.accept_images) return false;
      return true;
    });
    if (candidates.length === 0) return null;

    // First-ever inbound? Only asked when a 'new' agent is in the running —
    // it's the only rule that reads it.
    let isFirstMessage = false;
    if (candidates.some(a => a.trigger_mode === 'new')) {
      const { rows: prior } = await pool.query(
        `SELECT 1 FROM coexistence.chat_history
          WHERE wa_number = $1 AND contact_number = $2 AND direction = 'incoming'
            AND ($3::text IS NULL OR message_id IS DISTINCT FROM $3)
          LIMIT 1`,
        [record.wa_number || '', record.contact_number, record.message_id || null],
      );
      isFirstMessage = prior.length === 0;
    }

    // Live sessions for keyword/new candidates ('any' replies regardless).
    const sessions = new Map();
    const sessionable = candidates.filter(a => a.trigger_mode === 'keyword' || a.trigger_mode === 'new');
    if (sessionable.length) {
      const maxWindow = Math.max(...sessionable.map(a => a.trigger_session_minutes || 30));
      const { rows: runs } = await pool.query(
        `SELECT agent_id, MAX(started_at) AS last_run
           FROM coexistence.agent_runs
          WHERE agent_id = ANY($1::bigint[]) AND contact_number = $2
            AND started_at > NOW() - make_interval(mins => $3)
          GROUP BY agent_id`,
        [sessionable.map(a => a.id), record.contact_number, maxWindow],
      );
      for (const r of runs) sessions.set(Number(r.agent_id), r.last_run);
    }

    selected = selectAgent({
      agents: candidates,
      isFirstMessage,
      hasText,
      messageBody: record.message_body,
      sessions,
    });
    if (!selected) return null;
  }

  const agent = selected.agent;

  // Keyword handoff: the customer asked for a human (or another configured
  // word). Hand off instead of running the agent.
  if (agent.handoff_enabled && hasText) {
    const { matchesAnyHandoffKeyword, performHandoff } = require('./agentHandoff');
    if (matchesAnyHandoffKeyword(record.message_body, agent.handoff_keywords)) {
      await performHandoff({
        agentId: agent.id,
        handoffUserIds: agent.handoff_user_ids,
        waNumber: record.wa_number,
        contactNumber: record.contact_number,
        reason: 'Customer asked for a human (keyword).',
        by: 'keyword',
      });
      return { agentId: agent.id, handedOff: true };
    }
  }

  await enqueueAgentRun({
    agentId: agent.id,
    contactNumber: record.contact_number,
    inboundMessageId: record.message_id || null,
    inboundText: hasText ? record.message_body : null,
    // Carried so the engine's own is_active check knows this run was authorised
    // by an explicit binding, not by the account default.
    explicitlyBound: !!agent.explicitly_bound,
  });
  return { agentId: agent.id, explicitlyBound: !!agent.explicitly_bound, via: selected.via };
}

module.exports = { routeIfActive, selectAgent, tagScopeAllows, matchesKeyword };
