'use strict';
const messages = {
  material_expired: 'This material session ended or expired. Start a new session to continue.',
  invalid_material_context: 'These material references are invalid or expired. Please ask again.',
  invalid_material_session: 'This material session could not be registered. Please start again.',
  not_configured: 'Managed service is not configured in this build.', signed_out: 'Sign in to continue.',
  cancelled: 'The operation was cancelled.', auth_failed: 'Sign-in could not be completed. Please try again.',
  auth_expired: 'Sign-in expired. Please try again.', network: 'The managed service could not be reached. Please try again.',
  invalid_response: 'The managed service returned an invalid response.', quota_exceeded: 'Your usage limit has been reached.',
  rate_limited: 'Too many requests. Please try again shortly.', request_failed: 'The answer could not be completed. Please try again.',
  invalid_request: 'The answer request is invalid.', image_not_supported: 'The selected model does not support image questions. Choose a model with verified image support.',
  callback_unavailable: 'The sign-in callback port is busy. Close other NoCatch sign-in windows and try again.',
};
class ManagedError extends Error {
  constructor(code) { super(messages[code] || messages.request_failed); this.name = 'ManagedError'; this.code = messages[code] ? code : 'request_failed'; }
}
function safeError(error) { return error instanceof ManagedError ? error : new ManagedError(error?.name === 'AbortError' ? 'cancelled' : 'network'); }
module.exports = { ManagedError, safeError };
