import { dataMode, supabaseConfig } from '../env';
import { FIXTURE_NOW, FixtureDataSource } from './fixtures';
import type { DataSource } from './source';
import { createSupabaseDataSource } from './supabase';

// Which DataSource the app uses: QSR_DATA=fixtures selects the seeded fixtures, anything else reads the public
// views of the Supabase project (anon key, server side only). Server code only; never import this from a
// client component.

let instance: DataSource | null = null;

export function getDataSource(): DataSource {
  if (instance) return instance;
  if (dataMode() === 'fixtures') {
    instance = new FixtureDataSource();
  } else {
    const { url, anonKey } = supabaseConfig();
    instance = createSupabaseDataSource(url, anonKey);
  }
  return instance;
}

/** "Now" for relative times. Fixtures have a fixed clock so every page and screenshot is reproducible. */
export function getNow(): Date {
  return dataMode() === 'fixtures' ? FIXTURE_NOW : new Date();
}
