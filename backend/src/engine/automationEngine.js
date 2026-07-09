const pool = require('../db');
const { ssrfSafeFetch } = require('../util/ssrfGuard');

/* ══════════════════════════════════════════════════════════════════════
   Minimal Automation Execution Engine
   Evaluates keyword triggers and walks the automation graph,
   logging every step to automation_executions / automation_execution_steps.
   ══════════════════════════════════════════════════════════════════════ */

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeText(text) {
  return (text || '').toLowerCase().trim();
}

function matchesKeyword(messageBody, keyword, matchType, caseSensitive) {
  if (!messageBody || !keyword) return false;
  const msg = caseSensitive ? messageBody.trim() : normalizeText(messageBody);
  const kw = caseSensitive ? keyword.trim() : normalizeText(keyword);
  if (!kw) return false;
  switch (matchType) {
    case 'contains': return msg.includes(kw);
    case 'starts': return msg.startsWith(kw);
    case 'exact':
    default:
      return msg === kw;
  }
}

// Stringify any value for {{var}} interpolation. Primitives become their plain
// string form; objects/arrays go through JSON.stringify so the user at least
// sees readable JSON instead of `[object Object]`.
function _stringifyForInterpolation(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Normalize a Zen Chat field name into a {{variable}} token key.
// MUST stay identical to fieldVarKey() in the frontend AutomationBuilderView.jsx
// so the token the picker inserts is the token we resolve here.
// "Date of Birth" -> "date_of_birth", "city" -> "city", "lead_score" -> "lead_score".
function fieldVarKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function resolveVariables(text, context) {
  if (!text) return text;
  const contact = context.contact || {};
  // Lower-case the lookup map so `{{Name}}`, `{{NAME}}`, `{{name}}` all resolve.
  // Custom-field keys keep their original case at storage time but match
  // case-insensitively against the template tokens.
  // {{name}} prefers the captured name but falls back to the WhatsApp profile
  // name so greetings still render for contacts we haven't formally captured.
  // (Conditions use the RAW captured name via getFieldValue — see below.)
  const displayName = contact.name || contact.profile_name || '';
  const lookup = {
    name: displayName,
    first_name: displayName.split(' ')[0] || '',
    contact_number: contact.contact_number || context.contact_number || '',
    phone: contact.contact_number || context.contact_number || '',
  };
  // Map field id -> name so DB-loaded custom_fields (keyed by id, e.g. cf-city)
  // can be referenced by their normalized field name (e.g. {{city}}).
  const nameById = {};
  for (const fd of (context.field_defs || [])) { if (fd && fd.id) nameById[fd.id] = fd.name; }
  Object.entries(contact.custom_fields || {}).forEach(([k, v]) => {
    const sval = _stringifyForInterpolation(v);
    const lk = String(k).toLowerCase();
    // Built-ins win over custom fields with the same key, so AI extractions
    // can't clobber the canonical contact data.
    if (lookup[lk] === undefined || lookup[lk] === '') {
      lookup[lk] = sval;
    }
    // Also register under the field's normalized name when the key is a field id.
    const fname = nameById[k];
    if (fname) {
      const nk = fieldVarKey(fname);
      if (nk && (lookup[nk] === undefined || lookup[nk] === '')) lookup[nk] = sval;
    }
  });
  // Webhook-triggered runs: every top-level payload field is a variable (e.g.
  // {{event}}, {{source}}). Built-ins and contact fields win on key clashes.
  Object.entries(context.webhook_payload || {}).forEach(([k, v]) => {
    const lk = String(k).toLowerCase();
    if (lookup[lk] === undefined || lookup[lk] === '') lookup[lk] = _stringifyForInterpolation(v);
  });
  return String(text).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    const lk = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(lookup, lk) ? lookup[lk] : match;
  });
}

function resolveTemplateVariables(templateBody, bindings, context) {
  if (!templateBody) return templateBody;
  let result = templateBody;
  // Handle {{1}}, {{2}} etc. via bindings
  if (bindings) {
    Object.entries(bindings).forEach(([key, val]) => {
      const varNum = key.replace('var', '');
      const resolved = resolveVariables(val, context);
      result = result.replace(new RegExp(`\\{\\{${varNum}\\}\\}`, 'g'), resolved);
    });
  }
  return result;
}

// ─── Condition Evaluation ────────────────────────────────────────────

// Current weekday + hour in IST (UTC+5:30), for the Time condition source.
function istNow() {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60000);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return { weekday: days[ist.getUTCDay()], hour: ist.getUTCHours() };
}

function getFieldValue(source, field, context) {
  const contact = context.contact || {};
  const cf = contact.custom_fields || {};
  if (source === 'custom' || source === 'system') {
    if (field === 'name') return contact.name || '';
    if (field === 'contact_number' || field === 'phone') return contact.contact_number || context.contact_number || '';
    if (/^(last[_ ]?message|message)$/i.test(field)) return context.message_body || '';
    // Everything else (incl. lead_score) lives in the custom_fields JSONB, keyed by name.
    return cf[field] ?? '';
  }
  if (source === 'tags') {
    // contact.tags is an array of {id,name,...} objects (the shape the rest of
    // the app stores); also tolerate legacy plain-string entries. Match by name,
    // case-insensitive — `includes(field)` on the raw objects never matched.
    const names = (contact.tags || []).map(t => (typeof t === 'string' ? t : (t && t.name) || ''));
    return names.some(n => String(n).toLowerCase() === String(field).toLowerCase()) ? field : '';
  }
  if (source === 'time') {
    const { weekday, hour } = istNow();
    if (/hour/i.test(field)) return hour;
    if (/day/i.test(field)) return weekday;
    // "Current time" → business hours = Mon–Sat 09:00–18:00 IST.
    return (weekday !== 'sunday' && hour >= 9 && hour < 18) ? 'business' : 'after-hours';
  }
  if (source === 'bot') {
    if (/intent/i.test(field)) return cf['last_intent'] ?? cf['intent'] ?? '';
    if (/state/i.test(field)) return cf['bot_state'] ?? '';
    return cf[field] ?? '';
  }
  return '';
}

function evaluateRule(rule, context) {
  const { source, field, op, value } = rule;
  const fieldValue = getFieldValue(source, field, context);
  const compareValue = value !== undefined ? value : '';
  const strField = String(fieldValue ?? '').toLowerCase();
  const strCompare = String(compareValue).toLowerCase();

  switch (op) {
    case 'equals': return strField === strCompare;
    case 'not equals': return strField !== strCompare;
    case 'contains': return strField.includes(strCompare);
    case 'not contains': return !strField.includes(strCompare);
    case 'starts with': return strField.startsWith(strCompare);
    case 'ends with': return strField.endsWith(strCompare);
    case 'is empty': return strField === '';
    case 'is not empty': return strField !== '';
    case 'greater than': return Number(fieldValue) > Number(compareValue);
    case 'less than': return Number(fieldValue) < Number(compareValue);
    case 'has tag': return strField !== '';
    case 'not has tag': return strField === '';
    case 'is true': return String(fieldValue).toLowerCase() === 'true' || fieldValue === true;
    case 'is false': return String(fieldValue).toLowerCase() === 'false' || fieldValue === false;
    default: return false;
  }
}

function evaluateConditions(node, context) {
  const rules = node.rules || [];
  if (rules.length === 0) return true;
  const matchMode = node.matchMode || 'all';
  const results = rules.map(r => evaluateRule(r, context));
  if (matchMode === 'any') return results.some(Boolean);
  return results.every(Boolean);
}

// ─── Step Logger ─────────────────────────────────────────────────────

