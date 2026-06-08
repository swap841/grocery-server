module.exports = {
  testEnvironment: "node",
  setupFiles: ["./tests/__mocks__/setup.js"],
  testMatch: ["**/tests/**/*.test.js"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary"],
  collectCoverageFrom: [
    "middleware/**/*.js",
    "services/**/*.js",
  ],
  testTimeout: 15000,
  forceExit: true,
  detectOpenHandles: false,
};
