import { Injectable } from '@nestjs/common';
import { RowDataPacket } from 'mysql2/promise';
import { ChinaPartsDb } from './mysql.provider';

/** One row of Sanctum's `personal_access_tokens`, limited to the columns we may read. */
export interface PersonalAccessToken {
  id: number;
  tokenableType: string;
  tokenableId: number;
  /** sha256 hex of the secret part of the token. */
  tokenHash: string;
  expiresAt: Date | null;
  createdAt: Date | null;
}

interface TokenRow extends RowDataPacket {
  id: number;
  tokenable_type: string;
  tokenable_id: number;
  token: string;
  expires_at: Date | null;
  created_at: Date | null;
}

// Column-level grants: every query names its columns, and `SELECT *` would be refused.
const COLUMNS =
  'id, tokenable_type, tokenable_id, token, expires_at, created_at';

/** Session lookup for China Parts' Sanctum tokens (research R4). Read-only by construction. */
@Injectable()
export class TokensRepository {
  constructor(private readonly db: ChinaPartsDb) {}

  async findById(id: number): Promise<PersonalAccessToken | null> {
    const rows = await this.db.query<TokenRow>(
      `SELECT ${COLUMNS} FROM personal_access_tokens WHERE id = ?`,
      [id],
    );
    return this.first(rows);
  }

  async findByHash(sha256Hex: string): Promise<PersonalAccessToken | null> {
    const rows = await this.db.query<TokenRow>(
      `SELECT ${COLUMNS} FROM personal_access_tokens WHERE token = ?`,
      [sha256Hex],
    );
    return this.first(rows);
  }

  private first(rows: TokenRow[]): PersonalAccessToken | null {
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      tokenableType: row.tokenable_type,
      tokenableId: Number(row.tokenable_id),
      tokenHash: row.token,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }
}
