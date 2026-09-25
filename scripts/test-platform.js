const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CaptureService } = require('../src/services/capture.service');
const { createPlatformAdapter } = require('../src/platform');

function fixture(platform = 'win32') {
  const state = { calls: 0, pngCalls: 0, crops: [], permission: 'granted', opened: [] };
  const display = (id, x, scaleFactor) => ({ id, bounds: { x, y: 0, width: 100, height: 80 }, size: { width: 100, height: 80 }, scaleFactor, rotation: 0 });
  state.displays = [display(1, 0, 1), display(2, -100, 2)];
  state.primary = 1;
  state.image = (name, width = 200, height = 160) => ({
    getSize: () => ({ width, height }), isEmpty: () => false,
    crop: area => {
      state.crops.push({ name, ...area });
      if (state.cropFails) throw new Error('native crop error');
      return state.image(`${name}:crop`, area.width, area.height);
    },
    toPNG: () => { state.pngCalls++; return Buffer.from(name); }
  });
  state.sources = [1, 2].map(id => ({ id: `screen:${id}`, display_id: String(id), name: `display-${id}`, thumbnail: state.image(`image-${id}`) }));
  const electron = {
    screen: { getAllDisplays: () => state.displays, getPrimaryDisplay: () => state.displays.find(d => d.id === state.primary) },
    desktopCapturer: { getSources: async options => {
      state.calls++; state.options = options;
      if (state.onCapture) await state.onCapture();
      return state.sources;
    } },
    systemPreferences: {
      getMediaAccessStatus: () => state.permission,
      askForMediaAccess: async kind => { state.requested = kind; state.permission = 'denied'; return false; }
    },
    shell: {
      openPath: async path => { state.opened.push(path); return ''; },
      openExternal: async url => { state.opened.push(url); }
    }
  };
  const adapter = createPlatformAdapter({ electron, platform });
  const service = new CaptureService({ electron, platformAdapter: adapter, logger: { error() {}, logPerformance() {} } });
  return { state, electron, adapter, service };
}

test('matches display identity with equal-size sources and different scaling', async () => {
  const { state, service } = fixture();
  const result = await service.captureAndProcess({ displayId: '2' });
  assert.equal(result.imageBuffer.toString(), 'image-2:crop');
  assert.deepEqual(state.options.thumbnailSize, { width: 200, height: 160 });
  assert.equal(result.metadata.source.displayId, 2);
  assert.equal(state.crops[0].width, 100);
});

test('omitted display uses primary but missing explicit display rejects before capture', async () => {
  const { state, service } = fixture();
  state.primary = 2;
  assert.equal((await service.captureScreenshot()).metadata.displayId, 2);
  await assert.rejects(service.captureAndProcess({ displayId: 99 }), { code: 'DISPLAY_NOT_FOUND' });
  assert.equal(state.calls, 1);
});

test('unmapped or duplicate source identities reject instead of guessing by dimensions', async () => {
  const { state, service } = fixture();
  state.sources.forEach(source => { source.display_id = ''; });
  await assert.rejects(service.captureAndProcess({ displayId: 2 }), { code: 'DISPLAY_SOURCE_UNAVAILABLE' });
  state.sources.forEach(source => { source.display_id = '2'; });
  await assert.rejects(service.captureAndProcess({ displayId: 2 }), { code: 'DISPLAY_SOURCE_UNAVAILABLE' });
  assert.equal(state.pngCalls, 0);
});

test('invalid crop never serializes fullscreen pixels and capture lock recovers', async () => {
  const { state, service } = fixture();
  for (const area of [null, { x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 1 },
    { x: -1, y: 0, width: 10, height: 10 }, { x: 195, y: 0, width: 10, height: 10 }, { x: 0.5, y: 0, width: 10, height: 10 }]) {
    await assert.rejects(service.captureAndProcess({ area }), { code: 'INVALID_CROP' });
    assert.equal(service.isProcessing, false);
  }
  state.cropFails = true;
  await assert.rejects(service.captureAndProcess({ area: { x: 0, y: 0, width: 10, height: 10 } }), { code: 'INVALID_CROP' });
  assert.equal(state.pngCalls, 0);
  state.cropFails = false;
  await service.captureAndProcess();
  assert.equal(state.pngCalls, 1);
});

test('desktop DIP crop handles negative monitor origin and actual thumbnail scale', async () => {
  const { state, service } = fixture();
  await service.captureAndProcess({ displayId: 2, areaCoordinateSpace: 'desktop-dip', area: { x: -90, y: 10, width: 20, height: 20 } });
  assert.deepEqual(state.crops[0], { name: 'image-2', x: 20, y: 20, width: 40, height: 40 });
  await assert.rejects(service.captureAndProcess({ displayId: 2, areaCoordinateSpace: 'desktop-dip', area: { x: -10, y: 10, width: 20, height: 20 } }), { code: 'INVALID_CROP' });
});

