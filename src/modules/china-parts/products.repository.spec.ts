import { ChinaPartsMediaRepository } from './media.repository';
import { ChinaPartsProductsRepository } from './products.repository';
import { configWith, FakeChinaPartsDb } from './testing';

const config = configWith({
  CHINAPARTS_DISK_URLS: 'public=https://cp.example/storage',
});

describe('ChinaPartsProductsRepository (research R11)', () => {
  let db: FakeChinaPartsDb;
  let repository: ChinaPartsProductsRepository;

  beforeEach(() => {
    db = new FakeChinaPartsDb();
    repository = new ChinaPartsProductsRepository(
      db.asDb(),
      config,
      new ChinaPartsMediaRepository(db.asDb(), config),
    );
  });

  describe('findAttachable', () => {
    it("asks for the seller's active, undeleted products among the ids, in one query", async () => {
      db.on(/FROM products WHERE id IN/, [{ id: 101 }, { id: 102 }] as never[]);

      const attachable = await repository.findAttachable(1, [101, 102, 103]);

      expect(attachable).toEqual([101, 102]);
      expect(db.queries).toHaveLength(1);
      expect(db.queries[0].sql).toBe(
        'SELECT id FROM products WHERE id IN (?) AND seller_id = ? AND status = 1 AND deleted_at IS NULL',
      );
      expect(db.queries[0].values).toEqual([[101, 102, 103], 1]);
      db.expectNoSelectStar();
    });

    it('asks once for an id given twice', async () => {
      await repository.findAttachable(1, [101, 101]);
      expect(db.queries[0].values[0]).toEqual([101]);
    });

    it('asks nothing for no ids', async () => {
      expect(await repository.findAttachable(1, [])).toEqual([]);
      expect(db.queries).toHaveLength(0);
    });
  });

  describe('getCardRows', () => {
    const row = (over: Record<string, unknown> = {}) =>
      ({
        id: 101,
        seller_id: 1,
        name: 'Toyota Camry Oil Filter',
        slug: 'toyota-camry-oil-filter-101',
        status: 1,
        stock_quantity: 5,
        discount_percentage: '10.00',
        deleted_at: null,
        selling_price: '45.00',
        ...over,
      }) as never;

    it('reads the card columns, joining the default active variant, and the first image', async () => {
      db.on(/FROM products p/, [row()]);
      db.on(/FROM media/, [
        {
          id: 1,
          model_type: 'App\\Models\\Product',
          model_id: 101,
          uuid: 'u',
          file_name: 'filter.jpg',
          disk: 'public',
          collection_name: 'images',
          order_column: 1,
        } as never,
      ]);

      const [card] = await repository.getCardRows([101]);

      expect(card).toEqual({
        productId: 101,
        sellerExternalId: 1,
        name: 'Toyota Camry Oil Filter',
        slug: 'toyota-camry-oil-filter-101',
        active: true,
        deleted: false,
        stockQuantity: 5,
        discountPercentage: '10.00',
        sellingPrice: '45.00',
        imageUrl: 'https://cp.example/storage/1/filter.jpg',
      });
      const sql = db.queries[0].sql;
      expect(sql).toContain(
        'LEFT JOIN product_variants v ON v.product_id = p.id AND v.is_default = 1 AND v.status = 1',
      );
      expect(sql).toContain('WHERE p.id IN (?)');
      db.expectNoSelectStar();
    });

    it('keeps prices as the decimal strings China Parts stores, and reports what state a product is in', async () => {
      db.on(/FROM products p/, [
        row({
          id: 102,
          status: 0,
          deleted_at: new Date(),
          selling_price: null,
          stock_quantity: 0,
        }),
        row({ id: 103, selling_price: 12.5 }),
      ]);

      const cards = await repository.getCardRows([102, 103]);

      expect(cards[0]).toMatchObject({
        productId: 102,
        active: false,
        deleted: true,
        sellingPrice: null,
        stockQuantity: 0,
        imageUrl: null,
      });
      expect(cards[1].sellingPrice).toBe('12.5');
    });

    it('does not ask for images when there are no products', async () => {
      expect(await repository.getCardRows([])).toEqual([]);
      db.on(/FROM products p/, []);
      expect(await repository.getCardRows([5])).toEqual([]);
      expect(db.queries.some((q) => /FROM media/.test(q.sql))).toBe(false);
    });
  });
});
