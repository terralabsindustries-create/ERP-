const mongoose = require('mongoose');
const Team = require('../models/Team');
const { orgScope } = require('./accessScope');

/**
 * Put a login in exactly these teams (used by the user screens). Teams outside
 * the caller's business are ignored by the filter.
 */
async function setUserTeams(actor, userId, teamIds = []) {
  const ids = teamIds.filter((id) => mongoose.isValidObjectId(id));
  const scope = orgScope(actor);
  await Team.updateMany({ ...scope, _id: { $in: ids } }, { $addToSet: { members: userId } });
  await Team.updateMany({ ...scope, _id: { $nin: ids }, members: userId }, { $pull: { members: userId } });
  await Team.updateMany({ ...scope, _id: { $nin: ids }, lead: userId }, { $unset: { lead: 1 } });
}

/** The teams each of these logins belongs to, keyed by user id. */
async function teamsByUser(actor, userIds) {
  const teams = await Team.find({ ...orgScope(actor), members: { $in: userIds } }).select('name members').lean();
  const out = {};
  for (const t of teams) {
    for (const m of t.members) {
      (out[String(m)] ||= []).push({ _id: t._id, name: t.name });
    }
  }
  return out;
}

/** Teams in the caller's business with these ids (to validate a request). */
const teamsInOrg = (actor, ids) => Team.find({ ...orgScope(actor), _id: { $in: ids.filter((id) => mongoose.isValidObjectId(id)) } }).select('_id').lean();

module.exports = { setUserTeams, teamsByUser, teamsInOrg };
