import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Request,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { basename, dirname, extname, join } from 'path';
import { mkdirSync } from 'fs';
import { unlink, open } from 'fs/promises';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseFile } from 'music-metadata';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const execFileAsync = promisify(execFile);
const FFMPEG_BIN = ffmpegInstaller.path;
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ReelsService } from './reels.service';
import {
  CommentsQueryDto,
  FeedQueryDto,
  FollowingUsersQueryDto,
} from './dto/feed-query.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CreateReelDto } from './dto/create-reel.dto';
import { SearchQueryDto } from './dto/search-query.dto';
import { ReportReelDto } from './dto/report-reel.dto';

const REELS_UPLOAD_DIR = './uploads/reels';
// FR-060: 100 MB Multer cap (higher than the chat/status 20 MB cap — video).
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
// FR-060a: 60s cap + 1s tolerance for container-duration rounding.
const MAX_DURATION_SECONDS = 61;

type UploadFiles = {
  video?: Express.Multer.File[];
  thumbnail?: Express.Multer.File[];
};

@UseGuards(JwtAuthGuard)
@Controller('api/reels')
export class ReelsController {
  private readonly logger = new Logger(ReelsController.name);

  constructor(private readonly reelsService: ReelsService) {}

  // NOTE: static routes (liked/saved/search) MUST stay above the `:id`
  // routes below — NestJS matches in declaration order, and `:id` would
  // otherwise swallow these paths (e.g. GET /api/reels/liked -> getReel('liked')).

  @Get('liked')
  getLiked(@Request() req: any, @Query() query: FeedQueryDto) {
    return this.reelsService.getLiked(req.user.userId, query);
  }

  @Get('saved')
  getSaved(@Request() req: any, @Query() query: FeedQueryDto) {
    return this.reelsService.getSaved(req.user.userId, query);
  }

  // v6: public Reposts profile tab — `?userId=` selects whose reposts (defaults
  // to the caller). Static route, same ordering rule as liked/saved above.
  @Get('reposted')
  getReposted(@Request() req: any, @Query() query: FeedQueryDto) {
    return this.reelsService.getReposted(req.user.userId, query);
  }

  @Get('search')
  searchReels(@Request() req: any, @Query() query: SearchQueryDto) {
    return this.reelsService.searchReels(req.user.userId, query);
  }

  // v4 (FR-075): Following tab — static route, same ordering rule as
  // liked/saved/search above.
  @Get('following')
  getFollowingFeed(@Request() req: any, @Query() query: FeedQueryDto) {
    return this.reelsService.getFollowingFeed(req.user.userId, query);
  }

  // v5 (FR-084): followed-users list for the mention-suggestion overlay —
  // static route, same ordering rule as liked/saved/search/following above.
  @Get('me/following')
  getFollowingUsers(
    @Request() req: any,
    @Query() query: FollowingUsersQueryDto,
  ) {
    return this.reelsService.getFollowingUsers(req.user.userId, query);
  }

  @Get()
  getFeed(@Request() req: any, @Query() query: FeedQueryDto) {
    return this.reelsService.getFeed(req.user.userId, query);
  }

