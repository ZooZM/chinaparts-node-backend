import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelGuestViewDocument = ReelGuestView & Document;

// A signed-out view counts once per app installation per reel (FR-024). The installation id is the
// UUID the app generates once per install and sends as `X-Installation-Id`. The unique index is
// what makes insert-if-absent dedup possible: only a real insert increments `viewsCount`.
@Schema({
  collection: 'reel_guest_views',
  timestamps: { createdAt: true, updatedAt: false },
})
export class ReelGuestView {
  @Prop({ type: String, required: true })
  installationId: string;

  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  createdAt?: Date;
}

export const ReelGuestViewSchema = SchemaFactory.createForClass(ReelGuestView);

ReelGuestViewSchema.index({ installationId: 1, videoId: 1 }, { unique: true });
// Cascade delete with the reel.
ReelGuestViewSchema.index({ videoId: 1 });
