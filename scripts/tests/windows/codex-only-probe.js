#!/usr/bin/env node
'use strict';
/**
 * codex-only-probe.js — una máquina SÓLO con Codex en un Windows: instalar, arrancar una sesión de Codex, diagnosticar
 * y desinstalar sin que aparezca nada en la carpeta de Claude Code (story 8.23, tanda C · AC 22 · escenario `codex-only`
 * del pipeline 182).
 *
 * POR QUÉ EXISTE. Hasta la tanda C el arnés no se podía instalar sin Claude Code, y en Windows el lado Codex nunca
 * recibió sus reglas (`AGENTS.md` lo escribía sólo el guion de shell). La tanda C lo hace todo en Node —la detección,
 * el enchufe de Codex, el hook de arranque que actualiza, el estado en `~/.tycon/state`—, y nada de eso corrió en un
 * Windows: ahí los enlaces de skills son uniones, las rutas llevan barra invertida y el hook de arranque no puede
 * depender de Git Bash. Este paso lo ensaya en el agente Windows con el «GitHub» de juguete sirviendo el remoto del
 * laboratorio, y lo dice.
 *
 * QUÉ HACE, en una carpeta de usuario de laboratorio SIN carpeta de Claude Code:
 *   1. Deja un `AGENTS.md` con texto de la persona, publica una versión y la instala: `install --version latest --tool
 *      codex`. Mira: nada en `~/.claude`, el estado en `~/.tycon/state`, los bloques en `AGENTS.md` entre sus marcas con
 *      lo de la persona intacto y sin `@import`, las skills enlazadas, el hook de arranque registrado y `writable_roots`.
 *   2. Publica otra versión y corre el hook de arranque de Codex TAL COMO QUEDÓ REGISTRADO: el arnés se actualiza.
 *   3. `doctor --json` y `uninstall --yes`: se va lo del arnés, queda lo de la persona, y sigue sin haber `~/.claude`.
 * Cada diferencia con lo que pasa en Mac y Linux sale como hallazgo con su gravedad.
 *
 * Fuera de Windows corre igual («modo de laboratorio»): es el mismo camino, sin las uniones.
 *
 * CÓMO FALLA. Una instalación que no anda es un HECHO del reporte. El paso sale «error» sólo si no pudo ensayar: sin el
 * remoto del laboratorio, sin git para el servidor de juguete, sin node.
 *
 * Uso: node scripts/tests/windows/codex-only-probe.js --lab <laboratorio> --out <carpeta del reporte> [--allow-temp]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lab.js');
const T = require('./team-lab.js');

const NAME = 'codex-only';
const HERE = __dirname;
const SERVER = path.join(HERE, '..', 'fixtures', 'toy-release-server.js');
const CMD_TIMEOUT_MS = 10 * 60 * 1000;
const UPDATE_WAIT_MS = 3 * 60 * 1000;
const PERSON_TEXT = '# Mis reglas de Codex\n\ntexto propio de la persona\n';
const say = (s) => process.stdout.write(`${s}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const lastLines = (s, n = 3) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');
const isWin = L.isWin();
const slash = (s) => String(s).replace(/\\/g, '/');
const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* nada */ } };
const kill = (p) => { if (p) { try { p.kill(); } catch (_) { /* ya */ } } };

// con identidad propia: el agente de Windows no tiene user.name/user.email y `git commit` sale 128 (182 #12314)
function git(dir, args, env) { return L.run('git', ['-C', dir, '-c', 'user.name=Lab', '-c', 'user.email=lab@example.com', ...args], { env, timeoutMs: 5 * 60 * 1000 }); }

