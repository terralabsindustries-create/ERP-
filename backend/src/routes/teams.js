const express = require('express');
const mongoose = require('mongoose');
const { body, param, validationResult } = require('express-validator');
const Team = require('../models/Team');
const ActivityLog = require('../models/ActivityLog');
const { orgScope, orgMemberIds } = require('../utils/accessScope');

/*
  Teams: groups of people in one business ("Pre-press", "Finishing"…). They
  organise people and filter the user list and team overview; they grant no
  access. Reading needs User Management or Staff & Tasks; changing needs User
  Management: Edit Permissions (app.js).
*/

const router = express.Router();

const rejectInvalid = (req, res) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ status: 'error', message: errors.array()[0].msg, errors: errors.array() });
  return true;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const teamValidation = [
  body('name').isString().trim().notEmpty().withMessage('Give the team a name').isLength({ max: 60 }).withMessage('Team names are limited to 60 characters'),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 300 }).withMessage('Descriptions are limited to 300 characters'),
  body('memberIds').optional().isArray().withMessage('Members must be a list'),
  body('memberIds.*').optional().isMongoId().withMessage('Unknown team member'),
  body('leadId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('Unknown team lead')
];

const MEMBER_FIELDS = 'fullName email role accessRoleName isActive status department';
const populated = (q) => q.populate('members', MEMBER_FIELDS).populate('lead', 'fullName');

/** Members and lead from the body, limited to people in the caller's business. */
async function resolveMembers(user, b) {
  const wanted = [...new Set((b.memberIds || []).map(String))];
  const org = new Set((await orgMemberIds(user)).map(String));
  const outside = wanted.filter((id) => !org.has(id));
  if (outside.length) return { error: 'Some of the people chosen are not in your business.' };
  const lead = b.leadId ? String(b.leadId) : null;
  if (lead && !wanted.includes(lead)) return { error: 'The team lead must be one of the members.' };
  return { members: wanted, lead };
}

const nameTaken = (user, name, exceptId) =>
  Team.exists({
    ...orgScope(user),
    name: { $regex: `^${escapeRegex(name.trim())}$`, $options: 'i' },
    ...(exceptId ? { _id: { $ne: exceptId } } : {})
  });

const logTeam = (req, team, action, actionType, description) =>
  ActivityLog.logActivity({
    action,
    description,
    entityType: 'team',
    entityId: team._id,
    entityName: team.name,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity: 'low',
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

// GET /api/teams
router.get('/', async (req, res) => {
  try {
    const teams = await populated(Team.find(orgScope(req.user)).sort({ name: 1 })).lean();
    res.json({ status: 'success', data: { teams } });
  } catch (error) {
    console.error('List teams error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading teams' });
  }
});

// POST /api/teams
router.post('/', teamValidation, async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const { members, lead, error } = await resolveMembers(req.user, req.body);
    if (error) return res.status(400).json({ status: 'error', message: error });
    const name = req.body.name.trim();
    if (await nameTaken(req.user, name)) return res.status(409).json({ status: 'error', message: `There is already a team called "${name}".` });

    const team = await Team.create({
      name,
      description: req.body.description || '',
      members,
      lead: lead || undefined,
      dataScope: req.user.dataScope,
      userId: req.user._id
    });
    logTeam(req, team, 'Team Created', 'create', `Team "${team.name}" created with ${members.length} member${members.length === 1 ? '' : 's'}`);
    res.status(201).json({ status: 'success', data: { team: await populated(Team.findById(team._id)).lean() } });
  } catch (error) {
    console.error('Create team error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating the team' });
  }
});

// PUT /api/teams/:id
router.put('/:id', [param('id').isMongoId().withMessage('Team not found'), ...teamValidation], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const team = await Team.findOne({ _id: req.params.id, ...orgScope(req.user) });
    if (!team) return res.status(404).json({ status: 'error', message: 'Team not found' });
    const { members, lead, error } = await resolveMembers(req.user, req.body);
    if (error) return res.status(400).json({ status: 'error', message: error });
    const name = req.body.name.trim();
    if (await nameTaken(req.user, name, team._id)) return res.status(409).json({ status: 'error', message: `There is already a team called "${name}".` });

    const before = team.members.map(String);
    team.name = name;
    team.description = req.body.description || '';
    team.members = members;
    team.lead = lead || undefined;
    await team.save();

    const joined = members.filter((id) => !before.includes(id)).length;
    const left = before.filter((id) => !members.includes(id)).length;
    logTeam(req, team, 'Team Updated', 'update', `Team "${team.name}" updated: ${joined} joined, ${left} left`);
    res.json({ status: 'success', data: { team: await populated(Team.findById(team._id)).lean() } });
  } catch (error) {
    console.error('Update team error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while saving the team' });
  }
});

// DELETE /api/teams/:id — the people stay; only the grouping goes
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Team not found' });
    const team = await Team.findOneAndDelete({ _id: req.params.id, ...orgScope(req.user) });
    if (!team) return res.status(404).json({ status: 'error', message: 'Team not found' });
    logTeam(req, team, 'Team Deleted', 'delete', `Team "${team.name}" deleted`);
    res.json({ status: 'success', message: `Team "${team.name}" deleted` });
  } catch (error) {
    console.error('Delete team error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting the team' });
  }
});

module.exports = router;
