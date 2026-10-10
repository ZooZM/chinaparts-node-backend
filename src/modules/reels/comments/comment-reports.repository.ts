import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { isDuplicateKeyError } from '../../../common/mongo/duplicate-key';
import { BaseRepository } from '../../../common/repositories/base.repository';
import {
  ReelCommentReport,
  ReelCommentReportDocument,
} from '../schemas/reel-comment-report.schema';
import type { ReelReportReason } from '../schemas/reel-report.schema';

/** A comment with open reports, as the operator's queue lists it. */
export interface OpenReportGroup {
  commentId: string;
  reelId: string;
  text: string;
  authorId: string;
  openReportsCount: number;
  lastReportedAt: Date;
  /** The most recent reports first, at most `MAX_REPORTS_SHOWN`. */
  reports: Array<{
    reporterId: string;
    reason: string;
    customReason: string | null;
    createdAt: Date;
  }>;
}

const MAX_REPORTS_SHOWN = 20;

interface GroupRow {
  _id: Types.ObjectId;
  reelId: Types.ObjectId;
  text: string;
  authorId: Types.ObjectId;
  openReportsCount: number;
  lastReportedAt: Date;
  reports: Array<{
    reporterId: Types.ObjectId;
    reason: string;
    customReason: string | null;
    createdAt: Date;
  }>;
}

/** Reads and writes comment reports, and nothing else (constitution II). */
@Injectable()
export class CommentReportsRepository extends BaseRepository<ReelCommentReportDocument> {
  constructor(
    @InjectModel(ReelCommentReport.name)
    model: Model<ReelCommentReportDocument>,
  ) {
    super(model);
  }

  async exists(commentId: string, reporterId: string): Promise<boolean> {
    return Boolean(
      await this.model
        .exists({
          commentId: new Types.ObjectId(commentId),
          reporterId: new Types.ObjectId(reporterId),
        })
        .exec(),
    );
  }

  /** `created`, or `duplicate` if this account already reported this comment (including a race). */
  async add(report: {
    commentId: string;
    reelId: string;
    reporterId: string;
    reason: ReelReportReason;
    customReason?: string;
  }): Promise<'created' | 'duplicate'> {
    try {
      await this.model.create({
        commentId: new Types.ObjectId(report.commentId),
        videoId: new Types.ObjectId(report.reelId),
        reporterId: new Types.ObjectId(report.reporterId),
        reason: report.reason,
        customReason: report.customReason ?? null,
        dismissedAt: null,
      });
      return 'created';
    } catch (error) {
      if (isDuplicateKeyError(error)) return 'duplicate';
      throw error;
    }
  }

  /** How many comments this account reported since `since`, for the shared daily limit (FR-055). */
  countRecent(reporterId: string, since: Date): Promise<number> {
    return this.model
      .countDocuments({
        reporterId: new Types.ObjectId(reporterId),
        createdAt: { $gte: since },
      })
      .exec();
  }

  /**
   * Comments with open (undismissed) reports, most recently reported first, keyset paged on
   * `(lastReportedAt, commentId)`. A deleted comment is left out: its reports stay stored with the
   * reel, but there is nothing left to review.
   */
  async listOpenGrouped(params: {
    after?: { lastReportedAt: Date; commentId: string };
    limit: number;
  }): Promise<OpenReportGroup[]> {
    const rows = await this.model
      .aggregate<GroupRow>([
        { $match: { dismissedAt: null } },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $group: {
            _id: '$commentId',
            reelId: { $first: '$videoId' },
            openReportsCount: { $sum: 1 },
            lastReportedAt: { $max: '$createdAt' },
            reports: {
              $push: {
                reporterId: '$reporterId',
                reason: '$reason',
                customReason: '$customReason',
                createdAt: '$createdAt',
              },
            },
          },
        },
        ...(params.after
          ? [
              {
                $match: {
                  $or: [
                    { lastReportedAt: { $lt: params.after.lastReportedAt } },
                    {
                      lastReportedAt: params.after.lastReportedAt,
                      _id: { $lt: new Types.ObjectId(params.after.commentId) },
                    },
                  ],
                },
              },
            ]
          : []),
        { $sort: { lastReportedAt: -1, _id: -1 } },
        // Over-read, because deleted comments are dropped after the join below.
        { $limit: params.limit * 3 + 1 },
        {
          $lookup: {
            from: 'reel_comments',
            localField: '_id',
            foreignField: '_id',
            as: 'comment',
          },
        },
        { $unwind: '$comment' },
        { $match: { 'comment.deletedAt': null } },
        { $limit: params.limit + 1 },
        {
          $project: {
            reelId: 1,
            openReportsCount: 1,
            lastReportedAt: 1,
            text: '$comment.text',
            authorId: '$comment.authorId',
            reports: { $slice: ['$reports', MAX_REPORTS_SHOWN] },
          },
        },
      ])
      .exec();

    return rows.map((row) => ({
      commentId: row._id.toString(),
      reelId: row.reelId.toString(),
      text: row.text,
      authorId: row.authorId.toString(),
      openReportsCount: row.openReportsCount,
      lastReportedAt: row.lastReportedAt,
      reports: row.reports.map((report) => ({
        reporterId: report.reporterId.toString(),
        reason: report.reason,
        customReason: report.customReason,
        createdAt: report.createdAt,
      })),
    }));
  }

  /** Marks the open reports of a comment as dismissed. Returns how many there were. */
  async dismissOpen(commentId: string): Promise<number> {
    const result = await this.model
      .updateMany(
        { commentId: new Types.ObjectId(commentId), dismissedAt: null },
        { $set: { dismissedAt: new Date() } },
      )
      .exec();
    return result.modifiedCount;
  }

  /** Every report of a reel's comments goes with the reel (research R16). */
  async deleteByReel(reelId: string): Promise<void> {
    await this.model.deleteMany({ videoId: new Types.ObjectId(reelId) }).exec();
  }
}
