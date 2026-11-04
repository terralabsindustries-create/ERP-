/**
 * Staff invitations end to end: the email itself, accepting a link, expired and
 * used links, resending, and what happens to a working link when email fails.
 */
const request = require('supertest');
const app = require('../src/app');
const mailer = require('../src/utils/mailer');
const User = require('../src/models/User');
const {
  getInvitationEmailTemplate,
  buildAcceptUrl,
  hashInvitationToken
} = require('../src/utils/invitationUtils');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
const asAdmin = {
  post: (url, body) => request(app).post(url).set(auth(org.tokens.admin)).send(body),
  put: (url, body) => request(app).put(url).set(auth(org.tokens.admin)).send(body)
};
const lookup = (token) => request(app).get(`/api/auth/invitation/${token}`);
const accept = (token, password = 'secure-password') =>
  request(app).post(`/api/auth/invitation/${token}/accept`).send({ password });
const login = (email, password = 'secure-password') =>
  request(app).post('/api/auth/login').send({ email, password });

// A stand-in mail transport that records every message and can be told to fail.
const mockMail = () => {
  const sent = [];
  const sendMail = jest.fn(async (message) => {
    sent.push(message);
    return { messageId: `m${sent.length}` };
  });
  jest.spyOn(mailer, 'createTransporter').mockReturnValue({ sendMail });
  const tokenOf = (message = sent[sent.length - 1]) =>
    message.text.match(/accept-invitation\/([a-f0-9]{64})/)[1];
  return { sent, sendMail, tokenOf };
};

const smtpError = (props) => Object.assign(new Error('smtp failure'), props);

beforeAll(async () => {
  await connectTestDb('invitations');
  await User.init();
  org = await createOrg('inv', { managerPermissions: ['Dashboard', 'User Management'] });
});
afterAll(disconnectTestDb);
afterEach(() => jest.restoreAllMocks());

