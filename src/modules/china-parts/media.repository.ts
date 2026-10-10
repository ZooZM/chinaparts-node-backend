import { Injectable } from '@nestjs/common';
import { RowDataPacket } from 'mysql2/promise';
import { ChinaPartsConfig } from './china-parts.config';
import { ChinaPartsDb } from './mysql.provider';

interface MediaRow extends RowDataPacket {
  id: number;
  model_type: string;
  model_id: number;
  uuid: string | null;
  file_name: string;
  disk: string;
  collection_name: string;
  order_column: number | null;
}

/**
 * Images attached to China Parts models (Spatie media-library rows): product photos, shop logos,
 * seller avatars. Shared by the account and product repositories so the URL layout lives in one
 * place (research R7, R11).
 */
@Injectable()
export class ChinaPartsMediaRepository {
  constructor(
    private readonly db: ChinaPartsDb,
    private readonly config: ChinaPartsConfig,
  ) {}

  /**
   * The first image (lowest `order_column`) of each model in a collection, as a public URL.
   * Models without an image, or on a disk whose URL we do not know, are simply absent.
   */
  async firstImageUrls(
    modelTypes: string[],
    collection: string,
    modelIds: number[],
  ): Promise<Map<number, string>> {
    const urls = new Map<number, string>();
    if (modelTypes.length === 0 || modelIds.length === 0) return urls;

    const rows = await this.db.query<MediaRow>(
      'SELECT id, model_type, model_id, uuid, file_name, disk, collection_name, order_column ' +
        'FROM media WHERE model_type IN (?) AND model_id IN (?) AND collection_name = ? ' +
        'ORDER BY order_column, id',
      [modelTypes, modelIds, collection],
    );
    for (const row of rows) {
      const modelId = Number(row.model_id);
      if (urls.has(modelId)) continue;
      const url = this.urlFor(row);
      if (url) urls.set(modelId, url);
    }
    return urls;
  }

  private urlFor(row: MediaRow): string | null {
    const diskUrl = this.config.diskUrls.get(row.disk);
    if (diskUrl === undefined) return null;
    return this.config.mediaUrlTemplate
      .replace('{diskUrl}', diskUrl)
      .replace('{id}', String(row.id))
      .replace('{uuid}', row.uuid ?? '')
      .replace('{collection_name}', row.collection_name)
      .replace('{file_name}', encodeURIComponent(row.file_name));
  }
}
