import { Injectable } from '@nestjs/common';
import { AccountsService } from '../../accounts/accounts.service';
import { StandingService } from '../../accounts/standing.service';

/**
 * Everyone whose content a viewer must not see: the accounts they blocked, the accounts that
 * blocked them (FR-047), and the accounts not in good standing (FR-009). Every read applies it.
 *
 * The viewer is always removed from it: an owner sees their own reels in every state, including
 * while out of good standing. A signed-out visitor has only the standing set.
 */
@Injectable()
export class ExclusionService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly standing: StandingService,
  ) {}

  async forViewer(viewerId: string): Promise<string[]> {
    const [blocks, outOfStanding] = await Promise.all([
      viewerId ? this.accounts.getBlockSet(viewerId) : Promise.resolve([]),
      this.standing.members(),
    ]);
    const excluded = new Set<string>([...blocks, ...outOfStanding]);
    excluded.delete(viewerId);
    return [...excluded];
  }
}
