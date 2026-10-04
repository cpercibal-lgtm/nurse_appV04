// Upload validation and storage for evidence and contract documents
// (spec §5.1.5, §5.3.2; rules D1–D4; decisions C-17, D-10).
//
// - Size: 1 byte … UPLOAD_MAX_SIZE_BYTES (spec default 10 MB). Empty is rejected (D2).
// - Type: the declared Content-Type must be allowed for the purpose AND match
//   the file's magic bytes (spec §5.1.5). Credential evidence: PDF, JPEG, PNG,
//   WebP; contract copies: PDF only (C-17).
// - Scanning (D-10): lib/scanner.ts, after these checks and before storage —
//   ClamAV in production, a pass-through in development.
// - Storage: the document vault (lib/vault.ts) — encrypted, integrity-checked,
//   never overwritten (D3) and never served unless CLEAN (D4).

import crypto from 'node:crypto';
import { HttpError } from './http-errors.js';

export type UploadPurpose = 'CREDENTIAL_EVIDENCE' | 'CONTRACT_COPY';

export const ALLOWED_TYPES: Record<UploadPurpose, readonly string[]> = {
  CREDENTIAL_EVIDENCE: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
  CONTRACT_COPY: ['application/pdf'],
};

/** The MIME type implied by the leading bytes, or null when unrecognised. */
export function sniffMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export interface CheckedUpload { mimeType: string; sizeBytes: number; sha256: string; fileName: string }

/** The X-File-Name header (percent-encoded by the client); a malformed encoding is the client's error, not a 500. */
export function decodeFileName(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try { return decodeURIComponent(header); } catch { throw new HttpError(400, 'FILE_NAME_INVALID', 'The file name is not validly encoded'); }
}

// Control characters, and the invisible and direction-changing ones that can disguise a
// name ("invoice<RLO>fdp.exe" displays as "invoiceexe.pdf").
const UNSAFE_NAME_CHARS = /[\\/\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Throws a client-facing HttpError for any rule violation. */
export function checkUpload(purpose: UploadPurpose, bytes: Buffer, declaredType: string | undefined, fileNameRaw: string | undefined, maxBytes: number): CheckedUpload {
  if (bytes.length === 0) throw new HttpError(400, 'UPLOAD_EMPTY', 'The file is empty');
  if (bytes.length > maxBytes) throw new HttpError(413, 'UPLOAD_TOO_LARGE', `The file exceeds ${Math.floor(maxBytes / 1048576)} MB`);
  const declared = (declaredType ?? '').split(';')[0]!.trim().toLowerCase();
  const allowed = ALLOWED_TYPES[purpose];
  if (!allowed.includes(declared)) {
    throw new HttpError(415, 'UPLOAD_TYPE_NOT_ALLOWED', `Allowed types: ${allowed.join(', ')}`);
  }
  const detected = sniffMime(bytes);
  if (detected !== declared) throw new HttpError(415, 'UPLOAD_TYPE_MISMATCH', 'The file content does not match its declared type');
  // Keep only a safe display name; it is never used as a path.
  const fileName = (fileNameRaw ?? '').replace(UNSAFE_NAME_CHARS, '').trim().slice(0, 200) || 'document';
  if (purpose === 'CONTRACT_COPY' && !fileName.toLowerCase().endsWith('.pdf')) {
    throw new HttpError(415, 'UPLOAD_TYPE_NOT_ALLOWED', 'A contract copy must be a .pdf file (D1)');
  }
  return { mimeType: declared, sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), fileName };
}
