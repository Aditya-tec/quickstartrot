import type { Extraction, ExtractionBlock, Truncation } from '@qsr/core';

/** Headings that mark the part of a page a new developer follows first. */
export const QUICKSTART_HEADING = /quick ?start|getting started|install|setup|usage|hello world/i;

export interface PromptBlock {
  blockIndex: number;
  kind: string;
  lang?: string;
  file?: string;
  heading: string;
  text?: string;
  lines?: [number, string][];
  /** The block was cut short because nothing fit: only its first lines/characters are shown. */
  clipped?: true;
}

export interface Selection {
  /** The blocks the model sees, in document order. */
  blocks: PromptBlock[];
  truncation: Truncation;
}

export function toPromptBlock(b: ExtractionBlock): PromptBlock {
  return {
    blockIndex: b.index,
    kind: b.kind,
    heading: b.headingPath.join(' > '),
    ...(b.lang ? { lang: b.lang } : {}),
    ...(b.filenameHint ? { file: b.filenameHint } : {}),
    ...(b.kind === 'code'
      ? { lines: b.text.split('\n').map((t, i): [number, string] => [i + 1, t]) }
      : { text: b.text }),
  };
}

const cost = (b: PromptBlock): number => JSON.stringify(b).length;

/** The heading path with the part every block of the page shares (the page title) removed. */
function sectionPaths(blocks: readonly ExtractionBlock[]): string[] {
  const first = blocks[0]?.headingPath ?? [];
  let common = first.length;
  for (const b of blocks)
    for (let k = 0; k < common; k++) if (b.headingPath[k] !== first[k]) common = k;
  return blocks.map((b) => b.headingPath.slice(common).join(' > '));
}

/**
 * Sort keys, smallest first. The unit of selection is a code block together with the (at most 2) prose
 * blocks that introduce it; units whose section heading looks like a quickstart come first, and within
 * a group the document order decides, so the top of a page beats its tail. Then prose that introduces
 * no code (matching sections first), then headings.
 *
 * The heading is matched after removing the path every block shares: a page titled "Getting Started"
 * would otherwise make every block a quickstart block and the signal would mean nothing.
 */
function keys(blocks: readonly ExtractionBlock[]): [number, number, number][] {
  const sections = sectionPaths(blocks);
  const matching = sections.map((p) => QUICKSTART_HEADING.test(p));
  const key: [number, number, number][] = blocks.map((b, i) => [
    b.kind === 'heading' ? 4 + (matching[i] ? 0 : 1) : 2 + (matching[i] ? 0 : 1),
    i,
    0,
  ]);
  const claimed = new Set<number>();
  blocks.forEach((b, i) => {
    if (b.kind !== 'code') return;
    const group = matching[i] ? 0 : 1;
    key[i] = [group, i, 0];
    let distance = 0;
    for (let j = i - 1; j >= 0 && distance < 2; j--) {
      const prev = blocks[j] as ExtractionBlock;
      if (prev.kind === 'code') break;
      if (prev.kind !== 'prose' || claimed.has(j)) continue;
      claimed.add(j);
      key[j] = [group, i, ++distance];
    }
  });
  return key;
}

/** Cuts a block to fit `max` characters, keeping its beginning (at least one line or one character). */
function clip(block: PromptBlock, max: number): PromptBlock {
  if (block.lines) {
    for (let n = block.lines.length - 1; n >= 1; n--) {
      const cut = { ...block, lines: block.lines.slice(0, n), clipped: true as const };
      if (cost(cut) <= max) return cut;
    }
    return { ...block, lines: block.lines.slice(0, 1), clipped: true };
  }
  const text = block.text ?? '';
  for (let n = text.length - 1; n >= 1; n--) {
    const cut = { ...block, text: text.slice(0, n), clipped: true as const };
    if (cost(cut) <= max) return cut;
  }
  return { ...block, text: text.slice(0, 1), clipped: true };
}

/**
 * Chooses which blocks of the page the model sees, within `maxChars` of block JSON. Blocks are ranked
 * (see `keys`), taken in rank order while they fit, and returned in DOCUMENT order. Deterministic: ties
 * go to the earlier block. A block that does not fit is omitted, never shortened, except in the last
 * resort where the best block does not fit even alone: then it is clipped and marked, so the prompt is
 * never empty. The returned `truncation` says exactly what was left out.
 */
export function selectBlocks(extraction: Extraction, maxChars: number): Selection {
  const all = extraction.blocks;
  const prompt = all.map(toPromptBlock);
  const key = keys(all);
  const order = all
    .map((_, i) => i)
    .sort((a, b) => {
      const ka = key[a] as [number, number, number];
      const kb = key[b] as [number, number, number];
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || a - b;
    });

  const kept = new Map<number, PromptBlock>();
  let used = 0;
  for (const i of order) {
    const c = cost(prompt[i] as PromptBlock);
    if (used + c <= maxChars) {
      kept.set(i, prompt[i] as PromptBlock);
      used += c;
    }
  }
  const clipped: number[] = [];
  const best = order[0];
  if (best !== undefined && !kept.has(best)) {
    // The single most important block does not fit even alone: showing its beginning is better than
    // showing only less important blocks, or nothing.
    const block = clip(prompt[best] as PromptBlock, maxChars);
    kept.clear();
    kept.set(best, block);
    clipped.push(block.blockIndex);
  }

  const blocks = [...kept.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  const omittedBlockIndexes = all.filter((_, i) => !kept.has(i)).map((b) => b.index);
  return {
    blocks,
    truncation: {
      truncated: omittedBlockIndexes.length > 0 || clipped.length > 0,
      totalBlocks: all.length,
      includedBlocks: blocks.length,
      omittedBlocks: omittedBlockIndexes.length,
      omittedBlockIndexes,
      clippedBlockIndexes: clipped,
    },
  };
}
