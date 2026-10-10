import { Injectable, Logger } from '@nestjs/common';
import type { ViewerContext } from '../../../common/http/viewer-request';
import { StorageService } from '../../../common/storage/storage.service';
import { MediaUrlService } from '../media/media-url.service';
import { PriceConversionService } from '../products/price-conversion.service';
import { ProductLinksService } from '../products/product-links.service';
import type {
  AdminHiddenReelDto,
  AdminHiddenReelRecord,
  CreatorProfileDto,
  ProductCardDto,
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
  private readonly logger = new Logger(ReelPresenter.name);

  constructor(
    private readonly mediaUrls: MediaUrlService,
    private readonly storage: StorageService,
    private readonly productLinks: ProductLinksService,
    private readonly prices: PriceConversionService,
  ) {}

  async present(
    records: ReelRecord[],
    viewer: ViewerContext,
  ): Promise<ReelDto[]> {
    const cards = await this.cardsFor(records, viewer);
    return Promise.all(
      records.map(async (record): Promise<ReelDto> => {
        // `productLinks` and `creatorExternalId` are for building the cards, and go no further.
        const { media, productLinks, creatorExternalId, ...rest } = record;
        void productLinks;
        void creatorExternalId;
        const owner = viewer.user?.userId === record.creator.id;
        return {
          ...rest,
          ...(await this.urls(media, owner)),
          products: cards.get(record.id) ?? [],
        };
      }),
    );
  }

  /**
   * The product cards of a whole page of reels, with one lookup and one conversion however many
   * reels there are (research R11). A reel read never fails because cards could not be built: the
   * page is returned without them (FR-037).
   */
  private async cardsFor(
    records: ReelRecord[],
    viewer: ViewerContext,
  ): Promise<Map<string, ProductCardDto[]>> {
    const byReel = new Map<string, ProductCardDto[]>();
    const requests = records.flatMap((record) =>
      record.productLinks.map((link) => ({
        productId: link.productId,
        sellerExternalId: record.creatorExternalId,
      })),
    );
    if (requests.length === 0) return byReel;

    try {
      const base = await this.productLinks.getCards(requests);
      if (base.size === 0) return byReel;
      const converted = await this.prices.convert(
        [...base.values()],
        viewer.user?.preferredCurrency ?? null,
      );
      const byProduct = new Map(
        converted.map((card) => [card.productId, card]),
      );

      for (const record of records) {
        const cards: ProductCardDto[] = [];
        for (const link of record.productLinks) {
          const card = byProduct.get(link.productId);
          // A product is shown only on the reels of the seller it belongs to (FR-037).
          if (
            card &&
            base.get(link.productId)?.sellerExternalId ===
              record.creatorExternalId
          ) {
            cards.push(card);
          }
        }
        byReel.set(record.id, cards);
      }
    } catch (error) {
      this.logger.warn(`Product cards could not be built: ${String(error)}`);
    }
    return byReel;
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