async function logStep(client, executionId, node, input, output, status, errorMessage, waMessageId, waMessageStatus) {
  const { rows } = await client.query(
    `INSERT INTO coexistence.automation_execution_steps
     (execution_id, node_id, node_type, node_name, input_data, output_data, status, completed_at, error_message, wa_message_id, wa_message_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      executionId,
      node.id,
      node.type,
      node.title || node.name || `${node.type} node`,
      JSON.stringify(input || {}),
      JSON.stringify(output || {}),
      status,
      status === 'running' ? null : new Date().toISOString(),
      errorMessage || null,
      waMessageId || output?.whatsapp?.message_id || output?.waMessageId || null,
      waMessageStatus || output?.whatsapp?.status || output?.deliveryStatus || null,
    ]
  );
  return rows[0];
}

async function updateExecutionStatus(client, executionId, status, errorMessage) {
  await client.query(
    `UPDATE coexistence.automation_executions
     SET status = $1, completed_at = $2, error_message = $3
     WHERE id = $4`,
    [status, new Date().toISOString(), errorMessage || null, executionId]
  );
}

// ─── Node Handlers ───────────────────────────────────────────────────

async function executeTriggerNode(client, executionId, node, context) {
  const td = context.trigger_data || {};
  const isStatusTrigger = context.message_type === 'status' || td.status === 'read' || td.status === 'delivered' || td.status === 'sent';

  const output = {
    triggerKind: node.triggerKind,
    keyword: node.keyword,
    matchType: node.matchType,
    whatsapp: {
      direction: isStatusTrigger ? 'status_update' : 'incoming',
      message_id: td.message_id,
      from: context.contact_number,
      to: td.wa_number,
      message_type: context.message_type,
      message_body: context.message_body,
      timestamp: td.timestamp,
      wa_number: td.wa_number,
      phone_number_id: td.phone_number_id,
      contact_name: context.contact?.name,
      media_url: td.media_url,
      media_mime_type: td.media_mime_type,
      status: td.status || 'received',
      // Full raw webhook data for complete API visibility
      raw: {
        message_id: td.message_id,
        phone_number_id: td.phone_number_id,
        wa_number: td.wa_number,
        contact_number: context.contact_number,
        status: td.status,
        timestamp: td.timestamp,
        message_type: context.message_type,
        message_body: context.message_body,
        media_url: td.media_url,
        media_mime_type: td.media_mime_type,
        conversation: td.conversation || null,
        pricing: td.pricing || null,
        errors: td.errors || null,
      },
    },
    contact: context.contact || { contact_number: context.contact_number },
  };

  return logStep(client, executionId, node, { triggerKind: node.triggerKind }, output, 'success', null, td.message_id, td.status || 'received');
}

async function executeMessageNode(client, executionId, node, context) {
  const mode = node.messageMode || 'template';
  let output;

  if (mode === 'template') {
    const { rows: tplRows } = await client.query(
      'SELECT name, body, category, language, buttons, header_type, header_text, footer FROM coexistence.message_templates WHERE id = $1',
      [node.templateId]
    ).catch(() => ({ rows: [] }));
    const template = tplRows[0] || null;
    const resolvedBody = template ? resolveTemplateVariables(template.body, node.bindings, context) : null;

    // Real Meta send via the shared outbound queue. We resolve the account
    // by the wa_number that received the trigger (the BDA's WhatsApp number).
    const { resolveAccount, insertPendingRow } = require('../services/messageSender');
    const { enqueueSend } = require('../queue/sendQueue');
    const fromPhone = context.trigger_data?.wa_number;
    const { account, error: accErr } = await resolveAccount({
      accountId: node.whatsappAccountId,
      fromPhoneNumber: fromPhone,
    });
    if (accErr || !account) {
      throw new Error(`automation message: ${accErr || 'no account for ' + (node.whatsappAccountId || fromPhone)}`);
    }
    const localId = await insertPendingRow({
      account, toNumber: context.contact_number, messageType: 'template',
      messageBody: resolvedBody || template?.body || `Template: ${template?.name}`,
      templateMeta: template ? {
        header_type: template.header_type || 'NONE',
        header_text: template.header_text || null,
        footer: template.footer || null,
        buttons: Array.isArray(template.buttons) ? template.buttons : (template.buttons || []),
      } : null,
    });
    // Build body parameters from node.bindings, RESOLVING variables so a binding
    // like {"1":"{{name}}"} sends the contact's actual name (not the literal
    // token). Meta rejects empty params, so fall back to a single space.
    const bindings = node.bindings || {};
    const keys = Object.keys(bindings).sort((a, b) => +a - +b);
    const components = keys.length > 0
      ? [{ type: 'body', parameters: keys.map(k => ({ type: 'text', text: resolveVariables(String(bindings[k] || ''), context) || ' ' })) }]
      : [];
    // Consume any pending delay set by an upstream Delay node (BullMQ holds the job).
    const tplDelayMs = context.__pendingSendDelayMs || 0;
    await enqueueSend({
      kind: 'template',
      accountId: account.id,
      to: String(context.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { name: template?.name, languageCode: template?.language || 'en', components },
    }, { delayMs: tplDelayMs });
    context.__pendingSendDelayMs = 0;

    output = {
      mode: 'template',
      templateId: node.templateId,
      templateName: template?.name,
      templateCategory: template?.category,
      templateLanguage: template?.language,
      bindings,
      resolvedBody,
      to: context.contact_number,
      contactName: context.contact?.name,
      deliveryStatus: 'queued',
      note: 'Enqueued to sendQueue',
      whatsapp: {
        message_id: localId,
        from: fromPhone,
        to: context.contact_number,
        message_type: 'template',
        status: 'sending',
        timestamp: new Date().toISOString(),
      },
    };
  } else {
    const dd = node.directData || {};
    const resolvedBody = resolveVariables(dd.body, context);
    const directType = node.directType || 'text';

    // Dynamic API: not a WhatsApp message — perform a raw HTTP call to a
    // third-party endpoint and log the response on the execution step.
    // No chat_history row is created and the send queue is not involved.
    if (directType === 'dynamic_api') {
      const endpoint = resolveVariables(dd.endpoint, context);
      if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
        throw new Error('automation dynamic_api: endpoint URL must start with http:// or https://');
      }
      const method = String(dd.method || 'POST').toUpperCase();
      const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
      if (!allowedMethods.has(method)) {
        throw new Error(`automation dynamic_api: unsupported method ${method}`);
      }

      let parsedHeaders = {};
      if (dd.headers && String(dd.headers).trim()) {
        try {
          parsedHeaders = JSON.parse(resolveVariables(dd.headers, context));
          if (!parsedHeaders || typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders)) {
            throw new Error('headers JSON must be an object');
          }
        } catch (err) {
          throw new Error(`automation dynamic_api: invalid headers JSON — ${err.message}`);
        }
      }

      const resolvedBodyTemplate = resolveVariables(dd.body, context);
      let requestBody;
      if (method !== 'GET' && resolvedBodyTemplate) {
        const looksJson = parsedHeaders['Content-Type']?.toLowerCase().includes('json')
          || parsedHeaders['content-type']?.toLowerCase().includes('json')
          || resolvedBodyTemplate.trim().startsWith('{')
          || resolvedBodyTemplate.trim().startsWith('[');
        if (looksJson) {
          // Validate JSON shape so the user finds out at design time, not from
          // a remote 400. Re-stringify to normalize whitespace.
          try {
            requestBody = JSON.stringify(JSON.parse(resolvedBodyTemplate));
          } catch (err) {
            throw new Error(`automation dynamic_api: body template is not valid JSON — ${err.message}`);
          }
          if (!parsedHeaders['Content-Type'] && !parsedHeaders['content-type']) {
            parsedHeaders['Content-Type'] = 'application/json';
          }
        } else {
          requestBody = resolvedBodyTemplate;
        }
      }

      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutMs = 15000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let httpStatus = null;
      let respText = '';
      let respJson = null;
      let httpErr = null;
      try {
        const res = await fetch(endpoint, {
          method,
          headers: parsedHeaders,
          body: requestBody,
          signal: controller.signal,
        });
        httpStatus = res.status;
        respText = await res.text();
        if (respText.length > 4096) respText = respText.slice(0, 4096) + '…(truncated)';
        try { respJson = JSON.parse(respText); } catch { /* not JSON, leave null */ }
      } catch (err) {
        httpErr = err.name === 'AbortError'
          ? `request timed out after ${timeoutMs}ms`
          : (err.message || String(err));
      } finally {
        clearTimeout(timer);
      }
      const elapsedMs = Date.now() - startedAt;

      const apiOutput = {
        mode: 'direct',
        directType: 'dynamic_api',
        request: { method, url: endpoint, headers: parsedHeaders, body: requestBody || null },
        response: { status: httpStatus, body: respJson || respText || null },
        elapsedMs,
        error: httpErr,
        note: httpErr ? 'HTTP request failed' : (httpStatus >= 200 && httpStatus < 300 ? 'HTTP request succeeded' : 'HTTP returned non-2xx'),
      };

      const ok = !httpErr && httpStatus >= 200 && httpStatus < 300;
      const onError = String(dd.onError || 'continue').toLowerCase();
      if (!ok && onError === 'fail') {
        return logStep(client, executionId, node, { directType: 'dynamic_api' }, apiOutput, 'error', httpErr || `HTTP ${httpStatus}`);
      }
      return logStep(client, executionId, node, { directType: 'dynamic_api' }, apiOutput, 'success');
    }

    // Direct (free-form) message — only allowed inside 24h window. We don't
    // enforce the window in the engine because triggers usually fire on
    // recent inbound messages (the customer just messaged, so the window is
    // open). If Meta rejects it, the sendQueue marks the row failed.
    const { resolveAccount, insertPendingRow } = require('../services/messageSender');
    const { enqueueSend } = require('../queue/sendQueue');
    const fromPhone = context.trigger_data?.wa_number;
    const { account, error: accErr } = await resolveAccount({
      accountId: node.whatsappAccountId,
      fromPhoneNumber: fromPhone,
    });
    if (accErr || !account) {
      throw new Error(`automation direct message: ${accErr || 'no account for ' + (node.whatsappAccountId || fromPhone)}`);
    }
    const STORED_TYPE_MAP = { quick_reply: 'interactive', list: 'interactive', product: 'interactive', catalog: 'interactive', contact: 'contacts' };
    const storedMessageType = STORED_TYPE_MAP[directType] || directType;
    const localId = await insertPendingRow({
      account, toNumber: context.contact_number, messageType: storedMessageType, messageBody: resolvedBody,
    });
    let kind = 'text';
    // Any text body containing a URL gets a WhatsApp link-preview card (same as
    // the dedicated 'link' type), so links typed into a plain text node preview too.
    let payload = { body: resolvedBody, previewUrl: /https?:\/\/\S+/i.test(resolvedBody || '') };
    if (directType === 'quick_reply') {
      const rawButtons = Array.isArray(dd.buttons) ? dd.buttons : [];
      const buttons = rawButtons
        .map((b, i) => {
          const title = String(b?.title || b?.text || '').trim();
          if (!title) return null;
          const id = String(b?.id || `btn_${i}`).slice(0, 256);
          return { type: 'reply', reply: { id, title: title.slice(0, 20) } };
        })
        .filter(Boolean)
        .slice(0, 3);
      if (buttons.length === 0) {
        throw new Error('automation quick_reply: at least one button title required');
      }
      kind = 'interactive';
      const headerText = resolveVariables(dd.header, context);
      const interactive = {
        type: 'button',
        body: { text: resolvedBody || '' },
        action: { buttons },
      };
      if (headerText && headerText.trim()) {
        interactive.header = { type: 'text', text: String(headerText).slice(0, 60) };
      }
      payload = { interactive };
    } else if (directType === 'list') {
      // Meta interactive list limits:
      //   max 10 rows TOTAL across the entire message (not per section)
      //   max 10 sections
      //   row.id required, unique across message, ≤200 chars
      //   row.title required, ≤24 chars
      //   row.description optional, ≤72 chars
      //   section.title ≤24 chars (required when ≥2 sections)
      //   action.button required, ≤20 chars
      const rawSections = Array.isArray(dd.sections) ? dd.sections : [];
      const seenIds = new Set();
      let rowBudget = 10;
      const sections = [];
      for (let si = 0; si < rawSections.length && rowBudget > 0 && sections.length < 10; si++) {
        const s = rawSections[si] || {};
        const rawRows = Array.isArray(s.rows) ? s.rows : [];
        const rows = [];
        for (let ri = 0; ri < rawRows.length && rowBudget > 0; ri++) {
          const r = rawRows[ri] || {};
          const title = String(r.title || '').trim();
          if (!title) continue;
          let id = String(r.id || '').trim() || `s${si}_r${ri}`;
          id = id.slice(0, 200);
          // Dedupe ID across the whole message (Meta requires uniqueness)
          let unique = id;
          let n = 1;
          while (seenIds.has(unique)) unique = `${id.slice(0, 196)}_${n++}`;
          seenIds.add(unique);
          const row = { id: unique, title: title.slice(0, 24) };
          const desc = r.description ? String(r.description).trim() : '';
          if (desc) row.description = desc.slice(0, 72);
          rows.push(row);
          rowBudget--;
        }
        if (rows.length === 0) continue;
        sections.push({
          title: String(s.title || '').slice(0, 24),
          rows,
        });
      }
      if (sections.length === 0) {
        throw new Error('automation list: at least one section with a non-empty row title is required');
      }
      if (!resolvedBody || !resolvedBody.trim()) {
        throw new Error('automation list: body text is required by Meta');
      }
      // Meta requires section.title when there are 2+ sections
      if (sections.length > 1) {
        sections.forEach((sec, idx) => {
          if (!sec.title) sec.title = `Section ${idx + 1}`;
        });
      } else {
        // Single-section: title is optional, drop empty to avoid "title must not be empty"
        if (!sections[0].title) delete sections[0].title;
      }
      const buttonLabel = String(dd.button_text || dd.buttonLabel || 'Select').trim().slice(0, 20) || 'Select';
      kind = 'interactive';
      const headerText = resolveVariables(dd.header, context);
      const interactive = {
        type: 'list',
        body: { text: resolvedBody || '' },
        action: {
          button: buttonLabel,
          sections,
        },
      };
      if (headerText && headerText.trim()) {
        interactive.header = { type: 'text', text: String(headerText).slice(0, 60) };
      }
      payload = { interactive };
    } else if (directType === 'location') {
      const lat = String(dd.latitude ?? '').trim();
      const lon = String(dd.longitude ?? '').trim();
      if (!lat || !lon || Number.isNaN(Number(lat)) || Number.isNaN(Number(lon))) {
        throw new Error('automation location: latitude and longitude are required and must be numeric');
      }
      kind = 'location';
      payload = {
        latitude: Number(lat),
        longitude: Number(lon),
        name: resolveVariables(dd.name, context) || undefined,
        address: resolveVariables(dd.address, context) || undefined,
      };
    } else if (directType === 'contact' || directType === 'contacts') {
      const fullName = String(resolveVariables(dd.name, context) || '').trim();
      const first = String(resolveVariables(dd.first_name, context) || '').trim();
      const last = String(resolveVariables(dd.last_name, context) || '').trim();
      const formatted = fullName || [first, last].filter(Boolean).join(' ').trim();
      if (!formatted) {
        throw new Error('automation contact: name is required (formatted_name)');
      }
      const phoneRaw = String(resolveVariables(dd.phone, context) || '').trim();
      // wa_id must be digits only (country code + number, no '+', no spaces).
      // If '+' or any separator is included, Meta cannot resolve the contact
      // and the recipient sees "Invite to WhatsApp" instead of "Message".
      const waId = phoneRaw.replace(/\D/g, '');
      // Keep a clean E.164-style display value for the `phone` field.
      const phoneDisplay = phoneRaw.startsWith('+') ? `+${waId}` : (waId ? `+${waId}` : phoneRaw);
      const contactCard = {
        name: {
          formatted_name: formatted,
          ...(first ? { first_name: first } : (fullName ? { first_name: fullName.split(/\s+/)[0] } : {})),
          ...(last ? { last_name: last } : (fullName && fullName.split(/\s+/).length > 1 ? { last_name: fullName.split(/\s+/).slice(1).join(' ') } : {})),
        },
      };
      if (waId) {
        const phoneType = String(dd.phone_type || 'CELL').toUpperCase();
        const allowed = new Set(['CELL', 'HOME', 'WORK', 'MAIN', 'IPHONE']);
        contactCard.phones = [{
          phone: phoneDisplay,
          type: allowed.has(phoneType) ? phoneType : 'CELL',
          wa_id: waId,
        }];
      }
      const email = String(resolveVariables(dd.email, context) || '').trim();
      if (email) contactCard.emails = [{ email, type: 'WORK' }];
      const org = String(resolveVariables(dd.org, context) || '').trim();
      if (org) contactCard.org = { company: org };
      kind = 'contacts';
      payload = { contacts: [contactCard] };
    } else if (directType === 'product') {
      const catalogId = String(resolveVariables(dd.catalog_id, context) || '').trim();
      const productId = String(resolveVariables(dd.product_retailer_id, context) || '').trim();
      if (!catalogId || !productId) {
        throw new Error('automation product: catalog_id and product_retailer_id are required');
      }
      kind = 'interactive';
      const interactive = {
        type: 'product',
        body: resolvedBody ? { text: resolvedBody.slice(0, 1024) } : undefined,
        action: { catalog_id: catalogId, product_retailer_id: productId },
      };
      // Meta tolerates missing body for single-product but it's recommended; drop if empty
      if (!interactive.body) delete interactive.body;
      payload = { interactive };
    } else if (directType === 'catalog') {
      const catalogId = String(resolveVariables(dd.catalog_id, context) || '').trim();
      if (!resolvedBody || !resolvedBody.trim()) {
        throw new Error('automation catalog: body text is required by Meta');
      }
      kind = 'interactive';
      const interactive = {
        type: 'catalog_message',
        body: { text: resolvedBody.slice(0, 1024) },
        action: { name: 'catalog_message' },
      };
      if (catalogId) {
        interactive.action.parameters = { thumbnail_product_retailer_id: catalogId };
      }
      payload = { interactive };
    } else if (directType === 'link') {
      // Link message = text with preview_url enabled. We append the URL to
      // the body if the body doesn't already contain it, so WhatsApp can
      // generate the preview card client-side.
      const linkUrl = resolveVariables(dd.url, context) || '';
      if (!linkUrl) throw new Error('automation link: url is required');
      const bodyWithUrl = resolvedBody && resolvedBody.includes(linkUrl)
        ? resolvedBody
        : (resolvedBody ? `${resolvedBody}\n\n${linkUrl}` : linkUrl);
      kind = 'text';
      payload = { body: bodyWithUrl, previewUrl: true };
    } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(directType)) {
      kind = 'media';
      if (dd.mediaLibraryId) {
        const { syncMediaToAccount } = require('../routes/mediaLibrary');
        const { rows: mRows } = await client.query(
          `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
          [dd.mediaLibraryId]
        );
        if (mRows.length) {
          const media = mRows[0];
          const { rows: sRows } = await client.query(
            `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
            [media.id, account.id]
          );
          let sync = sRows[0];
          const needsSync = !sync || sync.status !== 'synced' || !sync.meta_media_id || (sync.expires_at && new Date(sync.expires_at) <= new Date());
          if (needsSync) {
            sync = await syncMediaToAccount(media.id, account.id);
            sync = {
              meta_media_id: sync.metaMediaId,
              expires_at: sync.expiresAt,
              status: sync.status,
            };
          }
          payload = {
            type: directType,
            mediaId: sync.meta_media_id,
            caption: resolveVariables(dd.caption, context),
            filename: resolveVariables(dd.filename, context),
          };
          // Mirror the library file to local disk so the chat bubble can
          // play/preview it via /api/media/:messageId — otherwise outbound
          // media sticks on "Downloading…" (media_status never becomes 'stored').
          // Best-effort: a failure here must not block the Meta send.
          try {
            const { getObjectBuffer } = require('../util/pgStorage');
            const { persistOutboundBuffer } = require('../services/mediaDownloader');
            const buf = await getObjectBuffer(media.storage_key);
            const ext = (media.original_name || '').split('.').pop()?.toLowerCase() || (media.mime_type || '').split('/')[1] || 'bin';
            const acctDigits = String(context.trigger_data?.wa_number || '').replace(/\D/g, '');
            const { absPath, size } = persistOutboundBuffer({ accountPhoneDigits: acctDigits, messageId: localId, buffer: buf, ext });
            await client.query(
              `UPDATE coexistence.chat_history
                  SET media_storage_path = $1, media_status = 'stored', media_size_bytes = $2,
                      media_mime_type = COALESCE(media_mime_type, $3), media_filename = $4, media_downloaded_at = NOW()
                WHERE message_id = $5`,
              [absPath, size, media.mime_type, media.original_name, localId]
            );
          } catch (mErr) {
            console.error('[engine] mirror library media to chat failed:', mErr.message);
          }
        } else {
          payload = {
            type: directType,
            link: resolveVariables(dd.url, context),
            caption: resolveVariables(dd.caption, context),
            filename: resolveVariables(dd.filename, context),
          };
        }
      } else {
        payload = {
          type: directType,
          link: resolveVariables(dd.url, context),
          caption: resolveVariables(dd.caption, context),
          filename: resolveVariables(dd.filename, context),
        };
      }
    }
    // Consume any pending delay set by an upstream Delay node (BullMQ holds the job).
    const directDelayMs = context.__pendingSendDelayMs || 0;
    await enqueueSend({
      kind, accountId: account.id,
      to: String(context.contact_number).replace(/\D/g, ''),
      localMessageId: localId, payload,
    }, { delayMs: directDelayMs });
    context.__pendingSendDelayMs = 0;

    output = {
      mode: 'direct',
      directType,
      resolvedBody,
      resolvedUrl: resolveVariables(dd.url, context),
      resolvedCaption: resolveVariables(dd.caption, context),
      resolvedFilename: resolveVariables(dd.filename, context),
      mediaLibraryId: dd.mediaLibraryId || null,
      to: context.contact_number,
      contactName: context.contact?.name,
      deliveryStatus: 'queued',
      note: 'Enqueued to sendQueue',
      whatsapp: {
        message_id: localId,
        from: fromPhone,
        to: context.contact_number,
        message_type: directType,
        status: 'sending',
        timestamp: new Date().toISOString(),
      },
    };
  }

  const waMsgId = output.apiResponse?.message_id || null;
  const waStatus = output.apiResponse?.status || output.deliveryStatus || null;
  const step = await logStep(client, executionId, node, { mode, to: context.contact_number }, output, 'success', null, waMsgId, waStatus);

  // If this message is configured to wait for the customer's reply before
  // continuing, flip the execution to 'paused' and signal the walker to exit.
  // The resume path (in webhook.js → resumeAutomation) will pick up from the
  // children of this node when the customer's next inbound message arrives.
  if (node.waitForReply === true) {
    const hours = Math.max(1, parseInt(node.waitTimeoutHours || 24, 10));
    await client.query(
      `UPDATE coexistence.automation_executions
          SET status='paused',
              awaiting_node_id=$1,
              paused_at=NOW(),
              expires_at=NOW() + ($2 || ' hours')::INTERVAL,
              wa_number=$3
        WHERE id=$4`,
      [node.id, String(hours), context.trigger_data?.wa_number || null, executionId]
    );
    step.__pauseExecution = true;
  }
  return step;
}

async function executeConditionNode(client, executionId, node, context) {
  const matched = evaluateConditions(node, context);
  const output = { matched, matchMode: node.matchMode || 'all', rulesEvaluated: (node.rules || []).length };
  return logStep(client, executionId, node, { rules: node.rules || [] }, output, 'success');
}

const DELAY_UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
const DELAY_MAX_MS = 7 * 86400000; // 7-day cap on a single delay

async function executeDelayNode(client, executionId, node, context) {
  const delayMode = node.delayMode || 'duration';
  let appliedMs = 0;
  // Only 'duration' is honored: we stash the ms on the context and the NEXT
  // message node enqueues its send with this BullMQ delay (non-blocking).
  // date/field/until modes need a real scheduler — left as honest log-only.
  if (delayMode === 'duration') {
    const val = Math.max(0, parseInt(node.waitValue, 10) || 0);
    const unitMs = DELAY_UNIT_MS[node.waitUnit] || DELAY_UNIT_MS.minutes;
    appliedMs = Math.min(val * unitMs, DELAY_MAX_MS);
    if (appliedMs > 0) context.__pendingSendDelayMs = (context.__pendingSendDelayMs || 0) + appliedMs;
  }
  const output = {
    delayMode,
    waitValue: node.waitValue,
    waitUnit: node.waitUnit,
    useContactTz: node.useContactTz,
    appliedMs,
    note: appliedMs > 0
      ? `Next message will be delayed ${appliedMs}ms via the send queue.`
      : 'No real delay applied (only "For a duration" mode is supported; date/field/until need a scheduler).',
  };
  return logStep(client, executionId, node, { delayMode }, output, 'success');
}

// Action kinds that don't have a real side-effect handler in this build.
// We keep them as honest, accurately-labelled log entries rather than faking a
// success — so the execution log tells the operator exactly what did NOT happen.
const ACTION_STUB_NOTES = {
  'Assign to Agent': 'Not applied — superseded by "Assign to BDA"; there is no team-member assignment column. Use Assign to BDA.',
};

async function executeActionNode(client, executionId, node, context) {
  const actions = node.actions || [];
  const waNumber     = context.trigger_data?.wa_number;
  const contactNumber = context.contact_number;
  const results = [];
  let stepStatus = 'success';
  let contactMutated = false; // emit one contact-saved SSE at the end if true

  for (const a of actions) {
    const base = { kind: a.kind, value: a.value };
    try {
      if (a.kind === 'Assign to BDA') {
        // a.value may be a literal user id, or a template like "{{assigned_bda_id}}"
        // when the action is configured in "By variable" mode. Resolve first.
        const rawValue = resolveVariables(String(a.value || ''), context).trim();
        const userId = parseInt(rawValue, 10);
        if (!userId) {
          results.push({ ...base, status: 'error', error: 'no user selected' });
          stepStatus = 'error';
          continue;
        }
        if (!waNumber || !contactNumber) {
          results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' });
          stepStatus = 'error';
          continue;
        }
        // Verify the user exists, is active, and is a bda_sales / admin
        const { rows: uRows } = await client.query(
          `SELECT id, display_name, role, is_active FROM coexistence.z_chat_users WHERE id = $1`,
          [userId]
        );
        if (uRows.length === 0) {
          results.push({ ...base, status: 'error', error: `user ${userId} not found` });
          stepStatus = 'error';
          continue;
        }
        const u = uRows[0];
        if (u.is_active === false) {
          results.push({ ...base, status: 'error', error: `user ${u.display_name} is disabled` });
          stepStatus = 'error';
          continue;
        }

        // UPSERT — creates the contact row if it doesn't exist yet (new chats
        // won't have a row until someone saves). Preserves existing name/tags
        // if the row was already there.
        const { rows: cRows } = await client.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, assigned_user_id, updated_at, tenant_id, organization_id)
           VALUES ($1, $2, $3, NOW(),
             (SELECT tenant_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')),
             (SELECT organization_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')))
           ON CONFLICT (wa_number, contact_number) DO UPDATE
             SET assigned_user_id = EXCLUDED.assigned_user_id, updated_at = NOW(),
                 tenant_id = COALESCE(coexistence.contacts.tenant_id, EXCLUDED.tenant_id),
                 organization_id = COALESCE(coexistence.contacts.organization_id, EXCLUDED.organization_id)
           RETURNING wa_number, contact_number, assigned_user_id`,
          [waNumber, contactNumber, userId]
        );
        results.push({
          ...base,
          status: 'applied',
          assignedTo: { id: u.id, displayName: u.display_name, role: u.role },
          contact: cRows[0],
        });

      } else if (a.kind === 'Add Tag') {
        // a.value holds the tag NAME (from the builder dropdown). Resolve it to
        // the canonical {id,name,color,category_id} object so the contact's
        // tags JSONB matches the shape the rest of the app expects.
        const tagName = String(a.value || '').trim();
        if (!tagName) { results.push({ ...base, status: 'error', error: 'no tag selected' }); stepStatus = 'error'; continue; }
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const { rows: tagRows } = await client.query(
          `SELECT id, name, color, category_id FROM coexistence.tags WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [tagName]
        );
        if (tagRows.length === 0) { results.push({ ...base, status: 'error', error: `tag "${tagName}" not found` }); stepStatus = 'error'; continue; }
        const tag = tagRows[0];
        const { rows: cur } = await client.query(
          `SELECT tags FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber]
        );
        const existing = (cur[0] && cur[0].tags) || [];
        const already = existing.some(t => t && (t.id === tag.id || String(t.name || '').toLowerCase() === tag.name.toLowerCase()));
        const newTags = already ? existing : [...existing, { id: tag.id, name: tag.name, color: tag.color, category_id: tag.category_id }];
        // INSERT…ON CONFLICT — creates the row for brand-new chats with no
        // saved contact yet; only the tags column is touched so name/fields
        // on an existing row are preserved.
        await client.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, tags, updated_at, tenant_id, organization_id)
           VALUES ($1, $2, $3::jsonb, NOW(),
             (SELECT tenant_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')),
             (SELECT organization_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')))
           ON CONFLICT (wa_number, contact_number) DO UPDATE
             SET tags = EXCLUDED.tags, updated_at = NOW(),
                 tenant_id = COALESCE(coexistence.contacts.tenant_id, EXCLUDED.tenant_id),
                 organization_id = COALESCE(coexistence.contacts.organization_id, EXCLUDED.organization_id)`,
          [waNumber, contactNumber, JSON.stringify(newTags)]
        );
        context.contact = context.contact || {};
        context.contact.tags = newTags;
        if (!already) {
          contactMutated = true;
          // Fire Tag Applied triggers AFTER this run finishes (own client),
          // depth-guarded so tag-triggered flows can't recurse forever.
          const tagDepth = (context.__tagDepth || 0) + 1;
          setImmediate(() => evaluateTagTriggers({
            waNumber, contactNumber, added: [tag.name], depth: tagDepth,
          }).catch(e => console.error('[engine] tag-trigger (add) error:', e.message)));
        }
        results.push({ ...base, status: already ? 'skipped' : 'applied', tag: { id: tag.id, name: tag.name }, note: already ? 'Contact already had this tag' : 'Tag added' });

      } else if (a.kind === 'Remove Tag') {
        const tagName = String(a.value || '').trim();
        if (!tagName) { results.push({ ...base, status: 'error', error: 'no tag selected' }); stepStatus = 'error'; continue; }
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const { rows: cur } = await client.query(
          `SELECT tags FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber]
        );
        if (cur.length === 0) { results.push({ ...base, status: 'skipped', note: 'No contact row — nothing to remove' }); continue; }
        const existing = cur[0].tags || [];
        // Match by id where resolvable, and always by name (case-insensitive) so
        // legacy tag entries with a different/missing id still get removed.
        const { rows: tagRows } = await client.query(
          `SELECT id FROM coexistence.tags WHERE LOWER(name) = LOWER($1) LIMIT 1`, [tagName]
        );
        const tagId = tagRows[0] && tagRows[0].id;
        const newTags = existing.filter(t => !(t && (String(t.name || '').toLowerCase() === tagName.toLowerCase() || (tagId && t.id === tagId))));
        const removed = newTags.length !== existing.length;
        await client.query(
          `UPDATE coexistence.contacts SET tags = $3::jsonb, updated_at = NOW() WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber, JSON.stringify(newTags)]
        );
        context.contact = context.contact || {};
        context.contact.tags = newTags;
        if (removed) {
          contactMutated = true;
          const tagDepth = (context.__tagDepth || 0) + 1;
          setImmediate(() => evaluateTagTriggers({
            waNumber, contactNumber, removed: [tagName], depth: tagDepth,
          }).catch(e => console.error('[engine] tag-trigger (remove) error:', e.message)));
        }
        results.push({ ...base, status: removed ? 'applied' : 'skipped', note: removed ? 'Tag removed' : 'Contact did not have this tag' });

      } else if (a.kind === 'Set Custom Field') {
        // a.value is "Field Name = value". The contacts.custom_fields JSONB is
        // keyed by the field DEFINITION id (e.g. cf-city), not the name — so we
        // resolve name → id. The value is variable-resolved ({{name}} etc.).
        const raw = String(a.value || '');
        const ix = raw.indexOf('=');
        const fieldName = (ix >= 0 ? raw.slice(0, ix) : raw).trim();
        const rawVal    = ix >= 0 ? raw.slice(ix + 1).trim() : '';
        if (!fieldName) { results.push({ ...base, status: 'error', error: 'no field selected' }); stepStatus = 'error'; continue; }
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const { rows: fRows } = await client.query(
          `SELECT id, name FROM coexistence.contact_field_definitions WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [fieldName]
        );
        if (fRows.length === 0) { results.push({ ...base, status: 'error', error: `custom field "${fieldName}" not found` }); stepStatus = 'error'; continue; }
        const fieldId = fRows[0].id;
        const value = resolveVariables(rawVal, context);
        const { rows: cur } = await client.query(
          `SELECT custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber]
        );
        const cf = { ...((cur[0] && cur[0].custom_fields) || {}) };
        cf[fieldId] = value;
        await client.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, custom_fields, updated_at, tenant_id, organization_id)
           VALUES ($1, $2, $3::jsonb, NOW(),
             (SELECT tenant_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')),
             (SELECT organization_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')))
           ON CONFLICT (wa_number, contact_number) DO UPDATE
             SET custom_fields = EXCLUDED.custom_fields, updated_at = NOW(),
                 tenant_id = COALESCE(coexistence.contacts.tenant_id, EXCLUDED.tenant_id),
                 organization_id = COALESCE(coexistence.contacts.organization_id, EXCLUDED.organization_id)`,
          [waNumber, contactNumber, JSON.stringify(cf)]
        );
        context.contact = context.contact || {};
        context.contact.custom_fields = cf;
        contactMutated = true;
        results.push({ ...base, status: 'applied', field: { id: fieldId, name: fRows[0].name }, value, note: 'Custom field set' });

      } else if (a.kind === 'Clear Custom Field') {
        const fieldName = String(a.value || '').trim();
        if (!fieldName) { results.push({ ...base, status: 'error', error: 'no field selected' }); stepStatus = 'error'; continue; }
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const { rows: fRows } = await client.query(
          `SELECT id, name FROM coexistence.contact_field_definitions WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [fieldName]
        );
        if (fRows.length === 0) { results.push({ ...base, status: 'error', error: `custom field "${fieldName}" not found` }); stepStatus = 'error'; continue; }
        const fieldId = fRows[0].id;
        const { rows: cur } = await client.query(
          `SELECT custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber]
        );
        if (cur.length === 0) { results.push({ ...base, status: 'skipped', note: 'No contact row — nothing to clear' }); continue; }
        const cf = { ...(cur[0].custom_fields || {}) };
        const had = Object.prototype.hasOwnProperty.call(cf, fieldId);
        delete cf[fieldId];
        await client.query(
          `UPDATE coexistence.contacts SET custom_fields = $3::jsonb, updated_at = NOW() WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber, JSON.stringify(cf)]
        );
        context.contact = context.contact || {};
        context.contact.custom_fields = cf;
        if (had) contactMutated = true;
        results.push({ ...base, status: had ? 'applied' : 'skipped', field: { id: fieldId, name: fRows[0].name }, note: had ? 'Custom field cleared' : 'Field was already empty' });

      } else if (a.kind === 'Update Lead Score') {
        // a.value is a point delta like "+10" / "-5" / "15". Stored in the
        // contact's custom_fields under a "lead_score" field definition
        // (auto-created on first use so the score shows in the CRM).
        const delta = parseInt(resolveVariables(String(a.value || ''), context).replace(/[^-\d]/g, ''), 10);
        if (Number.isNaN(delta)) { results.push({ ...base, status: 'error', error: 'value must be a number (e.g. +10, -5)' }); stepStatus = 'error'; continue; }
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        let { rows: fRows } = await client.query(
          `SELECT id FROM coexistence.contact_field_definitions WHERE LOWER(name) = 'lead_score' LIMIT 1`
        );
        if (fRows.length === 0) {
          ({ rows: fRows } = await client.query(
            `INSERT INTO coexistence.contact_field_definitions (name, field_type) VALUES ('lead_score', 'number') RETURNING id`
          ));
        }
        const fieldId = fRows[0].id;
        const { rows: cur } = await client.query(
          `SELECT custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
          [waNumber, contactNumber]
        );
        const cf = { ...((cur[0] && cur[0].custom_fields) || {}) };
        const next = (parseInt(cf[fieldId], 10) || 0) + delta;
        cf[fieldId] = String(next);
        await client.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, custom_fields, updated_at, tenant_id, organization_id)
           VALUES ($1, $2, $3::jsonb, NOW(),
             (SELECT tenant_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')),
             (SELECT organization_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')))
           ON CONFLICT (wa_number, contact_number) DO UPDATE
             SET custom_fields = EXCLUDED.custom_fields, updated_at = NOW()`,
          [waNumber, contactNumber, JSON.stringify(cf)]
        );
        context.contact = context.contact || {};
        context.contact.custom_fields = cf;
        contactMutated = true;
        results.push({ ...base, status: 'applied', delta, leadScore: next });

      } else if (a.kind === 'Subscribe Contact' || a.kind === 'Unsubscribe Contact') {
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const subscribed = a.kind === 'Subscribe Contact';
        await client.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, subscribed, updated_at, tenant_id, organization_id)
           VALUES ($1, $2, $3, NOW(),
             (SELECT tenant_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')),
             (SELECT organization_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')))
           ON CONFLICT (wa_number, contact_number) DO UPDATE
             SET subscribed = EXCLUDED.subscribed, updated_at = NOW()`,
          [waNumber, contactNumber, subscribed]
        );
        contactMutated = true;
        results.push({ ...base, status: 'applied', subscribed, note: subscribed ? 'Contact subscribed' : 'Contact unsubscribed (drips stop)' });

      } else if (a.kind === 'Send Email') {
        const { sendMail, isMailerConfigured } = require('../util/mailer');
        const to = resolveVariables(String(a.value || ''), context).trim();
        if (!to || !to.includes('@')) { results.push({ ...base, status: 'error', error: 'no valid recipient email' }); stepStatus = 'error'; continue; }
        if (!isMailerConfigured()) { results.push({ ...base, status: 'error', error: 'SMTP not configured (set SMTP_HOST in .env)' }); stepStatus = 'error'; continue; }
        const contactName = context.contact?.name || contactNumber;
        const r = await sendMail({
          to,
          subject: `WhatsApp flow update — ${contactName}`,
          text:
            `Automation notification.\n\nContact: ${contactName} (${contactNumber})\n` +
            `Business number: ${waNumber}\nLast message: ${context.message_body || '(none)'}\n`,
        });
        if (!r.ok) { results.push({ ...base, status: 'error', error: r.error }); stepStatus = 'error'; }
        else results.push({ ...base, status: 'applied', to, note: 'Email sent' });

      } else if (a.kind === 'Start Sequence' || a.kind === 'Pause Sequence' || a.kind === 'End Sequence') {
        const sequences = require('../services/sequences');
        if (!waNumber || !contactNumber) { results.push({ ...base, status: 'error', error: 'context missing wa_number or contact_number' }); stepStatus = 'error'; continue; }
        const ref = resolveVariables(String(a.value || ''), context).trim();
        let r;
        if (a.kind === 'Start Sequence') {
          if (!ref) { results.push({ ...base, status: 'error', error: 'no sequence selected' }); stepStatus = 'error'; continue; }
          r = await sequences.enroll({ sequenceRef: ref, waNumber, contactNumber });
        } else {
          r = await sequences.setStatusForContact({
            waNumber, contactNumber,
            status: a.kind === 'Pause Sequence' ? 'paused' : 'ended',
            sequenceRef: ref || null,
          });
        }
        if (!r.ok) { results.push({ ...base, status: 'error', error: r.error }); stepStatus = 'error'; }
        else results.push({ ...base, status: 'applied', ...r });

      } else {
        // Honest stub — no real side-effect handler for this kind in this build.
        results.push({ ...base, status: 'logged', note: ACTION_STUB_NOTES[a.kind] || 'Action recorded; no side-effect handler in this build.' });
      }
    } catch (err) {
      results.push({ ...base, status: 'error', error: err.message });
      stepStatus = 'error';
    }
  }

  return logStep(client, executionId, node, { actions, contact: { waNumber, contactNumber } }, { results }, stepStatus);
}

