# Feature Update Spec — Lead Management, AI Scoring & CRM Sync

> **Purpose of this document.** This is an implementation prompt. It describes, in
> platform-agnostic terms, every feature shipped between commit `32d307f`
> ("update lead score") and `4729d85` ("zoho crm tag") — 14 commits, ~5,700 lines.
> Hand this to a developer or a coding agent to reproduce the same functionality
> on a different stack.
>
> **Reference implementation** (for vocabulary only — do not assume these
> technologies): Node 20 + Express, PostgreSQL, React 18. Adapt freely.

---

## 0. Product context you need before starting

The product is a **multi-account WhatsApp Business CRM**: a shared team inbox,
contacts, broadcasts, a visual automation builder, AI agents, and a lead-triage
view called **Lead Studio**.

### The one data-model fact that drives everything

A **contact is keyed by a composite of `(business_whatsapp_number, customer_phone)`**.
The same customer messaging two different business numbers is two separate contact
rows. Every feature below respects this. If your platform keys contacts by a
single id, you must decide the equivalent scoping rule *before* building the CRM
import (see §7.4).

### Roles

Three roles, referenced throughout:
- `admin` — full access
- `sales` (a.k.a. BDA) — only sees chats/contacts assigned to them
- `viewer` — read-only

### Core contact fields assumed to exist

```
id, business_number, customer_phone, name, profile_name,
tags            (JSON array of tag objects)
custom_fields   (JSON object)
assigned_user_id, created_at, updated_at
```

Features below add more columns; each is called out in its section.

---

## 1. Feature: AI Conversation Summaries

**Goal.** Every lead's conversation gets a short written summary so a rep can
triage without reading the whole thread.

### 1.1 Data model
Add to contacts:
```
ai_summary       TEXT
ai_summary_at    TIMESTAMP
```

### 1.2 Two entry points, one summariser
Build **one** summarisation function used by both paths — this matters, because
two summarisers drift apart:

1. **Automatic sweeper** (background job, e.g. every 60s): finds conversations
   that have gone quiet and summarises them.
2. **Manual button** ("AI Summary" / "Re-summarise") in the lead list and lead
   detail panel.

### 1.3 Sweeper eligibility rules (each of these was a real bug — implement all)
- Idleness is measured from the **last message in the thread**, NOT from the last
  time the AI ran. A rep who carries a chat for an hour after the AI stopped must
  not get summarised mid-conversation.
- A **human takeover must NOT suppress the summary.** The most valuable summary is
  the conversation the AI opened and a human finished. Do not gate on an
  "agent paused" flag.
- **Re-arm on new activity**: if a message arrives after the summary was written,
  the conversation becomes eligible again so the summary refreshes.
- **Only AI-touched conversations** enter the automatic sweep, or you burn an LLM
  call on every purely-human chat on the account.
- Claim rows atomically (`SELECT … FOR UPDATE SKIP LOCKED` or equivalent) so two
  workers can't summarise the same thread.

### 1.4 Manual button rules
- The manual path must **not** run the agent's side-effect tools (writing to
  Sheets, retagging). Clicking "summarise" must summarise, nothing else.
- An **opt-in flag gates the automatic sweep only**, never the button — someone
  pressing the button has opted in by pressing it.
- The manual prompt must not claim the conversation has ended (it can be pressed
  mid-chat).
- **De-duplicate in-flight requests** per conversation: two reps opening the same
  lead must not both pay for an LLM call. Key on the conversation, release in a
  `finally`.

### 1.5 Prompt/model requirements
- Read further back than a normal reply does (reference impl: 100 messages vs a
  20-message reply window). An AI opening plus a human tail exceeds a normal
  context window and truncating loses why the customer got in touch.
- Do **not** filter history by sender — outbound human replies must be included.
- Tell the model explicitly that some "assistant" turns were written by a **human
  colleague who took over**, or it narrates a colleague's messages as its own.
- The summary is **never sent to the customer.** The summarisation run must not be
  able to enqueue an outbound message.
- Cap the stored summary length (reference: 4,000 chars).

### 1.6 Failure behaviour
A failed summary write must not fail the run. Return actionable errors to the UI
("no AI agent configured for this number", "no API key"), never a generic 500 —
every one of these is fixable by the user.

---

## 2. Feature: AI Buying-Intent Score (Hot / Warm / Cold)

