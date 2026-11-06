const mongoose = require('mongoose');

const numberSequenceSchema = new mongoose.Schema({
  _id: String,
  value: { type: Number, required: true, default: 0 }
});

/**
 * The next number of a sequence, one higher than both the sequence's last
 * number and `existingMax` (the highest number already in use, so a sequence
 * that starts late, or lags behind numbers written another way, never hands
 * out one that is taken). One atomic write: concurrent callers each get their
 * own number.
 *
 * Inside a transaction (`session`), the number is rolled back with it if the
 * transaction aborts, so an abandoned document leaves no gap.
 */
numberSequenceSchema.statics.nextAfter = async function (key, existingMax = 0, { session } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const counter = await this.findOneAndUpdate(
        { _id: key },
        [{ $set: { value: { $add: [{ $max: [{ $ifNull: ['$value', 0] }, existingMax] }, 1] } } }],
        { upsert: true, new: true, session }
      );
      return counter.value;
    } catch (error) {
      // Two first-ever upserts of a key can collide; the loser simply tries
      // again. A transaction cannot continue after an error, so it doesn't.
      if (error.code !== 11000 || attempt === 4 || session?.inTransaction()) throw error;
    }
  }
};

module.exports = mongoose.model('NumberSequence', numberSequenceSchema);
