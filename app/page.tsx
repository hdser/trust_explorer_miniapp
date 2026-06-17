import { MapExperience } from '@/components/map/MapExperience';

// The mini-app is a single surface: the connected avatar's trust map, with pay-anyone
// and activity/flow-replay as overlays. Rendered client-side (it owns a WebGL canvas).
export default function HomePage() {
  return <MapExperience />;
}
