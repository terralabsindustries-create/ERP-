const Notification = require('../models/Notification');

/**
 * Send one notification to each recipient, skipping the person who caused it
 * and duplicates. Never throws: a failed notification must not undo the change
 * that triggered it.
 *
 * @param {Object} opts
 * @param {Array}  opts.recipients  user ids (ObjectIds or strings; falsy skipped)
 * @param {Object} opts.actor       the logged-in user who made the change
 * @param {string} opts.type        Notification.type
 * @param {string} opts.title
 * @param {string} [opts.message]
 * @param {string} [opts.link]
 * @param {string} [opts.entityType]
 * @param {*}      [opts.entityId]
 */
async function notify({ recipients, actor, type, title, message, link, entityType, entityId }) {
  try {
    const actorId = actor?._id?.toString();
    const unique = [...new Set((recipients || []).filter(Boolean).map(String))].filter((id) => id !== actorId);
    if (unique.length === 0) return [];
    return await Notification.insertMany(
      unique.map((recipient) => ({
        recipient,
        dataScope: actor?.dataScope,
        type,
        title,
        message,
        link,
        entityType,
        entityId,
        actor: actor?._id,
        actorName: actor?.fullName
      }))
    );
  } catch (error) {
    console.error('Notification failed:', error.message);
    return [];
  }
}

module.exports = { notify };
