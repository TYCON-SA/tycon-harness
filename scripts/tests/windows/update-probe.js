#!/usr/bin/env node
'use strict';
/**
 * update-probe.js — una máquina del equipo instalada con el estado del VIERNES, que el lunes abre una sesión y se
 * actualiza sola a lo de HOY (story 8.17, tanda W0 · escenario `update`).
 *
 * POR QUÉ EXISTE. Todos los devs del equipo usan Windows, y cada máquina se actualiza sola al abrir una sesión. Lo
 * que entró esta semana nunca corrió en un Windows: carpetas mudadas, archivos renombrados, un mecanismo de
 * instalación que exige PowerShell 7. Nadie sabe qué le pasa el lunes a una máquina instalada el viernes. Este paso
 * lo ensaya en un agente Windows, con el instalador y el texto del alta del commit del viernes, y lo dice.
 *
 * QUÉ HACE, por cada variante, en su propia carpeta de usuario de laboratorio:
 *   1. Los dos remotos del laboratorio apuntan al commit del viernes. Instala como un dev del equipo: los pasos de
 *      Windows del texto del alta DE ESE COMMIT, cada bloque tal cual (ver `team-lab.js`). Abre una sesión.
 *   2. La foto del viernes, y el humo: cada hook con una entrada legítima.
 *   3. Los remotos pasan al commit de hoy, y la última salida a la red del mecanismo queda tres días atrás (pasó el
 *      fin de semana).
 *   4. Abre sesiones: corre todos los hooks `SessionStart`, con su `command` tal como quedó registrado. Tres veces:
 *      una lanzada por el bash de Git y dos por `cmd.exe` (nadie sabe todavía con cuál los lanza el asistente).
 *      Si después de eso los clones siguen en el viernes, los avanza a mano y abre una sesión más: queda anotado
 *      que la máquina no se actualizó sola.
 *   5. La foto de hoy, el humo otra vez, y la comparación. Cada diferencia sale como hallazgo con su gravedad:
 *      «rompe el trabajo del dev», «pierde un control» o «ruido».
 *
 * LAS VARIANTES (cuál PowerShell tiene la máquina y qué línea de arranque escribió el dev):
 *   canonical      con PowerShell 7 y la línea de arranque vieja «canónica» (la primera forma conocida de Windows
 *                  de `scripts/tests/fixtures/startup-lines.json` del commit del viernes).
 *   oldest-line    con PowerShell 7 y la línea más vieja: la que todavía trae el texto del alta.
 *   pwsh-missing   instalada el viernes con PowerShell 7; el lunes `pwsh` no está en el PATH de la sesión.
 *   ps51           la máquina sólo tiene el PowerShell 5.1 que trae Windows, el viernes y el lunes.
 * Con `--only <variante,…>` corren sólo ésas.
 *
 * ADEMÁS, una vez: los `.sh` y `.ps1` de los dos clones que llegaron con `\r` (el agente trae `core.autocrlf=true`), y
 * si cada PowerShell de la máquina puede leer los `.ps1` que el arnés le pide correr.
 *
 * DOS CAMINOS, SEGÚN LO QUE SE ENSAYA. Lo de arriba es la máquina del viernes sobre el ÁRBOL INTERNO (clones, y la
 * marca de la que arranca). Cuando el commit que se ensaya es una COPIA PUBLICADA (trae `version.json` en su raíz) la
 * máquina de antes se instala con la página pública de instalación y la versión nueva se publica en el GitHub de
 * juguete: eso vive en `guided-update.js`, no necesita una marca, y este guion sólo elige.
 *
 * CÓMO FALLA. Una máquina que no se actualiza, que pierde un hook o que queda rota es un HECHO del reporte, con su
 * gravedad. El paso sale «error» sólo si no pudo ensayar: sin los remotos, sin el texto del alta en el commit del
 * viernes, o si ninguna variante pudo correr.
 *
 * Uso: node scripts/tests/windows/update-probe.js --lab <laboratorio> --out <carpeta del reporte> [--only <variantes>] [--allow-temp]
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const T = require('./team-lab.js');

const NAME = 'update';
// lo que una versión publicada lleva en su raíz: con eso un árbol se declara «copia publicada»
const PUBLISHED_MARK = 'version.json';
const VARIANTS = Object.freeze([
  { id: 'canonical', home: ['users', 'friday-canonical'], ps: 'pwsh', line: 'known', pwsh_on_friday: true, pwsh_today: true, what: 'PowerShell 7 · la línea de arranque vieja canónica' },
  { id: 'oldest-line', home: ['users', 'friday-oldest-line'], ps: 'pwsh', line: 'doc', pwsh_on_friday: true, pwsh_today: true, what: 'PowerShell 7 · la línea más vieja (la del texto del alta)' },
  { id: 'pwsh-missing', home: ['users', 'friday-pwsh-missing'], ps: 'pwsh', line: 'known', pwsh_on_friday: true, pwsh_today: false, what: 'instalada con PowerShell 7; el lunes pwsh no está en el PATH' },
  { id: 'ps51', home: ['users', 'friday-ps51'], ps: 'powershell', line: 'doc', pwsh_on_friday: false, pwsh_today: false, what: 'sólo el PowerShell 5.1 de Windows, el viernes y el lunes' },
]);
// en qué orden se abren las sesiones de hoy: [nombre, forma de lanzar]. La cuarta está para `settings:rewritten-every-session`,
// que compara las dos últimas: la tercera puede ser la primera en que corre el programa nuevo (su escritura de
// settings.json es una sola vez), y con sólo tres esa primera escritura se leía como «cada arranque lo reescribe».
const SESSIONS = Object.freeze([['hoy-1', 'bash-c'], ['hoy-2', 'default-shell'], ['hoy-3', 'default-shell'], ['hoy-4', 'default-shell']]);

const short = (sha) => (sha ? String(sha).slice(0, 10) : '—');

function measure({ lab, out, platform = process.platform, baseEnv = process.env, allowTemp = false, only = null, rec }) {
  const state = T.readState(lab);
  if (!state) return { status: L.STATUS.error, reason: `no pude medir: ${lab} no trae los remotos del laboratorio (${T.STATE_FILE}): los deja «rehearse.js init»` };
  const gitEnv = L.labEnv(path.join(lab, 'users'), { base: baseEnv, platform });
  const { harness, skills } = state.remotes;
  // SE ELIGE POR LO QUE EL ÁRBOL ES. Sobre una copia publicada (trae `version.json` en su raíz) la máquina de antes se
  // instala con la página pública y la versión nueva se publica en el GitHub de juguete (`guided-update.js`): no hace
  // falta una marca. El árbol interno sigue como siempre: la máquina del viernes, con el texto del alta de ese commit.
  const published = T.fileAt(harness.dir, harness.target, PUBLISHED_MARK, gitEnv);
  if (published.problem) return { status: L.STATUS.error, reason: `no pude medir: no pude saber si lo que se ensaya es una copia publicada (${published.problem})` };
  if (published.present) { rec.fact('guided', true); return require('./guided-update.js').measure({ lab, out, state, platform, baseEnv, allowTemp, only, rec }); }
  // sin una marca de la que arrancar (sólo pasa con un solo repo: ahí la marca es opcional) no hay un «antes» que
  // instalar: no hay actualización que ensayar
  if (!harness.friday) return { status: L.STATUS.notMeasured, reason: 'sin una marca de la que arrancar no hay un «antes» que instalar: este escenario necesita la marca (una etiqueta o un commit del repo que se ensaya)' };
  const read = T.readTeamDoc(state, harness.friday, gitEnv);
  if (read.problem) return { status: L.STATUS.error, reason: `no pude medir: en el commit del viernes, ${read.problem}` };
  // el alta sin clon (story 8.23, tanda E): no trae urls ni línea de arranque que ensayar; su ensayo contra el GitHub de
  // juguete está pendiente — NO MEDIDO con el motivo, no seguir de largo como si fuera de dos clones. Y una copia
  // publicada no lleva el texto del alta del equipo: tampoco hay qué ensayar
  if (read.not_measured) return { status: L.STATUS.notMeasured, reason: `en el commit del viernes, ${read.not_measured}` };
  const doc = read.doc;
  rec.setRedactor(T.redactor(doc, baseEnv));
  const known = T.knownWindowsLines(T.showFile(harness.dir, harness.friday, T.KNOWN_LINES, gitEnv) || '');
  // el texto del viernes dice cómo estaba instalada la máquina: con un solo clon no hay un segundo repo que actualizar,
  // y la línea de arranque la dejó el instalador (no se registra a mano una forma vieja)
  const oneClone = doc.shape === T.SHAPE.one;
  const target = oneClone ? { harness: harness.target } : { harness: harness.target, skills: skills.target };
  rec.fact('commits', { friday: oneClone ? { harness: harness.friday } : { harness: harness.friday, skills: skills.friday }, today: target, sources: state.sources });
  rec.fact('doc', { file: T.DOC, at: harness.friday, shape: doc.shape, startup_line: doc.startup, installer: doc.installer, doctor: doc.doctor, known_windows_lines: known.map((k) => k.id) });
  rec.fact('not_rehearsed', T.notRehearsed(doc.shape));
  if (oneClone) rec.note('el alta del viernes es de un solo clon: la línea de arranque la deja el instalador, así que las variantes que el viernes registraban a mano una forma vieja (la conocida o la del texto) instalan igual que las demás');
  const redirect = T.redirectEnv(doc, state);
  const variants = {};
  const broke = [];
  let ran = 0;
  let measuredExtras = false;
  const say = (s) => process.stdout.write(`${s}\n`);
  const add = (v, d) => rec.finding(`update:${v.id}:${d.id}`, d.kind, d.detail, null, { severity: d.severity, variant: v.id });

  const runVariant = (v) => {
    const home = path.join(lab, ...v.home);
    const scratch = path.join(lab, 'scratch', `update-${v.id}`);
    const facts = { what: v.what, home };
    variants[v.id] = facts;
    const stop = (why) => { facts.not_run = why; rec.fact('variants', variants); say(`update: ${v.id} — no corrió: ${why}`); };
    try { fs.mkdirSync(home, { recursive: true }); } catch (e) { return stop(`no pude crear ${home}: ${e.code || e.message}`); }
    const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
    if (problem) return stop(problem);
    const full = T.rehearsalEnv(home, { base: baseEnv, extra: redirect, platform });
    const seen = L.run(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env: full, timeoutMs: 30000, cap: 600 });
    if (seen.exit !== 0 || !L.samePath(L.realOrSelf(seen.stdout.trim()), L.realOrSelf(home), platform)) return stop(`os.homedir() devuelve «${seen.stdout.trim()}», no la carpeta de laboratorio`);
    let bare = null;
    if (!v.pwsh_on_friday || !v.pwsh_today) {
      bare = T.withoutPwsh(full, platform);
      if (bare.problem) return stop(bare.problem);
      facts.pwsh_removed_from = bare.removed;
    }
    const fridayEnv = v.pwsh_on_friday ? full : bare.env;
    const todayEnv = v.pwsh_today ? full : bare.env;
    const ps = L.scanPath(v.ps, { env: fridayEnv, platform })[0] || null;
    if (!ps) return stop(`no hay ${v.ps} en esta máquina con qué instalar el viernes`);

    // 1 · el viernes
    const pointed = T.pointRemotes(state, 'friday', gitEnv);
    if (pointed) return stop(pointed);
    let line = null;
    if (v.line === 'known' && !oneClone) {
      if (known.length) line = known[0]; else rec.note(`${v.id}: el commit del viernes no trae formas conocidas de Windows (${T.KNOWN_LINES}): usa la línea del texto del alta`);
    }
    say(`update: ${v.id} — instalo el viernes (${v.what}) en ${home}`);
    const inst = T.teamInstall({ doc, home, scratch, env: fridayEnv, ps, psName: v.ps, line, id: `update-${v.id}`, say });
    ran++;
    facts.friday = { install: inst };
    rec.fact('variants', variants);
    if (inst.problem) { add(v, { id: 'friday-install-failed', severity: T.SEVERITY.breaks, kind: 'install', detail: `no se pudo instalar el estado del viernes: ${inst.problem}` }); return facts; }
    for (const s of inst.steps.filter((x) => x.threw || x.error || (x.exit !== 0 && x.exit !== undefined))) {
      add(v, { id: `friday-step-failed:${s.id}`, severity: ['installer', 'install', 'clone-harness', 'clone-skills', 'links'].includes(s.id) ? T.SEVERITY.breaks : T.SEVERITY.noise, kind: 'install', detail: `el viernes, ${s.what} ${s.threw ? `tiró: ${s.threw}` : `salió ${s.error || s.exit}`}${T.lastLines(s.stderr || s.stdout) ? ` — ${T.lastLines(s.stderr || s.stdout)}` : ''}` });
    }
    const { clone, skills: skillsDir, settings, shape } = inst;
    const forms = T.launchForms({ env: fridayEnv, platform, scratch });
    const smokeForms = ['bash-c', 'default-shell'].map((id) => forms[id]).filter(Boolean);
    facts.friday.session = T.fireSessionStart({ form: forms['default-shell'], home, clone, skills: skillsDir, shape, env: fridayEnv, label: 'viernes' });
    facts.before = T.photo({ home, clone, skills: skillsDir, shape, env: fridayEnv, platform });
    facts.before_smoke = T.smoke({ settingsFile: settings, forms: smokeForms, home, scratch, env: fridayEnv, platform });
    try { if (facts.before.settings.exists && !facts.before.settings.problem) L.writeJsonAtomic(path.join(out, `settings-update-${v.id}-friday.json`), T.redactor(doc, baseEnv)(T.readJsonLoose(settings).value)); } catch (_) { /* la copia es de cortesía */ }
    rec.fact('variants', variants);
    say(`update: ${v.id} — el viernes: ${(facts.before.settings.hooks || []).length} hook(s), línea de arranque ${(facts.before.settings.startup_lines || []).map((l) => `${l.form} (${l.shell})`).join(', ') || 'ninguna'}, doctor ${facts.before.doctor.readable ? `${facts.before.doctor.fail.length} rojo(s)` : 'ilegible'}`);

    // 2 · hoy
    const moved = T.pointRemotes(state, 'target', gitEnv);
    if (moved) { broke.push(`${v.id}: ${moved}`); return facts; }
    facts.weekend = T.simulateWeekend(home);
    const todayForms = T.launchForms({ env: todayEnv, platform, scratch });
    const sessions = [];
    for (const [label, formId] of SESSIONS) {
      if (!todayForms[formId]) continue;
      const s = T.fireSessionStart({ form: todayForms[formId], home, clone, skills: skillsDir, shape, env: todayEnv, label });
      sessions.push(s);
      say(`update: ${v.id} — sesión ${label} (${formId}): la línea de arranque salió ${((s.hooks || []).find((h) => h.startup) || {}).exit}; arnés ${short(s.heads && s.heads.harness)}${oneClone ? '' : ` · agent-skills ${short(s.heads && s.heads.skills)}`}`);
    }
    const last = sessions[sessions.length - 1];
    // cada clon de la máquina (los dos, o el único) quedó en el commit de hoy
    const byItself = Boolean(last && last.heads && Object.entries(target).every(([name, commit]) => last.heads[name] === commit));
    facts.updated_by_itself = byItself;
    if (!byItself) {
      add(v, { id: 'not-updated-by-itself', severity: T.SEVERITY.loses, kind: 'update', detail: oneClone
        ? `después de ${sessions.length} sesión(es) el clon seguía en ${short(last && last.heads && last.heads.harness)}, no en lo de hoy: la máquina no se actualizó sola`
        : `después de ${sessions.length} sesión(es) los clones seguían en ${short(last && last.heads && last.heads.harness)} (arnés) y ${short(last && last.heads && last.heads.skills)} (agent-skills), no en lo de hoy: la máquina no se actualizó sola` });
      // lo que haría una persona: avanzar los clones a mano (los dos, o el único), y abrir una sesión más
      facts.by_hand = {};
      for (const [name, dir] of [['harness', clone], ['skills', skillsDir]].filter(([name]) => name in target)) {
        const r = L.run('git', ['-C', dir, 'pull', '--ff-only', '--quiet'], { env: todayEnv, timeoutMs: 5 * 60 * 1000, cap: 800 });
        facts.by_hand[name] = { exit: r.exit, error: r.error, said: L.firstLine(r.stderr) || L.firstLine(r.stdout) };
      }
      if (todayForms['default-shell']) sessions.push(T.fireSessionStart({ form: todayForms['default-shell'], home, clone, skills: skillsDir, shape, env: todayEnv, label: 'hoy-a-mano' }));
    }
    facts.sessions = sessions;
    facts.after = T.photo({ home, clone, skills: skillsDir, shape, env: todayEnv, platform });
    facts.after_smoke = T.smoke({ settingsFile: settings, forms: ['bash-c', 'default-shell'].map((id) => todayForms[id]).filter(Boolean), home, scratch, env: todayEnv, platform });
    try { if (facts.after.settings.exists && !facts.after.settings.problem) L.writeJsonAtomic(path.join(out, `settings-update-${v.id}-today.json`), T.redactor(doc, baseEnv)(T.readJsonLoose(settings).value)); } catch (_) { /* la copia es de cortesía */ }
    facts.differences = T.comparePhotos(facts.before, facts.after, { sessions, smokeBefore: facts.before_smoke, smokeAfter: facts.after_smoke, target });
    for (const d of facts.differences) add(v, d);
    // el Node propio del arnés (story 8.39, AC 27): después de las sesiones de hoy, los hooks tienen que correr con él,
    // salvo que esté apagado o que la carpeta no entre en la forma de Windows (decisión 22, con su motivo en doctor)
    const hn = facts.after.doctor && facts.after.doctor.harness_node;
    facts.harness_node = hn || null;
    if (hn && hn.own !== true && hn.switch !== 'off' && !/no se puede escribir en un comando/.test(String(hn.reason || ''))) {
      add(v, { id: 'harness-node-not-own', severity: T.SEVERITY.loses, kind: 'harness-node', detail: `después de las sesiones de hoy el arnés no corre con su Node propio (${hn.reason || 'sin motivo'}): los hooks siguen con el Node del PATH` });
    }
    facts.answers = T.answers(facts.before, facts.after, facts.differences, { sessions, target });
    rec.fact('variants', variants);
    const a = facts.answers;
    say(`update: ${v.id} — hoy: ${a.updated ? 'actualizada' : 'NO actualizada'}${byItself ? '' : ' (no lo hizo sola)'} · ${a.healthy ? 'sana' : 'NO quedó sana'} · rompe ${a.by_severity.breaks} · pierde un control ${a.by_severity['loses-control']} · ruido ${a.by_severity.noise}`);

    // 3 · una vez, sobre el primer clon que quedó en lo de hoy: los finales de línea y qué PowerShell lee los .ps1
    if (!measuredExtras && a.updated) {
      measuredExtras = true;
      const bash = (todayForms['bash-c'] || {}).shell || null;
      const eol = oneClone ? { harness: T.eolFacts(clone, { env: full, bash }) } : { harness: T.eolFacts(clone, { env: full, bash }), skills: T.eolFacts(skillsDir, { env: full, bash }) };
      rec.fact('line_endings', eol);
      for (const [name, e] of Object.entries(eol)) {
        if (e.problem || !e.sh.with_cr) continue;
        const used = (facts.after.settings.hooks || []).some((h) => h.has_cr) || (facts.after.fixed_copy || []).some((f) => f.has_cr);
        rec.finding(`eol:sh-with-cr:${name}`, 'line-endings', `${e.sh.with_cr} de ${e.sh.total} archivos .sh del clon de ${name} llegaron con \\r (core.autocrlf en el clon: ${e.autocrlf_in_clone})${e.bash_reads_first ? `; bash, al leer ${e.bash_reads_first.file}, salió ${e.bash_reads_first.error || e.bash_reads_first.exit}${e.bash_reads_first.said ? ` — ${e.bash_reads_first.said}` : ''}` : ''}`, 'W1', { severity: used ? T.SEVERITY.loses : T.SEVERITY.noise });
      }
      const files = ['scripts/install-tycon-hooks.ps1', 'scripts/setup/sync-claude-md-blocks.ps1', 'scripts/setup/harness/bootstrap-fallback.ps1'].map((f) => path.join(clone, ...f.split('/')));
      const parse = T.psParseFacts(files, { pwsh: L.scanPath('pwsh', { env: baseEnv, platform })[0] || null, powershell: L.scanPath('powershell', { env: baseEnv, platform })[0] || null }, full);
      rec.fact('powershell_reads', parse);
      for (const p of parse.filter((x) => x.parse_errors)) rec.finding(`ps-parse:${p.shell}:${p.file}`, 'powershell', `${p.shell} ${p.version || ''} no puede leer ${p.file} del commit de hoy: ${p.parse_errors} error(es) de sintaxis — ${p.first}`, null, { severity: T.SEVERITY.loses });
    }
    return facts;
  };

  const chosen = VARIANTS.filter((v) => !only || only.includes(v.id));
  if (!chosen.length) return { status: L.STATUS.error, reason: `no pude medir: ninguna variante se llama ${only.join(', ')} (las que hay: ${VARIANTS.map((v) => v.id).join(', ')})` };
  for (const v of chosen) {
    try { runVariant(v); } catch (e) {
      broke.push(`la variante ${v.id} tiró: ${e.message}`);
      variants[v.id] = Object.assign(variants[v.id] || {}, { threw: e.message });
    }
    rec.fact('variants', variants);
  }
  // los remotos quedan en lo de hoy: es lo que espera el paso del alta, si corre después
  T.pointRemotes(state, 'target', gitEnv);
  if (!ran) return { status: L.STATUS.error, reason: `no pude medir: ninguna variante pudo correr (${Object.entries(variants).map(([k, x]) => `${k}: ${x.not_run || x.threw}`).join(' · ')})` };
  if (broke.length) return { status: L.STATUS.error, reason: `no pude medir: ${broke.join(' · ')}` };
  return { status: L.STATUS.measured, reason: null };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--only': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`update-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`update-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, out: path.resolve(args.out), allowTemp: Boolean(args['allow-temp']), only: args.only ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : null, rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  process.stdout.write(`update: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, VARIANTS, SESSIONS, measure };
