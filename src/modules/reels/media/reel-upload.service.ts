import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { rm } from 'node:fs/promises';
import { LimitsService } from '../../../common/config/limits';
import { ErrorCode } from '../../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../../common/http/viewer-request';
import { QUEUE_REELS_MODERATION } from '../../../common/queues/queue-names';
import { StorageService } from '../../../common/storage/storage.service';
import { AccountsService } from '../../accounts/accounts.service';
import type { CreateReelDto } from '../dto/create-reel.dto';
import {
  MODERATION_JOB,
  MODERATION_JOB_OPTIONS,
} from '../moderation/moderation-job';
import { ReelPresenter } from '../presentation/reel-presenter.service';
import { parseHashtagsAndMentions } from '../reels-text.util';
import { REELS_REPOSITORY } from '../reels.repository';
import type { ReelDto, ReelsRepository } from '../reels.repository';
import {
  generateThumbnail,
  readVideoDurationSeconds,
  remuxFaststart,
} from './video.util';

/** A file Multer has written to disk. */
export interface UploadedFile {
  path: string;
  mimetype: string;
}

export interface ReelUpload {
  video?: UploadedFile;
  thumbnail?: UploadedFile;
}

const VIDEO_TYPES: Record<string, { extension: string }> = {
  'video/mp4': { extension: 'mp4' },
  'video/quicktime': { extension: 'mov' },
  'video/webm': { extension: 'webm' },
};

const IMAGE_TYPES: Record<string, { extension: string }> = {
  'image/jpeg': { extension: 'jpg' },
  'image/png': { extension: 'png' },
};

/** A video may exceed the limit by this much, for container-duration rounding (FR-026). */
const DURATION_TOLERANCE_SECONDS = 1;

interface StoredFile {
  bucket: string;
  key: string;
}

/**
 * Publishing a reel (FR-025 to FR-033). The order is the whole point:
 *
 * 1. Validate the video and prepare the files (duration check, faststart remux, cover image).
 * 2. Store both files in the PRIVATE bucket.
 * 3. Only then create the reel document, as `pending_moderation`.
 * 4. Queue screening. A queue failure never fails the upload: the sweep picks the reel up.
 *
 * So a failure at any step leaves no document and no stored files (FR-033): whatever was already
 * stored is deleted, and every temp file goes whatever happens. The response never waits on
 * screening (FR-029).
 */
@Injectable()
export class ReelUploadService {
  private readonly logger = new Logger(ReelUploadService.name);

  constructor(
    @Inject(REELS_REPOSITORY) private readonly reels: ReelsRepository,
    private readonly storage: StorageService,
    private readonly accounts: AccountsService,
    private readonly limits: LimitsService,
    private readonly presenter: ReelPresenter,
    @InjectQueue(QUEUE_REELS_MODERATION)
    private readonly moderationQueue: Queue,
  ) {}

  async upload(
    user: AuthenticatedUser,
    files: ReelUpload,
    dto: CreateReelDto,
  ): Promise<ReelDto> {
    const tempFiles: string[] = [];
    for (const file of [files.video, files.thumbnail]) {
      if (file) tempFiles.push(file.path);
    }
    const stored: StoredFile[] = [];

    try {
      const reelId = new Types.ObjectId().toString();
      const description = dto.description ?? '';

      if (!files.video) {
        throw new BadRequestException({
          error: ErrorCode.VIDEO_REQUIRED,
          message: 'A video file is required',
        });
      }
      await this.assertWithinDurationLimit(files.video.path);

      const video = await this.prepareVideo(files.video, tempFiles);
      const thumbnail = await this.prepareThumbnail(
        files.thumbnail,
        video.path,
        tempFiles,
      );

      // Parsed after the cheap validation above, because it queries the database.
      const parsed = await parseHashtagsAndMentions(description, (handles) =>
        this.accounts.resolveMentions(handles),
      );

      const videoKey = `reels/${reelId}/video.${video.extension}`;
      const thumbnailKey = `reels/${reelId}/thumb.${thumbnail.extension}`;
      const bucket = this.storage.privateBucket;
      await this.store(stored, bucket, videoKey, video.path, video.contentType);
      await this.store(
        stored,
        bucket,
        thumbnailKey,
        thumbnail.path,
        thumbnail.contentType,
      );

      const record = await this.createDocument(
        stored,
        reelId,
        user,
        description,
        parsed,
        videoKey,
        thumbnailKey,
      );
      await this.enqueueScreening(record.id);
      return await this.presenter.presentOne(record, { user });
    } finally {
      await Promise.all(
        tempFiles.map((path) =>
          rm(path, { force: true }).catch((error: unknown) =>
            this.logger.warn(`Could not remove ${path}: ${String(error)}`),
          ),
        ),
      );
    }
  }