describe('the invitation email', () => {
  test('is from Carbon, carries the logo and a plain-text copy, and never says SerpY', async () => {
    const mail = mockMail();
    const res = await asAdmin.post('/api/users', {
      email: 'anu@example.test', fullName: 'Anu Joseph', role: 'staff', department: 'Pre-press'
    });
    expect(res.status).toBe(201);

    const message = mail.sent[0];
    expect(message.from).toEqual({ name: 'Carbon', address: expect.any(String) });
    expect(message.to).toBe('anu@example.test');
    expect(message.subject).toBe("You're invited to join INV Printers on Carbon");
    expect(message.html).toContain('http://localhost:8080/accept-invitation/');
    // Mail clients can't reach a developer's localhost, so the logo is the hosted copy.
    expect(message.html).toMatch(/<img src="https:\/\/[^"]+\/brand\/carbon-logo\.png"/);
    expect(message.html).toContain('INV admin has invited you');
    expect(message.text).toContain('Set your password:\nhttp://localhost:8080/accept-invitation/');
    expect(message.text).toMatch(/Department: +Pre-press/);
    expect(message.text).toContain('expires in 24 hours');
    for (const part of [message.subject, message.html, message.text, JSON.stringify(message.from)]) {
      expect(part).not.toMatch(/serpy/i);
    }
  });

  test('escapes what people typed and hides leftover SerpY names', () => {
    const { subject, html, text } = getInvitationEmailTemplate({
      fullName: '<script>alert(1)</script>',
      email: 'x@example.test',
      role: 'staff',
      companyName: 'SerpY ERP',
      acceptUrl: 'https://app.example.test/accept-invitation/abc'
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(subject).toBe("You're invited to join your team on Carbon");
    expect(`${subject}${html}${text}`).not.toMatch(/serpy/i);
  });

  test('links always open in a browser, even if FRONTEND_URL is the desktop app', () => {
    const saved = process.env.FRONTEND_URL;
    try {
      process.env.FRONTEND_URL = 'app://serpy';
      expect(buildAcceptUrl('abc')).toBe('https://erp-delta-one-83.vercel.app/accept-invitation/abc');
      process.env.FRONTEND_URL = 'https://erp.example.test/';
      expect(buildAcceptUrl('abc')).toBe('https://erp.example.test/accept-invitation/abc');
    } finally {
      process.env.FRONTEND_URL = saved;
    }
  });
});

describe('the sender', () => {
  test('keeps the configured mailbox but replaces a SerpY display name', () => {
    const saved = process.env.EMAIL_FROM;
    try {
      process.env.EMAIL_FROM = '"SerpY ERP" <erp@example.test>';
      expect(mailer.getFromAddress()).toEqual({ name: 'Carbon', address: 'erp@example.test' });
      // A business mailing its own customers still appears under its own name.
      expect(mailer.getFromAddress('Acme "Prints"')).toEqual({ name: 'Acme "Prints"', address: 'erp@example.test' });
      expect(mailer.getFromAddress('SerpY')).toEqual({ name: 'Carbon', address: 'erp@example.test' });
    } finally {
      process.env.EMAIL_FROM = saved;
    }
  });

  test('mail failures are explained in terms an admin can act on', () => {
    const codeOf = (error) => mailer.describeMailError(error).code;
    expect(codeOf({ code: 'EMAIL_NOT_CONFIGURED' })).toBe('EMAIL_NOT_CONFIGURED');
    expect(codeOf({ code: 'EAUTH', responseCode: 535 })).toBe('EMAIL_AUTH_FAILED');
    expect(codeOf({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 })).toBe('EMAIL_RECIPIENT_REJECTED');
    expect(codeOf({ code: 'EENVELOPE', responseCode: 550, response: '550 5.4.5 Daily user sending limit exceeded.' })).toBe('EMAIL_QUOTA_EXCEEDED');
    expect(codeOf({ code: 'ETIMEDOUT' })).toBe('EMAIL_UNREACHABLE');
    expect(codeOf({ code: 'EMESSAGE', responseCode: 421 })).toBe('EMAIL_TEMPORARY_FAILURE');
    expect(codeOf(new Error('anything else'))).toBe('EMAIL_SEND_FAILED');
  });
});

describe('accepting an invitation', () => {
  test('sets the password once, signs them in, and the used link says so', async () => {
    const mail = mockMail();
    expect((await asAdmin.post('/api/users', { email: 'flow@example.test', fullName: 'Flow Person', role: 'staff' })).status).toBe(201);
    const token = mail.tokenOf();

    // Not yet: the account has no password.
    const early = await login('flow@example.test');
    expect(early.status).toBe(403);
    expect(early.body.code).toBe('INVITATION_PENDING');

    const looked = await lookup(token);
    expect(looked.status).toBe(200);
    expect(looked.body.data.invitation).toMatchObject({ email: 'flow@example.test', companyName: 'INV Printers' });

    expect((await accept(token, '123')).status).toBe(400);

    const accepted = await accept(token);
    expect(accepted.status).toBe(200);
    expect(accepted.body.token).toBeTruthy();
    expect(accepted.body.data.user.email).toBe('flow@example.test');

    const reused = await lookup(token);
    expect(reused.status).toBe(410);
    expect(reused.body.code).toBe('INVITATION_USED');
    const replay = await accept(token, 'another-password');
    expect(replay.status).toBe(410);
    expect(replay.body.code).toBe('INVITATION_USED');

    expect((await login('flow@example.test')).status).toBe(200);
    expect((await login('flow@example.test', 'another-password')).status).toBe(401);

    // Once they've joined there is nothing to resend.
    const user = await User.findOne({ email: 'flow@example.test' });
    expect((await asAdmin.post(`/api/users/${user._id}/resend-invitation`, {})).status).toBe(400);
  });

  test('an expired link is refused with its own message, and a resend replaces it', async () => {
    const mail = mockMail();
    await asAdmin.post('/api/users', { email: 'late@example.test', fullName: 'Late Person', role: 'staff' });
    const oldToken = mail.tokenOf();
    await User.updateOne({ email: 'late@example.test' }, { 'invitation.expiresAt': new Date(Date.now() - 60000) });

    const expired = await lookup(oldToken);
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe('INVITATION_EXPIRED');
    expect((await accept(oldToken)).body.code).toBe('INVITATION_EXPIRED');
    expect((await login('late@example.test')).body.message).toMatch(/expired/);

    const user = await User.findOne({ email: 'late@example.test' });
    const resent = await asAdmin.post(`/api/users/${user._id}/resend-invitation`, {});
    expect(resent.status).toBe(200);
    const newToken = mail.tokenOf();
    expect(newToken).not.toBe(oldToken);

    expect((await lookup(oldToken)).body.code).toBe('INVITATION_INVALID');
    expect((await accept(newToken)).status).toBe(200);
    expect((await login('late@example.test')).status).toBe(200);
  });

  test('a made-up or malformed link is simply invalid', async () => {
    expect((await lookup('not-a-token')).status).toBe(404);
    const unknown = await lookup('a'.repeat(64));
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('INVITATION_INVALID');
    expect((await accept('b'.repeat(64))).status).toBe(404);
  });
});

describe('when email fails', () => {
  test('a new invitation leaves no login behind and says why', async () => {
    const mail = mockMail();
    mail.sendMail.mockRejectedValueOnce(smtpError({ code: 'ECONNECTION' }));
    const res = await asAdmin.post('/api/users', { email: 'nobody@example.test', fullName: 'Nobody', role: 'staff' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMAIL_UNREACHABLE');
    expect(res.body.message).toMatch(/Couldn't email the invitation to nobody@example\.test\..*could not be reached.*No login was created\./);
    expect(await User.exists({ email: 'nobody@example.test' })).toBeNull();
  });

  test('a failed resend keeps the link already sent working', async () => {
    const mail = mockMail();
    await asAdmin.post('/api/users', { email: 'keep@example.test', fullName: 'Keep Link', role: 'staff' });
    const token = mail.tokenOf();
    const user = await User.findOne({ email: 'keep@example.test' }).select('+invitation.tokenHash');

    mail.sendMail.mockRejectedValueOnce(smtpError({ code: 'EAUTH', responseCode: 535 }));
    const resend = await asAdmin.post(`/api/users/${user._id}/resend-invitation`, {});
    expect(resend.status).toBe(503);
    expect(resend.body.code).toBe('EMAIL_AUTH_FAILED');
    expect(resend.body.message).toMatch(/still works/);
    expect(resend.body.data.previousInvitationValid).toBe(true);

    const after = await User.findById(user._id).select('+invitation.tokenHash');
    expect(after.invitation.tokenHash).toBe(user.invitation.tokenHash);
    expect(after.invitation.tokenHash).toBe(hashInvitationToken(token));
    expect((await lookup(token)).status).toBe(200);
    expect((await accept(token)).status).toBe(200);
  });

  test('a failed re-invite changes nothing; a successful one replaces the link and the details', async () => {
    const mail = mockMail();
    await asAdmin.post('/api/users', { email: 'again@example.test', fullName: 'First Name', role: 'staff' });
    const firstToken = mail.tokenOf();

    mail.sendMail.mockRejectedValueOnce(smtpError({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }));
    const failed = await asAdmin.post('/api/users', { email: 'again@example.test', fullName: 'Second Name', role: 'manager' });
    expect(failed.status).toBe(422);
    expect(failed.body.code).toBe('EMAIL_RECIPIENT_REJECTED');
    expect(failed.body.message).toMatch(/Nothing was changed, and the invitation sent earlier still works/);
    let stored = await User.findOne({ email: 'again@example.test' });
    expect(stored.fullName).toBe('First Name');
    expect(stored.role).toBe('staff');
    expect((await lookup(firstToken)).status).toBe(200);

    const ok = await asAdmin.post('/api/users', { email: 'again@example.test', fullName: 'Second Name', role: 'manager' });
    expect(ok.status).toBe(201);
    stored = await User.findOne({ email: 'again@example.test' });
    expect(stored.fullName).toBe('Second Name');
    expect(stored.role).toBe('manager');
    expect((await lookup(firstToken)).body.code).toBe('INVITATION_INVALID');
    expect((await lookup(mail.tokenOf())).status).toBe(200);
    expect(await User.countDocuments({ email: 'again@example.test' })).toBe(1);
  });

  test('correcting an invitee\'s address reports whether the new email went out', async () => {
    const mail = mockMail();
    await asAdmin.post('/api/users', { email: 'typo@exmaple.test', fullName: 'Typo Person', role: 'staff' });
    const oldToken = mail.tokenOf();
    const user = await User.findOne({ email: 'typo@exmaple.test' });

    mail.sendMail.mockRejectedValueOnce(smtpError({ code: 'ETIMEDOUT' }));
    const res = await asAdmin.put(`/api/users/${user._id}`, { email: 'typo@example.test' });
    expect(res.status).toBe(200);
    expect(res.body.data.invitationEmail).toMatchObject({ sent: false, code: 'EMAIL_UNREACHABLE', to: 'typo@example.test' });
    expect(res.body.message).toMatch(/Use Resend invitation/);
    // The link that went to the wrong address must not keep working.
    expect((await lookup(oldToken)).status).toBe(404);

    const resent = await asAdmin.post(`/api/users/${user._id}/resend-invitation`, {});
    expect(resent.status).toBe(200);
    expect(mail.sent[mail.sent.length - 1].to).toBe('typo@example.test');
    expect((await accept(mail.tokenOf())).status).toBe(200);
  });
});
