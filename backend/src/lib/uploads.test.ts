import { describe, expect, it } from 'vitest';
import { HttpError } from './http-errors.js';
import { checkUpload, decodeFileName } from './uploads.js';

const PDF = Buffer.from('%PDF-1.7\n%test\n');

describe('decodeFileName', () => {
  it('decodes the percent-encoded X-File-Name and treats a missing one as absent', () => {
    expect(decodeFileName(encodeURIComponent('رخصة مزاولة.pdf'))).toBe('رخصة مزاولة.pdf');
    expect(decodeFileName(undefined)).toBeUndefined();
    expect(decodeFileName('')).toBeUndefined();
  });

  it('refuses a malformed encoding as a client error (400), not a server error', () => {
    const attempt = () => decodeFileName('licence%E0%A4%A.pdf');
    expect(attempt).toThrow(HttpError);
    try { attempt(); } catch (e) { expect(e).toMatchObject({ status: 400, code: 'FILE_NAME_INVALID' }); }
  });
});

describe('checkUpload file name', () => {
  const nameOf = (raw: string) => checkUpload('CREDENTIAL_EVIDENCE', PDF, 'application/pdf', raw, 1024).fileName;

  it('removes path separators, control characters and invisible direction marks', () => {
    expect(nameOf('../../etc/passwd.pdf')).toBe('....etcpasswd.pdf');
    expect(nameOf('scan\u0000\u001f\u007f.pdf')).toBe('scan.pdf');
    // Right-to-left override: would display "invoiceexe.pdf" for a name ending in .exe.
    expect(nameOf('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(nameOf('a​⁦b⁩﻿.pdf')).toBe('ab.pdf');
  });

  it('keeps Arabic and other ordinary text, and falls back to "document"', () => {
    expect(nameOf('شهادة BLS 2026.pdf')).toBe('شهادة BLS 2026.pdf');
    expect(nameOf('‮‏')).toBe('document');
  });
});
