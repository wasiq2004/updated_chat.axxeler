import { useEffect } from 'react';
import { ArrowLeft, Globe } from 'lucide-react';
import { FONT } from '../constants.js';

/*
 * Public legal pages (Privacy Policy, Terms and Conditions) shown at the clean
 * paths /privacy-policy and /terms-and-conditions so they can be submitted to
 * Meta for the WhatsApp Business Platform review. Content is written to align
 * with Meta Platform Terms and the WhatsApp Business Messaging Policy. These
 * pages render regardless of auth state (a reviewer is never logged in).
 *
 * Style note: the visible copy intentionally avoids long dashes.
 */

const L = {
  bg: '#08080A',
  bgAlt: '#0E0E12',
  surface: 'rgba(255,255,255,.035)',
  border: 'rgba(255,255,255,.09)',
  borderHi: 'rgba(255,255,255,.16)',
  text: '#FFFFFF',
  textSec: '#B4B4BE',
  textMute: '#6E6E78',
  red: '#E22635',
  redHi: '#FF4D5A',
};

// ── Company / product constants (edit here to update both pages) ──────────
const COMPANY = 'ProITBridge';
const PRODUCT = 'Zen Chat';
const SITE = 'chat.axxeler.in';
const WEBSITE = 'https://proitbridge.com';
const EMAIL = 'rnd.proitbridge@gmail.com';
const UPDATED = 'June 24, 2026';

