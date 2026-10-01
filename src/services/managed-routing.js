// Adapt managed answers to the existing renderer/session response contract.
function attachManagedSession(service, manager, mode = () => 'managed') {
  service.isManagedMode = () => mode() === 'managed';
  const request = async (text, image, skill, history, language, onDelta) => {
    const started = Date.now();
    const messages = (Array.isArray(history) ? history : []).filter(item =>
      ['user', 'model', 'assistant'].includes(item.role) && typeof item.content === 'string'
    ).slice(-20).map(item => ({ role: item.role === 'model' ? 'assistant' : item.role, content: item.content.slice(0, 16000) }));
    const result = await manager.answer({ text, ...(image ? { image } : {}), skill,
      history: messages, language: language || undefined,
      provider: process.env.LLM_PROVIDER || 'gemini' }, onDelta);
    return { response: result.text, metadata: { skill, programmingLanguage: language,
      processingTime: Date.now() - started, usedFallback: false, managed: true, requestId: result.requestId } };
  };
  for (const name of ['processTextWithSkill', 'processTextWithSkillStream',
    'processTranscriptionWithIntelligentResponse', 'processTranscriptionWithIntelligentResponseStream']) {
    const direct = service[name].bind(service);
    service[name] = (...args) => service.isManagedMode()
      ? request(args[0], null, args[1], args[2], args[3], args[4]) : direct(...args);
  }
  for (const name of ['processImageWithSkill', 'processImageWithSkillStream']) {
    const direct = service[name].bind(service);
    service[name] = (...args) => {
      if (!service.isManagedMode()) return direct(...args);
      if (!Buffer.isBuffer(args[0]) || !args[0].length || args[0].length > 6 * 1024 * 1024) {
        return Promise.reject(new Error('Choose a screenshot smaller than 6 MB.'));
      }
      return request('Help me understand the selected image.', { data: args[0].toString('base64'), mimeType: args[1] },
        args[2], args[3], args[4], args[5]);
    };
  }
  const stats = service.getStats.bind(service);
  service.getStats = () => service.isManagedMode()
    ? { ...stats(), isInitialized: manager.status().authenticated, hasApiKey: false, mode: 'managed' } : { ...stats(), mode: 'direct' };
  const test = service.testConnection.bind(service);
  service.testConnection = async () => service.isManagedMode()
    ? { success: manager.status().authenticated, mode: 'managed', error: manager.status().authenticated ? null : 'Sign in to OpenCluely first.' }
    : test();
  return service;
}
module.exports = { attachManagedSession };
