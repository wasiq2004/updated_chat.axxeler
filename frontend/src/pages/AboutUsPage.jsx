import { Globe, ExternalLink } from 'lucide-react';
import { C, FONT } from '../constants.js';

// Brand icons removed from lucide-react v1 — inlined from their last known paths.
const LinkedinIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/>
    <rect x="2" y="9" width="4" height="12"/>
    <circle cx="4" cy="4" r="2"/>
  </svg>
);
const InstagramIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
  </svg>
);
const YoutubeIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58 2.78 2.78 0 0 0 1.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z"/>
    <polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" fill="currentColor" strokeLinejoin="round"/>
  </svg>
);
const FacebookIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
  </svg>
);

// Zen Chat links surfaced on the About Us page. Each opens in a new tab.
const LINKS = [
  { label: 'Website',   sub: 'proitbridge.com',                    url: 'https://proitbridge.com/',                                    Icon: Globe,     color: '#2563EB' },
  { label: 'LinkedIn',  sub: 'ProITBridge',                        url: 'https://www.linkedin.com/company/proitbridge/',               Icon: LinkedinIcon,  color: '#0A66C2' },
  { label: 'Instagram', sub: '@pro_it_bridge',                     url: 'https://www.instagram.com/pro_it_bridge/',                    Icon: InstagramIcon, color: '#E1306C' },
  { label: 'YouTube',   sub: '@aicoachjohn',                       url: 'https://www.youtube.com/@aicoachjohn',                        Icon: YoutubeIcon,   color: '#FF0000' },
  { label: 'Facebook',  sub: 'proitbridge',                        url: 'https://www.facebook.com/proitbridge',                        Icon: FacebookIcon,  color: '#1877F2' },
];

export default function AboutUsPage() {
  return (
    <div style={{ padding: '40px 24px', fontFamily: FONT, color: C.text, maxWidth: 760, margin: '0 auto', width: '100%' }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <img
          src="/logo.png"
          alt="Zen Chat"
          style={{ height: 64, width: 'auto', objectFit: 'contain', margin: '0 auto 14px', display: 'block' }}
        />
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: '-0.02em' }}>About <span style={{ color: C.primary }}>Zen Chat</span></h1>
        <p style={{ fontSize: 14, color: C.textSecondary, margin: '10px auto 0', maxWidth: 540, lineHeight: 1.6 }}>
          Zen Chat is a WhatsApp CRM & inbox — manage conversations, build automations, and deploy AI agents, all from one place.
          Explore our work through the links below.
        </p>
      </div>

      {/* Link cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 14,
      }}>
        {LINKS.map(({ label, sub, url, Icon, color }, i) => (
          <a
            key={label}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '16px 18px', borderRadius: 12,
              background: C.cardBg, border: `1px solid ${C.border}`,
              textDecoration: 'none', color: C.text,
              boxShadow: C.shadowSm,
              transition: 'transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease',
              animation: `fadeInUp 0.35s ease-out ${i * 60}ms both`,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.transform = 'translateY(-3px)';
              e.currentTarget.style.boxShadow = '0 8px 28px rgba(0,0,0,0.10)';
              e.currentTarget.style.borderColor = color;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = 'none';
              e.currentTarget.style.boxShadow = C.shadowSm;
              e.currentTarget.style.borderColor = C.border;
            }}
          >
            <span style={{
              width: 44, height: 44, borderRadius: 10, flexShrink: 0,
              background: `${color}18`,
              color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icon size={22} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{label}</span>
              <span style={{ display: 'block', fontSize: 12, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>
            </span>
            <ExternalLink size={16} style={{ color: C.textMuted, flexShrink: 0 }} />
          </a>
        ))}
      </div>

      <div style={{ textAlign: 'center', marginTop: 36, fontSize: 12, color: C.textMuted }}>
        © {new Date().getFullYear()} Zen Chat · WhatsApp CRM & Inbox
      </div>
    </div>
  );
}
