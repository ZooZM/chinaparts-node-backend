import { ChinaPartsDevicesRepository } from './devices.repository';
import { configWith, FakeChinaPartsDb } from './testing';

describe('ChinaPartsDevicesRepository (research R14, FR-063)', () => {
  let db: FakeChinaPartsDb;
  let repository: ChinaPartsDevicesRepository;

  beforeEach(() => {
    db = new FakeChinaPartsDb();
    repository = new ChinaPartsDevicesRepository(db.asDb(), configWith());
  });

  it("asks for the exact account's tokens in its own app, with the columns the grants allow", async () => {
    db.on(/FROM device_tokens/, [
      { token: 'fcm-token-seller-1', platform: 'ios' },
    ] as never[]);

    const tokens = await repository.getTokens('seller', 1);

    expect(tokens).toEqual([{ token: 'fcm-token-seller-1', platform: 'ios' }]);
    expect(db.queries).toEqual([
      {
        sql: 'SELECT token, platform FROM device_tokens WHERE tokenable_type IN (?) AND tokenable_id = ? AND app = ?',
        values: [['App\\Models\\Seller', 'seller'], 1, 'seller'],
      },
    ]);
    db.expectNoSelectStar();
  });

  it('uses the customer types and the customer app for a customer', async () => {
    await repository.getTokens('customer', 1);

    expect(db.queries[0].values).toEqual([
      ['App\\Models\\Customer', 'customer'],
      1,
      'customer',
    ]);
  });

  it('uses the configured type names', async () => {
    const custom = new ChinaPartsDevicesRepository(
      db.asDb(),
      configWith({ CHINAPARTS_SELLER_TYPES: 'Vendor' }),
    );

    await custom.getTokens('seller', 9);

    expect(db.queries[0].values[0]).toEqual(['Vendor']);
  });

  it('returns a device registered twice once', async () => {
    db.on(/FROM device_tokens/, [
      { token: 'same', platform: 'android' },
      { token: 'same', platform: 'android' },
      { token: 'other', platform: 'ios' },
    ] as never[]);

    const tokens = await repository.getTokens('customer', 1);

    expect(tokens.map((t) => t.token)).toEqual(['same', 'other']);
  });

  it('returns none for an account with no devices', async () => {
    expect(await repository.getTokens('customer', 99)).toEqual([]);
  });
});
