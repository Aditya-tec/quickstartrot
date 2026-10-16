// Spec sections 4 and 9: "No secret ever appears in a log, artifact or LLM prompt." Everything the
// executor captures goes through redact() BEFORE it is written anywhere. It is deliberately
// conservative about what it rewrites: log lines have to stay readable, because they are the
// evidence behind a public claim that a vendor's quickstart is broken.

export const REDACTED = '[REDACTED]';

export interface RedactOptions {
  /** Exact values to remove wherever they appear: the dummy keys the plan injects. */
  secrets?: readonly string[];
  /** The sandbox user's home directory, replaced by `~`. */
  homePath?: string;
}

const MIN_SECRET_LENGTH = 4;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`, // CSI: colours, cursor movement, erase
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, // OSC: hyperlinks, window title
    `${ESC}[@-Z\\\\-_]`, // remaining two-character escapes
  ].join('|'),
  'g',
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Credentials with a recognisable shape, redacted wherever they appear. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /gsk_[A-Za-z0-9]{20,}/g, // Groq
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT (Supabase keys are JWTs)
];

const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

/**
 * `NAME = value` where NAME has a key/token/secret/password/credential/auth segment and the value is
 * a long token. The keyword must be a whole name segment, so `keyboard` or `monkey` do not count,
 * and the name is kept so the line still reads `RESEND_API_KEY=[REDACTED]`.
 */
const KEYED_VALUE = new RegExp(
  '(?<![A-Za-z0-9])' +
    '((?:[A-Za-z0-9]+[_.-])*(?:key|token|secret|passw(?:or)?d|credential|auth)(?:[_.-][A-Za-z0-9]+)*' +
    '["\']?\\s*[:=]\\s*["\']?)' +
    '([A-Za-z0-9+/=_.~-]{16,})' +
    '(["\']?)',
  'gi',
);

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\d.])(?:${OCTET}\\.){3}${OCTET}(?!\\d)`, 'g');

const H = '[0-9a-f]{1,4}';
const IPV6 = new RegExp(
  `(?<![0-9a-z:])(?:(?:${H}:){7}${H}|(?:${H}:){1,7}:(?:${H}(?::${H}){0,5})?|::${H}(?::${H}){0,6})(?![0-9a-z:])`,
  'gi',
);

export function redact(text: string, options: RedactOptions = {}): string {
  let out = stripAnsi(text);

  const secrets = [...(options.secrets ?? [])]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join(REDACTED);

  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = out.replace(KEYED_VALUE, `$1${REDACTED}$3`);

  const home = escapeRegExp(options.homePath ?? '/home/runner');
  out = out.replace(new RegExp(`${home}(?![A-Za-z0-9_-])`, 'g'), '~');

  return out.replace(IPV6, REDACTED).replace(IPV4, REDACTED);
}
