import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { FONT } from '../constants.js';

/* ── Design Tokens ──────────────────────────────────────────────────────────── */
const C = {
  pageBg: '#FAFAFA',
  dot: 'rgba(0,0,0,.10)',
  nodeBorder: 'rgba(0,0,0,.10)',
  nodeBorderExecuted: '#16A34A',
  nodeBorderError: '#DC2626',
  nodeBg: '#FFFFFF',
  text1: '#0A0A0A',
  text2: '#0A0A0A',
  text3: '#A1A1AA',
  text4: '#A1A1AA',
  text5: '#71717A',
  muted: '#71717A',
  edgeDefault: 'rgba(0,0,0,.22)',
  edgeExecuted: '#16A34A',
  edgeError: '#DC2626',
  green: '#16A34A',
  greenBg: 'rgba(34,197,94,.14)',
  red: '#DC2626',
  redBg: 'rgba(239,68,68,.14)',
  blue: '#2563EB',
  blueBg: 'rgba(96,165,250,.14)',
  orange: '#D97706',
  orangeBg: 'rgba(245,158,11,.14)',
  purple: '#7C3AED',
  purpleBg: 'rgba(157,124,255,.16)',
};

const NODE_W = 240;

const nodeH = (n) => {
  if (n.type === 'action') return Math.max(96, 44 + (n.actions?.length || 0) * 54);
  if (n.type === 'condition') return 118;
  if (n.type === 'message') return 102;
  return 96;
};

const NT = {
  trigger:  { bg:'rgba(239,68,68,.16)', border:'rgba(239,68,68,.34)', color:'#DC2626', accent:'#DC2626', label:'TRIGGER' },
  message:  { bg:'rgba(96,165,250,.16)', border:'rgba(96,165,250,.34)', color:'#2563EB', accent:'#2563EB', label:'MESSAGE' },
  condition:{ bg:'rgba(245,158,11,.16)', border:'rgba(245,158,11,.34)', color:'#D97706', accent:'#D97706', label:'CONDITION' },
  action:   { bg:'rgba(45,212,191,.16)', border:'rgba(45,212,191,.34)', color:'#2DD4BF', accent:'#2DD4BF', label:'ACTION' },
  delay:    { bg:'rgba(245,158,11,.16)', border:'rgba(245,158,11,.34)', color:'#D97706', accent:'#D97706', label:'DELAY' },
  api:      { bg:'rgba(165,180,252,.16)', border:'rgba(165,180,252,.34)', color:'#A5B4FC', accent:'#A5B4FC', label:'API' },
  handoff:  { bg:'rgba(244,114,182,.16)', border:'rgba(244,114,182,.34)', color:'#F472B6', accent:'#F472B6', label:'HANDOFF' },
  ai:       { bg:'rgba(157,124,255,.16)', border:'rgba(157,124,255,.34)', color:'#7C3AED', accent:'#7C3AED', label:'AI' },
  subflow:  { bg:'rgba(34,197,94,.16)', border:'rgba(34,197,94,.34)', color:'#16A34A', accent:'#16A34A', label:'SUB-FLOW' },
};

const TYPE_ICONS = {
  trigger: '⚡',
  message: '💬',
  condition: '◈',
  delay: '⏱',
  action: '⚙',
  handoff: '🤝',
  ai: '🧠',
  api: '🔗',
  subflow: '➡',
};

/* ── Edge path math ─────────────────────────────────────────────────────────── */
function edgePath(x1, y1, x2, y2) {
  const dy = Math.abs(y2 - y1);
  const c = Math.max(40, dy * 0.45);
  return `M ${x1} ${y1} C ${x1} ${y1 + c}, ${x2} ${y2 - c}, ${x2} ${y2}`;
}

function handlePos(n, kind, which = 'default') {
  const h = nodeH(n);
  if (kind === 'input') return { x: n.x + NODE_W / 2, y: n.y };
  if (n.type === 'condition' && which === 'yes') return { x: n.x + NODE_W / 3, y: n.y + h };
  if (n.type === 'condition' && which === 'no')  return { x: n.x + (NODE_W * 2) / 3, y: n.y + h };
  return { x: n.x + NODE_W / 2, y: n.y + h };
}

