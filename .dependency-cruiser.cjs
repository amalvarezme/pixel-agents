/** Enforces the hexagonal dependency direction: adapters -> ports -> application -> domain. */
module.exports = {
  forbidden: [
    {
      name: 'domain-no-adapters',
      comment: 'domain/ production code must never import adapters/ or ui/ — it owns zero I/O.',
      severity: 'error',
      from: { path: '^src/domain', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(adapters|ui)' },
    },
    {
      name: 'domain-no-runtime-deps',
      comment: 'domain/ production code must never import a third-party runtime package (test files may import the test runner).',
      severity: 'error',
      from: { path: '^src/domain', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm', 'npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
  },
};