// Human Handoff: assign the conversation to a team member and STOP the automated
// flow so a human can take over (the bot won't keep messaging past this node).
// assignMode 'specific' reads node.assigned (an ordered list of user ids) and
// picks the first active bda_sales/admin. Notifications: email (via SMTP mailer,
// if configured) and Create Task (tasks table) are delivered for real.
async function executeHandoffNode(client, executionId, node, context) {
  const waNumber = context.trigger_data?.wa_number;
  const contactNumber = context.contact_number;

  const ids = Array.isArray(node.assigned) ? node.assigned.map(x => parseInt(x, 10)).filter(Boolean) : [];
  let assignee = null;
  if (ids.length) {
    const { rows } = await client.query(
      `SELECT id, display_name, email, role FROM coexistence.z_chat_users
        WHERE id = ANY($1::bigint[]) AND is_active <> FALSE AND role IN ('bda_sales','admin')
        ORDER BY array_position($1::bigint[], id) LIMIT 1`,
      [ids]
    );
    assignee = rows[0] || null;
  }

  let assignedContact = null;
  if (assignee && waNumber && contactNumber) {
    const { rows } = await client.query(
      `INSERT INTO coexistence.contacts (wa_number, contact_number, assigned_user_id, updated_at, tenant_id, organization_id)
       VALUES ($1, $2, $3, NOW(),
         (SELECT tenant_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')),
         (SELECT organization_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')))
       ON CONFLICT (wa_number, contact_number) DO UPDATE
         SET assigned_user_id = EXCLUDED.assigned_user_id, updated_at = NOW(),
             tenant_id = COALESCE(coexistence.contacts.tenant_id, EXCLUDED.tenant_id),
             organization_id = COALESCE(coexistence.contacts.organization_id, EXCLUDED.organization_id)
       RETURNING wa_number, contact_number, assigned_user_id`,
      [waNumber, contactNumber, assignee.id]
    );
    assignedContact = rows[0];
  }

  // Deliver the configured notifications for real.
  const notify = node.notify || {};
  const notifications = {};
  const contactName = context.contact?.name || contactNumber;
  if (notify.email && assignee?.email) {
    const { sendMail, isMailerConfigured } = require('../util/mailer');
    if (isMailerConfigured()) {
      const r = await sendMail({
        to: assignee.email,
        subject: `Chat handed to you — ${contactName}`,
        text:
          `A WhatsApp conversation was handed off to you.\n\n` +
          `Contact: ${contactName} (${contactNumber})\nBusiness number: ${waNumber}\n` +
          `Priority: ${node.priority || 'normal'}` +
          (node.slaValue ? ` · respond within ${node.slaValue} ${node.slaUnit || 'minutes'}` : '') + `\n` +
          (node.internalNote ? `\nNote from the flow:\n${node.internalNote}\n` : '') +
          `\nLast message: ${context.message_body || '(none)'}\n`,
      });
      notifications.email = r.ok ? 'sent' : `failed: ${r.error}`;
    } else {
      notifications.email = 'skipped: SMTP not configured';
    }
  }
  if (notify.task) {
    try {
      const dueAt = node.slaValue
        ? new Date(Date.now() + (parseInt(node.slaValue, 10) || 15) * (node.slaUnit === 'hours' ? 3600000 : 60000))
        : null;
      await client.query(
        `INSERT INTO coexistence.tasks
           (title, description, priority, due_at, assigned_user_id, wa_number, contact_number, source, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'automation_handoff',
           (SELECT tenant_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($6,'[^0-9]','','g')))`,
        [
          `Follow up with ${contactName}`,
          node.internalNote || `Handed off by automation. Last message: ${context.message_body || '(none)'}`,
          ['low','normal','high','urgent'].includes(node.priority) ? node.priority : 'high',
          dueAt, assignee?.id || null, waNumber, contactNumber,
        ]
      );
      notifications.task = 'created';
    } catch (e) {
      notifications.task = `failed: ${e.message}`;
    }
  }

  const output = {
    assignMode: node.assignMode || 'specific',
    assignedTo: assignee ? { id: assignee.id, displayName: assignee.display_name, role: assignee.role } : null,
    priority: node.priority || 'normal',
    sla: node.slaValue ? `${node.slaValue} ${node.slaUnit || 'minutes'}` : null,
    internalNote: node.internalNote || null,
    contact: assignedContact,
    notifications,
    handedOff: true,
    note: assignee
      ? `Conversation assigned to ${assignee.display_name}. Automation stops here so the human can take over.`
      : 'Handoff reached but no active assignee was configured — automation stops for human review.',
  };
  const step = await logStep(client, executionId, node, {}, output, assignee ? 'success' : 'error');
  step.__endExecution = true; // human takes over → don't keep walking the graph
  return step;
}

