// Backend API tests run against a throwaway database on the local MongoDB
// (MONGODB_TEST_URI, default mongodb://127.0.0.1:27017). Each test file gets its
// own database, dropped when the file finishes.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testTimeout: 30000,
  maxWorkers: 1
};
