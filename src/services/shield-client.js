/**
 * Cluely Shield client — the Brain's (uid-501) side of the Unix-socket IPC to
 * the root shield helper (/tmp/cluely-shield.sock).
 *
 * Exam-mode handoff: before the Brain quits, it pushes the cached
 * config/credentials (API key, model, prompt) to the root helper and flips
 * `examMode` on. The helper persists them root-owned and answers autonomously
 * from then on — the Brain is no longer needed and fully quits (no killable
 * uid-501 GUI target remains).
 *
 * Protocol (newline-delimited JSON, one reply per command):
 *   {"cmd":"ping"}                                   -> {"ok":true,"pid":...}
 *   {"cmd":"configure","apiKey":...,"model":...,"baseUrl":...,"prompt":...,"maxTokens":...,"examMode":true}
 *                                                    -> {"ok":true,...}
 *   {"cmd":"exam-mode","on":true}                    -> {"ok":true,...}
 *   {"cmd":"answer"}                                 -> {"ok":true,"queued":true}
 */

const net = require('net');
const logger = require('../core/logger').createServiceLogger('Shield');

const SOCKET_PATH = '/tmp/cluely-shield.sock';
const DEFAULT_PROMPT =
  'You are an exam assistant. Read the question shown on the screen and answer it correctly and concisely. ' +
  'If it is multiple choice, give the letter and a one-line reason. ' +
  'If it is a coding question, give the code in a fenced block with the language tag.';

// Shared secret for the socket, generated at install and stored root-only in
// the helper config; the Brain reads it here so its mutating commands are
// accepted. A uid-501 attacker (LDB) does not know it.
const SOCKET_TOKEN = process.env.CLUELY_SHIELD_TOKEN || '';

/**
 * Attach the shared token to a mutating command.
 */
function withToken(command) {
  return SOCKET_TOKEN ? { ...command, token: SOCKET_TOKEN } : command;
}

/**
 * Send a single newline-delimited JSON command and await its reply.
 * @param {object} command
 * @param {number} timeoutMs
 * @returns {Promise<object>} parsed reply
 */
function sendCommand(command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: SOCKET_PATH });
    let buffer = '';

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Shield socket timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(JSON.stringify(command) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        const line = buffer.slice(0, nl);
        socket.destroy();
        try {
          resolve(JSON.parse(line));
        } catch (_) {
          reject(new Error('Bad JSON reply from shield: ' + line.slice(0, 200)));
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Shield socket error: ${err.message}`));
    });

    socket.on('close', () => {
      clearTimeout(timer);
    });
  });
}

/**
 * Ping the shield helper. Resolves true when the helper is alive and answering.
 * @returns {Promise<boolean>}
 */
async function ping() {
  const reply = await sendCommand({ cmd: 'ping' });
  return reply && reply.ok === true;
}

/**
 * Push the exam-mode config to the root helper and flip examMode on.
 * Called by the Brain right before it quits. The helper persists it root-owned.
 * @param {object} opts { apiKey, model, baseUrl, prompt, maxTokens }
 * @returns {Promise<object>} the helper's reply
 */
async function configureExamMode(opts = {}) {
  const command = withToken({
    cmd: 'configure',
    apiKey: opts.apiKey || '',
    model: opts.model || 'deepseek-flash',
    baseUrl: opts.baseUrl || 'https://api.deepseek.com',
    prompt: opts.prompt || DEFAULT_PROMPT,
    maxTokens: opts.maxTokens || 4096,
    examMode: true
  });
  const reply = await sendCommand(command);
  if (!reply || reply.ok !== true) {
    throw new Error('Shield rejected configure: ' + JSON.stringify(reply));
  }
  logger.info('Shield configured for exam mode', {
    model: command.model,
    hasApiKey: !!command.apiKey
  });
  return reply;
}

/**
 * Tell the shield to answer now (hotkey-equivalent over the socket).
 * @returns {Promise<object>}
 */
function answerNow() {
  return sendCommand(withToken({ cmd: 'answer' }));
}

/**
 * Orderly shutdown of the helper (operator-only; not used during an exam).
 * @returns {Promise<object>}
 */
function quit() {
  return sendCommand(withToken({ cmd: 'quit' }));
}

module.exports = {
  SOCKET_PATH,
  DEFAULT_PROMPT,
  SOCKET_TOKEN,
  sendCommand,
  ping,
  configureExamMode,
  answerNow,
  quit
};
