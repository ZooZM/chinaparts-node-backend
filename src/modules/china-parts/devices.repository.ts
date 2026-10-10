import { Injectable } from '@nestjs/common';
import { RowDataPacket } from 'mysql2/promise';
import type { AccountType } from '../../common/http/viewer-request';
import { ChinaPartsConfig } from './china-parts.config';
import { ChinaPartsDb } from './mysql.provider';

interface DeviceRow extends RowDataPacket {
  token: string;
  platform: string;
}

/** A device China Parts registered for push, by the app it belongs to. */
export interface DeviceToken {
  token: string;
  platform: string;
}

/**
 * The push tokens China Parts holds for an account (research R14). A token is only returned for
 * the exact account type, id and app: seller 1's seller-app device is never customer 1's, even
 * though both are "1" (FR-063). Reading only: the service cannot delete a dead token, so it
 * remembers them itself.
 */
@Injectable()
export class ChinaPartsDevicesRepository {
  constructor(
    private readonly db: ChinaPartsDb,
    private readonly config: ChinaPartsConfig,
  ) {}

  async getTokens(
    accountType: AccountType,
    externalId: number,
  ): Promise<DeviceToken[]> {
    const rows = await this.db.query<DeviceRow>(
      'SELECT token, platform FROM device_tokens WHERE tokenable_type IN (?) AND tokenable_id = ? AND app = ?',
      [this.config.tokenableTypes(accountType), externalId, accountType],
    );
    // The same device can be registered twice; sending twice would show two notifications.
    const seen = new Set<string>();
    const tokens: DeviceToken[] = [];
    for (const row of rows) {
      if (seen.has(row.token)) continue;
      seen.add(row.token);
      tokens.push({ token: row.token, platform: row.platform });
    }
    return tokens;
  }
}