// Send a free-form text to the flow's contact via the shared outbound queue.
// Used by the AI node reply. Returns the local message id.
async function sendFlowText(client, node, context, text) {
  const { resolveAccount, insertPendingRow } = require('../services/messageSender');
  const { enqueueSend } = require('../queue/sendQueue');
  const { account, error } = await resolveAccount({ fromPhoneNumber: context.trigger_data?.wa_number });
  if (error || !account) throw new Error(error || 'No WhatsApp account for this flow');
  const localId = await insertPendingRow({
    account, toNumber: context.contact_number, messageType: 'text', messageBody: text,
  });
  await enqueueSend({
    kind: 'text', accountId: account.id,
    to: String(context.contact_number).replace(/\D/g, ''),
    localMessageId: localId, payload: { body: text },
  }, { delayMs: context.__pendingSendDelayMs || 0 });
  context.__pendingSendDelayMs = 0;
  return localId;
}

// Send an approved template (no variable bindings) — the AI node's fallback.
async function sendFlowTemplate(client, node, context, templateId) {
  const { rows } = await client.query(
    `SELECT id, name, language, body FROM coexistence.message_templates WHERE id = $1 AND status = 'APPROVED'`,
    [parseInt(templateId, 10)]
  );
  const tpl = rows[0];
  if (!tpl) throw new Error(`Fallback template ${templateId} not found or not approved`);
  const { resolveAccount, insertPendingRow } = require('../services/messageSender');
  const { enqueueSend } = require('../queue/sendQueue');
  const { account, error } = await resolveAccount({ fromPhoneNumber: context.trigger_data?.wa_number });
  if (error || !account) throw new Error(error || 'No WhatsApp account for this flow');
  const localId = await insertPendingRow({
    account, toNumber: context.contact_number, messageType: 'template', messageBody: tpl.body,
  });
  await enqueueSend({
    kind: 'template', accountId: account.id,
    to: String(context.contact_number).replace(/\D/g, ''),
    localMessageId: localId,
    payload: { name: tpl.name, languageCode: tpl.language || 'en', components: [] },
  }, { delayMs: 0 });
  return { localId, templateName: tpl.name };
}

