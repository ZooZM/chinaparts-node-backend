import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { createReadStream } from 'fs';
import FormData from 'form-data';
import {
  ModerationProvider,
  ModerationVerdict,
} from './moderation-provider';

/**
 * v3 (FR-062, R15): calls Sightengine's video and text moderation APIs
 * directly against the locally-stored upload — no cloud-bucket
 * prerequisite (the deciding factor over AWS Rekognition/Google Video
 * Intelligence, both of which require the file in their own cloud storage
 * first; see research.md R15). Nudity/explicit/sexual-content models are
 * used as the flag boundary (the spec's "default categories" assumption).
 *
 * Throws on any HTTP/credential failure — the caller (the moderation
 * worker) treats a throw as "verdict unknown", retries, and never
 * publishes without an explicit clean response (FR-066, fail-closed).
 */
const VIDEO_MODELS = 'nudity-2.1,offensive-2.0';
const TEXT_MODELS = 'nudity_sexual_content';
const FLAG_THRESHOLD = 0.5;

@Injectable()
export class SightengineModerationProvider implements ModerationProvider {
  private readonly logger = new Logger(SightengineModerationProvider.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async analyze(
    videoPath: string,
    description: string,
  ): Promise<ModerationVerdict> {
    const apiUser = this.configService.get<string>('SIGHTENGINE_API_USER');
    const apiSecret = this.configService.get<string>(
      'SIGHTENGINE_API_SECRET',
    );
    if (!apiUser || !apiSecret) {
      throw new Error(
        'SIGHTENGINE_API_USER/SIGHTENGINE_API_SECRET are not configured',
      );
    }

    const videoFlagged = await this.checkVideo(videoPath, apiUser, apiSecret);
    if (videoFlagged) {
      this.logger.log(`Video flagged by Sightengine: ${videoFlagged.join(', ')}`);
      return {
        verdict: 'flagged',
        flaggedSource: 'video',
        categories: videoFlagged,
        providerRef: 'sightengine-video',
      };
    }

    if (description.trim().length > 0) {
      const textFlagged = await this.checkText(
        description,
        apiUser,
        apiSecret,
      );
      if (textFlagged) {
        this.logger.log(`Description flagged by Sightengine: ${textFlagged.join(', ')}`);
        return {
          verdict: 'flagged',
          flaggedSource: 'description',
          categories: textFlagged,
          providerRef: 'sightengine-text',
        };
      }
    }

    return { verdict: 'clean', providerRef: 'sightengine' };
  }

  private async checkVideo(
    videoPath: string,
    apiUser: string,
    apiSecret: string,
  ): Promise<string[] | null> {
    const form = new FormData();
    form.append('media', createReadStream(videoPath));
    form.append('models', VIDEO_MODELS);
    form.append('api_user', apiUser);
    form.append('api_secret', apiSecret);

    const response = await firstValueFrom(
      this.httpService.post<SightengineVideoResponse>(
        'https://api.sightengine.com/1.0/video/check-sync.json',
        form,
        { headers: form.getHeaders() },
      ),
    );

    const flagged = new Set<string>();
    for (const frame of response.data.data?.frames ?? []) {
      if ((frame.nudity?.sexual_activity ?? 0) >= FLAG_THRESHOLD) {
        flagged.add('nudity');
      }
      if ((frame.offensive?.prob ?? 0) >= FLAG_THRESHOLD) {
        flagged.add('offensive');
      }
    }
    return flagged.size > 0 ? [...flagged] : null;
  }

  private async checkText(
    description: string,
    apiUser: string,
    apiSecret: string,
  ): Promise<string[] | null> {
    const response = await firstValueFrom(
      this.httpService.get<SightengineTextResponse>(
        'https://api.sightengine.com/1.0/text/check.json',
        {
          params: {
            text: description,
            mode: 'standard',
            models: TEXT_MODELS,
            api_user: apiUser,
            api_secret: apiSecret,
          },
        },
      ),
    );
    const matches = response.data.nudity?.matches ?? [];
    return matches.length > 0 ? ['nudity_sexual_content'] : null;
  }
}

interface SightengineVideoResponse {
  data?: {
    frames?: {
      nudity?: { sexual_activity?: number };
      offensive?: { prob?: number };
    }[];
  };
}

interface SightengineTextResponse {
  nudity?: { matches?: unknown[] };
}
