import { useState, useEffect, useRef } from 'react';
import {
  Inbox, Bot, Megaphone, Zap, FileText, Users, BarChart3,
  ArrowRight, Check, MessageCircle, ShieldCheck, Sparkles,
  Globe, Menu, X,
} from 'lucide-react';
import { FONT, MONO } from '../constants.js';

/*
 * Public marketing landing page shown to logged-out visitors at the site root.
 * Self-contained dark theme (independent of the app's light/dark token set) so
 * it always reads as a premium product page regardless of the app theme.
 */

// ── Palette (landing-local; intentionally not the app C tokens) ──────────
const L = {
  bg: '#08080A',
  bgAlt: '#0E0E12',
  surface: 'rgba(255,255,255,.035)',
  surfaceHi: 'rgba(255,255,255,.06)',
  border: 'rgba(255,255,255,.09)',
  borderHi: 'rgba(255,255,255,.16)',
  text: '#FFFFFF',
  textSec: '#A9A9B4',
  textMute: '#6E6E78',
  red: '#E22635',
  redHi: '#FF4D5A',
  purple: '#9D7CFF',
  green: '#22C55E',
};

const FEATURES = [
  { icon: Inbox, color: L.red, title: 'Unified Team Inbox',
    desc: 'Every WhatsApp conversation in one shared workspace. Assign chats, leave internal notes, and reply as a team without missing a message.' },
  { icon: Bot, color: L.purple, title: 'AI Agents',
    desc: 'Deploy AI agents that understand context, answer instantly, and hand off to a human exactly when it matters, 24/7, in your brand voice.' },
  { icon: Zap, color: '#F59E0B', title: 'No-Code Automations',
    desc: 'Build conversation flows visually. Trigger replies, route leads, tag contacts and follow up automatically, with no developer required.' },
  { icon: Megaphone, color: L.green, title: 'Broadcasts',
    desc: 'Reach thousands of contacts with personalized, template-based campaigns and watch delivery, reads and replies in real time.' },
  { icon: FileText, color: '#38BDF8', title: 'Template Builder',
    desc: 'Design, preview and manage approved WhatsApp message templates with media, buttons and variables, all in a few clicks.' },
  { icon: Users, color: '#EC4899', title: 'Contacts & Pipelines',
    desc: 'A WhatsApp-native CRM. Segment contacts with tags, move leads through pipelines, and keep every detail in sync.' },
];

const STATS = [
  { value: '10k+', label: 'Messages handled daily' },
  { value: '24/7', label: 'AI agent availability' },
  { value: '3×', label: 'Faster response times' },
  { value: '99.9%', label: 'Platform uptime' },
];

const STEPS = [
  { n: '01', title: 'Connect WhatsApp', desc: 'Link your WhatsApp Business number in minutes, with no code and no hassle.' },
  { n: '02', title: 'Build your flows', desc: 'Set up AI agents, automations and templates tailored to your business.' },
  { n: '03', title: 'Scale conversations', desc: 'Let your team and AI handle every chat while you track results in real time.' },
];

const PLAN_FEATURES = [
  'Unified team inbox', 'AI agents & automations', 'Unlimited broadcasts',
  'Template & pipeline builder', 'Real-time analytics', 'Multi-number support',
];

