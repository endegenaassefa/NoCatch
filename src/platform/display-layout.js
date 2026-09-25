const { createHash } = require('node:crypto');

// Snapshot values, including primary identity, origin, scale and rotation.
function getDisplayLayout(screen, now = () => new Date().toISOString()) {
  if (!screen || typeof screen.getAllDisplays !== 'function') throw new Error('Display API unavailable');
  const displays = screen.getAllDisplays().map(d => ({
    id: d.id, label: d.label || '', bounds: { ...d.bounds }, size: { ...d.size },
    scaleFactor: d.scaleFactor, rotation: d.rotation, touchSupport: d.touchSupport || 'unknown'
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const primaryDisplayId = displays.length ? screen.getPrimaryDisplay().id : null;
  const layoutRevision = createHash('sha256').update(JSON.stringify({ primaryDisplayId, displays })).digest('hex');
  return { displays, primaryDisplayId, layoutRevision, checkedAt: now() };
}

module.exports = { getDisplayLayout };