/* ── Node Card ──────────────────────────────────────────────────────────────── */
function ExecutionNode({ node, step, isSelected, onClick }) {
  const t = NT[node.type] || NT.trigger;
  const h = nodeH(node);
  const executed = !!step;
  const hasError = step?.status === 'error';

  const borderColor = hasError ? C.nodeBorderError : executed ? C.nodeBorderExecuted : C.nodeBorder;
  const bgOpacity = executed ? 1 : 0.55;
  const topStripColor = hasError ? C.red : executed ? C.green : 'rgba(0,0,0,.12)';

  return (
    <div
      onClick={() => onClick(node, step)}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: NODE_W,
        minHeight: h,
        background: C.nodeBg,
        borderRadius: 12,
        border: `2px solid ${borderColor}`,
        boxShadow: isSelected ? '0 4px 16px rgba(0,0,0,.12)' : '0 1px 4px rgba(0,0,0,.05)',
        cursor: 'pointer',
        opacity: bgOpacity,
        transition: 'all .15s',
        zIndex: isSelected ? 10 : 1,
        fontFamily: FONT,
      }}
      onMouseEnter={e => { if (!executed) e.currentTarget.style.opacity = '0.8'; }}
      onMouseLeave={e => { if (!executed) e.currentTarget.style.opacity = '0.55'; }}
    >
      {/* Top strip */}
      <div style={{ height: 3, background: topStripColor, borderRadius: '12px 12px 0 0' }} />

      {/* Status badge */}
      {executed && (
        <div style={{
          position: 'absolute', top: -10, right: 10,
          padding: '2px 8px', borderRadius: 99,
          background: hasError ? C.redBg : C.greenBg,
          color: hasError ? C.red : C.green,
          fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em',
          border: `1px solid ${hasError ? 'rgba(239,68,68,.34)' : 'rgba(34,197,94,.34)'}`,
        }}>
          {hasError ? 'Error' : 'Success'}
        </div>
      )}

      {/* Content */}
      <div style={{ padding: '10px 12px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: t.bg, border: `1px solid ${t.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, flexShrink: 0,
          }}>
            {TYPE_ICONS[node.type] || '●'}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
              {t.label}
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text1, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.title || node.name || `${node.type} node`}
            </div>
            {node.sub && (
              <div style={{ fontSize: 10, color: C.text5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {node.sub}
              </div>
            )}
          </div>
        </div>

        {/* Execution timing */}
        {step && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.dot}`, display: 'flex', gap: 10 }}>
            <div style={{ fontSize: 10, color: C.text5 }}>
              <span style={{ color: C.muted }}>Started:</span> {new Date(step.started_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
            </div>
            {step.completed_at && (
              <div style={{ fontSize: 10, color: C.text5 }}>
                <span style={{ color: C.muted }}>Duration:</span> {Math.round((new Date(step.completed_at) - new Date(step.started_at)))}ms
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main Canvas ────────────────────────────────────────────────────────────── */
export default function ExecutionFlowCanvas({ nodes, edges, steps, onNodeClick, selectedNodeId }) {
  const containerRef = useRef(null);
  const [transform, setTransform] = useState({ x: 40, y: 30, scale: 0.75 });
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  // Build step lookup by node_id
  const stepMap = useMemo(() => {
    const map = {};
    (steps || []).forEach(step => { map[step.node_id] = step; });
    return map;
  }, [steps]);

  // Executed node ids
  const executedNodeIds = useMemo(() => new Set((steps || []).map(s => s.node_id)), [steps]);

  // Pan / zoom handlers
  const onWheel = useCallback((e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      setTransform(t => {
        const newScale = Math.max(0.3, Math.min(2.0, t.scale * factor));
        const scaleRatio = newScale / t.scale;
        return {
          x: mx - (mx - t.x) * scaleRatio,
          y: my - (my - t.y) * scaleRatio,
          scale: newScale,
        };
      });
    } else {
      // Pan
      setTransform(t => ({ ...t, x: t.x - e.deltaX, y: t.y - e.deltaY }));
    }
  }, []);

  const onMouseDown = useCallback((e) => {
    if (e.target.closest('.execution-node')) return;
    setPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
  }, [transform]);

  const onMouseMove = useCallback((e) => {
    if (!panning) return;
    setTransform({
      ...transform,
      x: panStart.current.tx + (e.clientX - panStart.current.x),
      y: panStart.current.ty + (e.clientY - panStart.current.y),
    });
  }, [panning, transform]);

  const onMouseUp = useCallback(() => setPanning(false), []);

  useEffect(() => {
    if (!panning) return;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [panning, onMouseMove, onMouseUp]);

  const fitToScreen = useCallback(() => {
    if (!nodes.length || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const xs = nodes.map(n => n.x);
    const ys = nodes.map(n => n.y);
    const hs = nodes.map(n => nodeH(n));
    const minX = Math.min(...xs) - 40;
    const minY = Math.min(...ys) - 40;
    const maxX = Math.max(...xs.map((x, i) => x + NODE_W)) + 40;
    const maxY = Math.max(...ys.map((y, i) => y + hs[i])) + 40;
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const scale = Math.min(rect.width / contentW, rect.height / contentH, 1.0);
    setTransform({ x: 40 - minX * scale + (rect.width - contentW * scale) / 2, y: 30 - minY * scale + (rect.height - contentH * scale) / 2, scale: Math.max(0.3, scale * 0.9) });
  }, [nodes]);

  useEffect(() => { fitToScreen(); }, [fitToScreen]);

  // Edge rendering
  const edgeElements = useMemo(() => {
    return (edges || []).map((e, i) => {
      const fromNode = nodes.find(n => n.id === e.from);
      const toNode = nodes.find(n => n.id === e.to);
      if (!fromNode || !toNode) return null;

      const fromPos = handlePos(fromNode, 'output', e.fromHandle);
      const toPos = handlePos(toNode, 'input');
      const d = edgePath(fromPos.x, fromPos.y, toPos.x, toPos.y);

      const isExecuted = executedNodeIds.has(e.from) && executedNodeIds.has(e.to);
      const fromStep = stepMap[e.from];
      const fromHasError = fromStep?.status === 'error';
      const stroke = fromHasError ? C.edgeError : isExecuted ? C.edgeExecuted : C.edgeDefault;
      const strokeWidth = isExecuted ? 2.5 : 1.5;
      const opacity = isExecuted ? 1 : 0.35;

      return (
        <g key={`${e.from}-${e.to}-${i}`} style={{ opacity }}>
          <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
          <circle cx={toPos.x} cy={toPos.y} r={3} fill={stroke} />
        </g>
      );
    }).filter(Boolean);
  }, [edges, nodes, executedNodeIds, stepMap]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', position: 'relative' }}>
      {/* Toolbar */}
      <div style={{
        position: 'absolute', top: 12, right: 12, zIndex: 20,
        display: 'flex', gap: 6, background: 'rgba(17,17,17,0.95)',
        borderRadius: 10, padding: '6px 8px', border: `1px solid ${C.nodeBorder}`,
        boxShadow: '0 2px 8px rgba(0,0,0,.4)',
      }}>
        <button onClick={fitToScreen} title="Fit to screen" style={iconBtnStyle}>
          <Maximize size={15} />
        </button>
        <button onClick={() => setTransform(t => ({ ...t, scale: Math.min(2, t.scale * 1.15) }))} title="Zoom in" style={iconBtnStyle}>
          <ZoomIn size={15} />
        </button>
        <button onClick={() => setTransform(t => ({ ...t, scale: Math.max(0.3, t.scale / 1.15) }))} title="Zoom out" style={iconBtnStyle}>
          <ZoomOut size={15} />
        </button>
      </div>

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 12, left: 12, zIndex: 20,
        display: 'flex', gap: 12, background: 'rgba(17,17,17,0.95)',
        borderRadius: 10, padding: '8px 12px', border: `1px solid ${C.nodeBorder}`,
        boxShadow: '0 2px 8px rgba(0,0,0,.4)', fontSize: 11, fontFamily: FONT, color: C.text4,
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, border: `2px solid ${C.nodeBorderExecuted}`, background: C.nodeBg }} />
          Executed
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, border: `2px solid ${C.nodeBorderError}`, background: C.nodeBg }} />
          Error
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, border: `2px solid ${C.nodeBorder}`, background: C.nodeBg, opacity: 0.5 }} />
          Not executed
        </span>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        style={{
          flex: 1, position: 'relative', overflow: 'hidden',
          background: C.pageBg, cursor: panning ? 'grabbing' : 'grab',
          touchAction: 'none', userSelect: 'none',
        }}
      >
        {/* Grid */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `radial-gradient(${C.dot} 1px, transparent 1px)`,
          backgroundSize: `${18 * transform.scale}px ${18 * transform.scale}px`,
          backgroundPosition: `${transform.x}px ${transform.y}px`,
          pointerEvents: 'none',
        }} />

        {/* World */}
        <div style={{
          position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: '0 0',
        }}>
          {/* Edges SVG */}
          <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
            {edgeElements}
          </svg>

          {/* Nodes */}
          {(nodes || []).map(node => (
            <ExecutionNode
              key={node.id}
              node={node}
              step={stepMap[node.id]}
              isSelected={selectedNodeId === node.id}
              onClick={onNodeClick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle = {
  width: 28, height: 28, borderRadius: 6,
  border: '1px solid rgba(0,0,0,.10)', background: C.nodeBg,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', color: C.text4,
};
