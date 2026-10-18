import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as obsidian from './obsidian';
import { createRequire } from 'node:module';
describe('distributed runtime bundle', () => {
  it('loads the exact packaged CommonJS plugin without remote assets', () => {
    const code = readFileSync('dist/knowledge-flow/main.js', 'utf8'); const module = { exports: {} as any };
    const require = createRequire(import.meta.url);
    new Function('require', 'module', 'exports', code)((name: string) => { if (name === 'obsidian') return obsidian; if (name.startsWith('node:')) return require(name); throw new Error('Unexpected runtime dependency: ' + name); }, module, module.exports);
    expect(typeof module.exports.default).toBe('function'); expect(code).not.toContain('https://cdnjs');
  });
});