  // v3 (FR-060): upload a new reel — video (required, ≤60s) + optional
  // thumbnail + description. Created as `pending_moderation`; the upload
  // response never waits on the moderation verdict (FR-062).
  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'video', maxCount: 1 },
        { name: 'thumbnail', maxCount: 1 },
      ],
      {
        storage: diskStorage({
          destination: (_req, file, cb) => {
            const sub = file.fieldname === 'thumbnail' ? 'thumbs' : 'videos';
            const dir = `${REELS_UPLOAD_DIR}/${sub}`;
            mkdirSync(dir, { recursive: true });
            cb(null, dir);
          },
          filename: (_req, file, cb) => {
            cb(null, `${randomUUID()}${extname(file.originalname)}`);
          },
        }),
        limits: { fileSize: MAX_VIDEO_BYTES },
        fileFilter: (_req, file, cb) => {
          const allowed =
            file.fieldname === 'thumbnail'
              ? /^image\/(jpeg|png)$/
              : /^video\/(mp4|quicktime|webm)$/;
          if (allowed.test(file.mimetype)) {
            cb(null, true);
          } else {
            cb(
              new BadRequestException(
                `Unsupported file type: ${file.mimetype}`,
              ),
              false,
            );
          }
        },
      },
    ),
  )
  async uploadReel(
    @Request() req: any,
    @Body() dto: CreateReelDto,
    @UploadedFiles() files: UploadFiles,
  ) {
    const videoFile = files.video?.[0];
    const thumbnailFile = files.thumbnail?.[0];
    if (!videoFile) {
      await this.cleanupFiles([thumbnailFile]);
      throw new BadRequestException('A video file is required');
    }

    try {
      await this.assertWithinDurationCap(videoFile.path);
    } catch (err) {
      // FR-060: no partial/phantom reel on any upload failure.
      await this.cleanupFiles([videoFile, thumbnailFile]);
      throw err;
    }

    // Defense-in-depth for playback latency: guarantee the served MP4 has its
    // moov atom at the front (+faststart) even if the client skipped its own
    // normalize pass. Best-effort — falls back to the original file on failure.
    const videoFilename = await this.remuxFaststart(videoFile.path);

    return this.reelsService.createReel({
      creatorId: req.user.userId,
      videoUrl: `/uploads/reels/videos/${videoFilename}`,
      thumbnailUrl: thumbnailFile
        ? `/uploads/reels/thumbs/${thumbnailFile.filename}`
        : '',
      description: dto.description ?? '',
    });
  }

  @Delete(':id')
  deleteReel(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.deleteReel(id, req.user.userId);
  }

  @Get(':id')
  getReel(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.getReel(id, req.user.userId);
  }

  @Post(':id/like')
  toggleLike(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.toggleLike(id, req.user.userId);
  }

  @Get(':id/comments')
  getComments(
    @Request() req: any,
    @Param('id') id: string,
    @Query() query: CommentsQueryDto,
  ) {
    return this.reelsService.getComments(id, req.user.userId, query);
  }

  @Post(':id/comments')
  addComment(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.reelsService.addComment(id, req.user.userId, dto.text);
  }

  @Post(':id/share')
  recordShare(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.recordShare(id, req.user.userId);
  }

  @Post(':id/view')
  recordView(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.recordView(id, req.user.userId);
  }

  @Post(':id/save')
  toggleSave(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.toggleSave(id, req.user.userId);
  }

  // v4 (FR-068/FR-069): report a reel (preset reason or 'other' + custom text).
  @Post(':id/report')
  reportReel(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: ReportReelDto,
  ) {
    return this.reelsService.reportReel(id, req.user.userId, dto);
  }

  // v4 (FR-073): explicit repost/un-repost — not a toggle (separate verbs).
  @Post(':id/repost')
  repostReel(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.repostReel(id, req.user.userId);
  }

  @Delete(':id/repost')
  unrepostReel(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.unrepostReel(id, req.user.userId);
  }

  // v6: everyone who reposted this reel — the reposters bottom sheet.
  @Get(':id/reposters')
  getReposters(
    @Request() req: any,
    @Param('id') id: string,
    @Query() query: FeedQueryDto,
  ) {
    return this.reelsService.getReposters(req.user.userId, id, query);
  }

  /**
   * FR-060a: server-side duration enforcement (never trust the client alone).
   *
   * Reads the MP4/MOV `moov`→`mvhd` atom directly (pure JS, no ffmpeg). This
   * is robust for *any* valid video — critically including video-only clips
   * (e.g. a muted screen recording), which `music-metadata` (an audio-focused
   * library) reports as `duration: undefined`, wrongly rejecting a perfectly
   * good upload. `music-metadata@7.x` remains a fallback for non-MP4 containers
   * (e.g. WebM) and the `.wav` fixtures used by the e2e suite.
   */
  private async assertWithinDurationCap(videoPath: string): Promise<void> {
    let durationSeconds = await this.readMp4DurationSeconds(videoPath);

    if (durationSeconds === undefined) {
      try {
        const meta = await parseFile(videoPath);
        durationSeconds = meta.format.duration;
      } catch {
        // fall through to the undefined check below
      }
    }

    if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) {
      throw new BadRequestException('Could not read the video duration');
    }
    if (durationSeconds > MAX_DURATION_SECONDS) {
      throw new BadRequestException(
        `Video exceeds the ${MAX_DURATION_SECONDS - 1}-second limit`,
      );
    }
  }

  /**
   * Parse an ISO-BMFF (MP4/MOV) file's movie duration by walking top-level
   * boxes to `moov`, then its child `mvhd`. Returns seconds, or `undefined`
   * if the file isn't ISO-BMFF or has no readable `mvhd` (caller falls back).
   * Only small header/atom slices are read — never the whole file.
   */
  private async readMp4DurationSeconds(
    videoPath: string,
  ): Promise<number | undefined> {
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(videoPath, 'r');
      const { size: fileSize } = await fh.stat();

      // Read one box header at `offset`; returns its size/type/payload offset.
      const readBox = async (offset: number, end: number) => {
        if (offset + 8 > end) return null;
        const header = Buffer.alloc(8);
        await fh!.read(header, 0, 8, offset);
        let size = header.readUInt32BE(0);
        const type = header.toString('latin1', 4, 8);
        let headerSize = 8;
        if (size === 1) {
          const large = Buffer.alloc(8);
          await fh!.read(large, 0, 8, offset + 8);
          size = large.readUInt32BE(0) * 2 ** 32 + large.readUInt32BE(4);
          headerSize = 16;
        } else if (size === 0) {
          size = end - offset; // extends to EOF
        }
        if (size < headerSize) return null;
        return { size, type, payloadOffset: offset + headerSize };
      };

      const findMvhd = async (
        start: number,
        end: number,
      ): Promise<number | undefined> => {
        let offset = start;
        while (offset < end) {
          const box = await readBox(offset, end);
          if (!box) break;
          if (box.type === 'mvhd') {
            const buf = Buffer.alloc(32);
            await fh!.read(buf, 0, 32, box.payloadOffset);
            const version = buf.readUInt8(0);
            const timescale =
              version === 1 ? buf.readUInt32BE(20) : buf.readUInt32BE(12);
            const duration =
              version === 1
                ? buf.readUInt32BE(24) * 2 ** 32 + buf.readUInt32BE(28)
                : buf.readUInt32BE(16);
            return timescale > 0 ? duration / timescale : undefined;
          }
          if (box.type === 'moov') {
            const found = await findMvhd(box.payloadOffset, offset + box.size);
            if (found !== undefined) return found;
          }
          offset += box.size;
        }
        return undefined;
      };

      return await findMvhd(0, fileSize);
    } catch {
      return undefined;
    } finally {
      await fh?.close();
    }
  }

  /**
   * Stream-copy remux that relocates the MP4 `moov` atom to the front of the
   * file (`+faststart`). A moov-at-end file forces a progressively-downloading
   * player to fetch the whole file before it can start decoding, which shows
   * up as heavy stutter on the *first* playback that vanishes once cached.
   *
   * The Flutter client already re-encodes with `+faststart`, so this is
   * defense-in-depth for any path that skips that (an older build, a direct
   * API call). `-c copy` means no re-encode — sub-second and lossless. Fully
   * best-effort: on any failure we keep and serve the original file rather
   * than fail the upload. Returns the filename to serve (new or original).
   */
  private async remuxFaststart(inputPath: string): Promise<string> {
    const outputPath = join(dirname(inputPath), `${randomUUID()}.mp4`);
    try {
      await execFileAsync(FFMPEG_BIN, [
        '-i',
        inputPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-y',
        outputPath,
      ]);
      await unlink(inputPath).catch(() => undefined);
      return basename(outputPath);
    } catch (err) {
      this.logger.warn(
        `faststart remux failed for ${inputPath}: ${(err as Error).message} — serving original`,
      );
      await unlink(outputPath).catch(() => undefined);
      return basename(inputPath);
    }
  }

  private async cleanupFiles(
    files: (Express.Multer.File | undefined)[],
  ): Promise<void> {
    for (const file of files) {
      if (!file) continue;
      try {
        await unlink(file.path);
      } catch {
        // Best-effort — a missing file must never block the error response.
      }
    }
  }
}
