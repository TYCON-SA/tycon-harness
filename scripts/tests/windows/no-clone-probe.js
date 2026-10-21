#!/usr/bin/env node
'use strict';
/**
 * no-clone-probe.js — la instalación SIN git en un Windows: una versión bajada como archivos
 * (escenario `no-clone` del ensayo de Windows; T14 en Windows).
 *
 * POR QUÉ EXISTE. La instalación sin clon instala el arnés bajando el comprimido de un commit publicado y cambiando una carpeta con
 * diario; nada de eso corrió en un Windows: ahí el `rename` de una carpeta con un archivo TOMADO falla, los enlaces de
 * carpeta piden privilegios (se usan uniones), y el bit de ejecutable no existe en el disco. Este paso lo ensaya en el
 * agente Windows con el «GitHub» de juguete (scripts/tests/fixtures/toy-release-server.js) sirviendo el remoto del
 * laboratorio, y lo dice.
 *
 * QUÉ HACE, en una carpeta de usuario de laboratorio:
 *   1. Publica una versión numerada sobre `main` del remoto del arnés y la instala: `harness.js install --version latest`.
 *   2. Publica otra y actualiza (`update --yes`): queda `previous/`.
 *   3. El archivo tomado (T14): con un archivo de `previous/` abierto por otro proceso, una tercera actualización tiene
 *      que ESPERAR (sale 2, dice «espera», no es `failed`) y aplicarse cuando se suelta; con un archivo de `trash/`
 *      tomado, el arranque siguiente no la borra, no frena nada y lo dice; suelto, la borra.
 *   4. `rollback`, `doctor --json` y `uninstall --yes`.
 *   6. (T1 y T16) Contra el GitHub REAL, sin permiso, sólo en el agente del ensayo de Windows (`TF_BUILD`): cuánto gasta
 *      del tope anónimo de la API cada ruta pública (`info/refs`, el raw por commit, codeload) y un 304 sin permiso; y, con
 *      el registro de pedidos (`TYCON_HTTP_TRACE`), cuántas consultas a `api.github.com` hacen la instalación (1: la
 *      verificación), mirar (0) y mirar con la API apuntada a un puerto cerrado (0, y anda); en Windows, que
 *      `get-harness.ps1` baja con la API cerrada. Lo que mide este paso depende de la red: la conexión del agente se
 *      comparte, así que un tope agotado por otros se anota, no se cuenta como falla del arnés.
 *   5. (T14) Lo mismo CON la capa del equipo, en otra carpeta de usuario: el repo del equipo de juguete
 *      servido por el Azure DevOps de juguete (`install --team <URL>` con el PAT de juguete guardado por `config set
 *      azure.token`; un commit sólo del equipo que llega en el arranque fuera de la ventana —en Windows, también con
 *      perfil-equipo.json tomado por otro proceso: entra entero o no cambia nada—; una versión pública nueva; `rollback`;
 *      `doctor --json`; `uninstall`) y por un GitHub de juguete con los dos repos (`install --team <org>/<repo>`).
 * Cada diferencia con lo que pasa en Mac y Linux sale como hallazgo con su gravedad («rompe el trabajo del dev» ·
 * «pierde un control» · «ruido»).
 *
 * Fuera de Windows corre igual, en «modo de laboratorio» (los archivos tomados no traban un rename en posix: esa parte
 * queda anotada como no medida).
 *
 * CÓMO FALLA. Una instalación que no anda es un HECHO del reporte. El paso sale «error» sólo si no pudo ensayar: sin el
 * remoto del laboratorio, sin git para el servidor de juguete, sin node.
 *
 * Uso: node scripts/tests/windows/no-clone-probe.js --lab <laboratorio> --out <carpeta del reporte> [--allow-temp]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lab.js');
const T = require('./team-lab.js');
const PLACE = require('../../setup/harness/place.js');

const NAME = 'no-clone';
const HERE = __dirname;
const SERVER = path.join(HERE, '..', 'fixtures', 'toy-release-server.js');
const CMD_TIMEOUT_MS = 10 * 60 * 1000;
const say = (s) => process.stdout.write(`${s}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const lastLines = (s, n = 3) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');
const isWin = L.isWin();

// con identidad propia: el agente de Windows no tiene user.name/user.email y `git commit` sale 128
// …y sin los hooks de git de la carpeta de usuario del laboratorio: `install` y la mudanza ponen ahí la
// carpeta global de hooks del arnés, y su pre-push (el freno antes de publicar) frenaría las publicaciones de juguete del
// propio ensayo, que van a un remoto de laboratorio declarado público. Lo que se mide es el arnés, no esto
const LAB_NO_HOOKS = path.join(require('os').tmpdir(), 'tycon-lab-no-git-hooks');
function git(dir, args, env) { return L.run('git', ['-C', dir, '-c', 'user.name=Lab', '-c', 'user.email=lab@example.com', '-c', `core.hooksPath=${LAB_NO_HOOKS}`, ...args], { env, timeoutMs: 5 * 60 * 1000 }); }

/** Una versión numerada publicada sobre `main` del remoto, con la copia «autor»: devuelve el commit, o null. */
function publish(author, number, env, extra = null) {
  fs.writeFileSync(path.join(author, 'version.json'), `{ "version": "${number}", "source": { "harness": "${'1'.repeat(40)}", "agent_skills": "${'2'.repeat(40)}" } }\n`);
  if (extra) { fs.mkdirSync(path.dirname(path.join(author, extra.rel)), { recursive: true }); fs.writeFileSync(path.join(author, extra.rel), extra.text); }
  else fs.appendFileSync(path.join(author, 'CHANGES'), `${number}\n`);
  for (const args of [['add', '-A'], ['commit', '-q', '-m', `versión ${number}`], ['push', '-q', 'origin', 'HEAD:main']]) {
    const r = git(author, args, env);
    if (r.exit !== 0) return { ok: false, reason: `git ${args[0]} salió ${r.exit}: ${L.firstLine(r.stderr)}` };
  }
  const h = git(author, ['rev-parse', 'HEAD'], env);
  return { ok: true, commit: L.firstLine(h.stdout) };
}

/** Un proceso que deja un archivo ABIERTO sin compartir (Windows) hasta que se lo mate. En posix abre y espera igual. */
// `share` (FileShare de .NET): 'None' traba hasta leerlo; 'Read' deja leer y traba reemplazarlo o borrarlo,
// que es lo que hace un editor o un antivirus con el archivo abierto (con 'None' el arranque no puede leer el perfil,
// no mira la red y el refresco de la capa ni corre: la sonda mediría otra cosa)
function holdOpen(file, env, share = 'None') {
  if (isWin) {
    const ps = L.scanPath('pwsh', { env })[0] || L.scanPath('powershell', { env })[0];
    if (!ps) return null;
    const script = `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', '${share === 'Read' ? 'Read' : 'None'}'); Start-Sleep -Seconds 600`;
    return spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env, stdio: 'ignore', windowsHide: true });
  }
  return spawn(process.execPath, ['-e', `const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');setTimeout(()=>{},600000)`, file], { env, stdio: 'ignore' });
}
const kill = (p) => { if (p) { try { p.kill(); } catch (_) { /* ya */ } } };
/** La dirección que dejó un servidor de juguete en su archivo de puertos (`<CLAVE>=<url>`), o null si no está. */
function portOf(file, key) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const m = new RegExp(`^${key}=(.+)$`, 'm').exec(text);
  return m ? m[1].trim() : null;
}
/**
 * Saca al arranque de la ventana de red (la última mirada, nunca): así el arranque siguiente mira. Si el estado no se pudo
 * reescribir, queda una nota: el hallazgo que siga («no se refrescó») tendría otra causa que la que dice.
 */
