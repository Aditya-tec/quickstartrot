// Every number in a text, as digits: digits and decimals, number words (one to twelve, once, twice) and ordinals (first to tenth). The names
// of levels and versions (L3, Level 3, v2) are not figures. Browser-safe. Used to check that the README and /methodology state only numbers
// that are in docs/CLAIMS.md.

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  once: '1',
  twice: '2',
  first: '1',
  second: '2',
  third: '3',
  fourth: '4',
  fifth: '5',
  sixth: '6',
  seventh: '7',
  eighth: '8',
  ninth: '9',
  tenth: '10',
};

export function numbersIn(text: string): Set<string> {
  const cleaned = text
    .replaceAll(/\bLevel \d\b/gi, ' ')
    .replaceAll(/\bL\d\b/g, ' ')
    .replaceAll(/\bv\d\b/g, ' ');
  const found = new Set<string>();
  for (const m of cleaned.match(/\d+(?:\.\d+)?/g) ?? []) found.add(m);
  for (const word of cleaned.toLowerCase().match(/\b[a-z]+\b/g) ?? []) {
    const n = NUMBER_WORDS[word];
    if (n !== undefined) found.add(n);
  }
  return found;
}
