'use strict';
const owner = require(process.argv[2]);
const options = JSON.parse(process.argv[3]);
let ready = false;
owner.acquire({ ...options, onActivate() { process.send?.({ event: 'activated' }); }, isReady: () => ready })
  .then(result => {
    process.send?.({ event: 'admission', pid: process.pid, acquired: result.acquired, owner: result.owner, mode: result.mode });
    if (!result.acquired) return process.disconnect?.();
    process.on('message', message => {
      if (message === 'ready') { ready = true; process.send?.({ event: 'ready' }); }
      if (message === 'close') { result.close(); process.disconnect?.(); }
    });
  }).catch(error => { process.send?.({ event: 'error', error: error.message, code: error.code }); process.exitCode = 1; process.disconnect?.(); });
