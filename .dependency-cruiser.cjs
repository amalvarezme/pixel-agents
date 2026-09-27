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
    {
      name: 'pixi-only-in-scene-pixi',
      comment: 'Only src/ui/scene/pixi/ may import pixi.js — layout math and the rest of ui/ stay canvas-free and testable without a browser (design.md D3).',
      severity: 'error',
      from: { path: '^src/ui', pathNot: ['^src/ui/scene/pixi', '\\.test\\.ts$'] },
      to: { path: 'pixi\\.js' },
    },
    {
      name: 'launcher-no-ingestion-adapter-imports',
      comment: 'The launcher subsystem shares the event bus but no code path with any ingestion adapter (design.md "Subsystem Separation from Ingestion").',
      severity: 'error',
      from: { path: '^src/adapters/driven/launcher', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/adapters/driven/(claude-code|codex|opencode|antigravity)' },
    },
    {
      name: 'mcp-no-adapters',
      comment:
        'src/mcp/ is a driving adapter: it reaches the visualizer over HTTP and imports the domain/ports layer directly, never another adapter. This is what keeps office_launch a genuine proxy (the Zero-Injection denylist and the /launch validation stay behind their own route) and office_snapshot a reader of the real SSE frame.',
      severity: 'error',
      from: { path: '^src/mcp', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/adapters' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
  },
};
