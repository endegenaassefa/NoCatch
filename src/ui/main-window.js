// Simple logger for renderer process
const logger = {
    info: (...args) => console.log('[MainWindowUI]', ...args),
    debug: (...args) => console.log('[MainWindowUI DEBUG]', ...args),
    error: (...args) => console.error('[MainWindowUI ERROR]', ...args),
    warn: (...args) => console.warn('[MainWindowUI WARN]', ...args)
};

class MainWindowUI {
    constructor() {
        this.isInteractive = false;
        this.isHidden = false;
        this.currentSkill = 'dsa'; // Default, will be updated from settings
        this.statusDot = null;
        this.skillIndicator = null;
        this.micButton = null;
        this.isRecording = false;
        this.speechAvailable = false; // track availability
        this._popoverHideTimeout = null;
        // Only the main renderer owns microphone commands. Recording broadcasts
        // below update UI state; they never acquire a device.
        this.microphoneCapture = new window.MicrophoneCapture({ api: window.electronAPI });
        this._unsubscribeMicrophone = window.electronAPI.onMicrophoneCommand(command => this.microphoneCapture.handle(command));
        window.addEventListener('pagehide', () => {
            this._unsubscribeMicrophone();
            this.microphoneCapture.dispose();
        }, { once: true });

        // Define available skills for navigation
        this.availableSkills = [
            'dsa', 'ood', 'mcq', 'system-design', 'behavioral', 'programming'
        ];
        
        this.init();
    }

