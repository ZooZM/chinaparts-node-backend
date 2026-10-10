import { StorageService } from '../../../common/storage/storage.service';
import { MediaUrlService, PRESIGN_TTL_SECONDS } from './media-url.service';

const keys = {
  videoKey: 'reels/1/video.mp4',
  thumbnailKey: 'reels/1/thumb.jpg',
};

function setup() {
  const storage = {
    privateBucket: 'priv',
    publicUrl: jest.fn((key: string) => `https://media.example/${key}`),
    presignGet: jest.fn((bucket: string, key: string, ttl: number) =>
      Promise.resolve(`https://signed.example/${bucket}/${key}?ttl=${ttl}`),
    ),
  };
  return {
    storage,
    service: new MediaUrlService(storage as unknown as StorageService),
  };
}

describe('MediaUrlService (research R12)', () => {
  it('gives everyone the public URLs while the files are public', async () => {
    const { service, storage } = setup();

    for (const privileged of [false, true]) {
      expect(
        await service.urlsFor({ ...keys, location: 'public' }, privileged),
      ).toEqual({
        videoUrl: 'https://media.example/reels/1/video.mp4',
        thumbnailUrl: 'https://media.example/reels/1/thumb.jpg',
      });
    }
    expect(storage.presignGet).not.toHaveBeenCalled();
  });

  it('gives an owner or operator a 15-minute presigned link to private files', async () => {
    const { service, storage } = setup();

    const urls = await service.urlsFor({ ...keys, location: 'private' }, true);

    expect(urls.videoUrl).toBe(
      'https://signed.example/priv/reels/1/video.mp4?ttl=900',
    );
    expect(urls.thumbnailUrl).toBe(
      'https://signed.example/priv/reels/1/thumb.jpg?ttl=900',
    );
    expect(PRESIGN_TTL_SECONDS).toBe(900);
    expect(storage.publicUrl).not.toHaveBeenCalled();
  });

  it('gives anyone else nothing for private files, so a pending or hidden video cannot be fetched', async () => {
    const { service, storage } = setup();

    expect(
      await service.urlsFor({ ...keys, location: 'private' }, false),
    ).toEqual({
      videoUrl: null,
      thumbnailUrl: null,
    });
    expect(storage.presignGet).not.toHaveBeenCalled();
  });
});
