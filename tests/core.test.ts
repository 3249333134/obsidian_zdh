import { describe, it, expect } from 'vitest';
import { endpoint, normalizeTags, parseAnalysis, renderNote, safeName, safePath, splitText } from '../src/core';
import { defaultDestinations } from '../src/config';
import { analysis } from './fixtures';
describe('paths and metadata', () => {
  it.each(['../outside', '/absolute', 'C:\\a', '.obsidian/plugins', 'foo/../bar', 'foo/.obsidian', 'foo//bar', 'foo/NUL:'])('rejects unsafe path %s', path => expect(() => safePath(path)).toThrow());
  it('allows Chinese paths and spaces', () => expect(safePath('知识 库/方法')).toBe('知识 库/方法'));
  it('sanitizes filenames', () => { expect(safeName('CON')).toMatch(/^文档/); expect(safeName('../标题:*')).not.toMatch(/[/:*]/); });
  it('normalizes tags without allowing yaml injection', () => expect(normalizeTags(['#方法', '方法', 'two words', '123', 'a/b'])).toEqual(['方法', 'two-words', 'a/b']));
  it('limits HTTP to local models and normalizes endpoints', () => {
    expect(endpoint('https://example.com/v1/')).toBe('https://example.com/v1/chat/completions');
    expect(endpoint('http://localhost:11434/v1/chat/completions')).toBe('http://localhost:11434/v1/chat/completions');
    expect(() => endpoint('http://example.com')).toThrow(); expect(() => endpoint('https://user:pass@example.com')).toThrow();
  });
  it('serializes frontmatter and escaped source links', () => {
    const note = renderNote({ ...analysis, title: '标题\n注入' }, '资产/文件 #1.pdf', 'now', 'later', '方法库', 'id');
    expect(note).toContain('# 标题 注入'); expect(note).toContain('%231.pdf'); expect(note).toContain('knowledge_flow_id: "id"');
  });
});
describe('full document processing', () => {
  it('preserves every character including the last section', () => {
    const text = ('段落内容😀\n'.repeat(500)) + '最后的关键信息'; const chunks = splitText(text, 1000);
    expect(chunks.join('')).toBe(text); expect(chunks.every(chunk => chunk.length <= 1000)).toBe(true); expect(chunks.at(-1)).toContain('最后');
  });
  it('accepts strict structured analysis and rejects invented destinations', () => {
    expect(parseAnalysis(JSON.stringify(analysis), defaultDestinations())).toEqual(analysis);
    expect(() => parseAnalysis(JSON.stringify({ ...analysis, destinationId: '../outside' }), defaultDestinations())).toThrow();
    expect(() => parseAnalysis('{"title":"incomplete"}', defaultDestinations())).toThrow();
    expect(() => parseAnalysis('invalid', defaultDestinations())).toThrow();
  });
});
