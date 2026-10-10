import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  duplicateKeyFields,
  isDuplicateKeyError,
} from '../../common/mongo/duplicate-key';
import { BaseRepository } from '../../common/repositories/base.repository';
import type {
  AccountType,
  Locale,
  Standing,
} from '../../common/http/viewer-request';
import {
  ReelsAccount,
  ReelsAccountDocument,
  ReelsAccountLean,
} from './schemas/reels-account.schema';

/** What the sync refreshes from China Parts on an existing account. */
export interface DisplayUpdate {
  name: string;
  nameNormalized: string;
  avatarUrl: string | null;
  standing: Standing;
  preferredCurrency: string | null;
  syncedAt: Date;
}

export interface ProvisionData extends DisplayUpdate {
  accountType: AccountType;
  externalId: number;
  username: string;
  usernameNormalized: string;
  locale: Locale;
}

export type ProvisionResult =
  | { status: 'created'; account: ReelsAccountLean }
  | { status: 'duplicate_username' }
  | { status: 'duplicate_external' };

/** The fields the sync compares with China Parts, so it only writes what changed. */
export type SyncRecord = Pick<
  ReelsAccountLean,
  | '_id'
  | 'externalId'
  | 'name'
  | 'avatarUrl'
  | 'standing'
  | 'preferredCurrency'
  | 'missingSince'
>;

const SYNC_FIELDS = [
  'externalId',
  'name',
  'avatarUrl',
  'standing',
  'preferredCurrency',
  'missingSince',
] as const;

