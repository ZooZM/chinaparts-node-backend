import { StorageService } from '../../../common/storage/storage.service';
import { ReelMediaService } from './reel-media.service';

const media = {
  videoKey: 'reels/1/video.mp4',
  thumbnailKey: 'reels/1/thumb.jpg',
};

function setup() {
  const storage = {
    privateBucket: 'priv',
    publicBucket: 'pub',
    copy: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  return {
    storage,
    service: new ReelMediaService(storage as unknown as StorageService),
  };
}

describe('ReelMediaService (research R12)', () => {
  it('publish copies both files private to public, leaving the originals', async () => {
    const { service, storage } = setup();
    await service.publish(media);

    expect(storage.copy).toHaveBeenCalledWith('priv', 'pub', media.videoKey);
    expect(storage.copy).toHaveBeenCalledWith(
      'priv',
      'pub',
      media.thumbnailKey,
    );
    expect(storage.copy).toHaveBeenCalledTimes(2);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('unpublish deletes only the public copies', async () => {
    const { service, storage } = setup();
    await service.unpublish(media);

    expect(storage.delete.mock.calls).toEqual(
      expect.arrayContaining([
        ['pub', media.videoKey],
        ['pub', media.thumbnailKey],
      ]),
    );
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it('deleteAll removes every copy in both buckets', async () => {
    const { service, storage } = setup();
    await service.deleteAll(media);

    expect(storage.delete).toHaveBeenCalledTimes(4);
    for (const bucket of ['pub', 'priv']) {
      expect(storage.delete).toHaveBeenCalledWith(bucket, media.videoKey);
      expect(storage.delete).toHaveBeenCalledWith(bucket, media.thumbnailKey);
    }
  });

  it('lets a missing source object surface, so a retry can happen', async () => {
    const { service, storage } = setup();
    storage.copy.mockRejectedValue(new Error('not found'));
    await expect(service.publish(media)).rejects.toThrow('not found');
  });

  it('is repeatable: calling twice does the same work twice and fails nowhere', async () => {
    const { service } = setup();
    await service.publish(media);
    await service.publish(media);
    await service.unpublish(media);
    await service.unpublish(media);
  });
});