    async init() {
        try {
            this.setupElements();
            this.setupEventListeners();
            this.setupExamLayout();
            
            // Load current skill from settings
            await this.loadCurrentSkill();
            
            // Load current interaction state
            await this.loadCurrentInteractionState();
            
            // Fetch speech availability
            await this.loadSpeechAvailability();
            
            this.updateSkillIndicator();
            this.updateAllElementStates(); // Update all elements with current state
            await this.refreshShortcutStatus();
            this.resizeWindowToContent();
            
            logger.info('Main window UI initialized', {
                component: 'MainWindowUI',
                skill: this.currentSkill,
                interactive: this.isInteractive
            });

            // Notify the main process that the overlay renderer is ready
            // so it can push the latest speech availability state.
            if (window.electronAPI && window.electronAPI.notifyMainWindowReady) {
                window.electronAPI.notifyMainWindowReady();
            }
            
        } catch (error) {
            logger.error('Failed to initialize main window UI', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadCurrentSkill() {
        try {
            if (window.electronAPI && window.electronAPI.getSettings) {
                const settings = await window.electronAPI.getSettings();
                if (settings && settings.activeSkill) {
                    this.currentSkill = settings.activeSkill;
                    logger.debug('Loaded current skill from settings', {
                        component: 'MainWindowUI',
                        skill: this.currentSkill
                    });
                }
            }
        } catch (error) {
            logger.warn('Failed to load current skill from settings', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadCurrentInteractionState() {
        try {
            // Request current interaction state from main process
            if (window.electronAPI && window.electronAPI.getWindowStats) {
                const stats = await window.electronAPI.getWindowStats();
                if (stats && typeof stats.isInteractive === 'boolean') {
                    this.isInteractive = stats.isInteractive;
                    logger.debug('Loaded current interaction state', {
                        component: 'MainWindowUI',
                        interactive: this.isInteractive
                    });
                }
            }
        } catch (error) {
            // If we can't get the state, assume non-interactive (safer default)
            this.isInteractive = false;
            logger.warn('Failed to load current interaction state, defaulting to non-interactive', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadSpeechAvailability() {
        try {
            if (window.electronAPI && window.electronAPI.getSpeechAvailability) {
                this.speechAvailable = await window.electronAPI.getSpeechAvailability();
                this.applyMicVisibility();
            }
        } catch (e) {
            this.speechAvailable = false;
            this.applyMicVisibility();
        }
    }

    applyMicVisibility() {
        if (this.micButton) {
            if (this.speechAvailable || this.isRecording) {
                this.micButton.style.display = '';
            } else {
                this.micButton.style.display = 'none';
            }
            // Resize to reflect layout change
            setTimeout(() => this.resizeWindowToContent(), 50);
        }
    }

    updateAllElementStates() {
        // Update all interactive elements with current state
        this.updateStatusDot();
        this.updateSkillIndicatorState();
        this.updateMicButtonState();
        this.updateSettingsIndicatorState();
    }

    updateStatusDot() {
        if (this.statusDot) {
            logger.debug('Updating status dot', {
                component: 'MainWindowUI',
                isInteractive: this.isInteractive,
                currentClasses: this.statusDot.className
            });
            
            // Remove both classes first
            this.statusDot.title = this.isInteractive ? 'Controls enabled' : 'Click-through · press Alt+A to use controls';
            this.statusDot.setAttribute('aria-label', this.statusDot.title);
            this.statusDot.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.statusDot.classList.add('interactive');
            } else {
                this.statusDot.classList.add('non-interactive');
            }
            
            logger.debug('Status dot updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                newClasses: this.statusDot.className
            });
        } else {
            logger.error('Status dot element not found');
        }
    }

    updateSkillIndicatorState() {
        if (this.skillIndicator) {
            // Remove both classes first
            this.skillIndicator.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.skillIndicator.classList.add('interactive');
            } else {
                this.skillIndicator.classList.add('non-interactive');
            }
            
            logger.debug('Skill indicator state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                classes: this.skillIndicator.className
            });
        }
    }

    updateMicButtonState() {
        if (this.micButton) {
            // Also hide when unavailable
            this.applyMicVisibility();
            // Remove both classes first
            this.micButton.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.micButton.classList.add('interactive');
            } else {
                this.micButton.classList.add('non-interactive');
            }
            
            // Update button state
            this.micButton.disabled = !this.isInteractive;
            
            logger.debug('Mic button state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                disabled: !this.isInteractive
            });
        }
    }

    updateSettingsIndicatorState() {
        if (this.settingsIndicator) {
            // Remove both classes first
            this.settingsIndicator.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.settingsIndicator.classList.add('interactive');
            } else {
                this.settingsIndicator.classList.add('non-interactive');
            }
            
            logger.debug('Settings indicator state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive
            });
        } else {
            logger.debug('Settings indicator not found, skipping state update');
        }
    }

    setupExamLayout() {
        const api = window.electronAPI;
        const byId = id => document.getElementById(id);
        const setup = byId('toolbarPanelSetup');
        const movement = byId('toolbarMovementKeys');
        const display = byId('toolbarDisplay');
        const status = byId('toolbarPanelStatus');
        const lock = byId('toolbarLayoutStatus');
        let dirty = false, revisions = 0;
        const fill = (select, entries, value) => {
            const signature = JSON.stringify(entries);
            if (select.dataset.options !== signature) {
                const previous = select.value;
                select.replaceChildren(...entries.map(([key, label]) => new Option(label, key)));
                select.dataset.options = signature;
                if (dirty && entries.some(([key]) => String(key) === previous)) select.value = previous;
            }
            if (!dirty) select.value = String(value ?? '');
        };
        const apply = state => {
            const previous = this.examState;
            this.examState = state;
            document.documentElement.style.setProperty("--exam-bar-height", `${state.compactHeight || 34}px`);
            document.documentElement.style.setProperty("--exam-menu-top", `${state.menuTop ?? (state.compactHeight || 34) + 8}px`);
            document.documentElement.classList.toggle('exam-layout', Boolean(state.enabled));
            setup.hidden = !state.supported;
            lock.hidden = !state.enabled;
            byId('toolbarExamToggle').hidden = !state.supported;
            byId('toolbarExamToggle').textContent = state.enabled ? 'Return to normal layout' : 'Use Exam layout';
            byId('openChatButton').setAttribute('aria-expanded', String(Boolean(state.chatOpen && state.coreVisible)));
            if (state.chatOpen && state.coreVisible) this.chatNotice = '';
            this.updateChatNotice();
            const message = state.enabled ? state.error || (state.saveError ? 'Position could not be saved. Controls remain available.' : '') : '';
            status.textContent = message;
            status.hidden = !message;
            const unavailable = state.movement !== 'ready';
            lock.classList.toggle('movement-unavailable', unavailable || Boolean(message));
            lock.title = message || (unavailable ? 'Movement unavailable · More → Panel setup to retry' : `Position locked · ${state.modifier}+arrows to move`);
            lock.setAttribute('aria-label', `${lock.title}. Open Panel setup`);
            byId('toolbarMovementHint').textContent = `${state.modifier}+arrows moves the toolbar and open chat. Tap for a small step; hold to keep moving.`;
            fill(movement, (state.modifiers || []).map(key => [key, `${key}+arrows`]), state.modifier);
            fill(display, (state.displays || []).map(item => [item.id, item.label]), state.displayId);
            if (state.enabled && state.menuMaxHeight) this.shortcutsPopover.style.maxHeight = `${state.menuMaxHeight}px`;
            if (previous?.enabled !== state.enabled || previous?.menuMaxHeight !== state.menuMaxHeight || previous?.compactHeight !== state.compactHeight || previous?.menuTop !== state.menuTop) this.resizeWindowToContent();
        };
        api.onExamLayoutChanged?.(state => { revisions++; apply(state); });
        const revision = revisions;
        api.getExamLayout?.().then(state => { if (revision === revisions) apply(state); }).catch(() => {
            status.textContent = 'Panel setup unavailable. Reopen NoCatch to retry.';
            status.hidden = false;
        });
        api.onToolbarMenuClose?.(() => this.hideShortcutsPopover());
        api.onChatPanelHidden?.(() => this.hideShortcutsPopover());
        const configure = async (extra = {}) => {
            const feedback = byId('toolbarSetupStatus');
            feedback.textContent = 'Saving…';
            try {
                const result = await api.configureExamLayout({ modifier: movement.value, displayId: Number(display.value), ...extra });
                if (!result.success) throw new Error(result.error);
                dirty = false;
                apply(result.state);
                feedback.textContent = result.state.error || (result.state.saveError ? 'Could not save position. Current setup remains usable.' : 'Setup saved.');
            } catch (error) { feedback.textContent = error.message; }
            this.resizeWindowToContent();
        };
        movement.addEventListener('change', () => { dirty = true; });
        display.addEventListener('change', () => { dirty = true; });
        setup.addEventListener('toggle', () => this.resizeWindowToContent());
        byId('toolbarSaveSetup').addEventListener('click', () => configure());
        byId('toolbarResetPosition').addEventListener('click', () => configure({ resetPosition: true }));
        lock.addEventListener('click', () => { this.showShortcutsPopover(); setup.open = true; movement.focus(); });
        byId('toolbarExamToggle').addEventListener('click', async () => {
            try {
                const result = await api.setExamLayout(!this.examState?.enabled);
                if (!result.success) throw new Error(result.error);
                apply(result.state);
                this.hideShortcutsPopover();
            } catch (error) { status.textContent = error.message; status.hidden = false; }
        });
        const notice = text => {
            if (this.examState?.enabled && !(this.examState.chatOpen && this.examState.coreVisible)) {
                this.chatNotice = text;
                this.updateChatNotice();
            }
        };
        api.onLlmResponse?.(() => notice('Chat ready'));
        api.onTranscriptionLlmResponse?.(() => notice('Chat ready'));
        api.onLlmError?.(() => notice('Chat error'));
        api.onOcrError?.(() => notice('Chat error'));
        api.onSpeechError?.(() => notice('Chat error'));
    }

    updateChatNotice() {
        const button = document.getElementById('openChatButton');
        const label = button?.querySelector('span');
        if (label) label.textContent = this.chatNotice || 'Chat';
        button?.setAttribute('aria-label', `${this.chatNotice || 'Chat'} · Ctrl+Shift+C`);
        button?.classList.toggle('chat-ready', Boolean(this.chatNotice));
    }

    resizeWindowToContent() {
        // Wait for DOM to fully render
        setTimeout(() => {
            const commandTab = document.querySelector('.command-tab');
            if (commandTab && window.electronAPI && window.electronAPI.resizeWindow) {
                const rect = commandTab.getBoundingClientRect();
                const width = Math.ceil(rect.width);
                let height = Math.ceil(rect.height);

                // If shortcuts popover is visible, extend height to fit it
                if (this.shortcutsPopover && this.shortcutsPopover.classList.contains('is-open')) {
                    const popRect = this.shortcutsPopover.getBoundingClientRect();
                    // Include the complete preference panel below the compact bar.
                    height = Math.max(height, Math.ceil(popRect.bottom + 8));
                }
                
                logger.debug('Resizing window to content', {
                    width,
                    height,
                    component: 'MainWindowUI'
                });
                
                window.electronAPI.resizeWindow(width, height, this.examState?.menuRevision);
            }
        }, 100);
    }

    setupElements() {
        this.statusDot = document.getElementById('statusDot');
        this.skillIndicator = document.getElementById('skillIndicator');
        this.settingsIndicator = document.getElementById('settingsIndicator'); // Optional
        this.micButton = document.getElementById('micButton');
    this.infoButton = document.getElementById('infoButton');
    this.shortcutsPopover = document.getElementById('shortcutsPopover');
    this.captureIndicator = document.getElementById('captureIndicator'); // Optional

        // Prefer the named capture action; retain the legacy fallback for older fixtures.
        const commandItems = document.querySelectorAll('.command-item');
        this.screenshotButton = document.getElementById('captureButton') || (commandItems && commandItems[0]);

    if (!this.statusDot || !this.skillIndicator || !this.micButton || !this.screenshotButton) {
            throw new Error('Required UI elements not found');
        }

        // Screenshot click handler
        this.screenshotButton.addEventListener('click', () => {
            if (this.isInteractive && window.electronAPI && window.electronAPI.takeScreenshot) {
                window.electronAPI.takeScreenshot();
            }
        });

        // Ordinary actions stay visible; less frequent preferences live in More.
        for (const [id, method] of [['openChatButton','switchToChat'], ['openMaterialsButton','showMaterials'], ['openSettingsButton','showSettings']]) {
            document.getElementById(id)?.addEventListener('click', async () => {
                if (!this.isInteractive) return;
                try { await window.electronAPI[method](); this.hideShortcutsPopover(); }
                catch (error) { this.showNotification(error.message || 'Please try again.', 'error'); }
            });
        }
        this.toolbarSkillSelect = document.getElementById('toolbarSkillSelect');
        this.toolbarSkillSelect?.addEventListener('change', async event => {
            if (!this.isInteractive) return;
            try { await window.electronAPI.updateActiveSkill(event.target.value); this.handleSkillActivated(event.target.value); }
            catch (error) { this.toolbarSkillSelect.value = this.currentSkill; this.showNotification(error.message, 'error'); }
        });
        this.shortcutsPopover?.querySelector('.shortcut-details')?.addEventListener('toggle', () => this.resizeWindowToContent());

        // Check for required elements (settingsIndicator is optional)
        if (this.settingsIndicator) {
            this.settingsIndicator.addEventListener('click', () => {
                if (this.isInteractive) {
                    this.showSettingsMenu();
                }
            });
        }

        // Add click handler for microphone
        this.micButton.addEventListener('click', async () => {
            if (this.isInteractive && this.speechAvailable) {
                try {
                    await window.electronAPI.toggleSpeechRecognition();
                } catch (error) {
                    logger.error('Speech recognition toggle failed', {
                        component: 'MainWindowUI',
                        error: error.message
                    });
                    this.isRecording = false;
                    this.updateMicButtonState();
                }
            } else if (this.isInteractive && !this.speechAvailable) {
                logger.warn('Mic clicked but speech recognition is not available', {
                    component: 'MainWindowUI'
                });
                this.loadSpeechAvailability();
            }
        });

        // Language dropdown
        this.languageSelect = document.getElementById('codingLanguage');
        if (this.languageSelect) {
            // Set default to C++ if no value is set
            this.languageSelect.value = 'cpp';
            
            // Initialize with current setting
            if (window.electronAPI && window.electronAPI.getSettings) {
                window.electronAPI.getSettings().then(settings => {
                    if (settings && settings.codingLanguage) {
                        this.languageSelect.value = settings.codingLanguage;
                    } else {
                        // Save C++ as default if no language is set
                        this.languageSelect.value = 'cpp';
                        window.electronAPI.saveSettings({ codingLanguage: 'cpp' });
                    }
                }).catch(() => {
                    // Fallback to C++ on error
                    this.languageSelect.value = 'cpp';
                });
            }

            this.languageSelect.addEventListener('change', (e) => {
                const lang = e.target.value;
                if (window.electronAPI && window.electronAPI.saveSettings) {
                    window.electronAPI.saveSettings({ codingLanguage: lang });
                }
                // Keep the open preferences panel inside the native window.
                this.resizeWindowToContent();
            });
        }

        // Info button / shortcuts popover
        if (this.infoButton && this.shortcutsPopover) {
            // de-0002 E9: palette "Shortcuts popover" entry toggles it
            // without any cursor travel (Q071: reuses the existing handler).
            if (window.electronAPI && window.electronAPI.onToggleShortcutsPopover) {
                window.electronAPI.onToggleShortcutsPopover(() => {
                    if (this.isInteractive) this.toggleShortcutsPopover();
                });
            }

            this.infoButton.addEventListener('click', (e) => {
                if (!this.isInteractive) return;
                e.stopPropagation();
                this.toggleShortcutsPopover();
            });

            // Close on outside click
            document.addEventListener('click', (e) => {
                if (!this.shortcutsPopover) return;
                const isClickInside = this.shortcutsPopover.contains(e.target) || this.infoButton.contains(e.target);
                if (!isClickInside && this.shortcutsPopover.classList.contains('is-open')) {
                    this.hideShortcutsPopover();
                }
            });

            // Close on Escape
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.shortcutsPopover && this.shortcutsPopover.classList.contains('is-open')) {
                    this.hideShortcutsPopover();
                }
            });
        }
    }

    setupEventListeners() {
        if (window.electronAPI) {
            // Fix interaction mode change listener
            window.electronAPI.onInteractionModeChanged((event, interactive) => {
                logger.debug('Interaction mode changed received:', interactive);
                this.handleInteractionModeChanged(interactive);
            });

            window.electronAPI.onRecordingStarted(() => {
                this.handleRecordingStarted();
            });

            window.electronAPI.onRecordingStopped(() => {
                this.handleRecordingStopped();
            });

            window.electronAPI.onSkillChanged((event, data) => {
                if (data && data.skill) {
                    this.handleSkillChanged(data);
                }
            });

            window.electronAPI.onSpeechAvailability((event, data) => {
                this.speechAvailable = !!(data && data.available);
                this.applyMicVisibility();
            });

            // Keystroke-capture mode indicator on the overlay bar.
            if (window.electronAPI.onCaptureModeChanged && this.captureIndicator) {
                window.electronAPI.onCaptureModeChanged((event, data) => {
                    const active = !!(data && data.active);
                    this.captureIndicator.style.display = active ? '' : 'none';
                    if (active) this.captureIndicator.classList.add('active');
                    else this.captureIndicator.classList.remove('active');
                });
            }
            if (window.electronAPI.onCaptureModeError) {
                window.electronAPI.onCaptureModeError((event, data) => {
                    if (data && data.message) {
                        logger.error('Capture mode error', { error: data.message });
                    }
                });
            }

            // Listen for coding language changes from other windows
            window.electronAPI.onCodingLanguageChanged((event, data) => {
                if (data && data.language && this.languageSelect) {
                    // avoid clobbering if same value
                    if (this.languageSelect.value !== data.language) {
                        this.languageSelect.value = data.language;
                    }
                    logger.debug('Language updated from other window', {
                        component: 'MainWindowUI',
                        language: data.language
                    });
                }
            });

            // Listen for main window shown event to refresh speech availability
            window.electronAPI.onMainWindowShown(() => {
                logger.debug('Main window shown - refreshing speech availability', {
                    component: 'MainWindowUI'
                });
                this.loadSpeechAvailability();
            });
            
            // The main process owns Alt+R; do not toggle it a second time
            // from a focused renderer's keydown event.
        }
        
        // Also listen via the api interface for backup
        if (window.api) {
            
            window.api.receive('interaction-mode-changed', (interactive) => {
                logger.debug('Interaction mode changed via api:', interactive);
                this.handleInteractionModeChanged(interactive);
            });
            
            window.api.receive('skill-updated', (data) => {
                logger.info('Skill updated event received from main process:', data);
                if (data && data.skill) {
                    this.handleSkillChanged(data);
                } else if (typeof data === 'string') {
                    // Handle case where skill is passed directly as string
                    this.handleSkillChanged({ skill: data });
                } else {
                    logger.warn('Skill updated event received but no skill data found:', data);
                }
            });
            
            // Listen for skill updates from settings window  
            window.api.receive('update-skill', (skill) => {
                logger.info('Direct skill update received from settings:', skill);
                this.handleSkillChanged({ skill: skill });
            });
        } else {
            logger.error('window.api not available - event listeners not set up!');
        }
        
        // Keyboard shortcuts
        this.setupKeyboardShortcuts();
        
        // Settings shortcut
        this.setupSettingsShortcut();
    }

    handleLLMResponse(data) {
        const skill = data.skill || data.metadata?.skill || 'General';
        const skillNames = {
            'dsa': 'DSA',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        const displaySkill = skillNames[skill] || skill.toUpperCase();
        
        logger.info('LLM response received', {
            component: 'MainWindowUI',
            skill: skill,
            displaySkill: displaySkill
        });
    }

    handleLLMError(data) {
        logger.error('LLM error received', {
            component: 'MainWindowUI',
            error: data.error
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.metaKey && e.key === '\\') {
                this.isHidden = !this.isHidden;
                if (this.isHidden) {
                    this.showHiddenIndicator();
                }
            }
            
            // Handle Cmd + Arrow keys based on interaction mode
            if (e.metaKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();

                if (this.isInteractive) {
                    // Interactive mode: Cmd + Up/Down for skill navigation
                    if (e.key === 'ArrowUp') {
                        this.navigateSkill(-1); // Previous skill
                    } else if (e.key === 'ArrowDown') {
                        this.navigateSkill(1); // Next skill
                    } else {
                    }
                    // Left/Right arrows do nothing in interactive mode
                } else {
                    // Non-interactive mode: Cmd + Arrow keys for window movement
                    this.moveWindow(e.key);
                }
            }
            
            // Alt+A is handled globally by the main process
            // No need to handle it here since it needs to work even when windows are non-interactive
        });
    }

    handleInteractionModeChanged(interactive) {
        logger.info('Handling interaction mode change', {
            component: 'MainWindowUI',
            newState: interactive,
            previousState: this.isInteractive
        });
        
        // Update the internal state
        this.isInteractive = interactive;
        
        // Update all UI elements to reflect the new state
        this.updateAllElementStates();

        // Auto-hide popover when leaving interactive mode
        if (!this.isInteractive && this.shortcutsPopover && this.shortcutsPopover.style.display !== 'none') {
            this.hideShortcutsPopover();
        }
        
        // Update skill indicator tooltip
        this.updateSkillIndicator();
        
        logger.info('Interaction mode change completed', {
            component: 'MainWindowUI',
            interactive: this.isInteractive,
            statusDotClass: this.statusDot ? this.statusDot.className : 'not found',
            skillIndicatorClass: this.skillIndicator ? this.skillIndicator.className : 'not found'
        });
    }

    handleSkillChanged(data) {
        const oldSkill = this.currentSkill;
        this.currentSkill = data.skill;
        
        logger.info('Handling skill change', {
            component: 'MainWindowUI',
            oldSkill: oldSkill,
            newSkill: data.skill,
            skillIndicatorExists: !!this.skillIndicator
        });
        
        this.updateSkillIndicator();
        
        logger.info('Skill changed successfully', {
            component: 'MainWindowUI',
            skill: data.skill
        });
    }

    handleSkillActivated(skillName) {
        this.currentSkill = skillName;
        this.updateSkillIndicator();
        
        logger.info('Skill activated', {
            component: 'MainWindowUI',
            skill: skillName
        });
    }

    handleScreenshotRequest() {
        logger.debug('Screenshot request received', { component: 'MainWindowUI' });
    }

    handleRecordingStarted() {
        this.isRecording = true;
        if (this.micButton) {
            this.micButton.classList.add('recording');
            this.micButton.setAttribute('aria-label', 'Stop voice input');
            this.micButton.title = 'Stop voice input';
            this.micButton.querySelector('.voice-stop')?.removeAttribute('hidden');
            this.applyMicVisibility();
        }
        logger.debug('Recording started', { component: 'MainWindowUI' });
    }

    handleRecordingStopped() {
        this.isRecording = false;
        if (this.micButton) {
            this.micButton.classList.remove('recording');
            this.micButton.setAttribute('aria-label', 'Start voice input');
            this.micButton.title = 'Start voice input';
            this.micButton.querySelector('.voice-stop')?.setAttribute('hidden', '');
            this.applyMicVisibility();
        }
        logger.debug('Recording stopped', { component: 'MainWindowUI' });
    }

    updateSkillIndicator() {
        const skillNames = {
            'dsa': 'DSA',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        logger.info('Updating skill indicator', {
            component: 'MainWindowUI',
            currentSkill: this.currentSkill,
            skillIndicatorExists: !!this.skillIndicator
        });
        
        if (!this.skillIndicator) {
            logger.error('Skill indicator element not found!');
            return;
        }
        
        if (this.toolbarSkillSelect) this.toolbarSkillSelect.value = this.currentSkill;
        const skillName = skillNames[this.currentSkill] || this.currentSkill.toUpperCase();
        const skillSpan = this.skillIndicator.querySelector('span');
        
        logger.info('Looking for skill span element', {
            component: 'MainWindowUI',
            spanExists: !!skillSpan,
            skillName: skillName
        });
        
        if (skillSpan) {
            const oldText = skillSpan.textContent;
            skillSpan.textContent = skillName;
                        
            const tooltip = this.isInteractive ? 
                `${skillName} - Use ⌘↑/↓ to navigate skills` : 
                `${skillName} - Enable interactive mode (Alt+A) to navigate`;
            this.skillIndicator.title = tooltip;
            
            // Add visual feedback for skill change
            // Preference changes do not move the interface.
            
            logger.info('Skill indicator updated successfully', {
                component: 'MainWindowUI',
                oldText: oldText,
                newText: skillName,
                interactive: this.isInteractive
            });
        } else {
            logger.error('Skill span element not found within skill indicator!');
        }
    }

    animateSkillChange() {
        if (this.skillIndicator) {
            this.skillIndicator.style.transform = 'scale(1.1)';
            this.skillIndicator.style.transition = 'transform 0.2s ease';
            
            setTimeout(() => {
                this.skillIndicator.style.transform = 'scale(1)';
            }, 200);
        }
    }

    navigateSkill(direction) {
        
        if (!this.isInteractive) {
            return;
        }
        
        const currentIndex = this.availableSkills.indexOf(this.currentSkill);
        if (currentIndex === -1) {
            logger.error('Current skill not found in available skills array');
            return;
        }
        
        // Calculate new index with wrapping
        let newIndex = currentIndex + direction;
        if (newIndex >= this.availableSkills.length) {
            newIndex = 0; // Wrap to beginning
        } else if (newIndex < 0) {
            newIndex = this.availableSkills.length - 1; // Wrap to end
        }
        
        const newSkill = this.availableSkills[newIndex];
        
        // Update skill locally and notify main process
        this.currentSkill = newSkill;
        this.updateSkillIndicator();
        
        // Save the skill change via IPC
        if (window.electronAPI && window.electronAPI.updateActiveSkill) {
            window.electronAPI.updateActiveSkill(newSkill).then(() => {
                logger.info('Skill navigation completed', {
                    component: 'MainWindowUI',
                    newSkill,
                    direction: direction > 0 ? 'down' : 'up'
                });
            }).catch(error => {
                logger.error('Failed to update skill via navigation', {
                    component: 'MainWindowUI',
                    error: error.message
                });
            });
        }
        
        // Show visual feedback
        this.showSkillChangeNotification(newSkill, direction);
    }

    showSkillChangeNotification(skill, direction) {
        const skillNames = {
            'dsa': 'DSA',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        const displayName = skillNames[skill] || skill.toUpperCase();
        const arrow = direction > 0 ? '↓' : '↑';
        
        // Create temporary notification
        const notification = document.createElement('div');
        notification.className = 'skill-change-notification';
        notification.innerHTML = `${arrow} ${displayName}`;
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            z-index: 1000;
            opacity: 0;
            transition: opacity 0.2s ease;
        `;
        
        document.body.appendChild(notification);
        
        // Animate in
        setTimeout(() => {
            notification.style.opacity = '1';
        }, 10);
        
        // Remove after 1 second
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 200);
        }, 1000);
    }

    showHiddenIndicator() {
        const indicator = document.querySelector('.hidden-indicator');
        if (indicator) {
            indicator.classList.add('show');
            setTimeout(() => {
                indicator.classList.remove('show');
            }, 3000);
        }
    }

    toggleInteractiveMode() {
        this.isInteractive = !this.isInteractive;
        this.updateAllElementStates();
        
        logger.debug('Interactive mode toggled', {
            component: 'MainWindowUI',
            interactive: this.isInteractive
        });
    }

    moveWindow(direction) {
        const moveDistance = 20; // pixels
        
        if (window.electronAPI && window.electronAPI.moveWindow) {
            let deltaX = 0, deltaY = 0;
            
            switch(direction) {
                case 'ArrowUp':
                    deltaY = -moveDistance;
                    break;
                case 'ArrowDown':
                    deltaY = moveDistance;
                    break;
                case 'ArrowLeft':
                    deltaX = -moveDistance;
                    break;
                case 'ArrowRight':
                    deltaX = moveDistance;
                    break;
            }
            
            window.electronAPI.moveWindow(deltaX, deltaY);
            logger.debug('Moving window', {
                component: 'MainWindowUI',
                direction: direction,
                deltaX: deltaX,
                deltaY: deltaY,
                interactive: this.isInteractive
            });
        } else {
            logger.warn('moveWindow API not available', { component: 'MainWindowUI' });
        }
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `fixed top-4 right-4 p-4 rounded-lg text-white z-50 ${
            type === 'error' ? 'bg-red-600' : 
            type === 'success' ? 'bg-green-600' :
            'bg-blue-600'
        }`;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 5000);
        
        logger.debug('Notification shown', {
            component: 'MainWindowUI',
            message,
            type
        });
    }

    async showGeminiConfig() {
        try {
            const status = await window.electronAPI.getGeminiStatus();
            
            const modal = this.createGeminiConfigModal(status);
            document.body.appendChild(modal);
            
            logger.debug('Gemini config modal shown', { component: 'MainWindowUI' });
        } catch (error) {
            logger.error('Failed to show Gemini config', {
                component: 'MainWindowUI',
                error: error.message
            });
            this.showNotification('Failed to load Gemini configuration', 'error');
        }
    }

    createGeminiConfigModal(status) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
        modal.innerHTML = `
            <div class="bg-gray-900 text-white p-6 rounded-lg max-w-md w-full">
                <div class="flex justify-between items-center mb-4">
                    <h2 class="text-xl font-bold">🤖 Gemini Flash 1.5 Configuration</h2>
                    <button class="text-gray-400 hover:text-white" onclick="this.closest('.fixed').remove()">✕</button>
                </div>
                
                <div class="mb-4 p-3 rounded ${status.hasApiKey ? 'bg-green-900' : 'bg-red-900'}">
                    <p><strong>Status:</strong> ${status.hasApiKey ? 'Configured' : 'Not Configured'}</p>
                    <p><strong>Model:</strong> ${status.model}</p>
                </div>
                
                <div class="mb-4">
                    <label class="block text-sm font-medium mb-2">API Key:</label>
                    <input type="password" id="geminiApiKey" placeholder="Enter your Gemini API key" 
                           class="w-full p-2 bg-gray-800 border border-gray-600 rounded text-white">
                    <p class="text-xs text-gray-400 mt-1">
                        Get your API key from: <a href="https://aistudio.google.com/app/apikey" target="_blank" class="text-blue-400">Google AI Studio</a>
                    </p>
                </div>
                
                <div class="flex space-x-2">
                    <button onclick="mainWindowUI.configureGemini()" class="flex-1 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">
                        Configure
                    </button>
                    <button onclick="mainWindowUI.testGeminiConnection()" class="flex-1 bg-green-600 hover:bg-green-700 px-4 py-2 rounded">
                        Test Connection
                    </button>
                </div>
                
                <div class="mt-4 text-center">
                    <button class="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded" onclick="this.closest('.fixed').remove()">
                        Close
                    </button>
                </div>
            </div>
        `;
        return modal;
    }

    async configureGemini() {
        const apiKey = document.getElementById('geminiApiKey').value.trim();
        if (!apiKey) {
            this.showNotification('Please enter an API key', 'error');
            return;
        }
        
        try {
            const result = await window.electronAPI.setGeminiApiKey(apiKey);
            if (result.success) {
                this.showNotification('Gemini API key configured successfully!', 'success');
                document.querySelector('.fixed').remove();
                
                logger.info('Gemini API key configured', { component: 'MainWindowUI' });
            } else {
                this.showNotification(`Configuration failed: ${result.error}`, 'error');
                logger.error('Gemini configuration failed', {
                    component: 'MainWindowUI',
                    error: result.error
                });
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
            logger.error('Gemini configuration error', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async testGeminiConnection() {
        try {
            const result = await window.electronAPI.testGeminiConnection();
            if (result.success) {
                this.showNotification('Gemini connection test successful!', 'success');
                logger.info('Gemini connection test successful', { component: 'MainWindowUI' });
            } else {
                this.showNotification(`Connection test failed: ${result.error}`, 'error');
                logger.error('Gemini connection test failed', {
                    component: 'MainWindowUI',
                    error: result.error
                });
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
            logger.error('Gemini connection test error', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    setupSettingsShortcut() {
        document.addEventListener('keydown', (e) => {
            // Cmd+, or Ctrl+, for settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                logger.debug('Settings keyboard shortcut pressed');
                e.preventDefault();
                this.openSettings();
            }
        });
    }

    openSettings() {
        try {
            if (window.electronAPI && window.electronAPI.showSettings) {
                window.electronAPI.showSettings();
            } else {
                logger.error('electronAPI or showSettings not available');
                return;
            }
            
            // Add visual feedback
            if (this.settingsIndicator) {
                this.settingsIndicator.style.transform = 'scale(1.1)';
                this.settingsIndicator.style.transition = 'transform 0.2s ease';
                
                setTimeout(() => {
                    this.settingsIndicator.style.transform = 'scale(1)';
                }, 200);
            }
            
            logger.info('Settings window opened', { component: 'MainWindowUI' });
        } catch (error) {
            logger.error('Failed to open settings', {
                component: 'MainWindowUI',
                error: error.message
            });
            this.showNotification('Failed to open settings', 'error');
        }
    }

    showSettingsMenu() {
        const menu = document.createElement('div');
        menu.className = 'settings-menu';
        menu.style.cssText = `
            position: absolute;
            right: 10px;
            top: 35px;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(20px);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 8px 0;
            min-width: 150px;
            z-index: 1000;
        `;

        const settingsOption = this.createMenuItem('Settings', 'fa-cog', () => {
            this.openSettings();
            document.body.removeChild(menu);
        });

        const quitOption = this.createMenuItem('Quit', 'fa-power-off', () => {
            if (window.electronAPI && window.electronAPI.quit) {
                window.electronAPI.quit();
            }
        });

        menu.appendChild(settingsOption);
        menu.appendChild(this.createMenuSeparator());
        menu.appendChild(quitOption);

        // Add click outside listener to close menu
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && !this.settingsIndicator.contains(e.target)) {
                document.body.removeChild(menu);
                document.removeEventListener('click', closeMenu);
            }
        };
        document.addEventListener('click', closeMenu);

        document.body.appendChild(menu);
    }

    createMenuItem(text, iconClass, onClick) {
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 8px 16px;
            color: rgba(255, 255, 255, 0.9);
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
        `;
        item.innerHTML = `<i class="fas ${iconClass}"></i>${text}`;
        item.addEventListener('mouseover', () => {
            item.style.background = 'rgba(255, 255, 255, 0.1)';
        });
        item.addEventListener('mouseout', () => {
            item.style.background = 'transparent';
        });
        item.addEventListener('click', onClick);
        return item;
    }

    createMenuSeparator() {
        const separator = document.createElement('div');
        separator.style.cssText = `
            height: 1px;
            background: rgba(255, 255, 255, 0.1);
            margin: 8px 0;
        `;
        return separator;
    }

    async refreshShortcutStatus() {
        if (!window.electronAPI?.getShortcutStatus) return;
        try {
            const status = await window.electronAPI.getShortcutStatus();
            if (this.shortcutsPopover && !this.examState?.enabled) this.shortcutsPopover.style.maxHeight = `${Math.max(160, Math.min(600, window.screen.availHeight - 100))}px`;
            const modifier = status.platform === 'darwin' ? 'Cmd' : 'Ctrl';
            const captureInstructions = document.getElementById('captureModeShortcuts');
            if (captureInstructions) captureInstructions.hidden = !(status.platform === 'darwin' &&
                status.shortcuts?.some(shortcut => shortcut.id === 'keystroke-capture' && shortcut.supported));
            const label = document.getElementById('captureShortcutLabel');
            if (label) label.textContent = `${modifier}+Shift+S`;
            if (this.screenshotButton) this.screenshotButton.title = `Capture your screen (${modifier}+Shift+S)`;
            const body = this.shortcutsPopover?.querySelector('.shortcuts-table tbody');
            if (!body || !Array.isArray(status.shortcuts)) return;
            body.replaceChildren();
            for (const shortcut of status.shortcuts) {
                const row = document.createElement('tr');
                row.dataset.shortcutId = shortcut.id;
                const chord = document.createElement('td');
                chord.textContent = shortcut.accelerator.replace('CommandOrControl', modifier);
                const action = document.createElement('td');
                action.textContent = shortcut.action;
                if (!shortcut.registered) {
                    const detail = document.createElement('div');
                    detail.textContent = shortcut.reason || 'Shortcut unavailable';
                    detail.style.cssText = 'font-size:11px;color:#e9b878;margin-top:4px';
                    action.appendChild(detail);
                }
                row.append(chord, action);
                body.appendChild(row);
            }
            this.resizeWindowToContent();
        } catch (_) {
            const body = this.shortcutsPopover?.querySelector('.shortcuts-table tbody');
            if (body) {
                const row = document.createElement('tr');
                const cell = document.createElement('td');
                cell.colSpan = 2;
                cell.textContent = 'Shortcut status is unavailable. Restart NoCatch and try again.';
                row.appendChild(cell);
                body.replaceChildren(row);
            }
        }
    }

    toggleShortcutsPopover() {
        if (!this.shortcutsPopover) return;
    const isOpen = this.shortcutsPopover.classList.contains('is-open');
    if (!isOpen) {
            this.showShortcutsPopover();
        } else {
            this.hideShortcutsPopover();
        }
    }

    showShortcutsPopover() {
        if (!this.shortcutsPopover) return;
        if (this._popoverHideTimeout) {
            clearTimeout(this._popoverHideTimeout);
            this._popoverHideTimeout = null;
        }
    this.shortcutsPopover.inert = false;
    this.infoButton?.setAttribute('aria-expanded', 'true');
    this.shortcutsPopover.classList.add('is-open');
        this.refreshShortcutStatus();
        // Resize main window to fit popover
        setTimeout(() => this.resizeWindowToContent(), 50);
    }

    hideShortcutsPopover() {
        if (!this.shortcutsPopover || !this.shortcutsPopover.classList.contains('is-open')) return;
    if (this.shortcutsPopover.contains(document.activeElement)) this.infoButton?.focus();
    this.shortcutsPopover.inert = true;
    this.infoButton?.setAttribute('aria-expanded', 'false');
    this.shortcutsPopover.classList.remove('is-open');
    for (const details of this.shortcutsPopover.querySelectorAll('details[open]')) details.open = false;
    // resize back to compact after transition
    setTimeout(() => this.resizeWindowToContent(), 130);
    }

    queueHideShortcutsPopover() {
        if (!this.shortcutsPopover) return;
        if (this._popoverHideTimeout) clearTimeout(this._popoverHideTimeout);
        this._popoverHideTimeout = setTimeout(() => this.hideShortcutsPopover(), 180);
    }
}

// Initialize when DOM is ready
let mainWindowUI;
if (typeof document !== 'undefined') {
    // Add immediate visual indicator that script is loading
    const style = document.createElement('style');
    document.head.appendChild(style);
    
    document.addEventListener('DOMContentLoaded', () => {
                
        mainWindowUI = new MainWindowUI();
        // Make it globally accessible for debugging
        window.mainWindowUI = mainWindowUI;
        logger.info('MainWindowUI initialized and available as window.mainWindowUI');
    });
}

// module.exports = MainWindowUI; // Not needed in browser context