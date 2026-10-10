import { Injectable } from '@nestjs/common';
import { basename } from 'path';
import { ModerationProvider, ModerationVerdict } from './moderation-provider';

/**
 * v3 (R15): dev/test moderation provider — no external credentials
 * required. Flags a reel when the stored video path or description
 * contains the marker `nsfw-test` (case-insensitive); everything else is
 * clean. This is the default provider (`MODERATION_PROVIDER=stub`) so the
 * full upload → moderation → publish/reject pipeline is exercisable
 * end-to-end without Sightengine credentials.
 *
 * NOTE: the video-path check only fires when the caller controls the path
 * directly (unit tests). Through the real `POST /api/reels` endpoint,
 * Multer renames every upload to a random UUID on disk (standard anti-
 * collision/path-traversal practice — see `ReelsController`'s
 * `diskStorage.filename`), so the original client-declared filename never
 * reaches this provider. The **description marker is the only reliable
 * trigger** through the real upload flow — see quickstart.md.
 */
const FLAG_MARKER = /nsfw-test/i;

@Injectable()
export class StubModerationProvider implements ModerationProvider {
  analyze(videoPath: string, description: string): Promise<ModerationVerdict> {
    if (FLAG_MARKER.test(basename(videoPath))) {
      return Promise.resolve({
        verdict: 'flagged',
        flaggedSource: 'video',
        categories: ['nsfw-test-marker'],
        providerRef: 'stub',
      });
    }
    if (FLAG_MARKER.test(description)) {
      return Promise.resolve({
        verdict: 'flagged',
        flaggedSource: 'description',
        categories: ['nsfw-test-marker'],
        providerRef: 'stub',
      });
    }
    return Promise.resolve({ verdict: 'clean', providerRef: 'stub' });
  }
}