test('DIP conversion honors thumbnail size rather than assuming requested resolution', async () => {
  const { state, service } = fixture();
  state.sources[1].thumbnail = state.image('small', 100, 80);
  await service.captureAndProcess({ displayId: 2, areaCoordinateSpace: 'display-dip', area: { x: 10, y: 10, width: 20, height: 20 } });
  assert.deepEqual(state.crops[0], { name: 'small', x: 10, y: 10, width: 20, height: 20 });
});

test('saved layout revision rejects scale, rotation, origin and primary changes', async () => {
  for (const change of [s => { s.displays[1].scaleFactor = 1.5; }, s => { s.displays[1].rotation = 90; }, s => { s.displays[1].bounds.x = 100; }, s => { s.primary = 2; }]) {
    const { state, service } = fixture();
    const { layoutRevision } = service.listDisplays();
    change(state);
    await assert.rejects(service.captureAndProcess({ displayId: 2, layoutRevision }), { code: 'STALE_DISPLAY_LAYOUT' });
    assert.equal(state.calls, 0);
  }
});

test('layout changes while capture is pending reject before image serialization', async () => {
  const { state, service } = fixture();
  state.onCapture = () => { state.displays.pop(); };
  await assert.rejects(service.captureAndProcess({ displayId: 2 }), { code: 'STALE_DISPLAY_LAYOUT' });
  assert.equal(state.pngCalls, 0);
});

test('permission denial prevents capture and does not become healthy', async () => {
  const { state, service, adapter } = fixture('darwin');
  state.permission = 'denied';
  assert.equal(adapter.checkCapability('screen').health, 'untested');
  await assert.rejects(service.captureAndProcess(), { code: 'SCREEN_PERMISSION_DENIED' });
  assert.equal(state.calls, 0);
  assert.equal(adapter.checkCapability('screen').health, 'untested');
  assert.equal(adapter.checkCapability('screen').lastOperationAt, null);
  assert.equal(adapter.checkCapability('screen').recoveryAction, 'open-settings');
});

test('macOS permission request returns denial without claiming microphone health', async () => {
  const { state, adapter } = fixture('darwin');
  state.permission = 'not-determined';
  const result = await adapter.requestCapability('microphone');
  assert.equal(result.permission, 'denied');
  assert.equal(result.health, 'untested');
  assert.equal(state.requested, 'microphone');
  assert.equal(result.recoveryAction, 'open-settings');
});

test('screen permission enumeration is explicit and separate from runtime health', async () => {
  const { state, adapter } = fixture('darwin');
  adapter.checkCapabilities();
  assert.equal(state.calls, 0);
  const result = await adapter.requestCapability('screen');
  assert.equal(result.requested, true);
  assert.equal(result.health, 'untested');
  assert.equal(state.calls, 1);
});

test('Windows screen permission is unknown despite Electron granted; microphone uses real status', async () => {
  const { state, adapter } = fixture();
  assert.equal(adapter.checkCapability('screen').permission, 'unknown');
  assert.equal(adapter.checkCapability('screen').health, 'untested');
  state.permission = 'denied';
  assert.equal(adapter.checkCapability('microphone').permission, 'denied');
  await adapter.requestCapability('microphone');
  assert.deepEqual(state.opened, ['ms-settings:privacy-microphone']);
  await adapter.openSettings('screen');
  assert.equal(state.opened[1], 'ms-settings:privacy-graphicscaptureprogrammatic');
});

test('Linux exposes untested unknown permission and does not silently invoke portals', async () => {
  const { state, adapter } = fixture('linux');
  const result = adapter.checkCapabilities();
  assert.equal(result.screen.availability, 'available');
  assert.equal(result.screen.permission, 'unknown');
  assert.equal(result.screen.health, 'untested');
  assert.equal(state.calls, 0);
  assert.equal((await adapter.openSettings('screen')).opened, false);
});

test('availability is independent of permission and health', () => {
  const adapter = createPlatformAdapter({ platform: 'darwin', electron: { systemPreferences: { getMediaAccessStatus: () => 'granted' } } });
  const status = adapter.checkCapability('screen');
  assert.equal(status.availability, 'unavailable');
  assert.equal(status.permission, 'granted');
  assert.equal(status.health, 'untested');
  assert.ok(status.checkedAt);
});


test('invalid selections retain the last operation, while native capture failures replace it', async () => {
  const { state, service, adapter } = fixture();
  await service.captureAndProcess();
  const before = adapter.checkCapability('screen');
  for (const options of [{ displayId: 999 }, { layoutRevision: 'old' }, { area: { x: 199, y: 0, width: 10, height: 10 } }]) {
    await assert.rejects(service.captureAndProcess(options));
    assert.equal(adapter.checkCapability('screen').health, 'healthy');
    assert.equal(adapter.checkCapability('screen').lastOperationAt, before.lastOperationAt);
  }
  state.onCapture = () => { throw new Error('Native screen capture failed'); };
  await assert.rejects(service.captureAndProcess(), /Native screen capture failed/);
  assert.equal(adapter.checkCapability('screen').health, 'failed');
});
