const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  getMaterialsStatus: () => ipcRenderer.invoke('materials-status'),
  importMaterials: () => ipcRenderer.invoke('materials-import'),
  prepareMaterials: () => ipcRenderer.invoke('materials-prepare'),
  startMaterials: options => ipcRenderer.invoke('materials-start',options),
  previewMaterial: (id,page) => ipcRenderer.invoke('materials-preview',id,page),
  removeMaterial: id => ipcRenderer.invoke('materials-remove',id),
  endMaterials: () => ipcRenderer.invoke('materials-end'),
  cancelMaterialImport: () => ipcRenderer.invoke('materials-cancel-import'),
  showMaterials: () => ipcRenderer.invoke('materials-show'),
  onMaterialsStatus: callback => {const listener=(_event,status)=>callback(status);ipcRenderer.on('materials-status-changed',listener);return ()=>ipcRenderer.removeListener('materials-status-changed',listener);},
  onMaterialsInvalidated: callback => {const listener=(_event,data)=>callback(data);ipcRenderer.on('materials-session-invalidated',listener);return ()=>ipcRenderer.removeListener('materials-session-invalidated',listener);},
  getManagedStatus: () => ipcRenderer.invoke('managed-status'),
  signIn: () => ipcRenderer.invoke('managed-sign-in'),
  signOut: () => ipcRenderer.invoke('managed-sign-out'),
  getSetupCapabilities: () => ipcRenderer.invoke('setup-capabilities'),
  requestSetupPermission: kind => ipcRenderer.invoke('setup-permission', kind),
  openPermissionSettings: kind => ipcRenderer.invoke('setup-permission-settings', kind),
  testSetupAnswer: input => ipcRenderer.invoke('setup-test-answer', input),
  getSetupState: () => ipcRenderer.invoke('get-setup-state'),
  saveSetupProgress: progress => ipcRenderer.invoke('save-setup-progress', progress),
  captureSetupPreview: options => ipcRenderer.invoke('capture-setup-preview', options),
  submitSetupQuestion: input => ipcRenderer.invoke('submit-setup-question', input),
  cancelSetup: () => ipcRenderer.invoke('cancel-setup'),
  showOnboarding: () => ipcRenderer.invoke('show-onboarding'),
  minimizeOnboarding: () => ipcRenderer.invoke('minimize-onboarding'),
  onManagedStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('managed-status', listener);
    return () => ipcRenderer.removeListener('managed-status', listener);
  },
  // Screenshot and OCR
  takeScreenshot: (requestId) => ipcRenderer.invoke('take-screenshot', requestId),
  
  // Speech recognition
  toggleSpeechRecognition: () => ipcRenderer.invoke('toggle-speech-recognition'),
  startSpeechRecognition: () => ipcRenderer.invoke('start-speech-recognition'),
  stopSpeechRecognition: () => ipcRenderer.invoke('stop-speech-recognition'),
  cancelSpeechRecognition: () => ipcRenderer.invoke('cancel-speech-recognition'),
  sendMicrophoneEvent: event => ipcRenderer.send('microphone-event', event),
  onMicrophoneCommand: callback => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('microphone-command', listener);
    return () => ipcRenderer.removeListener('microphone-command', listener);
  },
  getSpeechAvailability: () => ipcRenderer.invoke('get-speech-availability'),
  
  // Window management
  showAllWindows: () => ipcRenderer.invoke('show-all-windows'),
  hideAllWindows: () => ipcRenderer.invoke('hide-all-windows'),
  enableWindowInteraction: () => ipcRenderer.invoke('enable-window-interaction'),
  disableWindowInteraction: () => ipcRenderer.invoke('disable-window-interaction'),
  switchToChat: () => ipcRenderer.invoke('switch-to-chat'),
  switchToSkills: () => ipcRenderer.invoke('switch-to-skills'),
  resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', { width, height }),
  moveWindow: (deltaX, deltaY) => ipcRenderer.invoke('move-window', { deltaX, deltaY }),
  getWindowStats: () => ipcRenderer.invoke('get-window-stats'),
  
  // Session memory
  getSessionHistory: () => ipcRenderer.invoke('get-session-history'),
  getLLMSessionHistory: () => ipcRenderer.invoke('get-llm-session-history'),
  clearSessionMemory: () => ipcRenderer.invoke('clear-session-memory'),
  formatSessionHistory: () => ipcRenderer.invoke('format-session-history'),
  sendChatMessage: (text, requestId) => ipcRenderer.invoke('send-chat-message', text, requestId),
  getSkillPrompt: (skillName) => ipcRenderer.invoke('get-skill-prompt', skillName),
  
  // Gemini LLM configuration
  setGeminiApiKey: (apiKey) => ipcRenderer.invoke('set-gemini-api-key', apiKey),
  getGeminiStatus: () => ipcRenderer.invoke('get-gemini-status'),
  testGeminiConnection: () => ipcRenderer.invoke('test-gemini-connection'),
  
  // Settings
  showSettings: () => ipcRenderer.invoke('show-settings'),
  hideSettings: () => ipcRenderer.invoke('hide-settings'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getShortcutStatus: () => ipcRenderer.invoke('get-shortcut-status'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // First-run onboarding
  getFirstRunStatus: () => ipcRenderer.invoke('get-first-run-status'),
  completeFirstRun: () => ipcRenderer.invoke('complete-first-run'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  closeOnboarding: () => ipcRenderer.invoke('close-onboarding'),
  getWhisperModelStatus: model => ipcRenderer.invoke('whisper-model-status', model),
  prepareWhisperModel: model => ipcRenderer.invoke('prepare-whisper-model', model),
  cancelWhisperModel: operationId => ipcRenderer.invoke('cancel-whisper-model', operationId),
  onWhisperModelStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('whisper-model-status', listener);
    return () => ipcRenderer.removeListener('whisper-model-status', listener);
  },
  detectWhisper: () => ipcRenderer.invoke('detect-whisper'),
  installWhisper: () => ipcRenderer.invoke('install-whisper'),
  downloadWhisperModel: (modelName) => ipcRenderer.invoke('download-whisper-model', modelName),
  onInstallProgress: (callback) => {
    const wrapped = (_event, line) => {
      try { callback(line); } catch (e) { console.error('onInstallProgress error:', e); }
    };
    ipcRenderer.on('install-progress', wrapped);
    return () => ipcRenderer.removeListener('install-progress', wrapped);
  },
  updateAppIcon: (iconKey) => ipcRenderer.invoke('update-app-icon', iconKey),
  updateActiveSkill: (skill) => ipcRenderer.invoke('update-active-skill', skill),
  restartAppForStealth: () => ipcRenderer.invoke('restart-app-for-stealth'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  notifyMainWindowReady: () => {
    try {
      ipcRenderer.send('main-window-ready');
    } catch (error) {
      console.error('Error notifying main window ready:', error);
    }
  },
  quit: () => {
    try {
      ipcRenderer.send('quit-app');
    } catch (error) {
      console.error('Error in quit:', error);
    }
  },
  
  // LLM window specific methods
  expandLlmWindow: (contentMetrics) => ipcRenderer.invoke('expand-llm-window', contentMetrics),
  resizeLlmWindowForContent: (contentMetrics) => ipcRenderer.invoke('resize-llm-window-for-content', contentMetrics),

  // NOTE: copyToClipboard was REMOVED — clipboard writes are a proctor tell
  // and the Copy buttons were removed from the renderers.
  
  // Window binding / gap (previously handler-exists but not exposed here)
  setWindowBinding: (enabled) => ipcRenderer.invoke('set-window-binding', enabled),
  toggleWindowBinding: () => ipcRenderer.invoke('toggle-window-binding'),
  getWindowBindingStatus: () => ipcRenderer.invoke('get-window-binding-status'),
  setWindowGap: (gap) => ipcRenderer.invoke('set-window-gap', gap),

  // Keystroke-capture mode (focusless typing)
  getCaptureMode: () => ipcRenderer.invoke('get-capture-mode'),
  // TEST-HARNESS ONLY: synthesize real OS input for the stealth matrix.
  // The main process rejects every call unless the app was launched with
  // CLUELY_TEST_HARNESS=1, so normal launches carry no input surface.
  syntheticInput: (command) => ipcRenderer.invoke('synthetic-input', command),
  
  // Display management
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  captureArea: (options) => ipcRenderer.invoke('capture-area', options),

  // Cluely Shield (root helper) exam mode
  shieldStatus: () => ipcRenderer.invoke('shield-status'),
  shieldExamMode: (opts) => ipcRenderer.invoke('shield-exam-mode', opts),
  getExamModeState: () => ipcRenderer.invoke('get-exam-mode-state'),
  
  // Event listeners
  onTranscriptionReceived: (callback) => ipcRenderer.on('transcription-received', callback),
  onInterimTranscription: (callback) => ipcRenderer.on('interim-transcription', callback),
  onSpeechStatus: (callback) => ipcRenderer.on('speech-status', callback),
  onSpeechError: (callback) => ipcRenderer.on('speech-error', callback),
  onSpeechAvailability: (callback) => ipcRenderer.on('speech-availability', callback),
  onSessionEvent: (callback) => ipcRenderer.on('session-event', callback),
  onSessionCleared: (callback) => ipcRenderer.on('session-cleared', callback),
  onOcrCompleted: (callback) => ipcRenderer.on('ocr-completed', callback),
  onChatRequestStarted: (callback) => ipcRenderer.on('chat-request-started', callback),
  onOcrError: (callback) => ipcRenderer.on('ocr-error', callback),
  onLlmResponse: (callback) => ipcRenderer.on('llm-response', callback),
  onLlmError: (callback) => ipcRenderer.on('llm-error', callback),
  onTranscriptionLlmResponse: (callback) => ipcRenderer.on('transcription-llm-response', callback),
  onTranscriptionLlmResponseStart: (callback) => ipcRenderer.on('transcription-llm-response-start', callback),
  onTranscriptionLlmResponseChunk: (callback) => ipcRenderer.on('transcription-llm-response-chunk', callback),
  onOpenGeminiConfig: (callback) => ipcRenderer.on('open-gemini-config', callback),
  onDisplayLlmResponse: (callback) => ipcRenderer.on('display-llm-response', callback),
  onShowLoading: (callback) => ipcRenderer.on('show-loading', callback),
  onSkillChanged: (callback) => ipcRenderer.on('skill-changed', callback),
  onInteractionModeChanged: (callback) => ipcRenderer.on('interaction-mode-changed', callback),
  onRecordingStarted: (callback) => ipcRenderer.on('recording-started', callback),
  onRecordingStopped: (callback) => ipcRenderer.on('recording-stopped', callback),
  onCodingLanguageChanged: (callback) => ipcRenderer.on('coding-language-changed', callback),
  onMainWindowShown: (callback) => ipcRenderer.on('main-window-shown', callback),
  onCaptureModeChanged: (callback) => ipcRenderer.on('capture-mode-changed', callback),
  onCaptureModeError: (callback) => ipcRenderer.on('capture-mode-error', callback),
  onPaletteKey: (callback) => ipcRenderer.on('palette-key', callback),
  onCaptureHotkeyRefused: (callback) => ipcRenderer.on('capture-hotkey-refused', callback),
  onToggleShortcutsPopover: (callback) => ipcRenderer.on('toggle-shortcuts-popover', callback),
  onShieldAnswer: (callback) => ipcRenderer.on('shield-answer', callback),
  onShieldExamModeChanged: (callback) => ipcRenderer.on('shield-exam-mode-changed', callback),
  
  // Generic receive method
  receive: (channel, callback) => ipcRenderer.on(channel, callback),
  
  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
})

contextBridge.exposeInMainWorld('api', {
    send: (channel, data) => {
        let validChannels = [
            'close-settings',
            'quit-app',
            'save-settings',
            'toggle-recording',
            'toggle-interaction-mode',
            'update-skill',
            'window-loaded',
            'input-target-focused',
            'toggle-capture-mode',
            'palette-set-skill',
            'hide-llm-response',
            'show-shortcuts-popover'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        } else {
            console.warn('Invalid IPC channel:', channel);
        }
    },
    receive: (channel, func) => {
        let validChannels = [
            'load-settings',
            'recording-state-changed',
            'interaction-mode-changed',
            'skill-updated',
            'update-skill',
            'recording-started',
            'recording-stopped'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    }
});
