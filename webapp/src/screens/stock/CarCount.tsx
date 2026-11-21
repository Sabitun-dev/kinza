// Evening car stock count for "Kun yakuni" (filled in with the car stock step).

export interface CarCount {
  hasDiff: boolean;
  diffText: string;
  save: () => Promise<void>;
}

export function useCarCount(): CarCount {
  return { hasDiff: false, diffText: '', save: async () => {} };
}

export function CarCountSection(_: { car: CarCount }) {
  return null;
}
