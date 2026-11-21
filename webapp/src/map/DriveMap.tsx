import { useEffect, useRef } from 'react';
import { L, baseMap, dotIcon, meIcon } from './leaflet';

/** Small map: my position, the next stop highlighted, the remaining stops faded. */
export default function DriveMap({ me, next, rest }: { me: { lat: number; lng: number } | null; next: { lat: number; lng: number } | null; rest: { lat: number; lng: number }[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  useEffect(() => {
    if (!el.current) return;
    map.current = baseMap(el.current, next ? [next.lat, next.lng] : undefined, 14);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    for (const r of rest) L.marker([r.lat, r.lng], { icon: dotIcon('rgba(15,93,58,0.35)') }).addTo(g);
    if (next) L.marker([next.lat, next.lng], { icon: dotIcon('#e8a317', '▶') }).addTo(g);
    if (me) L.marker([me.lat, me.lng], { icon: meIcon() }).addTo(g);
    const pts = [me, next].filter(Boolean) as { lat: number; lng: number }[];
    if (pts.length === 2) m.fitBounds(pts.map((p) => [p.lat, p.lng] as [number, number]), { padding: [40, 40], maxZoom: 16 });
    else if (pts.length === 1) m.setView([pts[0].lat, pts[0].lng], 15);
  }, [me, next, rest]);
  return <div ref={el} className="h-44 w-full overflow-hidden rounded-[18px]" />;
}
