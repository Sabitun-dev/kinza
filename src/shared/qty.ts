// Quantities are stored as cans. A pack (blok) holds packSize cans (default 24).

export interface PackSplit {
  packs: number;
  cans: number;
}

export function toCans(packs: number, cans: number, packSize: number): number {
  return packs * packSize + cans;
}

export function splitCans(total: number, packSize: number): PackSplit {
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  return { packs: sign * Math.floor(abs / packSize), cans: sign * (abs % packSize) };
}

/** 246 cans, 24 per pack → "10 blok + 6 dona"; 240 → "10 blok"; 6 → "6 dona"; 0 → "0". */
export function formatQty(total: number, packSize: number): string {
  const { packs, cans } = splitCans(total, packSize);
  if (packs && cans) return `${packs} blok + ${Math.abs(cans)} dona`;
  if (packs) return `${packs} blok`;
  if (cans) return `${cans} dona`;
  return '0';
}

/** Short form for tight spaces: "10+6" or "10" (packs + cans). */
export function formatQtyShort(total: number, packSize: number): string {
  const { packs, cans } = splitCans(total, packSize);
  return cans ? `${packs}+${Math.abs(cans)}` : `${packs}`;
}

/** Price of a quantity: whole packs at the pack price, loose cans at the can price. */
export function priceFor(totalCans: number, packSize: number, perPack: number, perCan: number): number {
  const { packs, cans } = splitCans(totalCans, packSize);
  return packs * perPack + cans * perCan;
}

/** Default can price derived from a pack price. */
export function defaultCanPrice(perPack: number, packSize: number): number {
  return Math.round(perPack / packSize);
}
