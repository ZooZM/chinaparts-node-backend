import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3StorageDriver } from './s3.driver';

function client(endpoint: string): S3Client {
  return new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

describe('S3StorageDriver', () => {
  let workDir: string;
  let s3: S3Client;
  let sent: unknown[];
  let respond: (command: unknown) => unknown;
  let driver: S3StorageDriver;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 's3-spec-'));
    s3 = client('http://minio.internal:9000');
    sent = [];
    respond = () => ({});
    jest.spyOn(s3, 'send').mockImplementation(((command: unknown) => {
      sent.push(command);
      return Promise.resolve(respond(command));
    }) as never);
    driver = new S3StorageDriver(s3, client('https://media.reels.example.sa'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  it('uploads with the length, type and cache control', async () => {
    const file = join(workDir, 'v.mp4');
    await writeFile(file, '12345');

    await driver.putFile(
      'reels-public',
      'r/1/video.mp4',
      file,
      'video/mp4',
      'public, max-age=300',
    );

    const command = sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'reels-public',
      Key: 'r/1/video.mp4',
      ContentLength: 5,
      ContentType: 'video/mp4',
      CacheControl: 'public, max-age=300',
    });
  });

  it('copies server-side, replacing metadata so the cache control sticks and the type survives', async () => {
    respond = (command) =>
      command instanceof HeadObjectCommand
        ? { ContentType: 'video/mp4', CacheControl: undefined }
        : {};

    await driver.copy(
      'reels-private',
      'reels-public',
      'r/1/a b.mp4',
      'public, max-age=300',
    );

    const copy = sent.find(
      (c) => c instanceof CopyObjectCommand,
    ) as CopyObjectCommand;
    expect(copy.input).toMatchObject({
      Bucket: 'reels-public',
      Key: 'r/1/a b.mp4',
      CopySource: 'reels-private/r/1/a%20b.mp4',
      MetadataDirective: 'REPLACE',
      ContentType: 'video/mp4',
      CacheControl: 'public, max-age=300',
    });
  });

  it('refuses to copy an object that is not there', async () => {
    respond = () => {
      throw Object.assign(new Error('nope'), { name: 'NotFound' });
    };
    await expect(driver.copy('a', 'b', 'k')).rejects.toThrow(/not found/);
  });

  it('deletes by key', async () => {
    await driver.delete('reels-public', 'r/1/video.mp4');
    const command = sent[0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'reels-public',
      Key: 'r/1/video.mp4',
    });
  });

  describe('head', () => {
    it('returns the stored metadata', async () => {
      respond = () => ({
        ContentType: 'image/jpeg',
        CacheControl: 'max-age=1',
      });
      expect(await driver.head('b', 'k')).toEqual({
        contentType: 'image/jpeg',
        cacheControl: 'max-age=1',
      });
    });

    it.each([
      ['NotFound', { name: 'NotFound' }],
      ['NoSuchKey', { name: 'NoSuchKey' }],
      ['a bare 404', { $metadata: { httpStatusCode: 404 } }],
    ])('returns null for %s', async (_label, props) => {
      respond = () => {
        throw Object.assign(new Error('missing'), props);
      };
      expect(await driver.head('b', 'k')).toBeNull();
    });

    it('rethrows anything else, so an outage is never mistaken for "absent"', async () => {
      respond = () => {
        throw Object.assign(new Error('boom'), { name: 'InternalError' });
      };
      await expect(driver.head('b', 'k')).rejects.toThrow('boom');
    });
  });

  it('downloads to a temp file', async () => {
    respond = (command) =>
      command instanceof GetObjectCommand
        ? { Body: Readable.from([Buffer.from('hello video')]) }
        : {};

    const path = await driver.downloadToTemp('reels-private', 'r/1/video.mp4');

    expect(await readFile(path, 'utf8')).toBe('hello video');
    await rm(path, { force: true });
  });

  it('fails when the object has no readable body', async () => {
    respond = () => ({ Body: undefined });
    await expect(driver.downloadToTemp('b', 'k')).rejects.toThrow(
      /no readable body/,
    );
  });

  it('presigns against the public endpoint, not the internal one', async () => {
    const url = await driver.presignGet('reels-private', 'r/1/video.mp4', 900);

    expect(
      url.startsWith(
        'https://media.reels.example.sa/reels-private/r/1/video.mp4?',
      ),
    ).toBe(true);
    expect(url).toContain('X-Amz-Expires=900');
    expect(url).not.toContain('minio.internal');
  });
});
