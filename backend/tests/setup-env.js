// Runs before each test file loads the app.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.BCRYPT_SALT_ROUNDS = '4';
process.env.FRONTEND_URL = 'http://localhost:8080';
// Never send real mail from tests; individual tests mock the transport.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

// supertest starts a short-lived server per request. With Node's default
// keep-alive agent a later request can reuse a socket that server already
// closed, which shows up as an occasional "socket hang up".
const http = require('http');
http.globalAgent = new http.Agent({ keepAlive: false });

// The routes log every request in detail; keep test output readable.
if (!process.env.TEST_VERBOSE) {
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
}
