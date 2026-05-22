import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../hooks/useTheme';
import { getKindStyle } from './node-style';
import { readCssVar } from './useGraphTheme';
import type { GraphLink, GraphNode } from './graph-types';

export interface MinimapViewport {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface MinimapWorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface GraphMinimapProps {
  nodes: GraphNode[];
  links: GraphLink[];
  viewport: MinimapViewport;
  worldBounds: MinimapWorldBounds;
  onNavigate: (worldX: number, worldY: number) => void;
  selectedNodeId?: string | null;
  className?: string;
  width?: number;
  height?: number;
}

const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT = 150;
const SAMPLING_THRESHOLD = 5000;
const VIEWPORT_PADDING_RATIO = 0.05;

interface MinimapColors {
  bg: string;
  border: string;
  edge: string;
  viewportFill: string;
  viewportStroke: string;
  selectedRing: string;
  hintText: string;
}

function useMinimapColors(): MinimapColors {
  const { theme } = useTheme();
  return useMemo(() => {
    const isDark = theme === 'dark';
    return {
      bg: readCssVar('--vault-minimap-bg', isDark ? 'rgba(16,16,22,0.92)' : 'rgba(255,255,255,0.95)'),
      border: readCssVar('--vault-minimap-border', isDark ? '#1f1f2f' : 'rgba(0,0,0,0.12)'),
      edge: readCssVar('--vault-minimap-edge', isDark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.30)'),
      viewportFill: readCssVar(
        '--vault-minimap-viewport-fill',
        isDark ? 'rgba(0,229,255,0.12)' : 'rgba(8,145,178,0.12)',
      ),
      viewportStroke: readCssVar(
        '--vault-minimap-viewport-stroke',
        isDark ? 'rgba(0,229,255,0.85)' : 'rgba(8,145,178,0.85)',
      ),
      selectedRing: readCssVar('--vault-minimap-selected-ring', isDark ? '#00e5ff' : '#0891b2'),
      hintText: readCssVar('--vault-minimap-hint', isDark ? '#6a6a7a' : '#8a8a9a'),
    };
  }, [theme]);
}

interface ProjectionParams {
  scale: number;
  offsetX: number;
  offsetY: number;
  worldMinX: number;
  worldMinY: number;
}

function computeProjection(
  bounds: MinimapWorldBounds,
  width: number,
  height: number,
): ProjectionParams {
  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);
  const padX = worldW * VIEWPORT_PADDING_RATIO;
  const padY = worldH * VIEWPORT_PADDING_RATIO;
  const totalW = worldW + padX * 2;
  const totalH = worldH + padY * 2;
  const scale = Math.min(width / totalW, height / totalH);
  const offsetX = (width - totalW * scale) / 2 - (bounds.minX - padX) * scale;
  const offsetY = (height - totalH * scale) / 2 - (bounds.minY - padY) * scale;
  return {
    scale,
    offsetX,
    offsetY,
    worldMinX: bounds.minX - padX,
    worldMinY: bounds.minY - padY,
  };
}

function worldToMinimap(x: number, y: number, p: ProjectionParams): { x: number; y: number } {
  return { x: x * p.scale + p.offsetX, y: y * p.scale + p.offsetY };
}

function minimapToWorld(
  mx: number,
  my: number,
  p: ProjectionParams,
): { worldX: number; worldY: number } {
  return {
    worldX: (mx - p.offsetX) / p.scale,
    worldY: (my - p.offsetY) / p.scale,
  };
}

