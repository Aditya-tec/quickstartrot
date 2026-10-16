import type { RawBlock } from './normalize.js';

export interface PageScriptConfig {
  root: string;
  codeBlocks: string;
}

/**
 * Runs INSIDE the browser via page.evaluate, so it must be fully self-contained: no imports, no
 * closures over module scope. It only reads the DOM; all normalization happens in Node.
 *
 * Spec section 7, steps 6 to 8: walk the root in document order and emit heading, code and prose
 * blocks. Code text is read with innerText (not textContent) so hidden copy-button labels are
 * dropped, and invisible code (inactive tab panels) is skipped.
 */
export function collectBlocks(cfg: PageScriptConfig): RawBlock[] {
  const rootEl = document.querySelector(cfg.root);
  if (!rootEl) return [];

  const FILE_RE = /^[\w@.\-/]+\.[A-Za-z0-9]{1,8}$/;
  const visible = (el: Element): boolean => el.checkVisibility({ checkVisibilityCSS: true });
  const clean = (s: string): string =>
    s
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*[#¶§]$/, '')
      .trim();

  // Number of real code blocks under an element. Line-number gutters (a <pre> holding only digits)
  // do not count, so wrappers of numbered listings still look like a single-block wrapper.
  const codeCount = (el: Element): number =>
    Array.from(el.querySelectorAll('pre')).filter((p) => {
      const t = p.textContent ?? '';
      return /\S/.test(t) && !/^[\d\s]+$/.test(t);
    }).length;

  // Language lookup: language-*, lang-*, data-language, plus Sphinx's highlight-<lang>. Climbs from
  // the code element through ancestors, but only while the ancestor wraps this single code block, so
  // the line-number tables of mkdocs-material (language class 7 levels up) are found without
  // picking up an unrelated container's class.
  const langOf = (el: Element): string | null => {
    let cur: Element | null = el;
    for (let depth = 0; cur && depth < 12; depth++) {
      if (depth > 1 && codeCount(cur) > 1) break;
      const attr = cur.getAttribute('data-language') ?? cur.getAttribute('data-lang');
      if (attr) return attr.toLowerCase();
      for (const cls of Array.from(cur.classList)) {
        const m = /^(?:language|lang|highlight)-(.+)$/.exec(cls);
        // GitHub renders "highlight-source-js" / "highlight-text-shell-session": drop that prefix.
        const found = m?.[1]?.toLowerCase().replace(/^(?:source|text)-/, '');
        if (found && found !== 'default' && found !== 'none') return found;
      }
      cur = cur.parentElement;
    }
    return null;
  };

  // Code text via innerText (drops hidden copy-button labels). Highlighters such as Shiki render each
  // line as a block <span class="line"> and leave blank lines as EMPTY spans, which innerText
  // swallows. When every child of the code element is such a line, rebuild the text line by line.
  const codeText = (code: Element): string => {
    const kids = Array.from(code.children);
    const isLine = (c: Element): boolean =>
      c.classList.contains('line') ||
      c.classList.contains('ec-line') ||
      c.hasAttribute('data-line');
    if (kids.length >= 2 && kids.every(isLine)) {
      return kids.map((k) => (k as HTMLElement).innerText.replace(/\n$/, '')).join('\n');
    }
    return (code as HTMLElement).innerText;
  };

  const asFilename = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const text = raw.replace(/^\s*(?:file(?:name)?)\s*:\s*/i, '').trim();
    return FILE_RE.test(text) ? text : null;
  };

  const hintOf = (code: Element): string | null => {
    const pre = code.closest('pre') ?? code;
    // Only treat the parent as a title-bar wrapper when it holds exactly this one code block;
    // otherwise a page-wide container would leak other blocks' filenames into this one.
    const parent = pre.parentElement;
    const holder = parent && codeCount(parent) <= 1 ? parent : null;
    for (const el of [pre, code, holder]) {
      if (!el) continue;
      for (const name of ['data-title', 'data-filename', 'data-file', 'title']) {
        const hit = asFilename(el.getAttribute(name));
        if (hit) return hit;
      }
    }
    const cap = asFilename(pre.closest('figure')?.querySelector('figcaption')?.textContent);
    if (cap) return cap;
    for (const start of [pre, holder]) {
      let sib: Element | null = start?.previousElementSibling ?? null;
      for (let i = 0; sib && i < 2; i++, sib = sib.previousElementSibling) {
        const hit = asFilename(sib.textContent);
        if (hit) return hit;
      }
    }
    if (holder) {
      for (const el of Array.from(
        holder.querySelectorAll('[class*="title" i], [class*="filename" i]'),
      )) {
        if (pre.contains(el)) continue;
        const hit = asFilename(el.textContent);
        if (hit) return hit;
      }
    }
    return null;
  };

  const proseText = (el: Element): string => {
    if (!el.querySelector('pre, ul, ol')) return (el as HTMLElement).innerText;
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('pre, ul, ol, button, script, style').forEach((n) => n.remove());
    return copy.textContent ?? '';
  };

  type Item = RawBlock & { prose: boolean };
  const items: Item[] = [];
  const headingPath: string[] = [];
  const levels: number[] = [];

  const all = rootEl.querySelectorAll(`h1, h2, h3, h4, p, li, ${cfg.codeBlocks}`);
  for (const el of Array.from(all)) {
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();

    if (/^h[1-4]$/.test(tag)) {
      const level = Number(tag.slice(1));
      while (levels.length > 0 && (levels[levels.length - 1] ?? 0) >= level) {
        levels.pop();
        headingPath.pop();
      }
      const text = clean((el as HTMLElement).innerText);
      if (text === '') continue;
      levels.push(level);
      headingPath.push(text);
      items.push({
        kind: 'heading',
        lang: null,
        text,
        filenameHint: null,
        headingPath: [...headingPath],
        prose: false,
      });
      continue;
    }

    if (el.matches(cfg.codeBlocks)) {
      items.push({
        kind: 'code',
        lang: langOf(el),
        text: codeText(el),
        filenameHint: hintOf(el),
        headingPath: [...headingPath],
        prose: false,
      });
      continue;
    }

    // p / li: skip text that lives inside code, and containers whose own p/li children carry it.
    if (el.closest('pre') || el.querySelector('p, li')) continue;
    items.push({
      kind: 'prose',
      lang: null,
      text: proseText(el),
      filenameHint: null,
      headingPath: [...headingPath],
      prose: true,
    });
  }

  // Keep prose only when it is within 2 blocks before a code block, without crossing a heading.
  const keep = new Array<boolean>(items.length).fill(false);
  items.forEach((item, i) => {
    if (item.kind === 'code') {
      for (let back = 1; back <= 2; back++) {
        const prev = items[i - back];
        if (!prev || prev.kind === 'heading') break;
        keep[i - back] = true;
      }
    }
  });

  return items
    .filter((item, i) => (item.prose ? keep[i] === true : true))
    .map(({ kind, lang, text, filenameHint, headingPath: path }) => ({
      kind,
      lang,
      text,
      filenameHint,
      headingPath: path,
    }));
}
