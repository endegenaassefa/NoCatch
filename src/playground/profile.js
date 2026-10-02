'use strict';
const path = require('node:path');

// Pure validation before any configuration or profile contents are read.
function resolvePlaygroundProfile({ appData, override } = {}) {
  if (typeof appData !== 'string' || !appData) throw new Error('Windows profile directories are unavailable.');
  const paths = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(appData) ? path.win32 : path.posix;
  const dedicated = paths.resolve(appData, 'NoCatch-Ingestion-Playground');
  if (override === undefined || override === '') return dedicated;
  if (typeof override !== 'string' || !paths.isAbsolute(override) || /[\x00-\x1f]/.test(override) || override.split(/[\\/]/).includes('..')) {
    throw new Error('Playground profile must be an absolute dedicated path without traversal or control characters.');
  }
  const resolved = paths.resolve(override);
  const same = paths === path.win32 ? resolved.toLowerCase() === dedicated.toLowerCase() : resolved === dedicated;
  if (!same && !/^NoCatch-Playground-QA-[A-Za-z0-9_-]+$/.test(paths.basename(resolved))) {
    throw new Error('Use the dedicated playground profile or a NoCatch-Playground-QA-* profile.');
  }
  return resolved;
}
module.exports = { resolvePlaygroundProfile };
