import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type FollowDocument = Follow & Document;

@Schema({
  collection: 'follows',
  timestamps: { createdAt: true, updatedAt: false },
})
export class Follow {
  @Prop({ type: Types.ObjectId, ref: 'ReelsAccount', required: true })
  followerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'ReelsAccount', required: true })
  followeeId: Types.ObjectId;

  createdAt?: Date;
}

export const FollowSchema = SchemaFactory.createForClass(Follow);

// Toggle/dedup integrity (FR-055). `followerId != followeeId` is enforced in
// the service layer (self-follow is a 400, not a schema-level constraint).
FollowSchema.index({ followerId: 1, followeeId: 1 }, { unique: true });
// Follower lookups (followersCount derivation checks / admin tooling).
FollowSchema.index({ followeeId: 1 });
// Foundation for a future "reels from users I follow" feed (FR-055):
// this leg (followerId -> followees) joins with Reel's { creatorId } index.
FollowSchema.index({ followerId: 1, createdAt: -1 });
