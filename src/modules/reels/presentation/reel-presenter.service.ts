import { Injectable } from '@nestjs/common';
import type { ViewerContext } from '../../../common/http/viewer-request';
import { StorageService } from '../../../common/storage/storage.service';
import { MediaUrlService } from '../media/media-url.service';
import type {
  AdminHiddenReelDto,
  AdminHiddenReelRecord,
  CreatorProfileDto,
  ProfileRecord,
  ReelDto,
  ReelMediaRecord,
  ReelRecord,
} from '../reels.repository';

/**
 * Turns repository records into response DTOs (research R22): the media keys become URLs for this
 * viewer, once per page. The repository cannot do it, because it never calls a service, and a
 * service cannot do it per item without a query per reel.
 */
@Injectable()
export class ReelPresenter {
  constructor(
    private readonly mediaUrls: MediaUrlService,
    private readonly storage: StorageService,
  ) {}

  async present(
    records: ReelRecord[],
    viewer: ViewerContext,
  ): Promise<ReelDto[]> {
    return Promise.all(
      records.map(async (record): Promise<ReelDto> => {
        const { media, ...rest } = record;
        const owner = viewer.user?.userId === record.creator.id;
        return { ...rest, ...(await this.urls(media, owner)) };
      }),
    );
  }

  async presentOne(
    record: ReelRecord,
    viewer: ViewerContext,
  ): Promise<ReelDto> {
    const [dto] = await this.present([record], viewer);
    return dto;
  }

  async presentProfile(
    record: ProfileRecord,
    viewer: ViewerContext,
  ): Promise<CreatorProfileDto> {
    const owner = viewer.user?.userId === record.user.id;
    const videos = await Promise.all(
      record.videos.map(async (video) => ({
        id: video.id,
        status: video.status,
        thumbnailUrl: (await this.urls(video.media, owner)).thumbnailUrl,
      })),
    );
    return {
      user: record.user,
      stats: record.stats,
      viewer: record.viewer,
      videos,
    };
  }

  /** The operator backlog: operators may preview private media, so they always get links. */
  async presentHidden(
    records: AdminHiddenReelRecord[],
  ): Promise<AdminHiddenReelDto[]> {
    return Promise.all(
      records.map(async (record): Promise<AdminHiddenReelDto> => {
        const { media, ...rest } = record;
        return { ...rest, ...(await this.urls(media, true)) };
      }),
    );
  }

  /**
   * Always a string. For a viewer who may not preview private media, `urlsFor` has nothing, which
   * can only happen in the moment between a reel's status changing and its files being moved. The
   * public address then simply 404s until the copy lands, and it never exposes anything private.
   */
  private async urls(
    media: ReelMediaRecord,
    privileged: boolean,
  ): Promise<{ videoUrl: string; thumbnailUrl: string }> {
    const urls = await this.mediaUrls.urlsFor(media, privileged);
    return {
      videoUrl: urls.videoUrl ?? this.storage.publicUrl(media.videoKey),
      thumbnailUrl:
        urls.thumbnailUrl ?? this.storage.publicUrl(media.thumbnailKey),
    };
  }
}
