// Shared visual language for avatars, used by the graph renderer and the overlays.
import type { AvatarType } from './ego-graph';

export const TYPE_LABEL: Record<AvatarType, string> = {
  human: 'Human',
  organization: 'Organization',
  group: 'Group',
  unknown: 'Avatar',
};

export const TYPE_HEX: Record<AvatarType, string> = {
  human: '#1D9E75',
  organization: '#378ADD',
  group: '#EF9F27',
  unknown: '#b4b2a9',
};

/** The connected avatar (you) and the highlighted payment route get their own colors. */
export const CENTER_HEX = '#534AB7';
export const PATH_HEX = '#D85A30';
/** Avatars freshly pulled in by tapping "Expand" — they pop on the map as the network grows. */
export const NEW_HEX = '#DB2777';

/**
 * Distinct hues assigned to the groups picked in "color by group" mode — chosen to read clearly
 * against each other and to avoid clashing with the type/center/route/new colors above.
 */
export const GROUP_PALETTE = [
  '#E11D48', // rose
  '#2563EB', // blue
  '#16A34A', // green
  '#D97706', // amber
  '#9333EA', // violet
  '#0891B2', // cyan
];

/** Parse '#RRGGBB' into an [r, g, b] tuple (0–255). */
export function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * A stable, vivid color for an arbitrary address — used to color realized-flow legs by the token's
 * issuer, so the same token always reads the same hue across a replay. Hashes the address to a hue
 * (fixed saturation/lightness so every issuer color is clearly visible against the dimmed map).
 */
export function colorForAddress(addr: string): string {
  const s = addr.toLowerCase();
  let h = 0;
  for (let i = 2; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return hslToHex(h % 360, 68, 52);
}
