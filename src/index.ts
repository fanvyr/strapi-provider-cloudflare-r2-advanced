import type { ReadStream } from 'node:fs';
import { getOr } from 'lodash/fp';
import {
  S3Client,
  S3ClientConfig,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectCommandOutput,
  PutObjectCommandInput,
  ObjectCannedACL
} from '@aws-sdk/client-s3';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

declare namespace StrapiR2 {
  interface File {
    name: string;
    hash: string;
    ext: string;
    mime: string;
    size: number;
    path?: string | null;
    buffer?: Buffer;
    stream?: ReadStream;
    url?: string;
    provider_metadata?: {
      bucket?: string;
      key?: string;
      isPrivate?: boolean;
      [k: string]: any;
    } | null;
    [key: string]: any;
  }

  interface AWSParams {
    Bucket?: string;
    ACL?: ObjectCannedACL | string;
    [k: string]: any;
  }

  /**
   * All S3 client options plus our shared params.
   * (This mirrors Strapi's DefaultOptions type.)
   */
  interface DefaultOptions extends S3ClientConfig {
    // Legacy style:
    accessKeyId?: AwsCredentialIdentity['accessKeyId'];
    secretAccessKey?: AwsCredentialIdentity['secretAccessKey'];

    // Preferred:
    credentials?: AwsCredentialIdentity;

    params?: AWSParams;

    // Our extras:
    buckets?: Record<string, string>;
    publicDomains?: Record<string, string>;
    defaultBucket?: string;
    pool?: boolean;

    signedUrlExpires?: number; // seconds, default 3600

    [k: string]: any;
  }

  // We support both legacy + s3Options, like @strapi/provider-upload-aws-s3
  type InitOptions =
    | (DefaultOptions | { s3Options: DefaultOptions }) & {
      baseUrl?: string;
      rootPath?: string;
      [k: string]: any;
    };
}

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

const trimSlash = (value?: string | null): string =>
  (value || '').replace(/\/+$/, '');

const trimLeadingSlash = (value?: string | null): string =>
  (value || '').replace(/^\/+/, '');

/**
 * Parse bucket from path if it's in the format "bucket:NAME:rest/of/path"
 */
const parseBucketFromPath = (path?: string | null) => {
  if (!path || typeof path !== 'string') return null;
  const bucketMatch = path.match(/^bucket:([^:]+):(.+)$/);
  if (!bucketMatch) return null;

  return {
    bucketKey: bucketMatch[1],
    actualPath: bucketMatch[2]
  };
};

const extractCredentials = (options: StrapiR2.InitOptions): AwsCredentialIdentity | null => {
  // Prefer s3Options.credentials if present
  if ('s3Options' in options && options.s3Options?.credentials) {
    return {
      accessKeyId: options.s3Options.credentials.accessKeyId,
      secretAccessKey: options.s3Options.credentials.secretAccessKey
    };
  }

  // Legacy root-level
  const anyOptions = options as any;
  if (anyOptions.accessKeyId && anyOptions.secretAccessKey) {
    return {
      accessKeyId: anyOptions.accessKeyId,
      secretAccessKey: anyOptions.secretAccessKey
    };
  }

  return null;
};

/**
 * Merge legacy root options + s3Options (same idea as official provider)
 */
const getConfig = (initOptions: StrapiR2.InitOptions): StrapiR2.DefaultOptions => {
  const { s3Options, ...legacyS3Options } = initOptions as any;

  if (Object.keys(legacyS3Options).length > 0 && s3Options) {
    // Same style of warning as Strapi provider
    process.emitWarning(
      "S3 configuration options passed at root level of the provider will be deprecated in a future release. " +
      "Please wrap them inside the 's3Options: {}' property."
    );
  }

  const credentials = extractCredentials(initOptions);
  const config: StrapiR2.DefaultOptions = {
    ...(s3Options || {}),
    ...legacyS3Options,
    ...(credentials ? { credentials } : {})
  };

  // Ensure params exists
  if (!config.params) {
    config.params = {};
  }

  // Default ACL if not set
  config.params.ACL = getOr(ObjectCannedACL.public_read, ['params', 'ACL'], config) as
    | ObjectCannedACL
    | string;

  // Reasonable defaults for our advanced options
  config.buckets = config.buckets || {};
  config.publicDomains = config.publicDomains || {};
  config.defaultBucket = config.defaultBucket || 'public';
  config.signedUrlExpires = config.signedUrlExpires || 3600;

  // Ensure region exists for AWS SDK v3 (Cloudflare R2 ignores region)
  if (!config.region) {
    config.region = "auto";
  }

  return config;
};

/**
 * Resolve the bucket to use for a file.
 */