**Goal.** Every lead gets a 0–100 score for how likely they are to buy.

### 2.1 Data model
```
ai_intent_score  SMALLINT   -- 0..100
ai_intent_label  TEXT       -- 'Hot' | 'Warm' | 'Cold'
```
Index the score (it drives filtering).

### 2.2 Banding (use these exact thresholds everywhere)
```
score >= 70  ->  Hot
score >= 40  ->  Warm
score <  40  ->  Cold
```

### 2.3 How the score is produced — two-tier, no gaps
1. **Primary (free):** ask for it in the *same* LLM call that writes the summary.
   Append a directive telling the model to end its reply with a line like
   `INTENT_SCORE: 85`. Parse it out and strip it from the stored summary.
   - Match the **last** occurrence (the model may mention the phrase earlier).
   - Clamp to 0–100.
   - Guard: if stripping the line leaves an empty summary, fall back to the raw
     text minus the token rather than storing nothing.
2. **Deterministic fallback:** if the model omitted or malformed the line, run a
   tiny dedicated scoring call **on the summary text**. This guarantees every
   summary gets a score.

Derive the label from the score in one shared function so the label can never
disagree with the number.

### 2.4 Critical: two different scores exist — never conflate them
| Score | Source | Bands |
|---|---|---|
| **AI intent** (`ai_intent_score`) | LLM read of the conversation | 70 / 40 |
| **Rule-based lead score** (`custom_fields.lead_score`) | automation "Update Lead Score" action | 50 / 25 |

The UI shows **AI intent first, rule-based as fallback**. Implement one shared
helper used by the score pill, the segment filters, the KPI tile, and the sort:

```
effectiveScore(contact) = ai_intent_score ?? rule_based_lead_score   // null if neither
band(contact):
  if ai_intent_score exists -> 70/40 bands
  else if rule score exists -> 50/25 bands
  else -> null (unscored; cannot be binned)
```
Treat `0` as a **valid Cold score**, not "missing". Only `null`/`undefined`/`''`
mean unscored. Unscored leads sort to the bottom regardless of sort direction.

---

## 3. Feature: Lead Studio triage view

**Goal.** Turn the contact list into a lead-triage surface.

### 3.1 KPI strip
Computed over the **full loaded set**, not the filtered view (filters must not
move the headline numbers): Total leads · New this week (created < 7 days) ·
Unassigned (admin only) · Avg score · Hot count.

### 3.2 Segment chips
`All · New · Unassigned (admin only) · Hot · Warm · Cold`, each showing a live
count. **The chip count and the filtered result must be produced by the same
predicate function**, or a chip will show a count that doesn't match what
selecting it shows.

`Unassigned` is admin-only because a sales user's list is already scoped to their
own contacts server-side.

### 3.3 Table columns
`Name · Phone · Score · Owner · Source · AI Summary · <one column per tag category> · Actions`

- **Score** renders the intent pill (with a flame icon on Hot) or falls back to
  the rule-based pill.
- **AI Summary** clamps to one line with the full text in a tooltip + the detail
  panel. Keep the re-summarise control **always mounted**, not hover-revealed —
  a hover-reveal unmounts mid-request the moment the pointer leaves the row,
  discarding the spinner and any error while the LLM call continues invisibly.
  Shrink it to an icon instead.
- Clicking a row opens the lead detail; controls inside cells must stop event
  propagation so pressing a button doesn't also open a panel over the result.

---

## 4. Feature: Lead Source attribution

**Goal.** Record where each lead came from, un-editably.

### 4.1 Data model
```
lead_source           TEXT   -- slug
lead_source_id        TEXT
lead_source_url       TEXT
lead_source_headline  TEXT
lead_source_at        TIMESTAMP
```

### 4.2 Slugs and how each is captured
| Slug | Meaning | Captured from |
|---|---|---|
| `ctwa_ad` | Click-to-WhatsApp ad | referral payload on the customer's first message |
| `meta_post` | Facebook / Instagram post | same referral payload |
| `wa_link` | wa.me tracked link | an automation Link trigger matching its tracking code |
| `qr` | QR scan | an automation QR trigger matching its prefilled text |
| `meta_referral` | unknown/new referral type | fallback — record it rather than dropping the lead |

