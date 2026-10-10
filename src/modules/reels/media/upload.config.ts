import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { diskStorage } from 'multer';
import { LimitsService } from '../../../common/config/limits';
import { ErrorCode } from '../../../common/errors/error-codes';

/** The upload field names and the media types each accepts (FR-026, FR-027). */
const ALLOWED: Record<string, RegExp> = {
  video: /^video\/(mp4|quicktime|webm)$/,
  thumbnail: /^image\/(jpeg|png)$/,
};

/** The extension is only a hint for ffmpeg; a user-supplied one is kept only if it is harmless. */
function safeExtension(originalName: string): string {
  const extension = extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(extension) ? extension : '';
}

/**
 * Multer options for `POST /api/reels`. Uploads go to a temp directory first, are validated and
 * prepared, and only then stored in object storage (research R12): there is no local `uploads/`
 * directory and no static route. The size limit is configurable (FR-070), so these come from
 * `MulterModule.registerAsync` rather than a decorator argument.
 */
export function createUploadOptions(limits: LimitsService): MulterOptions {
  const directory = join(tmpdir(), 'reels-uploads');
  mkdirSync(directory, { recursive: true });
  return {
    storage: diskStorage({
      destination: directory,
      filename: (_request, file, callback) => {
        callback(null, `${randomUUID()}${safeExtension(file.originalname)}`);
      },
    }),
    limits: { fileSize: limits.maxVideoBytes, files: 2 },
    fileFilter: (_request, file, callback) => {
      const allowed = ALLOWED[file.fieldname];
      if (allowed?.test(file.mimetype)) {
        callback(null, true);
        return;
      }
      callback(
        new BadRequestException({
          error: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
          message: `Unsupported file type: ${file.mimetype}`,
        }),
        false,
      );
    },
  };
}