const AI_TASK_LABELS = {
  lead_qualification: 'lead qualification', customer_support: 'customer support',
  appointment_booking: 'appointment booking', product_recommendation: 'product recommendation',
  order_status: 'order status lookup', payment_assistance: 'payment assistance',
  faq_answering: 'FAQ answering', data_collection: 'structured data collection',
};
const AI_DEFAULT_MODEL = { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' };

// AI step: single-shot LLM call (via the AI Models registry) scoped to a
// concrete business task. Replies to the contact on WhatsApp (inside the 24h
// service window only — Meta rule), optionally saves the output to a contact
// field, and falls back to a template / handoff / exit when the window is
// closed or the model call fails.
async function executeAINode(client, executionId, node, context) {
  const { decrypt } = require('../util/crypto');
  const fallback = node.aiFallback || 'fallback_message';
  const waNumber = context.trigger_data?.wa_number;
  const contactNumber = context.contact_number;

  const runFallback = async (reason) => {
    const out = { reason, fallback };
    try {
      if (fallback === 'fallback_message' && node.fallbackTemplateId) {
        const sent = await sendFlowTemplate(client, node, context, node.fallbackTemplateId);
        out.sentTemplate = sent.templateName;
        return logStep(client, executionId, node, { aiTask: node.aiTask }, out, 'success');
      }
      const step = await logStep(client, executionId, node, { aiTask: node.aiTask }, {
        ...out,
        note: fallback === 'handoff'
          ? 'AI unavailable — flow stopped for human takeover.'
          : 'AI unavailable — flow exited per node config.',
      }, fallback === 'exit' ? 'success' : 'error');
      step.__endExecution = true;
      return step;
    } catch (e) {
      const step = await logStep(client, executionId, node, {}, { reason, fallbackError: e.message }, 'error');
      step.__endExecution = true;
      return step;
    }
  };

  // 24h service window: free-form messages are only deliverable within 24h of
  // the contact's last inbound message.
  const { rows: win } = await client.query(
    `SELECT 1 FROM coexistence.chat_history
      WHERE wa_number = $1 AND contact_number = $2 AND direction = 'incoming'
        AND timestamp > NOW() - INTERVAL '24 hours' LIMIT 1`,
    [waNumber, contactNumber]
  );
  if (win.length === 0) return runFallback('outside_24h_window');

  // First usable model from the registry (env keys as fallback).
  const { rows: models } = await client.query(
    `SELECT id, provider, api_key_encrypted FROM coexistence.ai_models
      WHERE provider IN ('anthropic','openai') ORDER BY created_at DESC`
  );
  let provider = null, apiKey = null;
  for (const m of models) {
    const k = m.api_key_encrypted ? decrypt(m.api_key_encrypted) : null;
    if (k) { provider = m.provider; apiKey = k; break; }
  }
  if (!apiKey && process.env.ANTHROPIC_API_KEY) { provider = 'anthropic'; apiKey = process.env.ANTHROPIC_API_KEY; }
  if (!apiKey && process.env.OPENAI_API_KEY)    { provider = 'openai';    apiKey = process.env.OPENAI_API_KEY; }
  if (!apiKey) return runFallback('no_ai_model_connected');

  try {
    const taskLabel = AI_TASK_LABELS[node.aiTask] || 'customer assistance';
    const contact = context.contact || {};
    const systemPrompt =
      `You are a WhatsApp business assistant performing ${taskLabel} for this business. ` +
      `Goal for this step: ${node.aiGoal || 'assist the customer with their request'}.\n` +
      (node.aiContext ? `Business context:\n${node.aiContext}\n` : '') +
      `Rules: stay strictly on the business task; keep the reply short (WhatsApp-appropriate, under 800 characters); ` +
      `plain text only (no markdown); never invent prices or availability not present in the context.`;
    const userMsg =
      `Customer${contact.name ? ` (${contact.name})` : ''} says: ${context.message_body || '(no text)'}`;

    const { runWithTools } = provider === 'anthropic' ? require('../llm/anthropic') : require('../llm/openai');
    const result = await runWithTools({
      systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
      tools: [],
      onToolCall: async () => 'no tools available',
      onStep: async () => {},
      model: AI_DEFAULT_MODEL[provider],
      apiKey,
      maxIterations: 1,
    });
    const reply = (result.finalText || '').trim();
    if (!reply) return runFallback('empty_ai_reply');

    const localId = await sendFlowText(client, node, context, reply);

    // Optionally persist the AI output to a contact custom field.
    let savedTo = null;
    const fieldName = String(node.aiSaveTo || '').trim();
    if (fieldName && fieldName !== '__new__' && waNumber && contactNumber) {
      const { rows: fRows } = await client.query(
        `SELECT id, name FROM coexistence.contact_field_definitions WHERE LOWER(name) = LOWER($1) LIMIT 1`, [fieldName]
      );
      if (fRows.length) {
        const { rows: cur } = await client.query(
          `SELECT custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`, [waNumber, contactNumber]
        );
        const cf = { ...((cur[0] && cur[0].custom_fields) || {}) };
        cf[fRows[0].id] = reply.slice(0, 2000);
        await client.query(
          `INSERT INTO coexistence.contacts (wa_number, contact_number, custom_fields, updated_at, tenant_id, organization_id)
           VALUES ($1, $2, $3::jsonb, NOW(),
             (SELECT tenant_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')),
             (SELECT organization_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')))
           ON CONFLICT (wa_number, contact_number) DO UPDATE
             SET custom_fields = EXCLUDED.custom_fields, updated_at = NOW()`,
          [waNumber, contactNumber, JSON.stringify(cf)]
        );
        savedTo = fRows[0].name;
      }
    }

    return logStep(client, executionId, node, { aiTask: node.aiTask, goal: node.aiGoal }, {
      provider, model: AI_DEFAULT_MODEL[provider], reply, savedTo,
      tokens: { input: result.totalInputTokens, output: result.totalOutputTokens },
      whatsapp: { message_id: localId, to: contactNumber, message_type: 'text', status: 'sending' },
    }, 'success', null, localId, 'sending');
  } catch (err) {
    console.error('[engine] AI node error:', err.message);
    return runFallback(`ai_error: ${err.message}`.slice(0, 300));
  }
}

// Minimal `$.a.b[0].c` (or `a.b`) extractor. No wildcards/filters — just a path.
function extractJsonPath(obj, path) {
  const clean = String(path || '').replace(/^\$\.?/, '').trim();
  if (!clean) return obj;
  return clean.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    const m = key.match(/^([^[]+)?(?:\[(\d+)\])?$/);
    if (!m) return undefined;
    let v = m[1] ? acc[m[1]] : acc;
    if (m[2] !== undefined && Array.isArray(v)) v = v[Number(m[2])];
    return v;
  }, obj);
}

