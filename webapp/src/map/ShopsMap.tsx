import { useEffect, useRef } from 'react';
import { L, baseMap, dotIcon, meIcon } from './leaflet';
import { formatMoney } from '@shared/money';

interface MapShop {
  id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  balance: number;
  overdue: number;
}

/** All shops on a map. Red = overdue debt, gold = debt, green = no debt. */
export default function ShopsMap({ shops, me, onOpen }: { shops: MapShop[]; me: { lat: number; lng: number } | null; onOpen: (id: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    if (!el.current) return;
    const map = baseMap(el.current, me ? [me.lat, me.lng] : undefined);
    const pts: [number, number][] = [];
    for (const s of shops) {
      if (s.lat == null || s.lng == null) continue;
      pts.push([s.lat, s.lng]);
      const color = s.overdue > 0 ? '#c62f2f' : s.balance > 0 ? '#e8a317' : '#0f5d3a';
      const m = L.marker([s.lat, s.lng], { icon: dotIcon(color) }).addTo(map);
      const div = document.createElement('div');
      div.style.cssText = 'font:15px system-ui;min-width:140px';
      div.innerHTML = `<b>${s.name.replace(/</g, '&lt;')}</b><br>${s.balance > 0 ? 'Qarz: ' + formatMoney(s.balance) : "Qarz yo'q"}<br><a style="color:#0f5d3a;font-weight:700">Ochish →</a>`;
      div.querySelector('a')!.onclick = () => open.current(s.id);
      m.bindPopup(div);
    }
    if (me) {
      L.marker([me.lat, me.lng], { icon: meIcon() }).addTo(map);
      pts.push([me.lat, me.lng]);
    }
    if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    return () => {
      map.remove();
    };
  }, [shops, me]);
  const missing = shops.filter((s) => s.lat == null).length;
  return (
    <div>
      <div ref={el} className="h-[62vh] w-full overflow-hidden rounded-[18px]" />
      {missing > 0 && <div className="mt-2 px-1 text-[13px] text-muted">{missing} ta do'konda joylashuv saqlanmagan.</div>}
    </div>
  );
}
