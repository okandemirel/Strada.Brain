/**
 * Shared CSS-variable theme hook for the vault graph + minimap.
 *
 * Centralises:
 *   - `readCssVar` (SSR/sandbox-safe lookup with fallback)
 *   - `useGraphColors` (full palette used by GraphCanvas)
 *   - `applyEdgeAlpha` (color-format-agnostic alpha injection)
 *
 * Lives next to the graph code rather than in `hooks/` because the entire
 * palette is graph-specific (folder/edge/glow colors that have no meaning
 * outside the canvas).
 */

import { useMemo } from 'react';

import { useTheme } from '../../../hooks/useTheme';

export function readCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

export interface GraphColors {
  bg: string;
  edge: string;
  edgeActive: string;
  edgeArrow: string;
  nodeBorder: string;
  nodeBorderHover: string;
  nodeSelectedRing: string;
  label: string;
  labelDetail: string;
  panelBg: string;
  panelBorder: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
}

export function useGraphColors(): GraphColors {
  const { theme } = useTheme();
  return useMemo(() => {
    const isDark = theme === 'dark';
    return {
      bg: readCssVar('--graph-bg', isDark ? '#0a0a0f' : '#fafafa'),
      edge: readCssVar('--graph-edge', isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'),
      edgeActive: readCssVar('--graph-edge-active', isDark ? '#00e5ff' : '#0891b2'),
      edgeArrow: readCssVar('--graph-edge', isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'),
      nodeBorder: readCssVar('--graph-node-border', isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'),
      nodeBorderHover: readCssVar('--graph-node-border-hover', isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'),
      nodeSelectedRing: readCssVar('--graph-node-selected-ring', isDark ? '#00e5ff' : '#0891b2'),
      label: readCssVar('--graph-label', isDark ? '#a0a0b0' : '#4a4a5a'),
      labelDetail: readCssVar('--graph-label-detail', isDark ? '#6a6a7a' : '#8a8a9a'),
      panelBg: readCssVar('--graph-panel-bg', isDark ? 'rgba(16,16,22,0.92)' : 'rgba(255,255,255,0.95)'),
      panelBorder: readCssVar('--graph-panel-border', isDark ? '#1f1f2f' : 'rgba(0,0,0,0.12)'),
      textPrimary: readCssVar('--color-text', isDark ? '#e8e8ed' : '#1a1a2e'),
      textSecondary: readCssVar('--color-text-secondary', isDark ? '#a0a0b0' : '#4a4a5a'),
      textTertiary: readCssVar('--color-text-tertiary', isDark ? '#6a6a7a' : '#8a8a9a'),
    };
  }, [theme]);
}

/**
 * Apply alpha to an arbitrary edge color string.
 *
 * Handles rgb/rgba/hsl/hsla by rewriting the color string. For other formats
 * (hex, named colors, "currentColor", etc.) we fall back to setting
 * `ctx.globalAlpha` and returning the original color — the caller MUST
 * restore globalAlpha afterwards. The function returns the color string to
 * use, and toggles `ctx.globalAlpha` only when necessary.
 *
 * Returns the new color string. Side effect: may mutate `ctx.globalAlpha`.
 */
export function applyEdgeAlpha(
  ctx: CanvasRenderingContext2D,
  baseColor: string,
  alpha: number,
): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const trimmed = baseColor.trim();
  // rgba(r,g,b,a) — replace last component
  if (trimmed.startsWith('rgba(')) {
    return trimmed.replace(/,\s*[^,)]+\)$/, `, ${clamped})`);
  }
  // rgb(r,g,b) — promote to rgba
  if (trimmed.startsWith('rgb(')) {
    const inner = trimmed.slice(4, -1).trim();
    return `rgba(${inner}, ${clamped})`;
  }
  // hsla(h,s%,l%,a) — replace last component
  if (trimmed.startsWith('hsla(')) {
    return trimmed.replace(/,\s*[^,)]+\)$/, `, ${clamped})`);
  }
  // hsl(h,s%,l%) — promote to hsla
  if (trimmed.startsWith('hsl(')) {
    const inner = trimmed.slice(4, -1).trim();
    return `hsla(${inner}, ${clamped})`;
  }
  // Hex / named / anything else: use globalAlpha as the alpha channel.
  ctx.globalAlpha = clamped;
  return trimmed;
}
