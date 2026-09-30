'use strict';

// These limits apply to actual bytes and decoded output, not ZIP declarations.
const LIMITS = Object.freeze({
  maxFiles: 10,
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 250 * 1024 * 1024,
  maxPagesPerFile: 250,
  maxTotalPages: 1000,
  maxTextBytesPerFile: 4 * 1024 * 1024,
  maxTotalTextBytes: 16 * 1024 * 1024,
  maxArchiveEntries: 5000,
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 1000,
  extractionTimeoutMs: 60000,
  draftDurationMs: 30 * 60000,
  sessionDurationMs: 90 * 60000,
  maxSources: 8,
  maxContextChars: 24000,
  maxContextTokens: 6000
});

module.exports = { LIMITS };
