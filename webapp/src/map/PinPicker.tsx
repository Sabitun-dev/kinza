import { useEffect, useRef } from 'react';
import { L, baseMap, dotIcon } from './leaflet';

/** Small map with a draggable pin. Tap the map to move the pin. */
export default function PinPicker({ lat, lng, onChange }: { lat: number | null; lng: number | null; onChange: (p: { lat: number; lng: number }) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const marker = useRef<L.Marker | null>(null);
  const map = useRef<L.Map | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (!el.current) return;
    const m = baseMap(el.current, lat != null && lng != null ? [lat, lng] : undefined, lat != null ? 17 : 13);
    map.current = m;
    const place = (p: L.LatLng) => {
      if (!marker.current) {
        marker.current = L.marker(p, { icon: dotIcon('#0f5d3a'), draggable: true }).addTo(m);
        marker.current.on('dragend', () => {
          const ll = marker.current!.getLatLng();
          cb.current({ lat: ll.lat, lng: ll.lng });
        });
      } else marker.current.setLatLng(p);
    };
    if (lat != null && lng != null) place(L.latLng(lat, lng));
    m.on('click', (e: L.LeafletMouseEvent) => {
      place(e.latlng);
      cb.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    return () => {
      m.remove();
      marker.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow external changes ("Mening joylashuvim")
  useEffect(() => {
    if (lat == null || lng == null || !map.current) return;
    const p = L.latLng(lat, lng);
    if (marker.current) marker.current.setLatLng(p);
    else {
      marker.current = L.marker(p, { icon: dotIcon('#0f5d3a'), draggable: true }).addTo(map.current);
      marker.current.on('dragend', () => {
        const ll = marker.current!.getLatLng();
        cb.current({ lat: ll.lat, lng: ll.lng });
      });
    }
    map.current.setView(p, 17);
  }, [lat, lng]);

  return <div ref={el} className="h-56 w-full overflow-hidden rounded-[18px]" />;
}
