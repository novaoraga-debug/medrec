'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// `node --test` runs every test file in its own child process, potentially in
// parallel. Give this process a private data file so tests never race on the
// shared backend/src/data/store.json (parallel restores were wiping each
// other's writes, e.g. the doctor application disappearing mid-flow).
// IMPORTANT: require this helper before requiring ../src/server or ../src/store.
const dataFile = path.join(os.tmpdir(), `medrec-test-store-${process.pid}-${Date.now()}.json`);
process.env.MEDREC_DATA_FILE = dataFile;

function restoreStore() {
  if (fs.existsSync(dataFile)) {
    fs.unlinkSync(dataFile);
  }
}

module.exports = { dataFile, restoreStore };
