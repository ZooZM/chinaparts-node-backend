import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWorkerRole } from '../../common/config/worker-role';
import { StorageService } from '../../common/storage/storage.service';
import { AccountsService } from '../accounts/accounts.service';
import { ChinaPartsAccountsRepository } from '../china-parts/chinaparts-accounts.repository';
import { ReelLifecycleService } from './lifecycle/reel-lifecycle.service';
import { generateThumbnail } from './media/video.util';
import { parseHashtagsAndMentions } from './reels-text.util';
import { REELS_REPOSITORY } from './reels.repository';
import type { ReelsRepository } from './reels.repository';

/**
 * Demo content for development, staging and test environments ONLY (FR-071). It never runs unless
 * `SEED_DEMO_CONTENT=true`, and it refuses to boot at all when `NODE_ENV=production`: a production
 * database must never get demo reels, so this is checked here and again by the Joi schema.
 *
 * Accounts come from China Parts, not from this file: the ids in `SEED_SELLER_EXTERNAL_IDS` and
 * `SEED_CUSTOMER_EXTERNAL_IDS` are provisioned through the normal path, and ids China Parts does
 * not know are skipped. The reels go through the real lifecycle (store privately, publish, make
 * public), so a seeded environment exercises the same code as a real upload.
 *
 * Idempotent: if the first seeded seller already has reels, nothing is added.
 */
const SEED_VIDEO = join(process.cwd(), 'assets', 'seed', 'sample-10s.mp4');

const DESCRIPTIONS = [
  'فلتر زيت أصلي لكامري #فلتر_زيت #كامري_٢٠١٨',
  'Genuine brake pads for Hyundai Elantra #BrakePads #Hyundai',
  'تفاصيل بطارية سيارة جديدة #بطارية #قطع_غيار',
  'Spark plugs: how to check the gap #SparkPlug #DIY',
  'إطارات شتوية بأسعار مميزة #إطارات #عروض',
  'Air filter replacement in two minutes #AirFilter #Maintenance',
  'زيوت المحركات الأكثر مبيعاً #زيت_محرك #Mobil1',
  'Headlight restoration before and after #Headlights #Detailing',
  'ممتص صدمات أمامي لتويوتا #ممتص_صدمات #تويوتا',
  'Radiator hose that fits most sedans #Radiator #Cooling',
  'شاحن بطارية ذكي للسيارات #شاحن #بطارية',
  'Wiper blades that last all winter #Wipers #Visibility',
];

@Injectable()
export class ReelsSeedService implements OnModuleInit {
  private readonly logger = new Logger(ReelsSeedService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly chinaParts: ChinaPartsAccountsRepository,
    private readonly accounts: AccountsService,
    private readonly storage: StorageService,
    private readonly lifecycle: ReelLifecycleService,
    @Inject(REELS_REPOSITORY) private readonly reels: ReelsRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get<boolean>('SEED_DEMO_CONTENT') !== true) return;
    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new Error('SEED_DEMO_CONTENT must never be enabled in production');
    }
    // One process seeds, so an API instance and a worker instance never both do.
    if (!isWorkerRole(this.config)) return;

    try {
      await this.seed();
    } catch (error) {
      // A seed problem (China Parts unreachable, storage down) must not stop the service booting.
      this.logger.error(`Demo seed failed: ${String(error)}`);
    }
  }

  private async seed(): Promise<void> {
    const sellerIds = this.ids('SEED_SELLER_EXTERNAL_IDS');
    const customerIds = this.ids('SEED_CUSTOMER_EXTERNAL_IDS');

    const [sellers, customers] = await Promise.all([
      this.chinaParts.getSellers(sellerIds),
      this.chinaParts.getCustomers(customerIds),
    ]);
    const provisioned = [];
    for (const account of [...sellers, ...customers]) {
      provisioned.push(await this.accounts.resolveOrProvision(account));
    }
    const creator = provisioned.find(
      (account) => account.accountType === 'seller',
    );
    if (!creator) {
      this.logger.warn(
        'No seed seller exists in China Parts, so no reels were seeded',
      );
      return;
    }

    const creatorId = creator._id.toString();
    if (
      (await this.reels.listPublishedByCreator(creatorId, null, 1)).length > 0
    ) {
      this.logger.log('Demo reels already seeded, skipping');
      return;
    }

    // The bundled asset is read-only in the image, so work on a copy in a temp directory.
    const workDir = await mkdtemp(join(tmpdir(), 'reels-seed-'));
    try {
      const video = join(workDir, 'seed.mp4');
      await copyFile(SEED_VIDEO, video);
      const thumbnail = await generateThumbnail(video);
      for (const description of DESCRIPTIONS) {
        await this.seedReel(creatorId, description, video, thumbnail);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
    this.logger.log(
      `Seeded ${DESCRIPTIONS.length} demo reels for seller ${creator.username}`,
    );
  }

  private async seedReel(
    creatorId: string,
    description: string,
    videoPath: string,
    thumbnailPath: string,
  ): Promise<void> {
    const id = new Types.ObjectId().toString();
    const videoKey = `reels/${id}/video.mp4`;
    const thumbnailKey = `reels/${id}/thumb.jpg`;
    const bucket = this.storage.privateBucket;

    await this.storage.putFile(bucket, videoKey, videoPath, 'video/mp4');
    await this.storage.putFile(
      bucket,
      thumbnailKey,
      thumbnailPath,
      'image/jpeg',
    );

    // No mentions are resolved: a seed must never send mention notifications.
    const parsed = await parseHashtagsAndMentions(description, () =>
      Promise.resolve([]),
    );
    await this.reels.createReel({
      id,
      creatorId,
      videoKey,
      thumbnailKey,
      description,
      hashtags: parsed.hashtags,
      hashtagsNormalized: parsed.hashtagsNormalized,
      mentions: [],
    });

    const published = await this.reels.publishPending(id);
    if (published) await this.lifecycle.onPublished(published);
  }

  private ids(key: string): number[] {
    return (this.config.get<string>(key) ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  }
}
