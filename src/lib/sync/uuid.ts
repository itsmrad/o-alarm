/**
 * RFC 4122 v5 (name-based, SHA-1) UUIDs, synchronous and dependency-free.
 *
 * Cloud rows with a natural key (occurrence, morning check-in, device, sync_state) get a
 * deterministic id derived from that key, so two devices converge on the same row instead
 * of hitting a unique violation (supabase/README.md "Sync conventions").
 */

/** Fixed namespace for O-Alarm cloud ids. Never change it: ids would stop converging. */
const NAMESPACE = '6f0f6b8e-3c1a-5d4e-9a57-0a1a2b3c4d5e';

function utf8(value: string): number[] {
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }
  return bytes;
}

function sha1(message: number[]): number[] {
  const bytes = [...message, 0x80];
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian bit length; names are far below 2^29 bytes, so the high word is 0.
  const bitLength = message.length * 8;
  bytes.push(
    0,
    0,
    0,
    0,
    bitLength >>> 24,
    (bitLength >>> 16) & 255,
    (bitLength >>> 8) & 255,
    bitLength & 255,
  );
  const byte = (i: number) => bytes[i] ?? 0;
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (byte(j) << 24) | (byte(j + 1) << 16) | (byte(j + 2) << 8) | byte(j + 3);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) [f, k] = [(b & c) | (~b & d), 0x5a827999];
      else if (i < 40) [f, k] = [b ^ c ^ d, 0x6ed9eba1];
      else if (i < 60) [f, k] = [(b & c) | (b & d) | (c & d), 0x8f1bbcdc];
      else [f, k] = [b ^ c ^ d, 0xca62c1d6];
      const temp = (rotl(a, 5) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].flatMap((word) => [
    (word >>> 24) & 255,
    (word >>> 16) & 255,
    (word >>> 8) & 255,
    word & 255,
  ]);
}

function parseUuid(uuid: string): number[] {
  const hex = uuid.replace(/-/g, '');
  return Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

export function uuidV5(name: string, namespace: string = NAMESPACE): string {
  const hash = sha1([...parseUuid(namespace), ...utf8(name)]).slice(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
