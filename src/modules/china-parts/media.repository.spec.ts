import { ChinaPartsMediaRepository } from './media.repository';
import { configWith, FakeChinaPartsDb } from './testing';

const config = configWith({
  CHINAPARTS_DISK_URLS: 'public=https://cp.example/storage',
});

function mediaRow(over: Record<string, unknown>) {
  return {
    id: 1,
    model_type: 'App\\Models\\Product',
    model_id: 101,
    uuid: 'uuid-1',
    file_name: 'filter.jpg',
    disk: 'public',
    collection_name: 'images',
    order_column: 1,
    ...over,
  } as never;
}

describe('ChinaPartsMediaRepository', () => {
  let db: FakeChinaPartsDb;
  let repository: ChinaPartsMediaRepository;

  beforeEach(() => {
    db = new FakeChinaPartsDb();
    repository = new ChinaPartsMediaRepository(db.asDb(), config);
  });

  it('asks for the first image of each model in one query, lowest order first', async () => {
    db.on(/FROM media/, [
      mediaRow({
        id: 5,
        model_id: 101,
        file_name: 'first.jpg',
        order_column: 1,
      }),
      mediaRow({
        id: 6,
        model_id: 101,
        file_name: 'second.jpg',
        order_column: 2,
      }),
      mediaRow({
        id: 9,
        model_id: 102,
        file_name: 'other.jpg',
        order_column: 1,
      }),
    ]);

    const urls = await repository.firstImageUrls(
      ['App\\Models\\Product', 'product'],
      'images',
      [101, 102],
    );

    expect(urls.get(101)).toBe('https://cp.example/storage/5/first.jpg');
    expect(urls.get(102)).toBe('https://cp.example/storage/9/other.jpg');
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('ORDER BY order_column, id');
    expect(db.queries[0].values).toEqual([
      ['App\\Models\\Product', 'product'],
      [101, 102],
      'images',
    ]);
    db.expectNoSelectStar();
  });

  it('skips a model whose disk has no configured URL', async () => {
    db.on(/FROM media/, [mediaRow({ disk: 's3-unknown' })]);
    expect(
      (await repository.firstImageUrls(['product'], 'images', [101])).size,
    ).toBe(0);
  });

  it('does not query when there is nothing to look up', async () => {
    expect((await repository.firstImageUrls([], 'images', [1])).size).toBe(0);
    expect(
      (await repository.firstImageUrls(['product'], 'images', [])).size,
    ).toBe(0);
    expect(db.queries).toHaveLength(0);
  });

  it('fills the template placeholders and encodes the file name', async () => {
    const custom = new ChinaPartsMediaRepository(
      db.asDb(),
      configWith({
        CHINAPARTS_DISK_URLS: 'public=https://cp.example/media/',
        CHINAPARTS_MEDIA_URL_TEMPLATE:
          '{diskUrl}/{collection_name}/{uuid}/{file_name}',
      }),
    );
    db.on(/FROM media/, [mediaRow({ file_name: 'a b.jpg', uuid: 'u-1' })]);

    const urls = await custom.firstImageUrls(['product'], 'images', [101]);

    expect(urls.get(101)).toBe('https://cp.example/media/images/u-1/a%20b.jpg');
  });
});
