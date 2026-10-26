'use strict';
/**
 * eol.test.js — los finales de línea los decide el repo, no la configuración de cada máquina.
 *
 * Un agente Windows puede traer `core.autocrlf=true` en la configuración
 * de sistema de Git for Windows: sin un `.gitattributes`, cada archivo de texto llega al árbol de trabajo con `\r\n`.
 * Un `.sh` con `\r\n` no es un error que se vea al clonar: `bash -n` lo da por bueno y recién al correr falla una
 * línea cualquiera (`exit 0\r` → «numeric argument required»). En Windows eso son los hooks en bash, los dos hooks
 * globales de git, el cierre de pruebas del pipeline y el respaldo del arranque.
 *
 * QUÉ MIRA (sobre el repo real y sobre repos de juguete):
 *   · la regla `* text=auto eol=lf` está en el `.gitattributes` de la raíz, y todo binario versionado está declarado
 *     (un binario que git detecta solo, sin declarar, depende de una heurística);
 *   · ningún archivo de texto versionado tiene `\r\n`, ni en el índice ni en el árbol de trabajo;
 *   · `git add --renormalize .` no cambia nada: a nadie que ya tiene el repo le aparece un archivo modificado;
 *   · un clon con `core.autocrlf=true`, o con `core.eol=crlf`, deja los `.sh` con `\n`.
 * Un archivo que rompe la regla se NOMBRA: el rojo dice cuál y cómo se arregla.
 *
 * «NO PUDE MIRAR» NO ES VERDE. En una carpeta sin `.git` (una copia exportada) lo del repo se saltea y se dice. Con
 * `.git` y git fallando (un clon de otra cuenta, un `.git` roto) la prueba sale ROJA con lo que dijo git.
 *
 * NO TOCA EL REPO: la prueba de `--renormalize` corre sobre una copia del índice y escribe los objetos nuevos en una
 * carpeta temporal. No usa bash: corre igual en Linux, en Mac y en Windows.
 *
 * Correr:   node scripts/tests/eol.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sinGitDelPadre } = require('../lib/clean-git-env.js');

const REPO = path.resolve(__dirname, '..', '..');
const RULE = '* text=auto eol=lf';
// Lo único que puede venir después de la regla: un binario, un tipo de archivo que necesita \r\n (un .bat, un .cmd),
// que se declara `text eol=crlf` (se versiona con \n y llega al árbol de trabajo con \r\n), o un archivo que se junta
// por unión al mezclar ramas (`merge=union` solo: no toca los finales de línea, que siguen con la regla).
const EXCEPTION_RULE = /^\S+\s+(binary|text eol=crlf|merge=union)$/;
const ATTRIBUTES = '.gitattributes';
// El paso que normaliza el árbol de trabajo de un clon que ya existía (medido: `git checkout -- .`, `git restore .`,
// `git reset --hard` y `git checkout-index -f -a` NO reescriben un archivo que el índice cree al día).
const NORMALIZE_STEP = 'git rm --cached -r -q . && git reset --hard -q';

const temporaries = [];
function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(d);
  return d;
}

function git(dir, args, env) {
  // Primero se le saca al entorno lo que git le pasa a sus hooks (esta suite puede correr desde uno), y RECIÉN ahí
  // va lo que pide la prueba: al revés, `sinGitDelPadre` se llevaría también el índice temporal y la prueba
  // escribiría en el índice de verdad.
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...sinGitDelPadre(), ...(env || {}) }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

function mustGit(dir, args, env) {
  const r = git(dir, args, env);
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} (${dir}) no anduvo: ${r.error ? r.error.message : r.stderr.trim()}`);
  return r.stdout;
}

/**
 * ¿Qué es `dir` para git? Tres respuestas, y sólo una se puede saltear:
 *   'clone'       la raíz de su propio árbol de trabajo: se mide;
 *   'not-a-clone' no tiene `.git` (una carpeta exportada): no hay nada que medir, y se dice;
 *   'unreadable'  tiene `.git` y git no lo puede leer (repo de otra cuenta, `.git` roto): NO es «no hay clon». Leerlo
 *                 así deja la prueba verde sin haber mirado el repo, justo donde más importa. Es un rojo, con lo
 *                 que dijo git.
 */
