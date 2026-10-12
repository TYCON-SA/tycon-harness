#!/usr/bin/env node
'use strict';
/**
 * onboarding-probe.js — el alta de un dev nuevo del equipo en Windows, con lo que hay hoy (story 8.17, tanda W0 ·
 * escenario `onboarding`).
 *
 * POR QUÉ EXISTE. Un dev del equipo no instala la copia pública: clona los repos internos y le pega al asistente
 * un texto (`onboarding/new-dev-harness-setup.md`) que tiene una rama de pasos para Windows. Esa rama nunca corrió en
 * un Windows. Este paso la sigue, paso por paso, en una carpeta de usuario de laboratorio de un agente Windows, con
 * el texto y el instalador del commit que se ensaya, y anota cómo quedó la máquina.
 *
 * QUÉ HACE, por cada variante:
 *   1. Los pasos de Windows del texto, cada bloque `powershell` tal cual (ver `team-lab.js`), según la forma que el
 *      texto tenga en el commit que se ensaya (queda dicha en el reporte: `doc.shape`):
 *        · DOS CLONES: clonar los dos repos, los enlaces de `agents` y `skills`, el import en `CLAUDE.md`, la línea
 *          de arranque en `settings.json`, el instalador una vez a mano y la verificación final.
 *        · UN SOLO CLON: clonar el repo, `harness.js install` (deja los enlaces, el import, la línea de arranque y
 *          los hooks), mirar los enlaces, el diagnóstico (`harness.js doctor`), la validación del JSON y la
 *          verificación final. Nada se escribe a mano, y la carpeta de las skills es el mismo clon.
 *      Lo que pide una persona, una credencial o una herramienta opcional (engram, BMAD, Clockify, CodeGraph, Codex)
 *      no se corre: va a la lista «no ensayado», con su motivo.
 *   2. La foto de cómo quedó: `doctor --json`, `version`, los hooks registrados contra la lista del instalador, si
 *      cada archivo de hook existe, si hay alguno dos veces, y si los cuatro enlaces de `~/.claude` llegan a donde
 *      tienen que llegar (`~/.claude/skills` entre ellos).
 *   3. La primera sesión: todos los hooks `SessionStart` tal como quedaron registrados. Otra foto, y qué cambió.
 * Cada cosa que no quedó bien es un hallazgo con su gravedad («rompe el trabajo del dev», «pierde un control», «ruido»).
 *
 * LAS VARIANTES
 *   new-dev        una máquina con PowerShell 7 (`pwsh`).
 *   new-dev-ps51   una máquina que sólo tiene el PowerShell 5.1 que trae Windows: el texto dice usar `powershell`.
 *
 * Después de este paso, `count-hooks` y `fire-registered` (los mismos del escenario `measure`) corren sobre la
 * primera variante que dejó hooks: este paso se la deja anotada en `lab-state.json`.
 *
 * DOS CAMINOS, SEGÚN LO QUE SE ENSAYA. Lo de arriba es el alta del equipo sobre el ÁRBOL INTERNO (el texto del alta, con
 * clon). Cuando el commit que se ensaya es una COPIA PUBLICADA (trae `version.json` en su raíz) el alta se ensaya
 * siguiendo la página pública de instalación de Windows, comando por comando: eso vive en `guided-install.js`, y este
 * guion sólo elige. Con el árbol interno y el texto del alta sin clon, el paso dice «no medido»: ese alta se ensaya
 * contra una copia publicada.
 *
 * CÓMO FALLA. Un alta que sale mal es un HECHO del reporte. El paso sale «error» sólo si no pudo ensayar: sin los
 * remotos del laboratorio, sin el texto del alta en el commit, o si ninguna variante pudo correr.
 *
 * Uso: node scripts/tests/windows/onboarding-probe.js --lab <laboratorio> --out <carpeta del reporte> [--only <variantes>] [--allow-temp]
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const T = require('./team-lab.js');

const NAME = 'onboarding';
// lo que una versión publicada lleva en su raíz: con eso un árbol se declara «copia publicada»
const PUBLISHED_MARK = 'version.json';
const VARIANTS = Object.freeze([
  { id: 'new-dev', home: ['users', 'new-dev'], ps: 'pwsh', pwsh: true, what: 'una máquina con PowerShell 7' },
  { id: 'new-dev-ps51', home: ['users', 'new-dev-ps51'], ps: 'powershell', pwsh: false, what: 'una máquina que sólo tiene el PowerShell 5.1 de Windows' },
]);
// los pasos del alta sin los cuales el dev no puede trabajar con el arnés (los de las dos formas del texto: `install`
// es el instalador del alta de un solo clon)
const VITAL_STEPS = ['step-0', 'clone-harness', 'clone-skills', 'links', 'installer', 'install', 'json-check'];

function measure({ lab, out, platform = process.platform, baseEnv = process.env, allowTemp = false, only = null, rec }) {
  const state = T.readState(lab);
  if (!state) return { status: L.STATUS.error, reason: `no pude medir: ${lab} no trae los remotos del laboratorio (${T.STATE_FILE}): los deja «rehearse.js init»` };
  const gitEnv = L.labEnv(path.join(lab, 'users'), { base: baseEnv, platform });
  const { harness, skills } = state.remotes;
  // SE ELIGE POR LO QUE EL ÁRBOL ES. Una copia publicada (trae `version.json` en su raíz) lleva la página pública de
  // instalación y el guion de entrada en su lugar: ahí el alta se ensaya siguiendo esa página (`guided-install.js`). El
  // árbol interno no los trae así: sigue el ensayo del texto del alta del equipo, como siempre.
  const published = T.fileAt(harness.dir, harness.target, PUBLISHED_MARK, gitEnv);
  if (published.problem) return { status: L.STATUS.error, reason: `no pude medir: no pude saber si lo que se ensaya es una copia publicada (${published.problem})` };
  if (published.present) { rec.fact('guided', true); return require('./guided-install.js').measure({ lab, out, state, platform, baseEnv, allowTemp, only, rec }); }
  const read = T.readTeamDoc(state, harness.target, gitEnv);
  if (read.problem) return { status: L.STATUS.error, reason: `no pude medir: en el commit que se ensaya, ${read.problem}` };
  // el alta sin clon: en el árbol interno no hay qué ensayar (se ensaya contra una copia publicada) — NO MEDIDO, no error
  if (read.not_measured) return { status: L.STATUS.notMeasured, reason: read.not_measured };
  const doc = read.doc;
  const redact = T.redactor(doc, baseEnv);
  rec.setRedactor(redact);
  const pointed = T.pointRemotes(state, 'target', gitEnv);
  if (pointed) return { status: L.STATUS.error, reason: `no pude medir: ${pointed}` };
  // con un solo clon agent-skills no se clona (su remoto queda en el laboratorio): no hay commit suyo que ensayar
  const oneClone = doc.shape === T.SHAPE.one;
  rec.fact('commits', { harness: harness.target, skills: oneClone ? null : skills.target, sources: state.sources });
  rec.fact('doc', { file: T.DOC, at: harness.target, shape: doc.shape, startup_line: doc.startup, installer: doc.installer, doctor: doc.doctor, step_zero: doc.step_zero });
  rec.fact('not_rehearsed', T.notRehearsed(doc.shape));
  const redirect = T.redirectEnv(doc, state);
  const variants = {};
  const usable = [];
  const broke = [];
  let ran = 0;
  let measuredEol = false;
  const say = (s) => process.stdout.write(`${s}\n`);
  const add = (v, d, prefix = '') => rec.finding(`onboarding:${v.id}:${prefix}${d.id}`, d.kind, d.detail, null, { severity: d.severity, variant: v.id });

  const runVariant = (v) => {
    const home = path.join(lab, ...v.home);
    const scratch = path.join(lab, 'scratch', `onboarding-${v.id}`);
    const facts = { what: v.what, home };
    variants[v.id] = facts;
    const stop = (why) => { facts.not_run = why; rec.fact('variants', variants); say(`onboarding: ${v.id} — no corrió: ${why}`); };
    try { fs.mkdirSync(home, { recursive: true }); } catch (e) { return stop(`no pude crear ${home}: ${e.code || e.message}`); }
    const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
    if (problem) return stop(problem);
    let env = T.rehearsalEnv(home, { base: baseEnv, extra: redirect, platform });
    const seen = L.run(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env, timeoutMs: 30000, cap: 600 });
    if (seen.exit !== 0 || !L.samePath(L.realOrSelf(seen.stdout.trim()), L.realOrSelf(home), platform)) return stop(`os.homedir() devuelve «${seen.stdout.trim()}», no la carpeta de laboratorio`);
    if (!v.pwsh) {
      const bare = T.withoutPwsh(env, platform);
      if (bare.problem) return stop(bare.problem);
      env = bare.env;
      facts.pwsh_removed_from = bare.removed;
    }
    const ps = L.scanPath(v.ps, { env, platform })[0] || null;
    if (!ps) return stop(`no hay ${v.ps} en esta máquina`);

    say(`onboarding: ${v.id} — el alta de ${T.SHAPE_TEXT[doc.shape]} (${v.what}) en ${home}`);
    const inst = T.teamInstall({ doc, home, scratch, env, ps, psName: v.ps, id: `onboarding-${v.id}`, say });
    ran++;
    facts.install = inst;
    rec.fact('variants', variants);
    if (inst.problem) { add(v, { id: 'install-failed', severity: T.SEVERITY.breaks, kind: 'install', detail: `el alta no pudo seguir: ${inst.problem}` }); return facts; }
    for (const s of inst.steps.filter((x) => x.threw || x.error || (x.exit !== 0 && x.exit !== undefined))) {
      add(v, { id: `step-failed:${s.id}`, severity: VITAL_STEPS.includes(s.id) ? T.SEVERITY.breaks : T.SEVERITY.noise, kind: 'install', detail: `${s.what} ${s.threw ? `tiró: ${s.threw}` : `salió ${s.error || s.exit}`}${T.lastLines(s.stderr || s.stdout) ? ` — ${T.lastLines(s.stderr || s.stdout)}` : ''}` });
    }
    const { clone, skills: skillsDir, settings, shape } = inst;
    facts.installed = T.photo({ home, clone, skills: skillsDir, shape, env, platform });
    for (const d of T.judgePhoto(facts.installed)) add(v, d);
    try { if (facts.installed.settings.exists && !facts.installed.settings.problem) L.writeJsonAtomic(path.join(out, `settings-onboarding-${v.id}.json`), redact(T.readJsonLoose(settings).value)); } catch (_) { /* la copia es de cortesía */ }
    rec.fact('variants', variants);
    const p = facts.installed;
    say(`onboarding: ${v.id} — quedó: ${(p.settings.hooks || []).length} hook(s) (faltan ${p.expected.problem ? '?' : p.expected.missing.length} de ${p.expected.problem ? '?' : p.expected.expected_total}), ${p.settings.dangling ? p.settings.dangling.length : '?'} sin archivo, ${p.settings.duplicated ? p.settings.duplicated.length : '?'} repetido(s) · enlaces ${p.links.map((l) => `${l.name}:${l.ok ? 'bien' : (l.present ? 'MAL' : 'FALTA')}`).join(' ')} · doctor ${p.doctor.readable ? `${p.doctor.mode}, ${p.doctor.fail.length} rojo(s)` : 'ilegible'}`);

    // la primera sesión del dev: lo que corre solo al abrirla, tal como quedó registrado
    const forms = T.launchForms({ env, platform, scratch });
    const sessions = ['default-shell', 'bash-c'].map((id) => forms[id]).filter(Boolean).map((form, i) => T.fireSessionStart({ form, home, clone, skills: skillsDir, shape, env, label: `primera-${i + 1}` }));
    facts.sessions = sessions;
    facts.after_first_sessions = T.photo({ home, clone, skills: skillsDir, shape, env, platform });
    facts.changed_by_first_sessions = T.comparePhotos(facts.installed, facts.after_first_sessions, { sessions });
    for (const d of facts.changed_by_first_sessions) add(v, d, 'first-sessions:');
    const count = (list, sev) => list.filter((d) => d.severity === sev).length;
    const all = rec.step.findings.filter((f) => f.variant === v.id);
    facts.answers = { usable: count(all, T.SEVERITY.breaks) === 0, by_severity: { breaks: count(all, T.SEVERITY.breaks), 'loses-control': count(all, T.SEVERITY.loses), noise: count(all, T.SEVERITY.noise) } };
    if (facts.after_first_sessions.settings.hooks && facts.after_first_sessions.settings.hooks.length) usable.push({ id: v.id, home, clone, skills: skillsDir, settings, env: Object.assign({}, T.REHEARSAL_ENV, redirect), path_first: null });
    rec.fact('variants', variants);

    if (!measuredEol) {
      measuredEol = true;
      const bash = (forms['bash-c'] || {}).shell || null;
      const eol = oneClone ? { harness: T.eolFacts(clone, { env, bash }) } : { harness: T.eolFacts(clone, { env, bash }), skills: T.eolFacts(skillsDir, { env, bash }) };
      rec.fact('line_endings', eol);
      for (const [name, e] of Object.entries(eol)) {
        if (e.problem || !e.sh.with_cr) continue;
        const used = (facts.after_first_sessions.settings.hooks || []).some((h) => h.has_cr) || (facts.after_first_sessions.fixed_copy || []).some((f) => f.has_cr);
        rec.finding(`eol:sh-with-cr:${name}`, 'line-endings', `${e.sh.with_cr} de ${e.sh.total} archivos .sh del clon de ${name} llegaron con \\r (core.autocrlf en el clon: ${e.autocrlf_in_clone})${e.bash_reads_first ? `; bash, al leer ${e.bash_reads_first.file}, salió ${e.bash_reads_first.error || e.bash_reads_first.exit}${e.bash_reads_first.said ? ` — ${e.bash_reads_first.said}` : ''}` : ''}`, 'W1', { severity: used ? T.SEVERITY.loses : T.SEVERITY.noise });
      }
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
  // la que cuentan y disparan count-hooks y fire-registered: la primera que dejó hooks
  const picked = usable[0] || null;
  rec.fact('measured_variant', picked ? picked.id : null);
  L.writeJsonAtomic(path.join(lab, 'lab-state.json'), { schema: L.SCHEMA, source: picked ? picked.clone : null, allow_temp: allowTemp, measured_variant: picked });
  if (!ran) return { status: L.STATUS.error, reason: `no pude medir: ninguna variante pudo correr (${Object.entries(variants).map(([k, x]) => `${k}: ${x.not_run || x.threw}`).join(' · ')})` };
  if (broke.length) return { status: L.STATUS.error, reason: `no pude medir: ${broke.join(' · ')}` };
  return { status: L.STATUS.measured, reason: null };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--only': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`onboarding-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`onboarding-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, out: path.resolve(args.out), allowTemp: Boolean(args['allow-temp']), only: args.only ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : null, rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  process.stdout.write(`onboarding: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, VARIANTS, VITAL_STEPS, measure };
