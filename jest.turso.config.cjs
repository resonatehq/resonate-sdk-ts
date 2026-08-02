// The Turso client packages (`@tursodatabase/database`, `@tursodatabase/sync`)
// are ESM-only, so the tests that exercise `TursoNetwork` have to run under
// Jest's real ESM module registry — which needs `--experimental-vm-modules` on
// the Node process, not just `useESM` on the transform.
//
// That flag is process-wide and changes Jest's own semantics (the `jest` global
// is not injected in ESM mode), so it cannot be turned on for the whole suite
// without rewriting every existing test. Hence a second config: `npm test` runs
// the main suite, then re-invokes Jest under the flag with this config. See the
// `test:turso` script in package.json.
module.exports = {
  collectCoverage: false,
  testEnvironment: "node",
  preset: "ts-jest/presets/default-esm",
  testMatch: ["**/tests/turso.test.ts"],
  forceExit: true,
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          module: "ESNext",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: false,
          esModuleInterop: true,
        },
      },
    ],
  },
};