function outOfWindowAt(home, rec) {
  const f = path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json');
  try { const s = readJson(f); s.last_fetch = null; s.last_fetch_failed = null; fs.writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`); return true; }
  catch (e) { rec.note(`no pude sacar el arranque de la ventana de red (${f}: ${e.code || e.message}): un «no se refrescó» que siga puede ser por esto`); return false; }
}
const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* nada */ } };

function measure({ lab, out, platform = process.platform, baseEnv = process.env, allowTemp = false, rec }) {
  const state = T.readState(lab);
  if (!state || !state.remotes || !state.remotes.harness) return { status: L.STATUS.error, reason: `${lab} no trae el estado del ensayo (rehearsal-state.json): corré «rehearse.js init»` };
  const bare = state.remotes.harness.dir;
  const base = path.join(lab, 'no-clone');
  const home = path.join(base, 'users', 'lab-no-clone');
  const author = path.join(base, 'author');
  const program = path.join(base, 'program');
  const serverDir = path.join(base, 'server');
  for (const d of [home, author, serverDir, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return { status: L.STATUS.error, reason: problem };
  const env0 = T.rehearsalEnv(home, { base: baseEnv, platform });
  rec.fact('home', home);
  rec.fact('lab_mode', !isWin);
  // 0. el sondeo T1: ¿se cambia una unión con la versión vieja tomada? Va primero y no depende de nada
  require('./links-spike.js').measureLinks({ base, env: env0, rec });
  // 0b. la medición E1: ¿un hook .js con la ruta del Node del arnés SIN comillas corre por los cinco
  // lanzadores? Tampoco depende de nada
  require('./node-form-spike.js').measureNodeForm({ base, env: env0, rec });

  // el remoto en el commit actual, la copia «autor» y la copia del programa (lo que una persona tendría bajado)
  const point = T.pointRemotes(state, 'target', env0);
  if (point) return { status: L.STATUS.error, reason: point };
  for (const [dir, label] of [[author, 'author'], [program, 'program']]) {
    const c = git(path.dirname(dir), ['clone', '--quiet', bare, dir], env0);
    if (c.exit !== 0) return { status: L.STATUS.error, reason: `no pude clonar el remoto del arnés (${label}): ${L.firstLine(c.stderr)}` };
  }
  // de qué repo «baja»: el que declara la copia (public-repos.json en el interno, public-remotes.json en la pública)
  let org = 'TYCON-LAB', name = 'arnes-lab', repoOption = ['--repo', 'TYCON-LAB/arnes-lab'];
  try { const pr = readJson(path.join(program, 'scripts', 'publishing', 'public-repos.json')); if (pr.org && pr.repo) { org = pr.org; name = pr.repo; repoOption = []; } } catch (_) { /* --repo lo dice */ }
  try { const rm = readJson(path.join(program, 'scripts', 'setup', 'public-remotes.json')); const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec((rm.remotes || [])[0] || ''); if (m) { org = m[1]; name = m[2]; repoOption = []; } } catch (_) { /* no es la copia pública */ }

  // el servidor de juguete sobre el remoto, con el git de la máquina por su ruta
  const gitBin = L.scanPath('git', { env: env0 })[0] || 'git';
  const control = path.join(serverDir, 'control.json');
  const log = path.join(serverDir, 'requests.log');
  const ports = path.join(serverDir, 'ports.env');
  fs.writeFileSync(control, '{ "auth": "none" }\n');
  const server = spawn(process.execPath, [SERVER, '--repo', bare, '--org', org, '--name', name, '--git', gitBin, '--control', control, '--log', log, '--port-file', ports], { env: env0, stdio: 'ignore', windowsHide: true });
  const lockers = [];
  const stopAll = () => { kill(server); for (const p of lockers) kill(p); };
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ports); i++) wait(100);
    if (!fs.existsSync(ports)) return { status: L.STATUS.error, reason: 'el servidor de versiones de juguete no arrancó' };
    const api = /^API=(.+)$/m.exec(fs.readFileSync(ports, 'utf8'))[1].trim();
    rec.fact('toy_server', { api, org, name });
    const profile = path.join(base, 'lab-profile.json');
    fs.writeFileSync(profile, '{ "install": { "profile": "full" } }\n');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');
    const env = T.rehearsalEnv(home, { base: baseEnv, platform, extra: {
      // TYCON_CLAUDE=1: `install` enchufa las herramientas que detecta y el agente no tiene ninguna
      // instalada; este escenario mide la máquina con Claude Code (la de sólo Codex es el escenario `codex-only`)
      TYCON_RELEASE_API: api, TYCON_UPDATE_APPLY: 'auto', TYCON_PROFILE: profile, TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0',
      TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
      CODEX_HOME: path.join(home, '.codex'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'), TYCON_UPDATE_NETWORK_BUDGET_S: '60',
    } });
    const own = path.join(home, '.tycon');
    const harnessJs = (tree) => path.join(tree, 'scripts', 'setup', 'harness.js');
    // `cap`: cuánto de la salida se guarda. `doctor --json` se LEE entero (con el tope de 4000 su JSON llega cortado
    // en cuanto el diagnóstico suma un renglón, y «no pude leerlo» sale como hallazgo)
    const run = (tree, args, label, cap = 4000) => {
      const r = L.run(process.execPath, [harnessJs(tree), ...args], { env, timeoutMs: CMD_TIMEOUT_MS, cap });
      rec.fact(label, { exit: r.exit, error: r.error, out: lastLines(`${r.stdout}\n${r.stderr}`, 4), ms: r.ms });
      return r;
    };
    const stateFile = () => { try { return readJson(path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json')); } catch (_) { return null; } };
    const versionOf = () => { const s = stateFile(); return s && s.version ? s.version.number : null; };
    const linkKind = (p) => { try { const st = fs.lstatSync(p); return st.isSymbolicLink() ? (isWin ? 'symlink-or-junction' : 'symlink') : (st.isDirectory() ? 'directory' : 'file'); } catch (_) { return 'missing'; } };
    const hookCount = () => { try { return Object.values(readJson(path.join(home, '.claude', 'settings.json')).hooks || {}).flat().flatMap((m) => m.hooks || []).length; } catch (_) { return null; } };

    // 1. instalar
    const v1 = publish(author, '2030.02.01.1', env0);
    if (!v1.ok) return { status: L.STATUS.error, reason: `no pude publicar la primera versión: ${v1.reason}` };
    const inst = run(program, ['install', '--version', 'latest', '--yes', ...repoOption], 'install');
    const s1 = stateFile();
    const placeLink = path.join(home, '.claude', PLACE.PLACE_NAME);
    rec.fact('after_install', { version: versionOf(), kind: s1 && s1.sources && s1.sources[0] ? s1.sources[0].kind : null, harness_dir: fs.existsSync(path.join(own, 'harness', 'version.json')), links: { place: linkKind(placeLink), skills: linkKind(path.join(home, '.claude', 'agent-skills')) }, hooks: hookCount() });
    if (inst.exit !== 0 || versionOf() !== '2030.02.01.1') {
      rec.finding('no-clone:install-fails', 'install', `install --version latest salió ${inst.exit}: ${lastLines(`${inst.stdout}\n${inst.stderr}`, 2)}`, 'W8', { severity: 'breaks' });
      return { status: L.STATUS.measured, reason: null };
    }
    if (rec.step.facts.after_install.links.place === 'missing') rec.finding('no-clone:place-link-missing', 'links', `el lugar ${placeLink} no quedó enlazado a ~/.tycon/harness`, 'W8', { severity: 'loses-control' });
    if (rec.step.facts.after_install.links.skills === 'missing') rec.finding('no-clone:skills-link-missing', 'links', 'agent-skills no quedó enlazado a ~/.tycon/harness (en Windows, una unión)', 'W8', { severity: 'loses-control' });
    // el freno antes de publicar, puesto: una máquina limpia, sin carpeta global de hooks de git, queda con
    // core.hooksPath apuntando a la carpeta del aplicador y el pre-push del arnés adentro. Sin esto la instalación sólo avisaría
    // y nada la pondría: una máquina instalada sin el paso a mano de la página quedaría sin el freno, sin que nadie lo notara
    {
      const hp = L.run('git', ['config', '--global', '--get', 'core.hooksPath'], { env, timeoutMs: 60000 });
      const want = path.join(home, '.git-hooks');
      const value = String(hp.stdout || '').trim();
      let prePush = false;
      try { prePush = fs.readFileSync(path.join(want, 'pre-push'), 'utf8').includes('git-pre-push-global.sh'); } catch (_) { prePush = false; }
      const same = Boolean(value) && L.samePath(value.replace(/\//g, path.sep), want);
      rec.fact('hooks_path', { exit: hp.exit, value: value || null, expected: want, same, pre_push: prePush });
      if (!same || !prePush) rec.finding('no-clone:pre-push-not-active', 'install', `después de install, core.hooksPath global es «${value || 'nada'}» (se esperaba ${want}) y el pre-push del arnés ${prePush ? 'está' : 'NO está'} ahí: el freno antes de publicar no corre`, 'W8', { severity: 'loses-control' });
    }
    const hooks0 = hookCount();
    const tree = path.join(own, 'harness');

    // 1b. el permiso guardado sólo para el usuario: `config set github.token` por stdin; en Windows, la ACL de
    // config.json (icacls) no puede dar acceso a nadie más que la cuenta
    const token = `lab-token-${Date.now()}`;
    const cs = L.run(process.execPath, [harnessJs(tree), 'config', 'set', 'github.token'], { env, input: token, timeoutMs: 60000, cap: 1000 });
    const configFile = path.join(own, 'config.json');
    const acl = isWin ? L.run('icacls', [configFile], { env, timeoutMs: 30000, cap: 2000 }) : null;
    const aclLines = acl && acl.exit === 0 ? acl.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !/^Successfully/i.test(l)).slice(1) : [];
    const others = aclLines.filter((l) => /BUILTIN\\Users|Everyone|Authenticated Users|Todos|Usuarios/i.test(l));
    rec.fact('config_token', { exit: cs.exit, file_exists: fs.existsSync(configFile), token_in_output: `${cs.stdout}${cs.stderr}`.includes(token), acl: acl ? { exit: acl.exit, lines: aclLines } : null });
    if (cs.exit !== 0) rec.finding('no-clone:config-set-fails', 'config', `config set github.token salió ${cs.exit}: ${lastLines(`${cs.stdout}\n${cs.stderr}`, 2)}`, 'W8', { severity: 'loses-control' });
    if (`${cs.stdout}${cs.stderr}`.includes(token)) rec.finding('no-clone:token-printed', 'config', 'config set imprimió el permiso', 'W8', { severity: 'breaks' });
    if (isWin && acl && acl.exit === 0 && others.length) rec.finding('no-clone:config-acl-open', 'config', `config.json queda legible por otros: ${others.join(' | ')}`, 'W8', { severity: 'loses-control' });
    if (isWin && (!acl || acl.exit !== 0)) rec.note(`icacls no pudo leer la ACL de config.json (${acl ? acl.exit : 'sin icacls'}): la restricción por usuario queda sin medir`);

    // 2. actualizar: queda previous/
    const v2 = publish(author, '2030.02.01.2', env0);
    if (!v2.ok) return { status: L.STATUS.error, reason: v2.reason };
    const up2 = run(tree, ['update', '--yes'], 'update_2');
    rec.fact('after_update_2', { version: versionOf(), previous: fs.existsSync(path.join(own, 'previous', 'version.json')), journal: fs.existsSync(path.join(own, 'swap.json')) });
    if (up2.exit !== 0 || versionOf() !== '2030.02.01.2') rec.finding('no-clone:update-fails', 'update', `update --yes salió ${up2.exit}: ${lastLines(`${up2.stdout}\n${up2.stderr}`, 2)}`, 'W8', { severity: 'breaks' });

    // 3. (T16) en Windows la versión bajada vive en la forma con ENLACES: la activa tomada no frena nada
    if (isWin) {
      // (T14) las carpetas de skills y agentes de Claude Code: reales al instalar, y la forma vieja convertida
      const rf = measureRealFolders({ home, own, run, rec });
      measureLinkLayout({ own, home, author, env0, env, run, versionOf, stateFile, rec, lockers, harnessJs });
      if (rf) {
        // después de las actualizaciones y vueltas atrás de arriba, lo propio sigue en la carpeta real
        const still = rf.every((f) => fs.existsSync(f));
        rec.fact('real_folders_after_updates', { kept: still });
        if (!still) rec.finding('no-clone:real-folders-own-lost-on-update', 'real-folders', `lo propio de ~/.claude no sobrevivió a las actualizaciones: ${rf.filter((f) => !fs.existsSync(f)).join(', ')}`, 'W8', { severity: 'breaks' });
      }
      // la parte de previous/ tomada (la actualización espera) no aplica en la forma con enlaces
    } else {
    // 3. el archivo tomado (T14): en previous/ durante un cambio → la actualización espera; en trash/ → la limpieza espera
    const v3 = publish(author, '2030.02.01.3', env0);
    if (!v3.ok) return { status: L.STATUS.error, reason: v3.reason };
    const held = holdOpen(path.join(own, 'previous', 'version.json'), env0);
    if (held) lockers.push(held);
    wait(1500);
    const up3 = run(tree, ['update', '--yes'], 'update_3_with_previous_locked');
    const waited = /espera/.test(`${up3.stdout}\n${up3.stderr}`);
    rec.fact('locked_previous', { measured: isWin && Boolean(held), exit: up3.exit, waited, version: versionOf(), failed: (stateFile() || {}).failed || null });
    if (isWin && held) {
      if (!(up3.exit === 2 && waited)) rec.finding('no-clone:locked-previous-not-waiting', 'update', `con un archivo de previous/ tomado la actualización no esperó: salió ${up3.exit} (${lastLines(`${up3.stdout}\n${up3.stderr}`, 2)})`, 'W8', { severity: 'breaks' });
      if ((stateFile() || {}).failed) rec.finding('no-clone:locked-previous-marked-failed', 'update', 'con un archivo tomado la versión quedó marcada failed: no se reintenta sola', 'W8', { severity: 'loses-control' });
    } else rec.note('archivo tomado en previous/: no medido fuera de Windows (en posix un rename no se traba)');
    kill(held);
    wait(1000);
    const up3b = run(tree, ['update', '--yes'], 'update_3_after_release');
    if (up3b.exit !== 0 || versionOf() !== '2030.02.01.3') rec.finding('no-clone:update-after-release-fails', 'update', `soltado el archivo, update salió ${up3b.exit} (versión ${versionOf()})`, 'W8', { severity: 'breaks' });
    const trash = path.join(own, 'trash');
    const trashed = fs.existsSync(trash) ? fs.readdirSync(trash) : [];
    rec.fact('trash_after_update_3', trashed);
    if (trashed.length) {
      const inside = path.join(trash, trashed[0], 'version.json');
      const held2 = fs.existsSync(inside) ? holdOpen(inside, env0) : null;
      if (held2) lockers.push(held2);
      wait(1500);
      const st1 = run(tree, ['startup'], 'startup_with_trash_locked');
      const still = fs.existsSync(path.join(trash, trashed[0]));
      rec.fact('locked_trash', { measured: isWin && Boolean(held2), exit: st1.exit, still_there: still });
      if (isWin && held2) {
        if (st1.exit !== 0) rec.finding('no-clone:startup-fails-with-locked-trash', 'startup', `startup salió ${st1.exit} con un archivo de trash/ tomado: tenía que salir 0 y dejarlo para el próximo arranque`, 'W8', { severity: 'breaks' });
        if (!still) rec.note('trash/ con un archivo tomado se pudo borrar igual (Windows lo dejó)');
      }
      kill(held2);
      wait(1000);
      const st2 = run(tree, ['startup'], 'startup_after_release');
      rec.fact('trash_after_release', { exit: st2.exit, remaining: fs.existsSync(trash) ? fs.readdirSync(trash) : [] });
      if (fs.existsSync(path.join(trash, trashed[0]))) rec.finding('no-clone:trash-not-cleaned', 'startup', 'soltado el archivo, el arranque siguiente no borró lo apartado en trash/', 'W8', { severity: 'noise' });
    }
    }
    if (hookCount() !== hooks0) rec.finding('no-clone:hook-count-changed', 'hooks', `la cuenta de hooks cambió entre versiones (${hooks0} → ${hookCount()})`, 'W8', { severity: 'loses-control' });

    // 4. rollback (fuera de Windows: en Windows lo midió el paso 3 con la activa tomada), doctor, uninstall
    if (!isWin) {
      const rb = run(tree, ['rollback'], 'rollback');
      rec.fact('after_rollback', { version: versionOf() });
      if (rb.exit !== 0 || versionOf() !== '2030.02.01.2') rec.finding('no-clone:rollback-fails', 'rollback', `rollback salió ${rb.exit} (versión ${versionOf()})`, 'W8', { severity: 'breaks' });
    }
    const doc = run(tree, ['doctor', '--json'], 'doctor', 400000);
    let fails = null;
    let hn = null;
    try { const dj = JSON.parse(doc.stdout); fails = dj.fail; hn = dj.harness_node || null; } catch (_) { fails = null; }
    rec.fact('doctor_fail', fails);
    // el Node propio del arnés: con la versión bajada instalada, los hooks corren con él, salvo que
    // esté apagado o que la carpeta no entre en la forma de Windows (con su motivo en doctor)
    rec.fact('harness_node', hn);
    if (hn && hn.own !== true && hn.switch !== 'off' && !/no se puede escribir en un comando/.test(String(hn.reason || ''))) rec.finding('no-clone:harness-node-not-own', 'harness-node', `el arnés instalado no corre con su Node propio (${hn.reason || 'sin motivo'}): los hooks siguen con el Node del PATH`, 'W8', { severity: 'loses-control' });
    if (doc.exit !== 0 || !Array.isArray(fails) || fails.length) rec.finding('no-clone:doctor-red', 'doctor', `doctor --json salió ${doc.exit}: ${JSON.stringify(fails).slice(0, 400)}`, 'W8', { severity: 'loses-control' });
    const un = run(tree, ['uninstall', '--yes'], 'uninstall');
    rec.fact('after_uninstall', { harness_dir: fs.existsSync(path.join(own, 'harness')), place_link: linkKind(placeLink), config_kept: fs.existsSync(path.join(own, 'config.json')) });
    if (un.exit !== 0 || fs.existsSync(path.join(own, 'harness'))) rec.finding('no-clone:uninstall-fails', 'uninstall', `uninstall --yes salió ${un.exit}; ~/.tycon/harness ${fs.existsSync(path.join(own, 'harness')) ? 'sigue' : 'no está'}`, 'W8', { severity: 'loses-control' });
    try { rec.fact('server_requests', fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length); } catch (_) { /* sin registro */ }

    // 5. con la capa del equipo (T14, su mitad no-clone)
    const team = measureTeam({ lab, base, author, program, bare, env0, baseEnv, platform, allowTemp, rec, api, org, name, repoOption, gitBin, serverDir, lockers });
    if (team) rec.note(team);
    // 6. la capa del equipo con Claude Code y Codex (T28)
    const teamA2 = measureTeamA2({ lab, base, program, env0, baseEnv, platform, allowTemp, rec, api, repoOption, gitBin, serverDir, lockers });
    if (teamA2) rec.note(teamA2);
    // 7. la skill de la lista fija con sus datos fuera de su carpeta (T37)
    const skillData = measureTeamSkillData({ lab, base, author, program, env0, baseEnv, platform, allowTemp, rec, api, repoOption, gitBin, serverDir, lockers });
    if (skillData) rec.note(skillData);
    // 8. contra el GitHub real, sin permiso (T1 y T16)
    const real = measureRealGithub({ base, program, baseEnv, platform, rec });
    if (real) rec.note(real);
    return { status: L.STATUS.measured, reason: null };
  } finally { stopAll(); }
}

/**
 * Las carpetas de skills y agentes de Claude Code (T14): después de instalar son carpetas REALES
 * con un enlace por entrada (uniones para las skills; enlace de archivo o enlace duro para los agentes). Después se arma la
 * forma vieja —`~/.claude/skills` y `agents` uniones a la carpeta entera del arnés— con una skill propia, un agente propio y
 * `synced/` adentro del arnés, y el arranque (el aplicador de PowerShell de verdad) la convierte: lo propio queda en la
 * carpeta real y el arnés ya no lo tiene. Devuelve las rutas de lo propio, para mirar que sobreviva a las actualizaciones
 * que siguen; o null si no se pudo armar. Nunca tira.
 */
function measureRealFolders({ home, own, run, rec }) {
  const claude = path.join(home, '.claude');
  const harness = path.join(own, 'harness');
  const isLinkP = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };
  const isReal = (p) => { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch (_) { return false; } };
  const ls = (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } };
  const sides = ['skills', 'agents'];
  rec.fact('real_folders_after_install', Object.fromEntries(sides.map((s) => [s, { real: isReal(path.join(claude, s)), entries: ls(path.join(claude, s)).length }])));
  for (const s of sides) if (!isReal(path.join(claude, s))) rec.finding(`no-clone:real-folders-${s}-not-real`, 'real-folders', `después de instalar, ${path.join(claude, s)} no es una carpeta real`, 'W8', { severity: 'loses-control' });
  // la forma vieja: se quitan las carpetas (sólo sus enlaces, nunca a través de ellos) y se ponen uniones a la carpeta entera
  try {
    for (const s of sides) {
      const d = path.join(claude, s);
      for (const n of ls(d)) { const p = path.join(d, n); if (isLinkP(p)) { try { fs.unlinkSync(p); } catch (_) { fs.rmdirSync(p); } } else fs.rmSync(p, { recursive: true, force: true }); }
      fs.rmdirSync(d);
      fs.symlinkSync(path.join(harness, s), d, 'junction');
    }
    fs.mkdirSync(path.join(harness, 'skills', 'mia'), { recursive: true });
    fs.writeFileSync(path.join(harness, 'skills', 'mia', 'SKILL.md'), 'mia\n');
    fs.mkdirSync(path.join(harness, 'skills', 'synced', 'org_cuenta', 'de-la-cuenta'), { recursive: true });
    fs.writeFileSync(path.join(harness, 'skills', 'synced', 'org_cuenta', 'de-la-cuenta', 'SKILL.md'), 'cuenta\n');
    fs.writeFileSync(path.join(harness, 'agents', 'mio.md'), 'mio\n');
  } catch (e) { rec.note(`carpetas reales: no pude armar la forma vieja (${e.code || e.message}): la conversión queda sin medir`); return null; }
  const st = run(harness, ['startup'], 'real_folders_convert');
  const own1 = path.join(claude, 'skills', 'mia', 'SKILL.md'), own2 = path.join(claude, 'agents', 'mio.md'), syn = path.join(claude, 'skills', 'synced', 'org_cuenta', 'de-la-cuenta', 'SKILL.md');
  const fact = {
    exit: st.exit,
    skills_real: isReal(path.join(claude, 'skills')), agents_real: isReal(path.join(claude, 'agents')),
    own_skill: fs.existsSync(own1), own_agent: fs.existsSync(own2), synced: fs.existsSync(syn),
    harness_clean: !fs.existsSync(path.join(harness, 'skills', 'mia')) && !fs.existsSync(path.join(harness, 'agents', 'mio.md')),
    harness_intact: fs.existsSync(path.join(harness, 'scripts', 'setup', 'harness.js')),
    pipeline_linked: fs.existsSync(path.join(claude, 'skills', 'tycon-pipeline', 'SKILL.md')),
  };
  rec.fact('real_folders_convert', fact);
  if (!fact.harness_intact) rec.finding('no-clone:real-folders-deleted-through-link', 'real-folders', 'la conversión borró algo del arnés a través de la unión', 'W8', { severity: 'breaks' });
  if (!fact.skills_real || !fact.agents_real) rec.finding('no-clone:real-folders-not-converted', 'real-folders', `el arranque no convirtió la forma vieja: ${JSON.stringify(fact)}`, 'W8', { severity: 'loses-control' });
  if (!fact.own_skill || !fact.own_agent || !fact.synced) rec.finding('no-clone:real-folders-own-lost', 'real-folders', `la conversión perdió lo propio: ${JSON.stringify(fact)}`, 'W8', { severity: 'breaks' });
  if (!fact.pipeline_linked) rec.finding('no-clone:real-folders-harness-not-linked', 'real-folders', 'después de convertir, las skills del arnés no se ven en ~/.claude/skills', 'W8', { severity: 'breaks' });
  return [own1, own2];
}

/**
 * La forma con ENLACES en Windows (T16): `~/.tycon/harness` es una unión a
 * `versions/<v>`. Con la versión ACTIVA tomada —un archivo abierto, un proceso con su carpeta de trabajo adentro y un
 * vigilante de carpetas, por la unión, como una sesión de Claude Code o un VS Code—: `update` aplica, `rollback` va y
 * vuelve; la limpieza deja lo tomado y lo borra al soltarse; el respaldo de PowerShell vuelve a la anterior por la
 * unión y repara un diario cortado; y una máquina en la forma anterior se convierte, trabada (el aviso UNA vez) y
 * después suelta. Cada diferencia es un hallazgo con su gravedad. Nunca tira.
 */
function measureLinkLayout({ own, home, author, env0, env, run, versionOf, stateFile, rec, lockers, harnessJs }) {
  const SP = require('./links-spike.js');
  const harness = path.join(own, 'harness'), previous = path.join(own, 'previous'), versions = path.join(own, 'versions');
  const target = (p) => { try { return path.resolve(path.dirname(p), fs.readlinkSync(p).replace(/^\\\\\?\\/, '')); } catch (_) { return null; } };
  const isLinkP = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };
  const ls = (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } };
  const vdir = (v) => path.join(versions, v);
  // (un archivo y una carpeta que una versión de verdad trae: version.json y scripts/, abiertos por la ruta que se da)
  const hold = (dir) => { const hs = SP.holders('all', dir, env0, true, { file: 'version.json', cwd: 'scripts' }); lockers.push(...hs); wait(2500); return hs; };
  const release = (hs) => { for (const h of hs) kill(h); wait(1500); };
  const out = (r) => `${r.stdout}\n${r.stderr}`;
  const breaks = (id, area, text) => rec.finding(`no-clone:${id}`, area, text, 'W8', { severity: 'breaks' });
  const loses = (id, area, text) => rec.finding(`no-clone:${id}`, area, text, 'W8', { severity: 'loses-control' });
  rec.fact('links_after_update_2', { harness: target(harness), previous: target(previous), versions: ls(versions) });
  if (!isLinkP(harness)) { breaks('links-not-born', 'links', `después de install y update, ${harness} no es una unión (${ls(own).join(', ')})`); return; }

  // a. la activa tomada, update aplica en esa corrida
  const v3 = publish(author, '2030.02.01.3', env0);
  if (!v3.ok) { rec.note(`forma con enlaces: no pude publicar la .3 (${v3.reason}): no medido`); return; }
  let hs = hold(harness);
  const up = run(harness, ['update', '--yes'], 'links_update_active_held');
  rec.fact('links_update_active_held', { exit: up.exit, version: versionOf(), harness: target(harness), previous: target(previous), alive: hs.map(SP.alive), failed: (stateFile() || {}).failed || null });
  if (up.exit !== 0 || versionOf() !== '2030.02.01.3' || /espera/.test(out(up))) breaks('active-held-update-blocked', 'update', `con la versión activa tomada, update salió ${up.exit} (versión ${versionOf()}): ${lastLines(out(up), 2)}`);
  if ((stateFile() || {}).failed) loses('active-held-marked-failed', 'update', 'con la activa tomada la versión quedó marcada failed');
  release(hs);

  // b. rollback con la activa tomada, y otra vez
  hs = hold(harness);
  const rb = run(harness, ['rollback'], 'links_rollback_active_held');
  const afterRb = { exit: rb.exit, version: versionOf(), harness: target(harness), previous: target(previous) };
  const rb2 = run(harness, ['rollback'], 'links_rollback_twice');
  rec.fact('links_rollback', { first: afterRb, second: { exit: rb2.exit, version: versionOf(), harness: target(harness), previous: target(previous) } });
  if (afterRb.exit !== 0 || afterRb.version !== '2030.02.01.2') breaks('active-held-rollback-fails', 'rollback', `rollback con la activa tomada salió ${afterRb.exit} (versión ${afterRb.version}): ${lastLines(out(rb), 2)}`);
  if (rb2.exit !== 0 || versionOf() !== '2030.02.01.3') breaks('rollback-twice-fails', 'rollback', `el segundo rollback salió ${rb2.exit} (versión ${versionOf()})`);
  release(hs);

  // c. la limpieza deja lo tomado y lo borra al soltarse (la .1 ya no es destino de ningún enlace)
  const old = vdir('2030.02.01.1');
  if (fs.existsSync(old)) {
    hs = hold(old);
    const st1 = run(harness, ['startup'], 'links_startup_old_held');
    const kept = fs.existsSync(path.join(old, 'version.json'));
    release(hs);
    const st2 = run(harness, ['startup'], 'links_startup_old_released');
    rec.fact('links_cleanup', { held_exit: st1.exit, kept_while_held: kept, gone_after_release: !fs.existsSync(old), versions: ls(versions), pending: (stateFile() || {}).link_pending || null });
    if (st1.exit !== 0) breaks('cleanup-held-startup-fails', 'startup', `el arranque con una versión vieja tomada salió ${st1.exit}`);
    if (!kept) rec.note('la versión vieja tomada se borró igual (o quedó a medias): Windows lo dejó');
    if (fs.existsSync(old)) rec.finding('no-clone:cleanup-not-after-release', 'startup', `soltada, el arranque no borró ${old}`, 'W8', { severity: 'noise' });
    if (st2.exit !== 0) breaks('cleanup-startup-fails', 'startup', `el arranque después de soltar salió ${st2.exit}`);
  } else rec.note(`forma con enlaces: ${old} ya no estaba antes de medir la limpieza (${ls(versions).join(', ')})`);

  // d. T9: el respaldo de PowerShell con harness.js roto vuelve a la anterior por la unión
  const ps = L.scanPath('pwsh', { env: env0 })[0] || L.scanPath('powershell', { env: env0 })[0];
  const fallback = path.join(home, '.claude', '.tycon-pipeline', 'harness', 'bootstrap-fallback.ps1');
  const prevTarget = target(previous), activeTarget = target(harness);
  if (ps && fs.existsSync(fallback) && prevTarget && activeTarget) {
    const js = path.join(activeTarget, 'scripts', 'setup', 'harness.js');
    const good = fs.readFileSync(js);
    fs.writeFileSync(js, 'esto no es javascript (\n');
    const fb = L.run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fallback], { env, timeoutMs: CMD_TIMEOUT_MS, cap: 4000 });
    rec.fact('links_ps1_fallback', { exit: fb.exit, harness: target(harness), previous: target(previous), out: lastLines(out(fb), 3) });
    if (!(target(harness) && path.resolve(target(harness)) === path.resolve(prevTarget))) breaks('ps1-fallback-no-retarget', 'fallback', `el respaldo de PowerShell no apuntó harness a la anterior (${prevTarget}): quedó en ${target(harness)} — ${lastLines(out(fb), 2)}`);
    if (!fs.existsSync(activeTarget)) loses('ps1-fallback-moved-dir', 'fallback', `el respaldo de PowerShell movió o borró ${activeTarget}`);
    fs.writeFileSync(js, good);
    // e. T5: un diario cortado lo repara el respaldo de PowerShell: harness vuelve a donde estaba
    try {
      const was = target(harness);
      fs.rmdirSync(harness); fs.symlinkSync(activeTarget, harness, 'junction');
      fs.writeFileSync(path.join(own, 'link-swap.json'), `${JSON.stringify({ schema: 1, kind: 'swap', stage: 'harness-pointed', version: 'x', dest: activeTarget, harness_was: was, previous_was: null }, null, 2)}\n`);
      const fr = L.run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fallback], { env, timeoutMs: CMD_TIMEOUT_MS, cap: 4000 });
      const back = target(harness);
      rec.fact('links_ps1_repair', { exit: fr.exit, harness: back, journal: fs.existsSync(path.join(own, 'link-swap.json')) });
      if (!(back && path.resolve(back) === path.resolve(was)) || fs.existsSync(path.join(own, 'link-swap.json'))) breaks('ps1-repair-fails', 'fallback', `el respaldo de PowerShell no reparó el diario cortado: harness → ${back} (era ${was}) — ${lastLines(out(fr), 2)}`);
    } catch (e) { rec.note(`forma con enlaces: no pude armar el diario cortado para el respaldo (${e.code || e.message}): no medido`); }
    // e2. la conversión a medias: harness ya es unión y previous sigue siendo una carpeta
    // TOMADA; con harness.js roto el respaldo no puede mover nada y no tiene que dejar la máquina sin harness
    try {
      const act = target(harness);
      if (isLinkP(previous)) fs.rmdirSync(previous);
      fs.cpSync(act, previous, { recursive: true });
      const js2 = path.join(act, 'scripts', 'setup', 'harness.js');
      const good2 = fs.readFileSync(js2);
      fs.writeFileSync(js2, 'esto no es javascript (\n');
      const hs2 = SP.holders('all', previous, env0, true, { file: 'version.json', cwd: 'scripts' }); lockers.push(...hs2); wait(2500);
      const fh = L.run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fallback], { env, timeoutMs: CMD_TIMEOUT_MS, cap: 4000 });
      const still = fs.existsSync(path.join(harness, 'version.json'));
      rec.fact('links_ps1_half_converted', { exit: fh.exit, harness_present: still, harness: target(harness), previous_real: fs.existsSync(previous) && !isLinkP(previous) });
      if (!still) breaks('ps1-half-converted-loses-harness', 'fallback', `con la conversión a medias y harness.js roto, el respaldo de PowerShell dejó la máquina sin ${harness}`);
      release(hs2);
      fs.writeFileSync(js2, good2);
      fs.rmSync(previous, { recursive: true, force: true });
      if (prevTarget && fs.existsSync(prevTarget)) fs.symlinkSync(prevTarget, previous, 'junction');
    } catch (e) { rec.note(`forma con enlaces: no pude armar la conversión a medias para el respaldo (${e.code || e.message}): no medido`); }
    // el arranque reconcilia el estado con lo que quedó apuntado (la versión que el respaldo dejó)
    run(harness, ['startup'], 'links_startup_after_fallback');
  } else rec.note(`forma con enlaces: el respaldo de PowerShell no se midió (${!ps ? 'sin pwsh ni powershell' : !fs.existsSync(fallback) ? `no está ${fallback}` : 'sin enlaces armados'})`);

  // f. una máquina en la forma anterior (carpetas reales), trabada y después suelta
  try {
    const keep = target(harness);
    for (const n of [harness, previous]) if (isLinkP(n)) fs.rmdirSync(n);
    fs.renameSync(keep, harness);
    for (const n of ls(versions)) fs.rmSync(path.join(versions, n), { recursive: true, force: true });
  } catch (e) { rec.note(`forma con enlaces: no pude armar la forma de antes para la conversión (${e.code || e.message}): no medido`); return; }
  const vc = publish(author, '2030.02.01.39', env0);
  if (!vc.ok) { rec.note(`conversión: no pude publicar (${vc.reason}): no medido`); return; }
  hs = hold(harness);
  outOfWindowAt(home, rec);
  // los primeros arranques trabados intentan en silencio; el aviso sale UNA vez al llegar a
  // 3 días o 10 arranques (acá: 9 intentos anotados a mano, y el décimo)
  const c1 = run(harness, ['startup'], 'links_convert_held');
  const silent = !/Cerrá/.test(out(c1));
  const stf = path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json');
  try { const s = readJson(stf); if (s.link_convert) s.link_convert.attempts = 9; fs.writeFileSync(stf, `${JSON.stringify(s, null, 2)}\n`); } catch (e) { rec.note(`conversión: no pude anotar los intentos en el estado (${e.code || e.message})`); }
  const c2 = run(harness, ['startup'], 'links_convert_held_tenth');
  const said = /Cerrá/.test(out(c2));
  const c2b = run(harness, ['startup'], 'links_convert_held_again');
  rec.fact('links_convert_held', { exit: c1.exit, real_dir: fs.existsSync(harness) && !isLinkP(harness), waiting: ls(versions), version: versionOf(), silent_first: silent, said_tenth: said, said_again: /Cerrá/.test(out(c2b)) });
  if (c1.exit !== 0) breaks('convert-held-startup-fails', 'convert', `el arranque con la conversión trabada salió ${c1.exit}`);
  if (!ls(versions).some((n) => n.startsWith('2030.02.01.39'))) loses('convert-held-version-lost', 'convert', `con la conversión trabada la versión nueva no quedó en versions/ (${ls(versions).join(', ')})`);
  if (!silent) rec.finding('no-clone:convert-held-not-silent', 'convert', `el primer arranque trabado ya avisó (tiene que intentar en silencio): ${lastLines(out(c1), 2)}`, 'W8', { severity: 'noise' });
  if (!said) loses('convert-held-not-said', 'convert', `al décimo arranque trabado no dijo qué cerrar: ${lastLines(out(c2), 2)}`);
  if (/Cerrá/.test(out(c2b))) rec.finding('no-clone:convert-held-said-twice', 'convert', 'el aviso de la conversión trabada se repitió en el arranque siguiente', 'W8', { severity: 'noise' });
  release(hs);
  outOfWindowAt(home, rec);
  const c3 = run(harness, ['startup'], 'links_convert_released');
  rec.fact('links_convert_released', { exit: c3.exit, harness: target(harness), previous: target(previous), version: versionOf() });
  if (!isLinkP(harness) || versionOf() !== '2030.02.01.39') breaks('convert-not-after-release', 'convert', `soltada, la conversión no salió o no aplicó la versión (harness ${isLinkP(harness) ? `→ ${target(harness)}` : 'sigue carpeta'}, versión ${versionOf()})`);
  void harnessJs;
}

/**
 * La instalación sin clon CON la capa del equipo (T14): el repo del equipo de juguete servido por el Azure
 * DevOps de juguete (la fuente de TYCON) —install, el refresco en el lugar con un commit sólo del equipo, una versión pública
 * nueva, rollback, doctor, uninstall— y por el GitHub de juguete con los dos repos (install). Con su propio entorno: sin el perfil
 * del laboratorio (la variable le ganaría a la capa), el arranque sin desprenderse (si no vuelve a los 20 s y se mide antes) y el
 * gestor de credenciales del agente apagado (sólo decide el PAT de juguete, guardado con el comando real). Nunca una credencial
 * real ni de Azure Pipelines. Devuelve una nota si algo no se pudo ensayar (nunca tira: lo de arriba ya quedó medido).
 */
function measureTeam({ base, author, program, bare, env0, baseEnv, platform, allowTemp, lab, rec, api, org, name, repoOption, gitBin, serverDir, lockers }) {
  const AZURE_SERVER = path.join(HERE, '..', 'fixtures', 'toy-azure-server.js');
  const TEAM_URL = 'https://dev.azure.com/acme/proyecto/_git/equipo-lab';
  const PAT = 'pat-lab';
  const outs = [];
  const harnessJs = (tree) => path.join(tree, 'scripts', 'setup', 'harness.js');
  // la versión de juguete sale del árbol INTERNO: sin los dos archivos de la capa, como la copia pública (si no, la capa choca)
  try { fs.rmSync(path.join(author, 'perfil-equipo.json'), { force: true }); } catch (_) { /* no estaba */ }
  try { fs.rmSync(path.join(author, 'scripts', 'metrics', 'corridas-buzon.json'), { force: true }); } catch (_) { /* no estaba */ }
  const v4 = publish(author, '2030.02.01.4', env0);
  if (!v4.ok) return `capa del equipo: no pude publicar la versión sin los archivos de la capa (${v4.reason}): no medido`;
  // el repo del equipo de juguete
  const teamWork = path.join(base, 'team-work'), teamBare = path.join(base, 'team.git');
  fs.mkdirSync(path.join(teamWork, 'scripts', 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(teamWork, 'team-layer.json'), '{ "schema": 1, "name": "equipo-lab", "requires": { "harness": ">= 2026.10.01.1" } }\n');
  const profile = (nightly) => `${JSON.stringify({ ado: { org: 'https://dev.azure.com/acme' }, integrations: { engram: true, nightly }, update: { channel: 'latest', apply: 'auto' }, packs: { default: 'all' }, install: { profile: 'full' } }, null, 2)}\n`;
  fs.writeFileSync(path.join(teamWork, 'perfil-equipo.json'), profile(true));
  fs.writeFileSync(path.join(teamWork, 'scripts', 'metrics', 'corridas-buzon.json'), '{ "_que_es": "la llave de JUGUETE del buzón (ensayo): no abre nada", "cuenta": "labcorridas", "contenedor": "corridas", "sas": "sv=lab", "vence": "2099-01-01" }\n');
  for (const args of [['init', '--quiet', '-b', 'main'], ['add', '-A'], ['commit', '--quiet', '-m', 'la capa del equipo (ensayo)']]) { const g = git(teamWork, args, env0); if (g.exit !== 0) return `capa del equipo: no pude armar el repo de juguete (git ${args[0]}: ${L.firstLine(g.stderr)}): no medido`; }
  { const g = git(base, ['clone', '--quiet', '--bare', teamWork, teamBare], env0); if (g.exit !== 0) return `capa del equipo: no pude armar el bare (${L.firstLine(g.stderr)}): no medido`; }
  const teamCommit = (text, msg) => {
    fs.writeFileSync(path.join(teamWork, 'perfil-equipo.json'), text);
    for (const args of [['add', '-A'], ['commit', '--quiet', '-m', msg], ['push', '--quiet', teamBare, 'HEAD:main']]) { const g = git(teamWork, args, env0); if (g.exit !== 0) return null; }
    return L.firstLine(git(teamWork, ['rev-parse', 'HEAD'], env0).stdout);
  };
  const waitFile = (f) => { for (let i = 0; i < 100 && !fs.existsSync(f); i++) wait(100); return fs.existsSync(f); };
  // el Azure DevOps de juguete y, para la fuente GitHub, un segundo GitHub de juguete con los DOS repos
  const azureControl = path.join(serverDir, 'azure-control.json'), azurePorts = path.join(serverDir, 'azure-ports.env');
  fs.writeFileSync(azureControl, `{ "pat": "${PAT}" }\n`);
  const azureSrv = spawn(process.execPath, [AZURE_SERVER, '--repo', teamBare, '--org', 'acme', '--project', 'proyecto', '--name', 'equipo-lab', '--git', gitBin, '--control', azureControl, '--log', path.join(serverDir, 'azure-requests.log'), '--port-file', azurePorts], { env: env0, stdio: 'ignore', windowsHide: true });
  lockers.push(azureSrv);
  if (!waitFile(azurePorts)) return 'capa del equipo: el Azure DevOps de juguete no arrancó: no medido';
  const azureApi = portOf(azurePorts, 'AZURE');
  if (!azureApi) return `el Azure DevOps de juguete arrancó sin dejar su dirección en ${azurePorts}: la capa del equipo queda no medida`;
  rec.fact('team_toy_azure', { api: azureApi, team: TEAM_URL });
  const homeOf = (id) => {
    const home = path.join(base, 'users', id);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');
    return home;
  };
  const envOf = (home, releaseApi) => T.rehearsalEnv(home, { base: baseEnv, platform, extra: {
    TYCON_RELEASE_API: releaseApi, TYCON_AZURE_API: azureApi, TYCON_AZURE_GIT_CREDENTIAL: '0', TYCON_UPDATE_APPLY: 'auto', TYCON_PROFILE: '', TYCON_STARTUP_DETACH: '0',
    TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0',
    TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
    CODEX_HOME: path.join(home, '.codex'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'), TYCON_UPDATE_NETWORK_BUDGET_S: '60',
  } });
  const home = homeOf('lab-no-clone-team');
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return `capa del equipo: ${problem}: no medido`;
  const env = envOf(home, api);
  const own = path.join(home, '.tycon');
  const tree = path.join(own, 'harness');
  const run = (t, args, label, cap = 4000, input = undefined) => {
    const r = L.run(process.execPath, [harnessJs(t), ...args], { env, timeoutMs: CMD_TIMEOUT_MS, cap, input });
    outs.push(`${r.stdout}\n${r.stderr}`);
    rec.fact(label, { exit: r.exit, error: r.error, out: lastLines(`${r.stdout}\n${r.stderr}`, 4), ms: r.ms });
    return r;
  };
  const stateFile = () => { try { return readJson(path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json')); } catch (_) { return null; } };
  const teamOfState = () => { const s = stateFile(); return s && s.team ? s.team : null; };
  const manifestCommit = (dir) => { try { return readJson(path.join(dir, '.tycon-team.json')).commit; } catch (_) { return null; } };
  const outOfWindow = () => outOfWindowAt(home, rec);
  const temps = () => { try { return fs.readdirSync(tree).filter((n) => n.startsWith('.tycon-team.tmp-')).concat(fs.readdirSync(path.join(tree, 'scripts', 'metrics')).filter((n) => n.startsWith('.tycon-team.tmp-'))); } catch (_) { return []; } };

  // a. el PAT de juguete, por el comando real (por stdin), y install --team con la URL de Azure
  run(program, ['config', 'set', 'azure.token'], 'team_config_set', 1000, PAT);
  const inst = run(program, ['install', '--version', 'latest', '--team', TEAM_URL, '--yes', ...repoOption], 'team_install');
  const t1 = teamOfState();
  rec.fact('team_after_install', { team: t1, perfil: fs.existsSync(path.join(tree, 'perfil-equipo.json')), manifest: manifestCommit(tree) });
  if (inst.exit !== 0) { rec.finding('no-clone:team-install-fails', 'team', `install --team <URL de Azure> salió ${inst.exit}: ${lastLines(`${inst.stdout}\n${inst.stderr}`, 3)}`, 'W8', { severity: 'breaks' }); return null; }
  if (!t1 || t1.host !== 'azure' || !fs.existsSync(path.join(tree, 'perfil-equipo.json')) || manifestCommit(tree) !== t1.commit) rec.finding('no-clone:team-not-stacked', 'team', `install --team salió 0 pero la capa no quedó apilada (estado ${JSON.stringify(t1)})`, 'W8', { severity: 'breaks' });

  // b. un commit SÓLO del equipo y un arranque fuera de la ventana: el refresco en el lugar
  const c2 = teamCommit(profile(false), 'nightly apagada');
  outOfWindow();
  const st1 = run(tree, ['startup'], 'team_startup_refresh');
  const t2 = teamOfState();
  const refreshed = Boolean(c2) && t2 && t2.commit === c2 && manifestCommit(tree) === c2 && /"nightly": false/.test(fs.readFileSync(path.join(tree, 'perfil-equipo.json'), 'utf8'));
  rec.fact('team_refresh', { exit: st1.exit, commit: c2, state: t2 && t2.commit, manifest: manifestCommit(tree), refreshed, temps: temps() });
  if (!refreshed) rec.finding('no-clone:team-refresh-fails', 'team', `un commit sólo del equipo no llegó en el arranque (esperado ${c2}, estado ${t2 && t2.commit}, manifiesto ${manifestCommit(tree)})`, 'W8', { severity: 'loses-control' });

  // b'. (Windows) el refresco con perfil-equipo.json TOMADO por otro proceso: o entra entero, o no cambia nada (nunca a medias)
  if (isWin) {
    const before = { perfil: fs.readFileSync(path.join(tree, 'perfil-equipo.json'), 'utf8'), manifest: manifestCommit(tree) };
    const held = holdOpen(path.join(tree, 'perfil-equipo.json'), env0, 'Read');
    if (held) {
      lockers.push(held);
      wait(1500);
      const c3 = teamCommit(profile(true), 'nightly prendida (archivo tomado)');
      outOfWindow();
      run(tree, ['startup'], 'team_startup_locked');
      kill(held);
      wait(1000);
      const after = { perfil: (() => { try { return fs.readFileSync(path.join(tree, 'perfil-equipo.json'), 'utf8'); } catch (_) { return null; } })(), manifest: manifestCommit(tree), temps: temps(), state: (teamOfState() || {}).commit, last_error: (teamOfState() || {}).last_error || null };
      const whole = after.manifest === c3 && /"nightly": true/.test(after.perfil || '');
      const untouched = after.manifest === before.manifest && after.perfil === before.perfil && !after.temps.length;
      rec.fact('team_locked_refresh', { commit: c3, before, after, outcome: whole ? 'applied' : (untouched ? 'untouched' : 'half') });
      if (!whole && !untouched) rec.finding('no-clone:team-locked-half', 'team', `con perfil-equipo.json tomado el refresco quedó a medias (${JSON.stringify(after).slice(0, 400)})`, 'W8', { severity: 'breaks' });
      if (untouched && !after.last_error) rec.finding('no-clone:team-locked-half', 'team', 'con el archivo tomado el refresco no cambió nada pero no lo dejó dicho (state.team.last_error vacío)', 'W8', { severity: 'noise' });
      outOfWindow();
      run(tree, ['startup'], 'team_startup_after_lock');
    } else rec.note('capa del equipo: no pude tomar perfil-equipo.json (sin PowerShell): el refresco con el archivo tomado queda no medido');
  } else rec.note('capa del equipo: el refresco con un archivo tomado sólo se mide en Windows (en posix un rename no se traba)');

  // c. una versión pública nueva: la capa viaja a la versión nueva
  const v5 = publish(author, '2030.02.01.5', env0);
  if (v5.ok) {
    const up = run(tree, ['update', '--yes'], 'team_update');
    const t3 = teamOfState(); const s3 = stateFile();
    rec.fact('team_after_update', { exit: up.exit, version: s3 && s3.version ? s3.version.number : null, team: t3 && t3.commit, perfil: fs.existsSync(path.join(tree, 'perfil-equipo.json')) });
    if (up.exit !== 0 || !s3 || s3.version.number !== '2030.02.01.5' || !fs.existsSync(path.join(tree, 'perfil-equipo.json')) || !t3 || manifestCommit(tree) !== t3.commit) rec.finding('no-clone:team-update-lost', 'team', `con una versión pública nueva la capa no quedó en la versión nueva (update ${up.exit}, estado ${JSON.stringify(t3)})`, 'W8', { severity: 'breaks' });
  } else rec.note(`capa del equipo: no pude publicar 2030.02.01.5 (${v5.reason}): update con capa no medido`);

  // d. rollback: la capa del estado es la del árbol que quedó
  const rb = run(tree, ['rollback'], 'team_rollback');
  const t4 = teamOfState();
  rec.fact('team_after_rollback', { exit: rb.exit, state: t4 && t4.commit, manifest: manifestCommit(tree) });
  if (rb.exit !== 0 || !t4 || t4.commit !== manifestCommit(tree)) rec.finding('no-clone:team-rollback-state', 'team', `después de rollback, state.team (${t4 && t4.commit}) no es la capa del árbol que quedó (${manifestCommit(tree)})`, 'W8', { severity: 'loses-control' });

  // e. doctor: la línea de la capa, sin fail
  const doc = run(tree, ['doctor', '--json'], 'team_doctor', 400000);
  let dj = null; try { dj = JSON.parse(doc.stdout); } catch (_) { dj = null; }
  const line = dj && Array.isArray(dj.ok) ? dj.ok.find((l) => /^capa del equipo equipo-lab /.test(l)) : null;
  rec.fact('team_doctor', { exit: doc.exit, line, fail: dj ? dj.fail : null });
  if (!dj || (dj.fail || []).length || !line) rec.finding('no-clone:team-doctor-line', 'team', `doctor --json con capa: ${dj ? `fail ${JSON.stringify(dj.fail).slice(0, 300)}, línea ${line ? 'sí' : 'no'}` : 'ilegible'}`, 'W8', { severity: 'loses-control' });

  // f. uninstall: deja y nombra ~/.tycon/team
  const un = run(tree, ['uninstall', '--yes'], 'team_uninstall');
  const teamDir = path.join(own, 'team');
  rec.fact('team_after_uninstall', { exit: un.exit, team_dir: fs.existsSync(teamDir), named: `${un.stdout}`.includes(teamDir) });
  if (un.exit !== 0 || !fs.existsSync(teamDir) || !`${un.stdout}${un.stderr}`.includes(teamDir)) rec.finding('no-clone:team-uninstall-cache', 'team', `uninstall con capa: salió ${un.exit}; ${teamDir} ${fs.existsSync(teamDir) ? 'quedó' : 'NO quedó'} y ${`${un.stdout}${un.stderr}`.includes(teamDir) ? 'se nombra' : 'NO se nombra'}`, 'W8', { severity: 'noise' });

  // g. la fuente GitHub en Windows: un segundo GitHub de juguete con los DOS repos y install --team <org>/<repo>
  const ghControl = path.join(serverDir, 'gh2-control.json'), ghPorts = path.join(serverDir, 'gh2-ports.env');
  fs.writeFileSync(ghControl, '{ "auth": "none" }\n');
  // el `git archive` del GitHub de juguete corre con la configuración del agente, y Git for Windows trae core.autocrlf=true:
  // sin un .gitattributes en el repo (la capa no puede traerlo), el comprimido sale con \r\n y su árbol no da el del commit.
  // GitHub de verdad arma el comprimido sin esa conversión: el servidor de juguete, igual
  const gh2Env = Object.assign({}, env0, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
  const gh2 = spawn(process.execPath, [SERVER, '--repo', bare, '--org', org, '--name', name, '--repo', teamBare, '--org', 'TYCON-LAB', '--name', 'equipo-lab', '--git', gitBin, '--control', ghControl, '--log', path.join(serverDir, 'gh2-requests.log'), '--port-file', ghPorts], { env: gh2Env, stdio: 'ignore', windowsHide: true });
  lockers.push(gh2);
  if (waitFile(ghPorts)) {
    const api2 = /^API=(.+)$/m.exec(fs.readFileSync(ghPorts, 'utf8'))[1].trim();
    const home2 = homeOf('lab-no-clone-team-github');
    const r = L.run(process.execPath, [harnessJs(program), 'install', '--version', 'latest', '--team', 'TYCON-LAB/equipo-lab', '--yes', ...repoOption], { env: envOf(home2, api2), timeoutMs: CMD_TIMEOUT_MS, cap: 4000 });
    outs.push(`${r.stdout}\n${r.stderr}`);
    const stacked = fs.existsSync(path.join(home2, '.tycon', 'harness', 'perfil-equipo.json'));
    rec.fact('team_github_install', { exit: r.exit, stacked, out: lastLines(`${r.stdout}\n${r.stderr}`, 3) });
    if (r.exit !== 0 || !stacked) rec.finding('no-clone:team-github-install-fails', 'team', `install --team <org>/<repo> (fuente GitHub) salió ${r.exit}, capa ${stacked ? 'apilada' : 'NO apilada'}: ${lastLines(`${r.stdout}\n${r.stderr}`, 2)}`, 'W8', { severity: 'loses-control' });
  } else rec.note('capa del equipo: el segundo GitHub de juguete no arrancó: la fuente GitHub en Windows queda no medida');

  // el PAT de juguete nunca en ninguna salida
  if (outs.some((o) => o.includes(PAT))) rec.finding('no-clone:team-pat-printed', 'team', 'el PAT de juguete apareció en la salida de un comando', 'W8', { severity: 'breaks' });
  return null;
}

/**
 * La capa del equipo en una carpeta de usuario NUEVA con Claude Code y Codex enchufados (T28): la capa de juguete
 * (scripts/tests/windows/team-lab.js, writeTeamLayerA2: un paquete con un revisor `base` y uno `condicional`, una skill de una
 * carpeta y una anidada a tres) servida por el Azure DevOps de juguete. install --team; los revisores en ~/.claude/agents y sus dos
 * traducciones en $CODEX_HOME (ninguna en adapters/ del árbol); la anidada por su ruta; un commit que saca un revisor y una skill,
 * y el arranque fuera de la ventana (sin uniones ni enlaces colgando, sin carpetas vacías); doctor --json sin fail; uninstall sin
 * ninguna traducción de la capa. Corre después de la parte anterior (que deja la versión 2030.02.01.5 sin los archivos de la
 * capa). Devuelve una nota si algo no se pudo ensayar (nunca tira).
 */
function measureTeamA2({ lab, base, program, env0, baseEnv, platform, allowTemp, rec, api, repoOption, gitBin, serverDir, lockers }) {
  const AZURE_SERVER = path.join(HERE, '..', 'fixtures', 'toy-azure-server.js');
  const TEAM_URL = 'https://dev.azure.com/acme/proyecto/_git/equipo-lab-a2';
  const PAT = 'pat-lab';
  const A2 = T.LAYER_A2;
  const outs = [];
  const harnessJs = (t) => path.join(t, 'scripts', 'setup', 'harness.js');
  const teamWork = path.join(base, 'team-a2-work'), teamBare = path.join(base, 'team-a2.git');
  fs.mkdirSync(teamWork, { recursive: true });
  T.writeTeamLayerA2(teamWork);
  for (const args of [['init', '--quiet', '-b', 'main'], ['add', '-A'], ['commit', '--quiet', '-m', 'la capa de la A2 (ensayo)']]) { const g = git(teamWork, args, env0); if (g.exit !== 0) return `capa de la A2: no pude armar el repo de juguete (git ${args[0]}: ${L.firstLine(g.stderr)}): no medido`; }
  { const g = git(base, ['clone', '--quiet', '--bare', teamWork, teamBare], env0); if (g.exit !== 0) return `capa de la A2: no pude armar el bare (${L.firstLine(g.stderr)}): no medido`; }
  const waitFile = (f) => { for (let i = 0; i < 100 && !fs.existsSync(f); i++) wait(100); return fs.existsSync(f); };
  const azureControl = path.join(serverDir, 'azure-a2-control.json'), azurePorts = path.join(serverDir, 'azure-a2-ports.env');
  fs.writeFileSync(azureControl, `{ "pat": "${PAT}" }\n`);
  const srv = spawn(process.execPath, [AZURE_SERVER, '--repo', teamBare, '--org', 'acme', '--project', 'proyecto', '--name', 'equipo-lab-a2', '--git', gitBin, '--control', azureControl, '--log', path.join(serverDir, 'azure-a2-requests.log'), '--port-file', azurePorts], { env: env0, stdio: 'ignore', windowsHide: true });
  lockers.push(srv);
  if (!waitFile(azurePorts)) return 'capa de la A2: el Azure DevOps de juguete no arrancó: no medido';
  const azureApi = portOf(azurePorts, 'AZURE');
  if (!azureApi) return `el Azure DevOps de juguete arrancó sin dejar su dirección en ${azurePorts}: la capa del equipo queda no medida`;
  const home = path.join(base, 'users', 'lab-no-clone-team-a2');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return `capa de la A2: ${problem}: no medido`;
  const codex = path.join(home, '.codex');
  const env = T.rehearsalEnv(home, { base: baseEnv, platform, extra: {
    TYCON_RELEASE_API: api, TYCON_AZURE_API: azureApi, TYCON_AZURE_GIT_CREDENTIAL: '0', TYCON_UPDATE_APPLY: 'auto', TYCON_PROFILE: '', TYCON_STARTUP_DETACH: '0',
    TYCON_CLAUDE: '1', TYCON_CODEX: '1', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0',
    TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
    CODEX_HOME: codex, TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'), TYCON_UPDATE_NETWORK_BUDGET_S: '60',
  } });
  const tree = path.join(home, '.tycon', 'harness');
  const run = (t, args, label, cap = 4000, input = undefined) => {
    const r = L.run(process.execPath, [harnessJs(t), ...args], { env, timeoutMs: CMD_TIMEOUT_MS, cap, input });
    outs.push(`${r.stdout}\n${r.stderr}`);
    rec.fact(label, { exit: r.exit, error: r.error, out: lastLines(`${r.stdout}\n${r.stderr}`, 4), ms: r.ms });
    return r;
  };
  const readable = (f) => { try { fs.readFileSync(f); return true; } catch (_) { return false; } };
  const there = (f) => { try { fs.lstatSync(f); return true; } catch (_) { return false; } };
  const codexFiles = (r) => [path.join(codex, `${r}.config.toml`), path.join(codex, 'agents', `${r}.toml`)];
  const outOfWindow = () => outOfWindowAt(home, rec);
  // un enlace (o una unión, en Windows) cuyo destino no existe, en las carpetas que el arnés llena
  const dangling = () => {
    const out = [];
    const walk = (d, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        let st = null;
        try { st = fs.lstatSync(p); } catch (_) { continue; }
        if (st.isSymbolicLink()) { if (!fs.existsSync(p)) out.push(p); continue; }
        if (st.isDirectory() && depth > 0) walk(p, depth - 1);
      }
    };
    for (const d of [path.join(home, '.claude', 'agents'), path.join(home, '.claude', 'skills'), path.join(codex, 'skills'), path.join(codex, 'agents')]) walk(d, 4);
    return out;
  };

  // a. el PAT de juguete por el comando real, e install --team con Claude Code y Codex
  run(program, ['config', 'set', 'azure.token'], 'team_a2_config_set', 1000, PAT);
  const inst = run(program, ['install', '--version', 'latest', '--team', TEAM_URL, '--yes', ...repoOption], 'team_a2_install');
  if (inst.exit !== 0) { rec.finding('no-clone:team-a2-install-fails', 'team-a2', `install --team (capa de la A2, Claude Code y Codex) salió ${inst.exit}: ${lastLines(`${inst.stdout}\n${inst.stderr}`, 3)}`, 'W8', { severity: 'breaks' }); return null; }
  const claudeAgents = [A2.base, A2.cond].map((r) => path.join(home, '.claude', 'agents', `${r}.md`));
  const nested = path.join(home, '.claude', 'skills', ...A2.nested.split('/'), 'SKILL.md');
  rec.fact('team_a2_claude', { agents: claudeAgents.map(readable), nested: readable(nested) });
  if (!claudeAgents.every(readable) || !readable(nested)) rec.finding('no-clone:team-a2-claude-missing', 'team-a2', `con la capa de la A2: revisores en ~/.claude/agents ${claudeAgents.map(readable).join('/')} · la anidada en ~/.claude/skills/${A2.nested} ${readable(nested) ? 'sí' : 'NO'}`, 'W8', { severity: 'loses-control' });
  const toms = [A2.base, A2.cond].flatMap(codexFiles);
  rec.fact('team_a2_codex', { tomls: toms.map((f) => fs.existsSync(f)) });
  if (!toms.every((f) => fs.existsSync(f))) rec.finding('no-clone:team-a2-codex-missing', 'team-a2', `las dos traducciones de cada revisor de la capa en $CODEX_HOME: ${toms.map((f) => `${path.relative(codex, f)} ${fs.existsSync(f) ? 'sí' : 'NO'}`).join(' · ')}`, 'W8', { severity: 'loses-control' });
  const inTree = ['agents', 'agents-native'].flatMap((s) => { try { return fs.readdirSync(path.join(tree, 'adapters', 'codex', s)).filter((f) => f.startsWith('rev-lab-')); } catch (_) { return []; } });
  if (inTree.length) rec.finding('no-clone:team-a2-in-adapters', 'team-a2', `traducciones de la capa dentro del árbol (adapters/): ${inTree.join(', ')} — doctor las vería «de más»`, 'W8', { severity: 'noise' });

  // b. un commit que saca el revisor condicional y la skill de una carpeta, y el arranque fuera de la ventana
  T.writeTeamLayerA2(teamWork, { second: false });
  let c2 = null;
  for (const args of [['add', '-A'], ['commit', '--quiet', '-m', 'sale un revisor y una skill'], ['push', '--quiet', teamBare, 'HEAD:main']]) { const g = git(teamWork, args, env0); if (g.exit !== 0) { c2 = false; break; } }
  if (c2 === false) return 'capa de la A2: no pude publicar el commit que saca un revisor y una skill: el refresco queda no medido';
  outOfWindow();
  run(tree, ['startup'], 'team_a2_startup_refresh');
  const left = [path.join(home, '.claude', 'agents', `${A2.cond}.md`), ...codexFiles(A2.cond), path.join(home, '.claude', 'skills', A2.single), path.join(codex, 'skills', A2.single)].filter(there);
  rec.fact('team_a2_refresh', { left });
  if (left.length) rec.finding('no-clone:team-a2-refresh-left', 'team-a2', `lo que la capa sacó sigue después del arranque: ${left.join(', ')}`, 'W8', { severity: 'loses-control' });
  const hang = dangling();
  if (hang.length) rec.finding('no-clone:team-a2-dangling', 'team-a2', `enlaces o uniones colgando: ${hang.slice(0, 5).join(', ')}`, 'W8', { severity: 'loses-control' });
  const empty = [path.join(tree, 'skills', A2.single), path.join(tree, 'agents', `${A2.cond}.md`)].filter(there);
  if (empty.length) rec.finding('no-clone:team-a2-empty-dirs', 'team-a2', `quedan restos de lo sacado en el árbol: ${empty.join(', ')}`, 'W8', { severity: 'noise' });

  // c. doctor y uninstall
  const doc = run(tree, ['doctor', '--json'], 'team_a2_doctor', 400000);
  let dj = null; try { dj = JSON.parse(doc.stdout); } catch (_) { dj = null; }
  rec.fact('team_a2_doctor', { exit: doc.exit, fail: dj ? dj.fail : null });
  if (!dj || (dj.fail || []).length) rec.finding('no-clone:team-a2-doctor-red', 'team-a2', `doctor --json con la capa de la A2: ${dj ? JSON.stringify(dj.fail).slice(0, 300) : 'ilegible'}`, 'W8', { severity: 'loses-control' });
  run(tree, ['uninstall', '--yes'], 'team_a2_uninstall');
  const after = [A2.base, A2.cond].flatMap(codexFiles).filter(there);
  rec.fact('team_a2_after_uninstall', { left: after });
  if (after.length) rec.finding('no-clone:team-a2-uninstall-left', 'team-a2', `después de uninstall quedan traducciones de la capa en $CODEX_HOME: ${after.join(', ')}`, 'W8', { severity: 'noise' });
  if (outs.some((o) => o.includes(PAT))) rec.finding('no-clone:team-pat-printed', 'team-a2', 'el PAT de juguete apareció en la salida de un comando (capa de la A2)', 'W8', { severity: 'breaks' });
  rec.note('capa de la A2: no medido acá — que Claude Code cargue la skill y que Codex corra el revisor (piden una sesión real de cada herramienta); en Windows el modo de un archivo no se mide');
  return null;
}

/**
 * La skill de la lista FIJA con sus datos fuera de su carpeta (T37), en una carpeta de usuario NUEVA con Claude
 * Code: la capa de juguete (team-lab.js, writeTeamLayerA2c: `skills/bizuit-sdd` con contenido inventado y sus dos archivos de
 * datos) servida por el Azure DevOps de juguete. install --team apila los datos y la skill se ve en ~/.claude/skills; una
 * carpeta propia del dev en su lugar con un `.bizuit-config.yaml` de juguete, y un `update` a una versión nueva: la conexión llega
 * a %USERPROFILE%\.bizuit-sdd\config.yaml, byte a byte, y el original queda; doctor avisa la carpeta propia (sin fail). Los
 * permisos del archivo no se miden en Windows. Corre después de las partes anteriores (la versión publicada va a
 * 2030.03.01.1, sin la skill de la lista, y después a 2030.03.01.2). Devuelve una nota si algo no se pudo ensayar (nunca tira).
 */
function measureTeamSkillData({ lab, base, author, program, env0, baseEnv, platform, allowTemp, rec, api, repoOption, gitBin, serverDir, lockers }) {
  const AZURE_SERVER = path.join(HERE, '..', 'fixtures', 'toy-azure-server.js');
  const TEAM_URL = 'https://dev.azure.com/acme/proyecto/_git/equipo-lab-a2c';
  const PAT = 'pat-lab';
  const C = T.LAYER_A2C;
  const outs = [];
  const harnessJs = (t) => path.join(t, 'scripts', 'setup', 'harness.js');
  const teamWork = path.join(base, 'team-a2c-work'), teamBare = path.join(base, 'team-a2c.git');
  fs.mkdirSync(teamWork, { recursive: true });
  T.writeTeamLayerA2c(teamWork);
  for (const args of [['init', '--quiet', '-b', 'main'], ['add', '-A'], ['commit', '--quiet', '-m', 'la capa de la A2c (ensayo)']]) { const g = git(teamWork, args, env0); if (g.exit !== 0) return `capa de la A2c: no pude armar el repo de juguete (git ${args[0]}: ${L.firstLine(g.stderr)}): no medido`; }
  { const g = git(base, ['clone', '--quiet', '--bare', teamWork, teamBare], env0); if (g.exit !== 0) return `capa de la A2c: no pude armar el bare (${L.firstLine(g.stderr)}): no medido`; }
  const waitFile = (f) => { for (let i = 0; i < 100 && !fs.existsSync(f); i++) wait(100); return fs.existsSync(f); };
  const azureControl = path.join(serverDir, 'azure-a2c-control.json'), azurePorts = path.join(serverDir, 'azure-a2c-ports.env');
  fs.writeFileSync(azureControl, `{ "pat": "${PAT}" }\n`);
  const srv = spawn(process.execPath, [AZURE_SERVER, '--repo', teamBare, '--org', 'acme', '--project', 'proyecto', '--name', 'equipo-lab-a2c', '--git', gitBin, '--control', azureControl, '--log', path.join(serverDir, 'azure-a2c-requests.log'), '--port-file', azurePorts], { env: env0, stdio: 'ignore', windowsHide: true });
  lockers.push(srv);
  if (!waitFile(azurePorts)) return 'capa de la A2c: el Azure DevOps de juguete no arrancó: no medido';
  const azureApi = portOf(azurePorts, 'AZURE');
  if (!azureApi) return `el Azure DevOps de juguete arrancó sin dejar su dirección en ${azurePorts}: la capa de la A2c queda no medida`;
  const home = path.join(base, 'users', 'lab-no-clone-team-a2c');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return `capa de la A2c: ${problem}: no medido`;
  const env = T.rehearsalEnv(home, { base: baseEnv, platform, extra: {
    TYCON_RELEASE_API: api, TYCON_AZURE_API: azureApi, TYCON_AZURE_GIT_CREDENTIAL: '0', TYCON_UPDATE_APPLY: 'auto', TYCON_PROFILE: '', TYCON_STARTUP_DETACH: '0',
    TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0', BIZUIT_SDD_HOME: '',
    TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
    CODEX_HOME: path.join(home, '.codex'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'), TYCON_UPDATE_NETWORK_BUDGET_S: '60',
  } });
  const tree = path.join(home, '.tycon', 'harness');
  const run = (t, args, label, cap = 4000, input = undefined) => {
    const r = L.run(process.execPath, [harnessJs(t), ...args], { env, timeoutMs: CMD_TIMEOUT_MS, cap, input });
    outs.push(`${r.stdout}\n${r.stderr}`);
    rec.fact(label, { exit: r.exit, error: r.error, out: lastLines(`${r.stdout}\n${r.stderr}`, 4), ms: r.ms });
    return r;
  };
  const there = (f) => { try { fs.lstatSync(f); return true; } catch (_) { return false; } };
  const readable = (f) => { try { fs.readFileSync(f); return true; } catch (_) { return false; } };
  const SENT = 'CENTINELA-ensayo-a2c';
  // la versión que publica la sonda sale del árbol INTERNO, que trae la skill de la lista; la copia pública nunca la trae (va a
  // la capa del equipo): se publica primero una versión sin esa carpeta, o la capa choca con la versión
  try { fs.rmSync(path.join(author, ...C.skill.split('/')), { recursive: true, force: true }); } catch (e) { return `capa de la A2c: no pude sacar ${C.skill} de la versión de ensayo (${e.code || e.message}): no medido`; }
  const v0 = publish(author, '2030.03.01.1', env0);
  if (!v0.ok) return `capa de la A2c: no pude publicar la versión sin la skill de la lista (${v0.reason}): no medido`;
  // a. el PAT de juguete por el comando real, e install --team con Claude Code
  run(program, ['config', 'set', 'azure.token'], 'team_a2c_config_set', 1000, PAT);
  const inst = run(program, ['install', '--version', 'latest', '--team', TEAM_URL, '--yes', ...repoOption], 'team_a2c_install');
  if (inst.exit !== 0) { rec.finding('no-clone:team-a2c-install-fails', 'team-a2c', `install --team (la skill de la lista con sus datos) salió ${inst.exit}: ${lastLines(`${inst.stdout}\n${inst.stderr}`, 3)}`, 'W8', { severity: 'breaks' }); return null; }
  const data = ['VERSION', 'templates/shared-styles.css'].map((f) => path.join(tree, ...C.skill.split('/'), ...f.split('/')));
  const claudeSkill = path.join(home, '.claude', 'skills', 'bizuit-sdd', 'SKILL.md');
  rec.fact('team_a2c_stacked', { data: data.map(readable), visible: readable(claudeSkill) });
  if (!data.every(readable)) rec.finding('no-clone:team-a2c-data-missing', 'team-a2c', `los archivos de datos de la skill de la lista no se apilaron: ${data.filter((f) => !readable(f)).join(', ')}`, 'W8', { severity: 'breaks' });
  if (!readable(claudeSkill)) rec.finding('no-clone:team-a2c-skill-invisible', 'team-a2c', `la skill de la lista no se ve en ${claudeSkill}`, 'W8', { severity: 'loses-control' });
  // b. una carpeta propia del dev en el lugar de la skill (como la instalación de antes del arnés), con su conexión de juguete. En
  // una máquina instalada ~/.claude/skills ENTERO es un enlace (o una unión) al árbol: la carpeta propia sólo existe donde la
  // persona tiene su ~/.claude/skills como carpeta real (el aplicador pone ahí un enlace por entrada y no pisa lo suyo). Se saca
  // ese enlace SIN seguirlo —borrar «recursivo» un enlace o una unión vacía la carpeta del árbol a la que apunta—
  // y se arma la carpeta real; nada se borra dentro de ~/.claude/skills
  const skillsDir = path.join(home, '.claude', 'skills');
  const own = path.join(skillsDir, 'bizuit-sdd');
  try {
    const st = fs.lstatSync(skillsDir);
    if (st.isSymbolicLink()) { try { fs.unlinkSync(skillsDir); } catch (_) { fs.rmdirSync(skillsDir); } }
  } catch (_) { /* no estaba */ }
  if (there(own)) return `capa de la A2c: ${own} ya existe en una carpeta real de skills: no se arma la carpeta propia encima (no medido)`;
  const legacyText = `environments:\n  active: dev\n  dev:\n    url: https://bpm.example.test/ensayo\n    user: ${SENT}\n`;
  try {
    fs.mkdirSync(path.join(own, 'processes', 'acme'), { recursive: true });
    fs.writeFileSync(path.join(own, 'VERSION'), '1.0.0\n');
    fs.writeFileSync(path.join(own, C.legacy), legacyText);
  } catch (e) { return `capa de la A2c: no pude armar la carpeta propia de juguete (${e.code || e.message}): la mudanza de la conexión queda no medida`; }
  // c. una versión nueva y `update`: la conexión llega a la casa nueva y el original queda
  const v = publish(author, '2030.03.01.2', env0);
  if (!v.ok) return `capa de la A2c: no pude publicar la versión nueva (${v.reason}): la mudanza de la conexión queda no medida`;
  const up = run(tree, ['update', '--yes'], 'team_a2c_update');
  const casa = path.join(home, C.home, C.file);
  let same = false;
  try { same = fs.readFileSync(casa, 'utf8') === legacyText; } catch (_) { same = false; }
  rec.fact('team_a2c_moved', { exit: up.exit, home: there(casa), same, original: there(path.join(own, C.legacy)), permissions: 'no medido en Windows' });
  if (!same) rec.finding('no-clone:team-a2c-not-moved', 'team-a2c', `la conexión de juguete no llegó a ${casa} (update salió ${up.exit}: ${lastLines(`${up.stdout}\n${up.stderr}`, 3)})`, 'W8', { severity: 'loses-control' });
  if (!there(path.join(own, C.legacy))) rec.finding('no-clone:team-a2c-original-gone', 'team-a2c', `el original ${path.join(own, C.legacy)} no quedó donde estaba`, 'W8', { severity: 'breaks' });
  // d. doctor avisa la carpeta propia, sin fail
  const doc = run(tree, ['doctor', '--json'], 'team_a2c_doctor', 400000);
  let dj = null; try { dj = JSON.parse(doc.stdout); } catch (_) { dj = null; }
  const warned = Boolean(dj && (dj.warn || []).some((w) => w.includes(own) && /carpeta propia/.test(w)));
  rec.fact('team_a2c_doctor', { exit: doc.exit, fail: dj ? dj.fail : null, ownWarned: warned });
  if (!dj || (dj.fail || []).length) rec.finding('no-clone:team-a2c-doctor-red', 'team-a2c', `doctor --json con la skill de la lista: ${dj ? JSON.stringify(dj.fail).slice(0, 300) : 'ilegible'}`, 'W8', { severity: 'loses-control' });
  if (!warned) rec.finding('no-clone:team-a2c-own-not-warned', 'team-a2c', `doctor no avisa la carpeta propia ${own}`, 'W8', { severity: 'noise' });
  if (outs.some((o) => o.includes(SENT))) rec.finding('no-clone:team-a2c-content-printed', 'team-a2c', 'el contenido de la conexión de juguete apareció en la salida de un comando', 'W8', { severity: 'breaks' });
  if (outs.some((o) => o.includes(PAT))) rec.finding('no-clone:team-pat-printed', 'team-a2c', 'el PAT de juguete apareció en la salida de un comando (capa de la A2c)', 'W8', { severity: 'breaks' });
  rec.note('capa de la A2c: no medido acá — los permisos del archivo de la conexión en Windows (hereda los de la carpeta del usuario) y que Claude Code cargue la skill');
  return null;
}

/**
 * Contra el GitHub REAL, sin permiso (T1 en Windows y T16): el sondeo del tope anónimo de la API y el registro de
 * pedidos de la instalación y de mirar, con el código de la rama (`program`). Sólo en el agente del ensayo de Windows (`TF_BUILD`; o con
 * `TYCON_PROBE_REAL_GITHUB=1`): en una suite local no sale a la red. Devuelve una nota si no se midió; nunca tira.
 */
function measureRealGithub({ base, program, baseEnv, platform, rec }) {
  if (!baseEnv.TF_BUILD && baseEnv.TYCON_PROBE_REAL_GITHUB !== '1') return 'GitHub real (story 8.34): no medido fuera del agente de la 182 (TF_BUILD; TYCON_PROBE_REAL_GITHUB=1 lo fuerza)';
  let repo = null;
  try { const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec((readJson(path.join(program, 'scripts', 'setup', 'public-remotes.json')).remotes || [])[0] || ''); if (m) repo = `${m[1]}/${m[2]}`; } catch (_) { repo = null; }
  if (!repo) return 'GitHub real (story 8.34): la copia no trae scripts/setup/public-remotes.json con el remoto público: no medido';
  const H = require('../../lib/http-get.js');
  const PG = require('../../setup/harness/public-git.js');
  const home = path.join(base, 'users', 'lab-real-github');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const trace = path.join(base, 'real-github-trace.jsonl');
  const profile = path.join(base, 'lab-profile-real.json');
  fs.writeFileSync(profile, '{ "install": { "profile": "minimal" } }\n');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');
  const env = T.rehearsalEnv(home, { base: baseEnv, platform, extra: {
    // sin tareas programadas: launchd es por usuario, no por HOME (una HOME de laboratorio no aísla la tarea real del examen)
    TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1',
    TYCON_HTTP_TRACE: trace, TYCON_UPDATE_APPLY: 'auto', TYCON_PROFILE: profile, TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0',
    TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
    CODEX_HOME: path.join(home, '.codex'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'), TYCON_UPDATE_NETWORK_BUDGET_S: '60',
  } });
  // las rutas son las reales: ninguna variable de prueba que apunte a un juguete
  for (const k of ['TYCON_RELEASE_API', 'TYCON_RELEASE_GIT', 'TYCON_RELEASE_RAW', 'TYCON_RELEASE_ARCHIVE']) delete env[k];
  // T1: el tope anónimo antes y después de cada ruta pública, y un 304 sin permiso (`rate_limit` no cuenta)
  const used = () => { const r = H.getSync('https://api.github.com/rate_limit', { env, timeoutMs: 20000 }); try { return JSON.parse(r.body.toString('utf8')).resources.core.used; } catch (_) { return null; } };
  const b = PG.bases(env);
  const spike = { before: used() };
  const refs = H.getSync(PG.refsUrl(b, repo), { env, timeoutMs: 30000 });
  const heads = refs.ok && refs.status === 200 ? PG.parseInfoRefs(refs.body) : { ok: false };
  const main = heads.ok ? heads.heads.main : null;
  spike.info_refs = { status: refs.ok ? refs.status : refs.kind, git_format: heads.ok, used_after: used() };
  if (main) {
    const raw = H.getSync(PG.rawUrl(b, repo, main, 'version.json'), { env, timeoutMs: 30000 });
    spike.raw = { status: raw.ok ? raw.status : raw.kind, used_after: used() };
    const tar = H.getSync(PG.tarUrl(b, repo, main), { env, timeoutMs: 120000, maxBytes: 256 * 1024 * 1024 });
    spike.codeload = { status: tar.ok ? tar.status : tar.kind, bytes: tar.ok ? tar.body.length : 0, used_after: used() };
  }
  const refApi = `https://api.github.com/repos/${repo}/git/ref/heads/main`;
  const first = H.getSync(refApi, { env, timeoutMs: 20000 });
  const etag = first.ok ? first.headers.etag : null;
  const u0 = used();
  const cond = etag ? H.getSync(refApi, { env, timeoutMs: 20000, headers: { 'If-None-Match': etag } }) : null;
  spike.not_modified = { status: cond && cond.ok ? cond.status : null, used_before: u0, used_after: used() };
  rec.fact('real_github_spike', spike);
  const moved = ['info_refs', 'raw', 'codeload'].filter((k) => spike[k] && spike.before !== null && spike[k].used_after !== null && spike[k].used_after > spike.before);
  if (moved.length) rec.finding('no-clone:real-public-route-charged', 'real-github', `el tope anónimo de la API subió después de ${moved.join(', ')} (${JSON.stringify(spike).slice(0, 300)}); la conexión del agente se comparte: puede ser otro`, 'W8', { severity: 'loses-control' });
  if (!heads.ok) rec.finding('no-clone:real-info-refs-unreadable', 'real-github', `info/refs de GitHub no se pudo leer (${JSON.stringify(spike.info_refs)})`, 'W8', { severity: 'breaks' });
  // T16: la instalación y mirar, con el código de la rama, contados con el registro
  const apiCalls = () => { try { return fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => /api\.github\.com/.test(o.origin) && !/rate_limit/.test(o.path)).map((o) => o.path); } catch (_) { return []; } };
  const runP = (args, label, extra = {}) => {
    try { fs.rmSync(trace, { force: true }); } catch (_) { /* nada */ }
    const r = L.run(process.execPath, [path.join(program, 'scripts', 'setup', 'harness.js'), ...args], { env: Object.assign({}, env, extra), timeoutMs: CMD_TIMEOUT_MS, cap: 4000 });
    const calls = apiCalls();
    rec.fact(label, { exit: r.exit, api: calls, out: lastLines(`${r.stdout}\n${r.stderr}`, 3) });
    return { r, calls };
  };
  const limited = (r) => /GitHub limita las consultas/.test(`${r.stdout}${r.stderr}`);
  const inst = runP(['install', '--version', 'latest', '--yes'], 'real_install');
  if (inst.r.exit !== 0 && limited(inst.r)) rec.note(`GitHub real: la API anónima del agente estaba en su tope; la instalación lo dijo con la hora (${lastLines(inst.r.stdout, 1)})`);
  else if (inst.r.exit !== 0) rec.finding('no-clone:real-install-fails', 'real-github', `install --version latest contra el GitHub real salió ${inst.r.exit}: ${lastLines(`${inst.r.stdout}\n${inst.r.stderr}`, 2)}`, 'W8', { severity: 'breaks' });
  else if (inst.calls.length !== 1 || !/git\/commits\//.test(inst.calls[0])) rec.finding('no-clone:real-install-api', 'real-github', `la instalación gastó ${inst.calls.length} consulta(s) a la API (se esperaba 1, git/commits): ${inst.calls.join(' ')}`, 'W8', { severity: 'loses-control' });
  if (inst.r.exit !== 0) return null;
  const look = runP(['update', '--check'], 'real_check');
  if (![0, 3].includes(look.r.exit)) rec.finding('no-clone:real-check-fails', 'real-github', `update --check salió ${look.r.exit}: ${lastLines(`${look.r.stdout}\n${look.r.stderr}`, 2)}`, 'W8', { severity: 'breaks' });
  if (look.calls.length) rec.finding('no-clone:real-check-api', 'real-github', `mirar gastó ${look.calls.length} consulta(s) a la API: ${look.calls.join(' ')}`, 'W8', { severity: 'loses-control' });
  const closed = runP(['update', '--check'], 'real_check_api_closed', { TYCON_RELEASE_API: 'http://127.0.0.1:9', TYCON_RELEASE_GIT: 'https://github.com' });
  if (![0, 3].includes(closed.r.exit)) rec.finding('no-clone:real-check-needs-api', 'real-github', `con la API en un puerto cerrado, update --check salió ${closed.r.exit}: ${lastLines(`${closed.r.stdout}\n${closed.r.stderr}`, 2)}`, 'W8', { severity: 'loses-control' });
  // en Windows: get-harness.ps1 con la API cerrada baja igual (main de info/refs, el comprimido de codeload)
  const ps = isWin ? L.scanPath('pwsh', { env })[0] : null;
  if (!ps) { rec.note('GitHub real: get-harness.ps1 no medido (sin Windows o sin pwsh)'); return null; }
  const home3 = path.join(base, 'users', 'lab-real-get-harness');
  fs.mkdirSync(home3, { recursive: true });
  const env3 = Object.assign(T.rehearsalEnv(home3, { base: baseEnv, platform, extra: { TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1', TYCON_PROFILE: profile, TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_BENCH_DAILY: '0' } }), { TYCON_RELEASE_API: 'http://127.0.0.1:9', TYCON_RELEASE_GIT: 'https://github.com' });
  delete env3.TYCON_RELEASE_RAW; delete env3.TYCON_RELEASE_ARCHIVE;
  const g = L.run(ps, ['-NoProfile', '-NonInteractive', '-File', path.join(program, 'scripts', 'setup', 'get-harness.ps1'), '--', '--yes'], { env: env3, timeoutMs: CMD_TIMEOUT_MS, cap: 4000 });
  const gout = `${g.stdout}\n${g.stderr}`;
  const downloaded = /bajo .* a una carpeta temporal/.test(gout) && !/no pude bajar el comprimido/.test(gout);
  rec.fact('real_get_harness_ps1', { exit: g.exit, downloaded, out: lastLines(gout, 3) });
  if (!downloaded) rec.finding('no-clone:real-get-harness-needs-api', 'real-github', `get-harness.ps1 con la API cerrada no bajó: ${lastLines(gout, 2)}`, 'W8', { severity: 'loses-control' });
  return null;
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`no-clone-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`no-clone-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, out: path.resolve(args.out), allowTemp: Boolean(args['allow-temp']), rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  say(`no-clone: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, measure, measureRealGithub };
