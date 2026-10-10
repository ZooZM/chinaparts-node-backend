import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Reel, ReelDocument, ReelStatus } from './schemas/reel.schema';
import { ReelLike, ReelLikeDocument } from './schemas/reel-like.schema';
import { ReelShare, ReelShareDocument } from './schemas/reel-share.schema';
import {
  ReelComment,
  ReelCommentDocument,
} from './schemas/reel-comment.schema';
import { Follow, FollowDocument } from './schemas/follow.schema';
import { parseHashtagsAndMentions } from './reels-text.util';

/**
 * Idempotent demo-content seed for the Reels feature (FR-033, clarified:
 * real database this phase, seeded with demo content). Runs once at boot,
 * guarded by a document-count check so restarts never duplicate data.
 *
 * Public sample video/image URLs only (curl-verified, per the v1 mock seed
 * this replaces — see the note that used to live in mock/reels-seed.ts).
 */
const SAMPLE_VIDEO_URLS = [
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_2MB.mp4',
  'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_2MB.mp4',
  'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_2MB.mp4',
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
];

const CREATORS = [
  { name: 'Lina K', username: 'lina.k', bio: 'Filmmaker. Cairo → Berlin.' },
  { name: 'Omar R', username: 'omar', bio: 'Home cook & content creator.' },
  {
    name: 'Sara M',
    username: 'sara.m',
    bio: 'Travel diaries, one reel at a time.',
  },
  {
    name: 'Yusuf A',
    username: 'yusuf.a',
    bio: 'Car enthusiast. Weekend racer.',
  },
  { name: 'Nour E', username: 'nour.e', bio: 'Music producer & DJ.' },
  { name: 'Karim S', username: 'karim.s', bio: 'Comedy sketches, no script.' },
  { name: 'Dina H', username: 'dina.h', bio: 'Fitness coach, 5am club.' },
  {
    name: 'Tarek B',
    username: 'tarek.b',
    bio: 'Street photography & short films.',
  },
];

const HASHTAG_POOL = [
  'travel',
  'cairo',
  'foodie',
  'cars',
  'music',
  'comedy',
  'fitness',
  'photography',
];

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

@Injectable()
export class ReelsSeedService implements OnModuleInit {
  private readonly logger = new Logger(ReelsSeedService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Reel.name) private readonly reelModel: Model<ReelDocument>,
    @InjectModel(ReelLike.name)
    private readonly likeModel: Model<ReelLikeDocument>,
    @InjectModel(ReelShare.name)
    private readonly shareModel: Model<ReelShareDocument>,
    @InjectModel(ReelComment.name)
    private readonly commentModel: Model<ReelCommentDocument>,
    @InjectModel(Follow.name)
    private readonly followModel: Model<FollowDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.backfillUsernames();
    await this.backfillStatus();

