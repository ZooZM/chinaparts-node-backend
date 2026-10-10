import { StandingService } from '../../accounts/standing.service';
import { ReelMediaService } from '../media/reel-media.service';
import type { ReelSnapshot, ReelsRepository } from '../reels.repository';
import { ReelLifecycleService } from './reel-lifecycle.service';

function snapshot(overrides: Partial<ReelSnapshot> = {}): ReelSnapshot {
  return {
    id: 'r1',
    creatorId: 'creator',
    status: 'published',
    media: { videoKey: 'v', thumbnailKey: 't', location: 'private' },
    hashtagsNormalized: ['a'],
    ...overrides,
  };
}

function setup(excluded = false) {
  const reels = { setMediaLocation: jest.fn().mockResolvedValue(undefined) };
  const media = {
    publish: jest.fn().mockResolvedValue(undefined),
    unpublish: jest.fn().mockResolvedValue(undefined),
    deleteAll: jest.fn().mockResolvedValue(undefined),
  };
  const standing = { isExcluded: jest.fn().mockResolvedValue(excluded) };
  const service = new ReelLifecycleService(
    reels as unknown as ReelsRepository,
    media as unknown as ReelMediaService,
    standing as unknown as StandingService,
  );
  return { service, reels, media, standing };
}

const at = (location: 'private' | 'public') => ({
  media: { videoKey: 'v', thumbnailKey: 't', location },
});

describe('ReelLifecycleService (research R12, R22)', () => {
  describe('the rule: public only while published AND the creator is in good standing (FR-009)', () => {
    it('publishes the files of a published reel whose creator is in good standing', async () => {
      const { service, media, reels } = setup(false);
      await service.syncMediaVisibility(snapshot(at('private')));

      expect(media.publish).toHaveBeenCalledTimes(1);
      expect(reels.setMediaLocation).toHaveBeenCalledWith('r1', 'public');
    });

    it('keeps the files private when the creator is not in good standing', async () => {
      const { service, media, reels } = setup(true);
      await service.syncMediaVisibility(snapshot(at('private')));

      expect(media.publish).not.toHaveBeenCalled();
      expect(reels.setMediaLocation).not.toHaveBeenCalled(); // already private
    });

    it('takes public files private when the creator loses good standing', async () => {
      const { service, media, reels } = setup(true);
      await service.syncMediaVisibility(snapshot(at('public')));

      expect(media.unpublish).toHaveBeenCalledTimes(1);
      expect(reels.setMediaLocation).toHaveBeenCalledWith('r1', 'private');
    });

    it.each(['pending_moderation', 'rejected', 'hidden'] as const)(
      "takes the files of a %s reel private, whatever the creator's standing",
      async (status) => {
        const { service, media, reels } = setup(false);
        await service.syncMediaVisibility(
          snapshot({ status, ...at('public') }),
        );

        expect(media.unpublish).toHaveBeenCalledTimes(1);
        expect(reels.setMediaLocation).toHaveBeenCalledWith('r1', 'private');
      },
    );

    it('does nothing when the files are already where the rule says', async () => {
      const { service, media, reels } = setup(false);
      await service.syncMediaVisibility(snapshot(at('public')));

      expect(media.publish).not.toHaveBeenCalled();
      expect(media.unpublish).not.toHaveBeenCalled();
      expect(reels.setMediaLocation).not.toHaveBeenCalled();
    });

    it('asks Redis directly for standing, not a cached copy', async () => {
      const { service, standing } = setup(false);
      await service.syncMediaVisibility(snapshot());
      expect(standing.isExcluded).toHaveBeenCalledWith('creator');
    });

    it('moves the files before recording where they are, so an interruption is safe to retry', async () => {
      const { service, media, reels } = setup(false);
      const order: string[] = [];
      media.publish.mockImplementation(() => {
        order.push('files');
        return Promise.resolve();
      });
      reels.setMediaLocation.mockImplementation(() => {
        order.push('record');
        return Promise.resolve();
      });

      await service.syncMediaVisibility(snapshot(at('private')));

      expect(order).toEqual(['files', 'record']);
    });

    it('does not record a new location when moving the files failed', async () => {
      const { service, media, reels } = setup(false);
      media.publish.mockRejectedValue(new Error('storage down'));

      await expect(
        service.syncMediaVisibility(snapshot(at('private'))),
      ).rejects.toThrow('storage down');
      expect(reels.setMediaLocation).not.toHaveBeenCalled();
    });
  });

  describe('hooks', () => {
    it('onPublished makes the files public for a creator in good standing', async () => {
      const { service, media } = setup(false);
      await service.onPublished(snapshot(at('private')));
      expect(media.publish).toHaveBeenCalledTimes(1);
    });

    it('onPublished keeps the files private for a suspended creator (screening passed while suspended)', async () => {
      const { service, media } = setup(true);
      await service.onPublished(snapshot(at('private')));
      expect(media.publish).not.toHaveBeenCalled();
    });

    it('onUnpublished removes the public copies of a hidden reel', async () => {
      const { service, media } = setup(false);
      await service.onUnpublished(
        snapshot({ status: 'hidden', ...at('public') }),
      );
      expect(media.unpublish).toHaveBeenCalledTimes(1);
    });

    it('onRestored brings the files back for a creator in good standing', async () => {
      const { service, media } = setup(false);
      await service.onRestored(
        snapshot({ status: 'published', ...at('private') }),
      );
      expect(media.publish).toHaveBeenCalledTimes(1);
    });

    it('onRestored leaves them private while the creator is suspended', async () => {
      const { service, media } = setup(true);
      await service.onRestored(
        snapshot({ status: 'published', ...at('private') }),
      );
      expect(media.publish).not.toHaveBeenCalled();
    });

    it('onDeleted removes every copy, whatever the status', async () => {
      const { service, media } = setup(false);
      const reel = snapshot({ status: 'pending_moderation' });
      await service.onDeleted(reel);
      expect(media.deleteAll).toHaveBeenCalledWith(reel.media);
    });
  });
});
