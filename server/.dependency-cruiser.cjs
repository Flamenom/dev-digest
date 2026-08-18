/**
 * Onion Architecture fitness function — see `.claude/skills/onion-architecture/`.
 *
 * Rings, innermost → outermost:
 *   core contracts + ports   src/vendor/shared/{contracts/*,adapters.ts}
 *   domain / policy          ../reviewer-core/src/*  ·  src/platform/grounding.ts
 *   application              src/modules/<m>/{service,run-executor,diff-loader}.ts
 *   infrastructure           src/adapters/*  ·  src/modules/<m>/repository*  ·  src/db/*
 *   presentation             src/modules/<m>/routes.ts  ·  src/platform/sse.ts
 *   composition root         src/platform/container.ts   (outside the rings)
 *
 * THE RULE: imports point inward only. Sideways between feature modules is
 * forbidden — cross-cutting entities resolve through the container.
 *
 * Run: `pnpm arch`. dependency-cruiser follows the node.js release cycle and
 * refuses odd-numbered releases — use node ^20.12 || ^22 || >=24 (node 23 fails).
 *
 * SEVERITIES: rules already at zero violations are `error` (they must never
 * regress). Rules with a known backlog are `warn` until their modules migrate —
 * flip each to `error` as it reaches zero. Baseline at introduction: 41 warnings,
 * 0 errors. See SKILL.md §13 for the migration order.
 */

/** Web framework — reachable from the presentation ring only. */
const WEB_FRAMEWORK =
  'node_modules/(fastify|@fastify|fastify-sse-v2|fastify-type-provider-zod)/';

/** DB packages — reachable from the infrastructure ring only. */
const DB_PACKAGES = 'node_modules/(drizzle-orm|postgres|drizzle-kit)/';

/** The layers that legitimately own data access. */
const DATA_LAYER =
  '^src/db/|^src/modules/[^/]+/repository(\\.ts|/)|^src/platform/(container|jobs)\\.ts$';

/** …plus bootstrap, which creates the Db client and pings it for /health. */
const DATA_LAYER_OR_BOOTSTRAP = DATA_LAYER + '|^src/(app|server)\\.ts$';

/**
 * Everything inside a feature module EXCEPT its presentation edge:
 * `routes.ts` (the HTTP adapter), `_shared/context.ts` (a route helper) and
 * `modules/index.ts` (the static plugin registry).
 */
const MODULE_INNARDS = {
  path: '^src/modules/',
  pathNot:
    '^src/modules/[^/]+/routes\\.ts$|^src/modules/_shared/context\\.ts$|^src/modules/index\\.ts$',
};

const REVIEWER_CORE = '^\\.\\./reviewer-core/src/';

