import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

const config = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    ignores: ['.next/**', 'node_modules/**', 'tests/**', 'ui-check.mjs'],
  },
  {
    rules: {
      // The gallery renders arbitrary remote URLs discovered at scan time, so
      // next/image (which needs a static remote-pattern allowlist) cannot be used.
      '@next/next/no-img-element': 'off',
    },
  },
];

export default config;
