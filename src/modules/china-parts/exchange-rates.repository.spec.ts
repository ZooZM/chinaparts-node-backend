import { ChinaPartsExchangeRatesRepository } from './exchange-rates.repository';
import { configWith, FakeChinaPartsDb } from './testing';

describe('ChinaPartsExchangeRatesRepository (research R11)', () => {
  it('selects the two configured columns from the configured table, quoted as identifiers', async () => {
    const db = new FakeChinaPartsDb();
    db.on(/FROM `fx_rates`/, [
      { code: 'sar', rate: '1.000000' },
      { code: 'USD', rate: '0.266667' },
    ] as never[]);
    const repository = new ChinaPartsExchangeRatesRepository(
      db.asDb(),
      configWith({
        CHINAPARTS_FX_TABLE: 'fx_rates',
        CHINAPARTS_FX_CODE_COLUMN: 'iso',
        CHINAPARTS_FX_RATE_COLUMN: 'per_sar',
      }),
    );

    const rates = await repository.getRates();

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toBe(
      'SELECT `iso` AS code, `per_sar` AS rate FROM `fx_rates`',
    );
    expect(rates.get('SAR')).toBe('1.000000');
    expect(rates.get('USD')).toBe('0.266667');
    db.expectNoSelectStar();
  });

  it('uses the defaults the fixtures match', async () => {
    const db = new FakeChinaPartsDb();
    await new ChinaPartsExchangeRatesRepository(
      db.asDb(),
      configWith(),
    ).getRates();
    expect(db.queries[0].sql).toBe(
      'SELECT `code` AS code, `exchange_rate` AS rate FROM `currencies`',
    );
  });

  it('ignores a row that is not a currency code or has no rate', async () => {
    const db = new FakeChinaPartsDb();
    db.on(/currencies/, [
      { code: 'EURO', rate: '1.1' },
      { code: 'GBP', rate: null },
      { code: ' eur ', rate: '0.9' },
    ] as never[]);

    const rates = await new ChinaPartsExchangeRatesRepository(
      db.asDb(),
      configWith(),
    ).getRates();

    expect([...rates.keys()]).toEqual(['EUR']);
  });

  it('refuses a table name that could carry SQL', () => {
    expect(() =>
      configWith({ CHINAPARTS_FX_TABLE: 'currencies`; DROP' }),
    ).toThrow(/letters, digits and underscores/);
  });
});
