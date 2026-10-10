import { normalizeForMatch } from '../../common/text/normalize-for-match';
import type { ChinaPartsAccount } from '../china-parts/chinaparts-accounts.repository';
import type { DisplayUpdate } from './accounts.repository';

/**
 * What a reels account caches from China Parts: the public name (with its normalized form, for
 * search), the picture, the standing and the currency. Used when an account is provisioned or
 * refreshed on a request, and by the sync that keeps them all current.
 */
export function toDisplay(account: ChinaPartsAccount): DisplayUpdate {
  return {
    name: account.name,
    nameNormalized: normalizeForMatch(account.name),
    avatarUrl: account.avatarUrl,
    standing: account.standing,
    preferredCurrency: account.preferredCurrency,
    syncedAt: new Date(),
  };
}