// API / Webhook node: make a real outbound HTTP request from the flow. URL,
// header values and body are variable-resolved ({{name}} etc.); the request goes
// through ssrfSafeFetch so it can't be aimed at loopback / cloud-metadata /
// internal services. Optionally extracts a value from the JSON response and saves
// it onto the contact. onError: 'continue' (default) | 'retry' (3x) | 'exit'.
async function executeAPINode(client, executionId, node, context) {
  const method = String(node.method || 'POST').toUpperCase();
  const url = resolveVariables(String(node.url || node.apiUrl || node.endpoint || ''), context).trim();
  const onError = node.onError || 'continue';
  const waNumber = context.trigger_data?.wa_number;
  const contactNumber = context.contact_number;

  const finishError = async (message, extra = {}) => {
    const step = await logStep(client, executionId, node, { method, url }, { error: message, ...extra }, 'error');
    if (onError === 'exit') step.__endExecution = true;
    return step;
  };

  if (!/^https?:\/\//i.test(url)) {
    return finishError('Invalid or missing URL (must start with http:// or https://)');
  }

  const headers = {};
  for (const h of (Array.isArray(node.apiHeaders) ? node.apiHeaders : [])) {
    const key = (h && (h.k ?? h.key)) ? String(h.k ?? h.key).trim() : '';
    if (key) headers[key] = resolveVariables(String(h.v ?? h.value ?? ''), context);
  }

  const init = { method, headers };
  if (method !== 'GET' && method !== 'DELETE') {
    const body = resolveVariables(String(node.apiBody ?? node.body ?? ''), context);
    if (body && body.trim()) {
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      init.body = body;
    }
  }

  const attempts = onError === 'retry' ? 3 : 1;
  let res = null, raw = null, lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      res = await ssrfSafeFetch(url, { ...init, signal: ctrl.signal });
      raw = await res.text();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err.name === 'AbortError' ? 'Request timed out (15s)' : err.message;
    } finally { clearTimeout(timer); }
  }
  if (lastErr) return finishError(lastErr, { attempts });

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = raw && raw.length > 4000 ? raw.slice(0, 4000) + '…[truncated]' : raw; }

  // Optional: extract a value from the response and save it to a contact field.
  let savedTo = null;
  const fieldName = String(node.respField || '').trim();
  if (fieldName && waNumber && contactNumber) {
    try {
      const value = extractJsonPath(parsed, node.respPath || '$');
      if (value !== undefined && value !== null) {
        const { rows: fRows } = await client.query(
          `SELECT id, name FROM coexistence.contact_field_definitions WHERE LOWER(name) = LOWER($1) LIMIT 1`, [fieldName]
        );
        if (fRows.length) {
          const { rows: cur } = await client.query(
            `SELECT custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`, [waNumber, contactNumber]
          );
          const cf = { ...((cur[0] && cur[0].custom_fields) || {}) };
          cf[fRows[0].id] = typeof value === 'object' ? JSON.stringify(value) : String(value);
          await client.query(
            `INSERT INTO coexistence.contacts (wa_number, contact_number, custom_fields, updated_at, tenant_id, organization_id)
             VALUES ($1, $2, $3::jsonb, NOW(),
               (SELECT tenant_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')),
               (SELECT organization_id FROM coexistence.whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')))
             ON CONFLICT (wa_number, contact_number) DO UPDATE
               SET custom_fields = EXCLUDED.custom_fields, updated_at = NOW(),
                   tenant_id = COALESCE(coexistence.contacts.tenant_id, EXCLUDED.tenant_id),
                   organization_id = COALESCE(coexistence.contacts.organization_id, EXCLUDED.organization_id)`,
            [waNumber, contactNumber, JSON.stringify(cf)]
          );
          context.contact = context.contact || {};
          context.contact.custom_fields = cf;
          savedTo = { field: fRows[0].name, value: cf[fRows[0].id] };
        }
      }
    } catch (e) { savedTo = { error: `Could not save response: ${e.message}` }; }
  }

  const httpOk = res.status >= 200 && res.status < 300;
  const step = await logStep(client, executionId, node, { method, url }, {
    status: res.status, ok: httpOk, response: parsed, savedTo,
  }, httpOk ? 'success' : 'error');
  if (!httpOk && onError === 'exit') step.__endExecution = true;
  return step;
}

