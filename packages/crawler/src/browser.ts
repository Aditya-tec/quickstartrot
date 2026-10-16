import { chromium, type Browser } from 'playwright';

/** Headless Chromium, the only browser we use (spec section 2). Caller closes it. */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch();
}
