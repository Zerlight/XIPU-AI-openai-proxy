// Smoke-check release contents and launchers without touching installed hosts.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
function isolatedEnvironment(home) {
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.XIPU_BRIDGE_CONFIG_DIR;
  return env;
}
function windowsLauncher(directory, env) {
  const run = args => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${path.join(directory, 'Install.cmd')}" ${args}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true, input: '\r\n', timeout: 15000 });
  const valid = run('--browser edge --session-name "Packaging test" --dry-run');
  assert.equal(valid.status, 0, valid.error?.message || valid.stderr || valid.stdout);
  assert.match(valid.stdout, /Session: Packaging test/);
  assert.ok(valid.stdout.includes('Microsoft\\Edge\\NativeMessagingHosts'));
  const invalid = run('--extension-id= --dry-run');
  assert.equal(invalid.status, 1, invalid.error?.message || invalid.stderr || invalid.stdout);
  assert.match(invalid.stderr, /--extension-id must/);
}
if (process.argv[2] === '--windows-launcher') {
  assert.equal(process.platform, 'win32', 'Windows launcher checks require Windows');
  assert.ok(process.argv[3], 'provide the compiled native executable');
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xipu-launcher-check-')));
  try {
    const directory = path.join(temporary, 'Launcher path with spaces');
    fs.mkdirSync(directory);
    fs.copyFileSync(path.resolve(process.argv[3]), path.join(directory, 'xipu-bridge.exe'));
    fs.copyFileSync(path.join(__dirname, 'Install.cmd'), path.join(directory, 'Install.cmd'));
    const home = path.join(temporary, 'Isolated home');
    windowsLauncher(directory, isolatedEnvironment(home));
    assert.deepEqual(fs.readdirSync(home), [], 'launcher dry-run mutated the isolated home');
    console.log('Windows launcher passed: path with spaces, forwarded arguments, failure exit status and no writes.');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  process.exit(0);
}
const release = path.join(repo, 'dist/release');
const version = require(path.join(repo, 'extension/manifest.json')).version;
const hashes = new Map(fs.readFileSync(path.join(release, 'SHA256SUMS'), 'utf8').trim().split('\n').map(line => {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  assert.ok(match, 'invalid checksum line');
  return [match[2], match[1]];
}));
for (const [file, hash] of hashes) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(release, file))).digest('hex'), hash, file);
}
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xipu-package-check-')));
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 15000, ...options });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result;
}
function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'unexpected symlink: ' + file);
    return entry.isDirectory() ? files(file, base) : [path.relative(base, file).split(path.sep).join('/')];
  }).sort();
}
try {
  for (const platform of ['macos', 'linux', 'windows']) for (const arch of ['arm64', 'amd64']) {
    const prefix = `xipu-ai-bridge_${version}_${platform}_${arch}`;
    const archive = prefix + (platform === 'linux' ? '.tar.gz' : '.zip');
    assert.ok(hashes.has(archive), 'missing archive checksum: ' + archive);
    const destination = path.join(temporary, 'Extracted packages with spaces', prefix);
    fs.mkdirSync(destination, { recursive: true });
    if (platform === 'linux') command('tar', ['-xzf', path.join(release, archive), '-C', destination]);
    else if (process.platform === 'win32') command('tar', ['-xf', path.join(release, archive), '-C', destination]);
    else command('unzip', ['-q', path.join(release, archive), '-d', destination]);
    const unpacked = path.join(destination, prefix);
    const executable = platform === 'windows' ? 'xipu-bridge.exe' : 'xipu-bridge';
    const launcher = { macos: 'Install.command', linux: 'install.sh', windows: 'Install.cmd' }[platform];
    const expected = [executable, launcher, 'INSTALL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/jsonschema.txt', 'licenses/x-image.txt', 'licenses/x-text.txt'].sort();
    assert.deepEqual(files(unpacked), expected);
    for (const file of expected.filter(file => file !== executable)) {
      const source = path.join(repo, file === launcher || file === 'INSTALL.md' ? 'packaging' : '', file);
      assert.deepEqual(fs.readFileSync(path.join(unpacked, file)), fs.readFileSync(source), 'stale packaged file: ' + file);
    }
    const raw = `xipu-bridge_${platform === 'macos' ? 'darwin' : platform}_${arch}${platform === 'windows' ? '.exe' : ''}`;
    assert.deepEqual(fs.readFileSync(path.join(unpacked, executable)), fs.readFileSync(path.join(release, raw)), 'packaged binary differs: ' + archive);
    const hostPlatform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
    const hostArch = process.arch === 'x64' ? 'amd64' : process.arch;
    if (platform === hostPlatform && arch === hostArch) {
      const home = path.join(temporary, 'Isolated home');
      const env = isolatedEnvironment(home);
      const result = command(path.join(unpacked, executable), ['install', '--dry-run'], { env });
      assert.match(result.stdout, /Extension ID: eegmaembfjajhifjbddmdbppchinmmcg/);
      assert.ok(result.stdout.includes(home));
      if (platform === 'windows') windowsLauncher(unpacked, env);
      assert.deepEqual(fs.readdirSync(home), [], 'dry-run mutated the isolated home');
    }
    if (platform !== 'windows' && process.platform !== 'win32') {
      for (const file of [executable, launcher]) assert.ok(fs.statSync(path.join(unpacked, file)).mode & 0o111, file + ' lost executable permission');
      fs.writeFileSync(path.join(unpacked, executable), '#!/bin/sh\nprintf "%s\\n" "$@"\nexit "${XIPU_PACKAGE_TEST_EXIT:-0}"\n', { mode: 0o755 });
      for (const status of [0, 17]) {
        const result = spawnSync('/bin/sh', [path.join(unpacked, launcher), '--browser', 'edge', '--session-name', 'Packaging test'], { cwd: temporary, encoding: 'utf8', timeout: 15000, env: { ...process.env, XIPU_PACKAGE_TEST_EXIT: String(status) } });
        assert.equal(result.status, status, 'launcher lost exit status');
        assert.ok(result.stdout.startsWith('install\n--browser\nedge\n--session-name\nPackaging test\n'), 'launcher lost arguments');
      }
    }
  }
  console.log('Package checks passed: six archives, hashes, licenses, exact binaries and isolated native dry-run.');
  console.log(process.platform === 'win32' ? 'Windows launcher arguments and failure exit status passed.' : 'POSIX executable permissions and launchers passed; Windows launcher execution requires Windows acceptance testing.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
