#!/usr/bin/env node
'use strict';
/**
 * migrate-probe.js — la mudanza de una máquina del clon a `~/.tycon` en un Windows (story 8.23, tanda D · AC 27-29 ·
 * escenario `migrate` del pipeline 182).
 *
 * POR QUÉ EXISTE. `harness.js migrate --to-home` mueve el estado, funde la configuración, re-apunta tres enlaces y
 * re-enchufa los hooks desde el árbol nuevo. En Windows cada una de esas cosas es distinta: los enlaces de carpeta son
 * uniones, un archivo abierto por otro proceso traba el `rename` de su carpeta (la precondición «nadie tiene tomados los
 * archivos del lugar viejo» existe sólo ahí), y las rutas llevan barra invertida en los comandos de los hooks. La suite
 * de la Mac (harness-move-home.test.sh) no puede medir nada de eso. Este paso lo ensaya en el agente Windows con el
 * «GitHub» de juguete sirviendo el remoto del laboratorio, y lo dice.
 *
 * QUÉ HACE, en una carpeta de usuario de laboratorio:
 *   1. Instala el arnés DESDE UN CLON (`harness.js install --yes` corrido desde ese clon): la máquina de hoy.
 *   2. Publica una versión en el remoto (el clon NO se actualiza: la mudanza no hace git) y mira `migrate --to-home
 *      --dry-run`: sale 0, dice qué mueve, qué enchufa y qué deja como enlace, y no escribe.
 *   3. En Windows, con un archivo del estado abierto por otro proceso: `migrate --to-home` sale 1, nombra la carpeta
 *      tomada y la máquina sigue siendo un clon. Con un archivo de agent-skills abierto (carpeta real, que la mudanza
 *      aparta), ya `--dry-run` sale 1 y la nombra. Fuera de Windows no se mide (en posix un rename no se traba) y se dice.
 *   4. `migrate --to-home` de verdad: la versión en `~/.tycon/harness`, el estado en `~/.tycon/state`, el lugar,
 *      `agent-skills` y `.tycon-pipeline` como enlaces (uniones), la misma cuenta de hooks y ninguno que nombre el clon,
 *      el clon idéntico (archivos y `.git`). Después, `startup` y `doctor --json` en verde.
 * Cada diferencia con lo que pasa en Mac sale como hallazgo con su gravedad.
 *
 * Fuera de Windows corre igual («modo de laboratorio»): es el mismo camino, sin las uniones ni el archivo tomado.
 *
 * CÓMO FALLA. Una mudanza que no anda es un HECHO del reporte. El paso sale «error» sólo si no pudo ensayar: sin el
 * remoto del laboratorio, sin git para el servidor de juguete, sin node.
 *
 * Uso: node scripts/tests/windows/migrate-probe.js --lab <laboratorio> --out <carpeta del reporte> [--allow-temp]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const L = require('./lab.js');
const T = require('./team-lab.js');

const NAME = 'migrate';
const HERE = __dirname;
const SERVER = path.join(HERE, '..', 'fixtures', 'toy-release-server.js');
// story 8.25 (A1a-azure, TZ14): el Azure DevOps de juguete que atiende el repo del equipo —la capa viaja desde ahí—
const AZURE_SERVER = path.join(HERE, '..', 'fixtures', 'toy-azure-server.js');
const TEAM_URL = 'https://dev.azure.com/acme/proyecto/_git/equipo-lab';
const CMD_TIMEOUT_MS = 10 * 60 * 1000;
const say = (s) => process.stdout.write(`${s}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const lastLines = (s, n = 3) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');
const isWin = L.isWin();
const slash = (s) => String(s).replace(/\\/g, '/');
const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* nada */ } };
const kill = (p) => { if (p) { try { p.kill(); } catch (_) { /* ya */ } } };
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };

// con identidad propia: el agente de Windows no tiene user.name/user.email y `git commit` sale 128 (182 #12314)
// …y sin los hooks de git de la carpeta de usuario del laboratorio: desde el 2026-10-14 `install` y la mudanza ponen ahí la
// carpeta global de hooks del arnés, y su pre-push (el freno antes de publicar) frenaba las publicaciones de juguete del
// propio ensayo, que van a un remoto de laboratorio declarado público (182 #13452). Lo que se mide es el arnés, no esto
const LAB_NO_HOOKS = path.join(require('os').tmpdir(), 'tycon-lab-no-git-hooks');
function git(dir, args, env) { return L.run('git', ['-C', dir, '-c', 'user.name=Lab', '-c', 'user.email=lab@example.com', '-c', `core.hooksPath=${LAB_NO_HOOKS}`, ...args], { env, timeoutMs: 5 * 60 * 1000 }); }

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

/** Un proceso que deja un archivo ABIERTO sin compartir (Windows) hasta que se lo mate. */
function holdOpen(file, env) {
  if (!isWin) return null;
  const ps = L.scanPath('pwsh', { env })[0] || L.scanPath('powershell', { env })[0];
  if (!ps) return null;
  // compartido para LEER: lo que se mide es que la carpeta no se puede renombrar con un archivo abierto adentro, no que el
  // estado quede ilegible (con 'None' el propio harness.js no podía leer su estado y salía 2 por otro motivo: 182 #12395)
  const script = `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); Start-Sleep -Seconds 600`;
  return spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env, stdio: 'ignore', windowsHide: true });
}

