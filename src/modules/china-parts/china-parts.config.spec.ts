import { configWith } from './testing';

describe('ChinaPartsConfig', () => {
  it('has the documented defaults', () => {
    const config = configWith();

    expect([...config.customerTypes]).toEqual([
      'App\\Models\\Customer',
      'customer',
    ]);
    expect([...config.sellerTypes]).toEqual(['App\\Models\\Seller', 'seller']);
    expect([...config.approvedSellerStatuses]).toEqual(['approved', '1']);
    expect(config.productImageCollection).toBe('images');
    expect(config.shopImageCollection).toBe('logo');
    expect(config.sellerImageCollection).toBe('avatar');
    expect(config.mediaUrlTemplate).toBe('{diskUrl}/{id}/{file_name}');
    expect(config.baseCurrency).toBe('SAR');
    expect(config.tokenExpirationMinutes).toBeNull();
    expect(config.fx).toEqual({
      table: 'currencies',
      codeColumn: 'code',
      rateColumn: 'exchange_rate',
      direction: 'per_base',
    });
  });

  it('maps a tokenable_type to an account type, and refuses everything else (FR-007)', () => {
    const config = configWith();

    expect(config.accountTypeOf('App\\Models\\Customer')).toBe('customer');
    expect(config.accountTypeOf('customer')).toBe('customer');
    expect(config.accountTypeOf('App\\Models\\Seller')).toBe('seller');
    expect(config.accountTypeOf('seller')).toBe('seller');
    expect(config.accountTypeOf('App\\Models\\Admin')).toBeNull();
    expect(config.accountTypeOf('admin')).toBeNull();
    expect(config.accountTypeOf('')).toBeNull();
  });

  it('follows configured type names, trimming and ignoring blanks', () => {
    const config = configWith({
      CHINAPARTS_CUSTOMER_TYPES: ' shopper , ,App\\Customer ',
      CHINAPARTS_SELLER_TYPES: 'vendor',
    });

    expect(config.accountTypeOf('shopper')).toBe('customer');
    expect(config.accountTypeOf('App\\Customer')).toBe('customer');
    expect(config.accountTypeOf('vendor')).toBe('seller');
    expect(config.accountTypeOf('customer')).toBeNull();
  });

  it('lower-cases approved seller statuses so comparison is not case sensitive', () => {
    const config = configWith({
      CHINAPARTS_SELLER_APPROVED_VALUES: 'Approved, 1 ,ACTIVE',
    });
    expect([...config.approvedSellerStatuses]).toEqual([
      'approved',
      '1',
      'active',
    ]);
  });

  it('parses disk URLs, keeping "=" inside a URL and trimming trailing slashes', () => {
    const config = configWith({
      CHINAPARTS_DISK_URLS:
        'public=https://cp.example/storage/, s3=https://cdn.example/a?b=c ,broken',
    });

    expect(config.diskUrls.get('public')).toBe('https://cp.example/storage');
    expect(config.diskUrls.get('s3')).toBe('https://cdn.example/a?b=c');
    expect(config.diskUrls.size).toBe(2);
  });

  it('reads the token expiry only when it is a positive number', () => {
    expect(
      configWith({ CHINAPARTS_TOKEN_EXPIRATION_MINUTES: 120 })
        .tokenExpirationMinutes,
    ).toBe(120);
    expect(
      configWith({ CHINAPARTS_TOKEN_EXPIRATION_MINUTES: '60' })
        .tokenExpirationMinutes,
    ).toBe(60);
    expect(
      configWith({ CHINAPARTS_TOKEN_EXPIRATION_MINUTES: '' })
        .tokenExpirationMinutes,
    ).toBeNull();
    expect(
      configWith({ CHINAPARTS_TOKEN_EXPIRATION_MINUTES: 0 })
        .tokenExpirationMinutes,
    ).toBeNull();
  });

  it('strips trailing slashes from the public storage URL and upper-cases the base currency', () => {
    const config = configWith({
      CHINAPARTS_PUBLIC_STORAGE_URL: 'https://cp.example/storage///',
      CHINAPARTS_BASE_CURRENCY: 'sar',
    });
    expect(config.publicStorageUrl).toBe('https://cp.example/storage');
    expect(config.baseCurrency).toBe('SAR');
  });

  describe('exchange-rate identifiers (constitution IV: not parameters, so validated)', () => {
    it('accepts letters, digits and underscores', () => {
      const config = configWith({
        CHINAPARTS_FX_TABLE: 'fx_rates_2',
        CHINAPARTS_FX_CODE_COLUMN: 'iso',
        CHINAPARTS_FX_RATE_COLUMN: 'rate',
        CHINAPARTS_FX_RATE_DIRECTION: 'to_base',
      });
      expect(config.fx).toEqual({
        table: 'fx_rates_2',
        codeColumn: 'iso',
        rateColumn: 'rate',
        direction: 'to_base',
      });
    });

    it.each([
      ['CHINAPARTS_FX_TABLE', 'currencies; DROP TABLE customers'],
      ['CHINAPARTS_FX_TABLE', 'a`b'],
      ['CHINAPARTS_FX_CODE_COLUMN', 'code,rate'],
      ['CHINAPARTS_FX_RATE_COLUMN', 'rate)--'],
      ['CHINAPARTS_FX_TABLE', 'db.currencies'],
    ])('rejects %s = %s', (key, value) => {
      expect(() => configWith({ [key]: value })).toThrow(
        /letters, digits and underscores/,
      );
    });
  });

  it('lists the model types of an account type for media and device lookups', () => {
    const config = configWith();
    expect(config.accountModelTypes('seller')).toEqual([
      'App\\Models\\Seller',
      'seller',
    ]);
    expect(config.tokenableTypes('customer')).toEqual([
      'App\\Models\\Customer',
      'customer',
    ]);
  });
});