// Sub-Flow: run another automation inline as a child execution (it gets its own
// execution row, so it's fully visible in the runs log). Guards: max nesting
// depth 3 and a cycle check on the automation-id stack, so A→B→A can't loop.
async function executeSubflowNode(client, executionId, node, context) {
  const flowId = parseInt(node.flowId || node.subflowId, 10);
  const waitMode = node.waitMode || 'await';
  if (!flowId) {
    return logStep(client, executionId, node, {}, { error: 'No sub-flow selected' }, 'error');
  }

  const depth = (context.__subflowDepth || 0) + 1;
  const stack = Array.isArray(context.__subflowStack) ? context.__subflowStack : [];
  if (depth > 3) {
    return logStep(client, executionId, node, { flowId }, { error: 'Sub-flow nesting limit (3) reached' }, 'error');
  }
  if (stack.includes(flowId)) {
    return logStep(client, executionId, node, { flowId }, { error: 'Sub-flow cycle detected — refusing to loop' }, 'error');
  }

  const { rows } = await client.query(
    `SELECT id, name, status, trigger_type, config FROM coexistence.chatbots WHERE id = $1`, [flowId]
  );
  const sub = rows[0];
  if (!sub) {
    return logStep(client, executionId, node, { flowId }, { error: `Sub-flow ${flowId} no longer exists` }, 'error');
  }

  const childContext = {
    ...context,
    __subflowDepth: depth,
    __subflowStack: [...stack, flowId],
    __pendingSendDelayMs: 0,
  };
  let childExecution = null, childError = null;
  try {
    childExecution = await executeAutomation(client, sub, childContext);
  } catch (e) { childError = e.message; }

  const output = {
    subflow: { id: sub.id, name: sub.name },
    waitMode,
    childExecutionId: childExecution?.id || null,
    ...(childError ? { error: childError } : {}),
    note: childError ? `Sub-flow failed: ${childError}` : `Ran sub-flow "${sub.name}"`,
  };
  const step = await logStep(client, executionId, node, { flowId }, output, childError ? 'error' : 'success');
  // waitMode 'handoff': the sub-flow was the terminal step — end the parent too.
  if (waitMode === 'handoff') step.__endExecution = true;
  return step;
}

// Executable node types. Trigger + Send Message are the linear core; Condition
// (yes/no branch), Smart Delay (non-blocking send delay), and Action (Add Tag /
// Remove Tag etc.) are dispatched by the walker too — see walkFrom for how a
// Condition's matched result selects the 'yes'/'no' outgoing edge.
// handoff/ai/api/subflow handlers remain defined but unwired (not in the
// builder palette); an unknown type is skipped by the walker, not failed.
const NODE_HANDLERS = {
  trigger: executeTriggerNode,
  message: executeMessageNode,
  condition: executeConditionNode,
  delay: executeDelayNode,
  action: executeActionNode,
  handoff: executeHandoffNode,
  api: executeAPINode,
  ai: executeAINode,
  subflow: executeSubflowNode,
};

// ─── Graph Walker ────────────────────────────────────────────────────

async function executeAutomation(client, automation, context) {
  const config = automation.config || {};
  const nodes = config.nodes || [];
  const edges = config.edges || [];

  if (nodes.length === 0) {
    console.log(`[engine] Automation ${automation.id} has no nodes`);
    return null;
  }

  // Create execution record
  const { rows } = await client.query(
    `INSERT INTO coexistence.automation_executions
     (automation_id, status, trigger_type, trigger_data, contact_number, started_at, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,
       (SELECT tenant_id FROM coexistence.chatbots WHERE id = $1))
     RETURNING *`,
    [
      automation.id,
      'running',
      context.trigger_type || 'keyword',
      JSON.stringify(context.trigger_data || {}),
      context.contact_number || null,
      new Date().toISOString(),
    ]
  );
  const execution = rows[0];

  try {
    // Find trigger node
    const triggerNode = nodes.find(n => n.type === 'trigger');
    if (!triggerNode) {
      throw new Error('No trigger node found in automation');
    }

    // Execute trigger
    await executeTriggerNode(client, execution.id, triggerNode, context);

    // Walk graph starting from nodes connected to trigger
    const triggerEdges = edges.filter(e => e.from === triggerNode.id);
    const startNodeId = triggerEdges.length > 0 ? triggerEdges[0].to : null;
    const visited = new Set([triggerNode.id]);

    const result = await walkFrom(client, execution.id, nodes, edges, startNodeId, context, visited);

    if (!result.paused) {
      await updateExecutionStatus(client, execution.id, 'success');
    }
    return execution;

  } catch (err) {
    console.error(`[engine] Execution error for automation ${automation.id}:`, err.message);
    await updateExecutionStatus(client, execution.id, 'error', err.message);
    return execution;
  }
}

// Walks the graph DFS from startNodeId. Returns { paused: boolean } —
// paused=true means a node signalled `step.__pauseExecution`, in which case
// the walker exited without finishing and the caller should NOT mark the
// execution as success (the pausing handler already flipped it to 'paused').
async function walkFrom(client, executionId, nodes, edges, startNodeId, context, visited = new Set()) {
  let currentNodeId = startNodeId;
  while (currentNodeId && !visited.has(currentNodeId)) {
    visited.add(currentNodeId);
    const node = nodes.find(n => n.id === currentNodeId);
    if (!node) break;

    const handler = NODE_HANDLERS[node.type];
    let step = null;
    if (handler) {
      step = await handler(client, executionId, node, context);
      // A Message node with waitForReply pauses the execution; exit cleanly —
      // the handler already flipped the execution row to status='paused'.
      if (step && step.__pauseExecution) {
        return { paused: true };
      }
      // A Handoff node ends the automated flow (a human takes over) — stop
      // walking so no further nodes run after the conversation is handed off.
      if (step && step.__endExecution) {
        return { paused: false };
      }
    } else {
      // Unknown / unwired node type (e.g. handoff/ai/api/subflow — defined but
      // not in the builder palette). Skip it and continue down the chain rather
      // than failing the whole run.
      await logStep(
        client, executionId, node, {},
        { note: `Skipped unsupported node type "${node.type}".` },
        'skipped'
      );
    }

    // Pick the outgoing edge. A Condition node routes to its 'yes' (matched) or
    // 'no' (not-matched) handle based on the evaluated result logged by
    // executeConditionNode; every other node follows its default edge (falling
    // back to the first edge so a node with only a branch handle still moves on).
    let fromHandle = 'default';
    if (node.type === 'condition' && step && step.output_data) {
      fromHandle = step.output_data.matched ? 'yes' : 'no';
    }
    const fromEdges = edges.filter(e => e.from === currentNodeId);
    let nextEdge;
    if (fromHandle === 'default') {
      nextEdge = fromEdges.find(e => !e.fromHandle || e.fromHandle === 'default') || fromEdges[0] || null;
    } else {
      // A branch with no connected edge ends the flow (no fallback to default —
      // that would wrongly send the not-matched path down the matched branch).
      nextEdge = fromEdges.find(e => e.fromHandle === fromHandle) || null;
    }
    currentNodeId = nextEdge ? nextEdge.to : null;
  }
  return { paused: false };
}

// Resume a paused execution. Atomically claims the row (status=paused →
// running) so concurrent inbound messages can't double-resume. Walks the
// graph from the children of the node where it paused, using the new
// inbound `record` as context.message_body.
async function resumeAutomation(client, executionId, record) {
  // Atomic claim — only one caller wins
  const { rows: claimed } = await client.query(
    `UPDATE coexistence.automation_executions
        SET status='running'
      WHERE id=$1 AND status='paused' AND expires_at>NOW()
     RETURNING id, automation_id, awaiting_node_id, trigger_data, contact_number`,
    [executionId]
  );
  if (claimed.length === 0) {
    // Already claimed by another worker, or expired
    return null;
  }
  const execRow = claimed[0];

  // Load the latest automation config
  const { rows: botRows } = await client.query(
    `SELECT id, name, config FROM coexistence.chatbots WHERE id = $1`,
    [execRow.automation_id]
  );
  if (botRows.length === 0) {
    await updateExecutionStatus(client, executionId, 'error', 'Automation no longer exists');
    return null;
  }
  const config = botRows[0].config || {};
  const nodes = config.nodes || [];
  const edges = config.edges || [];

  // Build context from the fresh inbound record (mirrors evaluateTriggers)
  const context = {
    contact_number: record.contact_number,
    message_body: record.message_body,
    message_type: record.message_type,
    trigger_type: 'resume',
    trigger_data: {
      message_id: record.message_id,
      wa_number: record.wa_number,
      phone_number_id: record.phone_number_id,
      timestamp: record.timestamp,
      media_url: record.media_url,
      media_mime_type: record.media_mime_type,
      status: record.status,
      conversation: record.conversation || null,
      pricing: record.pricing || null,
      errors: record.errors || null,
    },
  };

  // Re-hydrate contact info same as evaluateTriggers does
  try {
    const { rows: contactRows } = await client.query(
      `SELECT name, profile_name, tags, custom_fields FROM coexistence.contacts
        WHERE wa_number = $1 AND contact_number = $2`,
      [record.wa_number, record.contact_number]
    );
    if (contactRows.length > 0) {
      context.contact = {
        name: contactRows[0].name,
        profile_name: contactRows[0].profile_name,
        contact_number: record.contact_number,
        tags: contactRows[0].tags || [],
        custom_fields: contactRows[0].custom_fields || {},
      };
    }
  } catch (e) { /* non-fatal */ }

  // Field definitions let resolveVariables map custom_fields (id-keyed) back to
  // their {{normalized_name}} tokens.
  try {
    const { rows: fdRows } = await client.query(`SELECT id, name FROM coexistence.contact_field_definitions`);
    context.field_defs = fdRows;
  } catch (e) { context.field_defs = []; }

  // Find the node we paused at. For a Message node with waitForReply we
  // resume at its CHILDREN (the reply continues the flow). For an AI Agent
  // in conversational mode we resume AT THE SAME node — it needs to take the
  // next turn against the customer's new message.
  const pausedNode = nodes.find(n => n.id === execRow.awaiting_node_id);
  if (!pausedNode) {
    await updateExecutionStatus(client, executionId, 'error', `Paused node ${execRow.awaiting_node_id} no longer in automation config`);
    return null;
  }
  // Resume at the child of the paused node (a Message node with waitForReply).
  const nextEdges = edges.filter(e =>
    e.from === execRow.awaiting_node_id && (!e.fromHandle || e.fromHandle === 'default')
  );
  let startNodeId = nextEdges.length > 0 ? nextEdges[0].to : null;
  if (!startNodeId) {
    // Paused with nothing downstream — just close it out
    await client.query(
      `UPDATE coexistence.automation_executions
          SET status='success', awaiting_node_id=NULL, completed_at=NOW()
        WHERE id=$1`,
      [executionId]
    );
    return execRow;
  }

  console.log(`[engine] Resuming execution=${executionId} automation=${execRow.automation_id} from node=${startNodeId}`);

  try {
    // visited Set deliberately empty — the resumed walk treats startNodeId
    // as fresh. Cycle protection still works because walkFrom adds each
    // node as it visits.
    const result = await walkFrom(client, executionId, nodes, edges, startNodeId, context);
    if (!result.paused) {
      await client.query(
        `UPDATE coexistence.automation_executions
            SET status='success', awaiting_node_id=NULL, completed_at=NOW()
          WHERE id=$1`,
        [executionId]
      );
    }
    return execRow;
  } catch (err) {
    console.error(`[engine] Resume error for execution ${executionId}:`, err.message);
    await client.query(
      `UPDATE coexistence.automation_executions
          SET status='error', awaiting_node_id=NULL, error_message=$2, completed_at=NOW()
        WHERE id=$1`,
      [executionId, err.message]
    );
    return execRow;
  }
}

