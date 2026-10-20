#!/usr/bin/env node
'use strict';
/**
 * story-without-bmad.js — la historia de un repo sin proyecto BMAD (el modo primera vez de tycon-create-story).
 *
 *   node story-without-bmad.js mode  --repo <dir>
 *   node story-without-bmad.js write --repo <dir> --answers <archivo.json>
 *
 * `mode` decide el modo por lo que hay en el repo, no por lo que infiera el modelo: con `_bmad/bmm/config.yaml` es el
 * flujo de BMAD (`{"mode":"bmad"}`); sin él, el modo primera vez, con la carpeta (`specs/` si existe, si no
 * `stories/`), el número siguiente de la primera épica y la carpeta absoluta.
 *
 * `write` escribe la historia desde las respuestas ya convertidas en criterios y pruebas. El formato sale de acá y no
 * de la memoria del modelo: así la historia pasa el lint y el recorrido la encuentra. Valida todo antes de escribir
 * (sale 2 con el motivo en llano y sin escribir nada), nunca pisa un archivo y escribe de una vez. Al terminar deja
 * constancia en la carpeta de estado del arnés (`first-time-stories/`): `pipeline.js start` cambia de rama solo
 * únicamente para una historia con la marca `origin: first-time` Y esa constancia, así la marca escrita a mano no
 * alcanza. El agente no escribe en la carpeta de estado (el portón de escrituras lo niega).
 *
 * Formato de las respuestas (JSON):
 *   { title, asA, iWant, soThat,
 *     criteria: [{ given, when, then, failure? }],          // numerados 1..N en ese orden
 *     tests:    [{ name, criterion, level?, scenario, expected }],
 *     outOfScope?: [texto], filesToCreate?: [ruta], filesToModify?: [ruta],
 *     verify?: [comando] }                                 // cómo se corren las pruebas, un comando por renglón
 *
 * La historia nace limpia para el validador de historias: `sprint: 1`, la salvaguarda como primera tarea, «Lo que NO
 * hay que hacer» y «Cómo verificar que funciona» con los comandos. Sin `verify`, el comando sale del repo (`npm test`
 * con un `package.json` que declara `scripts.test`); si no se puede saber, no escribe: un comando inventado es el que
 * después corre el probador en vivo.
 */
const fs = require('fs');
const path = require('path');

const PIPELINE_LIB = path.join(__dirname, '..', '..', 'tycon-pipeline', 'scripts', 'lib');
const { probeStoryFile } = require(path.join(PIPELINE_LIB, 'story-discovery.js'));
const { writeRecord, RECORD_DIR } = require(path.join(PIPELINE_LIB, 'first-time-record.js'));

const BMAD_CONFIG = path.join('_bmad', 'bmm', 'config.yaml');
const EPIC = 1;

class Refusal extends Error {}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

function isBmad(repo) {
  return fs.existsSync(path.join(repo, BMAD_CONFIG));
}

const MAX_DEPTH = 4;

/** Los .md de la carpeta y sus subcarpetas. Lo que no se puede leer frena: un número no se adivina. */
function markdownFiles(dir, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT' && depth === 0) return [];
    throw new Refusal(`no pude leer ${dir} para saber qué número le toca a la historia (${e.code || e.message})`);
  }
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    // Un enlace cuenta como lo que apunta: una historia enlazada también tiene número.
    let kind = e;
    if (e.isSymbolicLink()) {
      try { kind = fs.statSync(p); } catch (err) {
        throw new Refusal(`no pude leer ${p} para saber qué número le toca a la historia (${err.code || err.message})`);
      }
    }
    if (kind.isDirectory()) {
      if (depth >= MAX_DEPTH) throw new Refusal(`${p} está a más de ${MAX_DEPTH} carpetas de profundidad: no puedo asegurar qué número le toca a la historia. Moví esas historias más arriba`);
      out.push(...markdownFiles(p, depth + 1));
    } else if (kind.isFile() && e.name.endsWith('.md')) {
      try { fs.accessSync(p, fs.constants.R_OK); } catch (err) {
        throw new Refusal(`no pude leer ${p} para saber qué número le toca a la historia (${err.code || err.message})`);
      }
      out.push(p);
    }
  }
  return out;
}

