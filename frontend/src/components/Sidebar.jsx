import {
  Home, Zap, LayoutTemplate, MessageCircle, Users,
  Megaphone, Image as ImageIcon, Info, KanbanSquare, Bot,
  ChevronLeft, ChevronRight, Lock, CreditCard,
} from 'lucide-react';
import { C, FONT } from '../constants.js';
import { canAccessPage } from '../lib/plans.js';

// Grouped so the nav reads as logical sections (labels show when expanded). Order
// within each group is preserved from the original flat list.
const NAV_GROUPS = [
  { title: 'Overview', items: [
    { id: 'home', label: 'Home', Icon: Home },
  ] },
  { title: 'Engage', items: [
    { id: 'chats',    label: 'Chats',    Icon: MessageCircle },
    { id: 'contacts', label: 'Contacts', Icon: Users },
    { id: 'pipelines', label: 'Pipelines', Icon: KanbanSquare },
  ] },
  { title: 'Build', items: [
    { id: 'chatbot-builder',  label: 'Automations',      Icon: Zap },
    { id: 'ai-agent-builder', label: 'AI Agents',        Icon: Bot },
    { id: 'template-builder', label: 'Template Builder', Icon: LayoutTemplate },
    { id: 'media-library',    label: 'Media',            Icon: ImageIcon },
    { id: 'bulk-message',     label: 'Bulk Message',     Icon: Megaphone },
  ] },
  { title: 'Account', items: [
    { id: 'billing', label: 'Plan',      Icon: CreditCard },
    { id: 'about',   label: 'About Us',  Icon: Info },
  ] },
];

export default function Sidebar({ activePage, onPageChange, collapsed, setCollapsed, user, entitlements }) {
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
      {/* Nav items — grouped with section labels */}
      <div style={{ padding: collapsed ? '10px 6px' : '12px 10px', flex: 1, overflowY: 'auto' }}>
        {NAV_GROUPS.map((group, gi) => {
          const items = (user?.role === 'admin' || !Array.isArray(user?.pages))
            ? group.items
            : group.items.filter(item => user.pages.includes(item.id));
          if (items.length === 0) return null;
          return (
            <div key={group.title} style={{ marginBottom: collapsed ? 4 : 10 }}>
              {!collapsed ? (
                <div style={{
                  fontSize: 10, fontWeight: 800, letterSpacing: '.11em', textTransform: 'uppercase',
                  color: C.textMuted, padding: '6px 12px 5px', opacity: 0.8,
                }}>{group.title}</div>
              ) : gi > 0 ? (
                <div style={{ height: 1, background: C.sidebarBorder, margin: '5px 12px' }} />
              ) : null}
              {items.map((item) => {
                const active = activePage === item.id;
                const locked = !canAccessPage(entitlements, item.id);
                return (
                  <div
                    key={item.id}
                    onClick={() => onPageChange(item.id)}
                    title={collapsed ? item.label : ''}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      gap: collapsed ? 0 : 11,
                      padding: collapsed ? '11px 0' : '10px 12px',
                      borderRadius: 11,
                      cursor: 'pointer',
                      marginBottom: 2,
                      background: active ? 'var(--c-primaryGradient, linear-gradient(135deg,#0FA8E0,#38CDF0))' : 'transparent',
                      color: active ? '#fff' : C.text,
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      fontFamily: FONT,
                      fontSize: 13,
                      fontWeight: active ? 700 : 500,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      userSelect: 'none',
                      transition: 'background .16s ease, color .16s ease, transform .16s ease, box-shadow .16s ease',
                      boxShadow: active ? 'inset 3px 0 0 var(--c-amber, #F6B100), 0 10px 26px rgba(15,168,224,.30)' : 'none',
                    }}
                    onMouseEnter={e => {
                      if (!active) {
                        e.currentTarget.style.background = 'var(--c-hover)';
                        e.currentTarget.style.transform = 'translateX(2px)';
                      }
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = active ? 'var(--c-primaryGradient, linear-gradient(135deg,#0FA8E0,#38CDF0))' : 'transparent';
                      e.currentTarget.style.transform = 'none';
                    }}
                  >
                    <span style={{
                      width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0, opacity: active ? 1 : 0.72, transition: 'opacity .15s ease',
                    }}>
                      <item.Icon size={16} strokeWidth={active ? 2.4 : 2} />
                    </span>
                    {!collapsed && (
                      <span style={{
                        flex: 1, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis',
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
          onMouseEnter={e => e.currentTarget.style.background = 'var(--c-hover)'}
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
