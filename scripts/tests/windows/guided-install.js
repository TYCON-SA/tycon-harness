'use strict';
/**
 * guided-install.js — el alta en Windows SIGUIENDO LA PÁGINA PÚBLICA (`getting-started/windows.md`), comando por comando,
 * y después la capa del equipo. Lo llama `onboarding-probe.js` cuando lo que se ensaya es una copia publicada (trae
 * `version.json`): ése es el árbol donde la página y el guion de entrada están en su lugar.
 *
 * POR QUÉ EXISTE. El equipo se instala siguiendo esa página, y nadie la había corrido entera en un Windows: ni el guion
 * de entrada con el programa de verdad, ni la primera sesión después del alta, ni la capa del equipo encima.
 *
 * QUÉ HACE
 *   1. Antes de correr nada, comprueba la ficha contra la página del commit que se ensaya (`guided-page.js`). Si no
 *      coinciden, o falta algo que una copia publicada tiene que traer, el paso sale «error»: nunca ensaya a medias.
 *   2. Levanta el laboratorio de juguete (`toy-lab.js`): un GitHub que sirve ese árbol como lo declara la ficha
 *      (`lab.auth`) —hoy `none`: un repo PÚBLICO, sin permiso, que es lo que la página supone al bajar el guion sin
 *      credencial; con `token`, privado y con su permiso de juguete— y un Azure DevOps con el repo del equipo.
 *   3. Por cada variante, en su propia carpeta de usuario de laboratorio:
 *        guided        una máquina con Claude Code y PowerShell 7. Corre los pasos de la máquina en el orden de la
 *                      página, cada comando tal cual en su propio proceso de `pwsh`; saca la foto; abre la primera
 *                      sesión por dos formas de lanzar, ESPERANDO al trabajo que se desprende del arranque; suma la
 *                      capa del equipo con sus dos comandos y comprueba lo que el alta del equipo manda comprobar.
 *        guided-ps51   una máquina que sólo tiene el PowerShell 5.1 de Windows. La página manda parar ahí: se mide
 *                      que frene limpio y lo diga. Aparte, declarado como fuera de la página, lo que encontraría
 *                      quien siguiera igual; y que la máquina haya quedado como estaba.
 *   4. Deja anotada la instalación en `lab-state.json`, para `count-hooks` y `fire-registered`.
 *
 * Al laboratorio se le cambian DOS cosas de la página, las dos declaradas en la ficha: la línea npx
 * corre el paquete armado con `npm pack` del commit que se ensaya en lugar del publicado (`lab.package`), y el paso de
 * instalar lleva al final la respuesta de la persona (`lab.answer`: el «s» a «¿Instalo?», que el agente no puede dar sin
 * terminal). Esos pasos van además con las rutas públicas del GitHub de juguete y la caché de npm del laboratorio. Todo
 * lo que se puso o se cambió respecto de la máquina de una persona queda dicho en `facts.lab_changes`, y el informe dice
 * en una línea dónde se puso la respuesta de la persona: no se lee como un verde total. Lo que no se corre (lo que hace la persona, lo que sale
 * a la red de verdad) va a `facts.not_rehearsed`, con su motivo.
 *
 * CÓMO FALLA. Un alta que sale mal es un HECHO del reporte, con su gravedad. Lo que el ensayo encuentra no se arregla
 * acá. «Error» es no haber podido ensayar: la página sin su marca, un servidor de juguete que no levantó, una variante
 * que tiró.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const T = require('./team-lab.js');
const G = require('./guided-page.js');
const TL = require('./toy-lab.js');
const RP = require('./release-photo.js');

const NAME = 'onboarding';
const VARIANTS = Object.freeze([
  // `required`: la principal del paso — si no puede ni empezar, el paso no ensayó (queda en «error», no en «medido»)
  { id: 'guided', home: ['users', 'guided'], ps: 'pwsh', required: true, what: 'una máquina con Claude Code y PowerShell 7' },
  { id: 'guided-ps51', home: ['users', 'guided-ps51'], ps: 'powershell', what: 'una máquina que sólo tiene el PowerShell 5.1 de Windows' },
]);
// los pasos de la página que llevan el permiso de GitHub en su ambiente CUANDO EL LABORATORIO TIENE UNO (`lab.auth:
// token`): en los demás no está nunca. Con `lab.auth: none` —la ficha de hoy— el laboratorio no arma ninguno y ningún
// paso lo lleva: una persona que sigue la página tampoco lo tiene
const TOKEN_STEPS = Object.freeze(['plan', 'install']);
// los archivos del paquete de npm, como los arma el workflow que publica (scripts/setup/npm/ más el LICENSE de la raíz)
const PACKAGE_FILES = Object.freeze(['package.json', 'index.js', 'home-paths.json', 'README.md']);

/**
 * El paquete de npm del commit que se ensaya, armado con `npm pack` como lo arma el workflow que publica: `{ tgz }` o
 * `{ problem }`. Va en la carpeta del paso; la caché de npm, también (nunca la de quien lanza).
 */