function toObjectId(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

function toObjectIds(ids: string[]): Types.ObjectId[] {
  return ids.map(toObjectId).filter((id): id is Types.ObjectId => id !== null);
}

/** Owns every read and write of the `reels_accounts` collection. Reads are lean with projections. */
@Injectable()
export class AccountsRepository extends BaseRepository<ReelsAccountDocument> {
  constructor(
    @InjectModel(ReelsAccount.name) model: Model<ReelsAccountDocument>,
  ) {
    super(model);
  }

  async findByExternal(
    accountType: AccountType,
    externalId: number,
  ): Promise<ReelsAccountLean | null> {
    return this.model
      .findOne({ accountType, externalId })
      .lean<ReelsAccountLean>()
      .exec();
  }

  async findByIdLean(id: string): Promise<ReelsAccountLean | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    return this.model.findById(objectId).lean<ReelsAccountLean>().exec();
  }

  /** Several accounts, with only the fields asked for (constitution VI: never a whole document). */
  async findByIdsLean<K extends keyof ReelsAccount>(
    ids: string[],
    fields: readonly K[],
  ): Promise<Array<Pick<ReelsAccountLean, K | '_id'>>> {
    const objectIds = toObjectIds(ids);
    if (objectIds.length === 0) return [];
    return this.model
      .find({ _id: { $in: objectIds } })
      .select(Object.fromEntries(fields.map((field) => [field, 1])))
      .lean<Array<Pick<ReelsAccountLean, K | '_id'>>>()
      .exec();
  }

  /** Accounts by normalized handle, to resolve the @mentions in a description. */
  async findByUsernamesNormalized(
    normalized: string[],
  ): Promise<Array<Pick<ReelsAccountLean, '_id' | 'username'>>> {
    if (normalized.length === 0) return [];
    return this.model
      .find({ usernameNormalized: { $in: normalized } })
      .select({ username: 1 })
      .lean<Array<Pick<ReelsAccountLean, '_id' | 'username'>>>()
      .exec();
  }

  /**
   * One page of every account of a type, in `externalId` order (the unique index), for the sync.
   * Paging by the last `externalId` seen stays cheap however many accounts there are.
   */
  async listByType(
    accountType: AccountType,
    afterExternalId: number,
    limit: number,
  ): Promise<SyncRecord[]> {
    return this.model
      .find({ accountType, externalId: { $gt: afterExternalId } })
      .sort({ externalId: 1 })
      .limit(limit)
      .select(Object.fromEntries(SYNC_FIELDS.map((field) => [field, 1])))
      .lean<SyncRecord[]>()
      .exec();
  }

  /** Every account not in good standing, for rebuilding the visibility exclusion set. */
  async listExcludedIds(): Promise<string[]> {
    const rows = await this.model
      .find({ standing: { $in: ['suspended', 'deleted'] } })
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return rows.map((row) => row._id.toString());
  }

  async createProvisioned(data: ProvisionData): Promise<ProvisionResult> {
    try {
      await this.model.create(data);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      return duplicateKeyFields(error).includes('usernameNormalized')
        ? { status: 'duplicate_username' }
        : { status: 'duplicate_external' };
    }
    const account = await this.findByExternal(
      data.accountType,
      data.externalId,
    );
    if (!account) throw new Error('Provisioned account vanished');
    return { status: 'created', account };
  }

  /** Writes refreshed display data and clears `missingSince`, because the row was found. */
  async updateDisplay(
    id: string,
    data: DisplayUpdate,
  ): Promise<ReelsAccountLean | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    return this.model
      .findByIdAndUpdate(
        objectId,
        { $set: { ...data, missingSince: null } },
        { new: true },
      )
      .lean<ReelsAccountLean>()
      .exec();
  }

  /** Many display updates in one round trip, for a sync page. */
  async applyDisplayUpdates(
    updates: Array<{ id: string; data: DisplayUpdate }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    await this.model.bulkWrite(
      updates.map(({ id, data }) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(id) },
          update: { $set: { ...data, missingSince: null } },
        },
      })),
      { ordered: false },
    );
  }

  /** Marks (or clears, with null) accounts China Parts did not return in a sync. */
  async setMissingSince(ids: string[], date: Date | null): Promise<void> {
    const objectIds = toObjectIds(ids);
    if (objectIds.length === 0) return;
    await this.model
      .updateMany({ _id: { $in: objectIds } }, { $set: { missingSince: date } })
      .exec();
  }

  async markDeleted(ids: string[]): Promise<void> {
    const objectIds = toObjectIds(ids);
    if (objectIds.length === 0) return;
    await this.model
      .updateMany(
        { _id: { $in: objectIds } },
        { $set: { standing: 'deleted' } },
      )
      .exec();
  }

  async updateLocale(id: string, locale: Locale): Promise<void> {
    const objectId = toObjectId(id);
    if (!objectId) return;
    await this.model.updateOne({ _id: objectId }, { $set: { locale } }).exec();
  }

  /** Returns the updated account, `'username_taken'` on a normalized collision, or null if unknown. */
  async updateProfile(
    id: string,
    data: { username?: string; usernameNormalized?: string; bio?: string },
  ): Promise<ReelsAccountLean | 'username_taken' | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    try {
      return await this.model
        .findByIdAndUpdate(objectId, { $set: data }, { new: true })
        .lean<ReelsAccountLean>()
        .exec();
    } catch (error) {
      if (
        isDuplicateKeyError(error) &&
        duplicateKeyFields(error).includes('usernameNormalized')
      ) {
        return 'username_taken';
      }
      throw error;
    }
  }

  /** The accounts `viewerId` has blocked. */
  async getBlockedIds(viewerId: string): Promise<string[]> {
    const objectId = toObjectId(viewerId);
    if (!objectId) return [];
    const viewer = await this.model
      .findById(objectId)
      .select({ blockedUsers: 1 })
      .lean<{ blockedUsers?: Types.ObjectId[] }>()
      .exec();
    return (viewer?.blockedUsers ?? []).map((id) => id.toString());
  }

  /** The accounts that have blocked `viewerId` (the reverse lookup, on the multikey index). */
  async findBlockerIds(viewerId: string): Promise<string[]> {
    const objectId = toObjectId(viewerId);
    if (!objectId) return [];
    const rows = await this.model
      .find({ blockedUsers: objectId })
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return rows.map((row) => row._id.toString());
  }

  /** Idempotent: `$addToSet`. */
  async addBlock(viewerId: string, targetId: string): Promise<void> {
    const viewer = toObjectId(viewerId);
    const target = toObjectId(targetId);
    if (!viewer || !target) return;
    await this.model
      .updateOne({ _id: viewer }, { $addToSet: { blockedUsers: target } })
      .exec();
  }

  async removeBlock(viewerId: string, targetId: string): Promise<void> {
    const viewer = toObjectId(viewerId);
    const target = toObjectId(targetId);
    if (!viewer || !target) return;
    await this.model
      .updateOne({ _id: viewer }, { $pull: { blockedUsers: target } })
      .exec();
  }

  /** Atomic counter changes, never read-modify-write. Deltas may be negative. */
  async incrementCounters(
    id: string,
    deltas: {
      followersCount?: number;
      followingCount?: number;
      totalLikes?: number;
    },
  ): Promise<void> {
    const objectId = toObjectId(id);
    if (!objectId) return;
    const inc = Object.fromEntries(
      Object.entries(deltas).filter(([, delta]) => delta !== 0),
    );
    if (Object.keys(inc).length === 0) return;
    await this.model.updateOne({ _id: objectId }, { $inc: inc }).exec();
  }
}