const getBucketInfo = (
  file: StrapiR2.File,
  config: StrapiR2.DefaultOptions
): { bucketKey: string; bucketName: string } => {
  const buckets = config.buckets || {};

  // 1) Check path for `bucket:KEY:...`
  const pathInfo = parseBucketFromPath(file.path || undefined);
  if (pathInfo && pathInfo.bucketKey && buckets[pathInfo.bucketKey]) {
    return {
      bucketKey: pathInfo.bucketKey,
      bucketName: buckets[pathInfo.bucketKey]
    };
  }

  // 2) Default bucket
  if (config.defaultBucket && buckets[config.defaultBucket]) {
    return {
      bucketKey: config.defaultBucket,
      bucketName: buckets[config.defaultBucket]
    };
  }

  // 3) First available bucket
  const availableBuckets = Object.keys(buckets);
  if (availableBuckets.length > 0) {
    const first = availableBuckets[0];
    return {
      bucketKey: first,
      bucketName: buckets[first]
    };
  }

  throw new Error('[strapi-provider-cloudflare-r2-advanced] No bucket configured.');
};

/**
 * Compute the S3/R2 object key for a file.
 */
const getObjectKey = (file: StrapiR2.File, config: StrapiR2.DefaultOptions): string => {
  const fileName = `${file.hash}${file.ext}`;

  if (config.pool) {
    return fileName;
  }

  const bucketInfoFromPath = parseBucketFromPath(file.path || undefined);
  const actualPath = bucketInfoFromPath ? bucketInfoFromPath.actualPath : file.path;

  const folder = trimLeadingSlash(actualPath || '');
  if (!folder) return fileName;

  return `${folder}/${fileName}`;
};

const assertUrlProtocol = (url: string) => /^\w*:\/\//.test(url);

/**
 * Build the appropriate URL based on bucket type (publicDomain, private/signed, or endpoint).
 */
const buildFileUrl = async (args: {
  s3Client: S3Client;
  config: StrapiR2.DefaultOptions;
  bucketKey: string;
  bucketName: string;
  key: string;
  isPrivate: boolean;
}): Promise<string> => {
  const { s3Client, config, bucketKey, bucketName, key, isPrivate } = args;
  const cleanKey = trimLeadingSlash(key);
  const publicDomains = config.publicDomains || {};
  const endpoint = config.endpoint as string | undefined;

  // Public bucket with configured public domain
  if (!isPrivate && publicDomains[bucketKey]) {
    const publicDomain = trimSlash(publicDomains[bucketKey]);
    return `${publicDomain}/${cleanKey}`;
  }

  // Private bucket → signed URL via v3
  if (isPrivate) {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: cleanKey
    });

    const signedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: config.signedUrlExpires || 3600
    });

    return signedUrl;
  }

  // Fallback: endpoint/bucket/key (works if bucket is public)
  if (!endpoint) {
    throw new Error(
      '[strapi-provider-cloudflare-r2-advanced] Missing `endpoint` in providerOptions.'
    );
  }

  const baseEndpoint = trimSlash(endpoint);
  return `${baseEndpoint}/${bucketName}/${cleanKey}`;
};

// ─────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────

