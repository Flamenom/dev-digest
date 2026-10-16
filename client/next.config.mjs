import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001",
  },
  webpack: (config) => {
    /**
     * `@devdigest/shared` is VENDORED TypeScript whose internal specifiers are
     * NodeNext-style (`./contracts/findings.js` for a file that is really
     * `findings.ts`). tsc (moduleResolution: Bundler) and vitest both perform the
     * .js -> .ts substitution themselves; webpack does not, so a *runtime* import
     * of the barrel fails to resolve while a type-only one silently works (SWC
     * erases it before resolution ever runs). Every client import was type-only
     * until the eval case editor needed `EvalExpectedOutput.safeParse` as a value.
     * The `.js` fallback is kept last so genuine .js files still resolve.
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default withNextIntl(nextConfig);
