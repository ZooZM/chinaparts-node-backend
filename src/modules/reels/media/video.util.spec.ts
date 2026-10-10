import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateThumbnail,
  readVideoDurationSeconds,
  remuxFaststart,
} from './video.util';

const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'media',
);
const SAMPLE_10S = join(FIXTURES, 'sample-10s.mp4');
const SAMPLE_70S = join(FIXTURES, 'sample-70s.mp4');

describe('video utilities', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'video-util-spec-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function copyOf(source: string): Promise<string> {
    const target = join(dir, 'upload.mp4');
    await copyFile(source, target);
    return target;
  }

  describe('readVideoDurationSeconds (FR-026)', () => {
    it('reads the duration of a 10-second MP4', async () => {
      const seconds = await readVideoDurationSeconds(SAMPLE_10S);
      expect(seconds).toBeCloseTo(10, 0);
    });

    it('reads a duration over the limit, so the service can refuse it', async () => {
      const seconds = await readVideoDurationSeconds(SAMPLE_70S);
      expect(seconds).toBeGreaterThan(61);
      expect(seconds).toBeCloseTo(70, 0);
    });

    it('cannot read a file that is not a video', async () => {
      const file = join(dir, 'notes.txt');
      await writeFile(file, 'just some text, definitely not a video');
      expect(await readVideoDurationSeconds(file)).toBeUndefined();
    });

    it('cannot read a missing file', async () => {
      expect(
        await readVideoDurationSeconds(join(dir, 'nope.mp4')),
      ).toBeUndefined();
    });

    it('cannot read a truncated file', async () => {
      const file = join(dir, 'cut.mp4');
      await writeFile(file, (await readFile(SAMPLE_10S)).subarray(0, 12));
      expect(await readVideoDurationSeconds(file)).toBeUndefined();
    });
  });

  describe('remuxFaststart (FR-023)', () => {
    it('produces a playable MP4 of the same length and removes the input', async () => {
      const input = await copyOf(SAMPLE_10S);

      const result = await remuxFaststart(input);

      expect(result.remuxed).toBe(true);
      expect(result.path).not.toBe(input);
      await expect(stat(input)).rejects.toThrow();
      expect(await readVideoDurationSeconds(result.path)).toBeCloseTo(10, 0);
    });

    it('puts the moov atom before the media data, so playback starts early', async () => {
      const input = await copyOf(SAMPLE_10S);
      const { path } = await remuxFaststart(input);

      const bytes = await readFile(path);
      expect(bytes.indexOf('moov')).toBeGreaterThan(-1);
      expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'));
    });

    it('keeps the original, and says so, when the input cannot be remuxed', async () => {
      const input = join(dir, 'broken.mp4');
      await writeFile(input, 'this is not a video at all');

      const result = await remuxFaststart(input);

      expect(result).toEqual({ path: input, remuxed: false });
      expect(await readFile(input, 'utf8')).toBe('this is not a video at all');
    });
  });

  describe('generateThumbnail', () => {
    it('writes a JPEG next to the video', async () => {
      const input = await copyOf(SAMPLE_10S);

      const thumbnail = await generateThumbnail(input);

      expect(thumbnail.endsWith('.jpg')).toBe(true);
      const bytes = await readFile(thumbnail);
      expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8'); // JPEG magic number
      expect(bytes.length).toBeGreaterThan(500);
    });

    it('throws for a file ffmpeg cannot read, leaving nothing behind', async () => {
      const input = join(dir, 'broken.mp4');
      await writeFile(input, 'not a video');
      await expect(generateThumbnail(input)).rejects.toThrow(/thumbnail/);
    });
  });
});
