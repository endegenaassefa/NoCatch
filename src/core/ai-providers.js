'use strict';
const DEFAULT_QWEN_BASE = 'https://dashscope-us.aliyuncs.com/compatible-mode/v1';
const defaults = { gemini: 'gemini-3.1-flash-lite', deepseek: 'deepseek-flash', qwen: 'qwen3.8-flash' };
const isProvider = provider => Object.hasOwn(defaults, provider);
function validateBaseUrl(provider, value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new Error('Invalid provider endpoint');
  const path = url.pathname.replace(/\/$/, '');
  const workspace = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:ap-southeast-1|cn-beijing|cn-hongkong|ap-northeast-1)\.maas\.aliyuncs\.com$/;
  const qwen = ((['dashscope-us.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope.aliyuncs.com'].includes(url.hostname) || workspace.test(url.hostname)) && path === '/compatible-mode/v1') ||
    (url.hostname === 'api.together.ai' && path === '/v1') || (url.hostname === 'openrouter.ai' && path === '/api/v1');
  if (provider === 'qwen' ? !qwen : provider === 'deepseek' && !(url.hostname === 'api.deepseek.com' && ['', '/v1'].includes(path))) throw new Error('Unsupported provider endpoint');
  return url.origin + path;
}
function resolveProvider({provider, model, baseUrl} = {}, env = process.env) {
  if (!isProvider(provider)) throw new Error('Unknown AI provider');
  const prefix = provider.toUpperCase();
  model = model || env[prefix + '_MODEL'] || defaults[provider];
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) throw new Error('Invalid provider model');
  baseUrl = provider === 'gemini' ? 'https://generativelanguage.googleapis.com' : validateBaseUrl(provider, baseUrl || env[prefix + '_BASE_URL'] || (provider === 'qwen' ? DEFAULT_QWEN_BASE : 'https://api.deepseek.com'));
  return {provider, model, baseUrl, apiKey: env[prefix + '_API_KEY'] || '', ...getProviderCapabilities(provider,model,baseUrl)};
}
function getProviderCapabilities(provider, model = defaults[provider], baseUrl = DEFAULT_QWEN_BASE) {
  let host; try {host=new URL(baseUrl).hostname;} catch {return {vision:false, contextTokens:null};}
  let contextTokens = null;
  if(provider==='deepseek' && ['deepseek-flash','deepseek-v4-pro'].includes(model)) contextTokens=1000000;
  let vision = provider === 'gemini' && /^gemini-/.test(model);
  if (provider === 'deepseek') vision = ['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(model);
  if (provider === 'qwen') {
    if (host === 'api.together.ai') vision = ['Qwen/Qwen3.5-9B'].includes(model);
    else if (host === 'openrouter.ai') vision = ['qwen/qwen3.8-flash'].includes(model);
    else vision = ['qwen3.8-flash','qwen3.7-plus','qwen3.8-max'].includes(model) || /^qwen(?:2\.5|3)-vl-(?:plus|max)(?:-[a-z0-9-]+)?$/.test(model);
  }
  if(provider==='qwen') {
    if(host==='api.together.ai' && model==='Qwen/Qwen3.5-9B') contextTokens=262144;
    else if(host==='api.together.ai' && model==='Qwen/Qwen3.8-Flash' || host==='openrouter.ai' && model==='qwen/qwen3.8-flash' || /(?:dashscope|maas).*aliyuncs\.com$/.test(host) && ['qwen3.8-flash','qwen3.7-plus'].includes(model)) contextTokens=1000000;
  }
  return {vision: Boolean(vision), contextTokens};
}
module.exports = {isProvider, resolveProvider, getProviderCapabilities, validateBaseUrl, DEFAULT_QWEN_BASE};
