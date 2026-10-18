import { StringDecoder } from 'node:string_decoder';
import { redact } from '@qsr/core';
import { matchAuthPattern, matchDriftPattern } from './expect.js';

// Spec section 9, "Output capture and redaction". Output is handled line by line so a secret that
// arrives split across two chunks is still redacted, memory stays bounded however much a step
// prints, and nothing is stored before it has been redacted.

export const LOG_CAP_BYTES = 256 * 1024; // full redacted log per step
export const TAIL_BYTES = 4096; // stdoutTail / stderrTail
export const MAX_LINE_CHARS = 16 * 1024; // longer lines are cut, so one line cannot exhaust memory

const TRUNCATED_LINE = ' [line truncated]';
const EVIDENCE_LINE_MAX = 300;
/** A line that starts with an exception or error class and a colon: `Error: x`, `anthropic.AuthenticationError: x`, `TypeError: x`. Stack frames start with `at` or `File`. */
const ERROR_LINE = /^\s*(?:[A-Za-z_][\w.$]*\.)?(?:[A-Za-z_$][\w$]*)?(?:Error|Exception)\s*:\s*\S/;
const LOG_TRUNCATED = '[qsr] output truncated: the log of this step is capped at 256 KB\n';

export interface StepOutputOptions {
  /** Exact values to remove (the dummy keys injected by the plan). */
  secrets: readonly string[];
  /** Strings that must appear in stdout (`expect.stdoutIncludes`). */
  stdoutIncludes: readonly string[];
  logCapBytes?: number;
  tailBytes?: number;
  maxLineBytes?: number;
}

export interface OutputEvidence {
  authPattern: string | null;
  /** The first line (redacted, at most 300 characters) that matched an auth pattern. */
  authLine: string | null;
  /** The first line that looks like an exception or error message (redacted, at most 300 characters). */
  errorLine: string | null;
  driftPattern: string | null;
  stdoutIncludesFound: Set<string>;
}

export interface StepOutputResult {
  stdoutTail: string;
  stderrTail: string;
  /** Redacted output of both streams in arrival order, at most the cap plus one notice line. */
  log: string;
  logTruncated: boolean;
  /** Raw bytes received, before any truncation. */
  bytesStdout: number;
  bytesStderr: number;
  evidence: OutputEvidence;
}

type Stream = 'out' | 'err';

/** The last `n` bytes of `text`, never starting in the middle of a multi-byte character. */
function lastBytes(text: string, n: number): string {
  if (Buffer.byteLength(text) <= n) return text;
  const buf = Buffer.from(text);
  let start = buf.length - n;
  while (start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

class StreamState {
  readonly decoder = new StringDecoder('utf8');
  carry = '';
  discarding = false;
  bytes = 0;
  /** Recent redacted lines; trimmed lazily so appending is O(1). */
  chunks: { text: string; bytes: number }[] = [];
  chunkBytes = 0;
}

export class StepOutput {
  private readonly cap: number;
  private readonly tailBytes: number;
  private readonly maxLine: number;
  private readonly streams: Record<Stream, StreamState> = {
    out: new StreamState(),
    err: new StreamState(),
  };
  private readonly logParts: string[] = [];
  private logBytes = 0;
  private logTruncated = false;
  private readonly evidence: OutputEvidence = {
    authPattern: null,
    authLine: null,
    errorLine: null,
    driftPattern: null,
    stdoutIncludesFound: new Set(),
  };

  constructor(private readonly options: StepOutputOptions) {
    this.cap = options.logCapBytes ?? LOG_CAP_BYTES;
    this.tailBytes = options.tailBytes ?? TAIL_BYTES;
    this.maxLine = options.maxLineBytes ?? MAX_LINE_CHARS;
  }

  stdout(chunk: Buffer | string): void {
    this.feed('out', chunk);
  }

  stderr(chunk: Buffer | string): void {
    this.feed('err', chunk);
  }

  /** A line written by the harness itself (for example why a step was killed). Goes to stderr. */
  note(text: string): void {
    this.emit('err', text);
  }

  /** Evidence collected so far, for deciding pass or fail before the final notes are added. */
  currentEvidence(): OutputEvidence {
    return this.evidence;
  }

  finish(): StepOutputResult {
    for (const stream of ['out', 'err'] as const) {
      const s = this.streams[stream];
      const rest = s.carry + s.decoder.end();
      s.carry = '';
      if (rest !== '' && !s.discarding) this.emit(stream, rest);
    }
    return {
      stdoutTail: this.tail('out'),
      stderrTail: this.tail('err'),
      log: this.logParts.join(''),
      logTruncated: this.logTruncated,
      bytesStdout: this.streams.out.bytes,
      bytesStderr: this.streams.err.bytes,
      evidence: this.evidence,
    };
  }

  private feed(stream: Stream, chunk: Buffer | string): void {
    const s = this.streams[stream];
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    s.bytes += buf.length;
    let rest = s.decoder.write(buf);
    for (let nl = rest.indexOf('\n'); nl !== -1; nl = rest.indexOf('\n')) {
      const piece = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (s.discarding) {
        s.discarding = false; // this newline ends the over-long line we were dropping
      } else {
        this.emit(stream, s.carry + piece);
      }
      s.carry = '';
    }
    if (rest === '' || s.discarding) return;
    s.carry += rest;
    if (s.carry.length > this.maxLine) {
      this.emit(stream, s.carry); // emit() cuts it to maxLine and marks it
      s.carry = '';
      s.discarding = true;
    }
  }

  private emit(stream: Stream, raw: string): void {
    // A terminal shows only what follows the last carriage return (progress bars rewrite a line).
    const withoutCrlf = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // CRLF is just a newline
    const afterCr = withoutCrlf.slice(withoutCrlf.lastIndexOf('\r') + 1);
    const cut =
      afterCr.length > this.maxLine ? afterCr.slice(0, this.maxLine) + TRUNCATED_LINE : afterCr;
    const line = redact(cut, { secrets: this.options.secrets });
    this.scan(stream, line);
    this.store(stream, `${line}\n`);
  }

  private scan(stream: Stream, line: string): void {
    const e = this.evidence;
    const auth = matchAuthPattern(line);
    e.authPattern ??= auth;
    if (auth !== null) e.authLine ??= line.trim().slice(0, EVIDENCE_LINE_MAX);
    if (ERROR_LINE.test(line)) e.errorLine ??= line.trim().slice(0, EVIDENCE_LINE_MAX);
    e.driftPattern ??= matchDriftPattern(line);
    if (stream === 'out') {
      for (const needle of this.options.stdoutIncludes) {
        if (line.includes(needle)) e.stdoutIncludesFound.add(needle);
      }
    }
  }

  private store(stream: Stream, text: string): void {
    const bytes = Buffer.byteLength(text);
    const s = this.streams[stream];
    s.chunks.push({ text, bytes });
    s.chunkBytes += bytes;
    while (
      s.chunks.length > 1 &&
      s.chunkBytes - (s.chunks[0] as { bytes: number }).bytes >= this.tailBytes
    ) {
      s.chunkBytes -= (s.chunks.shift() as { bytes: number }).bytes;
    }

    if (this.logTruncated) return;
    if (this.logBytes + bytes > this.cap) {
      this.logTruncated = true;
      this.logParts.push(LOG_TRUNCATED);
      return;
    }
    this.logParts.push(text);
    this.logBytes += bytes;
  }

  private tail(stream: Stream): string {
    return lastBytes(this.streams[stream].chunks.map((c) => c.text).join(''), this.tailBytes);
  }
}