/** Una versión numerada publicada sobre `main` del remoto, con la copia «autor». */
function publish(author, number, env) {
  fs.writeFileSync(path.join(author, 'version.json'), `{ "version": "${number}", "source": { "harness": "${'1'.repeat(40)}", "agent_skills": "${'2'.repeat(40)}" } }\n`);
  fs.appendFileSync(path.join(author, 'CHANGES'), `${number}\n`);
  for (const args of [['add', '-A'], ['commit', '-q', '-m', `versión ${number}`], ['push', '-q', 'origin', 'HEAD:main']]) {
    const r = git(author, args, env);
    if (r.exit !== 0) return { ok: false, reason: `git ${args[0]} salió ${r.exit}: ${L.firstLine(r.stderr)}` };
  }
  return { ok: true };
}

/** Todo lo que hay bajo una carpeta (rutas relativas), o `[]` si no existe. */
function listing(dir) {
  const out = [];
  const walk = (d, rel) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const n of names) { out.push(path.join(rel, n)); let st = null; try { st = fs.lstatSync(path.join(d, n)); } catch (_) { continue; } if (st.isDirectory() && !st.isSymbolicLink()) walk(path.join(d, n), path.join(rel, n)); }
  };
  if (fs.existsSync(dir)) { out.push('.'); walk(dir, ''); }
  return out;
}

