// PIN hashing: scrypt(pin + PIN_PEPPER, salt), stored as 'scrypt$<salt hex>$<hash hex>'.
// The pepper lives only in Vercel env vars, so a database leak alone does not reveal the PIN.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEYLEN = 32;

export const isValidPin = pin => typeof pin === 'string' && /^\d{4}$/.test(pin);

function derive(pin, pepper, salt) {
  return new Promise((resolve, reject) =>
    scrypt(pin + pepper, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPin(pin, pepper) {
  if (!isValidPin(pin)) throw new Error('PIN must be exactly 4 digits');
  const salt = randomBytes(16);
  const key = await derive(pin, pepper, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPin(pin, stored, pepper) {
  if (!isValidPin(pin) || typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await derive(pin, pepper, Buffer.from(saltHex, 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
