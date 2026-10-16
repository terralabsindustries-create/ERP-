const mongoose = require('mongoose');

const numberSequenceSchema = new mongoose.Schema({
  _id: String,
  value: { type: Number, required: true, default: 0 }
});

numberSequenceSchema.statics.nextAfter = async function (key, existingMax = 0) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const counter = await this.findOneAndUpdate(
        { _id: key },
        [{ $set: { value: { $add: [{ $max: [{ $ifNull: ['$value', 0] }, existingMax] }, 1] } } }],
        { upsert: true, new: true }
      );
      return counter.value;
    } catch (error) {
      if (error.code !== 11000 || attempt === 4) throw error;
    }
  }
};

module.exports = mongoose.model('NumberSequence', numberSequenceSchema);
