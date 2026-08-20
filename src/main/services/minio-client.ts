import { Client as MinioClient, type BucketItem } from 'minio';
import type { MinioConfig } from '../../types/config';
import type { LauncherManifest, BuildInfo, GameVariant } from '../../types/launcher';
import type { Readable } from 'stream';

let client: MinioClient | null = null;
let activeEndpoint = '';

const KNOWN_VARIANTS: Set<string> = new Set(['Shipping', 'Development', 'Test']);

export function ensureClient(config: MinioConfig): MinioClient {
  if (client && activeEndpoint === config.endpoint) return client;

  const url = new URL(config.endpoint);
  client = new MinioClient({
    endPoint: url.hostname,
    port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 9000),
    useSSL: url.protocol === 'https:',
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
  activeEndpoint = config.endpoint;
  return client;
}

export async function testConnection(config: MinioConfig): Promise<void> {
  const c = ensureClient(config);
  const exists = await c.bucketExists(config.bucket);
  if (!exists) throw new Error(`Bucket "${config.bucket}" does not exist`);
}

export async function getObjectStream(config: MinioConfig, key: string): Promise<Readable> {
  const c = ensureClient(config);
  return c.getObject(config.bucket, key) as unknown as Promise<Readable>;
}

export async function getPartialObjectStream(config: MinioConfig, key: string, offset: number): Promise<Readable> {
  const c = ensureClient(config);
  return c.getPartialObject(config.bucket, key, offset) as unknown as Promise<Readable>;
}

// ---------------------------------------------------------------------------
// Object listing
// ---------------------------------------------------------------------------

function collectStream(stream: NodeJS.ReadableStream): Promise<BucketItem[]> {
  return new Promise((resolve, reject) => {
    const items: BucketItem[] = [];
    stream.on('data', (item: BucketItem) => items.push(item));
    stream.on('end', () => resolve(items));
    stream.on('error', reject);
  });
}

export async function listAllObjects(
  config: MinioConfig,
  prefix: string,
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  const c = ensureClient(config);
  const items = await collectStream(c.listObjects(config.bucket, prefix, true));
  const result: Array<{ key: string; size: number; lastModified: Date }> = [];
  for (const i of items) {
    if (i.name && i.size > 0) {
      result.push({ key: i.name, size: i.size, lastModified: i.lastModified ?? new Date() });
    }
  }
  return result;
}

/**
 * Non-recursive prefix listing: returns only the immediate child "directory"
 * prefixes under the given prefix (i.e. CommonPrefixes from S3).
 * These items contain no ETag, so they never trigger entity expansion limits.
 */
async function listPrefixes(config: MinioConfig, prefix: string): Promise<string[]> {
  const c = ensureClient(config);
  const items = await collectStream(c.listObjects(config.bucket, prefix, false));
  const result: string[] = [];
  for (const item of items) {
    if (item.prefix) result.push(item.prefix);
  }
  return result;
}

/**
 * Grab the first file object from a non-recursive listing to get an
 * approximate lastModified timestamp for a prefix.  Non-recursive listing
 * with just a handful of items stays well under the XML entity limit.
 */
async function probeTimestamp(config: MinioConfig, prefix: string): Promise<Date | null> {
  const c = ensureClient(config);
  return new Promise((resolve) => {
    const stream = c.listObjects(config.bucket, prefix, false);
    const onData = (item: BucketItem) => {
      if (item.name && item.lastModified) {
        stream.removeListener('data', onData);
        stream.destroy();
        resolve(item.lastModified);
      }
    };
    stream.on('data', onData);
    stream.on('end', () => resolve(null));
    stream.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// Build discovery — two-level non-recursive prefix listing
// ---------------------------------------------------------------------------

/** 带并发上限的 map，避免一次性对 MinIO 发起过多请求 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseVersionLabel(label: string): { version: string; buildNumber: string } {
  const m = label.match(/^v?([\d.]+)(?:[-_](CL\w+))?$/);
  if (m) return { version: m[1], buildNumber: m[2] || '' };
  return { version: label, buildNumber: '' };
}

/**
 * Discover builds using two levels of non-recursive prefix listing.
 *
 * Expected layout: {prefix}/{Variant}/{VersionLabel}/...files...
 *
 * Instead of listing every file (which caused Entity expansion limit errors
 * when a build contains 500+ files with &quot; ETags), we only list directory
 * prefixes.  CommonPrefix responses carry no ETag, so the XML entity count
 * stays well below fast-xml-parser's default limit of 1000.
 *
 * Trade-off: BuildInfo.size is always 0 (unknown until download time).
 */
export async function discoverBuilds(
  config: MinioConfig,
  prefix: string,
  exeRelativePath: string,
): Promise<LauncherManifest> {
  const normalizedPrefix = prefix.replace(/\/+$/, '') + '/';

  // Level 1: list variant-level prefixes, e.g. "builds/Shipping/"
  const variantPrefixes = await listPrefixes(config, normalizedPrefix);

  if (variantPrefixes.length === 0) {
    return { game: '', platform: 'Win64', builds: [] };
  }

  const knownVariantPrefixes = variantPrefixes.filter((p) =>
    KNOWN_VARIANTS.has(p.slice(normalizedPrefix.length).replace(/\/$/, '')),
  );

  // Level 2: list version-level prefixes, e.g. "builds/Shipping/v1.0-CL12345/"
  const versionPrefixLists = await Promise.all(
    knownVariantPrefixes.map((variantPrefix) => listPrefixes(config, variantPrefix)),
  );

  const candidates: Array<{ variantName: GameVariant; versionPrefix: string; versionLabel: string }> = [];
  knownVariantPrefixes.forEach((variantPrefix, i) => {
    const variantName = variantPrefix.slice(normalizedPrefix.length).replace(/\/$/, '') as GameVariant;
    for (const versionPrefix of versionPrefixLists[i]) {
      const versionLabel = versionPrefix.slice(variantPrefix.length).replace(/\/$/, '');
      if (!versionLabel) continue;
      candidates.push({ variantName, versionPrefix, versionLabel });
    }
  });

  // Probe a single file per version to get an approximate build timestamp.
  // 串行探测在版本数多时会累积成数秒的等待，这里做有上限的并发。
  const timestamps = await mapWithConcurrency(candidates, 8, (c) =>
    probeTimestamp(config, c.versionPrefix),
  );

  const builds: BuildInfo[] = candidates.map((c, i) => {
    const { version, buildNumber } = parseVersionLabel(c.versionLabel);
    return {
      version,
      buildNumber,
      variant: c.variantName,
      objectKey: c.versionPrefix,
      size: 0,
      timestamp: timestamps[i] ? timestamps[i]!.toISOString() : new Date(0).toISOString(),
      exeRelativePath,
      isDirectory: true,
    };
  });

  return { game: '', platform: 'Win64', builds };
}

/**
 * Try fetching a manifest.json from S3; returns null if not found.
 */
export async function fetchManifest(
  config: MinioConfig,
  prefix: string,
): Promise<LauncherManifest | null> {
  try {
    const c = ensureClient(config);
    const key = prefix.replace(/\/+$/, '') + '/launcher-manifest.json';
    const stream = await c.getObject(config.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Primary entry point: try manifest first, then fall back to discovery.
 */
export async function getBuilds(
  config: MinioConfig,
  prefix: string,
  exeRelativePath: string,
): Promise<LauncherManifest> {
  const manifest = await fetchManifest(config, prefix);
  if (manifest && manifest.builds?.length > 0) return manifest;
  return discoverBuilds(config, prefix, exeRelativePath);
}
