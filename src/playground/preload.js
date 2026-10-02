'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const channel = 'ingestion-playground';
const actions = new Set(['state','rendered','event','exit','emergency','clear','quit','confirmExit','cancelExit','acknowledge','exportCourse','openCourse','materials','settings','start','answer','question','finish','review','preview','capture','retrieve']);
contextBridge.exposeInMainWorld('playground', {
  invoke: (action, payload) => { if (!actions.has(action)) throw new Error('Unknown action'); return ipcRenderer.invoke(channel, action, payload); },
  onState: callback => ipcRenderer.on(`${channel}:state`, (_event, state) => callback(state)),
  onError: callback => ipcRenderer.on(`${channel}:error`, (_event, message) => callback(message)),
  onExit: callback => ipcRenderer.on(`${channel}:exit`, () => callback())
});
