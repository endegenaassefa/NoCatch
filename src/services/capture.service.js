const { createPlatformAdapter } = require('../platform');

function captureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class CaptureService {
  constructor({ electron, platformAdapter, logger } = {}) {
    // Lazy dependencies keep the class importable in plain Node unit tests.
    this._electron = electron;
    this._platformAdapter = platformAdapter;
    this._logger = logger;
    this.isProcessing = false;
  }
  get electron() { return this._electron || (this._electron = require('electron')); }
  get platformAdapter() {
    return this._platformAdapter || (this._platformAdapter = createPlatformAdapter({ electron: this.electron }));
  }
  get logger() { return this._logger || (this._logger = require('../core/logger').createServiceLogger('CAPTURE')); }

  listDisplays() {
    try {
      return { success: true, ...this.platformAdapter.getDisplayLayout() };
    } catch (error) {
      this.logger.error('Failed to list displays', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * area defaults to image pixels for existing callers. Optional
   * areaCoordinateSpace: 'image-pixels' | 'display-dip' | 'desktop-dip'.
   * Pass listDisplays().layoutRevision with a saved selection to reject changes.
   * Omitted area preserves the existing left-half default.
   */
  async captureAndProcess(options = {}) {
    this._validateOptions(options);
    if (this.isProcessing) throw captureError('CAPTURE_BUSY', 'Capture already in progress');
    this.isProcessing = true;
    const startTime = Date.now();
    try {
      const { image, metadata } = await this.captureScreenshot(options);
      const size = image.getSize();
      const area = Object.hasOwn(options, 'area')
        ? this._cropArea(options.area, options.areaCoordinateSpace || 'image-pixels', metadata.displayBounds, size)
        : { x: 0, y: 0, width: Math.max(1, Math.floor(size.width / 2)), height: size.height };
      // Never return uncropped pixels after a crop failure.
      let finalImage;
      try { finalImage = image.crop(area); }
      catch (error) { throw captureError('INVALID_CROP', `Unable to crop the selected area: ${error.message}`); }
      const croppedSize = finalImage?.getSize();
      if (!finalImage || finalImage.isEmpty?.() || croppedSize.width !== area.width || croppedSize.height !== area.height) {
        throw captureError('INVALID_CROP', 'Capture did not produce the requested crop');
      }
      this._assertLayout(metadata.layoutRevision);
      const buffer = finalImage.toPNG();
      if (!buffer?.length) throw captureError('EMPTY_CAPTURE', 'Capture produced no image data');
      this.platformAdapter.reportOperation('screen', { success: true });
      this.logger.logPerformance('Screenshot capture', startTime, { bytes: buffer.length, dimensions: croppedSize });
      return {
        imageBuffer: buffer, mimeType: 'image/png',
        metadata: {
          timestamp: new Date().toISOString(), source: metadata, crop: area,
          areaCoordinateSpace: 'image-pixels', processingTime: Date.now() - startTime
        }
      };
    } catch (error) {
      // Selection/permission validation is not a failed screen-capture operation.
      const validation = ['INVALID_OPTIONS', 'INVALID_DISPLAY', 'INVALID_CROP', 'DISPLAY_NOT_FOUND',
        'STALE_DISPLAY_LAYOUT', 'SCREEN_PERMISSION_DENIED', 'CAPTURE_UNAVAILABLE'];
      if (!validation.includes(error.code)) this.platformAdapter.reportOperation('screen', { success: false, reason: error.message });
      throw error;
    } finally { this.isProcessing = false; }
  }

  async captureScreenshot(options = {}) {
    this._validateOptions(options);
    const layout = this.platformAdapter.getDisplayLayout();
    if (options.layoutRevision != null && options.layoutRevision !== layout.layoutRevision) {
      throw captureError('STALE_DISPLAY_LAYOUT', 'Display layout changed; select the capture area again');
    }
    const targetDisplay = this._getTargetDisplay(options.displayId, layout);
    const capability = this.platformAdapter.checkCapability('screen');
    if (['denied', 'restricted'].includes(capability.permission)) {
      throw captureError('SCREEN_PERMISSION_DENIED', capability.reason);
    }
    if (capability.availability !== 'available') throw captureError('CAPTURE_UNAVAILABLE', capability.reason);
    const bounds = targetDisplay.bounds;
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
      throw captureError('INVALID_DISPLAY', 'Selected display has invalid dimensions');
    }
    const scale = Number.isFinite(targetDisplay.scaleFactor) && targetDisplay.scaleFactor > 0 ? targetDisplay.scaleFactor : 1;
    const sources = await this.electron.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) }
    });
    this._assertLayout(layout.layoutRevision);
    const matches = sources.filter(source => source.display_id !== '' && source.display_id != null && String(source.display_id) === String(targetDisplay.id));
    // A portal may omit display_id. Never guess by source order or resolution.
    if (matches.length !== 1) throw captureError('DISPLAY_SOURCE_UNAVAILABLE', 'The selected display cannot be identified in capture sources; select a supported display or retry');
    const source = matches[0];
    const image = source.thumbnail;
    const size = image?.getSize();
    if (!image || image.isEmpty?.() || !size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) {
      throw captureError('EMPTY_CAPTURE', 'Selected display returned an empty capture');
    }
    return {
      image,
      metadata: {
        displayId: targetDisplay.id, displayBounds: bounds, scaleFactor: scale,
        layoutRevision: layout.layoutRevision, sourceId: source.id, sourceName: source.name,
        dimensions: size, captureTime: new Date().toISOString()
      }
    };
  }

  _validateOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw captureError('INVALID_OPTIONS', 'Capture options must be an object');
    if (options.displayId != null && !['string', 'number'].includes(typeof options.displayId)) throw captureError('INVALID_DISPLAY', 'Display identity must be a number or string');
    if (Object.hasOwn(options, 'area') && !this._isValidArea(options.area)) throw captureError('INVALID_CROP', 'Capture area must contain finite coordinates and positive dimensions');
    if (options.areaCoordinateSpace != null && !['image-pixels', 'display-dip', 'desktop-dip'].includes(options.areaCoordinateSpace)) throw captureError('INVALID_CROP', 'Unknown capture coordinate space');
  }
  _assertLayout(revision) {
    if (this.platformAdapter.getDisplayLayout().layoutRevision !== revision) throw captureError('STALE_DISPLAY_LAYOUT', 'Display layout changed; select the capture area again');
  }
  _getTargetDisplay(displayId, layout = this.platformAdapter.getDisplayLayout()) {
    const id = displayId == null ? layout.primaryDisplayId : displayId;
    const found = layout.displays.find(display => String(display.id) === String(id));
    if (!found) throw captureError('DISPLAY_NOT_FOUND', 'Selected display is no longer connected');
    return found;
  }
  _isValidArea(area) {
    return area && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(area[key])) && area.width > 0 && area.height > 0;
  }
  _cropArea(area, coordinateSpace, bounds, imageSize) {
    let { x, y, width, height } = area;
    let limit = imageSize;
    if (coordinateSpace === 'desktop-dip') { x -= bounds.x; y -= bounds.y; }
    if (coordinateSpace !== 'image-pixels') limit = bounds;
    if (x < 0 || y < 0 || x + width > limit.width || y + height > limit.height) throw captureError('INVALID_CROP', 'Capture area extends outside the selected display');
    if (coordinateSpace === 'image-pixels') {
      if (![x, y, width, height].every(Number.isInteger)) throw captureError('INVALID_CROP', 'Image pixel coordinates must be integers');
      return { x, y, width, height };
    }
    // Use actual returned dimensions: Electron can resize thumbnails.
    const ratioX = imageSize.width / bounds.width;
    const ratioY = imageSize.height / bounds.height;
    const left = Math.ceil(x * ratioX), top = Math.ceil(y * ratioY);
    const right = Math.floor((x + width) * ratioX), bottom = Math.floor((y + height) * ratioY);
    if (right <= left || bottom <= top) throw captureError('INVALID_CROP', 'Capture area is smaller than one image pixel');
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
}

module.exports = new CaptureService();
module.exports.CaptureService = CaptureService;
