import type { ResultSetHeader } from 'mysql2/promise';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import type { TestApp } from './app';
import { accountIdOf } from './fixtures';
import { issueToken, PersonKind } from './tokens';

/** A China Parts account a test can act as: a session, plus its reels identity. */
export interface Person {
  kind: PersonKind;
  /** The China Parts id (the `customers` or `sellers` row). */
  externalId: number;
  /** `Bearer id|secret`, for `CallOptions.token`. */
  token: string;
  /** The reels account id (an ObjectId string), what every response calls `id`. */
  id: string;
  /** The automatic handle, with the case the generator gave it. */
  username: string;
  name: string;
}

export interface PersonOptions {
  firstName?: string;
  lastName?: string;
}

let counter = 0;

/**
 * A new China Parts account in good standing (an active customer or an approved seller), with a
 * session and a provisioned reels identity. Every call makes a different person, so a test never
 * depends on what another test did. The handle comes from the name, as it does in production
 * (FR-015): `createPerson(app, 'customer', { firstName: 'Lina', lastName: 'K' })` is `Lina_K`.
 */
export async function createPerson(
  testApp: TestApp,
  kind: PersonKind,
  options: PersonOptions = {},
): Promise<Person> {
  counter += 1;
  const firstName =
    options.firstName ?? (kind === 'seller' ? 'Seller' : 'Buyer');
  const lastName = options.lastName ?? `Number${counter}`;

  const result =
    kind === 'seller'
      ? await testApp.infra.rootQuery<ResultSetHeader>(
          `INSERT INTO sellers
             (first_name, last_name, password, status, identity_status, created_at, updated_at)
           VALUES (?, ?, 'x', 'approved', 'approved', NOW(), NOW())`,
          [firstName, lastName],
        )
      : await testApp.infra.rootQuery<ResultSetHeader>(
          `INSERT INTO customers
             (first_name, last_name, password, status, created_at, updated_at)
           VALUES (?, ?, 'x', 1, NOW(), NOW())`,
          [firstName, lastName],
        );
  const externalId = result.insertId;

  const token = await issueToken(testApp.infra, kind, externalId);
  const id = await accountIdOf(testApp, kind, externalId);
  const me = await testApp.app.get(AccountsService).getMe(id);
  return {
    kind,
    externalId,
    token,
    id,
    username: me.username,
    name: me.name,
  };
}
