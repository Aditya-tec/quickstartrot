import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Target } from '@qsr/core';

export class TargetFileError extends Error {
  override readonly name = 'TargetFileError';
}

/** Where a target file may live: targets/<slug>.yaml, or targets/_canary/<slug>.yaml. */
export function candidatePaths(targetsDir: string, slug: string): string[] {
  return [path.join(targetsDir, `${slug}.yaml`), path.join(targetsDir, '_canary', `${slug}.yaml`)];
}

/** Reads and validates one target file. The slug inside must equal the file name (spec section 6). */
export async function parseTargetFile(file: string): Promise<Target> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new TargetFileError(`cannot read ${file}`);
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new TargetFileError(
      `${file}: invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = Target.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new TargetFileError(`${file}: ${issues}`);
  }

  const expected = path.basename(file, '.yaml');
  if (parsed.data.slug !== expected) {
    throw new TargetFileError(
      `${file}: slug "${parsed.data.slug}" must equal the file name "${expected}"`,
    );
  }
  return parsed.data;
}

export async function loadTarget(targetsDir: string, slug: string): Promise<Target> {
  for (const file of candidatePaths(targetsDir, slug)) {
    try {
      return await parseTargetFile(file);
    } catch (err) {
      if (err instanceof TargetFileError && err.message.startsWith('cannot read')) continue;
      throw err;
    }
  }
  throw new TargetFileError(`no target "${slug}" found in ${targetsDir}`);
}

/** Every target file (excluding canaries unless asked), validated. Used by plan and validate-targets. */
export async function loadAllTargets(
  targetsDir: string,
  opts: { canaries?: boolean } = {},
): Promise<Target[]> {
  const dirs = [targetsDir, ...(opts.canaries ? [path.join(targetsDir, '_canary')] : [])];
  const targets: Target[] = [];
  for (const dir of dirs) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const name of entries.filter((n) => n.endsWith('.yaml')).sort()) {
      targets.push(await parseTargetFile(path.join(dir, name)));
    }
  }
  return targets;
}
