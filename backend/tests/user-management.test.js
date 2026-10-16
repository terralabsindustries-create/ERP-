/**
 * User management: roles as named permission sets, teams, invitations and who
 * may change whose access. Every check here is against the API, not the UI.
 */
const request = require('supertest');
const app = require('../src/app');
const mailer = require('../src/utils/mailer');
const User = require('../src/models/User');
const AccessRole = require('../src/models/AccessRole');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

const MANAGER_PERMS = ['Dashboard', 'Jobs', 'Staff & Tasks', 'Customers', 'Invoicing', 'Payments', 'Reports', 'User Management'];

let org;
let other;
const as = (who, o = org) => ({
  get: (url) => request(app).get(url).set(auth(o.tokens[who])),
  post: (url, body) => request(app).post(url).set(auth(o.tokens[who])).send(body),
  put: (url, body) => request(app).put(url).set(auth(o.tokens[who])).send(body),
  delete: (url) => request(app).delete(url).set(auth(o.tokens[who]))
});
const roleNamed = async (name, o = org) => (await as('admin', o).get('/api/access-roles')).body.data.roles.find((r) => r.name === name);

beforeAll(async () => {
  await connectTestDb('usermgmt');
  await AccessRole.init();
  org = await createOrg('um', { managerPermissions: MANAGER_PERMS });
  other = await createOrg('xo');
});
afterAll(disconnectTestDb);
afterEach(() => jest.restoreAllMocks());

