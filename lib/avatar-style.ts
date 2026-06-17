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
