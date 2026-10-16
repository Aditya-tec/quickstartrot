// The alert channel (spec section 14): an issue labelled `harness` in our own repository, opened by the
// report job with the default GITHUB_TOKEN (issues: write on that job only). One open issue at a time: a
// second problem is a comment on it, so a bad week is one thread and not fifty issues.

export const HARNESS_LABEL = 'harness';
const API = 'https://api.github.com';

export class GitHubError extends Error {
  override readonly name = 'GitHubError';
}

export interface HarnessProblem {
  fetch: typeof fetch;
  token: string;
  /** owner/name, from GITHUB_REPOSITORY. */
  repository: string;
  title: string;
  body: string;
}

export interface HarnessProblemResult {
  action: 'created' | 'commented';
  url: string;
}

interface IssueLike {
  number?: number;
  html_url?: string;
  pull_request?: unknown;
}

export async function reportHarnessProblem(input: HarnessProblem): Promise<HarnessProblemResult> {
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'quickstartrot-report',
    'Content-Type': 'application/json',
  };
  const repo = `${API}/repos/${input.repository}`;

  async function call(method: string, url: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await input.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new GitHubError(
        `${method} ${url.replace(API, '')} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(
        `${method} ${url.replace(API, '')} failed: ${res.status} ${text.slice(0, 200)}`,
      );
    }
    return res.json();
  }

  const open = (await call(
    'GET',
    `${repo}/issues?labels=${HARNESS_LABEL}&state=open&per_page=30`,
  )) as IssueLike[];
  const existing = open.find((i) => i.pull_request === undefined && typeof i.number === 'number');
  if (existing) {
    const comment = (await call('POST', `${repo}/issues/${String(existing.number)}/comments`, {
      body: input.body,
    })) as IssueLike;
    return { action: 'commented', url: comment.html_url ?? existing.html_url ?? '' };
  }
  const created = (await call('POST', `${repo}/issues`, {
    title: input.title,
    body: input.body,
    labels: [HARNESS_LABEL],
  })) as IssueLike;
  return { action: 'created', url: created.html_url ?? '' };
}
