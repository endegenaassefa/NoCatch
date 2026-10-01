'use strict';
const { formatMaterialContext } = require('../materials/context');
const { LIMITS } = require('../materials/limits');
const { validateImage } = require('../core/image-input');
const cancelled = () => Object.assign(new Error('This question was cancelled or its material session expired.'), { code: 'CANCELLED' });
const fail = (code, message) => Object.assign(new Error(message), { code });
const notices = {
  none: '', available: 'Using session materials.', partial: 'Using available material; some pages or visual content may be missing.',
  'no-match': 'General knowledge — no matching evidence found in the prepared material.',
  failed: 'General knowledge — materials are unavailable.'
};
function historyWithin(history) {
  const result = []; let remaining = 6000;
  for (const turn of (Array.isArray(history) ? history : []).slice(-20).reverse()) {
    if (!['user', 'assistant', 'model'].includes(turn?.role) || typeof turn.content !== 'string') continue;
    if (turn.content.length > remaining) break;
    result.unshift({ role: turn.role === 'model' ? 'assistant' : turn.role, content: turn.content });
    remaining -= turn.content.length;
  }
  return result;
}
function validateQuestion(input) {
  if (typeof input?.text !== 'string' || input.text.length > 16000 || (!input.text.trim() && !input.image)) throw fail('INPUT_LIMIT', 'Enter a question of at most 16,000 characters.');
  if (input.image) validateImage(input.image);
}
function citations(text, sources) {
  const ids = new Set();
  for (const match of text.matchAll(/\[([^\]\n]{1,250})\]/g)) for (const id of match[1].split(/[,;\s]+/)) ids.add(id);
  return sources.filter(source => ids.has(source.id)).map(({ text, ...source }) => source);
}
function hasUnsupportedCitation(text, sources) {
  const allowed = new Set(sources.map(source => source.id));
  for (const match of text.matchAll(/\[([^\]\n]{1,250})\]/g)) for (const id of match[1].split(/[,;\s]+/)) {
    const coordinate = /^[^\s:]+:(?:page|slide):\d+$/.test(id);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::(?:page|slide):\d+)?$/i.test(id);
    if ((coordinate || uuid) && !allowed.has(id)) return true;
  }
  return false;
}

function createAnswerOrchestrator({ materials, answerDirect, managedSession, readSourceImages, getAIMode = () => 'managed' }) {
  const requests = new Set();
  const answer = async (input, { signal, onDelta = () => {}, onUsage = () => {} } = {}) => {
    validateQuestion(input);
    const status = materials?.status(), active = status?.state === 'active';
    const snapshot = active ? materials.snapshot() : null;
    const controller = new AbortController(); requests.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const check = () => {
      if (combined.aborted || (active && (Date.now() >= snapshot.expiresAt || !materials.isCurrent(snapshot)))) throw cancelled();
    };
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(90000, active ? snapshot.expiresAt - Date.now() : 90000)));
    const poll = active ? setInterval(() => { if (!materials.isCurrent(snapshot) || Date.now() >= snapshot.expiresAt) controller.abort(); }, 50) : null;
    timer.unref?.(); poll?.unref?.();
    const wait = async promise => {
      let abort;
      try { return await Promise.race([promise, new Promise((_,reject) => { abort = () => reject(cancelled()); combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) abort(); })]); }
      finally { combined.removeEventListener('abort', abort); }
    };
    const dispatch = async (payload, consume = onDelta) => {
      check();
      const options = { signal: combined, onDelta: delta => { check(); consume(delta); }, onUsage: usage => { check(); onUsage(usage); } };
      const result = await wait(getAIMode() === 'direct' ? answerDirect(payload, options) : managedSession.answerScoped(payload, options));
      check(); return result;
    };
    try {
      check();
      const history = historyWithin(input.history), payload = { ...input, history, skill: input.skill || 'general' };
      let context, materialStatus = 'none';
      if (active) {
        const marker = { sessionId: snapshot.sessionId, generation: snapshot.generation, expiresAt: snapshot.expiresAt, sources: [] };
        let question = input.text;
        // A large collection needs a searchable question before evidence can
        // be selected. Small full-context sessions answer images in one call.
        if (input.image && status.preparation?.strategy !== 'full-context') {
          const transcribed = await dispatch({ ...payload, text: 'Transcribe the question, answer choices and essential diagram labels from this screenshot. Return only the transcription; do not solve it.', history: [], materialContext: marker }, () => {});
          question = String(transcribed.text || '');
          if (!question.trim() || question.length > 16000) throw fail('IMAGE_TRANSCRIPTION_FAILED', 'The screenshot question could not be read. Try a smaller, clearer capture.');
        }
        try {
          const result = await wait(materials.retrieveAsync(question, { history, maxChars: LIMITS.maxContextChars, signal: combined }));
          check();
          if (['cancelled', 'expired'].includes(result?.status)) throw cancelled();
          if (!['available', 'partial', 'no-match', 'failed'].includes(result?.status)) throw new Error('Unknown material state');
          materialStatus = result.status;
          context = { ...result, ...marker, sources: ['available','partial'].includes(materialStatus) ? result.sources : [], status: materialStatus };
          formatMaterialContext(context);
        } catch (error) {
          check();
          if (['CANCELLED', 'MATERIAL_EXPIRED', 'material_expired', 'ABORT_ERR'].includes(error.code)) throw cancelled();
          materialStatus = 'failed'; context = { ...marker, status: materialStatus };
        }
        if (readSourceImages && context.sources.length) {
          try {
            const images = await wait(readSourceImages(context.sources, { signal: combined, provider: input.provider }));
            check();
            context.images = images;
            formatMaterialContext(context);
          } catch (error) {
            check();
            if (error.code === 'CANCELLED') throw cancelled();
            delete context.images;
            materialStatus = 'partial'; context.status = materialStatus;
          }
        }
        payload.materialContext = context;
      }
      const result = await dispatch(payload);
      if (typeof result.text !== 'string' || !result.text.trim()) throw fail('EMPTY_ANSWER', 'The model returned no answer. Try again.');
      const warning = active && hasUnsupportedCitation(result.text, context.sources) ? ' Some source citations could not be verified.' : '';
      const searchNotice = active && context.strategy === 'lexical-fallback' ? ' Semantic search is unavailable; text matching was used.' : '';
      return { ...result, materialStatus, materialNotice: notices[materialStatus] + searchNotice + warning,
        ...(active ? { materialSession: { sessionId: snapshot.sessionId, generation: snapshot.generation, expiresAt: snapshot.expiresAt },
          sources: citations(result.text, context.sources), retrievedSources: context.sources, strategy: context.strategy } : { sources: [], retrievedSources: [] }) };
    } finally { clearTimeout(timer); clearInterval(poll); requests.delete(controller); controller.abort(); }
  };
  answer.cancelAll = () => { for (const controller of requests) controller.abort(); };
  return answer;
}
module.exports = { createAnswerOrchestrator, validateQuestion, citations };
