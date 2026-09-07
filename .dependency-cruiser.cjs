/** Enforces the hexagonal dependency direction: adapters -> ports -> application -> domain. */
module.exports = {
  forbidden: [
    {
      name: 'domain-no-adapters',
      comment: 'domain/ must never import adapters/ or ui/ — it owns zero I/O.',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src/(adapters|ui)' },
    },
    {
      name: 'domain-no-runtime-deps',
      comment: 'domain/ must never import a third-party runtime package.',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { dependencyTypes: ['npm', 'npm-dev'], pathNot: '^(node:)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
  },
};
