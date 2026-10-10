import { Injectable } from '@nestjs/common';
import { RowDataPacket } from 'mysql2/promise';
import { ChinaPartsConfig } from './china-parts.config';
import { ChinaPartsDb } from './mysql.provider';

/**
 * China Parts' own exchange rates (research R11): currency code to rate, as the decimal string the
 * table holds. What a rate means (units per base currency, or the reverse) is configuration
 * (`CHINAPARTS_FX_RATE_DIRECTION`), applied by the conversion, not here.
 *
 * The table and column names are configuration too. A name cannot be a query parameter, so
 * `ChinaPartsConfig` checks each against `^[A-Za-z0-9_]+$` and this class quotes it as an
 * identifier. The query names its two columns, never `*`.
 */
@Injectable()
export class ChinaPartsExchangeRatesRepository {
  constructor(
    private readonly db: ChinaPartsDb,
    private readonly config: ChinaPartsConfig,
  ) {}

  async getRates(): Promise<Map<string, string>> {
    const { table, codeColumn, rateColumn } = this.config.fx;
    const rows = await this.db.query<RowDataPacket>(
      `SELECT \`${codeColumn}\` AS code, \`${rateColumn}\` AS rate FROM \`${table}\``,
    );
    const rates = new Map<string, string>();
    for (const row of rows) {
      const code = String(row.code).trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(code) && row.rate !== null) {
        rates.set(code, String(row.rate));
      }
    }
    return rates;
  }
}
