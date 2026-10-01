'use strict';
const { createAnswerOrchestrator } = require('./answer-orchestrator');
const { isProvider } = require('../core/ai-providers');
// Compatibility entry points translate UI arguments only. Context selection,
// cancellation, fallback and dispatch are owned by the shared orchestrator.
function attachMaterialsSession(service, dependencies) {
  const answer = dependencies.orchestrator || createAnswerOrchestrator(dependencies);
  const run = async (text, image, skill, history, language, onDelta) => {
    const started = Date.now(), provider = process.env.LLM_PROVIDER || 'gemini';
    if (!isProvider(provider)) throw new Error('Choose a configured AI provider.');
    const result = await answer({ text, ...(image ? { image } : {}), provider, skill: skill || 'general', history,
      language: language || undefined }, { onDelta });
    return { response: result.text, metadata: { skill, programmingLanguage: language, processingTime: Date.now() - started,
      usedFallback: ['failed','no-match'].includes(result.materialStatus), requestId: result.requestId,
      managed: dependencies.getAIMode() !== 'direct', materialStatus: result.materialStatus, materialNotice: result.materialNotice,
      materialSession: result.materialSession, sources: result.sources, strategy: result.strategy } };
  };
  for (const name of ['processTextWithSkill','processTextWithSkillStream','processTranscriptionWithIntelligentResponse','processTranscriptionWithIntelligentResponseStream']) {
    service[name] = (...args) => run(args[0], null, args[1], args[2], args[3], args[4]);
  }
  for (const name of ['processImageWithSkill','processImageWithSkillStream']) service[name] = (...args) => {
    if (!Buffer.isBuffer(args[0]) || !args[0].length || args[0].length > 2 * 1024 * 1024) return Promise.reject(new Error('Choose a screenshot smaller than 2 MiB.'));
    return run('Answer the question in this screenshot.', { data: args[0].toString('base64'), mimeType: args[1] }, args[2], args[3], args[4], args[5]);
  };
  service.cancelAnswers = answer.cancelAll;
  return service;
}
module.exports = { attachMaterialsSession };