function workTree(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return { state: 'not-a-clone', detail: null };
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.error || r.status !== 0) return { state: 'unreadable', detail: (r.error ? r.error.message : r.stderr.trim()) || `git salió ${r.status}` };
  let same = false;
  try { same = fs.realpathSync(r.stdout.trim()) === fs.realpathSync(dir); } catch (_) { same = false; }
  return same ? { state: 'clone', detail: null } : { state: 'unreadable', detail: `tiene .git, y git dice que la raíz del árbol es ${r.stdout.trim()}` };
}

/** Mide `dir` o dice por qué no: saltea sólo si no es un clon; si git no lo puede leer, falla. Devuelve si hay que medir. */
function mustMeasure(t, dir, what) {
  const w = workTree(dir);
  if (w.state === 'not-a-clone') { t.skip(`NO MEDIDO: ${what} no es un clon de git (los finales de línea se deciden al clonar)`); return false; }
  assert.strictEqual(w.state, 'clone', `no pude medir ${what} (${dir}): git no pudo leer este clon — ${w.detail}`);
  return true;
}

/** Las reglas de un `.gitattributes`: sus líneas sin comentarios ni vacías. */
function rulesOf(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** `git ls-files --eol -z` → [{ index, worktree, attr, file }]. Sin patrón de ruta: se filtra acá, no en la línea de comandos. */
function eolEntries(dir, env) {
  const out = mustGit(dir, ['ls-files', '--eol', '-z'], env);
  const entries = [];
  for (const row of out.split('\0')) {
    if (!row) continue;
    const tab = row.indexOf('\t');
    const meta = row.slice(0, tab);
    const m = /^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*)$/.exec(meta);
    if (!m) throw new Error(`no entendí la línea de git ls-files --eol: ${JSON.stringify(row)}`);
    entries.push({ index: m[1], worktree: m[2], attr: m[3].trim(), file: row.slice(tab + 1) });
  }
  return entries;
}

/** Qué archivos cambiaría `git add --renormalize .`, sin tocar el índice ni los objetos del repo. */
function renormalizeWouldChange(dir, env) {
  const scratch = tempDir('tycon-eol-index-');
  const gitDir = mustGit(dir, ['rev-parse', '--absolute-git-dir'], env).trim();
  const objects = path.resolve(dir, mustGit(dir, ['rev-parse', '--git-path', 'objects'], env).trim());
  const realIndex = path.join(gitDir, 'index');
  const staged = (name, args) => {
    const index = path.join(scratch, name);
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index);
    const own = path.join(scratch, `${name}-objects`);
    fs.mkdirSync(own, { recursive: true });
    const e = { ...(env || {}), GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: own, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    mustGit(dir, ['add', ...args, '.'], e);
    const map = new Map();
    for (const row of mustGit(dir, ['ls-files', '-s', '-z'], e).split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      map.set(row.slice(tab + 1), row.slice(0, tab));
    }
    return map;
  };
  // Lo que cambia SÓLO por normalizar: contra el mismo índice con los cambios locales ya agregados (`-u`), para que
  // un árbol con trabajo sin commitear no cuente como «normalización».
  const plain = staged('plain', ['-u']);
  const renormalized = staged('renormalized', ['--renormalize']);
  const changed = [];
  for (const [file, entry] of renormalized) if (plain.get(file) !== entry) changed.push(file);
  return changed.sort();
}

