// Best-effort redaction before a transcript leaves the machine. It catches common token shapes,
// not every secret: anything in a chat can still reach the model.
const PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / Stripe style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']{8,}/gi,
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const p of PATTERNS) {
    out = out.replace(p, (m, g1) =>
      typeof g1 === "string" && /^(bearer|[A-Z0-9_]+)$/i.test(g1) && !/^(sk|pk|rk)$/.test(g1) ? `${g1} [REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}
