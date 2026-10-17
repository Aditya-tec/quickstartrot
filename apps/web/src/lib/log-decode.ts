// Decoding for the log viewer (runs in the browser). The bucket serves a step log as raw gzip with
// Content-Type application/gzip and no Content-Encoding, so the bytes arrive compressed and are inflated here
// with DecompressionStream. If a CDN ever applies Content-Encoding the browser hands over plain text; the gzip
// magic number tells the two apart. The result is only ever rendered as text.

/** Keep at most this many bytes of a log (the end of it, where the failure is). */
export const MAX_LOG_BYTES = 512 * 1024;
const OMITTED = '[earlier output omitted]\n';

const isGzip = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeLog(buffer: ArrayBuffer): Promise<string> {
  let bytes: Uint8Array = new Uint8Array(buffer);
  if (isGzip(bytes)) {
    try {
      bytes = await inflate(new Uint8Array(buffer));
    } catch {
      throw new Error('The log file could not be decompressed');
    }
  }
  let omitted = false;
  if (bytes.length > MAX_LOG_BYTES) {
    bytes = bytes.subarray(bytes.length - MAX_LOG_BYTES);
    omitted = true;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return omitted ? OMITTED + text.slice(text.indexOf('\n') + 1) : text;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface WindowInput {
  scrollTop: number;
  viewport: number;
  lineHeight: number;
  total: number;
  overscan: number;
}

/** The slice of lines to render for a scroll position: [start, end). */
export function windowRange({ scrollTop, viewport, lineHeight, total, overscan }: WindowInput): {
  start: number;
  end: number;
} {
  if (total <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / lineHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + viewport) / lineHeight);
  const start = Math.min(total - 1, Math.max(0, first - overscan));
  const end = Math.min(total, last + overscan);
  return { start, end };
}