function LegalLayout({ title, intro, sections, otherLabel, otherHref }) {
  // The app shell pins html/body/#root to overflow:hidden, so this is its own
  // scroll container.
  useEffect(() => { window.scrollTo?.(0, 0); }, []);

  return (
    <div style={{
      height: '100vh', overflowY: 'auto', overflowX: 'hidden',
      background: L.bg, color: L.text, fontFamily: FONT, width: '100%',
    }}>
      {/* Top bar */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'rgba(8,8,10,.82)', backdropFilter: 'blur(14px)',
        borderBottom: `1px solid ${L.border}`,
      }}>
        <div style={{
          maxWidth: 880, margin: '0 auto', padding: '0 24px', height: 64,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}>
          <a href="/" style={{ display: 'inline-flex', alignItems: 'center' }}>
            <img src="/logo.png" alt={PRODUCT} style={{ height: 30, width: 'auto', objectFit: 'contain' }} />
          </a>
          <a href="/" style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, textDecoration: 'none',
            color: L.textSec, fontSize: 14, fontWeight: 600,
          }}
            onMouseEnter={e => (e.currentTarget.style.color = L.text)}
            onMouseLeave={e => (e.currentTarget.style.color = L.textSec)}
          ><ArrowLeft size={16} /> Back to home</a>
        </div>
      </header>

      {/* Document */}
      <main style={{ maxWidth: 820, margin: '0 auto', padding: '48px 24px 72px' }}>
        <h1 style={{ fontSize: 'clamp(28px, 5vw, 40px)', fontWeight: 800, letterSpacing: '-.02em', margin: '0 0 10px' }}>{title}</h1>
        <div style={{ fontSize: 13.5, color: L.textMute, marginBottom: 28 }}>Last updated: {UPDATED}</div>

        <p style={{ fontSize: 16, lineHeight: 1.7, color: L.textSec, margin: '0 0 8px' }}>{intro}</p>

        {sections.map((s, i) => (
          <section key={i} style={{ marginTop: 34 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-.01em', margin: '0 0 12px' }}>
              {i + 1}. {s.h}
            </h2>
            {(s.p || []).map((para, j) => (
              <p key={j} style={{ fontSize: 15.5, lineHeight: 1.7, color: L.textSec, margin: '0 0 12px' }}>{para}</p>
            ))}
            {s.list && (
              <ul style={{ margin: '0 0 12px', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 9 }}>
                {s.list.map((li, k) => (
                  <li key={k} style={{ fontSize: 15.5, lineHeight: 1.65, color: L.textSec }}>{li}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </main>

      {/* Footer */}
      <footer style={{ borderTop: `1px solid ${L.border}`, background: L.bgAlt }}>
        <div style={{
          maxWidth: 820, margin: '0 auto', padding: '26px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16,
        }}>
          <span style={{ fontSize: 12.5, color: L.textMute }}>
            © {new Date().getFullYear()} {PRODUCT} · {COMPANY}. All rights reserved.
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <a href={otherHref} style={{ fontSize: 13, fontWeight: 600, color: L.textSec, textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget.style.color = L.text)}
              onMouseLeave={e => (e.currentTarget.style.color = L.textSec)}
            >{otherLabel}</a>
            <a href={WEBSITE} target="_blank" rel="noopener noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600,
              color: L.textSec, textDecoration: 'none',
            }}
              onMouseEnter={e => (e.currentTarget.style.color = L.text)}
              onMouseLeave={e => (e.currentTarget.style.color = L.textSec)}
            ><Globe size={14} /> proitbridge.com</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─────────────────────────────── PRIVACY POLICY ───────────────────────────
const PRIVACY_SECTIONS = [
  {
    h: 'Information We Collect',
    p: ['We collect the following categories of information so that we can provide and improve the Service:'],
    list: [
      'Account information. When you or your administrator creates an account, we collect your name, email address, and a securely hashed password.',
      'WhatsApp business data. When you connect a WhatsApp Business account through the WhatsApp Business Platform provided by Meta, we process the phone numbers, contact names, message content, and media that you and your customers exchange so that you can view, reply to, and manage those conversations.',
      'Contact and CRM data. Information you add about your contacts, such as names, phone numbers, tags, notes, pipeline stages, and custom fields.',
      'Usage and log data. Technical information such as your IP address, browser type, device information, pages viewed, and timestamps, which we use for security, troubleshooting, and analytics.',
      'Integration data. If you connect third party services such as Google Sheets, we access only the data needed to perform the actions you configure.',
    ],
  },
  {
    h: 'How We Use Your Information',
    p: ['We use the information we collect to:'],
    list: [
      'Provide, operate, and maintain the Service, including the shared inbox, broadcasts, templates, automations, and AI agents.',
      'Send and receive WhatsApp messages on your behalf through Meta.',
      'Authenticate users and keep accounts secure.',
      'Respond to support requests and communicate with you about the Service.',
      'Monitor usage, prevent abuse, and improve features and reliability.',
      'Comply with our legal obligations.',
    ],
  },
  {
    h: 'WhatsApp and Meta Platforms',
    p: [
      'Zen Chat uses the WhatsApp Business Platform and other services provided by Meta Platforms, Inc. Our access to and use of information received through Meta APIs follows the Meta Platform Terms, the WhatsApp Business Messaging Policy, and all applicable Meta developer policies.',
      'Messages are delivered through Meta, and Meta processes them according to its own terms and privacy policy. We use information obtained from Meta only to provide and improve the features you have enabled, and we do not use it for any unauthorized purpose.',
    ],
  },
  {
    h: 'Artificial Intelligence Processing',
    p: [
      'If you enable AI agents or automated replies, the content of relevant messages may be processed by third party AI model providers, such as Anthropic and OpenAI, solely to generate responses and perform the tasks you configure. Where the option is available to us, we do not permit these providers to use your data to train their models. You control whether AI features are enabled.',
    ],
  },
  {
    h: 'How We Share Information',
    p: ['We do not sell your personal information. We share information only in the following cases:'],
    list: [
      'Service providers and sub processors. We use trusted vendors for hosting, infrastructure, AI processing, and integrations who process data on our behalf under appropriate confidentiality and security obligations.',
      'Meta and WhatsApp. To deliver and receive your WhatsApp messages.',
      'Legal and safety reasons. When required by law, regulation, or legal process, or to protect the rights, property, or safety of ProITBridge, our users, or others.',
      'Business transfers. In connection with a merger, acquisition, or sale of assets, subject to this Privacy Policy.',
    ],
  },
  {
    h: 'Data Retention',
    p: [
      'We retain information for as long as your account is active or as needed to provide the Service, comply with our legal obligations, resolve disputes, and enforce our agreements. When information is no longer required, we delete or anonymize it. You may request deletion of your data as described below.',
    ],
  },
  {
    h: 'Data Security',
    p: [
      'We use technical and organizational measures to protect your information, including encryption of sensitive credentials at rest, encrypted connections in transit, access controls, and audit logging. No method of transmission or storage is completely secure, so we cannot guarantee absolute security.',
    ],
  },
  {
    h: 'Your Rights and Choices',
    p: [
      'Depending on your location, you may have the right to access, correct, update, or delete your personal information, and to object to or restrict certain processing. To exercise these rights, contact us using the details below. We will respond within the time required by applicable law.',
    ],
  },
  {
    h: 'Data Deletion',
    p: [
      `You can request deletion of your account and associated data at any time by emailing us at ${EMAIL} with the subject "Data Deletion Request". We will verify your request and delete the relevant data, except where we are required to retain it by law. Administrators can also remove contacts and conversation data directly within the Service.`,
    ],
  },
  {
    h: 'International Data Transfers',
    p: [
      'Your information may be processed and stored in countries other than your own. Where we transfer personal information across borders, we take steps to ensure it receives an adequate level of protection in line with applicable law.',
    ],
  },
  {
    h: 'Children Privacy',
    p: [
      'The Service is intended for businesses and is not directed to children under the age of 16. We do not knowingly collect personal information from children. If you believe a child has provided us with personal information, please contact us so we can remove it.',
    ],
  },
  {
    h: 'Cookies',
    p: [
      'We use strictly necessary cookies and similar technologies to keep you signed in and to operate the Service securely. We do not use cookies for third party advertising.',
    ],
  },
  {
    h: 'Changes to This Policy',
    p: [
      'We may update this Privacy Policy from time to time. When we make material changes, we will update the date at the top of this page and, where appropriate, provide additional notice. Your continued use of the Service after the changes take effect means you accept the updated policy.',
    ],
  },
  {
    h: 'Contact Us',
    p: [
      `If you have questions or requests regarding this Privacy Policy or your data, contact us at ${EMAIL} or visit ${WEBSITE}.`,
    ],
  },
];

export function PrivacyPolicyPage() {
  return (
    <LegalLayout
      title="Privacy Policy"
      intro={`${COMPANY} ("we", "us", or "our") operates ${PRODUCT}, a WhatsApp business communication and customer relationship management platform available at ${SITE} (the "Service"). This Privacy Policy explains what information we collect, how we use it, how we share it, and the choices you have. By using the Service you agree to the practices described in this policy.`}
      sections={PRIVACY_SECTIONS}
      otherLabel="Terms and Conditions"
      otherHref="/terms-and-conditions"
    />
  );
}

// ───────────────────────────── TERMS AND CONDITIONS ───────────────────────
const TERMS_SECTIONS = [
  {
    h: 'Eligibility and Accounts',
    p: [
      'You must be at least 18 years old and able to form a binding contract to use the Service. You are responsible for the information in your account, for keeping your login credentials confidential, and for all activity that occurs under your account. Notify us promptly of any unauthorized use.',
    ],
  },
  {
    h: 'Description of the Service',
    p: [
      'Zen Chat provides a shared team inbox, message templates, broadcasts, automations, AI agents, contact management, and related tools that connect to the WhatsApp Business Platform provided by Meta. Features may change, improve, or be discontinued over time.',
    ],
  },
  {
    h: 'WhatsApp and Meta Compliance',
    p: [
      'Your use of WhatsApp features through the Service is subject to the WhatsApp Business Messaging Policy, the WhatsApp Business Terms of Service, and the Meta Platform Terms. You agree to comply with all applicable Meta and WhatsApp policies. We may suspend or limit features to comply with these policies or to protect the Service.',
    ],
  },
  {
    h: 'Acceptable Use',
    p: ['You agree not to use the Service to:'],
    list: [
      'Send spam, unsolicited messages, or messages to people who have not given the required opt in consent.',
      'Send unlawful, fraudulent, misleading, harassing, hateful, or infringing content.',
      'Violate the privacy or rights of any person, or collect data without a lawful basis.',
      'Distribute malware or attempt to gain unauthorized access to the Service or its systems.',
      'Reverse engineer, resell, or misuse the Service in a way that violates these Terms or applicable law.',
    ],
  },
  {
    h: 'Your Content and Customer Data',
    p: [
      'You retain ownership of the content and data you submit to the Service. You are responsible for obtaining all necessary consents from your contacts before messaging them and for handling their personal information in accordance with applicable law and our Privacy Policy. You grant us a limited license to process your content solely to provide the Service.',
    ],
  },
  {
    h: 'Third Party Services',
    p: [
      'The Service integrates with third party services such as Meta, Google, and AI model providers. Your use of those services is subject to their own terms and policies. We are not responsible for third party services and do not control their availability or behavior.',
    ],
  },
  {
    h: 'Intellectual Property',
    p: [
      'The Service, including its software, design, and content, is owned by ProITBridge and protected by intellectual property laws. We grant you a limited, non exclusive, non transferable right to use the Service in accordance with these Terms. You may not copy, modify, or create derivative works except as permitted by law.',
    ],
  },
  {
    h: 'Fees',
    p: [
      'If your plan includes fees, you agree to pay them as described at the time of purchase. Unless stated otherwise, fees are non refundable. We may change pricing with reasonable prior notice.',
    ],
  },
  {
    h: 'Service Availability',
    p: [
      'We aim to keep the Service available and reliable, but we do not guarantee uninterrupted or error free operation. We may perform maintenance, updates, or changes that temporarily affect availability.',
    ],
  },
  {
    h: 'Disclaimers',
    p: [
      'The Service is provided on an "as is" and "as available" basis without warranties of any kind, whether express or implied, including warranties of merchantability, fitness for a particular purpose, and non infringement, to the maximum extent permitted by law.',
    ],
  },
  {
    h: 'Limitation of Liability',
    p: [
      'To the maximum extent permitted by law, ProITBridge will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of profits, data, or goodwill, arising from your use of or inability to use the Service. Our total liability for any claim relating to the Service will not exceed the amount you paid to us for the Service in the twelve months before the claim.',
    ],
  },
  {
    h: 'Indemnification',
    p: [
      'You agree to indemnify and hold ProITBridge harmless from any claims, damages, losses, and expenses arising from your use of the Service, your content, or your violation of these Terms or applicable law.',
    ],
  },
  {
    h: 'Termination',
    p: [
      'You may stop using the Service at any time. We may suspend or terminate your access if you violate these Terms, if required by Meta or WhatsApp policies, or if necessary to protect the Service or other users. Upon termination, your right to use the Service ends, and we may delete your data in accordance with our Privacy Policy.',
    ],
  },
  {
    h: 'Governing Law',
    p: [
      'These Terms are governed by the laws of India, without regard to its conflict of law rules. Any disputes will be subject to the exclusive jurisdiction of the competent courts located in India, unless otherwise required by applicable law.',
    ],
  },
  {
    h: 'Changes to These Terms',
    p: [
      'We may update these Terms from time to time. When we make material changes, we will update the date at the top of this page. Your continued use of the Service after the changes take effect means you accept the updated Terms.',
    ],
  },
  {
    h: 'Contact Us',
    p: [
      `If you have questions about these Terms, contact us at ${EMAIL} or visit ${WEBSITE}.`,
    ],
  },
];

export function TermsPage() {
  return (
    <LegalLayout
      title="Terms and Conditions"
      intro={`These Terms and Conditions ("Terms") govern your access to and use of ${PRODUCT}, a WhatsApp business communication and customer relationship management platform operated by ${COMPANY} ("we", "us", or "our") and available at ${SITE} (the "Service"). By accessing or using the Service, you agree to be bound by these Terms. If you do not agree, please do not use the Service.`}
      sections={TERMS_SECTIONS}
      otherLabel="Privacy Policy"
      otherHref="/privacy-policy"
    />
  );
}