### 4.3 Rules
- **Write-once.** Only set when currently null (`WHERE lead_source IS NULL`). The
  first touch wins; later messages never rewrite attribution.
- Attribution is **not** the same as a user-editable "Lead Source" tag category.
  Keep them separate — one is provable, the other is whatever someone typed.
- For link/QR attribution, ensure a contact row exists first (insert-if-absent)
  because a brand-new lead may have no profile yet.
- Never display a guessed source. A lead who messaged the number directly has no
  source; showing "Direct" would be a guess dressed up as a fact — show nothing.
- Render the badge as a link to the ad/post when a source URL exists.

---

## 5. Feature: Hot-lead auto-routing

**Goal.** A Hot lead is automatically assigned to the right rep, with no human step.

### 5.1 Trigger point
Run **immediately after the intent score is persisted**, in the same flow that
produced it. It must fire for **both** the automatic summariser and the manual
button (any time a Hot score is produced).

### 5.2 Algorithm
```
if routing disabled by config            -> skip ('disabled')
if score is null or score < 70           -> skip ('not_hot')
if contact row missing                   -> skip ('no_contact')
if contact already has an owner          -> skip ('already_assigned')   # never steal
pick assignee:
    among ACTIVE users with role in (sales, admin)
    order by: role_rank (sales=0, admin=1) ASC,   # any sales rep beats any admin
              current_assigned_contact_count ASC, # least-loaded
              user_id ASC                         # stable tiebreak
if no assignee                           -> skip ('no_agent')
UPDATE contact SET owner = assignee WHERE owner IS NULL   # race guard
if 0 rows updated                        -> skip ('race_lost')
emit realtime events; log
```

### 5.3 Non-negotiable safety properties
- **Never reassigns an owned lead.** Only `owner IS NULL` rows.
- **Race-safe.** The `WHERE owner IS NULL` on the UPDATE makes a concurrent
  assignment (from a manual assign or a handoff step) a no-op rather than a
  double-assign.
- **Sales strictly preferred over admins.** A busy sales rep still beats an idle
  admin; admins are reached only when no active sales rep exists.
- **Best-effort.** The whole routine is wrapped so it can never fail the summary
  that triggered it. Every branch returns a reason instead of throwing.
- **Config kill-switch** (env var), default ON.

### 5.4 Side effects on success
Emit the same realtime events your manual handoff emits (contact updated,
assignment changed, in-app handoff notification) so the inbox and lead list update
live. Include a human-readable reason: `"Hot lead (buying intent 85) auto-assigned"`.

---

## 6. Feature: LLM usage & cost tracking

**Goal.** Show what the AI features actually cost.

### 6.1 Data model
An **append-only** usage table:
```
provider, model, model_ref_id, input_tokens, output_tokens, source, created_at
```
`source` distinguishes call sites (`summary`, `automation_ai`, …).

### 6.2 Pricing
Keep an **editable USD-per-1M-token price table** in code, keyed by model, with
longest-prefix matching plus a per-provider fallback (so an unknown model variant
still prices). Expose helpers for unit price, computed cost, and a rate card.

**Report in USD. Do not convert currency.**

### 6.3 Reporting endpoint
Query usage from **all sources separately and merge in code** (agent runs table +
the usage table). Do not join them — a missing or empty table on one side must
never hide the other. Merge rows for the same model across sources.

### 6.4 UI
Per-provider panel: total USD spend, run count, input/output tokens, per-model
breakdown, and a rate card. Poll (~15s) and refresh on window focus.
Distinguish **"endpoint not found" (server running an old build)** from
**"endpoint works, no data yet"** — these look identical to a user and have
completely different fixes.

---

## 7. Feature: CRM Import / Export (Zoho first, built to extend)

**Goal.** Two-way lead sync with an external CRM. Ship one provider; make adding
the next one mechanical.

### 7.1 Credential architecture — two distinct layers
Do not collapse these:

| Layer | Scope | Contents |
|---|---|---|
| **App identity** | one per install | OAuth Client ID + Secret + region + redirect URI |
| **Connection** | one per workspace | refresh token, access token + expiry, API domain, health, field-mapping config |

CRM sync is **organisation-level**, so the connection is a **single row**, not
per-user. (Contrast: a Google Sheets integration is per-user.)

