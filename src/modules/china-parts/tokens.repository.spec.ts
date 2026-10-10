import { TokensRepository } from './tokens.repository';
import { FakeChinaPartsDb } from './testing';

const row = {
  id: 7,
  tokenable_type: 'App\\Models\\Seller',
  tokenable_id: 42,
  token: 'a'.repeat(64),
  expires_at: null,
  created_at: new Date('2026-10-01T00:00:00Z'),
};

describe('TokensRepository', () => {
  let db: FakeChinaPartsDb;
  let repository: TokensRepository;

  beforeEach(() => {
    db = new FakeChinaPartsDb();
    repository = new TokensRepository(db.asDb());
  });

  it('finds a token by id, with exactly the columns the grants allow', async () => {
    db.on(/FROM personal_access_tokens WHERE id = \?/, [row as never]);

    expect(await repository.findById(7)).toEqual({
      id: 7,
      tokenableType: 'App\\Models\\Seller',
      tokenableId: 42,
      tokenHash: 'a'.repeat(64),
      expiresAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(db.queries[0]).toEqual({
      sql: 'SELECT id, tokenable_type, tokenable_id, token, expires_at, created_at FROM personal_access_tokens WHERE id = ?',
      values: [7],
    });
  });

  it('finds a token by the hash of its secret', async () => {
    db.on(/WHERE token = \?/, [row as never]);

    const token = await repository.findByHash('a'.repeat(64));

    expect(token?.id).toBe(7);
    expect(db.queries[0].values).toEqual(['a'.repeat(64)]);
  });

  it('returns null when there is no such token', async () => {
    expect(await repository.findById(999)).toBeNull();
    expect(await repository.findByHash('b'.repeat(64))).toBeNull();
  });

  it('coerces the ids from the driver to numbers', async () => {
    db.on(/personal_access_tokens/, [
      { ...row, id: '7', tokenable_id: '42' } as never,
    ]);
    const token = await repository.findById(7);
    expect(token).toMatchObject({ id: 7, tokenableId: 42 });
  });

  it('never selects *, which the column-level grants would refuse', async () => {
    db.on(/personal_access_tokens/, [row as never]);
    await repository.findById(1);
    await repository.findByHash('c'.repeat(64));
    db.expectNoSelectStar();
  });
});
