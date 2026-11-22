// All GitHub metadata (descriptions, names, locations, homepage URLs) is
// untrusted third-party input. Anything GitSphere persists or publishes goes
// through these helpers so that credential-shaped strings, control and
// bidirectional-override characters, and oversized values never reach
// checkpoints, datasets, Markdown, logs or artifacts.

const SECRET_PATTERNS = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g],
  ['github-legacy-oauth', /\bgho_[A-Za-z0-9]{16,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['slack-webhook', /hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g],
  ['stripe-key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['pypi-token', /\bpypi-[A-Za-z0-9_-]{50,}/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ['telegram-bot-token', /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g],
  ['discord-token', /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ['bearer-credential', /\b(?:bearer|token|apikey|api_key|api-key|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}/gi],
  ['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi],
];

const REDACTION = '[redacted]';

// C0/C1 controls, bidi overrides/isolates, zero-width and BOM characters.
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const [, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, REDACTION);
  }
  return text;
}

/** Returns the names of the credential patterns found; never the values. */
export function detectSecrets(value) {
  const text = String(value ?? '');
  const found = [];
  for (const [name, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.push(name);
  }
  pattern0Reset();
  return found;
}

function pattern0Reset() {
  for (const [, pattern] of SECRET_PATTERNS) pattern.lastIndex = 0;
}

export function sanitizeText(value, maxLength = 160) {
  if (value == null) return null;
  let text = String(value).replace(UNSAFE_CHARACTERS, '').replace(/\s+/g, ' ').trim();
  text = redactSecrets(text);
  if (!text) return null;
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1).trimEnd()}…`;
  return text;
}

export function sanitizeLogin(value) {
  const login = String(value ?? '');
  // GitHub logins: alphanumerics and single hyphens, max 39 characters.
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ? login : null;
}

export function sanitizeNameWithOwner(value) {
  const text = String(value ?? '');
  const match = text.match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  return match ? text : null;
}

/** Keeps only http(s) origin + path; drops credentials, query and fragment. */
export function sanitizeUrl(value, maxLength = 200) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const clean = `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  if (clean.length > maxLength || detectSecrets(clean).length) return null;
  return clean;
}

export function sanitizeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

/**
 * Final persistence guard: throws if a serialized document still contains a
 * credential-shaped string. The error names the file and pattern only.
 */
export function assertNoSecrets(serialized, label) {
  const found = detectSecrets(serialized);
  if (found.length) {
    const error = new Error(
      `Refusing to write ${label}: credential-shaped content detected (${found.join(', ')}). Value withheld.`,
    );
    error.code = 'GITSPHERE_SECRET_GUARD';
    throw error;
  }
}

/** Removes anything token-like from an error message before it is logged. */
export function safeErrorMessage(error) {
  return sanitizeText(error?.message || String(error), 300) || 'unknown error';
}
