import { describe, it, expect } from 'vitest';
import { extractText } from '../src/parser';
import { docx, pdf } from './fixtures';
describe('document extraction', () => {
  it.each(['md', 'txt'])('extracts full UTF-8 %s text', async ext => expect(await extractText(`文件.${ext}`, new TextEncoder().encode('第一段\n尾部结论').buffer)).toContain('尾部结论'));
  it('supports UTF-16 BOM and rejects invalid UTF-8', async () => {
    expect(await extractText('文件.txt', new Uint8Array([255,254,65,0,66,0]).buffer)).toBe('AB');
    await expect(extractText('文件.txt', new Uint8Array([255,255]).buffer)).rejects.toThrow('编码');
  });
  it('extracts DOCX text', async () => expect(await extractText('文件.docx', docx())).toContain('末尾信息'));
  it('extracts every PDF page', async () => { const text = await extractText('文件.pdf', pdf(['First page', 'Last conclusion'])); expect(text).toContain('First page'); expect(text).toContain('Last conclusion'); });
  it('rejects PDFs with scanned/empty pages instead of partial analysis', async () => await expect(extractText('扫描.pdf', pdf(['Text', '']))).rejects.toThrow('OCR'));
  it('rejects damaged or unsupported documents', async () => {
    await expect(extractText('文件.docx', new Uint8Array([1,2]).buffer)).rejects.toThrow('Word');
    await expect(extractText('文件.pdf', new Uint8Array([1,2]).buffer)).rejects.toThrow('PDF');
    await expect(extractText('文件.doc', new Uint8Array([1,2]).buffer)).rejects.toThrow('支持');
  });
});
