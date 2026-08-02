module.exports = {
  collectCoverage: true,
  coverageDirectory: "coverage",
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  // tests/turso.test.ts runs under jest.turso.config.cjs instead: the Turso
  // client packages are ESM-only and need --experimental-vm-modules, which
  // cannot be enabled for this suite without losing the injected `jest` global.
  testPathIgnorePatterns: ["dist/", "tests/turso.test.ts"],
  forceExit: true,
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { 
      useESM: true,
      tsconfig: {
        module: "ESNext",
        moduleResolution: "Bundler",
        allowImportingTsExtensions: false,
        esModuleInterop: true
      }
    }],
  },
};
