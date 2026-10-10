import { StubModerationProvider } from './stub.provider';

describe('StubModerationProvider', () => {
  const provider = new StubModerationProvider();

  it('is clean when neither the filename nor the description carries the marker', async () => {
    const result = await provider.analyze('/tmp/uploads/clip-123.mp4', 'a nice sunset');
    expect(result.verdict).toBe('clean');
  });

  it('flags on the filename marker', async () => {
    const result = await provider.analyze('/tmp/uploads/nsfw-test.mp4', 'a nice sunset');
    expect(result.verdict).toBe('flagged');
    expect(result.flaggedSource).toBe('video');
  });

  it('flags on the description marker', async () => {
    const result = await provider.analyze(
      '/tmp/uploads/clip-123.mp4',
      'contains nsfw-test marker',
    );
    expect(result.verdict).toBe('flagged');
    expect(result.flaggedSource).toBe('description');
  });

  it('is case-insensitive', async () => {
    const result = await provider.analyze('/tmp/uploads/NSFW-TEST.mp4', '');
    expect(result.verdict).toBe('flagged');
  });
});
