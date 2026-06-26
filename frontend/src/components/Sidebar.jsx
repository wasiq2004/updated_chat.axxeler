import {
  Home, Zap, LayoutTemplate, MessageCircle, Users,
  Megaphone, Image as ImageIcon, Info, KanbanSquare, Bot,
  ChevronLeft, ChevronRight, Lock, CreditCard,
} from 'lucide-react';
import { C, FONT } from '../constants.js';
import { canAccessPage } from '../lib/plans.js';

const NAV_ITEMS = [
  { id: 'home',              label: 'Home',             Icon: Home },
  { id: 'chatbot-builder',   label: 'Automations',      Icon: Zap },
  { id: 'ai-agent-builder',  label: 'AI Agents',        Icon: Bot },
  { id: 'template-builder',  label: 'Template Builder', Icon: LayoutTemplate },
  { id: 'media-library',     label: 'Media',            Icon: ImageIcon },
  { id: 'chats',             label: 'Chats',            Icon: MessageCircle },
  { id: 'contacts',          label: 'Contacts',         Icon: Users },
  { id: 'pipelines',         label: 'Pipelines',        Icon: KanbanSquare },
  { id: 'bulk-message',      label: 'Bulk Message',     Icon: Megaphone },
  { id: 'billing',           label: 'Plan',             Icon: CreditCard },
  { id: 'about',             label: 'About Us',         Icon: Info },
];

export default function Sidebar({ activePage, onPageChange, collapsed, setCollapsed, user, entitlements }) {
  const visibleItems = (user?.role === 'admin' || !Array.isArray(user?.pages))
    ? NAV_ITEMS
    : NAV_ITEMS.filter(item => user.pages.includes(item.id));

  return (
    <div style={{
      width: collapsed ? 68 : 224,
      minHeight: '100%',
      background: 'linear-gradient(180deg, rgba(0,0,0,.06), rgba(0,0,0,.02)), var(--c-sidebarBg)',
      backdropFilter: 'blur(22px)',
      WebkitBackdropFilter: 'blur(22px)',
      borderRight: `1px solid ${C.sidebarBorder}`,
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      transition: 'width 0.25s cubic-bezier(0.16,1,0.3,1), background 0.2s ease',
      overflow: 'hidden',
      position: 'relative',
      animation: 'fadeInLeft 0.35s cubic-bezier(0.16,1,0.3,1) both',
      boxShadow: '18px 0 48px rgba(0,0,0,.26)',
    }}>
      {/* Nav items */}
      <div style={{ padding: collapsed ? '10px 8px' : '14px 10px', flex: 1 }}>
        {visibleItems.map((item, i) => {
          const active = activePage === item.id;
          const locked = !canAccessPage(entitlements, item.id);
          return (
            <div
              key={item.id}
              onClick={() => onPageChange(item.id)}
              title={collapsed ? item.label : ''}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: collapsed ? 0 : 11,
                padding: collapsed ? '11px 0' : '10px 12px',
                borderRadius: 12,
                cursor: 'pointer',
                marginBottom: 2,
                background: active ? 'linear-gradient(135deg, rgba(15,168,224,.98), rgba(255,77,90,.92))' : 'transparent',
                color: active ? '#fff' : C.text,
                justifyContent: collapsed ? 'center' : 'flex-start',
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: active ? 700 : 500,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                userSelect: 'none',
                transition: 'background 0.15s ease, color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease',
                boxShadow: active ? '0 12px 28px rgba(15,168,224,.28)' : 'none',
                animation: `fadeInLeft 0.28s ease-out ${i * 30}ms both`,
              }}
              onMouseEnter={e => {
                if (!active) {
                  e.currentTarget.style.background = 'rgba(0,0,0,.065)';
                  e.currentTarget.style.transform = 'translateX(2px)';
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = active ? 'linear-gradient(135deg, rgba(15,168,224,.98), rgba(255,77,90,.92))' : 'transparent';
                e.currentTarget.style.transform = 'none';
              }}
            >
              <span style={{
                width: 20,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                opacity: active ? 1 : 0.7,
                transition: 'opacity 0.15s ease, transform 0.15s ease',
              }}>
                <item.Icon size={16} />
              </span>
              {!collapsed && (
                <span style={{
                  flex: 1,
                  letterSpacing: '-0.01em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  transition: 'opacity 0.2s ease',
                  opacity: locked && !active ? 0.6 : 1,
                }}>
                  {item.label}
                </span>
              )}
              {!collapsed && locked && (
                <Lock size={12} strokeWidth={2.5} style={{ flexShrink: 0, color: active ? '#fff' : C.textMuted, opacity: 0.85 }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Collapse button + watermark */}
      <div style={{ borderTop: `1px solid ${C.sidebarBorder}` }}>
        <div
          onClick={() => setCollapsed(p => !p)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: collapsed ? '12px 0' : '11px 14px',
            cursor: 'pointer',
            justifyContent: collapsed ? 'center' : 'flex-start',
            transition: 'background 0.15s ease',
            borderRadius: 0,
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,.06)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span style={{
            display: 'flex', alignItems: 'center', color: C.textSecondary, lineHeight: 1,
            transition: 'transform 0.25s cubic-bezier(0.34,1.56,0.64,1)',
            transform: collapsed ? 'rotate(0deg)' : 'rotate(0deg)',
          }}>
            {collapsed
              ? <ChevronRight size={22} strokeWidth={2.5} />
              : <ChevronLeft  size={22} strokeWidth={2.5} />}
          </span>
          {!collapsed && (
            <span style={{ fontSize: 13, fontWeight: 600, color: C.textSecondary, fontFamily: FONT, lineHeight: 1 }}>
              Collapse
            </span>
          )}
        </div>
        {!collapsed && (
          <div style={{ padding: '0 14px 10px' }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, fontFamily: FONT, letterSpacing: '.08em', textTransform: 'uppercase' }}>
              Powered by No one, Need Partnership!!
            </span>
          </div>
        )}
        {collapsed && (
          <div style={{ padding: '0 0 8px', textAlign: 'center' }}>
            <span style={{ fontSize: 7, fontWeight: 700, color: C.textMuted, fontFamily: FONT, letterSpacing: '.06em', textTransform: 'uppercase' }}>
              Powered by No one, Need Partnership!!
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
