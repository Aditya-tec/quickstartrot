import type { ExtractionBlock, VariantsConfig, VariantsReport } from '@qsr/core';
import { CrawlError } from './errors.js';

// Docs often show alternatives inside ONE code block:
//
//   // Require the framework and instantiate it      <- preamble, common to all
//   // ESM
//   import Fastify from 'fastify'
//   const fastify = Fastify({ logger: true })         <- variant 1
//   // CommonJs
//   const fastify = require('fastify')({ ... })       <- variant 2 (its own lines end at the first blank line)
//                                                        <- blank line
//   fastify.get('/', ...)                             <- shared tail, common to all
//
// Run as written, that block is a SyntaxError (two declarations of `fastify`), so the crawler keeps
// ONE variant. Rules (deterministic, no guessing):
//  - a marker is a line that matches one of `splitOn` as a whole (trimmed, case-insensitive);
//  - 2+ markers in a block are alternatives: output = preamble + the preferred variant + the shared tail,
//    where the tail is whatever follows the first blank line after the LAST variant's first line;
//  - exactly 1 marker: the block is that variant's. If it is the preferred one the block is kept minus the
//    marker line; if not, the variant is dropped (and the block with it, unless a preamble is left);
//  - 2+ markers but none preferred, or no marker anywhere on the page: variant_not_found. A docs structure
//    change is a finding, not something to work around.
// The marker lines never reach the plan: they are comments the docs use to label alternatives.

interface Split {
  preamble: string[];
  markers: string[];
  segments: string[][];
}

function split(lines: readonly string[], markerRes: readonly RegExp[]): Split | null {
  const at: number[] = [];
  lines.forEach((line, i) => {
    if (markerRes.some((re) => re.test(line.trim()))) at.push(i);
  });
  if (at.length === 0) return null;
  return {
    preamble: lines.slice(0, at[0]),
    markers: at.map((i) => (lines[i] as string).trim()),
    segments: at.map((start, k) => lines.slice(start + 1, at[k + 1] ?? lines.length)),
  };
}

const trimBlank = (lines: readonly string[]): string[] => {
  let a = 0;
  let b = lines.length;
  while (a < b && (lines[a] as string).trim() === '') a++;
  while (b > a && (lines[b - 1] as string).trim() === '') b--;
  return lines.slice(a, b);
};

const join = (parts: readonly (readonly string[])[]): string =>
  parts
    .map((p) => trimBlank(p))
    .filter((p) => p.length > 0)
    .map((p) => p.join('\n'))
    .join('\n\n');

export interface VariantsResult {
  blocks: ExtractionBlock[];
  report: VariantsReport;
}

/** Applies target `extract.variants` to normalized blocks. Pure; throws CrawlError(variant_not_found). */
export function applyVariants(
  input: readonly ExtractionBlock[],
  config: VariantsConfig,
): VariantsResult {
  const markerRes = config.splitOn.map((p) => new RegExp(`^(?:${p})$`, 'i'));
  const prefer = new RegExp(config.prefer, 'i');
  const report: VariantsReport = { prefer: config.prefer, blocks: [] };
  const kept: ExtractionBlock[] = [];

  for (const block of input) {
    const parts = block.kind === 'code' ? split(block.text.split('\n'), markerRes) : null;
    if (parts === null) {
      kept.push({ ...block, index: kept.length });
      continue;
    }
    const preferred = parts.markers.findIndex((m) => prefer.test(m));
    const entry = { originalIndex: block.index, markers: parts.markers };

    if (parts.markers.length === 1) {
      // The only variant in this block is the block's own.
      const text =
        preferred === 0
          ? join([parts.preamble, parts.segments[0] as string[]])
          : join([parts.preamble]);
      if (text === '') {
        report.blocks.push({
          ...entry,
          blockIndex: null,
          action: 'dropped_block',
          keptMarker: null,
        });
        continue;
      }
      report.blocks.push({
        ...entry,
        blockIndex: kept.length,
        action: 'kept_variant',
        keptMarker: preferred === 0 ? (parts.markers[0] as string) : null,
      });
      kept.push({ ...block, index: kept.length, text });
      continue;
    }

    if (preferred === -1)
      throw new CrawlError(
        'variant_not_found',
        `block ${block.index} has variant markers (${parts.markers.join(', ')}) but none matches "${config.prefer}"`,
      );

    const last = parts.segments.length - 1;
    const lastSegment = parts.segments[last] as string[];
    const firstBlank = lastSegment.findIndex((l) => l.trim() === '');
    const lastOwn = firstBlank === -1 ? lastSegment : lastSegment.slice(0, firstBlank);
    const tail = firstBlank === -1 ? [] : lastSegment.slice(firstBlank);
    const chosen = preferred === last ? lastOwn : (parts.segments[preferred] as string[]);

    report.blocks.push({
      ...entry,
      blockIndex: kept.length,
      action: 'kept_variant',
      keptMarker: parts.markers[preferred] as string,
    });
    kept.push({ ...block, index: kept.length, text: join([parts.preamble, chosen, tail]) });
  }

  if (report.blocks.length === 0)
    throw new CrawlError(
      'variant_not_found',
      `extract.variants is configured but no code block contains a variant marker (${config.splitOn.join(' | ')}): the docs structure changed`,
    );
  return { blocks: kept, report };
}