export default function LandingPage({ onLogin, onGetStarted }) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef(null);
  const cta = onGetStarted || onLogin;

  // The app shell pins html/body/#root to `overflow:hidden`, so the landing page
  // is its own scroll container (see root style below) and we track scroll on it.
  const onScroll = (e) => setScrolled(e.currentTarget.scrollTop > 12);

  const navLink = (label, href) => (
    <a href={href} onClick={() => setMenuOpen(false)} style={{
      color: L.textSec, textDecoration: 'none', fontSize: 14, fontWeight: 600,
      transition: 'color .15s', whiteSpace: 'nowrap',
    }}
      onMouseEnter={e => (e.currentTarget.style.color = L.text)}
      onMouseLeave={e => (e.currentTarget.style.color = L.textSec)}
    >{label}</a>
  );

  return (
    <div ref={scrollRef} onScroll={onScroll} style={{
      height: '100vh', overflowY: 'auto', overflowX: 'hidden',
      background: L.bg, color: L.text, fontFamily: FONT, width: '100%',
      scrollBehavior: 'smooth',
    }}>
      {/* ─────────────────────────── NAVBAR ─────────────────────────── */}
      <header style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        background: scrolled ? 'rgba(8,8,10,.82)' : 'transparent',
        backdropFilter: scrolled ? 'blur(14px)' : 'none',
        borderBottom: `1px solid ${scrolled ? L.border : 'transparent'}`,
        transition: 'background .3s, border-color .3s',
      }}>
        <nav style={{
          maxWidth: 1200, margin: '0 auto', padding: '0 24px', height: 68,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24,
        }}>
          <img src="/logo.png" alt="Zen Chat"
            style={{ height: 34, width: 'auto', objectFit: 'contain' }} />

          <div className="lp-nav-links" style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
            {navLink('Features', '#features')}
            {navLink('How it works', '#how')}
            {navLink('Pricing', '#pricing')}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={onLogin} className="lp-login-btn" style={{
              padding: '9px 18px', borderRadius: 10, cursor: 'pointer',
              background: 'transparent', color: L.text, fontFamily: FONT,
              border: `1px solid ${L.borderHi}`, fontSize: 14, fontWeight: 600,
              transition: 'background .15s, border-color .15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = L.surfaceHi; e.currentTarget.style.borderColor = L.text; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = L.borderHi; }}
            >Log in</button>
            <button onClick={cta} className="lp-cta-nav" style={{
              padding: '9px 18px', borderRadius: 10, cursor: 'pointer', border: 'none',
              background: `linear-gradient(135deg, ${L.red}, ${L.redHi})`, color: '#fff',
              fontFamily: FONT, fontSize: 14, fontWeight: 700,
              boxShadow: '0 4px 18px rgba(226,38,53,.4)', transition: 'transform .15s, box-shadow .15s',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 26px rgba(226,38,53,.55)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 4px 18px rgba(226,38,53,.4)'; }}
            >Get started <ArrowRight size={15} /></button>
            <button className="lp-burger" onClick={() => setMenuOpen(v => !v)} style={{
              display: 'none', background: 'transparent', border: `1px solid ${L.border}`,
              borderRadius: 9, width: 40, height: 40, color: L.text, cursor: 'pointer',
              alignItems: 'center', justifyContent: 'center',
            }}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
          </div>
        </nav>

        {/* Mobile menu */}
        {menuOpen && (
          <div className="lp-mobile-menu" style={{
            display: 'none', flexDirection: 'column', gap: 4, padding: '8px 24px 18px',
            background: 'rgba(8,8,10,.96)', borderBottom: `1px solid ${L.border}`,
          }}>
            {['Features', 'How it works', 'Pricing'].map((l, i) => (
              <a key={l} href={['#features', '#how', '#pricing'][i]} onClick={() => setMenuOpen(false)}
                style={{ color: L.textSec, textDecoration: 'none', fontSize: 15, fontWeight: 600, padding: '11px 0' }}>{l}</a>
            ))}
          </div>
        )}
      </header>

      {/* ─────────────────────────── HERO ─────────────────────────── */}
      <section style={{ position: 'relative', paddingTop: 150, paddingBottom: 80, textAlign: 'center' }}>
        {/* Ambient glows */}
        <div style={{
          position: 'absolute', top: -120, left: '50%', transform: 'translateX(-50%)',
          width: 760, height: 520, pointerEvents: 'none',
          background: 'radial-gradient(circle, rgba(226,38,53,.22) 0%, transparent 62%)',
          filter: 'blur(20px)',
        }} />
        <div style={{
          position: 'absolute', top: 80, right: '8%', width: 360, height: 360, pointerEvents: 'none',
          background: 'radial-gradient(circle, rgba(157,124,255,.16) 0%, transparent 65%)',
          filter: 'blur(30px)',
        }} />

        <div style={{ position: 'relative', maxWidth: 880, margin: '0 auto', padding: '0 24px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 26,
            padding: '7px 15px', borderRadius: 100, background: L.surface,
            border: `1px solid ${L.border}`, fontSize: 13, fontWeight: 600, color: L.textSec,
            animation: 'fadeInUp .6s ease-out both',
          }}>
            <Sparkles size={14} style={{ color: L.purple }} />
            AI-powered WhatsApp Business platform
          </div>

          <h1 style={{
            fontSize: 'clamp(38px, 6vw, 68px)', fontWeight: 800, lineHeight: 1.05,
            letterSpacing: '-0.035em', margin: '0 0 24px',
            animation: 'fadeInUp .6s ease-out .08s both',
          }}>
            Turn WhatsApp into your<br />
            <span style={{
              background: `linear-gradient(120deg, ${L.red}, ${L.redHi} 50%, ${L.purple})`,
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
            }}>growth engine</span>
          </h1>

          <p style={{
            fontSize: 'clamp(16px, 2vw, 19px)', color: L.textSec, lineHeight: 1.6,
            maxWidth: 620, margin: '0 auto 38px',
            animation: 'fadeInUp .6s ease-out .16s both',
          }}>
            Zen Chat unifies your team inbox, AI agents, automations and broadcasts,
            so you can answer every customer instantly and close more deals on the
            channel your customers already love.
          </p>

          <div style={{
            display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap',
            animation: 'fadeInUp .6s ease-out .24s both',
          }}>
            <button onClick={cta} style={{
              padding: '15px 30px', borderRadius: 12, cursor: 'pointer', border: 'none',
              background: `linear-gradient(135deg, ${L.red}, ${L.redHi})`, color: '#fff',
              fontFamily: FONT, fontSize: 16, fontWeight: 700,
              boxShadow: '0 8px 30px rgba(226,38,53,.45)', transition: 'transform .15s, box-shadow .15s',
              display: 'inline-flex', alignItems: 'center', gap: 9,
            }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 12px 40px rgba(226,38,53,.6)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 8px 30px rgba(226,38,53,.45)'; }}
            >Get started free <ArrowRight size={18} /></button>
            <button onClick={onLogin} style={{
              padding: '15px 30px', borderRadius: 12, cursor: 'pointer',
              background: L.surfaceHi, color: L.text, fontFamily: FONT,
              border: `1px solid ${L.borderHi}`, fontSize: 16, fontWeight: 600,
              transition: 'background .15s, border-color .15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,.1)'; e.currentTarget.style.borderColor = L.text; }}
              onMouseLeave={e => { e.currentTarget.style.background = L.surfaceHi; e.currentTarget.style.borderColor = L.borderHi; }}
            >Log in to workspace</button>
          </div>

          <div style={{
            display: 'flex', gap: 22, justifyContent: 'center', flexWrap: 'wrap', marginTop: 26,
            fontSize: 13, color: L.textMute, animation: 'fadeInUp .6s ease-out .32s both',
          }}>
            {['No credit card required', 'Set up in minutes', 'Cancel anytime'].map(t => (
              <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Check size={14} style={{ color: L.green }} /> {t}
              </span>
            ))}
          </div>
        </div>

        {/* Product mockup */}
        <div style={{
          position: 'relative', maxWidth: 960, margin: '64px auto 0', padding: '0 24px',
          animation: 'fadeInUp .7s ease-out .4s both',
        }}>
          <HeroMockup />
        </div>
      </section>

      {/* ─────────────────────────── STATS ─────────────────────────── */}
      <section style={{ padding: '20px 24px 70px' }}>
        <div style={{
          maxWidth: 1000, margin: '0 auto', display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 18,
        }}>
          {STATS.map(s => (
            <div key={s.label} style={{
              textAlign: 'center', padding: '24px 16px', borderRadius: 16,
              background: L.surface, border: `1px solid ${L.border}`,
            }}>
              <div style={{ fontSize: 34, fontWeight: 800, fontFamily: MONO, letterSpacing: '-.02em',
                background: `linear-gradient(135deg, ${L.text}, ${L.textSec})`,
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>{s.value}</div>
              <div style={{ fontSize: 13, color: L.textSec, marginTop: 6, fontWeight: 500 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ─────────────────────────── FEATURES ─────────────────────────── */}
      <section id="features" style={{ padding: '70px 24px', position: 'relative', background: L.bgAlt }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <SectionHead
            eyebrow="Everything you need"
            title="One platform for every conversation"
            sub="From the first hello to the closed deal, Zen Chat gives your team the tools to manage WhatsApp at scale."
          />
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20,
          }}>
            {FEATURES.map((f, i) => (
              <div key={f.title} className="lp-feature-card" style={{
                padding: 28, borderRadius: 18, background: L.surface,
                border: `1px solid ${L.border}`, transition: 'transform .2s, border-color .2s, background .2s',
              }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-5px)'; e.currentTarget.style.borderColor = L.borderHi; e.currentTarget.style.background = L.surfaceHi; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = L.border; e.currentTarget.style.background = L.surface; }}
              >
                <div style={{
                  width: 50, height: 50, borderRadius: 13, marginBottom: 18,
                  background: `${f.color}1f`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `1px solid ${f.color}33`,
                }}>
                  <f.icon size={24} style={{ color: f.color }} strokeWidth={2.2} />
                </div>
                <h3 style={{ fontSize: 19, fontWeight: 700, margin: '0 0 9px', letterSpacing: '-.01em' }}>{f.title}</h3>
                <p style={{ fontSize: 14.5, color: L.textSec, lineHeight: 1.62, margin: 0 }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────────────────── HOW IT WORKS ─────────────────────────── */}
      <section id="how" style={{ padding: '90px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <SectionHead
            eyebrow="How it works"
            title="Live in three simple steps"
            sub="No engineering team needed. Get your WhatsApp operation running today."
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
            {STEPS.map((s, i) => (
              <div key={s.n} style={{ position: 'relative', padding: '4px 4px' }}>
                <div style={{
                  fontSize: 52, fontWeight: 800, fontFamily: MONO, letterSpacing: '-.04em',
                  lineHeight: 1, marginBottom: 16,
                  background: `linear-gradient(135deg, ${L.red}, ${L.purple})`,
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
                  opacity: .92,
                }}>{s.n}</div>
                <h3 style={{ fontSize: 21, fontWeight: 700, margin: '0 0 10px' }}>{s.title}</h3>
                <p style={{ fontSize: 15, color: L.textSec, lineHeight: 1.6, margin: 0, maxWidth: 320 }}>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────────────────── PRICING / CTA CARD ─────────────────────────── */}
      <section id="pricing" style={{ padding: '40px 24px 100px' }}>
        <div style={{
          maxWidth: 1000, margin: '0 auto', borderRadius: 28, overflow: 'hidden',
          position: 'relative', border: `1px solid ${L.borderHi}`,
          background: `radial-gradient(900px 400px at 50% -10%, rgba(226,38,53,.22), transparent 60%), ${L.bgAlt}`,
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            alignItems: 'center', gap: 40, padding: '54px 48px',
          }}>
            <div>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 18,
                padding: '6px 13px', borderRadius: 100, background: L.surfaceHi,
                border: `1px solid ${L.border}`, fontSize: 12.5, fontWeight: 700,
                color: L.textSec, letterSpacing: '.04em', textTransform: 'uppercase',
              }}>
                <ShieldCheck size={14} style={{ color: L.green }} /> Trusted by growing teams
              </div>
              <h2 style={{ fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 800, margin: '0 0 16px', letterSpacing: '-.03em', lineHeight: 1.12 }}>
                Ready to grow on WhatsApp?
              </h2>
              <p style={{ fontSize: 16, color: L.textSec, lineHeight: 1.6, margin: '0 0 28px', maxWidth: 440 }}>
                Join teams using Zen Chat to handle thousands of conversations,
                automate the busywork and turn chats into customers.
              </p>
              <button onClick={cta} style={{
                padding: '15px 30px', borderRadius: 12, cursor: 'pointer', border: 'none',
                background: `linear-gradient(135deg, ${L.red}, ${L.redHi})`, color: '#fff',
                fontFamily: FONT, fontSize: 16, fontWeight: 700,
                boxShadow: '0 8px 30px rgba(226,38,53,.45)', transition: 'transform .15s, box-shadow .15s',
                display: 'inline-flex', alignItems: 'center', gap: 9,
              }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 12px 40px rgba(226,38,53,.6)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 8px 30px rgba(226,38,53,.45)'; }}
              >Get started now <ArrowRight size={18} /></button>
            </div>
            <div style={{
              padding: 28, borderRadius: 18, background: 'rgba(255,255,255,.04)',
              border: `1px solid ${L.border}`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: L.textSec, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 16 }}>
                Everything included
              </div>
              <div style={{ display: 'grid', gap: 13 }}>
                {PLAN_FEATURES.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 11, fontSize: 15, color: L.text }}>
                    <span style={{
                      width: 22, height: 22, borderRadius: 7, background: `${L.green}22`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      <Check size={14} style={{ color: L.green }} strokeWidth={3} />
                    </span>
                    {f}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────────────────── FOOTER ─────────────────────────── */}
      <footer style={{ borderTop: `1px solid ${L.border}`, background: L.bgAlt }}>
        <div style={{
          maxWidth: 1200, margin: '0 auto', padding: '40px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <img src="/logo.png" alt="Zen Chat" style={{ height: 28, width: 'auto', objectFit: 'contain' }} />
            <span style={{ fontSize: 13, color: L.textMute }}>WhatsApp CRM & Inbox · by ProITBridge</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
            <a href="/privacy-policy" style={{
              fontSize: 13.5, fontWeight: 600, color: L.textSec, textDecoration: 'none',
            }}
              onMouseEnter={e => (e.currentTarget.style.color = L.text)}
              onMouseLeave={e => (e.currentTarget.style.color = L.textSec)}
            >Privacy Policy</a>
            <a href="/terms-and-conditions" style={{
              fontSize: 13.5, fontWeight: 600, color: L.textSec, textDecoration: 'none',
            }}
              onMouseEnter={e => (e.currentTarget.style.color = L.text)}
              onMouseLeave={e => (e.currentTarget.style.color = L.textSec)}
            >Terms and Conditions</a>
            <a href="https://proitbridge.com/" target="_blank" rel="noopener noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, fontWeight: 600,
              color: L.textSec, textDecoration: 'none',
            }}
              onMouseEnter={e => (e.currentTarget.style.color = L.text)}
              onMouseLeave={e => (e.currentTarget.style.color = L.textSec)}
            ><Globe size={15} /> proitbridge.com</a>
            <button onClick={onLogin} style={{
              background: 'transparent', border: 'none', color: L.textSec, cursor: 'pointer',
              fontFamily: FONT, fontSize: 13.5, fontWeight: 600,
            }}
              onMouseEnter={e => (e.currentTarget.style.color = L.text)}
              onMouseLeave={e => (e.currentTarget.style.color = L.textSec)}
            >Log in</button>
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${L.border}`, padding: '18px 24px', textAlign: 'center', fontSize: 12.5, color: L.textMute }}>
          © {new Date().getFullYear()} Zen Chat · ProITBridge. All rights reserved.
        </div>
      </footer>

      {/* Responsive + landing-scoped styles */}
      <style>{`
        @media (max-width: 860px) {
          .lp-nav-links { display: none !important; }
          .lp-cta-nav   { display: none !important; }
          .lp-burger    { display: inline-flex !important; }
          .lp-mobile-menu { display: flex !important; }
        }
        @media (max-width: 480px) {
          .lp-login-btn { padding: 8px 14px !important; }
        }
      `}</style>
    </div>
  );
}

// ── Section header ───────────────────────────────────────────────────────
function SectionHead({ eyebrow, title, sub }) {
  return (
    <div style={{ textAlign: 'center', maxWidth: 640, margin: '0 auto 50px' }}>
      <div style={{
        fontSize: 13, fontWeight: 700, color: L.red, letterSpacing: '.1em',
        textTransform: 'uppercase', marginBottom: 14,
      }}>{eyebrow}</div>
      <h2 style={{ fontSize: 'clamp(28px, 4vw, 42px)', fontWeight: 800, margin: '0 0 16px', letterSpacing: '-.03em', lineHeight: 1.12 }}>{title}</h2>
      <p style={{ fontSize: 16.5, color: L.textSec, lineHeight: 1.6, margin: 0 }}>{sub}</p>
    </div>
  );
}

// ── Hero product mockup (stylized inbox preview) ─────────────────────────
function HeroMockup() {
  const chats = [
    { name: 'Aarav Sharma', msg: 'Perfect, I’ll take the premium plan 🎉', time: '2m', unread: 2, active: true },
    { name: 'Priya Patel', msg: 'Can you share the catalogue?', time: '9m', unread: 0 },
    { name: 'Acme Corp', msg: 'AI Agent: Your order has shipped ✓', time: '14m', unread: 0, ai: true },
    { name: 'Rohan Mehta', msg: 'Thanks for the quick reply!', time: '1h', unread: 0 },
  ];
  const bubbles = [
    { from: 'them', text: 'Hi! Do you have the new model in stock?' },
    { from: 'me', text: 'Yes we do! Want me to reserve one for you?' },
    { from: 'them', text: 'Perfect, I’ll take the premium plan 🎉' },
  ];
  return (
    <div style={{
      borderRadius: 18, overflow: 'hidden', border: `1px solid ${L.borderHi}`,
      background: '#0B0B0E', boxShadow: '0 40px 120px rgba(0,0,0,.6)',
    }}>
      {/* window chrome */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px',
        borderBottom: `1px solid ${L.border}`, background: 'rgba(255,255,255,.02)',
      }}>
        {['#FF5F57', '#FEBC2E', '#28C840'].map(c => (
          <span key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c }} />
        ))}
        <span style={{ marginLeft: 10, fontSize: 12.5, color: L.textMute, fontFamily: MONO }}>chat.axxeler.in</span>
      </div>
      <div className="lp-mock-grid" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 360 }}>
        {/* chat list */}
        <div style={{ borderRight: `1px solid ${L.border}`, background: 'rgba(255,255,255,.015)', padding: '12px 8px' }}>
          <div style={{ padding: '4px 10px 12px', fontSize: 13, fontWeight: 800, color: L.text, display: 'flex', alignItems: 'center', gap: 7 }}>
            <Inbox size={15} style={{ color: L.red }} /> Inbox
          </div>
          {chats.map((c, i) => (
            <div key={i} style={{
              display: 'flex', gap: 10, padding: '10px 10px', borderRadius: 10, marginBottom: 2,
              background: c.active ? L.surfaceHi : 'transparent', cursor: 'default',
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                background: c.ai ? `linear-gradient(135deg, ${L.purple}, #6D49E0)` : `linear-gradient(135deg, ${L.red}, ${L.redHi})`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff',
              }}>{c.ai ? <Bot size={17} /> : c.name[0]}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: L.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                  <span style={{ fontSize: 11, color: L.textMute, flexShrink: 0 }}>{c.time}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 2 }}>
                  <span style={{ fontSize: 12, color: L.textSec, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.msg}</span>
                  {c.unread > 0 && <span style={{ background: L.green, color: '#04210F', fontSize: 10.5, fontWeight: 800, borderRadius: 100, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>{c.unread}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
        {/* conversation */}
        <div style={{ display: 'flex', flexDirection: 'column', background: '#0A0E0C' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', borderBottom: `1px solid ${L.border}` }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: `linear-gradient(135deg, ${L.red}, ${L.redHi})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff' }}>A</div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>Aarav Sharma</div>
              <div style={{ fontSize: 11.5, color: L.green, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: L.green, display: 'inline-block' }} /> online
              </div>
            </div>
          </div>
          <div style={{ flex: 1, padding: '20px 18px', display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end' }}>
            {bubbles.map((b, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: b.from === 'me' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '74%', padding: '9px 13px', borderRadius: 14, fontSize: 13.5, lineHeight: 1.45,
                  background: b.from === 'me' ? `linear-gradient(135deg, ${L.red}, ${L.redHi})` : 'rgba(255,255,255,.06)',
                  color: '#fff',
                  borderBottomRightRadius: b.from === 'me' ? 4 : 14,
                  borderBottomLeftRadius: b.from === 'me' ? 14 : 4,
                }}>{b.text}</div>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, padding: '7px 11px', borderRadius: 100, background: `${L.purple}1a`, border: `1px solid ${L.purple}33`, alignSelf: 'flex-start', fontSize: 12, color: L.purple, fontWeight: 600 }}>
              <Sparkles size={13} /> AI agent suggested a reply
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: `1px solid ${L.border}` }}>
            <div style={{ flex: 1, padding: '10px 14px', borderRadius: 100, background: 'rgba(255,255,255,.05)', fontSize: 13, color: L.textMute }}>Type a message…</div>
            <div style={{ width: 38, height: 38, borderRadius: '50%', background: `linear-gradient(135deg, ${L.red}, ${L.redHi})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <MessageCircle size={17} style={{ color: '#fff' }} />
            </div>
          </div>
        </div>
      </div>
      <style>{`
        @media (max-width: 640px) {
          .lp-mock-grid { grid-template-columns: 1fr !important; }
          .lp-mock-grid > div:first-child { display: none !important; }
        }
      `}</style>
    </div>
  );
}
