/* ESLint flat config (v9). eslint-config-next bundles the rule set this app
   needs most: react-hooks (exhaustive-deps — see the useMemo trap this repo
   already hit once), jsx-a11y, and Next's RSC/link/image rules.
   eslint-config-next ships as legacy shareable config, so it is loaded through
   FlatCompat until it publishes a native flat config. */
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      // Build artifacts only — src/vendor/* is first-party code and IS linted.
    ],
  },
  ...compat.extends("next/core-web-vitals"),
];

export default config;
