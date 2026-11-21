import { useState } from 'react';
import { ShopPicker } from '../orders/ShopPicker';
import { SellScreen } from './Sell';

/** "+" → Sotish: pick the shop (nearby first), then sell. */
export function SellPick() {
  const [shopId, setShopId] = useState<number | null>(null);
  if (!shopId) return <ShopPicker title="Sotish" onPick={setShopId} />;
  return <SellScreen shopId={shopId} />;
}
