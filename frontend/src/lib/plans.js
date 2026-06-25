// Plan / feature metadata for the feature-gating UX. Single source of truth for
// which pages require which plan feature, plus the human copy used by the
// upgrade screens and the billing page. Backend stays authoritative for
// enforcement (featureGate); this is purely presentation.

import { C } from '../constants.js';

// Page id (router) → the plan feature key it requires. Pages not listed are
// "core" and never gated (inbox, contacts, pipelines, templates, media, home).
export const PAGE_FEATURE = {
  'bulk-message': 'campaigns',
  'chatbot-builder': 'automations',
  'ai-agent-builder': 'ai_agents',
  'branding': 'white_label',
};

// Rich copy for each gated feature — drives the upgrade screen.
export const FEATURE_META = {
  campaigns: {
    label: 'Campaigns & Broadcasts',
    tagline: 'Reach thousands of customers in a single click.',
    accent: C.amber,
    perks: [
      'Broadcast to thousands at once',
      'Schedule sends for the perfect moment',
      'Personalized template messaging',
      'Live delivery & read analytics',
    ],
  },
  automations: {
    label: 'Automations',
    tagline: 'Put your WhatsApp on autopilot.',
    accent: C.purple,
    perks: [
      'Visual no-code workflow builder',
      'Trigger on new message, keyword or event',
      'Auto-reply, tag and route conversations',
      'Multi-step flows with conditions',
    ],
  },
  ai_agents: {
    label: 'AI Agents',
    tagline: 'Let AI handle conversations 24/7.',
    accent: C.green,
    perks: [
      'AI assistants that reply instantly',
      'Qualify leads automatically',
      'Answer FAQs from your knowledge base',
      'Book appointments hands-free',
    ],
  },
  white_label: {
    label: 'White Label',
    tagline: 'Make the platform unmistakably yours.',
    accent: C.primary,
    perks: [
      'Your brand name throughout the app',
      'Custom accent color & theme',
      'Your own logo',
      'A workspace your customers recognize',
    ],
  },
};

// Plan tiers (low → high). Used for ordering, badges and "upgrade to" copy.
export const PLAN_META = {
  starter:      { label: 'Starter',      tier: 0, accent: '#64748B' },
  growth:       { label: 'Growth',       tier: 1, accent: C.green },
  professional: { label: 'Professional', tier: 2, accent: C.purple },
  enterprise:   { label: 'Enterprise',   tier: 3, accent: C.primary },
};

// Friendly labels for the per-feature catalog rows in the comparison grid.
export const FEATURE_LABELS = {
  inbox: 'Shared Inbox',
  crm: 'CRM & Contacts',
  deals: 'Deals & Pipelines',
  campaigns: 'Campaigns',
  broadcast: 'Broadcasts',
  ai_agents: 'AI Agents',
  automations: 'Automations',
  analytics: 'Analytics',
  api_access: 'API Access',
  webhooks: 'Webhooks',
  white_label: 'White Label',
  marketplace: 'Marketplace',
};

// Does the loaded entitlements object grant a feature?
// Treat a not-yet-loaded entitlements (undefined/null) as ALLOWED so the UI never
// flashes a lock during load; only lock once entitlements are present and lack it.
export function hasFeature(entitlements, key) {
  if (!key) return true;
  if (!entitlements || !Array.isArray(entitlements.features)) return true;
  return entitlements.features.includes(key);
}

// Can this page be accessed under the current entitlements?
export function canAccessPage(entitlements, pageId) {
  return hasFeature(entitlements, PAGE_FEATURE[pageId]);
}

// The lowest-tier plan (from the catalog) that includes a feature — for
// "Upgrade to Growth to unlock" messaging.
export function minPlanForFeature(catalog, featureKey) {
  const plans = (catalog?.plans || [])
    .filter(p => Array.isArray(p.features) && p.features.includes(featureKey))
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  return plans[0] || null;
}

export function formatLimit(v) {
  return v == null ? 'Unlimited' : Number(v).toLocaleString();
}
