/**
 * Plain-Node verification for the multi-skill engineering changes.
 *
 * Uses Node's built-in test runner (node:test) — no external dependencies.
 *
 * Run:
 *   node --test scripts/test-multi-skill.js
 *
 * Covers:
 *   - prompt-loader.js: skill loading, language injection, skill normalization
 *   - llm.service.js: formatImageInstruction() per-skill instructions
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { PromptLoader } = require('../prompt-loader');
const llmService = require('../src/services/llm.service');

// ---------------------------------------------------------------------------
// PromptLoader
// ---------------------------------------------------------------------------

test('loads all required skill prompts (dsa, ood, mcq, system-design, behavioral)', () => {
  const loader = new PromptLoader();
  const skills = loader.getAvailableSkills();

  for (const required of ['dsa', 'ood', 'mcq', 'system-design', 'behavioral']) {
    assert.ok(skills.includes(required), `missing skill: ${required}`);
  }
});

test('getSkillPrompt returns a prompt for ood', () => {
  const loader = new PromptLoader();
  const prompt = loader.getSkillPrompt('ood');
  assert.ok(prompt, 'expected a non-empty ood prompt');
  assert.ok(prompt.includes('Object-Oriented Design'));
});

test('getSkillPrompt returns a prompt for mcq', () => {
  const loader = new PromptLoader();
  const prompt = loader.getSkillPrompt('mcq');
  assert.ok(prompt, 'expected a non-empty mcq prompt');
  assert.ok(prompt.includes('Multiple Choice'));
});

test('injects programming language for dsa', () => {
  const loader = new PromptLoader();
  const prompt = loader.getSkillPrompt('dsa', 'python');
  assert.ok(prompt.includes('IMPLEMENTATION LANGUAGE: PYTHON'));
});

test('injects programming language for ood', () => {
  const loader = new PromptLoader();
  const prompt = loader.getSkillPrompt('ood', 'java');
  assert.ok(prompt.includes('PROGRAMMING LANGUAGE: JAVA'));
});

test('does NOT inject programming language for mcq', () => {
  const loader = new PromptLoader();
  const prompt = loader.getSkillPrompt('mcq', 'python');
  assert.ok(!prompt.includes('PROGRAMMING LANGUAGE'), 'mcq should not receive language injection');
});

test('does NOT inject programming language for behavioral', () => {
  const loader = new PromptLoader();
  const prompt = loader.getSkillPrompt('behavioral', 'python');
  assert.ok(!prompt.includes('PROGRAMMING LANGUAGE'), 'behavioral should not receive language injection');
});

test('skillsRequiringProgrammingLanguage is [dsa, ood]', () => {
  const loader = new PromptLoader();
  assert.deepStrictEqual(loader.getSkillsRequiringProgrammingLanguage(), ['dsa', 'ood']);
});

test('normalizeSkillName passes through ood/mcq/behavioral', () => {
  const loader = new PromptLoader();
  assert.strictEqual(loader.normalizeSkillName('ood'), 'ood');
  assert.strictEqual(loader.normalizeSkillName('mcq'), 'mcq');
  assert.strictEqual(loader.normalizeSkillName('behavioral'), 'behavioral');
});

test('normalizeSkillName maps system-design aliases', () => {
  const loader = new PromptLoader();
  assert.strictEqual(loader.normalizeSkillName('systems-design'), 'system-design');
  assert.strictEqual(loader.normalizeSkillName('architecture'), 'system-design');
});

// ---------------------------------------------------------------------------
// llm.service.js — formatImageInstruction()
// ---------------------------------------------------------------------------

test('formatImageInstruction includes MCQ-specific instruction', () => {
  const result = llmService.formatImageInstruction('mcq', null);
  assert.ok(result.toLowerCase().includes('multiple choice'), result);
  assert.ok(result.toLowerCase().includes('identify the correct option'), result);
});

test('formatImageInstruction includes OOD-specific instruction', () => {
  const result = llmService.formatImageInstruction('ood', null);
  assert.ok(result.toLowerCase().includes('class diagram'), result);
});

test('formatImageInstruction includes system-design instruction', () => {
  const result = llmService.formatImageInstruction('system-design', null);
  assert.ok(result.toLowerCase().includes('high-level architecture'), result);
});

test('formatImageInstruction includes behavioral instruction', () => {
  const result = llmService.formatImageInstruction('behavioral', null);
  assert.ok(result.toLowerCase().includes('star-method'), result);
});

test('formatImageInstruction includes language note when programmingLanguage provided', () => {
  const result = llmService.formatImageInstruction('dsa', 'python');
  assert.ok(result.includes('PYTHON'), result);
});

test('formatImageInstruction works for unknown skill without extra instruction', () => {
  const result = llmService.formatImageInstruction('unknown', null);
  assert.ok(result.includes('UNKNOWN'), result);
});

test('formatImageInstruction does not append trailing whitespace', () => {
  const result = llmService.formatImageInstruction('dsa', null);
  assert.strictEqual(result, result.trim());
});