function measure({ lab, platform = process.platform, baseEnv = process.env, allowTemp = false, rec }) {
  const state = T.readState(lab);
  if (!state || !state.remotes || !state.remotes.harness) return { status: L.STATUS.error, reason: `${lab} no trae el estado del ensayo (rehearsal-state.json): corré «rehearse.js init»` };
  const bare = state.remotes.harness.dir;
  const base = path.join(lab, 'codex-only');
  const home = path.join(base, 'users', 'lab-codex-only');
  const author = path.join(base, 'author');
  const program = path.join(base, 'program');
  const serverDir = path.join(base, 'server');
  const codexHome = path.join(home, '.codex');
  const claudeDir = path.join(home, '.claude');
  // la carpeta de Claude Code NO se crea: es lo que este escenario mide
  for (const d of [home, author, serverDir, codexHome]) fs.mkdirSync(d, { recursive: true });
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return { status: L.STATUS.error, reason: problem };
  const env0 = T.rehearsalEnv(home, { base: baseEnv, platform });
  rec.fact('home', home);
  rec.fact('lab_mode', !isWin);

  const point = T.pointRemotes(state, 'target', env0);
  if (point) return { status: L.STATUS.error, reason: point };
  for (const [dir, label] of [[author, 'author'], [program, 'program']]) {
    const c = git(path.dirname(dir), ['clone', '--quiet', bare, dir], env0);
    if (c.exit !== 0) return { status: L.STATUS.error, reason: `no pude clonar el remoto del arnés (${label}): ${L.firstLine(c.stderr)}` };
  }
  let org = 'TYCON-LAB', name = 'arnes-lab', repoOption = ['--repo', 'TYCON-LAB/arnes-lab'];
  try { const pr = readJson(path.join(program, 'scripts', 'publishing', 'public-repos.json')); if (pr.org && pr.repo) { org = pr.org; name = pr.repo; repoOption = []; } } catch (_) { /* --repo lo dice */ }
  try { const rm = readJson(path.join(program, 'scripts', 'setup', 'public-remotes.json')); const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec((rm.remotes || [])[0] || ''); if (m) { org = m[1]; name = m[2]; repoOption = []; } } catch (_) { /* no es la copia pública */ }

  const gitBin = L.scanPath('git', { env: env0 })[0] || 'git';
  const control = path.join(serverDir, 'control.json');
  const ports = path.join(serverDir, 'ports.env');
  fs.writeFileSync(control, '{ "auth": "none" }\n');
  const server = spawn(process.execPath, [SERVER, '--repo', bare, '--org', org, '--name', name, '--git', gitBin, '--control', control, '--log', path.join(serverDir, 'requests.log'), '--port-file', ports], { env: env0, stdio: 'ignore', windowsHide: true });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ports); i++) wait(100);
    if (!fs.existsSync(ports)) return { status: L.STATUS.error, reason: 'el servidor de versiones de juguete no arrancó' };
    const api = /^API=(.+)$/m.exec(fs.readFileSync(ports, 'utf8'))[1].trim();
    const profile = path.join(base, 'lab-profile.json');
    fs.writeFileSync(profile, '{ "install": { "profile": "full" } }\n');
    // ni TYCON_CLAUDE ni TYCON_CODEX: la herramienta la fija `--tool codex`; sin nada que detectar (variable de prueba)
    const env = T.rehearsalEnv(home, { base: baseEnv, platform, extra: {
      TYCON_RELEASE_API: api, TYCON_UPDATE_APPLY: 'auto', TYCON_PROFILE: profile, TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0',
      TYCON_TOOLS_DETECT_PATH: path.join(base, 'no-tools'), CODEX_HOME: codexHome, TYCON_UPDATE_NETWORK_BUDGET_S: '60',
    } });
    for (const k of ['TYCON_CLAUDE', 'TYCON_CODEX', 'TYCON_SETTINGS_PATH', 'CLAUDE_MD_PATH', 'CODEX_AGENTS_MD_PATH', 'TYCON_HOME']) delete env[k];
    const own = path.join(home, '.tycon');
    const tree = path.join(own, 'harness');
    const stateDir = path.join(own, 'state');
    const agentsMd = path.join(codexHome, 'AGENTS.md');
    const harnessJs = (t) => path.join(t, 'scripts', 'setup', 'harness.js');
    // `cap`: cuánto de la salida se guarda; `doctor --json` se lee entero (cortado no es JSON)
    const run = (t, args, label, cap = 4000) => {
      const r = L.run(process.execPath, [harnessJs(t), ...args], { env, timeoutMs: CMD_TIMEOUT_MS, cap });
      rec.fact(label, { exit: r.exit, error: r.error, out: lastLines(`${r.stdout}\n${r.stderr}`, 4), ms: r.ms });
      return r;
    };
    const stateFile = () => { try { return readJson(path.join(stateDir, 'harness-state.json')); } catch (_) { return null; } };
    const versionOf = () => { const s = stateFile(); return s && s.version ? s.version.number : null; };
    const noClaude = (when) => {
      const found = listing(claudeDir);
      const jsonThere = fs.existsSync(path.join(home, '.claude.json'));
      rec.fact(`claude_dir_${when}`, { entries: found.length, sample: found.slice(0, 8), claude_json: jsonThere });
      if (found.length || jsonThere) rec.finding(`codex-only:claude-dir-written-${when}`, 'claude-dir', `${when}: apareció ${found.length ? `la carpeta de Claude Code con ${found.length} entrada(s) (${found.slice(0, 4).join(', ')})` : '~/.claude.json'} en una máquina sólo con Codex`, 'W8', { severity: 'breaks' });
    };

    // 1. instalar, con un AGENTS.md que ya trae texto de la persona
    fs.writeFileSync(agentsMd, PERSON_TEXT);
    const v1 = publish(author, '2030.03.01.1', env0);
    if (!v1.ok) return { status: L.STATUS.error, reason: `no pude publicar la primera versión: ${v1.reason}` };
    const inst = run(program, ['install', '--version', 'latest', '--tool', 'codex', '--yes', ...repoOption], 'install');
    const s1 = stateFile();
    rec.fact('after_install', { version: versionOf(), tools: s1 ? s1.tools : null, kind: s1 && s1.sources && s1.sources[0] ? s1.sources[0].kind : null, state_in_own_home: Boolean(s1), harness_dir: fs.existsSync(path.join(tree, 'version.json')), fixed_copy: fs.existsSync(path.join(stateDir, 'harness', 'bootstrap.js')) });
    if (inst.exit !== 0 || versionOf() !== '2030.03.01.1') {
      rec.finding('codex-only:install-fails', 'install', `install --version latest --tool codex salió ${inst.exit}: ${lastLines(`${inst.stdout}\n${inst.stderr}`, 2)}`, 'W8', { severity: 'breaks' });
      noClaude('after-failed-install');
      return { status: L.STATUS.measured, reason: null };
    }
    noClaude('after-install');
    if (!s1 || !Array.isArray(s1.tools) || s1.tools.join(',') !== 'codex') rec.finding('codex-only:tools-not-recorded', 'state', `el estado no dice tools: codex (${JSON.stringify(s1 && s1.tools)})`, 'W8', { severity: 'loses-control' });
    // las reglas: los bloques entre marcas, lo de la persona intacto, sin @import
    let agents = '';
    try { agents = fs.readFileSync(agentsMd, 'utf8'); } catch (_) { agents = ''; }
    const blocks = (agents.match(/<!-- TYCON_BLOCK:[\w-]+ START/g) || []).length;
    const imports = agents.split('\n').filter((l) => l.startsWith('@')).length;
    rec.fact('agents_md', { blocks, person_text_intact: agents.startsWith(PERSON_TEXT), import_lines: imports, bytes: agents.length });
    if (!blocks) rec.finding('codex-only:agents-md-without-blocks', 'rules', 'AGENTS.md no trae ningún bloque del arnés: Codex no recibe las reglas', 'W8', { severity: 'loses-control' });
    if (!agents.startsWith(PERSON_TEXT)) rec.finding('codex-only:person-text-changed', 'rules', 'lo que la persona tenía en AGENTS.md fuera de las marcas cambió', 'W8', { severity: 'breaks' });
    if (imports) rec.finding('codex-only:agents-md-import', 'rules', `AGENTS.md trae ${imports} renglón(es) @import, que Codex no resuelve`, 'W8', { severity: 'noise' });
    // las skills, los hooks y las rutas escribibles
    let skillLinks = 0;
    try { for (const n of fs.readdirSync(path.join(codexHome, 'skills'))) { try { if (fs.lstatSync(path.join(codexHome, 'skills', n)).isSymbolicLink() || isWin) skillLinks++; } catch (_) { /* siguiente */ } } } catch (_) { skillLinks = 0; }
    let startCmd = null; let namesClaude = false;
    try {
      const hooks = readJson(path.join(codexHome, 'hooks.json')).hooks || {};
      const cmds = Object.values(hooks).flat().flatMap((g) => (g && g.hooks) || []).map((h) => String(h.command || ''));
      startCmd = (hooks.SessionStart || []).flatMap((g) => g.hooks || []).map((h) => String(h.command || '')).find((c) => c.includes('harness-startup.js')) || null;
      namesClaude = cmds.some((c) => /[\\/]\.claude[\\/]/.test(c));
    } catch (_) { startCmd = null; }
    let toml = '';
    try { toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); } catch (_) { toml = ''; }
    const rootsOk = toml.includes(JSON.stringify(stateDir));
    rec.fact('codex_plug', { skill_links: skillLinks, startup_hook: startCmd, hooks_name_claude_dir: namesClaude, writable_roots_has_own_state: rootsOk });
    if (!skillLinks) rec.finding('codex-only:no-skill-links', 'skills', 'no quedó ninguna skill enlazada en ~/.codex/skills (en Windows, uniones)', 'W8', { severity: 'loses-control' });
    if (!startCmd) rec.finding('codex-only:no-startup-hook', 'hooks', 'el hook de arranque de Codex (harness-startup.js) no quedó registrado: esta máquina no se actualiza sola', 'W8', { severity: 'loses-control' });
    else if (!slash(startCmd).includes(slash(path.join(tree, 'scripts', 'hooks', 'harness-startup.js')))) rec.finding('codex-only:startup-hook-elsewhere', 'hooks', `el hook de arranque no apunta a ~/.tycon/harness: ${startCmd}`, 'W8', { severity: 'loses-control' });
    if (namesClaude) rec.finding('codex-only:hooks-name-claude-dir', 'hooks', 'algún hook de Codex nombra la carpeta de Claude Code', 'W8', { severity: 'loses-control' });
    if (!rootsOk) rec.finding('codex-only:writable-roots-missing', 'mcp', 'config.toml no lleva ~/.tycon/state en writable_roots: el pipeline bajo Codex no puede escribir su estado', 'W8', { severity: 'loses-control' });

    // 2. una versión nueva, y el hook de arranque de Codex como quedó registrado: actualiza
    if (startCmd) {
      const v2 = publish(author, '2030.03.01.2', env0);
      if (!v2.ok) return { status: L.STATUS.error, reason: `no pude publicar la segunda versión: ${v2.reason}` };
      const hookFile = path.join(tree, 'scripts', 'hooks', 'harness-startup.js');
      const st = L.run(process.execPath, [hookFile], { env, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'lab', cwd: base }), timeoutMs: CMD_TIMEOUT_MS, cap: 2000 });
      const until = Date.now() + UPDATE_WAIT_MS;
      while (versionOf() !== '2030.03.01.2' && Date.now() < until) wait(500);
      rec.fact('startup_update', { hook_exit: st.exit, version: versionOf(), out: lastLines(`${st.stdout}\n${st.stderr}`, 2), ms: st.ms });
      if (st.exit !== 0) rec.finding('codex-only:startup-hook-exit', 'startup', `el hook de arranque de Codex salió ${st.exit} (tiene que salir 0 siempre)`, 'W8', { severity: 'noise' });
      if (versionOf() !== '2030.03.01.2') {
        let logTail = '';
        try { logTail = lastLines(fs.readFileSync(path.join(stateDir, 'harness', 'startup.log'), 'utf8'), 3); } catch (_) { logTail = 'sin registro'; }
        rec.finding('codex-only:startup-does-not-update', 'startup', `el arranque de Codex no actualizó el arnés (sigue en ${versionOf()}): ${logTail}`, 'W8', { severity: 'breaks' });
      }
      noClaude('after-startup');
    }

    // 3. doctor y uninstall
    const doc = run(tree, ['doctor', '--json'], 'doctor', 400000);
    let fails = null;
    try { fails = JSON.parse(doc.stdout).fail; } catch (_) { fails = null; }
    rec.fact('doctor_fail', fails);
    if (doc.exit !== 0 || !Array.isArray(fails) || fails.length) rec.finding('codex-only:doctor-red', 'doctor', `doctor --json salió ${doc.exit}: ${JSON.stringify(fails).slice(0, 400)}`, 'W8', { severity: 'loses-control' });
    const un = run(tree, ['uninstall', '--yes'], 'uninstall');
    let after = '';
    try { after = fs.readFileSync(agentsMd, 'utf8'); } catch (_) { after = ''; }
    rec.fact('after_uninstall', { harness_dir: fs.existsSync(tree), state_dir: fs.existsSync(stateDir), agents_md_blocks: (after.match(/TYCON_BLOCK/g) || []).length, person_text_kept: after.includes('texto propio de la persona') });
    if (un.exit !== 0 || fs.existsSync(tree)) rec.finding('codex-only:uninstall-fails', 'uninstall', `uninstall --yes salió ${un.exit}; ~/.tycon/harness ${fs.existsSync(tree) ? 'sigue' : 'se fue'}: ${lastLines(`${un.stdout}\n${un.stderr}`, 2)}`, 'W8', { severity: 'loses-control' });
    if (fs.existsSync(stateDir)) rec.finding('codex-only:state-dir-left', 'uninstall', 'después de uninstall quedó ~/.tycon/state: la máquina sigue marcada como «vive en ~/.tycon»', 'W8', { severity: 'loses-control' });
    if (/TYCON_BLOCK/.test(after) || !after.includes('texto propio de la persona')) rec.finding('codex-only:agents-md-after-uninstall', 'uninstall', 'AGENTS.md después de uninstall: quedaron bloques del arnés o se perdió lo de la persona', 'W8', { severity: 'loses-control' });
    noClaude('after-uninstall');
    return { status: L.STATUS.measured, reason: null };
  } finally { kill(server); }
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`codex-only-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`codex-only-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, allowTemp: Boolean(args['allow-temp']), rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  say(`codex-only: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, measure };
