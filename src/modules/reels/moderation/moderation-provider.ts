/**
 * v3 (FR-062): abstraction over the third-party AI moderation service that
 * screens both the uploaded video and the reel's description text. Swapping
 * providers (e.g. to AWS Rekognition or Google Video Intelligence once CDN
 * media storage lands — research.md R15) means adding one new class here,
 * never touching the worker or the pipeline's publish/reject rules.
 */
export interface ModerationVerdict {
  verdict: 'clean' | 'flagged';
  /** Present only when flagged (FR-064 — either modality can flag). */
  flaggedSource?: 'video' | 'description';
  /** Provider-reported categories (nudity, explicit, ...) for audit. */
  categories?: string[];
  /** Provider request/media id for audit — optional. */
  providerRef?: string;
}

export const MODERATION_PROVIDER = Symbol('MODERATION_PROVIDER');

export interface ModerationProvider {
  /**
   * Analyzes a locally-stored video file and its description. MUST throw
   * (never resolve to a fabricated verdict) on any failure so the caller's
   * fail-closed retry policy (FR-066) takes over.
   */
  analyze(videoPath: string, description: string): Promise<ModerationVerdict>;
}