// ─── Trigger Evaluation ──────────────────────────────────────────────

async function evaluateTriggers(messageRecord) {
  const client = await pool.connect();
  const executions = [];

  try {
    // Fetch all active automations
    const { rows: automations } = await client.query(
      `SELECT id, name, status, trigger_type, config
       FROM coexistence.chatbots
       WHERE status = 'active'`
    );

    const context = {
      contact_number: messageRecord.contact_number,
      message_body: messageRecord.message_body,
      message_type: messageRecord.message_type,
      trigger_type: 'keyword',
      trigger_data: {
        message_id: messageRecord.message_id,
        wa_number: messageRecord.wa_number,
        phone_number_id: messageRecord.phone_number_id,
        timestamp: messageRecord.timestamp,
        media_url: messageRecord.media_url,
        media_mime_type: messageRecord.media_mime_type,
        status: messageRecord.status,
        conversation: messageRecord.conversation || null,
        pricing: messageRecord.pricing || null,
        errors: messageRecord.errors || null,
      },
    };

    // Try to load contact data
    try {
      const { rows: contactRows } = await client.query(
        `SELECT name, profile_name, tags, custom_fields
         FROM coexistence.contacts
         WHERE wa_number = $1 AND contact_number = $2
         LIMIT 1`,
        [messageRecord.wa_number, messageRecord.contact_number]
      );
      if (contactRows.length > 0) {
        context.contact = {
          name: contactRows[0].name,
          profile_name: contactRows[0].profile_name,
          contact_number: messageRecord.contact_number,
          tags: contactRows[0].tags || [],
          custom_fields: contactRows[0].custom_fields || {},
        };
      }
    } catch (e) {
      // Contact lookup failed, continue without contact data
    }

    // Field definitions for {{custom_field_name}} resolution + AI persistence.
    try {
      const { rows: fdRows } = await client.query(`SELECT id, name FROM coexistence.contact_field_definitions`);
      context.field_defs = fdRows;
    } catch (e) { context.field_defs = []; }

    // Computed at most once per inbound message (only when actually needed),
    // then reused across every automation.
    let isNewContact;
    let hasLiveExecution;

    for (const automation of automations) {
      const config = automation.config || {};
      const nodes = config.nodes || [];
      const triggerNode = nodes.find(n => n.type === 'trigger');
      if (!triggerNode) continue;

      // WhatsApp-account filter: if the trigger node names specific accounts,
      // only fire when the inbound record arrived on one of them. Empty/missing
      // = listen on every account (backward-compatible with pre-2026-05-19 flows).
      const triggerAccounts = Array.isArray(triggerNode.triggerAccounts) ? triggerNode.triggerAccounts : [];
      if (triggerAccounts.length > 0 && !triggerAccounts.includes(messageRecord.wa_number)) {
        continue;
      }

      // Message-driven trigger kinds: keyword / anyMessage / newContact / link /
      // qr all fire from an inbound WhatsApp message (link & qr arrive as a
      // normal message whose body is the wa.me pre-filled text). tagApplied
      // fires from evaluateTagTriggers; webhook fires from /api/hooks.
      const triggerKind = triggerNode.triggerKind || 'keyword';
      const isRealMessage = messageRecord.message_type !== 'status' && messageRecord.message_type !== 'reaction';

      let shouldFire = false;
      if (triggerKind === 'keyword') {
        shouldFire = isRealMessage && matchesKeyword(
          messageRecord.message_body, triggerNode.keyword || '',
          triggerNode.matchType || 'exact', !!triggerNode.caseSensitive
        );
      } else if (triggerKind === 'anyMessage') {
        if (isRealMessage) {
          const requireTag = String(triggerNode.requireTag || '').trim().toLowerCase();
          if (requireTag) {
            // Honor the "only for contacts with tag" filter (tags may be strings or {name} objects).
            const tags = (context.contact?.tags || []).map(t => (typeof t === 'string' ? t : (t?.name || ''))).map(s => String(s).toLowerCase());
            shouldFire = tags.includes(requireTag);
          } else {
            shouldFire = true;
          }
          // "Skip if contact is already in another flow" (default ON).
          if (shouldFire && (triggerNode.skipIfInFlow === undefined || triggerNode.skipIfInFlow)) {
            if (hasLiveExecution === undefined) {
              const { rows: le } = await client.query(
                `SELECT 1 FROM coexistence.automation_executions
                  WHERE contact_number = $1 AND status IN ('running','paused') LIMIT 1`,
                [messageRecord.contact_number]
              );
              hasLiveExecution = le.length > 0;
            }
            if (hasLiveExecution) shouldFire = false;
          }
        }
      } else if (triggerKind === 'newContact') {
        if (isRealMessage) {
          // The inbound message is already committed to chat_history before we run,
          // so "first ever inbound" means the count is exactly 1. Computed once.
          if (isNewContact === undefined) {
            const { rows: cc } = await client.query(
              `SELECT COUNT(*)::int AS n FROM coexistence.chat_history
                WHERE wa_number = $1 AND contact_number = $2 AND direction = 'incoming'`,
              [messageRecord.wa_number, messageRecord.contact_number]
            );
            isNewContact = (cc[0]?.n ?? 0) <= 1;
          }
          if (triggerNode.onlyFirstEver === false) {
            // Also fire for returning contacts, as long as they're not mid-flow.
            const { rows: le } = await client.query(
              `SELECT 1 FROM coexistence.automation_executions
                WHERE automation_id = $1 AND contact_number = $2 AND status IN ('running','paused') LIMIT 1`,
              [automation.id, messageRecord.contact_number]
            );
            shouldFire = le.length === 0;
          } else {
            shouldFire = isNewContact;
          }
          // "Require DPDP/GDPR opt-in": only proceed for subscribed contacts.
          if (shouldFire && triggerNode.requireOptIn) {
            const { rows: sub } = await client.query(
              `SELECT subscribed FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2 LIMIT 1`,
              [messageRecord.wa_number, messageRecord.contact_number]
            );
            if (sub.length && sub[0].subscribed === false) shouldFire = false;
          }
        }
      } else if (triggerKind === 'link' || triggerKind === 'qr') {
        // wa.me links & QR codes deliver as a normal inbound message whose body
        // is the pre-filled text — that text is the attribution marker.
        const marker = String(triggerNode.prefilledMsg || '').trim().toLowerCase();
        const body = String(messageRecord.message_body || '').trim().toLowerCase();
        shouldFire = isRealMessage && !!marker && (body === marker || body.startsWith(marker));
      } else {
        continue; // tagApplied/webhook/apiEvent — fired from other event sources
      }

      if (shouldFire) {
        context.trigger_type = triggerKind;
        console.log(`[engine] Trigger match (${triggerKind}): automation=${automation.id}`);
        const execution = await executeAutomation(client, automation, context);
        if (execution) executions.push(execution);
      }
    }

  } catch (err) {
    console.error('[engine] evaluateTriggers error:', err.message);
  } finally {
    client.release();
  }

  return executions;
}

// ─── Tag Applied trigger ─────────────────────────────────────────────
// Fires automations whose trigger is "Tag Applied" when tags change on a
// contact — from an automation action (Add/Remove Tag) or a manual contact
// save. depth guards recursion: a tag-triggered flow that itself tags the
// contact may fire ONE more level, then stops.
async function evaluateTagTriggers({ waNumber, contactNumber, added = [], removed = [], depth = 0 }) {
  if (depth >= 2) return [];
  const addedNames = added.map(t => String(typeof t === 'string' ? t : t?.name || '').toLowerCase()).filter(Boolean);
  const removedNames = removed.map(t => String(typeof t === 'string' ? t : t?.name || '').toLowerCase()).filter(Boolean);
  if (addedNames.length === 0 && removedNames.length === 0) return [];

  const client = await pool.connect();
  const executions = [];
  try {
    const { rows: automations } = await client.query(
      `SELECT id, name, status, trigger_type, config FROM coexistence.chatbots WHERE status = 'active'`
    );

    const context = {
      contact_number: contactNumber,
      message_body: '',
      message_type: 'tag_event',
      trigger_type: 'tagApplied',
      trigger_data: { wa_number: waNumber, contact_number: contactNumber },
      __tagDepth: depth,
    };
    try {
      const { rows: contactRows } = await client.query(
        `SELECT name, profile_name, tags, custom_fields FROM coexistence.contacts
          WHERE wa_number = $1 AND contact_number = $2 LIMIT 1`,
        [waNumber, contactNumber]
      );
      if (contactRows.length > 0) {
        context.contact = {
          name: contactRows[0].name, profile_name: contactRows[0].profile_name,
          contact_number: contactNumber,
          tags: contactRows[0].tags || [], custom_fields: contactRows[0].custom_fields || {},
        };
      }
    } catch { /* continue without contact */ }
    try {
      const { rows: fdRows } = await client.query(`SELECT id, name FROM coexistence.contact_field_definitions`);
      context.field_defs = fdRows;
    } catch { context.field_defs = []; }

    for (const automation of automations) {
      const nodes = (automation.config || {}).nodes || [];
      const triggerNode = nodes.find(n => n.type === 'trigger');
      if (!triggerNode || (triggerNode.triggerKind || 'keyword') !== 'tagApplied') continue;

      const wantTag = String(triggerNode.tag || '').trim().toLowerCase();
      if (!wantTag) continue;
      const direction = triggerNode.tagDirection === 'removed' ? 'removed' : 'added';
      const pool_ = direction === 'removed' ? removedNames : addedNames;
      if (!pool_.includes(wantTag)) continue;

      // fireOncePerTag (default ON): don't refire for a contact this automation
      // already ran for on the same tag.
      if (triggerNode.fireOncePerTag !== false) {
        const { rows: prev } = await client.query(
          `SELECT 1 FROM coexistence.automation_executions
            WHERE automation_id = $1 AND contact_number = $2
              AND trigger_data->>'tag' = $3 LIMIT 1`,
          [automation.id, contactNumber, wantTag]
        );
        if (prev.length > 0) continue;
      }

      const runContext = {
        ...context,
        trigger_data: { ...context.trigger_data, tag: wantTag, direction },
      };
      console.log(`[engine] Tag trigger (${direction} "${wantTag}"): automation=${automation.id}`);
      const execution = await executeAutomation(client, automation, runContext);
      if (execution) executions.push(execution);
    }
  } catch (err) {
    console.error('[engine] evaluateTagTriggers error:', err.message);
  } finally {
    client.release();
  }
  return executions;
}

module.exports = {
  evaluateTriggers,
  evaluateTagTriggers,
  executeAutomation,
  resumeAutomation,
  matchesKeyword,
  resolveVariables,
  evaluateConditions,
};