  /** Server-side, whatever the app checked (FR-026). */
  private async assertWithinDurationLimit(videoPath: string): Promise<void> {
    const seconds = await readVideoDurationSeconds(videoPath);
    if (seconds === undefined || !Number.isFinite(seconds)) {
      throw new BadRequestException({
        error: ErrorCode.VIDEO_DURATION_UNREADABLE,
        message: 'Could not read the video duration',
      });
    }
    const max = this.limits.maxDurationSeconds;
    if (seconds > max + DURATION_TOLERANCE_SECONDS) {
      throw new BadRequestException({
        error: ErrorCode.VIDEO_TOO_LONG,
        message: `Video exceeds the ${max}-second limit`,
      });
    }
  }

  private async prepareVideo(
    file: UploadedFile,
    tempFiles: string[],
  ): Promise<{ path: string; extension: string; contentType: string }> {
    const remuxed = await remuxFaststart(file.path);
    tempFiles.push(remuxed.path);
    if (remuxed.remuxed) {
      return { path: remuxed.path, extension: 'mp4', contentType: 'video/mp4' };
    }
    // The remux failed (a container MP4 cannot hold), so the original is stored under its own
    // type rather than mislabelled as MP4.
    const type = VIDEO_TYPES[file.mimetype] ?? VIDEO_TYPES['video/mp4'];
    return {
      path: file.path,
      extension: type.extension,
      contentType: file.mimetype,
    };
  }

  private async prepareThumbnail(
    uploaded: UploadedFile | undefined,
    videoPath: string,
    tempFiles: string[],
  ): Promise<{ path: string; extension: string; contentType: string }> {
    if (uploaded) {
      const type = IMAGE_TYPES[uploaded.mimetype] ?? IMAGE_TYPES['image/jpeg'];
      return {
        path: uploaded.path,
        extension: type.extension,
        contentType: uploaded.mimetype,
      };
    }
    const generated = await generateThumbnail(videoPath);
    tempFiles.push(generated);
    return { path: generated, extension: 'jpg', contentType: 'image/jpeg' };
  }

  private async store(
    stored: StoredFile[],
    bucket: string,
    key: string,
    path: string,
    contentType: string,
  ): Promise<void> {
    // Registered before the attempt: a write that fails halfway may still have left an object,
    // and deleting a key that is not there is harmless.
    stored.push({ bucket, key });
    try {
      await this.storage.putFile(bucket, key, path, contentType);
    } catch (error) {
      await this.removeStored(stored);
      throw error;
    }
  }

  private async createDocument(
    stored: StoredFile[],
    reelId: string,
    user: AuthenticatedUser,
    description: string,
    parsed: Awaited<ReturnType<typeof parseHashtagsAndMentions>>,
    videoKey: string,
    thumbnailKey: string,
  ) {
    try {
      return await this.reels.createReel({
        id: reelId,
        creatorId: user.userId,
        videoKey,
        thumbnailKey,
        description,
        hashtags: parsed.hashtags,
        hashtagsNormalized: parsed.hashtagsNormalized,
        mentions: parsed.mentions,
      });
    } catch (error) {
      // No document, so no files either (FR-033).
      await this.removeStored(stored);
      throw error;
    }
  }

  private async removeStored(stored: StoredFile[]): Promise<void> {
    await Promise.all(
      stored.map(({ bucket, key }) =>
        this.storage
          .delete(bucket, key)
          .catch((error: unknown) =>
            this.logger.warn(
              `Could not remove ${bucket}/${key} after a failed upload: ${String(error)}`,
            ),
          ),
      ),
    );
  }

  /**
   * A queue failure (Redis briefly down) must not fail the upload: the reel stays pending and the
   * worker's sweep picks it up later. Fail-closed, never fail-open (FR-031).
   */
  private async enqueueScreening(reelId: string): Promise<void> {
    try {
      await this.moderationQueue.add(
        MODERATION_JOB,
        { reelId },
        { jobId: reelId, ...MODERATION_JOB_OPTIONS },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue screening for reel ${reelId}: ${String(error)}. The sweep will retry.`,
      );
    }
  }
}
