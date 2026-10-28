/**
 * Minimal Keccak-256 (the Ethereum variant, 0x01 padding), so event topics and
 * function selectors are derived from their signatures instead of pasted in.
 * BigInt lanes are slow but only ever hash a few short strings.
 */

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** rotation offsets indexed by x + 5y */
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RATE = 136;

const rotl = (v: bigint, n: number) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function permute(s: bigint[]): void {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (const rc of RC) {
    for (let x = 0; x < 5; x++) c[x] = s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) s[x + y] = s[x + y]! ^ d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y]!, ROT[x + 5 * y]!);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) s[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & MASK & b[((x + 2) % 5) + y]!);
    }
    s[0] = s[0]! ^ rc;
  }
}

export function keccak256(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1]! |= 0x80;

  const s = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]!);
      s[i] = s[i]! ^ lane;
    }
    permute(s);
  }
  let hex = '';
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 8; k++) hex += Number((s[i]! >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, '0');
  }
  return `0x${hex}`;
}

/** topic0 for an event signature, e.g. "Transfer(address,address,uint256)" */
export const topic = (signature: string) => keccak256(signature);
/** 4-byte selector for a function signature, e.g. "symbol()" */
export const selector = (signature: string) => keccak256(signature).slice(0, 10);
