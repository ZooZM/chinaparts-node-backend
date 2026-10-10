import { Inject, Injectable } from '@nestjs/common';
import { StandingService } from '../../accounts/standing.service';
import { ReelMediaService } from '../media/reel-media.service';
import { REELS_REPOSITORY } from '../reels.repository';
import type { ReelSnapshot, ReelsRepository } from '../reels.repository';

/**
 * The single place for the side effects of a reel changing status, or of its creator changing
 * standing (data-model.md "Reel status", research R12 and R22). A repository returns the outcome
 * of a guarded update and the caller then calls the matching hook here, so the effects run exactly
 * once and only after the update succeeded.
 *
 * The rule it enforces: a reel's files sit in the public bucket only while the reel is
 * `published` AND its creator is in good standing (FR-009). Every hook re-applies that one rule,
 * so a status change and a standing change cannot disagree about where the files are.
 */
@Injectable()
export class ReelLifecycleService {
  constructor(
    @Inject(REELS_REPOSITORY) private readonly reels: ReelsRepository,
    private readonly media: ReelMediaService,
    private readonly standing: StandingService,
  ) {}

  /** A reel passed screening. */
  async onPublished(reel: ReelSnapshot): Promise<void> {
    await this.syncMediaVisibility(reel);
  }

  /** A published reel was hidden or rejected. */
  async onUnpublished(reel: ReelSnapshot): Promise<void> {
    await this.syncMediaVisibility(reel);
  }

  /** An operator restored a hidden reel. */
  async onRestored(reel: ReelSnapshot): Promise<void> {
    await this.syncMediaVisibility(reel);
  }

  /** The reel was deleted: every copy of its files goes. */
  async onDeleted(reel: ReelSnapshot): Promise<void> {
    await this.media.deleteAll(reel.media);
  }

  /**
   * Puts the reel's files where the rule says and records where they are. The files move first and
   * the record second, so an interruption leaves a state the next run puts right: both steps are
   * idempotent. Standing is read fresh from Redis here, because a stale answer would leave a
   * suspended seller's video public.
   */
  async syncMediaVisibility(reel: ReelSnapshot): Promise<void> {
    const shouldBePublic =
      reel.status === 'published' &&
      !(await this.standing.isExcluded(reel.creatorId));
    const target = shouldBePublic ? 'public' : 'private';
    if (reel.media.location === target) return;

    if (target === 'public') {
      await this.media.publish(reel.media);
    } else {
      await this.media.unpublish(reel.media);
    }
    await this.reels.setMediaLocation(reel.id, target);
  }
}
