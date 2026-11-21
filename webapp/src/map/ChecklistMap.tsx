import { useEffect, useRef } from 'react';
import { L, baseMap, dotIcon } from './leaflet';
import type { ChecklistRow } from '../screens/today/Checklist';

const COLOR: Record<string, string> = { PENDING: '#0f5d3a', SOLD: '#8aa398', DELIVERED: '#8aa398', NO_ORDER: '#b26b00', CLOSED: '#c62f2f', MOVED: '#1f62c9' };

/** Today's shops as numbered pins coloured by status, with the route line. */
export default function ChecklistMap({ items, route, onOpen }: { items: ChecklistRow[]; route?: { path?: [number, number][] } | null; onOpen: (r: ChecklistRow) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    if (!el.current) return;
    const map = baseMap(el.current);
    const pts: [number, number][] = [];
    items.forEach((r, i) => {
      if (r.shop.lat == null || r.shop.lng == null) return;
      pts.push([r.shop.lat, r.shop.lng]);
      L.marker([r.shop.lat, r.shop.lng], { icon: dotIcon(COLOR[r.status] ?? '#0f5d3a', r.status === 'PENDING' ? i + 1 : '✓') })
        .addTo(map)
        .on('click', () => open.current(r));
    });
    const line = route?.path ?? pts;
    if (line.length > 1) L.polyline(line, { color: '#e8a317', weight: 4, opacity: 0.8 }).addTo(map);
    if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    else if (pts.length === 1) map.setView(pts[0], 16);
    return () => {
      map.remove();
    };
  }, [items, route]);
  return <div ref={el} className="h-[55vh] w-full overflow-hidden rounded-[18px]" />;
}
