const test = require('node:test');
const assert = require('node:assert/strict');
const { readData } = require('../src/store');

test('default user store includes a demo patient login for the app UI', () => {
  const data = readData();
  const demoUser = data.users.find((user) => user.email === 'qa.user.2026@example.com');

  assert.ok(demoUser, 'Expected a seeded demo account for the healthcare UI');
  assert.equal(demoUser.role, 'patient');
  assert.ok(demoUser.passwordHash); 
});