/** El hash de una carpeta entera (contenido y rutas relativas), con su .git: un fetch, un pull o un reset lo cambian. */
function dirHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n), r = `${rel}/${n}`;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, r);
      else { h.update(r); h.update(st.isSymbolicLink() ? fs.readlinkSync(p) : fs.readFileSync(p)); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

function measure({ lab, platform = process.platform, baseEnv = process.env, allowTemp = false, rec }) {
  const state = T.readState(lab);
  if (!state || !state.remotes || !state.remotes.harness) return { status: L.STATUS.error, reason: `${lab} no trae el estado del ensayo (rehearsal-state.json): corré «rehearse.js init»` };
  const bare = state.remotes.harness.dir;
  const base = path.join(lab, 'migrate');
  const home = path.join(base, 'users', 'lab-migrate');
  const author = path.join(base, 'author');
  const clone = path.join(base, 'clone');     // el clon de la persona: desde acá se instala, y la mudanza no lo toca
  const serverDir = path.join(base, 'server');
  for (const d of [home, author, serverDir, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return { status: L.STATUS.error, reason: problem };
  const env0 = T.rehearsalEnv(home, { base: baseEnv, platform });
  rec.fact('home', home);
  rec.fact('lab_mode', !isWin);

  const point = T.pointRemotes(state, 'target', env0);
  if (point) return { status: L.STATUS.error, reason: point };
  for (const [dir, label] of [[author, 'author'], [clone, 'clone']]) {
    const c = git(path.dirname(dir), ['clone', '--quiet', bare, dir], env0);
    if (c.exit !== 0) return { status: L.STATUS.error, reason: `no pude clonar el remoto del arnés (${label}): ${L.firstLine(c.stderr)}` };
  }
  let org = 'TYCON-LAB', name = 'arnes-lab', repoOption = ['--repo', 'TYCON-LAB/arnes-lab'];
  try { const pr = readJson(path.join(clone, 'scripts', 'publishing', 'public-repos.json')); if (pr.org && pr.repo) { org = pr.org; name = pr.repo; repoOption = []; } } catch (_) { /* --repo lo dice */ }
  // story 8.25: el clon de juguete NO hereda el repo del equipo del repo real (la clave `team`): este ensayo mide la mudanza
  // SIN capa (regresión); el servidor de juguete atiende un solo repo y con la clave la mudanza exigiría ver el otro
  try {
    const prFile = path.join(clone, 'scripts', 'publishing', 'public-repos.json');
    const pr = readJson(prFile);
    if (pr.team !== undefined) { delete pr.team; fs.writeFileSync(prFile, `${JSON.stringify(pr, null, 2)}\n`); rec.fact('team_key_stripped', true); }
  } catch (_) { /* sin el archivo no hay clave que sacar */ }
  try { const rm = readJson(path.join(clone, 'scripts', 'setup', 'public-remotes.json')); const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec((rm.remotes || [])[0] || ''); if (m) { org = m[1]; name = m[2]; repoOption = []; } } catch (_) { /* idem */ }

  const gitBin = L.scanPath('git', { env: env0 })[0] || 'git';
  const control = path.join(serverDir, 'control.json');
  const ports = path.join(serverDir, 'ports.env');
  fs.writeFileSync(control, '{ "auth": "none" }\n');
  const server = spawn(process.execPath, [SERVER, '--repo', bare, '--org', org, '--name', name, '--git', gitBin, '--control', control, '--log', path.join(serverDir, 'requests.log'), '--port-file', ports], { env: env0, stdio: 'ignore', windowsHide: true });
  const holders = [];
  const stopAll = () => { kill(server); for (const p of holders) kill(p); };
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ports); i++) wait(100);
    if (!fs.existsSync(ports)) return { status: L.STATUS.error, reason: 'el servidor de versiones de juguete no arrancó' };
    const api = /^API=(.+)$/m.exec(fs.readFileSync(ports, 'utf8'))[1].trim();
    rec.fact('toy_server', { api, org, name });
    // el repo del equipo de juguete (los tres archivos de la capa) y el Azure DevOps de juguete que lo atiende (story 8.25, TZ14):
    // la mudanza de esta máquina va a traer la capa desde ahí; sin credencial, tiene que DECIRLO y no escribir
    const teamWork = path.join(base, 'team-work'), teamBare = path.join(base, 'team.git');
    fs.mkdirSync(path.join(teamWork, 'scripts', 'metrics'), { recursive: true });
    fs.writeFileSync(path.join(teamWork, 'team-layer.json'), '{ "schema": 1, "name": "equipo-lab", "requires": { "harness": ">= 2026.10.01.1" } }\n');
    fs.writeFileSync(path.join(teamWork, 'perfil-equipo.json'), `${JSON.stringify({ ado: { org: 'https://dev.azure.com/acme' }, integrations: { engram: true, nightly: true, codex: 'detect' }, update: { channel: 'latest', apply: 'auto' }, packs: { default: 'all' }, install: { profile: 'full' } }, null, 2)}\n`);
    fs.writeFileSync(path.join(teamWork, 'scripts', 'metrics', 'corridas-buzon.json'), '{ "_que_es": "la llave de JUGUETE del buzón (ensayo): no abre nada", "cuenta": "labcorridas", "contenedor": "corridas", "sas": "sv=lab", "vence": "2099-01-01" }\n');
    for (const args of [['init', '--quiet', '-b', 'main'], ['add', '-A'], ['commit', '--quiet', '-m', 'la capa del equipo (ensayo)']]) { const g = git(teamWork, args, env0); if (g.exit !== 0) return { status: L.STATUS.error, reason: `no pude armar el repo del equipo de juguete (git ${args[0]}): ${L.firstLine(g.stderr)}` }; }
    { const g = git(base, ['clone', '--quiet', '--bare', teamWork, teamBare], env0); if (g.exit !== 0) return { status: L.STATUS.error, reason: `no pude armar el bare del repo del equipo: ${L.firstLine(g.stderr)}` }; }
    const azureControl = path.join(serverDir, 'azure-control.json'), azurePorts = path.join(serverDir, 'azure-ports.env');
    fs.writeFileSync(azureControl, '{ "pat": "pat-lab" }\n');
    const azureSrv = spawn(process.execPath, [AZURE_SERVER, '--repo', teamBare, '--org', 'acme', '--project', 'proyecto', '--name', 'equipo-lab', '--git', gitBin, '--control', azureControl, '--log', path.join(serverDir, 'azure-requests.log'), '--port-file', azurePorts], { env: env0, stdio: 'ignore', windowsHide: true });
    holders.push(azureSrv);
    for (let i = 0; i < 100 && !fs.existsSync(azurePorts); i++) wait(100);
    if (!fs.existsSync(azurePorts)) return { status: L.STATUS.error, reason: 'el Azure DevOps de juguete no arrancó' };
    const azureApi = /^AZURE=(.+)$/m.exec(fs.readFileSync(azurePorts, 'utf8'))[1].trim();
    rec.fact('toy_azure', { api: azureApi, team: TEAM_URL });
    // T48 (story 8.23, tanda G · AC 41): el perfil del equipo vive EN EL CLON de la persona (perfil-equipo.json en su raíz,
    // como en toda máquina del equipo), no por variable: así la mudanza tiene que pasarlo a ~/.tycon/config.json, porque la
    // versión publicada (el autor) no lo trae. Antes la sonda lo ponía por TYCON_PROFILE, que sobrevivía a la mudanza y
    // tapaba justo la pérdida que la primera máquina migrada mostró (2026-10-08).
    const teamProfile = { ado: { org: 'https://dev.azure.com/acme' }, integrations: { engram: true, nightly: true, codex: 'detect' }, update: { channel: 'latest', apply: 'auto' }, packs: { default: 'all' }, install: { profile: 'full' } };
    fs.writeFileSync(path.join(clone, 'perfil-equipo.json'), `${JSON.stringify(teamProfile, null, 2)}\n`);
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');
    const env = T.rehearsalEnv(home, { base: baseEnv, platform, extra: {
      TYCON_RELEASE_API: api, TYCON_AZURE_API: azureApi, TYCON_UPDATE_APPLY: 'auto', TYCON_PROFILE: '', TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0',
      TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
      CODEX_HOME: path.join(home, '.codex'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'), TYCON_UPDATE_NETWORK_BUDGET_S: '60', TYCON_STARTUP_DETACH: '0',
    } });
    const own = path.join(home, '.tycon');
    const newTree = path.join(own, 'harness');
    const oldStateDir = path.join(home, '.claude', '.tycon-pipeline');
    const PLACE = require(path.join(clone, 'scripts', 'setup', 'harness', 'place.js'));
    const placeLink = path.join(home, '.claude', PLACE.PLACE_NAME);
    const skillsLink = path.join(home, '.claude', 'agent-skills');
    const harnessJs = (tree) => path.join(tree, 'scripts', 'setup', 'harness.js');
    const run = (tree, args, label, cap = 4000) => {
      const r = L.run(process.execPath, [harnessJs(tree), ...args], { env, timeoutMs: CMD_TIMEOUT_MS, cap });
      rec.fact(label, { exit: r.exit, error: r.error, out: lastLines(`${r.stdout}\n${r.stderr}`, 4), ms: r.ms });
      return r;
    };
    const stateFile = () => { for (const f of [path.join(own, 'state', 'harness-state.json'), path.join(oldStateDir, 'harness-state.json')]) { try { return readJson(f); } catch (_) { /* el otro */ } } return null; };
    const kindOf = () => { const s = stateFile(); return s && s.sources && s.sources[0] ? (s.sources[0].kind || 'tree') : null; };
    const linkKind = (p) => { try { const st = fs.lstatSync(p); return st.isSymbolicLink() ? (isWin ? 'symlink-or-junction' : 'symlink') : (st.isDirectory() ? 'directory' : 'file'); } catch (_) { return 'missing'; } };
    const resolvesTo = (link, target) => { const a = realOrNull(link), b = realOrNull(target); return Boolean(a && b && slash(a).toLowerCase() === slash(b).toLowerCase()); };
    const hookCmds = () => { try { return Object.values(readJson(path.join(home, '.claude', 'settings.json')).hooks || {}).flat().flatMap((m) => m.hooks || []).map((h) => String(h.command || '')); } catch (_) { return []; } };
    // la carpeta que precede a /scripts/hooks/ en el comando: entre comillas puede llevar espacios (una carpeta de usuario «Nombre Apellido»)
    const namesDir = (cmd, dir) => { const m = /"([^"]+?)[/\\]scripts[/\\]hooks[/\\]/.exec(cmd) || /'([^']+?)[/\\]scripts[/\\]hooks[/\\]/.exec(cmd) || /(?:^|\s)([^"'\s]+?)[/\\]scripts[/\\]hooks[/\\]/.exec(cmd); if (!m) return false; const r = realOrNull(m[1]); const d = realOrNull(dir); return Boolean(r && d && slash(r).toLowerCase() === slash(d).toLowerCase()); };

    // 1. la máquina de hoy: instalada desde el clon
    const inst = run(clone, ['install', '--yes'], 'install_from_clone');
    if (inst.exit !== 0 || kindOf() !== 'tree') {
      rec.finding('migrate:install-from-clone-fails', 'install', `install --yes desde el clon salió ${inst.exit} (kind ${kindOf()}): sin máquina que mudar`, 'W8', { severity: 'breaks' });
      return { status: L.STATUS.measured, reason: null };
    }
    const hooks0 = hookCmds();
    let cloneHash0 = dirHash(clone);
    rec.fact('before', { hooks: hooks0.length, hooks_naming_clone: hooks0.filter((c) => namesDir(c, clone)).length, place: linkKind(placeLink), skills: linkKind(skillsLink) });
    // T43 (story 8.23, tanda F · AC 40): lo PERSONAL del dev en la carpeta vieja —una skill y un agente que no son del arnés
    // ni de terceros— tiene que seguir activo después de la mudanza. Sólo si la carpeta vieja es una carpeta real (en esta
    // sonda el install desde el clon la deja como enlace: entonces se arma como la máquina de un dev: una carpeta real con
    // las entradas del clon y lo personal, y ~/.claude/skills y ~/.claude/agents como enlaces que pasan por ella)
    const personal = { skill: 'personal-skill', agent: 'personal-agent.md' };
    const skillsDir = path.join(home, '.claude', 'skills'), agentsDir = path.join(home, '.claude', 'agents');
    let personalArmed = false;
    try {
      if (linkKind(skillsLink) !== 'directory') {
        try { fs.rmSync(skillsLink, { recursive: true, force: true }); } catch (_) { /* un enlace o nada */ }
        fs.mkdirSync(path.join(skillsLink, 'skills'), { recursive: true }); fs.mkdirSync(path.join(skillsLink, 'agents'), { recursive: true });
        for (const side of ['skills', 'agents']) for (const n of fs.readdirSync(path.join(clone, side))) { try { fs.cpSync(path.join(clone, side, n), path.join(skillsLink, side, n), { recursive: true }); } catch (_) { /* una entrada que no se copia no es personal */ } }
      }
      fs.mkdirSync(path.join(skillsLink, 'skills', personal.skill), { recursive: true });
      fs.writeFileSync(path.join(skillsLink, 'skills', personal.skill, 'SKILL.md'), '# skill personal del dev (ensayo)\n');
      fs.writeFileSync(path.join(skillsLink, 'agents', personal.agent), '# agente personal del dev (ensayo)\n');
      for (const [where, sub] of [[skillsDir, 'skills'], [agentsDir, 'agents']]) {
        try { fs.rmSync(where, { recursive: true, force: true }); } catch (_) { /* nada */ }
        fs.symlinkSync(path.join(skillsLink, sub), where, 'junction');
      }
      personalArmed = true;
    } catch (e) { rec.note(`lo personal no se pudo armar (${e.message}): T43 no medido en esta corrida`); }
    rec.fact('personal_before', { armed: personalArmed, old_is_dir: linkKind(skillsLink) === 'directory', skills_link: linkKind(skillsDir), agents_link: linkKind(agentsDir) });

    // 2. una versión publicada (el clon NO se actualiza) y el plan. La versión que se publica acá sale del repo INTERNO
    // (el bundle del ensayo), que trae el perfil del equipo real; la copia pública de verdad NO lo trae (el exportador lo
    // deja afuera): se saca antes de publicar, para que la máquina mudada lea sólo lo que la mudanza fundió. Sin esto,
    // #12493-#12495: la máquina mudada leía el perfil REAL del árbol bajado (clockify prendida) y aparecían los dos hooks
    // de clocki, que el perfil del ensayo no prende
    try { fs.rmSync(path.join(author, 'perfil-equipo.json'), { force: true }); } catch (_) { /* no estaba */ }
    // y lo mismo con la llave del buzón (story 8.25, 182 #12528): la versión bajada de verdad tampoco la trae; con ella adentro,
    // el arnés —bien— se niega a apilar la capa del equipo sobre una versión que ya trae una ruta de su lista cerrada
    try { fs.rmSync(path.join(author, 'scripts', 'metrics', 'corridas-buzon.json'), { force: true }); } catch (_) { /* no estaba */ }
    const v1 = publish(author, '2030.03.01.1', env0);
    if (!v1.ok) return { status: L.STATUS.error, reason: `no pude publicar la versión: ${v1.reason}` };
    const dry = run(clone, ['migrate', '--to-home', '--dry-run', ...repoOption], 'dry_run', 8000);
    const dryOut = `${dry.stdout}\n${dry.stderr}`;
    if (dry.exit !== 0) rec.finding('migrate:dry-run-fails', 'plan', `migrate --to-home --dry-run salió ${dry.exit}: ${lastLines(dryOut, 3)}`, 'W8', { severity: 'breaks' });
    for (const word of ['mueve:', 'enlace:', 'enchufa:']) if (!dryOut.includes(word)) rec.finding(`migrate:plan-without-${word.replace(':', '')}`, 'plan', `el plan no dice «${word}»: ${lastLines(dryOut, 4)}`, 'W8', { severity: 'noise' });
    if (personalArmed && !/conserva 1 skills y 1 agente tuyos/.test(dryOut)) rec.finding('migrate:plan-without-personal', 'plan', `el plan no dice «conserva 1 skills y 1 agente tuyos» (T43): ${(dryOut.match(/.*conserva.*/) || ['sin línea conserva'])[0].slice(0, 300)}`, 'W8', { severity: 'loses-control' });
    if (personalArmed && !(dryOut.includes(personal.skill) && dryOut.includes(personal.agent))) rec.finding('migrate:plan-personal-unnamed', 'plan', 'el plan no nombra la skill y el agente personales (T43)', 'W8', { severity: 'noise' });
    // T48 (tanda G): el plan anticipa que el perfil del equipo pasa al archivo de la máquina, con sus valores
    if (!/perfil del equipo: .*perfil-equipo\.json → .*config\.json, como valores de la máquina/.test(dryOut)) rec.finding('migrate:plan-without-profile', 'plan', `el plan no dice que el perfil del equipo pasa a ~/.tycon/config.json (T48): ${(dryOut.match(/.*perfil del equipo.*/) || ['sin línea «perfil del equipo»'])[0].slice(0, 300)}`, 'W8', { severity: 'loses-control' });
    else if (!(dryOut.includes('engram') && dryOut.includes('canal latest') && dryOut.includes('paquete del stack all'))) rec.finding('migrate:plan-profile-unnamed', 'plan', 'la línea del perfil del equipo no nombra engram, canal latest y paquete del stack all (T48)', 'W8', { severity: 'noise' });
    if (kindOf() !== 'tree' || fs.existsSync(newTree)) rec.finding('migrate:dry-run-wrote', 'plan', '--dry-run escribió: la máquina cambió o apareció ~/.tycon/harness', 'W8', { severity: 'breaks' });

    // 2 bis. la capa del equipo desde AZURE DEVOPS (story 8.25, TZ14 = Windows_MigrateAzure_NoCredentialSaid_AndHappyPathWithToyPat_Pipeline182,
    // la mide el agente de la 182 por número de corrida): el clon declara el repo del equipo por su URL (la clave
    // `team` de public-repos.json). (a) SIN credencial —el gestor de credenciales del agente no tiene nada para dev.azure.com y
    // no hay PAT guardado—, la mudanza no arranca, lo DICE con las dos formas de ponerla y no escribe (el caso de la máquina
    // Windows que dejó de actualizarse sin avisar); (b) con el PAT de juguete guardado, el plan nombra la capa y la mudanza
    // real (abajo) la apila: el perfil llega con origen «perfil», no se funde
    {
      const prFile = path.join(clone, 'scripts', 'publishing', 'public-repos.json');
      let pr = {}; try { pr = readJson(prFile); } catch (_) { pr = { org, repo: name }; }
      pr.team = TEAM_URL;
      fs.writeFileSync(prFile, `${JSON.stringify(pr, null, 2)}\n`);
      cloneHash0 = dirHash(clone);   // la clave es parte del clon que la mudanza no debe tocar
      const homeHash0 = dirHash(home);
      const noCred = run(clone, ['migrate', '--to-home', ...repoOption], 'migrate_azure_no_credential', 6000);
      const noOut = `${noCred.stdout}\n${noCred.stderr}`;
      // qué rama salió: «sin credencial» (el gestor del agente no tiene nada para dev.azure.com: lo que D-9 supone) o «no vale»
      // (el gestor TENÍA una credencial —la de otra organización— y el Azure de juguete la rechazó): las dos son «lo dice», pero
      // sólo la primera mide D-9, y la segunda queda anotada para que se sepa
      const branch = /sin credencial de Azure DevOps/.test(noOut) ? 'missing' : (/no vale para/.test(noOut) ? 'invalid' : null);
      rec.fact('azure_no_credential', { exit: noCred.exit, branch, said_missing: branch !== null, said_how: /config set azure\.token/.test(noOut) && /gestor de credenciales/.test(noOut), wrote: dirHash(home) !== homeHash0 || fs.existsSync(newTree), kind: kindOf() });
      const anc = rec.step.facts.azure_no_credential;
      if (branch === 'invalid') rec.note('el gestor de credenciales del agente TENÍA una credencial para dev.azure.com (la rechazó el Azure de juguete): la rama «sin credencial» no se midió en esta corrida; la de «no vale», sí');
      if (noCred.exit !== 1 || anc.kind !== 'tree') rec.finding('migrate:azure-no-credential-not-refused', 'team', `sin credencial de Azure DevOps, migrate salió ${noCred.exit} (kind ${anc.kind}): tenía que salir 1 sin escribir (TZ14): ${lastLines(noOut, 3)}`, 'W8', { severity: 'breaks' });
      if (anc.wrote) rec.finding('migrate:azure-no-credential-wrote', 'team', 'sin credencial de Azure DevOps la mudanza escribió algo en la HOME (TZ14)', 'W8', { severity: 'breaks' });
      if (!anc.said_missing) rec.finding('migrate:azure-no-credential-silent', 'team', `sin credencial de Azure DevOps la mudanza no lo dijo (TZ14): ${lastLines(noOut, 3)}`, 'W8', { severity: 'loses-control' });
      else if (!anc.said_how) rec.finding('migrate:azure-no-credential-no-how', 'team', `sin credencial, el aviso no da las dos formas de ponerla (config set azure.token · el gestor de git) (TZ14): ${lastLines(noOut, 3)}`, 'W8', { severity: 'noise' });
      // el PAT de juguete, como lo dejaría `harness.js config set azure.token`
      fs.mkdirSync(own, { recursive: true });
      fs.writeFileSync(path.join(own, 'config.json'), '{ "azure": { "token": "pat-lab" } }\n', { mode: 0o600 });
      const dryT = run(clone, ['migrate', '--to-home', '--dry-run', ...repoOption], 'dry_run_with_team', 8000);
      const dryTOut = `${dryT.stdout}\n${dryT.stderr}`;
      if (dryT.exit !== 0) rec.finding('migrate:azure-dry-run-fails', 'team', `con el PAT, migrate --dry-run salió ${dryT.exit} (TZ14): ${lastLines(dryTOut, 3)}`, 'W8', { severity: 'breaks' });
      if (!dryTOut.includes(`capa del equipo ${TEAM_URL} @`)) rec.finding('migrate:azure-plan-without-layer', 'team', `el plan no nombra la capa del equipo por su URL de Azure (TZ14): ${lastLines(dryTOut, 4)}`, 'W8', { severity: 'loses-control' });
      if (!/perfil del equipo: viaja en la capa del equipo/.test(dryTOut)) rec.finding('migrate:azure-plan-fuses-profile', 'team', `con capa, el plan no dice que el perfil viaja en la capa (no se funde) (TZ14): ${(dryTOut.match(/.*perfil del equipo.*/) || ['sin línea'])[0].slice(0, 300)}`, 'W8', { severity: 'loses-control' });
      if (fs.existsSync(newTree)) rec.finding('migrate:azure-dry-run-wrote', 'team', 'el --dry-run con capa escribió ~/.tycon/harness', 'W8', { severity: 'breaks' });
    }

    // 3. los archivos del lugar viejo tomados (sólo Windows): la precondición frena sin escribir
    if (isWin) {
      const held = holdOpen(path.join(oldStateDir, 'harness-state.json'), env0);
      if (held) {
        holders.push(held);
        wait(1500);
        const blocked = run(clone, ['migrate', '--to-home', ...repoOption], 'migrate_with_locked_file');
        const out = `${blocked.stdout}\n${blocked.stderr}`;
        rec.fact('locked_file', { exit: blocked.exit, kind: kindOf(), harness_dir: fs.existsSync(newTree) });
        if (blocked.exit !== 1) rec.finding('migrate:locked-file-not-refused', 'preconditions', `con un archivo del estado tomado, migrate salió ${blocked.exit} (tenía que salir 1 sin escribir): ${lastLines(out, 2)}`, 'W8', { severity: 'breaks' });
        else if (!/tomad[oa]s?/.test(out) || !/\.tycon-pipeline \(E[A-Z]+\)/.test(out)) rec.finding('migrate:locked-file-reason-missing', 'preconditions', `con un archivo tomado salió 1 pero no nombra la carpeta tomada con su código: ${lastLines(out, 2)}`, 'W8', { severity: 'noise' });
        if (kindOf() !== 'tree' || fs.existsSync(newTree)) rec.finding('migrate:locked-file-wrote', 'preconditions', 'con un archivo tomado la mudanza escribió igual', 'W8', { severity: 'breaks' });
        kill(held); holders.pop();
        wait(1500);
      } else rec.note('archivo tomado: sin PowerShell para abrirlo, no medido');
      // 3 bis. una carpeta tomada que NO es el estado: agent-skills como carpeta real, con un archivo de una skill personal
      // abierto (el caso de una máquina Windows: la mudanza falló a mitad de camino, al apartar agent-skills, con EPERM).
      // Ya el plan (--dry-run) frena, nombra agent-skills con su código y dice qué cerrar; no escribe nada
      const personalFile = path.join(skillsLink, 'skills', personal.skill, 'SKILL.md');
      const heldSkills = personalArmed && linkKind(skillsLink) === 'directory' ? holdOpen(personalFile, env0) : null;
      if (heldSkills) {
        holders.push(heldSkills);
        wait(1500);
        const blocked2 = run(clone, ['migrate', '--to-home', '--dry-run', ...repoOption], 'dry_run_with_skills_locked');
        const out2 = `${blocked2.stdout}\n${blocked2.stderr}`;
        const said = { names_skills: /agent-skills \(E[A-Z]+\)/.test(out2), says_what: /VS Code/.test(out2) && /reinici/.test(out2) };
        rec.fact('skills_locked', { exit: blocked2.exit, ...said, kind: kindOf(), harness_dir: fs.existsSync(newTree), skills: linkKind(skillsLink) });
        if (blocked2.exit !== 1) rec.finding('migrate:skills-locked-not-refused', 'preconditions', `con un archivo de agent-skills tomado, migrate --dry-run salió ${blocked2.exit} (tenía que salir 1: la mudanza fallaría a mitad de camino al apartarla): ${lastLines(out2, 2)}`, 'W8', { severity: 'breaks' });
        else if (!said.names_skills || !said.says_what) rec.finding('migrate:skills-locked-reason-missing', 'preconditions', `con agent-skills tomada salió 1 pero no la nombra con su código o no dice qué cerrar: ${lastLines(out2, 2)}`, 'W8', { severity: 'noise' });
        if (kindOf() !== 'tree' || fs.existsSync(newTree) || linkKind(skillsLink) !== 'directory') rec.finding('migrate:skills-locked-wrote', 'preconditions', 'con agent-skills tomada el plan escribió o movió algo', 'W8', { severity: 'breaks' });
        kill(heldSkills); holders.pop();
        wait(1500);
      } else rec.note(personalArmed ? 'agent-skills tomada: sin PowerShell para abrir el archivo, no medido' : 'agent-skills tomada: lo personal no se armó (agent-skills no es carpeta real), no medido');
    } else rec.note('archivos tomados: no medido fuera de Windows (en posix un rename no se traba)');

    // 4. la mudanza
    const mig = run(clone, ['migrate', '--to-home', ...repoOption], 'migrate', 8000);
    const s2 = stateFile();
    rec.fact('after_migrate', {
      exit: mig.exit, kind: kindOf(), tree: s2 && s2.tree, version: s2 && s2.version ? s2.version.number : null,
      state_in_own: fs.existsSync(path.join(own, 'state', 'harness-state.json')), harness_dir: fs.existsSync(path.join(newTree, 'version.json')),
      links: { place: linkKind(placeLink), place_to_new: resolvesTo(placeLink, newTree), skills: linkKind(skillsLink), skills_to_new: resolvesTo(skillsLink, newTree), pipeline: linkKind(oldStateDir), pipeline_to_state: resolvesTo(oldStateDir, path.join(own, 'state')) },
      hooks: hookCmds().length, hooks_naming_clone: hookCmds().filter((c) => namesDir(c, clone)).length, hooks_naming_new: hookCmds().filter((c) => namesDir(c, newTree)).length,
      // qué hooks aparecieron o se fueron, por el NOMBRE del guion y contados (la mudanza re-apunta todos los comandos, así
      // que comparar el texto entero los daba todos como «idos» y «aparecidos»: #12494): si la cuenta cambia, que se sepa CUÁLES
      ...(() => {
        const name = (c) => (String(c).match(/([^\\/"' ]+\.(?:js|sh|ps1|cmd))/) || [null, String(c).slice(0, 60)])[1];
        const count = (list) => list.reduce((m, c) => m.set(name(c), (m.get(name(c)) || 0) + 1), new Map());
        const b = count(hooks0), a = count(hookCmds());
        const delta = (x, y) => [...new Set([...x.keys(), ...y.keys()])].filter((k) => (y.get(k) || 0) > (x.get(k) || 0)).map((k) => `${k}${(y.get(k) || 0) - (x.get(k) || 0) > 1 ? ` ×${(y.get(k) || 0) - (x.get(k) || 0)}` : ''}`);
        return { hooks_added: delta(b, a).slice(0, 10), hooks_removed: delta(a, b).slice(0, 10) };
      })(),
      journal_left: fs.existsSync(path.join(own, 'migrate.json')), clone_untouched: dirHash(clone) === cloneHash0,
    });
    const f = rec.step.facts.after_migrate;
    if (mig.exit !== 0 || f.kind !== 'release') {
      rec.finding('migrate:fails', 'migrate', `migrate --to-home salió ${mig.exit} (kind ${f.kind}): ${lastLines(`${mig.stdout}\n${mig.stderr}`, 3)}`, 'W8', { severity: 'breaks' });
      return { status: L.STATUS.measured, reason: null };
    }
    if (!f.state_in_own) rec.finding('migrate:state-not-moved', 'state', 'el estado no quedó en ~/.tycon/state', 'W8', { severity: 'breaks' });
    if (!f.harness_dir) rec.finding('migrate:harness-missing', 'tree', 'no hay ~/.tycon/harness/version.json', 'W8', { severity: 'breaks' });
    if (!f.links.place_to_new) rec.finding('migrate:place-link', 'links', `el lugar ${placeLink} no resuelve a ~/.tycon/harness (${f.links.place})`, 'W8', { severity: 'loses-control' });
    if (!f.links.skills_to_new) rec.finding('migrate:skills-link', 'links', `agent-skills no resuelve a ~/.tycon/harness (${f.links.skills}; en Windows, una unión)`, 'W8', { severity: 'loses-control' });
    if (!f.links.pipeline_to_state) rec.finding('migrate:pipeline-link', 'links', `.tycon-pipeline no resuelve a ~/.tycon/state (${f.links.pipeline})`, 'W8', { severity: 'loses-control' });
    if (f.hooks !== hooks0.length) rec.finding('migrate:hook-count-changed', 'hooks', `la cuenta de hooks cambió con la mudanza (${hooks0.length} → ${f.hooks}; aparecieron: ${(f.hooks_added || []).join(', ') || '—'}; se fueron: ${(f.hooks_removed || []).join(', ') || '—'})`, 'W8', { severity: 'loses-control' });
    if (f.hooks_naming_clone) rec.finding('migrate:hooks-name-clone', 'hooks', `${f.hooks_naming_clone} hook(s) siguen nombrando el clon`, 'W8', { severity: 'loses-control' });
    if (!f.hooks_naming_new) rec.finding('migrate:hooks-not-new-tree', 'hooks', 'ningún hook nombra ~/.tycon/harness', 'W8', { severity: 'loses-control' });
    if (f.journal_left) rec.finding('migrate:journal-left', 'migrate', 'quedó el diario ~/.tycon/migrate.json después de terminar', 'W8', { severity: 'noise' });
    if (!f.clone_untouched) rec.finding('migrate:clone-touched', 'clone', 'el clon de la persona cambió (archivos o .git) con la mudanza', 'W8', { severity: 'breaks' });
    // T43: lo personal activo como carpetas reales, y el arnés al lado como enlace (o unión) por entrada
    if (personalArmed) {
      const realEntry = (p) => { try { const st = fs.lstatSync(p); return !st.isSymbolicLink() && (st.isDirectory() || st.isFile()); } catch (_) { return false; } };
      const pf = {
        skills_real_dir: linkKind(skillsDir) === 'directory', agents_real_dir: linkKind(agentsDir) === 'directory',
        skill_active: realEntry(path.join(skillsDir, personal.skill)) && fs.existsSync(path.join(skillsDir, personal.skill, 'SKILL.md')),
        agent_active: realEntry(path.join(agentsDir, personal.agent)),
        harness_skill_linked: resolvesTo(path.join(skillsDir, 'tycon-pipeline'), path.join(newTree, 'skills', 'tycon-pipeline')),
        // los revisores del arnés al lado del agente personal: enlace, unión o —Windows sin modo desarrollador— enlace duro (un archivo con el mismo contenido)
        harness_agents_present: (() => { try { const names = fs.readdirSync(path.join(newTree, 'agents')).filter((n) => /\.md$/.test(n)); return names.length > 0 && names.every((n) => { const f = path.join(agentsDir, n); try { return fs.readFileSync(f, 'utf8') === fs.readFileSync(path.join(newTree, 'agents', n), 'utf8'); } catch (_) { return false; } }); } catch (_) { return false; } })(),
        aside_without_personal: (() => { try { const aside = fs.readdirSync(path.join(home, '.claude')).filter((n) => n.startsWith('agent-skills.before-migrate-')); return aside.length === 1 && !fs.existsSync(path.join(home, '.claude', aside[0], 'skills', personal.skill)); } catch (_) { return false; } })(),
        said: /conservadas 1 skills y 1 agente tuyos/.test(`${mig.stdout}\n${mig.stderr}`),
      };
      rec.fact('personal_after', pf);
      if (!pf.skills_real_dir || !pf.agents_real_dir) rec.finding('migrate:personal-dirs-not-real', 'personal', `~/.claude/skills (${linkKind(skillsDir)}) o ~/.claude/agents (${linkKind(agentsDir)}) no quedaron como carpetas reales (T43)`, 'W8', { severity: 'breaks' });
      if (!pf.skill_active || !pf.agent_active) rec.finding('migrate:personal-lost', 'personal', `lo personal no quedó activo: skill ${pf.skill_active} · agente ${pf.agent_active} (T43)`, 'W8', { severity: 'breaks' });
      if (!pf.harness_skill_linked) rec.finding('migrate:personal-harness-not-linked', 'personal', 'la skill del arnés (tycon-pipeline) no está al lado como enlace por entrada a ~/.tycon/harness (T43)', 'W8', { severity: 'loses-control' });
      if (!pf.harness_agents_present) rec.finding('migrate:personal-agents-harness-missing', 'personal', 'los revisores del arnés no están al lado del agente personal en ~/.claude/agents (ni enlace, ni unión, ni enlace duro con el mismo contenido) (T43)', 'W8', { severity: 'loses-control' });
      if (!pf.aside_without_personal) rec.finding('migrate:personal-duplicated', 'personal', 'lo personal quedó también en la carpeta apartada (copiado, no movido) o la apartada no es una (T43)', 'W8', { severity: 'noise' });
      if (!pf.said) rec.finding('migrate:personal-not-said', 'personal', 'la salida de migrate no dice «conservadas 1 skills y 1 agente tuyos» (T43)', 'W8', { severity: 'noise' });
    }

    // T48 (tanda G · AC 41): después de mudar, el lector del árbol NUEVO (sin perfil) da las mismas integraciones, el mismo
    // paquete por defecto y la misma política que el clon (con perfil), con origen «maquina»; y la salida lo contó
    {
      const ex = L.run(process.execPath, [path.join(newTree, 'scripts', 'lib', 'tycon-config.js'), 'explain', '--json'], { env, timeoutMs: 60000 });
      let v = null, o = null;
      try { const d = JSON.parse(ex.stdout); v = d.valores; o = d.origenes; } catch (_) { v = null; }
      const pf = v ? {
        engram: v.integraciones.engram, nightly: v.integraciones.nightly, codex: v.integraciones.codex, ado: v.ado.org,
        channel: v.update.channel, apply: v.update.apply, packs: v.packs.default, profile: v.install.profile,
        origin_engram: o['integraciones.engram'], origin_packs: o['packs.default'],
        // con la capa del equipo (TZ14) el perfil NO se funde: la salida dice que viaja en la capa y los valores llegan con origen «perfil»
        said: /perfil del equipo: viaja en la capa del equipo/.test(`${mig.stdout}\n${mig.stderr}`),
      } : { explain_exit: ex.exit, err: lastLines(`${ex.stdout}\n${ex.stderr}`, 2) };
      rec.fact('profile_after', pf);
      if (!v) rec.finding('migrate:profile-explain-fails', 'profile', `tycon-config.js explain --json del árbol nuevo no se pudo leer (exit ${ex.exit}) (T48)`, 'W8', { severity: 'loses-control' });
      else {
        // codex no se compara: el ensayo corre con TYCON_CODEX=0 en el entorno, y la variable le gana al perfil (como debe)
        if (!(pf.engram === true && pf.nightly === true && pf.ado === 'https://dev.azure.com/acme' && pf.channel === 'latest' && pf.apply === 'auto' && pf.packs === 'all' && pf.profile === 'full')) rec.finding('migrate:profile-lost', 'profile', `después de mudar la máquina no lee lo que decía el perfil del equipo (T48/TZ14): ${JSON.stringify(pf).slice(0, 300)}`, 'W8', { severity: 'loses-control' });
        else if (pf.origin_engram !== 'perfil' || pf.origin_packs !== 'perfil') rec.finding('migrate:profile-origin', 'profile', `con la capa del equipo los valores tienen que venir del perfil, no fundidos como de la máquina (${pf.origin_engram}, ${pf.origin_packs}) (TZ14)`, 'W8', { severity: 'loses-control' });
        if (!pf.said) rec.finding('migrate:profile-not-said', 'profile', 'la salida de migrate no dice que el perfil del equipo viaja en la capa (TZ14)', 'W8', { severity: 'noise' });
      }
      // la capa misma: los archivos en el árbol nuevo y el estado con team (host azure, la URL, el commit); el PAT jamás en la salida
      const teamManifest = (() => { try { return readJson(path.join(newTree, '.tycon-team.json')); } catch (_) { return null; } })();
      const teamState = s2 && s2.team ? s2.team : null;
      rec.fact('team_after', { manifest: Boolean(teamManifest), files: teamManifest ? teamManifest.files.length : 0, profile_file: fs.existsSync(path.join(newTree, 'perfil-equipo.json')), mailbox_key: fs.existsSync(path.join(newTree, 'scripts', 'metrics', 'corridas-buzon.json')), state: teamState ? { repo: teamState.repo, host: teamState.host, commit: (teamState.commit || '').slice(0, 7), files: teamState.files } : null, pat_in_output: /pat-lab/.test(`${mig.stdout}\n${mig.stderr}`) });
      const ta = rec.step.facts.team_after;
      if (!ta.manifest || !ta.profile_file || !ta.mailbox_key) rec.finding('migrate:azure-layer-missing', 'team', `la capa del equipo no quedó entera en ~/.tycon/harness (manifiesto ${ta.manifest}, perfil ${ta.profile_file}, llave ${ta.mailbox_key}) (TZ14)`, 'W8', { severity: 'breaks' });
      if (!ta.state || ta.state.host !== 'azure' || ta.state.repo !== TEAM_URL) rec.finding('migrate:azure-state-team', 'team', `el estado mudado no trae team con host azure y la URL (${JSON.stringify(ta.state)}) (TZ14)`, 'W8', { severity: 'loses-control' });
      if (ta.pat_in_output) rec.finding('migrate:azure-pat-printed', 'team', 'el PAT de Azure apareció en la salida de migrate (TZ14)', 'W8', { severity: 'breaks' });
    }

    // 5. el arranque y el diagnóstico de la máquina mudada (con el árbol nuevo, como lo haría la línea de arranque)
    const st = run(newTree, ['startup'], 'startup_after');
    if (st.exit !== 0 || kindOf() !== 'release') rec.finding('migrate:startup-after', 'startup', `startup tras la mudanza salió ${st.exit} (kind ${kindOf()})`, 'W8', { severity: 'breaks' });
    const doc = run(newTree, ['doctor', '--json'], 'doctor', 400000);
    let fails = null;
    try { fails = JSON.parse(doc.stdout).fail; } catch (_) { fails = null; }
    rec.fact('doctor_fail', fails);
    if (doc.exit !== 0 || !Array.isArray(fails) || fails.length) rec.finding('migrate:doctor-red', 'doctor', `doctor --json salió ${doc.exit}: ${JSON.stringify(fails).slice(0, 400)}`, 'W8', { severity: 'loses-control' });
    return { status: L.STATUS.measured, reason: null };
  } finally { stopAll(); }
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`migrate-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`migrate-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, allowTemp: Boolean(args['allow-temp']), rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  say(`migrate: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, measure };
