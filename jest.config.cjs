module.exports = {
  collectCoverage: true,
  coverageDirectory: "coverage",
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  testPathIgnorePatterns: ["dist/"],
  forceExit: true,
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    // Workspace packages resolve to source so tests never require a build.
    "^@resonatehq/base$": "<rootDir>/packages/base/src/index.ts",
    "^@resonatehq/connector-http$": "<rootDir>/packages/connector-http/src/index.ts",
    "^@resonatehq/connector-nats$": "<rootDir>/packages/connector-nats/src/index.ts",
    "^@resonatehq/connector-pg$": "<rootDir>/packages/connector-pg/src/index.ts",
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
