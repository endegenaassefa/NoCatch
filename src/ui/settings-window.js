document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechProviderSelect = document.getElementById('speechProvider');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const whisperCommandInput = document.getElementById('whisperCommand');
    const whisperModelInput = document.getElementById('whisperModel');
    const whisperLanguageInput = document.getElementById('whisperLanguage');
    const whisperDeviceSelect = document.getElementById('whisperDevice');
    const whisperCaptureModeSelect = document.getElementById('whisperCaptureMode');
    const whisperResponseTargetSelect = document.getElementById('whisperResponseTarget');
    const whisperSegmentMsInput = document.getElementById('whisperSegmentMs');
    const geminiKeyInput = document.getElementById('geminiKey');
    const llmProviderSelect = document.getElementById('llmProvider');
    const providerFields = ['qwenKey','qwenModel','qwenBaseUrl','deepseekModel','deepseekBaseUrl'];
    const dirtyKeys = new Set();
    for (const id of ['geminiKey','deepseekKey','qwenKey','azureKey']) document.getElementById(id)?.addEventListener('input',()=>dirtyKeys.add(id));
    const deepseekKeyInput = document.getElementById('deepseekKey');
    const windowGapInput = document.getElementById('windowGap');
    const captureHotkeyInput = document.getElementById('captureHotkey');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const iconGrid = document.getElementById('iconGrid');
    const shieldStatusEl = document.getElementById('shieldStatus');
    const shieldCheckButton = document.getElementById('shieldCheckButton');
    const shieldExamModeButton = document.getElementById('shieldExamModeButton');
    const shieldShowWindowCheckbox = document.getElementById('shieldShowWindowCheckbox');

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.speechProvider && speechProviderSelect) speechProviderSelect.value = settings.speechProvider;
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults). Previously
        // empty strings were skipped which left stale UI values.
        if (azureKeyInput) azureKeyInput.value = settings.azureKey || '';
        if (azureRegionInput) azureRegionInput.value = settings.azureRegion || '';
        if (whisperCommandInput) whisperCommandInput.value = settings.whisperCommand || '';
        if (whisperModelInput) whisperModelInput.value = settings.whisperModel || '';
        if (whisperLanguageInput) whisperLanguageInput.value = settings.whisperLanguage || '';
        if (whisperDeviceSelect) whisperDeviceSelect.value = settings.whisperDevice || 'auto';
        if (whisperCaptureModeSelect) whisperCaptureModeSelect.value = settings.whisperCaptureMode || 'vad';
        if (whisperResponseTargetSelect) whisperResponseTargetSelect.value = settings.whisperResponseTarget || 'both';
        if (whisperSegmentMsInput) whisperSegmentMsInput.value = settings.whisperSegmentMs || '';
        if (geminiKeyInput && !dirtyKeys.has('geminiKey')) geminiKeyInput.value = settings.geminiKey || '';
        if (llmProviderSelect) llmProviderSelect.value = settings.llmProvider || 'gemini';
        if (deepseekKeyInput && !dirtyKeys.has('deepseekKey')) deepseekKeyInput.value = settings.deepseekKey || '';
        for (const id of providerFields) { const field=document.getElementById(id); if(field && !dirtyKeys.has(id)) field.value=settings[id] || ''; }
        if (windowGapInput) windowGapInput.value = settings.windowGap || '';
        if (captureHotkeyInput) captureHotkeyInput.value = settings.captureHotkey || '';

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                    option.setAttribute('aria-pressed', 'true');
                } else {
                    option.classList.remove('selected');
                    option.setAttribute('aria-pressed', 'false');
                }
            });
        }

        updateSpeechFieldStates();
        updateLlmFieldStates();
        document.dispatchEvent(new Event('settings-loaded'));
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (speechProviderSelect) settings.speechProvider = speechProviderSelect.value;
        if (azureKeyInput && dirtyKeys.has('azureKey')) settings.azureKey = azureKeyInput.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (whisperCommandInput) settings.whisperCommand = whisperCommandInput.value;
        if (whisperModelInput) settings.whisperModel = whisperModelInput.value;
        if (whisperLanguageInput) settings.whisperLanguage = whisperLanguageInput.value;
        if (whisperDeviceSelect) settings.whisperDevice = whisperDeviceSelect.value;
        if (whisperCaptureModeSelect) settings.whisperCaptureMode = whisperCaptureModeSelect.value;
        if (whisperResponseTargetSelect) settings.whisperResponseTarget = whisperResponseTargetSelect.value;
        if (whisperSegmentMsInput) settings.whisperSegmentMs = whisperSegmentMsInput.value;
        if (geminiKeyInput && dirtyKeys.has('geminiKey')) settings.geminiKey = geminiKeyInput.value;
        if (llmProviderSelect) settings.llmProvider = llmProviderSelect.value;
        if (deepseekKeyInput && dirtyKeys.has('deepseekKey')) settings.deepseekKey = deepseekKeyInput.value;
        for (const id of providerFields) { const field=document.getElementById(id); if(field && (!id.endsWith('Key') || dirtyKeys.has(id))) settings[id]=field.value; }
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (captureHotkeyInput && captureHotkeyInput.value.trim()) settings.captureHotkey = captureHotkeyInput.value.trim();
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        
        window.api.send('save-settings', settings);
    };

    const updateSpeechFieldStates = () => {
        const provider = speechProviderSelect ? speechProviderSelect.value : 'azure';
        const preparingModel = document.getElementById('whisperModelSetup')?.dataset.busy === 'true';
        if (speechProviderSelect) speechProviderSelect.disabled = preparingModel;

        // Show/hide provider-specific field groups instead of just disabling
        // them. This keeps the settings UI clean — only the relevant fields
        // for the selected provider are visible.
        const azureGroup = document.getElementById('azureFields');
        const whisperGroup = document.getElementById('whisperFields');
        const azureNote = document.getElementById('azureFieldsNote');

        if (azureGroup) {
            azureGroup.style.display = provider === 'azure' ? '' : 'none';
        }
        if (whisperGroup) {
            whisperGroup.style.display = provider === 'whisper' ? '' : 'none';
        }
        if (azureNote) {
            azureNote.style.display = provider === 'azure' ? '' : 'none';
        }

        // Also toggle disabled attribute for any leftover direct field refs
        [azureKeyInput, azureRegionInput].forEach(input => {
            if (input) input.disabled = provider !== 'azure';
        });
        [whisperCommandInput, whisperModelInput, whisperLanguageInput, whisperDeviceSelect,
            whisperCaptureModeSelect, whisperResponseTargetSelect, whisperSegmentMsInput].forEach(input => {
            if (input) input.disabled = provider !== 'whisper' || (preparingModel && [whisperCommandInput, whisperModelInput, whisperDeviceSelect].includes(input));
        });
    };

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        whisperCommandInput,
        whisperModelInput,
        whisperLanguageInput,
        whisperDeviceSelect,
        whisperCaptureModeSelect,
        whisperResponseTargetSelect,
        whisperSegmentMsInput,
        geminiKeyInput,
        deepseekKeyInput,
        windowGapInput,
        captureHotkeyInput
    ];

    inputs.push(...providerFields.map(id=>document.getElementById(id)));
    document.getElementById('qwenPreset')?.addEventListener('change',()=> {
      const preset=document.getElementById('qwenPreset').value;
      const bases={virginia:'https://dashscope-us.aliyuncs.com/compatible-mode/v1',together:'https://api.together.ai/v1',openrouter:'https://openrouter.ai/api/v1'};
      const field=document.getElementById('qwenBaseUrl');
      if(bases[preset]) field.value=bases[preset];
      else if(preset!=='custom') { const id=document.getElementById('qwenWorkspace').value.trim(); if(!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(id)) {document.getElementById('qwenWorkspace').focus();return;} field.value=`https://${id}.${preset}.maas.aliyuncs.com/compatible-mode/v1`; }
      if(preset==='together') document.getElementById('qwenModel').value='Qwen/Qwen3.8-Flash';
      else if(preset==='openrouter') document.getElementById('qwenModel').value='qwen/qwen3.8-flash';
      else if(preset!=='custom') document.getElementById('qwenModel').value='qwen3.8-flash';
      saveSettings();
    });
    document.getElementById('qwenWorkspace')?.addEventListener('change',()=>document.getElementById('qwenPreset').dispatchEvent(new Event('change')));
    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (speechProviderSelect) {
        speechProviderSelect.addEventListener('change', () => {
            updateSpeechFieldStates();
            saveSettings();
        });
    }

    if (llmProviderSelect) {
        llmProviderSelect.addEventListener('change', () => {
            updateLlmFieldStates();
            saveSettings();
        });
    }

    // Show/hide Gemini vs DeepSeek key fields based on the selected provider.
    const updateLlmFieldStates = () => {
        const provider = llmProviderSelect ? llmProviderSelect.value : 'gemini';
        const geminiGroup = document.getElementById('geminiFields');
        const deepseekGroup = document.getElementById('deepseekFields');

        if (geminiGroup) {
            geminiGroup.style.display = provider === 'gemini' ? '' : 'none';
        }
        if (deepseekGroup) {
            deepseekGroup.style.display = provider === 'deepseek' ? '' : 'none';
        }
        const qwenGroup = document.getElementById('qwenFields');
        if(qwenGroup) qwenGroup.style.display=provider==='qwen'?'':'none';
        for(const id of providerFields) {const field=document.getElementById(id);if(field) field.disabled=!id.startsWith(provider);}
        if (geminiKeyInput) geminiKeyInput.disabled = provider !== 'gemini';
        if (deepseekKeyInput) deepseekKeyInput.disabled = provider !== 'deepseek';
    };

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    updateSpeechFieldStates();
    updateLlmFieldStates();

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assets/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assets/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assets/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('button');
            iconElement.type = 'button';
            iconElement.setAttribute('aria-pressed', 'false');
            iconElement.setAttribute('aria-label', `Use ${icon.name} app icon`);
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assets/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('span');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                    opt.setAttribute('aria-pressed','false');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                iconElement.setAttribute('aria-pressed','true');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // ── Cluely Shield (exam mode) status + handoff ─────────────────────────
    const refreshShieldStatus = async () => {
        if (!window.electronAPI || !window.electronAPI.shieldStatus || !shieldStatusEl) return;
        shieldStatusEl.textContent = 'Checking…';
        try {
            const s = await window.electronAPI.shieldStatus();
            if (s && s.ok === true) {
                shieldStatusEl.textContent = `Online — pid ${s.pid}, exam mode ${s.examMode ? 'ON' : 'off'}`;
            } else if (s && s.error) {
                shieldStatusEl.textContent = `Unavailable — ${s.error}`;
            } else {
                shieldStatusEl.textContent = 'Offline (helper not running)';
            }
        } catch (error) {
            shieldStatusEl.textContent = 'Unavailable — ' + error.message;
        }
    };

    if (shieldCheckButton) {
        shieldCheckButton.addEventListener('click', refreshShieldStatus);
    }

    if (shieldExamModeButton) {
        shieldExamModeButton.addEventListener('click', async () => {
            if (!window.electronAPI || !window.electronAPI.shieldExamMode) return;
            shieldExamModeButton.disabled = true;
            shieldExamModeButton.textContent = 'Configuring…';
            try {
                // Integrated display by default: showWindow:false keeps the
                // helper headless and answers render in the CHAT window (the
                // Cluely UI stays visible — chat, question types, mic, typing).
                // The checkbox opts into the root-drawn backup window.
                const result = await window.electronAPI.shieldExamMode({
                    showWindow: shieldShowWindowCheckbox ? shieldShowWindowCheckbox.checked : false
                });
                if (result && result.ok === true) {
                    // The chat stays visible as the surface; only this settings
                    // window and the overlay hide. ⌃⌥⇧E or the chat's 🛡️ button
                    // is the restore path.
                    shieldExamModeButton.textContent = 'Exam mode armed — chat stays on top (⌃⌥⇧E to restore)';
                } else {
                    shieldExamModeButton.disabled = false;
                    shieldExamModeButton.textContent = 'Enter Exam Mode';
                    const err = (result && result.error) || 'unknown error';
                    if (shieldStatusEl) shieldStatusEl.textContent = 'Failed — ' + err;
                }
            } catch (error) {
                shieldExamModeButton.disabled = false;
                shieldExamModeButton.textContent = 'Enter Exam Mode';
                if (shieldStatusEl) shieldStatusEl.textContent = 'Failed — ' + error.message;
            }
        });
    }

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
        refreshShieldStatus();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });

    // Tell the main process when the user clicks into an input, so the
    // keystroke-capture mode routes keystrokes to this window.
    document.addEventListener('focusin', (e) => {
        const target = e.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            if (window.api && window.api.send) window.api.send('input-target-focused');
        }
    });
}); 
