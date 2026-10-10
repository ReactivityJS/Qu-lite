/**
 * CRYPTO - everything Qu Lite needs, on WebCrypto only (browsers, Node >= 22):
 * Ed25519 signatures, X25519 key agreement, AES-256-GCM, SHA-256, HKDF,
 * HMAC, deterministic key pairs from 32-byte seeds, and an anonymous
 * SEALED BOX for "encrypt to a public key without revealing who sent it or
 * whom it is for".
 *
 * Private keys are PKCS8 bytes throughout (that is what WebCrypto imports).
 */
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

/** Fixed RFC 8410 PKCS8 prefixes: header || 32-byte raw private scalar. */
const PKCS8_HEADER = {
  Ed25519: new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
  X25519: new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]),
};

// --------------------------------------------------------------- encoding
export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`fromHex: not valid hex`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// --------------------------------------------------------------- hashing
export const sha256 = async (data) => new Uint8Array(await subtle.digest('SHA-256', data));

/** @param {Uint8Array} ikm @param {string} info @param {number} [length] */
export async function hkdf(ikm, info, length = 32) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, key, length * 8));
}

export async function hmac(keyBytes, data) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, data));
}

// --------------------------------------------------------------- key pairs
/**
 * Deterministic key pair from a 32-byte seed.
 * @param {'Ed25519'|'X25519'} curve
 * @param {Uint8Array} seed
 * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>} privateKey is PKCS8
 */
export async function keypairFromSeed(curve, seed) {
  if (seed.length !== 32) throw new Error('keypairFromSeed: seed must be 32 bytes');
  const privateKey = concat(PKCS8_HEADER[curve], seed);
  const key = await subtle.importKey('pkcs8', privateKey, { name: curve }, true, curve === 'Ed25519' ? ['sign'] : ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', key);
  return { publicKey: fromBase64(jwk.x), privateKey };
}

/** A fresh identity: Ed25519 for signing, X25519 (`xPublicKey`, the "epub") for receiving sealed boxes. */
export async function generateIdentity() {
  const ed = await keypairFromSeed('Ed25519', randomBytes(32));
  const x = await keypairFromSeed('X25519', randomBytes(32));
  return { publicKey: ed.publicKey, privateKey: ed.privateKey, xPublicKey: x.publicKey, xPrivateKey: x.privateKey };
}

// --------------------------------------------------------------- signatures
export async function sign(data, privateKey) {
  const key = await subtle.importKey('pkcs8', privateKey, { name: 'Ed25519' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('Ed25519', key, data));
}

/** @returns {Promise<boolean>} false (never throws) for malformed keys or signatures */
export async function verify(data, signature, publicKey) {
  try {
    const key = await subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify('Ed25519', key, signature, data);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- symmetric
export const aesKey = (raw) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** @returns {Promise<Uint8Array>} iv(12) || ciphertext+tag */
export async function aesEncrypt(key, plaintext, additionalData) {
  const iv = randomBytes(12);
  const params = additionalData ? { name: 'AES-GCM', iv, additionalData } : { name: 'AES-GCM', iv };
  return concat(iv, new Uint8Array(await subtle.encrypt(params, key, plaintext)));
}

export async function aesDecrypt(key, sealed, additionalData) {
  const iv = sealed.subarray(0, 12);
  const params = additionalData ? { name: 'AES-GCM', iv, additionalData } : { name: 'AES-GCM', iv };
  return new Uint8Array(await subtle.decrypt(params, key, sealed.subarray(12)));
}

// --------------------------------------------------------------- sealed box
async function sharedKey(xPrivateKey, xPublicKey, ephPub, recipientPub) {
  const priv = await subtle.importKey('pkcs8', xPrivateKey, { name: 'X25519' }, false, ['deriveBits']);
  const pub = await subtle.importKey('raw', xPublicKey, { name: 'X25519' }, false, []);
  const secret = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256));
  return aesKey(await hkdf(concat(secret, ephPub, recipientPub), 'qu-lite/sealed-box'));
}

/**
 * Encrypts `bytes` so that only the holder of `recipientXPub`'s private key
 * can read it. Anonymous: the output carries a one-time ephemeral key, no
 * sender and no recipient identifier. Layout: ephPub(32) || iv(12) || ct.
 */
export async function sealTo(recipientXPub, bytes) {
  const eph = await keypairFromSeed('X25519', randomBytes(32));
  const key = await sharedKey(eph.privateKey, recipientXPub, eph.publicKey, recipientXPub);
  return concat(eph.publicKey, await aesEncrypt(key, bytes));
}

/** @returns {Promise<Uint8Array|null>} the plaintext, or null if the box was not for this key */
export async function openSealed(xPrivateKey, xPublicKey, box) {
  if (!(box instanceof Uint8Array) || box.length < 32 + 12 + 16) return null;
  try {
    const ephPub = box.subarray(0, 32);
    const key = await sharedKey(xPrivateKey, ephPub, ephPub, xPublicKey);
    return await aesDecrypt(key, box.subarray(32));
  } catch {
    return null;
  }
}
