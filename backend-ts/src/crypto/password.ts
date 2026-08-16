import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 10;

export async function hashPassword(raw: string): Promise<string> {
  return bcrypt.hash(raw, BCRYPT_ROUNDS);
}

export async function matchesPassword(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}
