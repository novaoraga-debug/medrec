const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(desktopDir, '..');
const buildDir = path.join(desktopDir, 'build');

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_'))
);
const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit', shell: true, env: childEnv });
const frontendDir = path.join(rootDir, 'frontend');

if (!fs.existsSync(path.join(frontendDir, 'node_modules'))) run('npm install', frontendDir);
run('npm run build', frontendDir);

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(path.join(buildDir, 'backend'), { recursive: true });
fs.cpSync(path.join(rootDir, 'backend', 'src'), path.join(buildDir, 'backend', 'src'), {
  recursive: true,
  filter: (source) => path.basename(source) !== 'store.json' && !source.endsWith('.tmp')
});
fs.cpSync(path.join(rootDir, 'frontend', 'dist'), path.join(buildDir, 'frontend'), { recursive: true });

console.log('Desktop build inputs ready in', buildDir);
