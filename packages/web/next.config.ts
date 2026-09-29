import type { NextConfig } from 'next'

const config: NextConfig = {
  // @knot-tui/core ships raw TypeScript (its `exports` points at src/index.ts).
  transpilePackages: ['@knot-tui/core'],
  // Core's NodeNext imports name `./x.js` for `./x.ts`. Turbopack can't map that
  // (16.3 ignores this option), which is why the scripts pass `--webpack`.
  experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
}

export default config
