import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney } from '@shared/money';

/** Revenue per day — one series, so no legend; the card title names it. */
export default function RevenueChart({ series }: { series: { date: string; revenue: number; collected: number }[] }) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const bar = dark ? '#2f9e68' : '#138a4b'; // validated against each surface
  const ink = dark ? '#94a99c' : '#5b6f64';
  const grid = dark ? '#22382b' : '#e1e9e4';
  const short = (v: number) => (v >= 1_000_000 ? `${Math.round(v / 100_000) / 10}m` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={series} margin={{ top: 8, right: 4, left: -12, bottom: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} stroke={grid} />
        <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(8)} tick={{ fill: ink, fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={12} />
        <YAxis tickFormatter={short} tick={{ fill: ink, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
        <Tooltip
          cursor={{ fill: grid, opacity: 0.6 }}
          contentStyle={{ borderRadius: 12, border: 'none', background: dark ? '#1a2d22' : '#ffffff', color: dark ? '#ecf4ef' : '#10261b', fontSize: 13 }}
          labelFormatter={(d) => String(d).split('-').reverse().join('.')}
          formatter={(v) => [formatMoney(Number(v)), 'Tushum']}
        />
        <Bar dataKey="revenue" fill={bar} radius={[4, 4, 0, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}