export default function GraphMinimap({
  nodes,
  links,
  viewport,
  worldBounds,
  onNavigate,
  selectedNodeId = null,
  className,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: GraphMinimapProps) {
  const { t } = useTranslation('vault');
  const colors = useMinimapColors();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const projection = useMemo(
    () => computeProjection(worldBounds, width, height),
    [worldBounds, width, height],
  );

  const samplingStride = useMemo(() => {
    if (nodes.length <= SAMPLING_THRESHOLD) return 1;
    return Math.ceil(nodes.length / SAMPLING_THRESHOLD);
  }, [nodes.length]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const cssW = width;
    const cssH = height;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    // Edges (0.5px @ 30% opacity). Only when node count is reasonable to keep paint cheap.
    if (nodes.length <= SAMPLING_THRESHOLD * 2) {
      ctx.strokeStyle = colors.edge;
      ctx.lineWidth = 0.5;
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      for (const link of links) {
        const s = typeof link.source === 'object' ? link.source : null;
        const tgt = typeof link.target === 'object' ? link.target : null;
        if (!s || !tgt || s.x == null || s.y == null || tgt.x == null || tgt.y == null) continue;
        const a = worldToMinimap(s.x, s.y, projection);
        const b = worldToMinimap(tgt.x, tgt.y, projection);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Nodes — 1-2px dots, colored by kind
    let selectedPos: { x: number; y: number; color: string } | null = null;
    for (let i = 0; i < nodes.length; i += samplingStride) {
      const node = nodes[i]!;
      if (node.x == null || node.y == null) continue;
      const isSelected = node.id === selectedNodeId;
      const color = node.color || getKindStyle(node.kind).color;
      const pos = worldToMinimap(node.x, node.y, projection);
      const r = isSelected ? 2 : Math.max(1, Math.min(2, Math.sqrt(node.val) * 0.6));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (isSelected) selectedPos = { x: pos.x, y: pos.y, color };
    }

    // Selected node — guarantee draw even if it fell outside sampling stride
    if (!selectedPos && selectedNodeId) {
      const sel = nodes.find((n) => n.id === selectedNodeId);
      if (sel && sel.x != null && sel.y != null) {
        const color = sel.color || getKindStyle(sel.kind).color;
        const pos = worldToMinimap(sel.x, sel.y, projection);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 2, 0, Math.PI * 2);
        ctx.fill();
        selectedPos = { x: pos.x, y: pos.y, color };
      }
    }

    // Selection ring
    if (selectedPos) {
      ctx.strokeStyle = colors.selectedRing;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(selectedPos.x, selectedPos.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Viewport rectangle
    if (viewport.zoom > 0) {
      const viewWorldW = viewport.width / viewport.zoom;
      const viewWorldH = viewport.height / viewport.zoom;
      const worldLeft = viewport.x - viewWorldW / 2;
      const worldTop = viewport.y - viewWorldH / 2;
      const topLeft = worldToMinimap(worldLeft, worldTop, projection);
      const rectW = viewWorldW * projection.scale;
      const rectH = viewWorldH * projection.scale;

      ctx.fillStyle = colors.viewportFill;
      ctx.fillRect(topLeft.x, topLeft.y, rectW, rectH);
      ctx.strokeStyle = colors.viewportStroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, rectW - 1, rectH - 1);
    }
  }, [colors, height, links, nodes, projection, samplingStride, selectedNodeId, viewport, width]);

  // Throttle redraws via requestAnimationFrame
  useEffect(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      draw();
      rafRef.current = null;
    });
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [draw]);

  const navigateToEvent = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const { worldX, worldY } = minimapToWorld(mx, my, projection);
      onNavigate(worldX, worldY);
    },
    [onNavigate, projection],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      setIsDragging(true);
      navigateToEvent(e.clientX, e.clientY);
    },
    [navigateToEvent],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDragging) return;
      navigateToEvent(e.clientX, e.clientY);
    },
    [isDragging, navigateToEvent],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if ((e.target as HTMLCanvasElement).hasPointerCapture(e.pointerId)) {
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      setIsDragging(false);
    },
    [],
  );

  const title = t('graph.minimap.title', 'Graph overview');
  const toggleHint = t('graph.minimap.toggleHint', 'Click or drag to navigate');
  const nodeCountLabel = t('graph.minimap.nodeCount', '({{count}} nodes)', { count: nodes.length });

  return (
    <div
      className={className}
      style={{
        width,
        height,
        borderRadius: 8,
        overflow: 'hidden',
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        position: 'relative',
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        backdropFilter: 'blur(8px)',
      }}
      role="region"
      aria-label={title}
      title={toggleHint}
    >
      <canvas
        ref={canvasRef}
        style={{
          width,
          height,
          display: 'block',
          cursor: isDragging ? 'grabbing' : 'crosshair',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        aria-label={title}
      />
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 6,
          fontSize: 9,
          lineHeight: 1.2,
          color: colors.hintText,
          pointerEvents: 'none',
          userSelect: 'none',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          letterSpacing: 0.2,
        }}
      >
        {nodeCountLabel}
      </div>
    </div>
  );
}
