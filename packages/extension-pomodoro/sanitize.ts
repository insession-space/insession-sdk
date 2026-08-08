// Normalizers for untrusted input, shared by the two boundaries that take it:
// `reduce` (wire payloads) and `restore` (persisted data). They live here
// rather than next to either caller so that both are guaranteed to clamp the
// same way — a declaration read back from storage must be exactly as long as
// one that was just declared.

const MIN_MINUTES = 1;
const MAX_MINUTES = 120;

// A "one-line declaration" is not meant to hold long text.
const DECLARE_MAX_LEN = 80;

export function clampMinutes(value: unknown, fallbackSeconds: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallbackSeconds;
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, n)) * 60;
}

// Normalizes declaration text (trim + clamp to DECLARE_MAX_LEN). Single
// source used by both `reduce` and `restore`.
export function clampDeclarationText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .slice(0, DECLARE_MAX_LEN);
}
