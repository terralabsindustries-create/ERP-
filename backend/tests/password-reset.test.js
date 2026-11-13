/**
 * Forgot password: request a code by email, then set a new password with it.
 */
const request = require('supertest');
const app = require('../src/app');
const mailer = require('../src/utils/mailer');
const User = require('../src/models/User');
const OTP = require('../src/models/OTP');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg } = require('./helpers/fixtures');

let org;
let sent;

const forgot = (email) => request(app).post('/api/auth/forgot-password').send({ email });
const reset = (email, otp, newPassword = 'brand-new-pass') =>
  request(app).post('/api/auth/reset-password').send({ email, otp, newPassword });
const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });
const codeIn = (message) => message.text.match(/\b(\d{6})\b/)[1];
// Lets the next request through the one-code-a-minute limit.
const ageCodes = (email) => OTP.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - 120e3) } });

beforeAll(async () => {
  await connectTestDb('password_reset');
  org = await createOrg('pwreset');
});

beforeEach(() => {
  sent = [];
  jest.spyOn(mailer, 'createTransporter').mockReturnValue({
    sendMail: jest.fn(async (message) => { sent.push(message); return { messageId: 'm' }; })
  });
});

afterEach(() => jest.restoreAllMocks());
afterAll(disconnectTestDb);

test('a reset code changes the password once and only once', async () => {
  const email = org.staff1.email;
  const response = await forgot(email);
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe(email);
  expect(sent[0].subject).toMatch(/reset your password/i);
  const code = codeIn(sent[0]);
  expect((await OTP.findOne({ email })).otp).not.toBe(code); // stored hashed

  expect((await reset(email, code)).status).toBe(200);
  expect((await login(email, 'brand-new-pass')).status).toBe(200);
  expect((await login(email, 'Passw0rd!')).status).toBe(401);
  expect((await reset(email, code, 'another-pass')).status).toBe(400);
});

test('unknown, invited and deactivated addresses get the same answer and no email', async () => {
  const known = await (async () => { await ageCodes(org.staff2.email); return forgot(org.staff2.email); })();
  await User.updateOne({ _id: org.manager._id }, { status: 'invited' });
  await User.updateOne({ _id: org.admin._id }, { isActive: false });
  const others = await Promise.all([forgot('nobody@example.test'), forgot(org.manager.email), forgot(org.admin.email)]);
  for (const response of others) {
    expect(response.status).toBe(known.status);
    expect(response.body).toEqual(known.body);
  }
  expect(sent.map((m) => m.to)).toEqual([org.staff2.email]);
  await User.updateOne({ _id: org.manager._id }, { status: 'active' });
  await User.updateOne({ _id: org.admin._id }, { isActive: true });
});

test('wrong guesses are limited and a repeat request inside a minute sends nothing', async () => {
  const email = org.manager.email;
  await forgot(email);
  await forgot(email);
  expect(sent).toHaveLength(1);
  const code = codeIn(sent[0]);
  const wrong = code === '000000' ? '111111' : '000000';

  const guesses = await Promise.all(Array.from({ length: 8 }, () => reset(email, wrong)));
  expect(guesses.every((r) => r.status === 400)).toBe(true);
  expect((await OTP.findOne({ email })).attempts).toBe(5);
  const locked = await reset(email, code);
  expect(locked.status).toBe(400);
  expect(locked.body.code).toBe('RESET_CODE_LOCKED');

  await ageCodes(email);
  await forgot(email);
  expect(sent).toHaveLength(2);
  expect((await reset(email, codeIn(sent[1]))).status).toBe(200);
});

test('a code that could not be emailed is discarded and the error is reported', async () => {
  const email = org.admin.email;
  mailer.createTransporter.mockReturnValue({ sendMail: jest.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNECTION' })) });
  const failed = await forgot(email);
  expect(failed.status).toBe(503);
  expect(failed.body.code).toBe('EMAIL_UNREACHABLE');
  expect(await OTP.countDocuments({ email })).toBe(0);
});
