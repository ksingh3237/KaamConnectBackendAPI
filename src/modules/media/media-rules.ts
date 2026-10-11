import { randomUUID } from 'node:crypto';

export type StorageBucket = 'media' | 'private';

export const MediaPurpose = {
  PROFILE_PHOTO: 'PROFILE_PHOTO',
  JOB_PHOTO: 'JOB_PHOTO',
  JOB_VOICE: 'JOB_VOICE',
  WORK_PROOF: 'WORK_PROOF',
  AADHAAR: 'AADHAAR',
} as const;
export type MediaPurpose = (typeof MediaPurpose)[keyof typeof MediaPurpose];

const MB = 1024 * 1024;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const AUDIO_TYPES = ['audio/mp4', 'audio/aac', 'audio/mpeg'] as const;

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
};

export const CONTENT_TYPE_BY_EXTENSION: Record<string, string> =
  Object.fromEntries(
    Object.entries(EXTENSION_BY_TYPE).map(([type, ext]) => [ext, type]),
  );

interface PurposeRule {
  /** Aadhaar images live in their own private bucket; everything else in the media bucket. */
  bucket: StorageBucket;
  allowedTypes: readonly string[];
  maxBytes: number;
}

/** docs/03-api-spec.md section 2.6: images up to 5 MB, voice notes up to 2 MB. */
export const MEDIA_RULES: Record<MediaPurpose, PurposeRule> = {
  PROFILE_PHOTO: {
    bucket: 'media',
    allowedTypes: IMAGE_TYPES,
    maxBytes: 5 * MB,
  },
  JOB_PHOTO: { bucket: 'media', allowedTypes: IMAGE_TYPES, maxBytes: 5 * MB },
  JOB_VOICE: { bucket: 'media', allowedTypes: AUDIO_TYPES, maxBytes: 2 * MB },
  WORK_PROOF: { bucket: 'media', allowedTypes: IMAGE_TYPES, maxBytes: 5 * MB },
  AADHAAR: { bucket: 'private', allowedTypes: IMAGE_TYPES, maxBytes: 5 * MB },
};

export const UPLOAD_URL_TTL_SEC = 300;
export const READ_URL_TTL_SEC = 600;
export const ADMIN_READ_URL_TTL_SEC = 300;

/** Keys are namespaced by owner and purpose: `u/<userId>/<PURPOSE>/<uuid>.<ext>`. */
export function buildKey(
  userId: string,
  purpose: MediaPurpose,
  contentType: string,
): string {
  return `u/${userId}/${purpose}/${randomUUID()}.${EXTENSION_BY_TYPE[contentType]}`;
}

/** Matches only keys this user generated for this purpose (blocks using someone else's key). */
export function ownedKeyPattern(userId: string, purpose: MediaPurpose): RegExp {
  return new RegExp(
    `^u/${userId}/${purpose}/[0-9a-f-]{36}\\.(jpg|png|webp|m4a|aac|mp3)$`,
  );
}

/** Shape check for any key before it touches the file system or a bucket. */
export const ANY_KEY_PATTERN =
  /^u\/[0-9a-f-]{36}\/[A-Z_]+\/[0-9a-f-]{36}\.(jpg|png|webp|m4a|aac|mp3)$/;