/** La carpeta de las historias y el número siguiente de la primera épica (por el `story:` de cada .md, no por su nombre). */
function nextStory(repo) {
  const folder = fs.existsSync(path.join(repo, 'specs')) ? 'specs' : 'stories';
  const dir = path.join(repo, folder);
  let max = 0;
  for (const f of markdownFiles(dir)) {
    const s = probeStoryFile(f);
    const m = s && String(s.id).match(new RegExp(`^${EPIC}\\.(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return { folder, dir, number: `${EPIC}.${max + 1}` };
}

function slug(title) {
  return title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'historia';
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const oneLine = (v) => text(v).replace(/\s*\n\s*/g, ' ');
const cell = (v) => oneLine(v).replace(/\|/g, '\\|');

/** Una ruta relativa al repo que va tal cual en una lista YAML sin cambiar de significado. */
function safeRepoPath(f) {
  return /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(f) && !f.split('/').includes('..');
}

/** Todo lo que falta o sobra, en llano. Vacío = se puede escribir. */
function problems(a) {
  const out = [];
  if (!a || typeof a !== 'object') return ['las respuestas no son un objeto JSON'];
  if (!text(a.title)) out.push('falta el título');
  if (/["\\\n]/.test(a.title || '')) out.push('el título no puede llevar comillas dobles, barras invertidas ni saltos de línea (usá comillas simples)');
  for (const k of ['asA', 'iWant', 'soThat']) if (!text(a[k])) out.push(`falta «${{ asA: 'como', iWant: 'quiero', soThat: 'para' }[k]}»`);
  const criteria = Array.isArray(a.criteria) ? a.criteria : [];
  const tests = Array.isArray(a.tests) ? a.tests : [];
  if (!criteria.length) out.push('no hay ningún criterio de aceptación');
  criteria.forEach((c, i) => {
    for (const k of ['given', 'when', 'then']) if (!text(c && c[k])) out.push(`al criterio ${i + 1} le falta «${k}»`);
  });
  tests.forEach((t, i) => {
    const name = text(t && t.name) || `#${i + 1}`;
    if (!text(t && t.name)) out.push(`a la prueba ${name} le falta el nombre`);
    else if (!/^[A-Za-z0-9_]+$/.test(t.name)) out.push(`el nombre de la prueba ${name} sólo lleva letras sin tilde, números y _`);
    const n = Number(t && t.criterion);
    if (!Number.isInteger(n) || n < 1 || n > criteria.length) out.push(`la prueba ${name} nombra el criterio ${t && t.criterion}, que no existe`);
    for (const k of ['scenario', 'expected']) if (!text(t && t[k])) out.push(`a la prueba ${name} le falta «${k}»`);
  });
  criteria.forEach((_, i) => {
    if (criteria.length && !tests.some((t) => Number(t && t.criterion) === i + 1)) out.push(`el criterio ${i + 1} no tiene ninguna prueba`);
  });
  for (const k of ['outOfScope', 'filesToCreate', 'filesToModify']) {
    if (a[k] !== undefined && (!Array.isArray(a[k]) || a[k].some((x) => !text(x)))) out.push(`«${k}» tiene que ser una lista de textos`);
  }
  // un salto de línea o un ``` sacaría el comando del bloque bash y escribiría en la historia
  if (a.verify !== undefined && (!Array.isArray(a.verify) || a.verify.some((x) => !text(x) || /[\r\n]|```/.test(x)))) {
    out.push('«verify» tiene que ser una lista de comandos, uno por renglón, sin saltos de línea ni ```');
  }
  for (const k of ['filesToCreate', 'filesToModify']) {
    for (const f of Array.isArray(a[k]) ? a[k] : []) {
      if (typeof f === 'string' && !safeRepoPath(f)) out.push(`la ruta «${f}» no sirve: va relativa al repo, sin «..», y sólo con letras sin tilde, números, «/», «.», «_», «-» (sin empezar con «-»)`);
    }
  }
  return out;
}

/** Los comandos de «Cómo verificar que funciona»: los de la respuesta o el que declara el repo. Sin ninguno, frena. */
function verifyCommands(repo, a) {
  if (Array.isArray(a.verify) && a.verify.length) return a.verify.map(oneLine);
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); } catch (_e) { /* sin package.json legible */ }
  const t = pkg && pkg.scripts && typeof pkg.scripts.test === 'string' ? pkg.scripts.test.trim() : '';
  // el `test` que deja `npm init` («Error: no test specified» y sale 1) no corre ninguna prueba
  if (t && !/no test specified/i.test(t)) return ['npm test'];
  throw new Refusal('no escribí la historia: falta cómo se corren las pruebas. Agregá a las respuestas «verify» con el comando (por ejemplo ["npm test"]), o preguntale a la persona cómo las corre');
}

function yamlList(key, items) {
  return items.length ? [`${key}:`, ...items.map((x) => `  - ${oneLine(x)}`)] : [`${key}: []`];
}

/** Un renglón de «Lo que NO hay que hacer»: lo que ya empieza con «no» va tal cual, lo demás es «No tocar …». */
function dontTouch(x) {
  const t = oneLine(x).replace(/\.+$/, '');
  return /^no\b/i.test(t) ? `- ${t.charAt(0).toUpperCase()}${t.slice(1)}.` : `- No tocar ${t}.`;
}

/** Lo que la salvaguarda confirma: los archivos a crear no existen y los a modificar sí. */
function safeguard(toCreate, toModify) {
  const parts = [];
  if (toModify.length) parts.push(`existen ${toModify.map((f) => `\`${oneLine(f)}\``).join(', ')}`);
  if (toCreate.length) parts.push(`todavía no existen ${toCreate.map((f) => `\`${oneLine(f)}\``).join(', ')}`);
  return parts.length ? `: ${parts.join('; ')}` : '';
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function render(a, number, verify, exists = () => false) {
  const criteria = a.criteria;
  const tests = a.tests;
  const toCreate = a.filesToCreate || [];
  const toModify = a.filesToModify || [];
  // «Que existe hoy» dice lo que está en el disco, no lo que la respuesta supone
  const present = [...toModify, ...toCreate].filter((f) => exists(f));
  const absent = [...toCreate, ...toModify].filter((f) => !exists(f));
  const principal = criteria.map((c, i) => ({ c, n: i + 1 })).filter((x) => !x.c.failure);
  const failures = criteria.map((c, i) => ({ c, n: i + 1 })).filter((x) => x.c.failure);
  const ac = ({ c, n }) => `${n}. **Given** ${oneLine(c.given)} **When** ${oneLine(c.when)} **Then** ${oneLine(c.then)}`;
  const files = [...toCreate.map((f) => `| Crear | \`${cell(f)}\` |`), ...toModify.map((f) => `| Modificar | \`${cell(f)}\` |`)];
  return [
    '---',
    `epic: ${EPIC}`,
    `story: "${number}"`,
    `title: "${oneLine(a.title)}"`,
    'status: ready-for-dev',
    `created: ${today()}`,
    'sprint: 1',
    'priority: "P2"',
    'approach: "[CREATE]"',
    'origin: first-time',
    'depends_on: []',
    ...yamlList('files_to_create', toCreate),
    ...yamlList('files_to_modify', toModify),
    '---',
    '',
    `# Story ${number}: ${oneLine(a.title)}`,
    '',
    'Status: ready-for-dev',
    '',
    '## Story',
    '',
    `Como ${oneLine(a.asA)},`,
    `quiero ${oneLine(a.iWant)},`,
    `para ${oneLine(a.soThat)}.`,
    '',
    '## Acceptance Criteria',
    '',
    '### Lo que tiene que pasar',
    '',
    ...principal.map(ac),
    ...(failures.length ? ['', '### Modos de falla', '', ...failures.map(ac)] : []),
    '',
    `### Tests (${tests.length} verificaciones)`,
    '',
    '| # | Test | AC | Nivel | Escenario | Resultado esperado |',
    '|---|------|----|-------|-----------|--------------------|',
    ...tests.map((t, i) => `| T${i + 1} | \`${t.name}\` | ${Number(t.criterion)} | ${cell(t.level) || 'unit'} | ${cell(t.scenario)} | ${cell(t.expected)} |`),
    '',
    '## Tasks / Subtasks',
    '',
    `- [ ] [SEQ] Task 1: Salvaguarda de estado — verificar que el repo está como dice la historia${safeguard(toCreate, toModify)} (AC: todos)`,
    `- [ ] [SEQ] Task 2: las pruebas T1 a T${tests.length}, en rojo por la causa correcta (AC: todos)`,
    `- [ ] [SEQ] Task 3: el código que las pone en verde (AC: todos)`,
    '',
    '### Task Dependencies',
    '',
    'Task 1 → Task 2 → Task 3 (secuencial)',
    '',
    '## Lo que NO hay que hacer',
    '',
    ...(a.outOfScope || []).map(dontTouch),
    '- No escribir el código antes de ver las pruebas en rojo.',
    '',
    '## Cómo verificar que funciona',
    '',
    '```bash',
    ...verify,
    '```',
    '',
    '## Dev Notes',
    '',
    '### Patron de referencia verificado',
    '',
    'No aplica: historia escrita en el modo primera vez, sin proyecto BMAD.',
    '',
    '### Que existe hoy',
    '',
    ...(present.length ? present.map((f) => `- **Archivo:** \`${cell(f)}\` — ${toModify.includes(f) ? 'lo modifica la historia' : 'ya existe, y la historia dice crearlo: lo confirma la salvaguarda'}`) : []),
    ...(absent.length ? [`- **No existe:** ${absent.map((f) => `\`${cell(f)}\``).join(', ')}`] : []),
    ...(present.length || absent.length ? [] : ['La historia no nombra archivos: los decide el plan del recorrido y los confirma la salvaguarda.']),
    '',
    '### Que hay que hacer (la delta)',
    '',
    ...[...toCreate.map((f) => `Crear \`${cell(f)}\``), ...toModify.map((f) => `Modificar \`${cell(f)}\``)]
      .concat([`Que se cumplan los criterios 1 a ${criteria.length}, con las pruebas T1 a T${tests.length} en verde`])
      .map((x, i) => `${i + 1}. ${x}`),
    '',
    '### Archivos a crear/modificar',
    '',
    ...(files.length ? ['| Accion | Archivo |', '|--------|---------|', ...files] : ['Los decide el plan del recorrido.']),
    '',
    '## Dev Agent Record',
    '',
    '### Agent Model Used',
    '',
    '### Completion Notes List',
    '',
    '### File List',
    '',
  ].join('\n');
}

