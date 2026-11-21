import { createContext, useContext } from 'react';

export type Role = 'OWNER' | 'AGENT' | 'DRIVER';

export interface Session {
  user: { id: number; name: string; role: Role; phone: string | null; introSeen: boolean };
  settings: Record<string, any> & {
    businessName: string;
    defaultPackSize: number;
    deliveryDays: number;
    skipSundays: boolean;
    agentMaxDiscountBp: number;
    lowStockPacks: number;
    botUsername: string;
  };
  reload: () => Promise<void>;
}

export const SessionCtx = createContext<Session>(null as never);
export const useSession = () => useContext(SessionCtx);
export const useRole = () => useSession().user.role;
export const useIsOwner = () => useSession().user.role === 'OWNER';
