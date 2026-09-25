const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const DIST_ASSETS = path.join(FRONTEND_DIR, 'dist', 'assets');

test('frontend production build contains zero hardcoded credentials', () => {
  assert.ok(fs.existsSync(DIST_ASSETS), 'dist/assets directory must exist');

  const files = fs.readdirSync(DIST_ASSETS);
  const jsBundle = files.find((f) => f.endsWith('.js'));
  assert.ok(jsBundle, 'should produce a JS bundle');

  const bundleContent = fs.readFileSync(path.join(DIST_ASSETS, jsBundle), 'utf8');

  const forbiddenNeedles = [
    'SuperAdmin!2026',
    'Password123!',
    'super.admin@medrec.local',
    'qa.user.2026@example.com',
    'doctor.demo@medrec.local',
    'pharmacist.demo@medrec.local'
  ];

  for (const needle of forbiddenNeedles) {
    assert.strictEqual(
      bundleContent.includes(needle),
      false,
      `Bundle must not contain hardcoded secret/credential: ${needle}`
    );
  }

  // Functional sanity check
  assert.ok(
    bundleContent.includes('medrec.session'),
    'Bundle should still retain valid app logic such as session keys'
  );
});

test('frontend source gates staff unlock code with DEV mode check', () => {
  const appSrc = fs.readFileSync(path.join(FRONTEND_DIR, 'src', 'App.tsx'), 'utf8');

  // Verify DEV gating
  assert.match(
    appSrc,
    /STAFF_UNLOCK_CODE\s*=\s*\(\s*import\.meta\.env\.VITE_STAFF_UNLOCK_CODE\s*\|\|\s*\(\s*import\.meta\.env\.DEV\s*\?\s*'SuperAdmin!2026'\s*:\s*''\s*\)\s*\)\.trim\(\)/,
    'STAFF_UNLOCK_CODE must default to SuperAdmin!2026 only in DEV'
  );

  // Verify blank unlock guard
  assert.match(
    appSrc,
    /if\s*\(\s*!STAFF_UNLOCK_CODE\s*\)\s*{\s*notify\(\s*['"]error['"],\s*['"]Staff access is not configured in this build\.['"]\s*\);/,
    'handleStaffUnlock must reject attempts when STAFF_UNLOCK_CODE is empty'
  );
});

test('frontend source gates demo credentials map and register defaults behind DEV', () => {
  const appSrc = fs.readFileSync(path.join(FRONTEND_DIR, 'src', 'App.tsx'), 'utf8');

  assert.match(
    appSrc,
    /const\s+demoCredentials\s*:\s*Partial<Record<Role,\s*{\s*email:\s*string;\s*password:\s*string\s*}>>\s*=\s*import\.meta\.env\.DEV/,
    'demoCredentials map must be gated behind import.meta.env.DEV'
  );

  assert.match(
    appSrc,
    /const\s+password\s*=\s*signIn\.password\s*\|\|\s*\(\s*import\.meta\.env\.DEV\s*\?\s*["']Password123!["']\s*:\s*["']["']\s*\);/,
    'Registration fallback password must only fallback in DEV'
  );
});

test('legacy portal production builds contain zero hardcoded credentials', () => {
  const forbiddenNeedles = [
    'SuperAdmin!2026',
    'Password123!',
    'super.admin@medrec.local',
    'qa.user.2026@example.com',
    'doctor.demo@medrec.local',
    'pharmacist.demo@medrec.local'
  ];

  const portalNames = ['patient', 'doctor', 'pharmacist', 'staff'];
  for (const name of portalNames) {
    const assetsDir = path.join(ROOT, 'portals', name, 'dist', 'assets');
    assert.ok(fs.existsSync(assetsDir), `portals/${name}/dist/assets must exist`);

    const files = fs.readdirSync(assetsDir);
    const jsBundles = files.filter((f) => f.endsWith('.js'));
    assert.ok(jsBundles.length > 0, `portals/${name} should have at least one JS bundle`);

    for (const bundle of jsBundles) {
      const content = fs.readFileSync(path.join(assetsDir, bundle), 'utf8');
      for (const needle of forbiddenNeedles) {
        assert.strictEqual(
          content.includes(needle),
          false,
          `Portal bundle ${name}/${bundle} must not contain secret/credential: ${needle}`
        );
      }
    }
  }
});