**Encrypt** client secret and both tokens at rest — AES-256-GCM, storing
`base64(iv ‖ authTag ‖ ciphertext)`, key derived by SHA-256 of a stable
install-wide secret. Never store plaintext. Note that rotating that key makes
existing ciphertext unreadable — surface that as a clear error, not a crash.

Also add an append-only **sync log**: direction, module, status
(`ok|partial|error`), total/succeeded/failed/skipped, error message, who ran it,
timestamp.

### 7.2 Multi–data-centre support (do not skip this)
Zoho (and several CRMs) run isolated data centres — US, EU, IN, AU, JP, CA, SA,
CN. A token minted in one is worthless in another. So:
- Region is a **first-class stored field**, chosen by the admin.
- Build all OAuth URLs (`/oauth/v2/auth`, `/token`, `/token/revoke`) from a
  region → accounts-domain map.
- The **API domain is returned by the token exchange** — persist and use *that*,
  never a guessed domain. The region map only supplies a pre-first-exchange default.
- An unknown/mistyped region should fall back to the default centre (a clear auth
  error the admin can fix), not crash the connect flow.

### 7.3 OAuth flow
- **State parameter = a short-lived signed token** (JWT, ~10 min TTL) carrying the
  initiating user id, a random nonce, and a `kind` discriminator. Reject on
  mismatch so a returning redirect can't be replayed against another user.
- Request `access_type=offline` **and** `prompt=consent` — without forced consent
  most providers return a refresh token only on the *first* authorisation, so
  reconnecting leaves you tokenless. Fail loudly if no refresh token comes back.
- The **callback route must be public** (unauthenticated) — the provider redirects
  the user's browser to it — and mounted *before* your auth middleware. Every
  other route is admin-gated.
- Redirect back to the settings page with a one-shot `?status=connected|error`
  banner; strip the query afterwards so refreshes don't re-fire it.
- **Token refresh helper:** return the cached access token if it expires more than
  ~60s from now; otherwise refresh, persist the new token + expiry, mark healthy.
  On failure mark the connection unhealthy with the message. Every API call goes
  through this helper — callers never touch refresh tokens.
- **Disconnect** best-effort revokes at the provider, then deletes the row.

### 7.4 Field mapping — Contact ↔ CRM Lead

**Export (ours → CRM):**
```
name         -> Last_Name (+ First_Name if the name splits)
customer_phone -> Phone and Mobile   (normalised to digits, sent as +<digits>)
ai_summary + intent + source -> Description
```

Rules that prevent whole-record rejections:
- Zoho **requires `Last_Name`**. A blank name must fall back to something
  (e.g. `Lead +919876543210`) or the record is rejected.
- A single-token name becomes the last name; multi-token splits on the final space.
- **Do NOT write to picklist fields** (`Rating`, `Lead_Source`) in v1. Pushing a
  value the customer's picklist doesn't contain makes the CRM reject the entire
  record. Fold intent and source into the free-text `Description` instead, and
  leave picklist mapping as an opt-in stored config for later.

**Import (CRM → ours):**
```
Phone or Mobile -> customer_phone (strip all non-digits)
Full_Name, or First+Last, or Last_Name -> name
```
- A lead with **no phone is skipped** (counted as `skipped`, not `failed`) —
  there's nothing to key a WhatsApp contact on.
- **Import must target a specific business WhatsApp account**, because contacts
  are keyed by `(business_number, customer_phone)`. Make it a required parameter
  with a UI selector. *(This is the §0 fact biting — resolve it for your model.)*
- **Never overwrite an existing name** on re-import; only fill it if absent.

### 7.5 Sync mechanics
- **Export deduplicates via the CRM's upsert endpoint** with
  `duplicate_check_fields: ['Phone']` — an existing lead with that phone is
  updated, not duplicated. Batch **≤100 records** per call.
- **Import paginates** (≤200 per page), following the provider's `more_records`
  flag, with a caller-supplied cap.
- Retry **once on 401** (force a token refresh) and **back off on 429**. Treat
  `204 No Content` as an empty page, not an error.
- Count per-record outcomes; overall status is `ok` / `partial` / `error`.
  Write one sync-log row per run and surface the first few error messages.

### 7.6 Auto-tag imported leads with their source CRM
Every imported lead is stamped with a tag naming the CRM it came from.

- Idempotently create a tag **category** named `CRM` (stable id) and a **tag** per
  provider (stable id like `tag-crm-zoho`, name `Zoho`, brand colour).