describe('roles', () => {
  test('a business starts with the print-shop roles, created once', async () => {
    const [first, second] = await Promise.all([as('admin').get('/api/access-roles'), as('admin').get('/api/access-roles')]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const res = await as('admin').get('/api/access-roles');
    const names = res.body.data.roles.map((r) => r.name);
    expect(names).toEqual(['Shop manager', 'Accountant', 'Front desk', 'Designer', 'Press operator', 'Dispatch']);
    expect(res.body.data.customCount).toBe(3);
    expect(res.body.data.ownerCount).toBe(1);
  });

  test('staff without User Management cannot see or change roles', async () => {
    expect((await as('staff1').get('/api/access-roles')).status).toBe(403);
    expect((await as('staff1').post('/api/access-roles', { name: 'x', baseRole: 'staff', permissions: [] })).status).toBe(403);
  });

  test('a manager can create a role only from permissions they hold', async () => {
    const ok = await as('manager').post('/api/access-roles', {
      name: 'Billing clerk', baseRole: 'staff', permissions: ['Invoicing', 'Invoicing: View', 'Invoicing: Create & Edit']
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.role.permissions).toEqual(['Dashboard', 'Invoicing', 'Invoicing: View', 'Invoicing: Create & Edit']);

    const beyond = await as('manager').post('/api/access-roles', { name: 'Books', baseRole: 'staff', permissions: ['Accounts'] });
    expect(beyond.status).toBe(403);
  });

  test('a manager cannot edit or delete a role that holds more than they do', async () => {
    const accountant = await roleNamed('Accountant');
    expect(accountant.editable).toBe(true); // the admin's view
    const put = await as('manager').put(`/api/access-roles/${accountant._id}`, { ...accountant, permissions: ['Invoicing'] });
    expect(put.status).toBe(403);
    expect((await as('manager').delete(`/api/access-roles/${accountant._id}`)).status).toBe(403);
  });

  test('role names are unique in a business, ignoring case', async () => {
    const res = await as('admin').post('/api/access-roles', { name: 'designer', baseRole: 'staff', permissions: [] });
    expect(res.status).toBe(409);
  });

  test('staff roles can never see all staff data', async () => {
    const res = await as('admin').post('/api/access-roles', { name: 'Odd one', baseRole: 'staff', permissions: [], canViewAllData: true });
    expect(res.status).toBe(201);
    expect(res.body.data.role.canViewAllData).toBe(false);
  });
});

describe('giving people a role', () => {
  test('the role\'s permissions are copied to the login and take effect at once', async () => {
    const designer = await roleNamed('Designer');
    const res = await as('admin').put(`/api/users/${org.staff1._id}`, { accessRoleId: designer._id });
    expect(res.status).toBe(200);
    const u = await User.findById(org.staff1._id);
    expect(String(u.accessRole)).toBe(String(designer._id));
    expect(u.accessRoleName).toBe('Designer');
    expect(u.role).toBe('staff');
    expect([...u.permissions].sort()).toEqual([...designer.permissions].sort());

    expect((await as('staff1').get('/api/jobs')).status).toBe(200);
    expect((await as('staff1').get('/api/invoices')).status).toBe(403);
  });

  test('editing the role updates everyone who holds it', async () => {
    const designer = await roleNamed('Designer');
    const res = await as('admin').put(`/api/access-roles/${designer._id}`, {
      ...designer,
      name: 'Pre-press designer',
      permissions: [...designer.permissions, 'Invoicing', 'Invoicing: View']
    });
    expect(res.status).toBe(200);
    expect(res.body.data.usersUpdated).toBe(1);
    expect((await as('staff1').get('/api/invoices')).status).toBe(200);
    expect((await User.findById(org.staff1._id)).accessRoleName).toBe('Pre-press designer');
  });

  test('a role in use cannot be deleted until its holders move', async () => {
    const designer = await roleNamed('Pre-press designer');
    const blocked = await as('admin').delete(`/api/access-roles/${designer._id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ROLE_IN_USE');

    // Back to custom access, set one permission at a time.
    const custom = await as('admin').put(`/api/users/${org.staff1._id}`, { accessRoleId: null, permissions: ['Jobs', 'Jobs: View'] });
    expect(custom.status).toBe(200);
    const u = await User.findById(org.staff1._id);
    expect(u.accessRole).toBeNull();
    expect(u.accessRoleName).toBeUndefined();
    expect((await as('admin').delete(`/api/access-roles/${designer._id}`)).status).toBe(200);
  });

  test('nobody but the admin changes their own access', async () => {
    const dispatch = await roleNamed('Dispatch');
    expect((await as('staff1').put(`/api/users/${org.staff1._id}`, { accessRoleId: dispatch._id })).status).toBe(403);
    expect((await as('manager').put(`/api/users/${org.manager._id}`, { permissions: MANAGER_PERMS })).status).toBe(403);
    // Their own name is fine.
    expect((await as('staff1').put(`/api/users/${org.staff1._id}`, { fullName: 'UM Staff Uno' })).status).toBe(200);
  });

  test('a manager can only give roles within their own access', async () => {
    const clerk = await roleNamed('Billing clerk');
    expect((await as('manager').put(`/api/users/${org.staff2._id}`, { accessRoleId: clerk._id })).status).toBe(200);
    const accountant = await roleNamed('Accountant');
    expect((await as('manager').put(`/api/users/${org.staff2._id}`, { accessRoleId: accountant._id })).status).toBe(403);
  });

  test('a manager cannot change the admin or someone who holds more than they do', async () => {
    expect((await as('manager').put(`/api/users/${org.admin._id}`, { fullName: 'Taken over' })).status).toBe(403);
    const accountant = await roleNamed('Accountant');
    await as('admin').put(`/api/users/${org.staff2._id}`, { accessRoleId: accountant._id });
    const res = await as('manager').put(`/api/users/${org.staff2._id}`, { accessRoleId: null, permissions: ['Jobs'] });
    expect(res.status).toBe(403);
    expect((await as('manager').put(`/api/users/${org.staff2._id}/toggle-status`)).status).toBe(403);
  });

  test('the admin account keeps full access', async () => {
    const dispatch = await roleNamed('Dispatch');
    expect((await as('admin').put(`/api/users/${org.admin._id}`, { accessRoleId: dispatch._id })).status).toBe(403);
  });
});

describe('teams', () => {
  let teamId;

  test('a team holds people from this business, with an optional lead among them', async () => {
    const res = await as('admin').post('/api/teams', {
      name: 'Finishing', description: 'Cutting, binding, lamination', memberIds: [org.staff1._id, org.manager._id], leadId: org.manager._id
    });
    expect(res.status).toBe(201);
    teamId = res.body.data.team._id;
    expect(res.body.data.team.members.map((m) => m.fullName).sort()).toEqual(['UM Manager', 'UM Staff Uno']);
    expect(res.body.data.team.lead.fullName).toBe('UM Manager');

    expect((await as('admin').post('/api/teams', { name: 'Bad lead', memberIds: [org.staff1._id], leadId: org.staff2._id })).status).toBe(400);
    expect((await as('admin').post('/api/teams', { name: 'Poach', memberIds: [other.staff1._id] })).status).toBe(400);
    expect((await as('admin').post('/api/teams', { name: 'finishing' })).status).toBe(409);
  });

  test('the user list shows each person\'s teams and can be filtered by team', async () => {
    const res = await as('admin').get(`/api/users?team=${teamId}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.data.users.map((u) => u.fullName).sort()).toEqual(['UM Manager', 'UM Staff Uno']);
    expect(res.body.data.users[0].teams).toEqual([{ _id: teamId, name: 'Finishing' }]);
  });

  test('the team overview can be narrowed to one team', async () => {
    const res = await as('admin').get(`/api/team/overview?team=${teamId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.members.map((m) => m.user.fullName).sort()).toEqual(['UM Manager', 'UM Staff Uno']);
  });

  test('changing someone\'s teams moves them, and a lead who leaves stops being lead', async () => {
    await as('admin').put(`/api/users/${org.manager._id}`, { teamIds: [] });
    const team = (await as('admin').get('/api/teams')).body.data.teams.find((t) => t._id === teamId);
    expect(team.members.map((m) => m.fullName)).toEqual(['UM Staff Uno']);
    expect(team.lead).toBeUndefined();
  });

  test('staff need User Management: Edit Permissions to change teams', async () => {
    expect((await as('staff1').post('/api/teams', { name: 'Mine' })).status).toBe(403);
  });
});

describe('another business', () => {
  test('cannot see or change this business\'s roles, teams or people', async () => {
    const mine = await roleNamed('Front desk');
    const theirs = (await as('admin', other).get('/api/access-roles')).body.data.roles;
    expect(theirs.some((r) => r._id === mine._id)).toBe(false);
    expect((await as('admin', other).put(`/api/access-roles/${mine._id}`, { ...mine })).status).toBe(404);
    expect((await as('admin', other).delete(`/api/access-roles/${mine._id}`)).status).toBe(404);

    const team = (await as('admin').get('/api/teams')).body.data.teams[0];
    expect((await as('admin', other).get('/api/teams')).body.data.teams).toEqual([]);
    expect((await as('admin', other).put(`/api/teams/${team._id}`, { name: 'Ours now' })).status).toBe(404);
    expect((await as('admin', other).get(`/api/users?team=${team._id}`)).body.data.users).toEqual([]);

    // Nor hand one of this business's roles to their own staff.
    expect((await as('admin', other).put(`/api/users/${other.staff1._id}`, { accessRoleId: mine._id })).status).toBe(400);
  });
});

describe('invitations', () => {
  test('an invitation can carry a role and teams', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'invite' });
    jest.spyOn(mailer, 'createTransporter').mockReturnValue({ sendMail });
    const frontDesk = await roleNamed('Front desk');
    const team = (await as('admin').get('/api/teams')).body.data.teams[0];

    const res = await as('admin').post('/api/users', {
      email: 'counter@example.test', fullName: 'Counter Person', accessRoleId: frontDesk._id, teamIds: [team._id]
    });
    expect(res.status).toBe(201);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const u = await User.findOne({ email: 'counter@example.test' });
    expect(u.status).toBe('invited');
    expect(u.accessRoleName).toBe('Front desk');
    expect([...u.permissions].sort()).toEqual([...frontDesk.permissions].sort());

    const listed = (await as('admin').get('/api/users?status=invited')).body.data.users.find((x) => x.email === 'counter@example.test');
    expect(listed.teams.map((t) => t.name)).toEqual([team.name]);
    expect(listed.invitation.expiresAt).toBeTruthy();
  });

  test('inviting needs User Management: Create Login', async () => {
    expect((await as('staff2').post('/api/users', { email: 'nope@example.test', fullName: 'Nope' })).status).toBe(403);
  });
});

describe('active status', () => {
  test('a manager with Edit Permissions can switch off staff they can manage, never the admin', async () => {
    const res = await as('manager').put(`/api/users/${org.staff1._id}/toggle-status`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.isActive).toBe(false);
    const inactive = (await as('admin').get('/api/users?status=inactive')).body.data.users.map((u) => u.fullName);
    expect(inactive).toEqual(['UM Staff Uno']);
    expect((await as('manager').put(`/api/users/${org.admin._id}/toggle-status`)).status).toBe(403);
  });
});

describe('mail not set up', () => {
  test('an invitation says email is not configured instead of a server error', async () => {
    const res = await as('admin').post('/api/users', { email: 'nomail@example.test', fullName: 'No Mail' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMAIL_NOT_CONFIGURED');
    expect(await User.exists({ email: 'nomail@example.test' })).toBeNull();
  });
});