/** Los problemas de finales de línea de un repo, cada uno nombrando su archivo. Vacío = cumple. */
function eolProblems(dir, env) {
  const problems = [];
  const file = path.join(dir, ATTRIBUTES);
  if (!fs.existsSync(file)) {
    problems.push(`falta ${ATTRIBUTES} en la raíz: sin él, los finales de línea los decide core.autocrlf de cada máquina`);
  } else if (!rulesOf(fs.readFileSync(file, 'utf8')).includes(RULE)) {
    problems.push(`${ATTRIBUTES} no trae la regla «${RULE}»`);
  }
  for (const e of eolEntries(dir, env)) {
    const declaredBinary = /(^|\s)-text(\s|$)/.test(e.attr);
    if (declaredBinary) continue;
    if (e.index === '-text') problems.push(`binario sin declarar en ${ATTRIBUTES}: ${e.file} (agregá su extensión como «binary»)`);
    else if (e.index === 'crlf' || e.index === 'mixed') problems.push(`versionado con \\r\\n: ${e.file} (se arregla con: git add --renormalize ${e.file})`);
    else if (/(^|\s)eol=crlf(\s|$)/.test(e.attr)) continue;   // declarado con \r\n a propósito: en el árbol de trabajo le corresponde
    else if (e.worktree === 'crlf' || e.worktree === 'mixed') problems.push(`con \\r\\n en el árbol de trabajo: ${e.file} (este clon es anterior a ${ATTRIBUTES}; con el árbol limpio: ${NORMALIZE_STEP})`);
  }
  for (const f of renormalizeWouldChange(dir, env)) problems.push(`git add --renormalize . cambiaría: ${f}`);
  return problems;
}

// ── repos de juguete: git sin la configuración de la máquina ──────────────────────────────────────────────────────
function toyEnv() {
  const cfg = path.join(tempDir('tycon-eol-cfg-'), 'gitconfig');
  fs.writeFileSync(cfg, '');
  return {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  };
}

function toyRepo(files, env, config = []) {
  const dir = tempDir('tycon-eol-toy-');
  mustGit(dir, ['init', '-q', '-b', 'main'], env);
  for (const c of config) mustGit(dir, ['config', ...c], env);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  mustGit(dir, ['add', '-A'], env);
  mustGit(dir, ['-c', 'core.hooksPath=', 'commit', '-q', '-m', 'fixture'], env);
  return dir;
}

const SCRIPT = '#!/usr/bin/env bash\necho hola\nexit 0\n';
const GZIP_BYTES = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const realAttributes = () => fs.readFileSync(path.join(REPO, ATTRIBUTES), 'utf8');