const provider = {
  name: "strapi-provider-cloudflare-r2-advanced",
  displayName: "Cloudflare R2 Advanced",
  init(initOptions: StrapiR2.InitOptions) {
    const { baseUrl, rootPath } = initOptions as any;

    const config = getConfig(initOptions);
    const s3Client = new S3Client(config);

    const filePrefix = rootPath ? `${trimSlash(rootPath)}/` : '';

    const getFileKeyForUpload = (file: StrapiR2.File): string => {
      const key = getObjectKey(file, config);
      return `${filePrefix}${key}`;
    };

    const uploadCore = async (
      file: StrapiR2.File,
      customParams: Partial<PutObjectCommandInput> = {}
    ): Promise<void> => {
      const effectivePath = (file as any)._replaceOriginalFolder || file.path;

      const bucketInfo = getBucketInfo(file, config);

      // Temporarily inject effectivePath for key calculation
      const originalPathBackup = file.path;
      (file as any).path = effectivePath;
      const Key = getFileKeyForUpload(file);
      file.path = originalPathBackup;

      const body =
        file.stream ||
        (file.buffer
          ? Buffer.from(file.buffer as any, 'binary')
          : undefined);

      if (!body) {
        throw new Error(
          '[strapi-provider-cloudflare-r2-advanced] File has neither stream nor buffer.'
        );
      }

      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: bucketInfo.bucketName,
          Key,
          Body: body,
          ACL: config.params?.ACL as ObjectCannedACL | undefined,
          ContentType: file.mime,
          ...customParams
        }
      });

      const uploadResult = await upload.done();

      // Determine privacy (same logic as old plugin: if no publicDomain → treat as private)
      const isPrivateBucket = !config.publicDomains?.[bucketInfo.bucketKey];

      // URL: we mostly ignore uploadResult.Location and use our deterministic rules
      if (baseUrl && !isPrivateBucket) {
        const cleanKey = trimLeadingSlash(Key);
        file.url = `${trimSlash(baseUrl)}/${cleanKey}`;
      } else {
        file.url = await buildFileUrl({
          s3Client,
          config,
          bucketKey: bucketInfo.bucketKey,
          bucketName: bucketInfo.bucketName,
          key: Key,
          isPrivate: isPrivateBucket
        });
      }

      file.provider_metadata = {
        ...(file.provider_metadata || {}),
        bucket: bucketInfo.bucketKey,
        key: Key,
        isPrivate: isPrivateBucket
      };
    };

    return {
      /**
       * Upload file – Strapi v5 will call this for buffer or stream.
       */
      async upload(file: StrapiR2.File, customParams: Partial<PutObjectCommandInput> = {}) {
        // console.log("[R2-ADVANCED] upload() invoked");

        await uploadCore(file, customParams);
      },

      /**
       * Backwards-compatible uploadStream alias.
       */
      async uploadStream(file: StrapiR2.File, customParams: Partial<PutObjectCommandInput> = {}) {
        // console.log("[R2-ADVANCED] uploadStream() invoked");
        await uploadCore(file, customParams);
      },

      /**
       * Delete a file.
       */
      delete(file: StrapiR2.File, customParams: Partial<PutObjectCommandInput> = {}): Promise<DeleteObjectCommandOutput[]> {
        const deletions: Promise<DeleteObjectCommandOutput>[] = [];

        const addDeletion = (meta: any) => {
          if (!meta) return;
          const bucketKey = meta.bucket;
          const key = meta.key;
          if (!bucketKey || !key) return;

          const bucketName = config.buckets?.[bucketKey];
          if (!bucketName) {
            throw new Error(
              `[strapi-provider-cloudflare-r2-advanced] Unknown bucket '${bucketKey}' during delete().`
            );
          }

          const command = new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
            ...customParams,
          });

          deletions.push(s3Client.send(command));
        };

        // Main file
        addDeletion(file.provider_metadata);

        // Format files (thumbnail, small, medium, large, etc.)
        if (file.formats && typeof file.formats === "object") {
          for (const formatKey of Object.keys(file.formats)) {
            const fmt = file.formats[formatKey];
            if (fmt?.provider_metadata) {
              addDeletion(fmt.provider_metadata);
            }
          }
        }

        // Return all delete promises
        return Promise.all(deletions);
      },

      /**
       * Generate a fresh signed URL for private files, using provider_metadata.
       * Same semantics as your current helper.
       */
      async getSignedUrl(file: StrapiR2.File, expiresIn?: number): Promise<string> {
        // console.log("[R2-ADVANCED] getSignedUrl() called");
        const metadata = file.provider_metadata || {};
        const bucketKey = metadata.bucket as string | undefined;
        const key = metadata.key as string | undefined;

        if (!metadata.isPrivate || !bucketKey || !key) {
          // Public files: just return stored URL
          return file.url as string;
        }

        const bucketName = config.buckets?.[bucketKey];
        if (!bucketName) {
          throw new Error(
            `[strapi-provider-cloudflare-r2-advanced] Unknown bucket '${bucketKey}' in provider_metadata.`
          );
        }

        const command = new GetObjectCommand({
          Bucket: bucketName,
          Key: key
        });

        const url = await getSignedUrl(s3Client, command, {
          expiresIn: expiresIn || config.signedUrlExpires || 3600
        });

        return url;
      },

      /**
       * Replace an existing file (Media Library action). DOES NOT WORK - THÄÄNNKS @STRAPI! 
       * Steps:
       * 1) Delete existing file + its formats.
       * 2) Reconstruct original folder path from provider_metadata.key.
       * 3) Upload new file into same folder.
       */
      async replace(file: StrapiR2.File, customParams: Partial<PutObjectCommandInput> = {}) {
        

        // 1. Remove old file(s)
        await this.delete(file, customParams);

        const oldMeta = file.provider_metadata;
        if (!oldMeta || !oldMeta.key) {
          throw new Error("[R2] Cannot replace: provider_metadata.key missing.");
        }

        const oldKey = oldMeta.key;
        const lastSlash = oldKey.lastIndexOf("/");
        const originalFolder = lastSlash >= 0 ? oldKey.slice(0, lastSlash) : "";

        

        // Apply fix — make Strapi-admin replacement consistent
        file.path = `bucket:${oldMeta.bucket}:${originalFolder}`;
        (file as any)._replaceOriginalFolder = originalFolder;


        // console.log("[R2-ADVANCED] Calling uploadCore() for replacement…");
        await uploadCore(file, customParams);
      }
    };
  }
};
export = provider;