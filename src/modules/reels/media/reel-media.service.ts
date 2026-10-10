import { Injectable } from '@nestjs/common';
import { StorageService } from '../../../common/storage/storage.service';
import type { ReelMediaRecord } from '../reels.repository';

type MediaKeys = Pick<ReelMediaRecord, 'videoKey' | 'thumbnailKey'>;

/**
 * Moves a reel's files between the private and public buckets (research R12). It touches storage
 * only and never the database: `ReelLifecycleService` decides when, and records where they are.
 * Every operation is idempotent, so a retried job or a repeated call is harmless.
 */
@Injectable()
export class ReelMediaService {
  constructor(private readonly storage: StorageService) {}

  /** Copies both files from the private bucket to the public one. The private originals stay. */
  async publish(media: MediaKeys): Promise<void> {
    const from = this.storage.privateBucket;
    const to = this.storage.publicBucket;
    await Promise.all([
      this.storage.copy(from, to, media.videoKey),
      this.storage.copy(from, to, media.thumbnailKey),
    ]);
  }

  /** Removes the public copies, so the links stop working. The private originals stay. */
  async unpublish(media: MediaKeys): Promise<void> {
    const bucket = this.storage.publicBucket;
    await Promise.all([
      this.storage.delete(bucket, media.videoKey),
      this.storage.delete(bucket, media.thumbnailKey),
    ]);
  }

  /** Removes every copy, in both buckets (a deleted reel). */
  async deleteAll(media: MediaKeys): Promise<void> {
    await this.unpublish(media);
    const bucket = this.storage.privateBucket;
    await Promise.all([
      this.storage.delete(bucket, media.videoKey),
      this.storage.delete(bucket, media.thumbnailKey),
    ]);
  }
}
