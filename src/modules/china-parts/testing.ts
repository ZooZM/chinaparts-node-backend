import { ConfigService } from '@nestjs/config';
import { RowDataPacket } from 'mysql2/promise';
import { ChinaPartsConfig } from './china-parts.config';
import { ChinaPartsDb } from './mysql.provider';

/** Shared by the specs in this module: a fake database that records every query it is given. */
export interface RecordedQuery {
  sql: string;
  values: unknown[];
}

type QueryMatcher = RegExp | ((sql: string, values: unknown[]) => boolean);

export class FakeChinaPartsDb {
  readonly queries: RecordedQuery[] = [];
  private readonly handlers: Array<
    (sql: string, values: unknown[]) => RowDataPacket[] | undefined
  > = [];

  /**
   * Answers any query that matches (a RegExp on the SQL, or a predicate on SQL and values).
   * Later registrations win. A query nothing matches gets no rows.
   */
  on(matcher: QueryMatcher, rows: RowDataPacket[]): this {
    const matches =
      matcher instanceof RegExp
        ? (sql: string): boolean => matcher.test(sql)
        : matcher;
    this.handlers.unshift((sql, values) =>
      matches(sql, values) ? rows : undefined,
    );
    return this;
  }

  query<T extends RowDataPacket>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    this.queries.push({ sql, values });
    for (const handler of this.handlers) {
      const rows = handler(sql, values);
      if (rows) return Promise.resolve(rows as T[]);
    }
    return Promise.resolve([]);
  }

  asDb(): ChinaPartsDb {
    return this as unknown as ChinaPartsDb;
  }

  /** No query may select `*`: the grants are column-level, so it would be refused (and it leaks). */
  expectNoSelectStar(): void {
    for (const { sql } of this.queries) {
      expect(sql).not.toMatch(/select\s+\*/i);
      expect(sql).not.toMatch(/\b\w+\.\*/);
    }
  }
}

export function configWith(
  values: Record<string, unknown> = {},
): ChinaPartsConfig {
  return new ChinaPartsConfig({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}
