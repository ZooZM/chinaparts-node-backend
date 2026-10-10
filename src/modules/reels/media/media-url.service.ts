import { Injectable } from '@nestjs/common';
import { StorageService } from '../../../common/storage/storage.service';
import type { ReelMediaRecord } from '../reels.repository';

/** Owners and operators preview non-public media through links that expire after 15 minutes (R12). */
export const PRESIGN_TTL_SECONDS = 900;

export interface MediaUrls {
  videoUrl: string | null;
  thumbnailUrl: string | null;
}

/**
 * Builds the URLs of a reel's files, per response (research R12). A URL depends on where the files
 * are right now and on who is asking:
 * - in the public bucket: the anonymous public URL, for everyone;
 * - otherwise: a presigned link for a privileged viewer (the owner, or an operator), and nothing
 *   at all for anyone else, so a pending, rejected or hidden video can never be fetched.
 */
@Injectable()
export class MediaUrlService {
  constructor(private readonly storage: StorageService) {}

  async urlsFor(
    media: ReelMediaRecord,
    privileged: boolean,
  ): Promise<MediaUrls> {
    if (media.location === 'public') {
      return {
        videoUrl: this.storage.publicUrl(media.videoKey),
        thumbnailUrl: this.storage.publicUrl(media.thumbnailKey),
      };
    }
    if (!privileged) return { videoUrl: null, thumbnailUrl: null };

    const bucket = this.storage.privateBucket;
    const [videoUrl, thumbnailUrl] = await Promise.all([
      this.storage.presignGet(bucket, media.videoKey, PRESIGN_TTL_SECONDS),
      this.storage.presignGet(bucket, media.thumbnailKey, PRESIGN_TTL_SECONDS),
    ]);
    return { videoUrl, thumbnailUrl };
  }
}