function write(repo, answersPath, home) {
  if (isBmad(repo)) throw new Refusal(`este repo es un proyecto BMAD (${BMAD_CONFIG}): la historia se crea con el flujo de BMAD, no con el modo primera vez`);
  let answers;
  try { answers = JSON.parse(fs.readFileSync(answersPath, 'utf8')); } catch (e) {
    throw new Refusal(`no pude leer las respuestas (${answersPath}): ${e.message}`);
  }
  const bad = problems(answers);
  if (bad.length) throw new Refusal(`no escribí la historia:\n${bad.map((p) => `  - ${p}`).join('\n')}`);
  const verify = verifyCommands(repo, answers);
  const { dir, number } = nextStory(repo);
  const target = path.join(dir, `story-${number}-${slug(answers.title)}.md`);
  if (fs.existsSync(target)) throw new Refusal(`no escribí la historia: ya existe ${target} y no lo piso`);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, render(answers, number, verify, (f) => fs.existsSync(path.join(repo, f))), { flag: 'wx' });
  try { fs.linkSync(tmpFile, target); } catch (e) {
    fs.unlinkSync(tmpFile);
    if (e.code === 'EEXIST') throw new Refusal(`no escribí la historia: ya existe ${target} y no lo piso`);
    throw e;
  }
  fs.unlinkSync(tmpFile);
  // Sin constancia la historia no arranca sola: antes que dejarla a medias, no se deja.
  try { writeRecord(home, target, number); } catch (e) {
    const why = `no pude dejar la constancia de la historia en la carpeta de estado del arnés (${e.code || e.message})`;
    try { fs.unlinkSync(target); } catch (err) {
      throw new Refusal(`${why}, y tampoco pude borrar ${target} (${err.code || err.message}): borrala a mano, sin la constancia no arranca sola`);
    }
    throw new Refusal(`${why}; no la dejé escrita. Revisá esa carpeta y volvé a correrlo`);
  }
  const rel = path.relative(repo, target).split(path.sep).join('/');
  // el cierre viaja en el resultado: lo que va sólo por la salida de errores el agente no lo dice
  const closing = `Listo, tu historia quedó en \`${rel}\`. Para implementarla, pedime: «implementemos la story ${rel}». ` +
    'Si el repo no tiene git o estás en `main`, el recorrido lo prepara solo: crea la rama de trabajo y te lo dice.';
  return { path: target, story: number, phrase: `implementemos la story ${rel}`, closing };
}

function main(argv) {
  const cmd = argv[0];
  const repoArg = arg(argv, '--repo');
  if (!['mode', 'write'].includes(cmd) || !repoArg) {
    process.stderr.write('uso: story-without-bmad.js mode --repo <dir> | write --repo <dir> --answers <archivo.json>\n');
    return 2;
  }
  const repo = path.resolve(repoArg);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    process.stderr.write(`no encuentro la carpeta del repo: ${repo}\n`);
    return 2;
  }
  try {
    if (cmd === 'mode') {
      const out = isBmad(repo) ? { mode: 'bmad' } : { mode: 'first-time', ...nextStory(repo) };
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return 0;
    }
    const answers = arg(argv, '--answers');
    if (!answers) throw new Refusal('falta --answers <archivo.json>');
    const out = write(repo, path.resolve(answers), require('os').homedir());
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.stderr.write(`Historia escrita: ${out.path}\nPara implementarla, pedile a tu agente de código: «${out.phrase}»\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) { process.stderr.write(`${e.message}\n`); return 2; }
    throw e;
  }
}

module.exports = { nextStory, problems, render, verifyCommands, isBmad, RECORD_DIR };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
