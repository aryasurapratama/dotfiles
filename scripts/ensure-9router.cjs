#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { gzipSync, gunzipSync } = require('node:zlib');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const exists = filename => fs.existsSync(filename);
const cliEnvironment = ctx => {
  const environment = { ...process.env,
    PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''), DATA_DIR: ctx.router };
  delete environment.NINE_ROUTER_BACKUP_BASE64;
  return environment;
};

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivate(filename, data) {
  privateDirectory(path.dirname(filename));
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function context() {
  const state = path.resolve(process.env.AI_TOOLS_STATE_DIR || (
    process.env.CODESPACES === 'true' ? '/workspaces/.ai-tools' : path.join(os.homedir(), '.local/share/ai-tools')
  ));
  const localConfig = path.resolve(__dirname, '../config/9router.json');
  const configFile = path.basename(__filename) !== 'bootstrap.cjs' && exists(localConfig)
    ? localConfig : path.join(state, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (typeof settings.model !== 'string' || !/^[\w./-]+$/.test(settings.model)) throw new Error('Model 9Router tidak valid.');
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(settings.reasoningEffort)) throw new Error('Reasoning effort tidak valid.');
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    throw new Error('Port pada config/9router.json harus antara 1 dan 65535.');
  }
  if (!['127.0.0.1', 'localhost'].includes(settings.host)) throw new Error('Host 9Router harus lokal.');
  for (const version of [settings.version, settings.codexVersion]) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Versi CLI harus lengkap: major.minor.patch.');
  }
  const user = process.env.AI_TOOLS_USER_DIR || os.homedir();
  return { state, user, settings, configFile,
    homeRouter: path.join(user, '.9router'), router: path.join(state, '9router'),
    homeCodex: path.join(user, '.codex/config.toml'), codex: path.join(state, 'codex/config.toml'),
    origin: `http://127.0.0.1:${settings.port}` };
}

function samePath(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

async function routerStatus(origin) {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    return response.ok && (body?.ok === true || body?.status === 'ok') ? 'ready' : 'occupied';
  } catch (error) {
    return error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED' ? 'stopped' : 'occupied';
  }
}

// Online backup includes committed WAL transactions without copying a changing
// database, WAL, and SHM independently. Cache and native binaries are rebuilt.
async function snapshotRouter(source, destination) {
  if (samePath(source, destination) || !exists(source)) return;
  privateDirectory(destination);
  const rootFiles = ['jwt-secret', 'machine-id', 'connect.env', 'db.json', 'model-catalog.json', 'model-catalog-raw.json'];
  for (const name of rootFiles) {
    const filename = path.join(source, name);
    if (exists(filename)) writePrivate(path.join(destination, name), fs.readFileSync(filename));
    else fs.rmSync(path.join(destination, name), { force: true });
  }
  if (exists(path.join(source, 'auth'))) {
    privateDirectory(path.join(destination, 'auth'));
    const sourceAuthFiles = fs.readdirSync(path.join(source, 'auth'), { withFileTypes: true }).filter(file => file.isFile());
    const sourceAuthNames = new Set(sourceAuthFiles.map(file => file.name));
    for (const file of sourceAuthFiles) {
      writePrivate(path.join(destination, 'auth', file.name), fs.readFileSync(path.join(source, 'auth', file.name)));
    }
    for (const file of fs.readdirSync(path.join(destination, 'auth'))) {
      if (!sourceAuthNames.has(file)) fs.rmSync(path.join(destination, 'auth', file), { force: true });
    }
  } else {
    fs.rmSync(path.join(destination, 'auth'), { recursive: true, force: true });
  }
  const sourceDB = path.join(source, 'db/data.sqlite');
  if (!exists(sourceDB)) return;
  const { DatabaseSync, backup } = require('node:sqlite');
  privateDirectory(path.join(destination, 'db'));
  const temporary = path.join(destination, 'db', `backup-${process.pid}.sqlite`);
  const database = new DatabaseSync(sourceDB, { readOnly: true });
  try {
    await backup(database, temporary);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, path.join(destination, 'db/data.sqlite'));
  } finally {
    database.close();
    fs.rmSync(temporary, { force: true });
  }
}