- Merge the tag into the contact's existing tags — **never replace the array**,
  and don't duplicate on re-import (match on tag id or case-insensitive name).
- Because the lead list renders one column per tag category, this automatically
  appears as a **CRM** column showing a `Zoho` chip.
- Make the helper generic (`ensureCrmTag(name, colour)`) so the next provider gets
  its own chip for free.

### 7.7 Settings UI
Group CRMs under **one "CRM" card**, not one card per provider — otherwise the
integrations grid grows unboundedly. The card opens a provider list: the live
provider(s) plus visibly **disabled "Coming soon"** cards for the roadmap.

The provider detail page needs: credentials form (Client ID, masked Secret with
reveal, region selector, **read-only copyable redirect URI derived from the
current origin**), connect/disconnect with a health indicator, an **Export** panel
(scope by account, "Only Hot leads" toggle), an **Import** panel (target account
selector + max records), a result callout, and recent sync history.

### 7.8 Setup the admin must do (document this in your UI)
1. Create a **server-based OAuth app** in the CRM's developer console.
2. Register the redirect URI **exactly** as shown in the settings page.
3. Paste Client ID + Secret, pick the data centre, save, then Connect.

---

## 8. Smaller features in this range

**8.1 One-button WhatsApp onboarding.** Replace manual entry of App ID / secret /
config id / verify token with the provider's Embedded Signup: the business logs in
with Facebook, and their WhatsApp account + phone number are fetched automatically.
Move platform credentials to **environment config, one source of truth** — the app
secret was previously stored twice (encrypted in the DB for OAuth, and read from
env for webhook signature verification) with nothing keeping them in sync, so a
workspace could have working signup while its webhooks were accepted unverified.
Replace the credentials UI with a read-only status line.
*Gotcha:* the Facebook SDK login callback **must be a plain, non-`async` function.*

**8.2 24-hour window reminder.** WhatsApp only allows free-form messages within 24h
of the customer's last message. Add an opt-in per-conversation reminder that nudges
before that window closes, with the message configured once in settings.

---

## 9. Cross-cutting engineering rules

1. **Schema migrations** are numbered, idempotent (`IF NOT EXISTS` on every
   statement), applied at boot, and tracked in a migrations table. If your build
   mirrors migrations into two directories, **every migration must be written to
   both** and kept byte-identical.
2. **Route ordering:** register literal routes (`/x/usage`) *before* parameterised
   ones (`/x/:id`), or the param swallows them.
3. **Encryption key stability.** The key that encrypts tokens must survive
   redeploys, or all stored credentials become unreadable.
4. **Realtime.** Push server-sent events for message/contact/assignment changes so
   the inbox and lead list never need a manual reload. Any feature that changes
   assignment or contact data emits them.
5. **Best-effort side effects.** Analytics, usage logging, tagging, and routing are
   all wrapped so they can never fail the primary operation.
6. **Honest empty states.** Distinguish "not deployed" (404) from "no data yet" and
   from "misconfigured" — they look the same to users and have different fixes.

---

## 10. Acceptance checklist

Ship only when all of these hold:

- [ ] A conversation the AI opened and a human finished still gets summarised.
- [ ] Every stored summary has a non-null intent score (fallback scorer proven).
- [ ] Intent `0` renders as Cold, not as "unscored".
- [ ] Segment chip counts exactly match the rows shown when that chip is selected.
- [ ] Score pill, KPI tile, segment filter, and column sort all agree (one shared helper).
- [ ] A Hot score on an **owned** lead does **not** reassign it.
- [ ] Two simultaneous assignment attempts produce exactly one owner.
- [ ] Auto-routing prefers a busy sales rep over an idle admin.
- [ ] Routing failure does not prevent the summary/score from saving.
- [ ] Lead source is written once and never rewritten by later messages.
- [ ] CRM export of a contact with a blank name still succeeds.
- [ ] CRM export of the same contact twice updates, not duplicates.
- [ ] CRM import skips phone-less leads and never overwrites existing names.
- [ ] Re-importing does not duplicate the CRM source tag.
- [ ] Token refresh happens transparently; an expired token self-heals on next call.
- [ ] Disconnect revokes remotely and removes local credentials.
- [ ] Secrets are never returned by an API unless explicitly revealed to an admin.
