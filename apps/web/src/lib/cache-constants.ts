// How long public data may be cached, in one place that needs no framework import. cached.ts uses it for the data
// cache, and the methodology page quotes it (through facts.ts), so the page cannot say a different number.

/** The data cache of every page (and the OG images): seconds. A finished cycle refreshes it at once. */
export const REVALIDATE_SECONDS = 300;