// ── T15 ───────────────────────────────────────────────────────────────────────────────────────────
test('T15a Eol_Gitattributes — la regla está en la raíz y los binarios están declarados', () => {
  const file = path.join(REPO, ATTRIBUTES);
  assert.ok(fs.existsSync(file), `falta ${ATTRIBUTES} en la raíz del repo`);
  const rules = rulesOf(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(rules[0], RULE, `la primera regla es «${RULE}»: las que siguen son sus excepciones`);
  assert.ok(rules.includes('*.gz binary'), 'los .gz (los chunks de la memoria, los volcados) van declarados como binarios');
  for (const r of rules.slice(1)) assert.match(r, EXCEPTION_RULE, `toda otra regla declara un binario («<patrón> binary») un archivo que necesita \\r\\n («<patrón> text eol=crlf») o uno que se junta por unión («<patrón> merge=union»): ${r}`);
  assert.ok(!fs.readFileSync(file).includes('\r'), `${ATTRIBUTES} mismo va con \\n`);
});

test('T15b Eol_NoCrlfTracked_RenormalizeIsNoop — el repo real: ningún texto con \\r\\n y nada que renormalizar', (t) => {
  if (!mustMeasure(t, REPO, 'esta carpeta')) return;
  const problems = eolProblems(REPO);
  assert.deepStrictEqual(problems, [], `finales de línea fuera de regla:\n  ${problems.join('\n  ')}`);
});

test('T15c Eol_SkillsRepo — agent-skills, mientras sea un repo aparte: la misma regla y el mismo resultado', (t) => {
  // sin `catch`: si la biblioteca no puede contestar (tira cuando su vecina está y no carga), esto es ROJO con su
  // causa. «No pude preguntar» no es «no hay un clon» (lo mide T15c2)
  const skills = require('../lib/skills-dir.js').resolveSkillsDirs(process.env.TYCON_SKILLS_DIR).repo;
  if (!skills || !fs.existsSync(skills)) { t.skip('NO MEDIDO: no hay un clon de agent-skills en esta máquina'); return; }
  if (fs.realpathSync(skills) === fs.realpathSync(REPO)) { t.skip('las skills viven en este mismo repo: ya las midió T15b'); return; }
  if (!mustMeasure(t, skills, 'agent-skills')) return;
  const problems = eolProblems(skills);
  assert.deepStrictEqual(problems, [], `agent-skills (${skills}), finales de línea fuera de regla:\n  ${problems.join('\n  ')}`);
  // En la copia pública de un solo repo viaja UN .gitattributes, el del arnés: los dos tienen que decir lo mismo.
  assert.deepStrictEqual(rulesOf(fs.readFileSync(path.join(skills, ATTRIBUTES), 'utf8')), rulesOf(realAttributes()),
    'el .gitattributes de agent-skills y el del arnés traen las mismas reglas');
});

test('T15c2 Eol_SkillsReader_BrokenNeighborIsRed — si quien ubica las skills no puede contestar, la prueba de agent-skills es roja con la causa (no «no hay un clon»)', () => {
  // (el título no nombra a la otra prueba por su número seguido de un espacio: T15g corre una copia con ese patrón)
  // `skills-dir.js` tira cuando su vecina (canonical-path.js) está y no carga. Si T15c envolviera
  // la llamada en un `catch` genérico, saltearía con «no hay un clon de agent-skills en esta máquina»: «no pude
  // preguntar» leído como «no hay». Se corre una COPIA de esta suite (sólo T15c) en un clon de juguete.
  // 🔴 Falla con: con el `catch`, la copia con la vecina rota sale 0 (T15c salteada).
  const lab = (broken) => {
    const dir = fs.realpathSync(tempDir('eol-reader-'));
    const clone = path.join(dir, 'clone');
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(clone, 'scripts', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(clone, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(clone, 'skills', 'tycon-pipeline'), { recursive: true });
    fs.mkdirSync(path.join(clone, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'agent-skills', 'skills', 'tycon-pipeline'), { recursive: true });
    fs.copyFileSync(__filename, path.join(clone, 'scripts', 'tests', 'eol.test.js'));
    for (const f of ['clean-git-env.js', 'skills-dir.js', 'canonical-path.js', 'legacy-names.js']) {
      fs.copyFileSync(path.join(REPO, 'scripts', 'lib', f), path.join(clone, 'scripts', 'lib', f));
    }
    if (broken) fs.writeFileSync(path.join(clone, 'scripts', 'lib', 'canonical-path.js'), 'throw new Error("biblioteca rota a propósito")\n');
    const env = { ...sinGitDelPadre(), HOME: home, USERPROFILE: home };
    delete env.TYCON_SKILLS_DIR;
    const r = spawnSync(process.execPath, ['--test-name-pattern', 'T15c Eol_SkillsRepo', path.join(clone, 'scripts', 'tests', 'eol.test.js')],
      { encoding: 'utf8', env, cwd: dir });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const broken = lab(true);
  assert.notStrictEqual(broken.status, 0, `con la vecina rota T15c tiene que dar rojo: ${broken.out}`);
  assert.ok(broken.out.includes('biblioteca rota a propósito'), `y nombrar la causa: ${broken.out}`);
  assert.ok(!/no hay un clon de agent-skills/.test(broken.out), `sin decir «no hay un clon»: ${broken.out}`);
  // el espejo: con la vecina sana, el clon de juguete (unido) contesta «él mismo» y T15c no falla
  const healthy = lab(false);
  assert.strictEqual(healthy.status, 0, healthy.out);
  assert.match(healthy.out, /las skills viven en este mismo repo/, healthy.out);
});

test('T15d Eol_NamesOffender — en un repo de juguete, cada archivo fuera de regla sale con su nombre', () => {
  const env = toyEnv();
  // 1 · sin .gitattributes
  const bare = toyRepo({ 'a.sh': SCRIPT }, env);
  assert.match(eolProblems(bare, env).join('\n'), /falta \.gitattributes/);
  // 2 · un archivo versionado con \r\n (entró antes de la regla, con autocrlf apagado)
  const crlf = toyRepo({ 'scripts/hooks/roto.sh': SCRIPT.replace(/\n/g, '\r\n'), 'bien.sh': SCRIPT }, env, [['core.autocrlf', 'false']]);
  fs.writeFileSync(path.join(crlf, ATTRIBUTES), realAttributes());
  mustGit(crlf, ['add', ATTRIBUTES], env);
  mustGit(crlf, ['-c', 'core.hooksPath=', 'commit', '-q', '-m', 'la regla'], env);
  const deCrlf = eolProblems(crlf, env);
  assert.ok(deCrlf.some((p) => p.startsWith('versionado con \\r\\n: scripts/hooks/roto.sh')), `nombra al archivo con \\r\\n: ${JSON.stringify(deCrlf)}`);
  assert.ok(deCrlf.includes('git add --renormalize . cambiaría: scripts/hooks/roto.sh'), `y dice que renormalizar lo cambiaría: ${JSON.stringify(deCrlf)}`);
  assert.ok(!deCrlf.some((p) => p.includes('bien.sh')), 'el archivo sano no aparece');
  // 3 · un binario que la regla no declara
  const binary = toyRepo({ [ATTRIBUTES]: `${RULE}\n`, 'dump.gz': GZIP_BYTES, 'a.sh': SCRIPT }, env);
  assert.deepStrictEqual(eolProblems(binary, env), [`binario sin declarar en ${ATTRIBUTES}: dump.gz (agregá su extensión como «binary»)`]);
  // 3b · un tipo de archivo que SÍ necesita \r\n (un .bat, un .cmd) se declara `text eol=crlf`: versionado con \n, y con
  //      \r\n en el árbol de trabajo a propósito. No es un problema, y la forma de la regla es una de las dos aceptadas.
  const batch = toyRepo({ [ATTRIBUTES]: `${RULE}\n*.bat text eol=crlf\n`, 'correr.bat': '@echo off\r\necho hola\r\n', 'a.sh': SCRIPT }, env);
  assert.deepStrictEqual(eolProblems(batch, env), [], 'un .bat declarado eol=crlf no es un archivo fuera de regla');
  assert.ok(fs.readFileSync(path.join(batch, 'correr.bat')).includes('\r\n'));
  assert.match('*.bat text eol=crlf', EXCEPTION_RULE);
  assert.match('*.gz binary', EXCEPTION_RULE);
  assert.doesNotMatch('*.sh eol=crlf', EXCEPTION_RULE, 'un eol=crlf sin `text` no normaliza lo que se versiona');
  assert.doesNotMatch('*.sh -text', EXCEPTION_RULE);
  assert.match('.tycon/estimates.jsonl merge=union', EXCEPTION_RULE);
  for (const r of ['a.jsonl merge=union text', 'a.jsonl merge=union eol=crlf', 'a.jsonl merge=union -text', 'a.jsonl text merge=union', 'a.jsonl merge=union binary']) {
    assert.doesNotMatch(r, EXCEPTION_RULE, `merge=union va solo: junto a un atributo de finales de línea es otra regla (${r})`);
  }
  // 4 · con la regla real, un repo sano no tiene nada que decir — tampoco con trabajo sin commitear en el árbol
  const clean = toyRepo({ [ATTRIBUTES]: realAttributes(), 'dump.gz': GZIP_BYTES, 'a.sh': SCRIPT, 'datos.json': '{"a":1}\n' }, env);
  assert.deepStrictEqual(eolProblems(clean, env), []);
  fs.appendFileSync(path.join(clean, 'a.sh'), 'echo cambio-local\n');
  assert.deepStrictEqual(eolProblems(clean, env), [], 'un cambio local sin commitear no es «normalización»');
  assert.strictEqual(mustGit(clean, ['diff', '--cached', '--name-only'], env), '', 'y la prueba no dejó nada en el índice del repo');
});

test('T15e Eol_CloneWithAutocrlf — con la regla real, un clon con core.autocrlf=true (o core.eol=crlf) deja los .sh con \\n', () => {
  const env = toyEnv();
  const origin = toyRepo({
    [ATTRIBUTES]: realAttributes(), 'scripts/hooks/a.sh': SCRIPT, 'scripts/setup/b.ps1': 'param()\nWrite-Host hola\n',
    'datos.json': '{"a":1}\n', 'dump.gz': GZIP_BYTES,
  }, env);
  const parent = tempDir('tycon-eol-clone-');
  const variants = { autocrlf: [['-c', 'core.autocrlf=true']], eol: [['-c', 'core.autocrlf=false'], ['-c', 'core.eol=crlf']] };
  for (const [name, config] of Object.entries(variants)) {
    const clone = path.join(parent, name);
    mustGit(parent, ['clone', '-q', ...config.flat(), origin, clone], env);
    for (const f of ['scripts/hooks/a.sh', 'scripts/setup/b.ps1', 'datos.json', ATTRIBUTES]) {
      assert.ok(!fs.readFileSync(path.join(clone, f)).includes('\r'), `${name}: ${f} llegó con \\r`);
    }
    assert.ok(fs.readFileSync(path.join(clone, 'dump.gz')).equals(GZIP_BYTES), `${name}: el binario llegó byte a byte`);
    assert.deepStrictEqual(eolProblems(clone, env), [], `${name}: nada fuera de regla en el clon`);
  }
  // El control del rojo: SIN la regla, el mismo clon con autocrlf=true sí trae \r — es lo que la regla evita.
  const without = toyRepo({ 'scripts/hooks/a.sh': SCRIPT }, env);
  const broken = path.join(parent, 'sin-regla');
  mustGit(parent, ['clone', '-q', '-c', 'core.autocrlf=true', without, broken], env);
  assert.ok(fs.readFileSync(path.join(broken, 'scripts/hooks/a.sh')).includes('\r\n'), 'sin .gitattributes, autocrlf=true convierte el .sh a \\r\\n');
});

test('T15f Eol_ExistingClone — un clon anterior a la regla conserva su \\r\\n hasta el paso que lo normaliza, y la prueba lo nombra', () => {
  const env = toyEnv();
  const origin = toyRepo({ 'scripts/hooks/a.sh': SCRIPT, 'b.txt': 'uno\n' }, env);
  const parent = tempDir('tycon-eol-existing-');
  const clone = path.join(parent, 'clon');
  mustGit(parent, ['clone', '-q', '-c', 'core.autocrlf=true', origin, clone], env);
  assert.ok(fs.readFileSync(path.join(clone, 'scripts/hooks/a.sh')).includes('\r\n'), 'el clon viejo nace con \\r\\n');
  // llega el commit que agrega la regla
  fs.writeFileSync(path.join(origin, ATTRIBUTES), realAttributes());
  mustGit(origin, ['add', ATTRIBUTES], env);
  mustGit(origin, ['-c', 'core.hooksPath=', 'commit', '-q', '-m', 'la regla'], env);
  mustGit(clone, ['pull', '-q', '--ff-only'], env);
  assert.strictEqual(mustGit(clone, ['status', '--porcelain'], env), '', 'tras el pull, nadie ve un archivo modificado');
  assert.ok(fs.readFileSync(path.join(clone, 'scripts/hooks/a.sh')).includes('\r\n'), 'el .sh que el pull no tocó sigue con \\r\\n');
  const before = eolProblems(clone, env);
  assert.ok(before.some((p) => p.startsWith('con \\r\\n en el árbol de trabajo: scripts/hooks/a.sh') && p.includes(NORMALIZE_STEP)),
    `la prueba nombra el archivo y el paso que lo arregla: ${JSON.stringify(before)}`);
  // los caminos que parecen arreglarlo y no lo hacen
  mustGit(clone, ['checkout', '-q', '--', '.'], env);
  mustGit(clone, ['reset', '-q', '--hard'], env);
  assert.ok(fs.readFileSync(path.join(clone, 'scripts/hooks/a.sh')).includes('\r\n'), 'git checkout -- . y git reset --hard no lo normalizan');
  // el paso que sí
  fs.writeFileSync(path.join(clone, 'sin-versionar.txt'), 'local\n');
  mustGit(clone, ['rm', '--cached', '-r', '-q', '.'], env);
  mustGit(clone, ['reset', '--hard', '-q'], env);
  assert.ok(!fs.readFileSync(path.join(clone, 'scripts/hooks/a.sh')).includes('\r'), 'tras el paso, el .sh queda con \\n');
  assert.ok(fs.existsSync(path.join(clone, 'sin-versionar.txt')), 'lo que no está versionado no se toca');
  assert.deepStrictEqual(eolProblems(clone, env), []);
});

test('T15g Eol_CannotLookIsNotGreen — con un clon que git no puede leer la prueba sale roja; sin clon, lo dice y no afirma nada del repo', () => {
  // La carpeta de una copia de esta misma prueba: la regla real, un .sh con \r\n, y un `.git` que git no puede leer
  // (en Windows el caso típico es «dubious ownership»: el repo lo clonó otra cuenta).
  const build = (withGit) => {
    const dir = tempDir('tycon-eol-cannot-look-');
    fs.mkdirSync(path.join(dir, 'scripts', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(__filename, path.join(dir, 'scripts', 'tests', 'eol.test.js'));
    // lo que la copia importa: sin `skills-dir.js`, T15c de la copia sería roja por no poder preguntar dónde están las
    // skills (ese error no se traga), y acá se mide otra cosa
    for (const f of ['clean-git-env.js', 'skills-dir.js']) fs.copyFileSync(path.join(REPO, 'scripts', 'lib', f), path.join(dir, 'scripts', 'lib', f));
    fs.writeFileSync(path.join(dir, ATTRIBUTES), realAttributes());
    fs.writeFileSync(path.join(dir, 'roto.sh'), SCRIPT.replace(/\n/g, '\r\n'));
    if (withGit) fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /no/existe/en/ninguna/parte\n');
    return dir;
  };
  // sólo T15b y T15c de la copia: las que miden el repo (y así la copia no vuelve a lanzar esta misma prueba)
  const run = (dir) => spawnSync(process.execPath, ['--test-reporter=tap', '--test-name-pattern=T15[bc] ', path.join(dir, 'scripts', 'tests', 'eol.test.js')],
    { encoding: 'utf8', env: { ...sinGitDelPadre(), TYCON_SKILLS_DIR: dir } });
  const unreadable = run(build(true));
  assert.notStrictEqual(unreadable.status, 0, `un clon que no se puede leer no puede dar verde:\n${unreadable.stdout}`);
  assert.match(unreadable.stdout, /not ok \d+ - T15b/);
  assert.match(unreadable.stdout, /no pude medir/);
  assert.match(unreadable.stdout, /not a git repository/, 'y trae lo que dijo git');
  const exported = run(build(false));
  assert.strictEqual(exported.status, 0, `${exported.stdout}${exported.stderr}`);
  assert.match(exported.stdout, /ok \d+ - T15b[^\n]*# SKIP NO MEDIDO: esta carpeta no es un clon de git/);
  assert.doesNotMatch(exported.stdout, /^ok \d+ - T15[bc](?![^\n]*# SKIP)/m, 'sin clon no hay ningún verde sobre el repo: sólo el salteo, dicho');
});

test.after(() => {
  for (const d of temporaries) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* un temporal que no se pudo borrar no cambia el veredicto */ } }
});

module.exports = { eolProblems, rulesOf, workTree, RULE, EXCEPTION_RULE, NORMALIZE_STEP };
