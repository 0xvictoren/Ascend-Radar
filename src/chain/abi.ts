import type { Address } from '../core/types.ts';
import { selector } from './keccak.ts';

/** Just enough ABI decoding for the handful of events and calls Radar reads. */

export const words = (data: string): string[] => (data.startsWith('0x') ? data.slice(2) : data).match(/.{64}/g) ?? [];

export const uint = (word: string): bigint => BigInt(`0x${word}`);

export function int(word: string): bigint {
  const v = BigInt(`0x${word}`);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

export const addr = (wordOrTopic: string): Address => `0x${wordOrTopic.slice(-40).toLowerCase()}` as Address;

export const padAddress = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;

/** bigint base units -> float, keeping precision for 18-decimal amounts */
export function units(v: bigint, decimals: number): number {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const n = Number(abs / base) + Number(abs % base) / Number(base);
  return neg ? -n : n;
}

/** Decodes an ABI-encoded `string` return value (also tolerates bytes32-style names). */
export function decodeString(ret: string | null): string {
  if (!ret || ret === '0x') return '';
  const w = words(ret);
  if (w.length >= 2 && uint(w[0]!) === 32n) {
    const len = Number(uint(w[1]!));
    const hex = w.slice(2).join('').slice(0, len * 2);
    return Buffer.from(hex, 'hex').toString('utf8');
  }
  return Buffer.from(w[0] ?? '', 'hex').toString('utf8').replace(/\0+$/, '');
}

export const SEL = {
  name: selector('name()'),
  symbol: selector('symbol()'),
  decimals: selector('decimals()'),
  poolManager: selector('poolManager()'),
  vault: selector('vault()'),
  baseQuote: selector('baseQuote()'),
};