function packageFor(ctx, state) {
  const npm = require('./npx-probe.js').npmProgram('npm');
  if (!npm) return { problem: `este Node (${process.execPath}) no trae npm a su lado: sin npm no se arma el paquete que corre la línea npx` };
  const harness = state.remotes.harness;
  const src = path.join(ctx.dir, 'package-src');
  const dest = path.join(ctx.dir, 'package');
  try {
    fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dest, { recursive: true });
    for (const [rel, to] of [...PACKAGE_FILES.map((f) => [`scripts/setup/npm/${f}`, f]), ['LICENSE', 'LICENSE']]) {
      const text = T.showFile(harness.dir, harness.target, rel, ctx.genv);
      if (text === null || text === undefined) return { problem: `el commit que se ensaya no trae ${rel}: sin él no se arma el paquete de npm` };
      fs.writeFileSync(path.join(src, to), text);
    }
  } catch (e) { return { problem: `no pude armar los archivos del paquete de npm: ${e.code || e.message}` }; }
  const env = Object.assign({}, ctx.genv, npmEnv(ctx));
  const r = L.run(process.execPath, [npm, 'pack', '--silent', '--pack-destination', dest], { cwd: src, env, timeoutMs: 5 * 60 * 1000 });
  const name = String(r.stdout || '').trim().split('\n').pop().trim();
  const tgz = path.join(dest, name);
  if (r.exit !== 0 || !name || !fs.existsSync(tgz)) return { problem: `npm pack salió ${r.error || r.exit}: ${L.firstLine(r.stderr) || 'sin decir nada'}` };
  return { tgz };
}
/** Lo de npm en el laboratorio: su caché en la carpeta del paso, sin avisos ni auditorías que salgan a la red. */
const npmEnv = (ctx) => ({ npm_config_cache: path.join(ctx.dir, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' });
/**
 * Sin el paquete armado no se sigue la página: la línea npx correría el publicado (y saldría al registro de verdad), y eso
 * no es ensayar el commit. Tira, y quien corre las variantes lo anota como «no pude ensayar».
 */
function needPackage(ctx) {
  const m = ctx.manifest;
  const uses = G.machineSteps(m).some((s) => s.commands.some((c) => c.text.startsWith(`${m.lab.package.from} `)));
  if (uses && !ctx.package) throw new Error('sin el paquete armado del commit que se ensaya no sigo la página: la línea npx correría el publicado');
}
/**
 * El ambiente de un comando con la línea npx: las tres rutas públicas del GitHub de juguete (git, el comprimido y el
 * crudo) y npm. Las tres: con git puesto, el cliente del arnés completa la que falte con la de verdad.
 */
const npxEnv = (env, ctx) => Object.assign({}, env, { TYCON_RELEASE_GIT: String(ctx.git), TYCON_RELEASE_ARCHIVE: String(ctx.archive), TYCON_RELEASE_RAW: String(ctx.raw) }, npmEnv(ctx));
/**
 * El ambiente de un paso: con el permiso de GitHub de juguete sólo si el laboratorio tiene uno y el paso es de los que
 * lo usan. En todo otro caso el paso corre SIN la variable, traiga lo que traiga el ambiente que le pasan: «ningún paso
 * llevó un permiso» lo asegura este lugar, no que quien armó el ambiente se haya acordado de limpiarlo.
 */
const stepEnv = (env, tokens, uses) => {
  const bare = Object.fromEntries(Object.entries(env || {}).filter(([k]) => !/^TYCON_GITHUB_TOKEN$/i.test(k)));
  return uses && tokens && tokens.github ? TL.withToken(bare, tokens.github) : bare;
};
/** Cómo sirve el GitHub de juguete el árbol que se ensaya, dicho para el reporte. */
const githubServing = (ctx) => (ctx.tokens && ctx.tokens.github ? 'privado, con un permiso de juguete' : 'público, sin permiso (la línea npx baja el arnés sin credencial)');
const round = (ms) => Math.round(ms / 100) / 10;

/** «No pude ensayar»: el resultado del paso cuando falta algo sin lo cual no hay ensayo. Nunca «no medido». */
const notReady = (problem) => ({ status: L.STATUS.error, reason: `no pude ensayar: ${problem}` });

/** Los argumentos de un comando de la capa del equipo (`harness.js …`), con la dirección del repo en su hueco. */
function teamArgs(text, { teamUrl = TL.TEAM_URL } = {}) {
  return String(text).replace(/^harness\.js\s+/, '').split(/\s+/).filter(Boolean).map((a) => (a === '<team-url>' ? teamUrl : a));
}

// ── el laboratorio de un paso ────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que el paso necesita antes de la primera variante: la página comprobada contra la ficha, los dos servidores de
 * juguete y el repo del equipo. `{ problem }` si algo falta: no es un hallazgo de la máquina, es no poder ensayar.
 */
function openLab({ lab, name, state, baseEnv = process.env, platform = process.platform, manifest = G.loadManifest(), start = {} }) {
  // cómo se levanta cada servidor de juguete (las pruebas pasan uno que no levanta)
  const startGitHub = start.github || TL.startGitHub;
  const startAzure = start.azure || TL.startAzure;
  const harness = state.remotes.harness;
  const genv = TL.gitEnv(lab, { base: baseEnv, platform });
  // un archivo del commit que se ensaya: su texto, `null` si no está, o tira si git no lo pudo decir
  const read = (rel) => {
    const has = T.fileAt(harness.dir, harness.target, rel, genv);
    if (has.problem) throw new Error(`${rel}: ${has.problem}`);
    if (!has.present) return null;
    const text = T.showFile(harness.dir, harness.target, rel, genv);
    if (text === null) throw new Error(`${rel}: el commit lo trae y git show no lo devolvió`);
    return text;
  };
  const guide = G.prepare({ read, manifest });
  // el tapador del reporte se arma apenas se saben los nombres: un motivo de «no pude ensayar» también pasa por él (el
  // de «la página y la ficha no coinciden» cita comandos que traen el nombre del repo público)
  const redactOf = (secrets) => TL.redactor({ secrets, env: baseEnv, publicUrl: `https://github.com/${guide.names.org}/${guide.names.repo}` });
  if (guide.problem) return { problem: guide.names ? redactOf([])(guide.problem) : guide.problem };
  const dir = path.join(lab, 'guided', name);
  // el laboratorio de un paso es de una sola corrida: lo que dejó la anterior (el repo del equipo, la copia «autor»,
  // las carpetas de usuario ya instaladas) haría fallar a ésta más adelante, con un motivo que no orienta
  if (fs.existsSync(dir)) return { problem: `el paso ${name} ya corrió sobre este laboratorio (existe ${dir}): el laboratorio de un paso es de una sola ejecución — para repetirlo, o para correr otra variante, armá un laboratorio nuevo con «init»` };
  const noTools = path.join(dir, 'no-tools');
  try { fs.mkdirSync(noTools, { recursive: true }); } catch (e) { return { problem: `no pude crear ${dir}: ${e.code || e.message}` }; }
  // lo que ya levantó se cierra pase lo que pase: un servidor de juguete no queda vivo si lo que sigue falla o tira
  const started = [];
  const stop = () => { for (const s of started.splice(0)) { try { s.stop(); } catch (_) { /* ya no está */ } } };
  // si el laboratorio del paso no se pudo armar, no corrió nada: se cierra lo levantado y se saca la carpeta, para que
  // el mismo paso se pueda volver a intentar sobre este laboratorio. Se reintenta el borrado (en Windows el servidor
  // recién cerrado puede tener todavía abierto un archivo suyo); si igual queda, se dice: el reintento contestaría «ya
  // corrió», y no es cierto
  const failed = (problem) => {
    stop();
    let left = null;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch (e) { left = e.code || e.message; }
    if (!left && fs.existsSync(dir)) left = 'sigue ahí';
    return { problem: redactOf([])(left ? `${problem} — además no pude sacar la carpeta del paso (${dir}: ${left}): para reintentar hace falta un laboratorio nuevo, o borrarla a mano` : problem) };
  };
  try {
    const gitBin = L.scanPath('git', { env: genv, platform })[0] || 'git';
    // el permiso de GitHub de juguete existe sólo si la ficha manda servir el repo como privado (`lab.auth: token`).
    // Con `none` no se arma: lo que no existe no puede terminar en el ambiente de un paso ni en la salida de un comando
    const tokens = Object.assign(manifest.lab.auth === 'token' ? { github: TL.toyToken('github') } : {}, { azure: TL.toyToken('azure') });
    const github = startGitHub({ dir: path.join(dir, 'servers'), bare: harness.dir, org: guide.names.org, name: guide.names.repo, gitBin, env: genv, token: tokens.github || null });
    if (github.problem) return failed(github.problem);
    started.push(github);
    const team = TL.makeTeamRepo({ dir: path.join(dir, 'team'), env: genv });
    if (team.problem) return failed(team.problem);
    const azure = startAzure({ dir: path.join(dir, 'servers'), bare: team.bare, gitBin, env: genv, pat: tokens.azure });
    if (azure.problem) return failed(azure.problem);
    started.push(azure);
    const redact = redactOf([tokens.github, tokens.azure]);
    // `discard(problem)`: para quien, con el laboratorio ya abierto, no puede seguir armándolo (cierra y saca la
    // carpeta, igual que si hubiera fallado acá) — devuelve el motivo, ya tapado
    return { manifest, guide, dir, genv, gitBin, tokens, api: github.url, raw: github.raw, git: github.git, archive: github.archive, azureApi: azure.url, team, noTools, redact, stop, discard: (problem) => failed(problem).problem };
  } catch (e) {
    return failed(`no pude armar el laboratorio del paso: ${e.message}`);
  }
}

/** Lo que va al reporte de todo paso guiado, antes de la primera variante. */
function noteLab(rec, ctx, state, platform) {
  const m = ctx.manifest;
  rec.fact('guided', true);
  rec.fact('lab_mode', !L.isWin(platform));
  rec.fact('commits', { harness: state.remotes.harness.target, sources: state.sources });
  // el número de versión de la copia que se ensaya (el de su version.json). Si no se deja leer, queda dicho por qué:
  // de ese número salen los de las versiones de juguete
  let rehearsed = null;
  try {
    rehearsed = JSON.parse(String(T.showFile(state.remotes.harness.dir, state.remotes.harness.target, 'version.json', ctx.genv)).replace(/^﻿/, '')).version || null;
    if (!rehearsed) rec.note('el version.json de la copia que se ensaya no trae un número de versión: las versiones de juguete se numeran desde 2030');
  } catch (e) { rec.note(`no pude leer el número de versión de la copia que se ensaya (version.json: ${e.message}): las versiones de juguete se numeran desde 2030`); }
  rec.fact('rehearsed_version', rehearsed);
  rec.fact('page', { file: m.page.published, mark: m.page.mark, at: state.remotes.harness.target, page_name_from: ctx.guide.page_name_from, page_steps: ctx.guide.page_steps, entry_package: ctx.guide.entry_package });
  rec.fact('not_rehearsed', G.notRehearsed(m));
  rec.fact('toy_servers', { github: { api: ctx.api, raw: ctx.raw, repo: githubServing(ctx) }, azure: { api: ctx.azureApi, team: TL.TEAM_URL, team_commit: ctx.team.commit } });
}

/**
 * La carpeta de usuario de una variante y su ambiente, armado desde limpio. `null` si no se pudo (el motivo queda en
 * `facts.not_run`).
 */
function openVariant({ ctx, lab, prefix, v, facts, platform = process.platform, allowTemp = false, baseEnv = process.env }) {
  const home = path.join(lab, ...v.home);
  const scratch = path.join(lab, 'scratch', `${prefix}-${v.id}`);
  facts.home = home;
  // primero se comprueba que la carpeta es del laboratorio; recién después se escribe en ella
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) { facts.not_run = problem; return null; }
  try { TL.makeHome(home); } catch (e) { facts.not_run = `no pude crear ${home}: ${e.code || e.message}`; return null; }
  const made = TL.variantEnv(home, { base: baseEnv, platform, api: ctx.api, detectPath: ctx.noTools });
  const seen = L.run(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env: made.env, timeoutMs: 30000, cap: 600 });
  if (seen.exit !== 0 || !L.samePath(L.realOrSelf(seen.stdout.trim()), L.realOrSelf(home), platform)) { facts.not_run = `os.homedir() devuelve «${seen.stdout.trim()}», no la carpeta de laboratorio`; return null; }
  return { home, scratch, env: made.env, changes: made.lab_changes, window: path.join(scratch, 'window') };
}

/**
 * Todo lo que el laboratorio puso o cambió respecto de la máquina de una persona (va entero al reporte). Lo anota
 * TODA variante que corre, no sólo la principal: `own` es lo propio de esa variante (por ejemplo, `pwsh` quitado del
 * PATH, o el guion de entrada puesto por el laboratorio).
 */
function labChanges({ ctx, changes, ps, env, scratch }) {
  const m = ctx.manifest;
  const where = [];
  for (const s of G.machineSteps(m)) for (const [i, c] of s.commands.entries()) if (c.text.startsWith(`${m.lab.package.from} `)) where.push(`${s.id}[${i}]`);
  let effective = null;
  if (ps) { const r = TL.runPage({ ps, text: 'Get-ExecutionPolicy', cwd: path.join(scratch, 'window'), env, scratch, id: 'execution-policy', timeoutMs: 60000 }); effective = L.firstLine(r.stdout) || `no pude leerla (${r.error || r.exit})`; }
  return {
    // los dos cambios de la ficha: el paquete armado, y la respuesta de la persona
    package: { from: m.lab.package.from, to: m.lab.package.to.split(G.PACKAGE_MARK).join(ctx.package || '<sin armar>'), where: where.join(', '), why: m.lab.package.why },
    answer: { step: m.lab.answer.step, append: m.lab.answer.append, why: m.lab.answer.why },
    public_routes: { TYCON_RELEASE_GIT: ctx.git, TYCON_RELEASE_ARCHIVE: ctx.archive, TYCON_RELEASE_RAW: ctx.raw, where: where.join(', ') },
    token: ctx.tokens && ctx.tokens.github
      ? `TYCON_GITHUB_TOKEN: el permiso de juguete del GitHub de juguete, sólo en los pasos ${TOKEN_STEPS.join(', ')}`
      : 'TYCON_GITHUB_TOKEN: no se pone en ningún paso (el GitHub de juguete sirve el repo como público, sin permiso)',
    env_set: changes.env_set,
    env_set_with_team: { TYCON_AZURE_API: ctx.azureApi, TYCON_AZURE_GIT_CREDENTIAL: '0' },
    env_removed: changes.env_removed,
    never_set: changes.never_set,
    always: changes.always,
    launched_with: changes.launched_with,
    execution_policy: { launched_with: 'Bypass', effective },
    by_variant: {},
  };
}
/**
 * Anota lo que el laboratorio cambió, sin pisar lo que ya anotó otra variante del mismo paso: lo común se anota una
 * vez (es el mismo para todas) y lo propio de cada variante va bajo su nombre.
 */
function noteLabChanges(rec, { ctx, v, home, changes, ps, env, scratch, own = {} }) {
  const all = rec.step.facts.lab_changes || labChanges({ ctx, changes, ps, env, scratch });
  all.by_variant[v.id] = Object.assign({ user_folder: home, shell: v.ps || 'pwsh' }, own);
  rec.fact('lab_changes', all);
  return all;
}

// ── seguir la página ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Corre los pasos de la máquina de la página, en su orden: cada comando tal cual (con el único cambio del laboratorio)
 * en su propio proceso de PowerShell, todos en la misma carpeta de trabajo. `{ commands, findings }`. `only`: sólo esos
 * pasos (por identificador).
 *
 * Cada comando queda anotado APENAS termina: `commands` es el arreglo donde se van sumando las filas (quien llama pasa
 * el de sus `facts`) y `each(findings)` se llama después de cada comando con lo que ese comando encontró. Así, si el
 * paso se corta por su tope con un comando colgado, el parcial dice qué comandos habían corrido y cuál no volvió.
 */
function followPage({ ctx, home, env, ps, scratch, cwd, id, only = null, platform = process.platform, say = () => {}, commands = [], each = () => {} }) {
  const m = ctx.manifest;
  const findings = [];
  needPackage(ctx);
  for (const step of G.machineSteps(m).filter((s) => !only || only.includes(s.id))) {
    let previous = null;
    for (const [i, cmd] of step.commands.entries()) {
      const real = G.withNames(cmd.text, ctx.guide.names);
      const row = { step: step.id, runs: step.runs, text: real };
      commands.push(row);
      const decided = G.shouldRun(cmd, previous, { platform });
      if (!decided.run) { Object.assign(row, decided.not_comparable ? { not_comparable: decided.not_comparable } : { skipped: decided.skipped }); each([]); continue; }
      const lab = G.labText(real, m, { pkg: ctx.package, step: step.id });
      if (lab.changed) row.lab_changed = { from: lab.from, to: lab.to };
      if (lab.answer) row.lab_answer = lab.answer;
      // queda dicho que este comando arrancó, antes de esperarlo: si no vuelve, el parcial lo nombra
      row.started = L.nowIso();
      each([]);
      const own = stepEnv(env, ctx.tokens, TOKEN_STEPS.includes(step.id));
      const raw = TL.runPage({ ps, text: lab.text, cwd, env: lab.changed ? npxEnv(own, ctx) : own, scratch, id: `${id}-${step.id}-${i + 1}` });
      // los permisos se buscan en la salida CRUDA, antes de taparla
      const safe = TL.checked(raw, ctx.tokens, `paso ${step.id}`);
      // se juzga sobre la salida ya TAPADA: lo «medido» de cada cosa esperada va al reporte, y sale de esa salida
      const judged = G.judge(step, cmd, safe.clean, { home, cwd });
      const found = [...safe.findings, ...judged.findings];
      findings.push(...found);
      Object.assign(row, { exit: raw.exit, error: raw.error, timed_out: raw.timed_out, seconds: round(raw.ms), expected: judged.checks, out: L.clip(safe.clean.stdout, 1500), err: L.clip(safe.clean.stderr, 1500) });
      if (raw.not_found && raw.not_found.length) row.not_found = raw.not_found;
      if (Object.keys(judged.noted).length) row.noted = judged.noted;
      // (la salida ya tapada: el motivo de un «salteado» puede citarla)
      previous = safe.clean;
      each(found);
      say(`  ${id} · ${step.id}[${i + 1}]: ${raw.error ? `no arrancó (${raw.error})` : `salió ${raw.exit}`} (${row.seconds} s)${found.length ? ` — ${found.map((f) => f.id).join(', ')}` : ''}`);
    }
  }
  return { commands, findings };
}

// ── la capa del equipo ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Suma la capa del equipo con los dos comandos de la ficha, contra el Azure DevOps de juguete, y comprueba lo que el
 * alta del equipo manda comprobar. `{ env, facts, findings }`: `env` es el ambiente de ahí en más (con el Azure de
 * juguete). Cada cosa que no quedó es un hallazgo `guided:team:<qué>`.
 */
function addTeam({ ctx, home, env, tree, paths }) {
  const m = ctx.manifest;
  const tenv = TL.teamEnv(env, ctx.azureApi);
  const findings = [];
  const facts = { url: TL.TEAM_URL, commands: [] };
  // toda salida que se mira pasa por acá: los permisos se buscan en la cruda y lo que sigue usa la tapada
  const seen = (raw, where) => { const safe = TL.checked(raw, ctx.tokens, where); findings.push(...safe.findings); return safe.clean; };
  const run = (cmd, input) => {
    const raw = TL.harness(tree, teamArgs(cmd.text), { env: tenv, input, cwd: home });
    const clean = seen(raw, `la capa del equipo («${cmd.text}»)`);
    facts.commands.push({ text: cmd.text, exit: raw.exit, error: raw.error, seconds: round(raw.ms), out: L.clip(TL.lastLines(`${clean.stdout}\n${clean.stderr}`, 4), 600) });
    return clean;
  };
  // los dos comandos, por lo que son y no por su lugar en la ficha: el permiso entra sólo por la entrada estándar del
  // que la declara
  const cmds = G.teamCommands(m);
  if (cmds.problem) throw new Error(`la ficha no dice bien los comandos de la capa del equipo: ${cmds.problem}`);
  const saved = run(cmds.token, ctx.tokens.azure);
  const inst = saved.error || saved.exit !== 0 ? null : run(cmds.install);
  if (!inst || inst.error || inst.exit !== 0) {
    const bad = inst ? [cmds.install, inst] : [cmds.token, saved];
    findings.push({ id: 'guided:team:install-failed', severity: T.SEVERITY.breaks, kind: 'team', detail: `la capa del equipo: «${bad[0].text}» ${bad[1].error ? `no arrancó (${bad[1].error})` : `salió ${bad[1].exit}`} — ${L.clip(TL.lastLines(`${bad[1].stdout}\n${bad[1].stderr}`, 3), 400)}${inst ? '' : ' (el comando que instala con la capa no se corrió: sin el permiso guardado no tiene con qué)'}` });
    return { env: tenv, facts, findings };
  }
  // el estado dice de qué repo y qué commit es la capa, y el árbol la trae apilada. Un estado que está y no se deja
  // leer TIRA (`stateOf`): no es «la capa no quedó», es no poder saberlo
  const st = TL.stateOf(paths);
  const team = st && st.team && typeof st.team === 'object' ? st.team : null;
  let stacked = null;
  let stackedProblem = null;
  try { stacked = TL.readJson(path.join(tree, '.tycon-team.json')).commit || null; } catch (e) { stacked = null; stackedProblem = e.code === 'ENOENT' ? 'el árbol no trae .tycon-team.json' : `.tycon-team.json no se pudo leer: ${e.code || e.message}`; }
  facts.state = team ? { repo: team.repo || null, host: team.host || null, commit: team.commit || null } : null;
  facts.stacked = { commit: stacked, profile_in_tree: fs.existsSync(path.join(tree, 'perfil-equipo.json')), problem: stackedProblem };
  if (!team || !team.repo || !team.commit || !facts.stacked.profile_in_tree || stacked !== team.commit) findings.push({ id: 'guided:team:not-stacked', severity: T.SEVERITY.breaks, kind: 'team', detail: `la instalación con la capa salió 0 pero la capa no quedó apilada: el estado dice ${JSON.stringify(facts.state)}, el árbol ${JSON.stringify(facts.stacked)} (se esperaba el commit ${ctx.team.commit})` });
  // la configuración: la organización, las integraciones y los paquetes, con origen en el perfil
  const explained = seen(L.run(process.execPath, [path.join(tree, 'scripts', 'lib', 'tycon-config.js'), 'explain', '--json'], { env: tenv, cwd: home, timeoutMs: 60000, cap: 400000 }), 'la capa del equipo (tycon-config.js explain --json)');
  let origins = null;
  try { origins = JSON.parse(explained.stdout).origenes || null; } catch (_) { origins = null; }
  const fromProfile = origins ? Object.fromEntries(Object.entries(origins).filter(([, from]) => /perfil/.test(String(from)))) : null;
  facts.profile_origin = fromProfile;
  const want = [['la organización', /^ado\.org$/], ['las integraciones', /^integra[a-z]*\./], ['los paquetes', /^pa[a-z]*\.default$/]];
  // de lo que no sale del perfil, de dónde sale (lo que la persona eligió al instalar le gana al perfil del equipo)
  const elsewhere = (rx) => Object.entries(origins || {}).filter(([k]) => rx.test(k)).map(([k, from]) => `${k}: ${from}`).join(', ');
  const missing = want.filter(([, rx]) => !fromProfile || !Object.keys(fromProfile).some((k) => rx.test(k))).map(([what, rx]) => `${what}${elsewhere(rx) ? ` (${elsewhere(rx)})` : ''}`);
  if (missing.length) findings.push({ id: 'guided:team:profile-origin', severity: T.SEVERITY.loses, kind: 'team', detail: `con la capa puesta, la configuración no muestra con origen en el perfil del equipo: ${missing.join('; ')}${origins ? '' : ` (tycon-config.js explain --json salió ${explained.error || explained.exit}: ${L.clip(L.firstLine(explained.stderr) || L.firstLine(explained.stdout), 200)})`}` });
  // la versión trae la capa con su commit
  const versioned = seen(TL.harness(tree, ['version', '--json'], { env: tenv, cwd: home, timeoutMs: 60000 }), 'la capa del equipo (harness.js version --json)');
  let vj = null;
  try { vj = JSON.parse(versioned.stdout); } catch (_) { vj = null; }
  facts.version_json = vj ? { number: vj.number || null, kind: vj.kind || null, team: vj.team ? { commit: vj.team.commit || null, repo: vj.team.repo || null } : null } : null;
  if (!vj || !vj.team || !vj.team.commit) findings.push({ id: 'guided:team:version-without-team', severity: T.SEVERITY.loses, kind: 'team', detail: `harness.js version --json (salió ${versioned.error || versioned.exit}) no trae la capa del equipo con su commit: ${L.clip(L.firstLine(versioned.stdout) || L.firstLine(versioned.stderr), 200)}` });
  // y el diagnóstico la nombra
  const doctor = T.doctorFacts(path.join(tree, 'scripts', 'setup', 'harness.js'), tenv, home);
  facts.doctor_line = doctor.readable ? (doctor.ok || []).find((l) => /^capa del equipo /.test(l)) || null : null;
  facts.doctor = { readable: doctor.readable, fail: doctor.fail || null };
  if (!facts.doctor_line) findings.push({ id: 'guided:team:doctor-line', severity: T.SEVERITY.loses, kind: 'team', detail: `harness.js doctor --json ${doctor.readable ? 'no nombra la capa del equipo entre lo que está bien' : `no se pudo leer (${doctor.problem || ''})`}` });
  return { env: tenv, facts, findings };
}

// ── las variantes ────────────────────────────────────────────────────────────────────────────────────────────────

function runGuided({ ctx, v, facts, save, lab, out, platform, allowTemp, baseEnv, rec, add, say, usable, waitCapMs, waitBudgetMs }) {
  const opened = openVariant({ ctx, lab, prefix: NAME, v, facts, platform, allowTemp, baseEnv });
  if (!opened) return false;
  const { home, scratch, env, window } = opened;
  const ps = L.scanPath(v.ps, { env, platform })[0] || null;
  if (!ps) { facts.not_run = `no hay ${v.ps} en esta máquina: la página pide PowerShell 7`; return false; }
  facts.ps = v.ps;
  noteLabChanges(rec, { ctx, v, home, changes: opened.changes, ps, env, scratch });
  say(`onboarding: ${v.id} — el alta siguiendo la página (${v.what}) en ${home}`);
  // cada comando y lo que encontró quedan en el parcial apenas termina (si el paso se corta, no se pierden)
  facts.commands = [];
  followPage({ ctx, home, env, ps, scratch, cwd: window, id: `${NAME}-${v.id}`, platform, say, commands: facts.commands, each: (found) => { for (const f of found) add(f); save(); } });
  const tree = path.join(home, '.tycon', 'harness');
  const read = TL.versionFacts(tree);
  facts.version = read.number;
  const count = (sev) => rec.step.findings.filter((f) => f.variant === v.id && f.severity === sev).length;
  const answer = () => { facts.answers = { usable: count(T.SEVERITY.breaks) === 0, by_severity: { breaks: count(T.SEVERITY.breaks), 'loses-control': count(T.SEVERITY.loses), noise: count(T.SEVERITY.noise) } }; save(); };
  if (!facts.version) {
    // «no quedó una versión» son dos cosas: no hay version.json (la instalación no dejó nada: ya lo dijo su paso), o
    // está y no se deja leer — eso rompe, y se dice con su nombre
    if (read.problem) add({ id: 'version:unreadable', severity: T.SEVERITY.breaks, kind: 'version', detail: `después del alta, el árbol instalado no trae un número de versión legible (${read.problem}): no se sabe qué versión quedó` });
    say(`onboarding: ${v.id} — no quedó una versión instalada en ${tree}${read.problem ? ` (${read.problem})` : ''}: no hay sesión ni capa que ensayar`);
    answer();
    return true;
  }
  const paths = TL.statePaths({ home, env, tree });
  if (paths.problem) throw new Error(paths.problem);
  const settings = path.join(home, '.claude', 'settings.json');
  facts.installed = RP.photo({ home, tree, env, paths, platform });
  for (const d of RP.judgePhoto(facts.installed)) add(d);
  try { if (facts.installed.settings.exists && !facts.installed.settings.problem) L.writeJsonAtomic(path.join(out, `settings-onboarding-${v.id}.json`), ctx.redact(T.readJsonLoose(settings).value)); } catch (_) { /* la copia es de cortesía */ }
  save();
  const p = facts.installed;
  say(`onboarding: ${v.id} — quedó la versión ${facts.version}: ${(p.settings.hooks || []).length} hook(s) (faltan ${p.expected.problem ? '?' : p.expected.missing.length} de ${p.expected.problem ? '?' : p.expected.expected_total}) · enlaces ${p.links.map((l) => `${l.name}:${l.ok ? 'bien' : (l.present ? 'MAL' : 'FALTA')}`).join(' ')} · doctor ${p.doctor.readable ? `${p.doctor.mode}, ${p.doctor.fail.length} rojo(s)` : 'ilegible'}`);

  // la primera sesión: lo que corre solo al abrirla, tal como quedó registrado, sin apagar el desprendimiento
  const forms = T.launchForms({ env, platform, scratch });
  const budget = { left_ms: waitBudgetMs };
  const open = (formId, label, sessionEnv) => {
    const s = TL.fireSession({ form: forms[formId], home, env: sessionEnv, label, paths, secrets: ctx.tokens, capMs: waitCapMs, budget });
    s.version = TL.installedVersion(tree);
    say(`onboarding: ${v.id} — sesión ${label} (${formId}): ${s.problem ? `NO se pudo abrir (${s.problem})` : `la línea de arranque salió ${((s.hooks || []).find((h) => h.startup) || {}).exit}; ${s.wait && s.wait.detached ? `se desprendió y esperé ${round(s.wait.waited_ms)} s (${s.wait.ended_by})` : 'no se desprendió'}`}`);
    return s;
  };
  const wanted = ['default-shell', 'bash-c'];
  // la forma de lanzar que la máquina no tiene queda dicha (no «se lanzó de dos formas» callando una)
  if (wanted.some((id) => !forms[id])) rec.note(`${v.id}: esta máquina no tiene con qué lanzar por ${wanted.filter((id) => !forms[id]).join(', ')}: la primera sesión se abrió sólo por ${wanted.filter((id) => forms[id]).join(', ') || 'ninguna forma'}`);
  const sessions = wanted.filter((id) => forms[id]).map((id, i) => open(id, `primera-${i + 1}`, env));
  facts.sessions = sessions;
  save();
  facts.after_first_sessions = RP.photo({ home, tree, env, paths, platform });
  facts.changed_by_first_sessions = RP.comparePhotos(facts.installed, facts.after_first_sessions, { sessions });
  for (const d of facts.changed_by_first_sessions) add(d, 'first-sessions:');
  save();

  // la capa del equipo, encima
  const team = addTeam({ ctx, home, env, tree, paths });
  facts.team = team.facts;
  for (const f of team.findings) add(f);
  save();
  const withTeam = [];
  if (forms['default-shell']) {
    facts.team.session = open('default-shell', 'con-la-capa', team.env);
    withTeam.push(facts.team.session);
    facts.team.version_after_session = TL.installedVersion(tree);
  }
  // cómo quedó la máquina CON la capa (la que usa todo el equipo): se juzga igual que antes de sumarla — la foto contra
  // la de antes, y la sesión con la capa como las primeras
  const left = RP.photo({ home, tree, env: team.env, paths, platform });
  facts.after_team = left;
  facts.changed_by_team = RP.comparePhotos(facts.after_first_sessions, left, { sessions: withTeam });
  for (const d of facts.changed_by_team) add(d, 'team:');
  answer();
  // sobre esta instalación miden count-hooks y fire-registered, en otro proceso: para entonces los dos servidores de
  // juguete ya están cerrados. Su ambiente lleva esas dos direcciones y el gestor de credenciales apagado: esa sesión
  // queda sin red, y nunca le habla a la red de verdad
  if ((left.settings.hooks || []).length) {
    usable.push({ id: v.id, home, clone: tree, skills: tree, settings, path_first: null,
      // lo que la variante no heredó de quien lanza tampoco lo hereda quien mide después (un valor nulo lo borra)
      env: Object.assign(Object.fromEntries(opened.changes.env_removed.map((k) => [k, null])), opened.changes.env_set, { TYCON_AZURE_API: ctx.azureApi, TYCON_AZURE_GIT_CREDENTIAL: '0' }) });
  }
  save();
  return true;
}

/** Lo que hay en una carpeta de usuario que una instalación a medias habría cambiado. */
function homeFacts(home) {
  const settings = path.join(home, '.claude', 'settings.json');
  return { harness_dir: fs.existsSync(path.join(home, '.tycon', 'harness')), settings_sha256: TL.sha(settings), startup_line: Boolean(T.registeredStartup(settings)) };
}

/**
 * La máquina que sólo tiene PowerShell 5.1: frena limpio y lo dice. `powershell_file` es lo que contestó el guion de
 * entrada lanzado con `powershell -File`; `before` y `after`, la carpeta de usuario antes y después.
 */
function judgePs51({ powershell_file: answer, before, after }) {
  const out = [];
  // el instalador del paquete dice lo que falta por su salida y frena por su canal de errores: se miran los dos
  if (!answer || answer.error || !/PowerShell 7/.test(`${answer.said || ''}\n${answer.out || ''}`)) {
    out.push({ id: 'guided-ps51:no-clear-message', severity: T.SEVERITY.loses, kind: 'page', detail: `la línea npx, en una máquina sin PowerShell 7, no dice que hace falta: ${answer ? (answer.error ? `no arrancó (${answer.error})` : `salió ${answer.exit} — ${L.clip(answer.said, 300) || 'sin decir nada'}`) : 'no se lanzó'}` });
  }
  const wrote = [];
  if (after.harness_dir && !before.harness_dir) wrote.push('quedó la carpeta ~/.tycon/harness');
  if (after.settings_sha256 !== before.settings_sha256) wrote.push('settings.json cambió');
  if (after.startup_line && !before.startup_line) wrote.push('quedó registrada la línea de arranque');
  if (wrote.length) out.push({ id: 'guided-ps51:half-installed', severity: T.SEVERITY.breaks, kind: 'install', detail: `sin PowerShell 7 la máquina no quedó como estaba: ${wrote.join('; ')}` });
  return out;
}

function runPs51({ ctx, v, facts, save, lab, platform, allowTemp, baseEnv, rec, add, say }) {
  const opened = openVariant({ ctx, lab, prefix: NAME, v, facts, platform, allowTemp, baseEnv });
  if (!opened) return false;
  const { home, scratch, window } = opened;
  const bare = T.withoutPwsh(opened.env, platform);
  if (bare.problem) { facts.not_run = bare.problem; return false; }
  const env = bare.env;
  facts.pwsh_removed_from = bare.removed;
  const ps = L.scanPath(v.ps, { env, platform })[0] || null;
  if (!ps) { facts.not_run = `no hay ${v.ps} en esta máquina (el PowerShell 5.1 sólo viene con Windows)`; return false; }
  facts.ps = v.ps;
  // lo que el laboratorio cambió lo anota toda variante que corre (una corrida de ésta sola también lo dice)
  noteLabChanges(rec, { ctx, v, home, changes: opened.changes, ps, env, scratch, own: { pwsh_removed_from: bare.removed } });
  say(`onboarding: ${v.id} — ${v.what}, en ${home}`);
  const m = ctx.manifest;
  const before = homeFacts(home);
  const said = (r) => L.clip(T.tellingLine(r.stderr) || L.firstLine(r.stderr) || L.firstLine(r.stdout), 400);
  let shot = 0;
  const shoot = (what, text, withToken, npx = false) => {
    const own = stepEnv(env, ctx.tokens, withToken);
    const raw = TL.runPage({ ps, text, cwd: window, env: npx ? npxEnv(own, ctx) : own, scratch, id: `${NAME}-${v.id}-${++shot}` });
    const safe = TL.checked(raw, ctx.tokens, what);
    for (const f of safe.findings) add(f);
    return { what, text, exit: raw.exit, error: raw.error, timed_out: raw.timed_out, not_found: raw.not_found && raw.not_found.length ? raw.not_found : undefined, seconds: round(raw.ms), said: said(safe.clean), out: L.clip(safe.clean.stdout, 800) };
  };
  // el paso 1 de la página, con el PowerShell que hay: que informe una versión 5 es lo esperado acá
  const step = (id) => m.steps.find((s) => s.id === id);
  facts.tools = shoot('el paso tools de la página, con powershell', step('tools').commands[0].text, false);
  facts.tools.powershell_version = (/^\d+\.\d+[\d.]*/m.exec(facts.tools.out) || [null])[0];
  facts.followed_page = false;
  facts.why = 'la página manda parar en el paso 1 si no hay PowerShell 7: el ensayo no la sigue desde ahí';
  // fuera de la página: lo que encontraría quien siguiera igual. La línea npx corre con node, sin importar el shell; lo
  // que se mide es que el instalador, sin PowerShell 7 en el PATH, frene antes de bajar y lo diga
  needPackage(ctx);
  const line = G.labText(G.withNames(step('install').commands[0].text, ctx.guide.names), m, { pkg: ctx.package, step: 'install' });
  facts.off_page = [];
  const answer = Object.assign(shoot('la línea npx de la página, sin PowerShell 7 en el PATH', line.text, true, line.changed), { lab_answer: line.answer || undefined });
  facts.off_page.push(answer);
  const after = homeFacts(home);
  facts.left = { before, after };
  for (const f of judgePs51({ powershell_file: answer, before, after })) add(f);
  save();
  return true;
}

// ── el paso ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** El alta siguiendo la página, sobre una copia publicada. `state` es el estado del laboratorio (`rehearsal-state.json`). */
function measure({ lab, out, state, platform = process.platform, baseEnv = process.env, allowTemp = false, only = null, rec, start = {}, waitCapMs = TL.WAIT_CAP_MS, waitBudgetMs = TL.VARIANT_WAIT_BUDGET_MS }) {
  const choice = TL.chooseVariants(VARIANTS, only);
  if (choice.problem) return notReady(choice.problem);
  const say = (s) => process.stdout.write(`${s}\n`);
  const genv = TL.gitEnv(lab, { base: baseEnv, platform });
  return TL.onRehearsedCommit(state, genv, () => {
    const ctx = openLab({ lab, name: NAME, state, baseEnv, platform, start });
    if (ctx.problem) return notReady(ctx.problem);
    // el paquete de npm del commit que se ensaya: sin él la línea npx correría el publicado
    const pk = packageFor(ctx, state);
    if (pk.problem) return notReady(ctx.discard(pk.problem));
    ctx.package = pk.tgz;
    const watch = TL.watching(ctx.redact, ctx.tokens);
    rec.setRedactor(watch.redact);
    try {
      noteLab(rec, ctx, state, platform);
      const usable = [];
      const result = TL.runVariants({ variants: choice.chosen, rec, say, run: (v, facts, save) => {
        const add = (d, prefix = '') => rec.finding(`${NAME}:${v.id}:${prefix}${d.id}`, d.kind, d.detail, null, { severity: d.severity, variant: v.id });
        const args = { ctx, v, facts, save, lab, out, platform, allowTemp, baseEnv, rec, add, say, usable, waitCapMs, waitBudgetMs };
        return v.id === 'guided' ? runGuided(args) : runPs51(args);
      } });
      // la que cuentan y disparan count-hooks y fire-registered
      const picked = usable[0] || null;
      rec.fact('measured_variant', picked ? picked.id : null);
      L.writeJsonAtomic(path.join(lab, 'lab-state.json'), { schema: L.SCHEMA, source: picked ? picked.clone : null, allow_temp: allowTemp, measured_variant: picked });
      // la red de abajo: un permiso de juguete en algo que se iba a guardar sin haber pasado por la revisión en crudo
      for (const f of TL.savedLeaks(watch)) rec.finding(`${NAME}:${f.id}`, f.kind, f.detail, null, { severity: f.severity });
      return TL.variantsStatus(result, choice.chosen);
    } finally { ctx.stop(); }
  });
}

module.exports = { NAME, VARIANTS, TOKEN_STEPS, PACKAGE_FILES, stepEnv, npxEnv, githubServing, notReady, teamArgs, openLab, packageFor, noteLab, openVariant, labChanges, noteLabChanges, followPage, addTeam, homeFacts, judgePs51, measure };
