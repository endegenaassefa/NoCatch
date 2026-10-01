'use strict';
// Local desktop launcher. The installed EXE and its resources remain standalone.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { parse } = require('dotenv');
const { resolveProvider } = require('../src/core/ai-providers');

function launch({ argv = process.argv.slice(2), environment = process.env, start = spawn } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    check: { type: 'boolean', default: false },
    profile: { type: 'string', default: 'NoCatch-Clean-Slate-Exam' },
    'model-dir': { type: 'string' }
  } });
  if (!/^[a-zA-Z0-9_-]+$/.test(values.profile)) throw new Error('Use a profile name, not a path.');
  if (!environment.APPDATA || !environment.LOCALAPPDATA) throw new Error('Windows profile directories are unavailable.');
  const executable = path.join(environment.LOCALAPPDATA, 'Programs', 'screen-reader-util', 'screen-reader-util.exe');
  const profile = path.join(environment.APPDATA, values.profile);
  const originalConfig = path.join(environment.APPDATA, 'screen-reader-util', '.env');
  for (const file of [executable, path.join(path.dirname(executable), 'resources/speech-runtime/windows-x64/python.exe'),
    ...(values['model-dir'] ? [path.join(values['model-dir'], 'small.pt')] : [])]) {
    if (!fs.existsSync(file)) throw new Error(`Required local dependency is missing: ${file}`);
  }
  if (values.check) return { dependenciesPresent: true, executable, profile, credentials: 'not read by this check' };

  const readConfig = file => fs.existsSync(file) ? parse(fs.readFileSync(file)) : {};
  const normal = readConfig(originalConfig);
  const local = readConfig(path.join(profile, '.env'));
  const provider = local.LLM_PROVIDER || normal.LLM_PROVIDER || 'deepseek';
  if (!['gemini', 'deepseek', 'qwen'].includes(provider)) throw new Error('Choose a supported provider in Settings.');
  const env = { ...environment };
  for (const name of Object.keys(env)) {
    if (/^(ELECTRON_RUN_AS_NODE|AI_MODE|LLM_PROVIDER|(?:GEMINI|DEEPSEEK|QWEN)_.*|NOCATCH_MANAGED_.*)$/i.test(name)) delete env[name];
  }
  {
    const prefix = provider.toUpperCase();
    const usable = value => typeof value === 'string' && value.trim() && !/^your[_ ]/i.test(value);
    for (const suffix of ['MODEL', 'BASE_URL']) {
      const name = `${prefix}_${suffix}`;
      const value = usable(local[name]) ? local[name] : normal[name];
      if (usable(value)) env[name] = value;
    }
    const selectedRoute = resolveProvider({ provider }, env);
    env[`${prefix}_MODEL`] = selectedRoute.model;
    env[`${prefix}_BASE_URL`] = selectedRoute.baseUrl;
    const keyName = `${prefix}_API_KEY`;
    if (usable(local[keyName])) env[keyName] = local[keyName];
    else if (usable(normal[keyName])) {
      const normalRoute = resolveProvider({ provider, baseUrl: normal[`${prefix}_BASE_URL`] }, {}).baseUrl;
      // A normal-profile Alibaba key must not follow a local OpenRouter route.
      if (selectedRoute.baseUrl === normalRoute) env[keyName] = normal[keyName];
    }
  }
  if (!env[`${provider.toUpperCase()}_API_KEY`]) throw new Error('Configure the selected provider key in the app Settings first.');
  Object.assign(env, { AI_MODE: 'direct', LLM_PROVIDER: provider, WHISPER_CAPTURE_MODE: 'manual' });
  if (values['model-dir']) Object.assign(env, {
    SPEECH_PROVIDER: 'whisper', WHISPER_PYTHON: '', WHISPER_COMMAND: 'whisper',
    WHISPER_MODEL_DIR: path.resolve(values['model-dir']), WHISPER_MODEL: 'small',
    WHISPER_LANGUAGE: 'en', WHISPER_DEVICE: 'cpu', WHISPER_RESPONSE_TARGET: 'chat'
  });
  fs.mkdirSync(profile, { recursive: true });
  const child = start(executable, [`--user-data-dir=${profile}`], { cwd: profile, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', error => { console.error(`NoCatch launch failed: ${error.message}`); process.exitCode = 1; });
  child.unref();
  return { executable, profile, provider };
}
module.exports = { launch };
if (require.main === module) {
  try { const result = launch(); if (process.argv.includes('--check')) console.log(JSON.stringify(result)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
