import type { EvidenceOutcome, EvidenceRejectionCode } from '@aftercare/contracts';

export function accepted<T>(value: T): EvidenceOutcome<T> {
  return { ok: true, value };
}

export function rejected(code: EvidenceRejectionCode, message: string): EvidenceOutcome<never> {
  return { ok: false, rejection: { code, message } };
}