    const existingReels = await this.reelModel.countDocuments().exec();
    if (existingReels > 0) {
      this.logger.log('Reels already seeded — skipping demo content seed');
      return;
    }
    await this.seed();
  }

  /**
   * v3 (FR-061): reels created before the moderation pipeline shipped have
   * no `status` field. They were vetted at seed time (or are pre-existing
   * production content), so they backfill straight to `published` — never
   * silently drop out of every feed/profile/search surface. Idempotent:
   * a no-op on repeat boots once every doc has a status.
   */
  private async backfillStatus(): Promise<void> {
    const result = await this.reelModel
      .updateMany(
        { status: { $exists: false } },
        { $set: { status: ReelStatus.PUBLISHED, publishedAt: new Date() } },
      )
      .exec();
    if (result.modifiedCount > 0) {
      this.logger.log(
        `Backfilled status=published for ${result.modifiedCount} pre-v3 reel(s)`,
      );
    }
  }

  /** Real (non-seeded) users predate `username` — backfill so they can be @mentioned/searched. */
  private async backfillUsernames(): Promise<void> {
    const usernameless = await this.userModel
      .find({ username: { $exists: false } })
      .select('_id name')
      .exec();
    for (const user of usernameless) {
      const base =
        user.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '.')
          .replace(/^\.+|\.+$/g, '') || 'user';
      let candidate = base;
      let suffix = 1;

      while (await this.userModel.exists({ username: candidate })) {
        candidate = `${base}${suffix++}`;
      }
      user.username = candidate;

      await user.save();
    }
    if (usernameless.length > 0) {
      this.logger.log(
        `Backfilled username for ${usernameless.length} existing user(s)`,
      );
    }
  }

  private async seed(): Promise<void> {
    this.logger.log('Seeding Reels demo content into MongoDB...');

    const creators = await Promise.all(
      CREATORS.map(async (c, i) => {
        const existing = await this.userModel
          .findOne({ username: c.username })
          .exec();
        if (existing) return existing;
        return this.userModel.create({
          name: c.name,
          username: c.username,
          phoneNumber: `+100000000${i}`,
          bio: c.bio,
          avatarUrl: `https://picsum.photos/seed/reels-avatar-${i + 1}/200/200`,
          isPhoneVerified: true,
        });
      }),
    );

    const videoCount = 40;
    const reelDocs: ReelDocument[] = [];
    for (let i = 0; i < videoCount; i++) {
      const creator = creators[i % creators.length];
      const mentionTarget = creators[(i + 1) % creators.length];
      const tag1 = HASHTAG_POOL[i % HASHTAG_POOL.length];
      const tag2 = HASHTAG_POOL[(i + 3) % HASHTAG_POOL.length];
      const description = `Reel #${i + 1} moments #${tag1} #${tag2} feat. @${mentionTarget.username}`;

      const { hashtags, mentions } = await parseHashtagsAndMentions(
        description,
        this.userModel,
      );

      const seededAt = daysAgo(videoCount - i);
      const reel = await this.reelModel.create({
        creatorId: creator._id,
        videoUrl: SAMPLE_VIDEO_URLS[i % SAMPLE_VIDEO_URLS.length],
        thumbnailUrl: `https://picsum.photos/seed/reels-thumb-${i + 1}/400/700`,
        description,
        hashtags,
        mentions: mentions.map((m) => ({
          userId: new Types.ObjectId(m.userId),
          username: m.username,
        })),
        // v3 (FR-061): demo catalog is vetted at seed time — enters
        // directly as published, never through the moderation pipeline.
        status: ReelStatus.PUBLISHED,
        publishedAt: seededAt,
        createdAt: seededAt,
      });
      reelDocs.push(reel);
    }

    // Seeded likes/comments/shares/follows so counts aren't all zero —
    // counters kept consistent with the relation rows written (FR-055).
    for (let i = 0; i < reelDocs.length; i++) {
      const reel = reelDocs[i];
      const likerCount = (i % 5) + 1;
      for (let l = 0; l < likerCount; l++) {
        const liker = creators[(i + l + 1) % creators.length];

        await this.likeModel.create({ userId: liker._id, videoId: reel._id });

        await this.userModel
          .updateOne({ _id: reel.creatorId }, { $inc: { totalLikes: 1 } })
          .exec();
      }
      reel.likesCount = likerCount;

      if (i % 3 === 0) {
        const author = creators[(i + 2) % creators.length];

        await this.commentModel.create({
          videoId: reel._id,
          authorId: author._id,
          text: 'This is amazing 🔥',
          createdAt: daysAgo(videoCount - i - 1),
        });
        reel.commentsCount = 1;
      }

      if (i % 4 === 0) {
        const sharer = creators[(i + 3) % creators.length];

        await this.shareModel.create({
          userId: sharer._id,
          videoId: reel._id,
          createdAt: daysAgo(videoCount - i - 1),
        });
        reel.sharesCount = 1;
      }

      reel.viewsCount = (i % 7) * 37;

      await reel.save();
    }

    for (let i = 0; i < creators.length; i++) {
      const follower = creators[i];
      const followee = creators[(i + 1) % creators.length];

      await this.followModel.create({
        followerId: follower._id,
        followeeId: followee._id,
      });

      await this.userModel
        .updateOne({ _id: followee._id }, { $inc: { followersCount: 1 } })
        .exec();

      await this.userModel
        .updateOne({ _id: follower._id }, { $inc: { followingCount: 1 } })
        .exec();
    }

    this.logger.log(
      `Seeded ${creators.length} creators and ${reelDocs.length} reels`,
    );
  }
}
