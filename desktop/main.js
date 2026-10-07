const { app, BrowserWindow, dialog, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const PREFERRED_PORT = 47615;
const HOST = '127.0.0.1';
let mainWindow = null;
let server = null;

function logStartup(message) {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'startup.log'), `${new Date().toISOString()} ${message}\n`);
  } catch { /* logging must never block startup */ }
}
process.on('uncaughtException', (error) => logStartup(`uncaughtException: ${error && error.stack}`));

function loadSecrets(userData) {
  const file = path.join(userData, 'secrets.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const secrets = {
      JWT_SECRET: crypto.randomBytes(48).toString('hex'),
      REFRESH_SECRET: crypto.randomBytes(48).toString('hex'),
      QR_SECRET: crypto.randomBytes(48).toString('hex')
    };
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    return secrets;
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

async function startBackend() {
  const userData = app.getPath('userData');
  const secrets = loadSecrets(userData);
  const buildDir = path.join(__dirname, 'build');

  process.env.MEDREC_DATA_FILE = path.join(userData, 'data', 'store.json');
  process.env.MEDREC_UPLOAD_DIR = path.join(userData, 'uploads');
  process.env.MEDREC_STATIC_DIR = path.join(buildDir, 'frontend');
  fs.mkdirSync(path.dirname(process.env.MEDREC_DATA_FILE), { recursive: true });
  Object.assign(process.env, secrets);

  const { app: expressApp } = require(path.join(buildDir, 'backend', 'src', 'server.js'));
  const port = (await isPortFree(PREFERRED_PORT)) ? PREFERRED_PORT : 0;

  return new Promise((resolve, reject) => {
    server = expressApp.listen(port, HOST, () => resolve(server.address().port));
    server.once('error', reject);
  });
}

async function createWindow() {
  const port = await startBackend();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'MedRec',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://${HOST}:${port}`)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(`http://${HOST}:${port}/`);
}

if (!app.requestSingleInstanceLock()) {
  logStartup('another instance holds the lock; quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow).catch((error) => {
    logStartup(`startup failed: ${error && error.stack}`);
    dialog.showErrorBox('MedRec could not start', String(error && error.message ? error.message : error));
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (server) server.close();
    app.quit();
  });
}
