'use strict';
const { randomUUID } = require('node:crypto');
const DURATION_MS = 90 * 60 * 1000;
const clone = value => JSON.parse(JSON.stringify(value));
const invalid = message => Object.assign(new Error(message), { code: 'PLAYGROUND_STATE' });

// Owns the exam lifecycle only. Materials and answering stay in their existing services.
class PlaygroundSession {
  constructor({ now = Date.now, questions } = {}) {
    if (typeof now !== 'function' || !Array.isArray(questions) || !questions.length || questions.length > 100) throw invalid('The exam questions are unavailable.');
    const ids = new Set();
    this.questions = questions.map(q => {
      if (!q || typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(q.id) || ids.has(q.id) || typeof q.title !== 'string' || typeof q.text !== 'string' || !q.text.trim() || q.text.length > 16000) throw invalid('Invalid exam question.');
      ids.add(q.id);
      return Object.freeze({ id: q.id, title: q.title.slice(0, 200), text: q.text,
        ...(Array.isArray(q.choices) ? { choices: Object.freeze(q.choices.map(s => String(s).slice(0, 2000))) } : {}) });
    });
    Object.freeze(this.questions);
    this.now = now;
    this.generation = 0;
    this.clear();
  }

  clear() {
    this.generation++;
    this.state = { phase: 'idle', mode: null, runId: null, expiresAt: null, materialSession: null,
      questionIndex: 0, answers: {}, focusAcknowledgementRequired: false, exitConfirmationRequired: false, exitReason: null };
    return this.status();
  }

  _expire() {
    if (this.state.expiresAt !== null && this.now() >= this.state.expiresAt && this.state.phase !== 'expired') {
      this.generation++;
      Object.assign(this.state, { phase: 'expired', answers: {}, focusAcknowledgementRequired: false, exitConfirmationRequired: false });
    }
  }

  status() { this._expire(); return clone({ ...this.state, generation: this.generation, questionCount: this.questions.length }); }
  snapshot() { this._expire(); return { runId: this.state.runId, generation: this.generation, expiresAt: this.state.expiresAt }; }
  accepts(snapshot) {
    this._expire();
    return Boolean(snapshot && snapshot.runId && this.state.phase === 'running' && !this.state.focusAcknowledgementRequired && !this.state.exitConfirmationRequired && snapshot.runId === this.state.runId && snapshot.generation === this.generation);
  }
  _requireRunning() {
    if (!this.accepts(this.snapshot())) throw invalid('The exam is paused, ended, or has expired.');
  }

  start({ mode, materialSession = null } = {}) {
    this._expire();
    if (this.state.phase === 'running') throw invalid('Finish or exit this run before starting another.');
    if (!['restriction', 'diagnostic'].includes(mode)) throw invalid('Choose a restriction or diagnostic run.');
    let expiresAt = this.now() + DURATION_MS;
    if (materialSession !== null) {
      if (!materialSession || typeof materialSession.sessionId !== 'string' || !materialSession.sessionId.length || materialSession.sessionId.length > 200 || /[\x00-\x1f]/.test(materialSession.sessionId) || !Number.isSafeInteger(materialSession.generation) || materialSession.generation < 0 || !Number.isSafeInteger(materialSession.expiresAt) || materialSession.expiresAt <= this.now()) throw invalid('Start an unexpired materials session first.');
      expiresAt = materialSession.expiresAt;
    }
    this.generation++;
    this.state = { phase: 'running', mode, runId: randomUUID(), expiresAt,
      materialSession: materialSession ? clone(materialSession) : null,
      questionIndex: 0, answers: {}, focusAcknowledgementRequired: false, exitConfirmationRequired: false, exitReason: null };
    return this.status();
  }

  saveAnswer(questionId, text) {
    this._requireRunning();
    if (!this.questions.some(q => q.id === questionId) || typeof text !== 'string' || text.length > 16000) throw invalid('Choose an exam question and enter at most 16,000 characters.');
    this.state.answers[questionId] = text;
    return this.status();
  }
  goToQuestion(index) {
    this._requireRunning();
    if (!Number.isInteger(index) || index < 0 || index >= this.questions.length) throw invalid('That question is unavailable.');
    this.state.questionIndex = index;
    return this.status();
  }
  focusLost() {
    this._expire();
    if (this.state.phase === 'running' && this.state.mode === 'restriction' && !this.state.focusAcknowledgementRequired) {
      this.generation++;
      this.state.focusAcknowledgementRequired = true;
    }
    return this.status();
  }
  acknowledgeFocus() {
    this._expire();
    if (this.state.phase !== 'running') throw invalid('This run has ended.');
    this.state.focusAcknowledgementRequired = false;
    return this.status();
  }
  requestExit() {
    this._expire();
    if (this.state.phase !== 'running') throw invalid('There is no running exam to exit.');
    this.generation++;
    this.state.exitConfirmationRequired = true;
    return this.status();
  }
  cancelExit() {
    this._expire();
    if (this.state.phase !== 'running') throw invalid('This run has ended.');
    this.state.exitConfirmationRequired = false;
    return this.status();
  }
  confirmExit(reason) {
    this._expire();
    if (this.state.phase !== 'running' || !this.state.exitConfirmationRequired || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw invalid('Enter a short reason for leaving the exam.');
    this.generation++;
    Object.assign(this.state, { phase: 'exited', exitReason: reason.trim(), exitConfirmationRequired: false, focusAcknowledgementRequired: false });
    return this.status();
  }
  finish() {
    this._requireRunning();
    this.generation++;
    Object.assign(this.state, { phase: 'completed', exitConfirmationRequired: false, focusAcknowledgementRequired: false });
    return this.status();
  }
}
module.exports = { PlaygroundSession, DURATION_MS };
