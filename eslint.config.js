import tseslint from 'typescript-eslint';

// The website must never turn data into markup (logs, diffs, names and summaries are rendered as React text).
// Every way of doing that is a lint error in apps/web; apps/web/src/lib/no-raw-html.test.ts checks it too.
const RAW_HTML = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is not allowed: render data as text.',
  },
  {
    selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
    message: 'innerHTML and outerHTML are not allowed: render data as text.',
  },
  {
    selector:
      'CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment)$/]',
    message:
      'insertAdjacentHTML and createContextualFragment are not allowed: render data as text.',
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^write(ln)?$/]",
    message: 'document.write is not allowed.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      'fixtures/**',
      'apps/web/next-env.d.ts',
      'apps/web/screenshots/**',
      'apps/web/test-results/**',
      'apps/web/playwright-report/**',
      'apps/web/lighthouse-reports/**',
    ],
  },
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: { 'no-restricted-syntax': ['error', ...RAW_HTML] },
  },
);
