import { extractRawText } from 'mammoth/mammoth.browser';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as worker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// PDF.js can use its bundled in-process worker without fetching any remote script.
(globalThis as typeof globalThis & { pdfjsWorker: unknown }).pdfjsWorker = worker;
export const SUPPORTED = ['md', 'txt', 'pdf', 'docx'];
export function extension(name: string): string { return name.split('.').pop()?.toLowerCase() || ''; }
export async function extractText(name: string, buffer: ArrayBuffer): Promise<string> {
  const ext = extension(name);
  let text = '';
  if (ext === 'md' || ext === 'txt') {
    const bytes = new Uint8Array(buffer);
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer); }
    catch { throw new Error('文本编码无法识别，请另存为 UTF-8 后重试。'); }
  } else if (ext === 'docx') {
    try { text = (await extractRawText({ arrayBuffer: buffer })).value; }
    catch { throw new Error('Word 文件无法解析，请确认是未加密且未损坏的 DOCX。'); }
  } else if (ext === 'pdf') {
    const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false });
    try {
      const pdf = await loading.promise;
      const pages: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const content = await (await pdf.getPage(n)).getTextContent();
        const lines = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        if (!lines.trim()) throw new Error(`PDF 第 ${n} 页没有可提取文字，可能包含扫描页；首版不支持 OCR。`);
        pages.push(`\n第 ${n} 页\n${lines}`);
      }
      text = pages.join('\n');
    } catch (error) {
      if (error instanceof Error && error.message.includes('OCR')) throw error;
      throw new Error('PDF 无法解析，请检查文件是否损坏、加密或为扫描件。');
    } finally { await loading.destroy(); }
  } else throw new Error('支持 Markdown、TXT、文本 PDF 和 DOCX。');
  if (!text.trim()) throw new Error('文件没有可提取的文字。扫描件需要先进行 OCR。');
  return text.trim();
}
