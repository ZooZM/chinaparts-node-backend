import { StorageService } from '../../../common/storage/storage.service';
import { MediaUrlService } from '../media/media-url.service';
import type {
  AdminHiddenReelRecord,
  ProfileRecord,
  ReelMediaRecord,
  ReelRecord,
} from '../reels.repository';
import { ReelPresenter } from './reel-presenter.service';

const media = (location: 'private' | 'public'): ReelMediaRecord => ({
  videoKey: 'reels/1/video.mp4',
  thumbnailKey: 'reels/1/thumb.jpg',
  location,
});

function record(overrides: Partial<ReelRecord> = {}): ReelRecord {
  return {
    id: 'r1',
    media: media('public'),
    createdAt: '2026-10-10T00:00:00.000Z',
    description: 'd',
    hashtags: [],
    mentions: [],
    creator: {
      id: 'creator',
      name: 'Shop',
      username: 'shop',
      avatarUrl: null,
      accountType: 'seller',
      viewerFollowing: false,
    },
    status: 'published',
    viewsCount: 0,
    likesCount: 0,
    commentsCount: 0,
    sharesCount: 0,
    viewerLiked: false,
    viewerSaved: false,
    repostedBy: null,
    repostersCount: 0,
    topReposters: [],
    viewerReposted: false,
    ...overrides,
  };
}

function setup() {
  const mediaUrls = {
    urlsFor: jest.fn((m: ReelMediaRecord, privileged: boolean) => {
      if (m.location === 'public') {
        return Promise.resolve({
          videoUrl: `https://pub/${m.videoKey}`,
          thumbnailUrl: `https://pub/${m.thumbnailKey}`,
        });
      }
      return Promise.resolve(
        privileged
          ? {
              videoUrl: `https://signed/${m.videoKey}`,
              thumbnailUrl: `https://signed/${m.thumbnailKey}`,
            }
          : { videoUrl: null, thumbnailUrl: null },
      );
    }),
  };
  const storage = { publicUrl: (key: string) => `https://pub/${key}` };
  const presenter = new ReelPresenter(
    mediaUrls as unknown as MediaUrlService,
    storage as unknown as StorageService,
  );
  return { presenter, mediaUrls };
}

const ownerViewer = { user: { userId: 'creator' } as never };
const otherViewer = { user: { userId: 'someone-else' } as never };
const guest = {};

describe('ReelPresenter (research R22)', () => {
  it('replaces the media keys with URLs and keeps everything else', async () => {
    const { presenter } = setup();
    const [dto] = await presenter.present([record()], otherViewer);

    expect(dto.videoUrl).toBe('https://pub/reels/1/video.mp4');
    expect(dto.thumbnailUrl).toBe('https://pub/reels/1/thumb.jpg');
    expect(dto).not.toHaveProperty('media');
    expect(dto).toMatchObject({
      id: 'r1',
      status: 'published',
      creator: { username: 'shop' },
    });
  });

  it('gives the owner a presigned link to a private reel', async () => {
    const { presenter, mediaUrls } = setup();
    const [dto] = await presenter.present(
      [record({ status: 'pending_moderation', media: media('private') })],
      ownerViewer,
    );

    expect(dto.videoUrl).toBe('https://signed/reels/1/video.mp4');
    expect(mediaUrls.urlsFor).toHaveBeenCalledWith(media('private'), true);
  });

  it.each([
    ['another signed-in viewer', otherViewer],
    ['a guest', guest],
  ])('never hands %s a presigned link', async (_label, viewer) => {
    const { presenter, mediaUrls } = setup();
    await presenter.present([record({ media: media('private') })], viewer);
    expect(mediaUrls.urlsFor).toHaveBeenCalledWith(media('private'), false);
  });

  it('falls back to a public address, never a private one, in the moment before files move', async () => {
    const { presenter } = setup();
    const [dto] = await presenter.present(
      [record({ media: media('private') })],
      otherViewer,
    );
    expect(dto.videoUrl).toBe('https://pub/reels/1/video.mp4');
    expect(dto.videoUrl).not.toContain('signed');
  });

  it('presents a whole page, deciding ownership per reel', async () => {
    const { presenter } = setup();
    const mine = record({ id: 'mine', media: media('private') });
    const theirs = record({
      id: 'theirs',
      media: media('private'),
      creator: { ...record().creator, id: 'other-creator' },
    });

    const [a, b] = await presenter.present([mine, theirs], ownerViewer);

    expect(a.videoUrl).toContain('signed');
    expect(b.videoUrl).not.toContain('signed');
  });

  it('presents a single reel', async () => {
    const { presenter } = setup();
    expect((await presenter.presentOne(record(), guest)).id).toBe('r1');
  });

  it('returns an empty page for no records', async () => {
    const { presenter } = setup();
    expect(await presenter.present([], guest)).toEqual([]);
  });

  describe('profiles', () => {
    const profile = (id: string): ProfileRecord => ({
      user: {
        id,
        name: 'Shop',
        username: 'shop',
        avatarUrl: null,
        accountType: 'seller',
        bio: '',
      },
      stats: { followers: 1, following: 2, totalLikes: 3 },
      videos: [
        { id: 'v1', media: media('public'), status: 'published' },
        { id: 'v2', media: media('private'), status: 'pending_moderation' },
      ],
      viewer: { following: false, isSelf: false },
    });

    it('gives the owner links to their private reels in the grid', async () => {
      const { presenter } = setup();
      const dto = await presenter.presentProfile(
        profile('creator'),
        ownerViewer,
      );
      expect(dto.videos).toEqual([
        {
          id: 'v1',
          status: 'published',
          thumbnailUrl: 'https://pub/reels/1/thumb.jpg',
        },
        {
          id: 'v2',
          status: 'pending_moderation',
          thumbnailUrl: 'https://signed/reels/1/thumb.jpg',
        },
      ]);
      expect(dto.stats).toEqual({ followers: 1, following: 2, totalLikes: 3 });
    });

    it('never links a private thumbnail for anyone else', async () => {
      const { presenter } = setup();
      const dto = await presenter.presentProfile(
        profile('creator'),
        otherViewer,
      );
      expect(dto.videos[1].thumbnailUrl).not.toContain('signed');
    });
  });

  describe('operator backlog', () => {
    it('gives operators preview links to hidden reels', async () => {
      const { presenter } = setup();
      const hidden: AdminHiddenReelRecord = {
        id: 'r1',
        creator: { id: 'c', username: 'shop' },
        media: media('private'),
        description: 'd',
        hiddenAt: '2026-10-10T00:00:00.000Z',
        reportsCount: 3,
        reports: [],
      };
      const [dto] = await presenter.presentHidden([hidden]);
      expect(dto.videoUrl).toContain('signed');
      expect(dto).not.toHaveProperty('media');
      expect(dto.reportsCount).toBe(3);
    });
  });
});
