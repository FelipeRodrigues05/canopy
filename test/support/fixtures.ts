import { v7 as uuidv7 } from 'uuid';

export const newPlayerId = (): string => uuidv7();

export const brl = (amount: string) => ({ amount, currency: 'BRL' });
