const mongoose = require('mongoose');

const BASE_URI = process.env.MONGODB_TEST_URI || 'mongodb://127.0.0.1:27017';

/** Connect to a fresh database just for this test file. */
async function connectTestDb(label) {
  const name = `terralabs_test_${label}_${process.pid}_${Date.now()}`;
  await mongoose.connect(`${BASE_URI}/${name}`);
  return name;
}

async function disconnectTestDb() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
}

module.exports = { connectTestDb, disconnectTestDb };
