/**
 * Error text that is safe to log. Library errors (Prisma, Firebase) can echo their arguments or the credential they
 * choked on, so any long unbroken run of token-like characters (an FCM device token, a base64 private key line) is
 * replaced, and the result is capped. Short words and codes ("messaging/internal-error") stay readable.
 */
export function safeReason(error: unknown, maxLength = 300): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/[A-Za-z0-9_\-+/=:.]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
