const mongoose = require('mongoose');

/**
 * A group of people in one business, e.g. "Pre-press" or "Finishing". Teams
 * organise people; they grant no access of their own (that is the role's job).
 * The team overview and the user list can be narrowed to one team.
 */
const teamSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Team name is required'],
    trim: true,
    maxlength: [60, 'Team names are limited to 60 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [300, 'Descriptions are limited to 300 characters']
  },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Optional; must be one of the members.
  lead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  dataScope: {
    type: String,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

teamSchema.index({ dataScope: 1, name: 1 });
teamSchema.index({ members: 1 });

module.exports = mongoose.model('Team', teamSchema);