function restoreCodex(ctx, preferPersistent = false) {
  privateDirectory(path.dirname(ctx.codex));
  privateDirectory(path.dirname(ctx.homeCodex));
  if (samePath(ctx.homeCodex, ctx.codex)) return;
  if (exists(ctx.homeCodex) && !(preferPersistent && exists(ctx.codex))) {
    // Some editors replace the symlink with a new file when saving. Preserve
    // that newer user config before restoring the persistent link.
    const contents = fs.readFileSync(ctx.homeCodex);
    if (exists(ctx.codex) && !fs.readFileSync(ctx.codex).equals(contents)) {
      writePrivate(`${ctx.codex}.before-ai-tools-${Date.now()}`, fs.readFileSync(ctx.codex));
    }
    writePrivate(ctx.codex, contents);
  }
  if (!exists(ctx.codex)) return;
  if (exists(ctx.homeCodex)) fs.renameSync(ctx.homeCodex, `${ctx.homeCodex}.before-ai-tools-${Date.now()}`);
  else { try { fs.unlinkSync(ctx.homeCodex); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  fs.symlinkSync(ctx.codex, ctx.homeCodex);
}

function findCLI(ctx, name) {
  const directories = [path.join(ctx.state, 'cli/node_modules/.bin'), ...(process.env.PATH || '').split(path.delimiter)];
  for (const directory of directories) {
    const file = path.join(directory, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      const descriptor = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(256);
      const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      fs.closeSync(descriptor);
      if (!buffer.subarray(0, size).toString().includes('# ai-tools managed launcher')) return file;
    } catch {}
  }
  return null;
}

function installCLIs(ctx) {
  const packages = [];
  if (!findCLI(ctx, '9router')) packages.push(`9router@${ctx.settings.version}`);
  if (!findCLI(ctx, 'codex')) packages.push(`@openai/codex@${ctx.settings.codexVersion}`);
  if (!packages.length) return;
  const result = spawnSync('npm', ['install', '--prefix', path.join(ctx.state, 'cli'), '--no-audit', '--no-fund', '--save-exact', ...packages], {
    stdio: 'inherit', env: cliEnvironment(ctx)
  });
  if (result.error || result.status !== 0) throw new Error('Instalasi CLI gagal; periksa koneksi npm dan Node.js 24.');
}

function installLaunchers(ctx) {
  const installed = path.join(ctx.state, 'bootstrap.cjs');
  if (path.resolve(__filename) !== installed) writePrivate(installed, fs.readFileSync(__filename));
  writePrivate(path.join(ctx.state, 'settings.json'), JSON.stringify(ctx.settings, null, 2) + '\n');
  const bin = path.join(ctx.user, '.local/bin');
  privateDirectory(bin);
  for (const [name, command] of [['9router', 'run'], ['codex', 'codex']]) {
    const filename = path.join(bin, name);
    if (exists(filename) && !fs.readFileSync(filename, 'utf8').includes('# ai-tools managed launcher')) {
      throw new Error(`${filename} sudah ada; launcher lain tidak ditimpa.`);
    }
    writePrivate(filename, `#!/usr/bin/env bash\n# ai-tools managed launcher\nexec ${shellQuote(process.execPath)} ${shellQuote(installed)} ${command} "$@"\n`);
    fs.chmodSync(filename, 0o700);
  }
  const snippet = '\n# ai-tools managed PATH\nexport PATH="$HOME/.local/bin:$PATH"\n';
  const autostart = `\n# ai-tools managed autostart\nif [ "\${CODESPACES:-}" = "true" ] && [ -f ${shellQuote(path.join(ctx.router, 'db/data.sqlite'))} ]; then\n  (umask 077; ${shellQuote(process.execPath)} ${shellQuote(installed)} run >> ${shellQuote(path.join(ctx.state, 'autostart.log'))} 2>&1 </dev/null &)\nfi\n`;
  for (const filename of ['.bashrc', '.profile', ...(exists(path.join(ctx.user, '.zshrc')) ? ['.zshrc'] : [])]) {
    const file = path.join(ctx.user, filename);
    const contents = exists(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!contents.includes('# ai-tools managed PATH')) fs.appendFileSync(file, snippet, { mode: 0o600 });
    if (!contents.includes('# ai-tools managed autostart')) fs.appendFileSync(file, autostart, { mode: 0o600 });
  }
}

function watcherPID(ctx) {
  try {
    const pid = Number(fs.readFileSync(path.join(ctx.state, 'snapshot.pid'), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 1) return null;
    process.kill(pid, 0);
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return command.includes(path.join(ctx.state, 'bootstrap.cjs')) && command.includes('watch') ? pid : null;
  } catch { return null; }
}

function startWatcher(ctx) {
  if (samePath(ctx.homeRouter, ctx.router) || watcherPID(ctx)) return;
  const logfile = fs.openSync(path.join(ctx.state, 'snapshot.log'), 'a', 0o600);
  const environment = { ...process.env, AI_TOOLS_STATE_DIR: ctx.state, AI_TOOLS_USER_DIR: ctx.user, NODE_NO_WARNINGS: '1' };
  delete environment.NINE_ROUTER_BACKUP_BASE64;
  const child = spawn(process.execPath, [path.join(ctx.state, 'bootstrap.cjs'), 'watch'], {
    detached: true, stdio: ['ignore', logfile, logfile],
    env: environment
  });
  fs.closeSync(logfile);
  writePrivate(path.join(ctx.state, 'snapshot.pid'), String(child.pid));
  child.unref();
}

async function watch(ctx) {
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; });
  let previous = '';
  while (!samePath(ctx.homeRouter, ctx.router)) {
    const authFiles = exists(path.join(ctx.homeRouter, 'auth'))
      ? fs.readdirSync(path.join(ctx.homeRouter, 'auth')).map(name => 'auth/' + name) : [];
    const signature = ['db/data.sqlite', 'db/data.sqlite-wal', 'jwt-secret', 'machine-id', 'connect.env', 'db.json', ...authFiles].map(name => {
      try { const stat = fs.statSync(path.join(ctx.homeRouter, name)); return `${stat.size}:${stat.mtimeMs}`; } catch { return ''; }
    }).join('|');
    if (signature !== previous || stopping) {
      try {
        await snapshotRouter(ctx.homeRouter, ctx.router);
        previous = signature;
      } catch (error) { console.error(`Backup tertunda: ${error.message}`); }
    }
    if (stopping || await routerStatus(ctx.origin) === 'stopped') {
      await snapshotRouter(ctx.homeRouter, ctx.router);
      break;
    }
    await delay(1000);
  }
}

async function prepare(ctx, status) {
  privateDirectory(ctx.state);
  const importedCodex = importBackup(ctx);
  restoreCodex(ctx, importedCodex);
  if (!samePath(ctx.homeRouter, ctx.router)) {
    await snapshotRouter(ctx.homeRouter, ctx.router);
    if (status === 'ready') startWatcher(ctx);
    else if (status === 'stopped') {
      const pid = watcherPID(ctx);
      if (pid) {
        process.kill(pid, 'SIGTERM');
        for (let i = 0; i < 30 && watcherPID(ctx); i++) await delay(100);
        if (watcherPID(ctx)) throw new Error('Pencadangan masih selesai; jalankan ulang sebentar lagi.');
      }
      privateDirectory(ctx.router);
      if (exists(ctx.homeRouter)) fs.renameSync(ctx.homeRouter, `${ctx.homeRouter}.before-ai-tools-${Date.now()}`);
      else { try { fs.unlinkSync(ctx.homeRouter); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      fs.symlinkSync(ctx.router, ctx.homeRouter);
    }
  }
}

function importBackup(ctx) {
  if (!process.env.NINE_ROUTER_BACKUP_BASE64 || exists(path.join(ctx.router, 'db/data.sqlite'))) return;
  const packed = Buffer.from(process.env.NINE_ROUTER_BACKUP_BASE64, 'base64');
  const data = JSON.parse(gunzipSync(packed, { maxOutputLength: 32 * 1024 * 1024 }).toString());
  if (data.format !== 1 || !data.files || typeof data.files !== 'object') throw new Error('Format backup 9Router tidak valid.');
  for (const [name, value] of Object.entries(data.files)) {
    if (!/^(9router\/(db\/data\.sqlite|auth\/[\w.-]+|jwt-secret|machine-id|connect\.env|db\.json)|codex\/config\.toml)$/.test(name) || typeof value !== 'string') {
      throw new Error('Backup berisi lokasi file yang tidak diizinkan.');
    }
  }
  let importedCodex = false;
  for (const [name, value] of Object.entries(data.files)) {
    const filename = path.join(ctx.state, name);
    if (!exists(filename)) {
      writePrivate(filename, Buffer.from(value, 'base64'));
      if (name === 'codex/config.toml') importedCodex = true;
    }
  }
  return importedCodex;
}

async function exportBackup(ctx) {
  const files = {};
  const temporary = fs.mkdtempSync(path.join(ctx.state, 'export-'));
  try {
    await snapshotRouter(ctx.router, path.join(temporary, '9router'));
    const databaseFile = path.join(temporary, '9router/db/data.sqlite');
    if (exists(databaseFile)) {
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(databaseFile);
      try {
        for (const table of ['usageHistory', 'usageDaily', 'requestDetails']) {
          if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
            database.exec(`DELETE FROM ${table}`);
          }
        }
        database.exec('VACUUM');
      } finally { database.close(); }
    }
    for (const name of ['db/data.sqlite', 'jwt-secret', 'machine-id', 'connect.env', 'db.json']) {
      const filename = path.join(temporary, '9router', name);
      if (exists(filename)) files[`9router/${name}`] = fs.readFileSync(filename).toString('base64');
    }
    const auth = path.join(temporary, '9router/auth');
    if (exists(auth)) for (const name of fs.readdirSync(auth)) files[`9router/auth/${name}`] = fs.readFileSync(path.join(auth, name)).toString('base64');
    if (exists(ctx.codex)) files['codex/config.toml'] = fs.readFileSync(ctx.codex).toString('base64');
    const encoded = gzipSync(JSON.stringify({ format: 1, files })).toString('base64');
    const filename = path.join(ctx.state, 'backup.base64');
    writePrivate(filename, encoded);
    console.log(`Backup privat: ${filename} (${Buffer.byteLength(encoded)} byte)`);
    if (Buffer.byteLength(encoded) > 48000) console.log('Backup melebihi batas satu Codespaces Secret; gunakan pemindahan file privat.');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function initializeCodex(ctx) {
  // Make the local gateway's authentication mode explicit. The IDE reads this
  // provider configuration from the same Codex home as the CLI.
  if (exists(ctx.codex)) {
    const contents = fs.readFileSync(ctx.codex, 'utf8');
    const sectionStart = contents.indexOf('[model_providers.9router]');
    const sectionTail = sectionStart < 0 ? '' : contents.slice(sectionStart + '[model_providers.9router]'.length);
    const nextSection = sectionTail.search(/\r?\n\[/);
    const provider = sectionStart < 0 ? '' : nextSection < 0 ? sectionTail : sectionTail.slice(0, nextSection);
    if (/^\s*model_provider\s*=\s*"9router"\s*$/m.test(contents) && provider &&
        !/^\s*requires_openai_auth\s*=/m.test(provider)) {
      const updated = contents.replace(
        /(^\[model_providers\.9router\]\r?\n)/m,
        '$1requires_openai_auth = false\n'
      );
      if (updated !== contents) writePrivate(ctx.codex, updated);
    }
    return;
  }
  const filename = path.join(ctx.router, 'db/data.sqlite');
  if (!exists(filename)) return;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filename, { readOnly: true });
  let key;
  try { key = db.prepare('SELECT key FROM apiKeys WHERE isActive=1 ORDER BY createdAt LIMIT 1').get()?.key; }
  finally { db.close(); }
  if (!key) return;
  const quote = JSON.stringify;
  writePrivate(ctx.codex, `model = ${quote(ctx.settings.model)}\nmodel_provider = "9router"\nmodel_reasoning_effort = ${quote(ctx.settings.reasoningEffort)}\n\n[model_providers.9router]\nname = "9Router"\nrequires_openai_auth = false\nbase_url = ${quote(ctx.origin + '/v1')}\nwire_api = "responses"\n\n[model_providers.9router.http_headers]\nAuthorization = ${quote('Bearer ' + key)}\n`);
  restoreCodex(ctx);
}

async function startRouter(ctx) {
  const status = await routerStatus(ctx.origin);
  if (status === 'occupied') throw new Error(`Port ${ctx.settings.port} dipakai layanan lain atau 9Router belum sehat; proses itu tidak dihentikan.`);
  await prepare(ctx, status);
  if (status === 'ready') { initializeCodex(ctx); console.log(`9Router sudah aktif: ${ctx.origin}/dashboard`); return; }
  const logfile = fs.openSync(path.join(ctx.state, '9router.log'), 'a', 0o600);
  const child = spawn(findCLI(ctx, '9router'), ['--no-browser', '--skip-update', '--tray', '--host', ctx.settings.host, '--port', String(ctx.settings.port)], {
    detached: true, stdio: ['ignore', logfile, logfile], cwd: ctx.state,
    env: cliEnvironment(ctx)
  });
  fs.closeSync(logfile);
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  for (let i = 0; i < 300; i++) {
    if (spawnError) throw spawnError;
    if (await routerStatus(ctx.origin) === 'ready') { initializeCodex(ctx); console.log(`9Router aktif: ${ctx.origin}/dashboard`); return; }
    if (child.exitCode !== null) throw new Error(`9Router berhenti; periksa ${ctx.state}/9router.log`);
    await delay(200);
  }
  throw new Error(`9Router belum siap; periksa ${ctx.state}/9router.log`);
}

async function withLock(ctx, action) {
  const filename = path.join(ctx.state, 'bootstrap.lock');
  for (let i = 0; i < 600; i++) {
    let descriptor;
    try {
      descriptor = fs.openSync(filename, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(filename, 'utf8'));
        if (Number.isInteger(pid) && pid > 1) {
          try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') fs.rmSync(filename, { force: true }); }
        } else if (Date.now() - fs.statSync(filename).mtimeMs > 30000) fs.rmSync(filename, { force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(100);
      continue;
    }
    fs.writeSync(descriptor, String(process.pid));
    try { return await action(); } finally { fs.closeSync(descriptor); fs.rmSync(filename, { force: true }); }
  }
  throw new Error('Bootstrap lain masih berjalan.');
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Gunakan Node.js 24 atau lebih baru.');
  const ctx = context();
  const command = process.argv[2] || 'run';
  if (command === 'watch') return watch(ctx);
  privateDirectory(ctx.state);
  const startup = command === 'setup' || command === 'backup' || (command === 'run' && process.argv.length <= 3);
  if (startup) return withLock(ctx, async () => {
    installCLIs(ctx);
    installLaunchers(ctx);
    if (command === 'run') return startRouter(ctx);
    await prepare(ctx, await routerStatus(ctx.origin));
    initializeCodex(ctx);
    if (command === 'backup') return exportBackup(ctx);
    console.log(`9Router dan Codex siap. Penyimpanan persisten: ${ctx.state}`);
  });
  restoreCodex(ctx);
  const name = command === 'codex' ? 'codex' : '9router';
  const cli = findCLI(ctx, name);
  if (!cli) throw new Error(`CLI ${name} belum terpasang. Jalankan npm run router:setup.`);
  const result = spawnSync(cli, process.argv.slice(3), { stdio: 'inherit', env: cliEnvironment(ctx) });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

module.exports = { snapshotRouter, restoreCodex, routerStatus, writePrivate, importBackup };
if (require.main === module) main().catch(error => { console.error(`9Router: ${error.message}`); process.exitCode = 1; });
