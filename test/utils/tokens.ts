import { createHash, randomBytes } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import type { TestInfra } from './containers';

export type PersonKind = 'customer' | 'seller';
export type TokenType = PersonKind | 'admin';

const MODEL: Record<TokenType, string> = {
  customer: 'App\\Models\\Customer',
  seller: 'App\\Models\\Seller',
  admin: 'App\\Models\\Admin',
};

/**
 * A China Parts session, made the way Laravel Sanctum makes one: a row in `personal_access_tokens`
 * holding the sha256 of a random secret, and a bearer value `id|secret` for the client
 * (quickstart.md section 4). Inserted as root, which only a test may do.
 */
export async function issueToken(
  infra: TestInfra,
  type: TokenType,
  externalId: number,
  options: { expiresAt?: Date | null } = {},
): Promise<string> {
  const secret = randomBytes(20).toString('hex');
  const result = await infra.rootQuery<ResultSetHeader>(
    `INSERT INTO personal_access_tokens
       (tokenable_type, tokenable_id, name, token, abilities, expires_at, created_at)
     VALUES (?, ?, 'e2e', ?, '["*"]', ?, NOW())`,
    [
      MODEL[type],
      externalId,
      createHash('sha256').update(secret).digest('hex'),
      options.expiresAt ?? null,
    ],
  );
  return `Bearer ${result.insertId}|${secret}`;
}

/** The id Sanctum would have given a token, from a bearer value. */
export function tokenId(bearer: string): number {
  return Number(bearer.replace(/^Bearer /, '').split('|')[0]);
}
