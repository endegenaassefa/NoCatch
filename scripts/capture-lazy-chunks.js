/**
 * Runtime traffic capture for lazy-loaded chunks.
 *
 * Usage:
 *   1. Open HackerRank test page in a browser with DevTools.
 *   2. Paste this script into the console BEFORE the test starts.
 *   3. Run one authorized practice attempt.
 *   4. Call `dumpCapturedTraffic()` to see all captured requests.
 *
 * This wraps fetch, XHR, sendBeacon, and WebSocket to log all arguments.
 */

(function() {
  const captured = [];

  function logCapture(type, url, data) {
    captured.push({
      timestamp: new Date().toISOString(),
      type,
      url,
      data: typeof data === 'string' ? data : JSON.stringify(data)
    });
    console.log(`[CAPTURE] ${type} ${url}`, data);
  }

  // Wrap fetch
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const [url, options] = args;
    logCapture('fetch', url, options?.body);
    return originalFetch.apply(this, args);
  };

  // Wrap XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._captureUrl = url;
    this._captureMethod = method;
    return originalXHROpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    logCapture('xhr', this._captureUrl, body);
    return originalXHRSend.apply(this, arguments);
  };

  // Wrap sendBeacon
  const originalSendBeacon = navigator.sendBeacon;
  navigator.sendBeacon = function(url, data) {
    logCapture('beacon', url, data);
    return originalSendBeacon.apply(this, arguments);
  };

  // Wrap WebSocket
  const originalWebSocketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    logCapture('websocket', this.url, data);
    return originalWebSocketSend.apply(this, arguments);
  };

  // Expose dump function
  window.dumpCapturedTraffic = function() {
    console.table(captured);
    return captured;
  };

  console.log('[CAPTURE] Traffic capture installed. Call dumpCapturedTraffic() to see results.');
})();
