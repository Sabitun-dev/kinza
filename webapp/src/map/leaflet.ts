import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export { L };

/** Namangan centre — used when there is no GPS yet. */
export const NAMANGAN: [number, number] = [40.9983, 71.6726];

export function baseMap(el: HTMLElement, center: [number, number] = NAMANGAN, zoom = 13) {
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);
  return map;
}

/** Coloured round markers (no image files to download). */
export function dotIcon(color: string, label?: string | number) {
  return L.divIcon({
    className: '',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#fff;font:700 13px system-ui">${label ?? ''}</div>`,
  });
}

export function meIcon() {
  return L.divIcon({
    className: '',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    html: '<div style="width:18px;height:18px;border-radius:50%;background:#1f62c9;border:3px solid #fff;box-shadow:0 0 0 6px rgba(31,98,201,.25)"></div>',
  });
}
