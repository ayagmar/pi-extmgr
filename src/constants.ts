/**
 * Constants for pi-extmgr
 *
 * All time values are in milliseconds unless otherwise noted.
 */

/** File extension suffix used to disable extensions (e.g., `extension.ts.disabled`) */
export const DISABLED_SUFFIX = ".disabled";

/** Number of items to display per page in paginated views */
export const PAGE_SIZE = 20;

/** Default cache time-to-live: 5 minutes */
export const CACHE_TTL = 5 * 60 * 1000;

/**
 * Timeout values for various operations (in milliseconds)
 *
 * These values balance user experience with reliability.
 * Network operations get shorter timeouts, file operations get longer ones.
 */
export const TIMEOUTS = {
  /** npm registry search timeout */
  npmSearch: 20_000,
  /** npm package metadata lookup timeout */
  npmView: 10_000,
  /** Full package installation timeout (3 minutes) */
  packageInstall: 180_000,
  /** Package update timeout (2 minutes) */
  packageUpdate: 120_000,
  /** Package removal timeout (1 minute) */
  packageRemove: 60_000,
  /** Package listing timeout */
  listPackages: 10_000,
  /** Package metadata fetch timeout */
  fetchPackageInfo: 30_000,
  /** Package extraction timeout */
  extractPackage: 30_000,
  /** Weekly download stats timeout */
  weeklyDownloads: 5_000,
} as const;

export type TimeoutKey = keyof typeof TIMEOUTS;

/**
 * Cache limits and TTL values (in milliseconds or count)
 */
export const CACHE_LIMITS = {
  /** Maximum number of package info entries to cache */
  packageInfoMaxSize: 100,
  /** Metadata cache TTL: 24 hours */
  metadataTTL: 24 * 60 * 60 * 1000,
  /** Search results cache TTL: 15 minutes */
  searchTTL: 15 * 60 * 1000,
  /** Package info cache TTL: 6 hours */
  packageInfoTTL: 6 * 60 * 60 * 1000,
} as const;

export type CacheLimitKey = keyof typeof CACHE_LIMITS;

/**
 * UI Constants
 *
 * These values control the user interface behavior and appearance.
 */
export const UI = {
  /** Maximum height for scrollable lists in terminal rows */
  maxListHeight: 16,
  /** Minimum number of items before enabling search functionality */
  searchThreshold: 8,
  /** Default confirmation dialog timeout: 30 seconds */
  confirmTimeout: 30_000,
  /** Extended confirmation timeout for destructive operations: 1 minute */
  longConfirmTimeout: 60_000,
} as const;

export type UIKey = keyof typeof UI;
