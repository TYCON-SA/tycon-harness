'use strict';
/**
 * npx-probe.js — el instalador del paquete de npm en un Windows (story 8.40, tanda A · AC 5 y 34 · T34; escenario `npx`
 * del pipeline 182).
 *
 * El paquete (`scripts/setup/npm/`) se arma con `npm pack` (con LICENSE copiado, como el workflow que publica) y se corre
 * con `npx --yes --package <tgz> tycon-harness --profile minimal --integrations none --packs none --yes` contra el
 * «GitHub» de juguete (scripts/tests/fixtures/toy-release-server.js, sobre el remoto del ensayo) en una carpeta de usuario
 * de juguete. Mide:
 *   1. que instala: estado `release`, `~/.tycon/harness` con la versión publicada, `doctor --json` sin rojos;
 *   2. que con un PATH sin pwsh sale 1 sin bajar nada, nombrando PowerShell 7 y `winget install Microsoft.PowerShell`.
 * npm y npx corren con ESTE Node por su programa (`npm-cli.js` / `npx-cli.js` al lado del ejecutable), sin pasar por un
 * `.cmd`; la caché de npm vive en el laboratorio (`npm_config_cache`: en Windows la de fábrica está en %LocalAppData%,
 * fuera de la carpeta de usuario de juguete, y un .tgz rearmado con la misma ruta podría salir de una caché vieja).
 * Fuera de Windows corre igual (modo laboratorio) y lo dice: lo que importa medir de Windows es el punto 2 y el `.cmd`.
 *
 * Uso: node scripts/tests/windows/npx-probe.js --lab <laboratorio> --out <carpeta del reporte> [--allow-temp]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lab.js');
const T = require('./team-lab.js');

const NAME = 'npx';
const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..', '..');
const SERVER = path.join(HERE, '..', 'fixtures', 'toy-release-server.js');
const CMD_TIMEOUT_MS = 10 * 60 * 1000;
const say = (s) => process.stdout.write(`${s}\n`);
const lastLines = (s, n = 3) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');
const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* nada */ } };
const LAB_NO_HOOKS = path.join(os.tmpdir(), 'tycon-lab-no-git-hooks');
// commits con fecha fija y sin el mantenimiento automático de git: la versión de juguete no depende del reloj
function git(dir, args, env) {
  const e = Object.assign({}, env, { GIT_AUTHOR_DATE: '2030-03-01T00:00:00Z', GIT_COMMITTER_DATE: '2030-03-01T00:00:00Z' });
  return L.run('git', ['-C', dir, '-c', 'user.name=Lab', '-c', 'user.email=lab@example.com', '-c', `core.hooksPath=${LAB_NO_HOOKS}`, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { env: e, timeoutMs: 5 * 60 * 1000 });
}

/** El programa de npm o de npx que trae ESTE Node (Windows: al lado del ejecutable; posix: en lib/node_modules). */
function npmProgram(which) {
  const dir = path.dirname(process.execPath);
  for (const base of [path.join(dir, 'node_modules', 'npm', 'bin'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin')]) {
    const f = path.join(base, `${which}-cli.js`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function measure({ lab, platform = process.platform, baseEnv = process.env, allowTemp = false, rec }) {
  const state = T.readState(lab);
  if (!state || !state.remotes || !state.remotes.harness) return { status: L.STATUS.error, reason: `${lab} no trae el estado del ensayo (rehearsal-state.json): corré «rehearse.js init»` };
  const npm = npmProgram('npm'); const npx = npmProgram('npx');
  if (!npm || !npx) return { status: L.STATUS.notMeasured, reason: `este Node (${process.execPath}) no trae npm/npx a su lado` };
  const base = path.join(lab, 'npx');
  const home = path.join(base, 'users', 'lab-npx');
  const author = path.join(base, 'author');
  const serverDir = path.join(base, 'server');
  const pkg = path.join(base, 'pkg');
  for (const d of [home, serverDir, pkg, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return { status: L.STATUS.error, reason: problem };
  const env0 = T.rehearsalEnv(home, { base: baseEnv, platform });
  rec.fact('home', home);
  rec.fact('lab_mode', !L.isWin(platform));

  // el remoto en el commit de hoy, una versión numerada publicada encima, y el servidor de juguete
  const point = T.pointRemotes(state, 'target', env0);
  if (point) return { status: L.STATUS.error, reason: point };
  const bare = state.remotes.harness.dir;
  const c = git(base, ['clone', '--quiet', bare, author], env0);
  if (c.exit !== 0) return { status: L.STATUS.error, reason: `no pude clonar el remoto del arnés: ${L.firstLine(c.stderr)}` };
  const org = 'example-org', name = 'example-harness';
  fs.mkdirSync(path.join(author, 'scripts', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(author, 'scripts', 'setup', 'public-remotes.json'), `{ "remotes": ["https://github.com/${org}/${name}"] }\n`);
  fs.writeFileSync(path.join(author, 'version.json'), `{ "version": "2030.03.01.1", "source": { "harness": "${'1'.repeat(40)}", "agent_skills": "${'2'.repeat(40)}" } }\n`);
  for (const args of [['add', '-A'], ['commit', '-q', '-m', 'versión 2030.03.01.1'], ['push', '-q', 'origin', 'HEAD:main']]) {
    const r = git(author, args, env0);
    if (r.exit !== 0) return { status: L.STATUS.error, reason: `no pude publicar la versión de juguete (git ${args[0]} salió ${r.exit}): ${L.firstLine(r.stderr)}` };
  }
  const control = path.join(serverDir, 'control.json'); const log = path.join(serverDir, 'requests.log'); const ports = path.join(serverDir, 'ports.env');
  fs.writeFileSync(control, '{ "auth": "none" }\n');
  const server = spawn(process.execPath, [SERVER, '--repo', bare, '--org', org, '--name', name, '--git', L.scanPath('git', { env: env0 })[0] || 'git', '--control', control, '--log', log, '--port-file', ports], { env: env0, stdio: 'ignore', windowsHide: true });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ports); i++) wait(100);
    if (!fs.existsSync(ports)) return { status: L.STATUS.error, reason: 'el servidor de versiones de juguete no arrancó' };
    const p = fs.readFileSync(ports, 'utf8'); const port = (k) => (new RegExp(`^${k}=(.+)$`, 'm').exec(p) || [])[1];
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');
    const env = T.rehearsalEnv(home, { base: baseEnv, platform, extra: {
      TYCON_RELEASE_API: port('API'), TYCON_RELEASE_GIT: port('GIT'), TYCON_RELEASE_ARCHIVE: port('CODELOAD'), TYCON_UPDATE_APPLY: 'auto',
      TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0', TYCON_THIRD_PARTY: '0',
      TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
      CODEX_HOME: path.join(home, '.codex'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'),
      npm_config_cache: path.join(base, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
    } });

    // el paquete, armado como lo arma el workflow
    for (const f of ['package.json', 'index.js', 'home-paths.json', 'README.md']) fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'npm', f), path.join(pkg, f));
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(pkg, 'LICENSE'));
    const packed = L.run(process.execPath, [npm, 'pack', '--silent', '--pack-destination', base], { cwd: pkg, env, timeoutMs: CMD_TIMEOUT_MS });
    const tgz = path.join(base, lastLines(packed.stdout, 1));
    rec.fact('pack', { exit: packed.exit, tgz: path.basename(tgz), out: lastLines(`${packed.stdout}\n${packed.stderr}`, 2) });
    if (packed.exit !== 0 || !fs.existsSync(tgz)) return { status: L.STATUS.error, reason: `npm pack salió ${packed.exit}: ${lastLines(packed.stderr, 2)}` };
    const npxRun = (e, label) => {
      const r = L.run(process.execPath, [npx, '--yes', '--package', tgz, 'tycon-harness', '--repo', `${org}/${name}`, '--profile', 'minimal', '--integrations', 'none', '--packs', 'none', '--yes'], { env: e, cwd: base, timeoutMs: CMD_TIMEOUT_MS });
      rec.fact(label, { exit: r.exit, error: r.error, out: lastLines(`${r.stdout}\n${r.stderr}`, 4), ms: r.ms });
      return r;
    };

    // 1 · instala
    const inst = npxRun(env, 'install');
    let st = null; try { st = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json'), 'utf8')); } catch (_) { /* sin estado */ }
    const kind = st && st.sources && st.sources[0] ? st.sources[0].kind : null;
    const harnessJs = path.join(home, '.tycon', 'harness', 'scripts', 'setup', 'harness.js');
    rec.fact('after_install', { kind, version: st && st.version ? st.version.number : null, harness: fs.existsSync(harnessJs) });
    if (inst.exit !== 0 || kind !== 'release' || !fs.existsSync(harnessJs)) {
      rec.finding('npx:install-fails', 'install', `npx --package <tgz> tycon-harness salió ${inst.exit} (estado ${kind || 'ninguno'}): ${lastLines(`${inst.stdout}\n${inst.stderr}`, 3)}`, 'W8', { severity: 'breaks' });
    } else {
      // `doctor --json` se lee entero (como no-clone-probe.js: con un tope chico su JSON llega cortado)
      const doc = L.run(process.execPath, [harnessJs, 'doctor', '--json'], { env, timeoutMs: CMD_TIMEOUT_MS, cap: 400000 });
      let fails = null; try { fails = JSON.parse(doc.stdout).fail; } catch (_) { /* ilegible */ }
      rec.fact('doctor', { exit: doc.exit, fails });
      if (doc.exit !== 0 || !Array.isArray(fails) || fails.length) rec.finding('npx:doctor-red', 'doctor', `doctor --json salió ${doc.exit}: ${JSON.stringify(fails).slice(0, 400)}`, 'W8', { severity: 'loses-control' });
    }

    // 2 · sin pwsh: lo nombra con el comando sugerido y no baja nada (sólo en Windows: fuera, pwsh no es requisito)
    if (L.isWin(platform)) {
      const w = T.withoutPwsh(env, platform);
      if (w.problem) rec.note(`sin pwsh: no medido (${w.problem})`);
      else {
        fs.rmSync(path.join(home, '.tycon'), { recursive: true, force: true });
        fs.rmSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true, force: true });
        const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').length : 0;
        const r = npxRun(w.env, 'without_pwsh');
        const said = `${r.stdout}\n${r.stderr}`;
        const after = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').length : 0;
        if (r.exit !== 1 || !/pwsh/.test(said) || !/winget install Microsoft\.PowerShell/.test(said)) rec.finding('npx:pwsh-missing-not-named', 'requisites', `sin pwsh salió ${r.exit} sin nombrar PowerShell 7 y su comando: ${lastLines(said, 3)}`, 'W8', { severity: 'loses-control' });
        if (after !== before) rec.finding('npx:pwsh-missing-downloaded', 'requisites', `sin pwsh igual le pidió ${after - before} cosa(s) al GitHub de juguete: tenía que salir antes de bajar`, 'W8', { severity: 'noise' });
      }
    } else rec.note('fuera de Windows el paso sin pwsh no se mide (pwsh no es requisito acá)');
    return { status: L.STATUS.measured, reason: null };
  } finally { try { server.kill(); } catch (_) { /* ya */ } }
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`npx-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`npx-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, allowTemp: Boolean(args['allow-temp']), rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  say(`${NAME}: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, measure, npmProgram };