module.exports = {
  forbidden: [
    // ======== ring: domain core (reviewer-core) — holds today, keep it ========
    {
      name: 'core-purity',
      comment:
        'reviewer-core is the domain core: no DB, no GitHub, no git, no ripgrep/ast-grep, no HTTP ' +
        'framework. Its ONLY side effect is the injected LLMProvider.',
      severity: 'error',
      from: { path: REVIEWER_CORE },
      to: {
        path: [
          DB_PACKAGES,
          WEB_FRAMEWORK,
          'node_modules/(octokit|@octokit|simple-git|@ast-grep|dependency-cruiser|@vscode/ripgrep)/',
        ].join('|'),
      },
    },
    {
      name: 'core-no-server-imports',
      comment:
        'reviewer-core may read the shared contracts (src/vendor/shared) and NOTHING else from the ' +
        'server. Anything else is an outward import from the innermost ring.',
      severity: 'error',
      from: { path: REVIEWER_CORE },
      to: { path: '^src/', pathNot: '^src/vendor/shared/' },
    },
    {
      name: 'core-no-io-builtins',
      comment:
        'The domain core must not touch the filesystem, subprocesses or the network directly. ' +
        'Skills/memory/specs arrive as ALREADY-resolved strings; progress/cancel are callbacks.',
      severity: 'error',
      from: { path: REVIEWER_CORE },
      to: {
        dependencyTypes: ['core'],
        path: '^(fs|fs/promises|child_process|net|http|https|dns|dgram)$',
      },
    },

    // ======== ring: presentation is outermost — clean today, keep it =========
    {
      name: 'no-fastify-inward',
      comment:
        'Fastify is presentation-only. A service/executor/repository must not know it is driven by ' +
        'HTTP: routes translate request → plain args and domain result → response. Inject a narrow ' +
        'structural Logger (modules/reviews/run-executor.ts is the model) instead of pino/fastify types.',
      severity: 'error',
      from: MODULE_INNARDS,
      to: { path: WEB_FRAMEWORK },
    },
    {
      name: 'no-fastify-in-adapters',
      comment: 'Adapters implement ports; they are never aware of the HTTP edge.',
      severity: 'error',
      from: { path: '^src/adapters/' },
      to: { path: WEB_FRAMEWORK },
    },
    {
      name: 'no-fastify-in-core',
      comment: 'Belt-and-braces: the domain ring never sees the web framework.',
      severity: 'error',
      from: { path: REVIEWER_CORE },
      to: { path: WEB_FRAMEWORK },
    },

    // ======== ring: infrastructure — known backlog, migrating ================
    {
      name: 'no-db-outside-repo',
      comment:
        'The repository is the ONLY layer that runs queries. Drizzle/postgres imports belong in ' +
        'src/db, src/modules/<m>/repository*, platform/jobs.ts, the composition root and bootstrap. ' +
        'A route that builds its own `eq(...)` has skipped the repository entirely.',
      severity: 'warn',
      from: { path: '^src/', pathNot: DATA_LAYER_OR_BOOTSTRAP },
      to: { path: DB_PACKAGES },
    },
    {
      name: 'no-db-schema-outside-repo',
      comment:
        'Drizzle $inferSelect row types must not leave the repository. Map row → domain type at the ' +
        'repository boundary; a service or route typed by src/db/{schema,rows} is coupled to the ' +
        'physical tables and breaks on any migration.',
      severity: 'warn',
      from: { path: '^src/', pathNot: DATA_LAYER },
      to: { path: '^src/db/(schema|rows)' },
    },

    // ======== composition root ==============================================
    {
      name: 'no-container-inward',
      comment:
        'A service must RECEIVE its dependencies, not fetch them. Importing platform/container.ts ' +
        'makes the application ring depend on the composition root — and through it on every ' +
        'concrete adapter. Take an explicit deps object, built in the container, instead.',
      severity: 'warn',
      from: MODULE_INNARDS,
      to: { path: '^src/platform/container\\.ts$' },
    },
    {
      name: 'no-concrete-adapter-outside-root',
      comment:
        'Only the composition root may name a concrete adapter. Elsewhere depend on the port ' +
        'interface from @devdigest/shared. NOTE: when the import is a PURE helper that happens to ' +
        'live under adapters/ (git/diff-parser, codeindex/extract, astgrep), the placement is the ' +
        'smell — move the function into the domain ring instead of importing outward.',
      severity: 'warn',
      from: { path: '^src/', pathNot: '^src/platform/container\\.ts$|^src/adapters/|^src/db/' },
      to: { path: '^src/adapters/' },
    },

    // ======== vertical slices (the "sliced onion") ==========================
    {
      name: 'no-cross-module',
      comment:
        'Feature modules are independent vertical slices. Never import a sibling module folder — ' +
        'cross-cutting entities resolve through the container (container.agentsRepo, .repoIntel). ' +
        'modules/_shared is the one shared slice.',
      severity: 'warn',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/([^/]+)/', pathNot: '^src/modules/$1/|^src/modules/_shared/' },
    },

    // ======== structural hygiene ============================================
    {
      name: 'no-circular',
      comment:
        'A cycle means two files ended up in the same ring by accident. Split the shared piece ' +
        'inward rather than importing back outward.',
      severity: 'warn',
      from: {},
      to: { circular: true },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.ts$|^src/db/migrations/|/clones/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
