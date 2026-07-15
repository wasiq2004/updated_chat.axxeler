// Premium "upgrade to unlock" screen, shown when a tenant opens a page whose
// feature isn't in their plan. Designed to feel aspirational, not punitive.

import { Lock, Sparkles, Check, ArrowRight, Megaphone, Zap, Bot, Crown, Palette } from 'lucide-react';
import { C, FONT } from '../constants.js';
import { FEATURE_META, PAGE_FEATURE, PLAN_META, minPlanForFeature, fmtMoney } from '../lib/plans.js';

const FEATURE_ICON = { campaigns: Megaphone, automations: Zap, ai_agents: Bot, white_label: Palette };

export default function UpgradeGate({ pageId, entitlements, onViewPlans }) {
  const featureKey = PAGE_FEATURE[pageId];
  const meta = FEATURE_META[featureKey] || { label: 'This feature', tagline: '', perks: [], accent: C.primary };
  const accent = meta.accent || C.primary;
  const Icon = FEATURE_ICON[featureKey] || Sparkles;

  const target = minPlanForFeature(entitlements?.catalog, featureKey);
  const targetMeta = target ? PLAN_META[target.key] : null;
  const currentPlanKey = entitlements?.plan?.key;
  const currentPlanLabel = currentPlanKey ? (PLAN_META[currentPlanKey]?.label || currentPlanKey) : null;
  const price = target ? Number(target.price_monthly) : null;

  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '40px 24px', fontFamily: FONT, color: C.text, position: 'relative', overflow: 'hidden',
    }}>
      {/* Ambient glow */}
      <div aria-hidden style={{
        position: 'absolute', top: '-20%', left: '50%', transform: 'translateX(-50%)',
        width: 720, height: 720, borderRadius: '50%', pointerEvents: 'none',
        background: `radial-gradient(circle, ${accent}22 0%, transparent 60%)`,
        filter: 'blur(8px)',
      }} />

      <div style={{
        position: 'relative', width: '100%', maxWidth: 760,
        background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 24,
        boxShadow: C.shadowLg, overflow: 'hidden',
        animation: 'fadeInUp 0.5s cubic-bezier(0.16,1,0.3,1) both',
      }}>
        {/* Accent top hairline */}
        <div style={{ height: 3, background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />

        <div style={{ padding: '40px 40px 36px', textAlign: 'center' }}>
          {/* Icon medallion */}
          <div style={{
            width: 76, height: 76, margin: '0 auto 22px', borderRadius: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
            background: `linear-gradient(145deg, ${accent}26, ${accent}0d)`,
            border: `1px solid ${accent}40`,
            boxShadow: `0 18px 44px ${accent}33`,
          }}>
            <Icon size={34} color={accent} strokeWidth={2} />
            <span style={{
              position: 'absolute', bottom: -8, right: -8, width: 30, height: 30, borderRadius: '50%',
              background: C.cardBg, border: `1px solid ${C.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Lock size={14} color={C.textSecondary} />
            </span>
          </div>

          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12,
            padding: '4px 12px', borderRadius: 20, background: `${accent}1a`, border: `1px solid ${accent}33`,
            fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: accent,
          }}>
            <Sparkles size={13} /> Premium feature
          </div>

          <h1 style={{ fontSize: 30, fontWeight: 800, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
            Unlock {meta.label}
          </h1>
          <p style={{ fontSize: 15.5, color: C.textSecondary, margin: '0 auto 28px', maxWidth: 460, lineHeight: 1.55 }}>
            {meta.tagline}
          </p>

          {/* Perks */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12,
            textAlign: 'left', marginBottom: 30, maxWidth: 560, margin: '0 auto 30px',
          }}>
            {(meta.perks || []).map((p, i) => (
              <div key={p} style={{
                display: 'flex', alignItems: 'center', gap: 11,
                padding: '12px 14px', borderRadius: 12,
                background: C.surfaceAlt, border: `1px solid ${C.border}`,
                animation: `fadeInUp 0.4s ease-out ${120 + i * 70}ms both`,
              }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 7, flexShrink: 0,
                  background: `${accent}1f`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Check size={14} color={accent} strokeWidth={3} />
                </span>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p}</span>
              </div>
            ))}
          </div>

          {/* Plan callout + CTA */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
            flexWrap: 'wrap', padding: '18px 20px', borderRadius: 16,
            background: `linear-gradient(135deg, ${accent}14, transparent)`,
            border: `1px solid ${accent}33`,
          }}>
            <div style={{ textAlign: 'left' }}>
              {targetMeta && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <Crown size={15} color={accent} />
                  <span style={{ fontSize: 14, fontWeight: 700 }}>
                    Available on {targetMeta.label}
                    {price != null && price > 0 && (
                      <span style={{ color: C.textSecondary, fontWeight: 600 }}> · {fmtMoney(price, target?.currency)}/mo</span>
                    )}
                  </span>
                </div>
              )}
              {currentPlanLabel && (
                <div style={{ fontSize: 12.5, color: C.textMuted }}>
                  You're currently on the <b style={{ color: C.textSecondary }}>{currentPlanLabel}</b> plan
                </div>
              )}
            </div>
            <button
              onClick={onViewPlans}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '11px 20px', borderRadius: 11, border: 'none', cursor: 'pointer',
                background: `linear-gradient(135deg, ${C.primary}, ${C.primaryHover})`,
                color: '#fff', fontFamily: FONT, fontSize: 14, fontWeight: 700,
                boxShadow: `0 12px 28px ${C.primary}44`, whiteSpace: 'nowrap',
                transition: 'transform 0.15s ease, box-shadow 0.15s ease',
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; }}
            >
              View plans <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
