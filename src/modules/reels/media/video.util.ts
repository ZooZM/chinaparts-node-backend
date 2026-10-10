import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';

const execFileAsync = promisify(execFile);
export const FFMPEG_BIN = ffmpegInstaller.path;

/**
 * Server-side duration check (FR-026): never trust the client alone.
 *
 * Reads the MP4/MOV `moov` then `mvhd` atom directly, in pure JS without ffmpeg. That is robust
 * for any valid video, including video-only clips (a muted screen recording), which
 * `music-metadata` (an audio-focused library) reports as having no duration and would wrongly
 * reject. `music-metadata` remains the fallback for other containers such as WebM.
 * Returns `undefined` when neither can tell.
 */
export async function readVideoDurationSeconds(
  videoPath: string,
): Promise<number | undefined> {
  const fromAtoms = await readMp4DurationSeconds(videoPath);
  if (fromAtoms !== undefined) return fromAtoms;
  try {
    const metadata = await parseFile(videoPath);
    return metadata.format.duration;
  } catch {
    return undefined;
  }
}

/**
 * An ISO-BMFF (MP4/MOV) file's movie duration, found by walking the top-level boxes to `moov` and
 * then its child `mvhd`. Only small header slices are read, never the whole file. Returns
 * undefined if the file is not ISO-BMFF or has no readable `mvhd`.
 */
async function readMp4DurationSeconds(
  videoPath: string,
): Promise<number | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(videoPath, 'r');
    const file = handle;
    const { size: fileSize } = await file.stat();

    const readBox = async (offset: number, end: number) => {
      if (offset + 8 > end) return null;
      const header = Buffer.alloc(8);
      await file.read(header, 0, 8, offset);
      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerSize = 8;
      if (size === 1) {
        const large = Buffer.alloc(8);
        await file.read(large, 0, 8, offset + 8);
        size = large.readUInt32BE(0) * 2 ** 32 + large.readUInt32BE(4);
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset; // extends to the end of the file
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
          const buffer = Buffer.alloc(32);
          await file.read(buffer, 0, 32, box.payloadOffset);
          const version = buffer.readUInt8(0);
          const timescale =
            version === 1 ? buffer.readUInt32BE(20) : buffer.readUInt32BE(12);
          const duration =
            version === 1
              ? buffer.readUInt32BE(24) * 2 ** 32 + buffer.readUInt32BE(28)
              : buffer.readUInt32BE(16);
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
    await handle?.close();
  }
}

/**
 * A stream-copy remux that moves the MP4 `moov` atom to the front of the file (`+faststart`). A
 * moov-at-end file makes a progressively downloading player fetch the whole file before it can
 * decode, which shows up as stutter on the first playback (FR-023).
 *
 * The apps already re-encode with `+faststart`, so this is defense in depth for any path that
 * skips that. `-c copy` means no re-encode: sub-second and lossless. Best effort: if the remux
 * fails (a container MP4 cannot hold), the original is kept and `remuxed` is false, so the caller
 * stores it under its own type rather than mislabelling it as MP4.
 */
export async function remuxFaststart(
  inputPath: string,
): Promise<{ path: string; remuxed: boolean }> {
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
    return { path: outputPath, remuxed: true };
  } catch {
    await unlink(outputPath).catch(() => undefined);
    return { path: inputPath, remuxed: false };
  }
}

/**
 * A cover image from the video, for uploads that bring none. Takes the frame at 1 second and
 * falls back to the first frame for a clip shorter than that. Returns the path of a temp JPEG.
 */
export async function generateThumbnail(videoPath: string): Promise<string> {
  const output = join(dirname(videoPath), `${randomUUID()}.jpg`);
  for (const seek of ['1', '0']) {
    try {
      await execFileAsync(FFMPEG_BIN, [
        '-ss',
        seek,
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        '-y',
        output,
      ]);
      if ((await stat(output)).size > 0) return output;
    } catch {
      // Try the next seek position.
    }
  }
  await unlink(output).catch(() => undefined);
  throw new Error('Could not generate a thumbnail');
}
