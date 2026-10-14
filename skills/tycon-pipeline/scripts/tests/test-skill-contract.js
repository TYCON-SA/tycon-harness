#!/usr/bin/env node
/**
 * test-skill-contract.js — el SKILL.md del pipeline se puede achicar, pero no puede perder nada
 * (story 7.7 del arnés, 2026-09-19).
 *
 * El SKILL.md se carga ENTERO en cada corrida y el hilo principal lo relee en cada respuesta: con
 * 107 KB era la pieza más pesada del piso que controla el arnés. La story lo bajó a menos de 25 KB
 * mudando la historia (casos, fechas, mediciones) a HISTORIA.md, que no se carga sola. Recortar a
 * mano un archivo de reglas es exactamente cómo se pierde una en silencio, así que el recorte vive
 * detrás de esta guarda:
 *
 *   1. CONTRATO — cada id de regla, subcomando de marker.js/pipeline.js, flag y variable de entorno
 *      que nombraban el SKILL.md de la base y los step files sigue apareciendo en el SKILL.md nuevo o
 *      en algún step file, o está en `historicos` con su motivo. Si falta uno, falla nombrándolo.
 *   2. PÁRRAFOS — cada párrafo del SKILL.md de la base está, literal, en el SKILL.md nuevo o en
 *      HISTORIA.md. La historia se muda; no se tira. HISTORIA.md nombra los productos del equipo: vive en el repo
 *      de mantenimiento y no se publica. Por eso el contrato declara, por su huella, qué párrafos se mudaron allá
 *      (`en_historia`): donde está HISTORIA.md (el árbol armado de los nocturnos) se verifica que cada uno esté de
 *      verdad; en el público solo, un párrafo de la base tiene que estar en el SKILL.md o figurar en esa lista.
 *   3. FORMA — el SKILL.md pesa ≤ 25 KB, su frontmatter es el de la base, y trae las tres
 *      correcciones que encontró el laboratorio (exit 4 del test-gate, cierre del Step 8 con
 *      `marker.js clear` + review, resumen de la matriz en el Step 7).
 *
 * La base es el SKILL.md del commit fijado en el contrato (`base`), no «el anterior»: después del
 * merge, HEAD~ deja de ser la versión grande.
 *
 * Uso:
 *   node test-skill-contract.js              verifica (exit 0 verde · 1 rojo)
 *   node test-skill-contract.js --generate   regenera fixtures/skill-contract.json desde la base
 *                                            (conserva `historicos`; pide git)
 *   node test-skill-contract.js --history    escribe HISTORIA.md con los párrafos de la base que
 *                                            el SKILL.md actual ya no tiene literales (pide git)
 *   --skill <ruta>                           verificar otro SKILL.md (para probar mutantes)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.join(__dirname, '..', '..');
const REPO = path.join(SKILL_DIR, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'skill-contract.json');
const HISTORIA = path.join(SKILL_DIR, 'HISTORIA.md');
const STEPS = path.join(SKILL_DIR, 'steps');
const REL_SKILL = 'skills/tycon-pipeline/SKILL.md';
const TOPE_BYTES = 25 * 1024;

// ── Extracción ──────────────────────────────────────────────────────────────────────────────
// Ids de regla con número (PIPE-C0, DODRT-C5.1, SPEED-1, BUG-PIPELINE-006) y con ordinal romano
// (D.i.1, COMM.iii, I.i.c.1).
const RE_ID_NUM = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[A-Z]?\d+(?:\.\d+)?\b/g;
const RE_ID_ROM = /\b[A-Z]{1,5}\.[ivx]+(?:\.[a-z0-9]+)*\b/g;
const RE_CMD = /\b(marker|pipeline)\.js\s+([a-z][a-z0-9-]+)/g;
const RE_FLAG = /(?<![\w-])--[a-z][a-z0-9-]+/g;
const RE_ENV = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/g;

function sinFrontmatter(texto) {
  const m = /^---\n[\s\S]*?\n---\n/.exec(texto);
  return m ? texto.slice(m[0].length) : texto;
}

function frontmatter(texto) {
  const m = /^---\n[\s\S]*?\n---\n/.exec(texto);
  return m ? m[0] : '';
}

function extraer(texto) {
  const out = { regla: new Set(), comando: new Set(), flag: new Set(), env: new Set() };
  for (const m of texto.matchAll(RE_ID_NUM)) out.regla.add(m[0]);
  for (const m of texto.matchAll(RE_ID_ROM)) out.regla.add(m[0]);
  for (const m of texto.matchAll(RE_CMD)) out.comando.add(`${m[1]}.js ${m[2]}`);
  for (const m of texto.matchAll(RE_FLAG)) out.flag.add(m[0]);
  for (const m of texto.matchAll(RE_ENV)) out.env.add(m[0]);
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ¿La entrada sigue nombrada? Ids, flags y env: con el MISMO extractor que armó el contrato — si
// presencia y extracción usaran reglas distintas, la base misma daría faltas falsas (pasó: un id
// pegado a un guion, `#done-sin-advisors-S1-…`, se extraía y no se «encontraba»).
// Comandos: `marker.js X` literal, o X como token ENTERO en backticks (`X`, `X N`, `X|Y`) dentro de
// un bloque —viñeta o párrafo— que nombra el mismo script: así lista la referencia rápida,
// «**marker.js**: `get` · `set` …». 🔴 Sin esas dos condiciones un nombre de archivo o de otro
// script contaba como el comando: `adhoc.log` hacía pasar a `marker.js adhoc`, y el `start` de
// otra skill a `pipeline.js start` (pase adversarial de la 7.7, 2 hallazgos confirmados).
function bloques(texto) {
  return texto.split(/\n(?=[ \t]*(?:[-*] |\d+\. |#)|[ \t]*\n)/);
}
function presente(tipo, entrada, texto, ex = extraer(texto)) {
  if (tipo === 'comando') {
    if (ex.comando.has(entrada)) return true;
    const [script, sub] = entrada.split(' ');
    const token = new RegExp('`' + esc(sub) + '(?=[`\\s|])');
    return bloques(texto).some((b) => b.includes(script) && token.test(b));
  }
  return ex[tipo].has(entrada);
}

// ── Párrafos ────────────────────────────────────────────────────────────────────────────────
// Párrafo = bloque entre líneas en blanco. Se compara normalizado (sin sangría ni espacios de más) y
// se escribe crudo, para que HISTORIA.md conserve las listas anidadas tal como estaban.
const normalizar = (p) => p.split('\n').map((l) => l.trim()).join('\n').trim();
function parrafosCrudos(texto) {
  return sinFrontmatter(texto).split(/\n[ \t]*\n/).map((p) => p.replace(/^\n+|\s+$/g, '')).filter((p) => normalizar(p).length > 3);
}
function parrafos(texto) {
  return parrafosCrudos(texto).map(normalizar);
}
const hash = (p) => crypto.createHash('sha1').update(p.replace(/\s+/g, ' ')).digest('hex').slice(0, 16);

// ── Lectura ─────────────────────────────────────────────────────────────────────────────────
// Todo se lee con finales de línea LF: agent-skills no tiene .gitattributes, y un checkout de Git
// para Windows (autocrlf) trae CRLF — el frontmatter no matcheaba y todos los párrafos salían
// «perdidos» sobre un SKILL.md sin cambios (pase adversarial de la 7.7).
const lf = (t) => String(t).replace(/\r\n/g, '\n');
const leer = (p) => lf(fs.readFileSync(p, 'utf8'));
function leerBase(sha) {
  return lf(execFileSync('git', ['-C', REPO, 'show', `${sha}:${REL_SKILL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
function textoSteps() {
  return fs.readdirSync(STEPS).filter((f) => f.endsWith('.md')).sort()
    .map((f) => leer(path.join(STEPS, f))).join('\n');
}

// ── Modos ───────────────────────────────────────────────────────────────────────────────────
function generar() {
  const previo = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : {};
  const base = previo.base;
  if (!base) throw new Error('el contrato no declara `base` (commit del SKILL.md de referencia)');
  const skillBase = leerBase(base);
  const ex = extraer(sinFrontmatter(skillBase) + '\n' + textoSteps());
  const contrato = {
    _por_que: previo._por_que,
    base,
    frontmatter: frontmatter(skillBase),
    entradas: Object.fromEntries(Object.entries(ex).map(([k, v]) => [k, [...v].sort()])),
    historicos: previo.historicos || [],
    en_historia: previo.en_historia || [],
    parrafos: parrafos(skillBase).map((p) => ({ h: hash(p), inicio: p.slice(0, 70).replace(/\s+/g, " ") })),
  };
  fs.writeFileSync(FIXTURE, JSON.stringify(contrato, null, 1) + '\n');
  const n = Object.values(contrato.entradas).reduce((a, v) => a + v.length, 0);
  console.log(`contrato regenerado desde ${base}: ${n} entradas, ${contrato.parrafos.length} párrafos`);
}

function historia() {
  const c = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const skillBase = leerBase(c.base);
  const nuevos = new Set(parrafos(leer(path.join(SKILL_DIR, 'SKILL.md'))).map(hash));
  const salen = parrafosCrudos(skillBase).filter((p) => !nuevos.has(hash(normalizar(p))));
  const cab = [
    '# tycon-pipeline — historia',
    '',
    '> **No se carga sola.** La regla vigente está en `SKILL.md` y en `steps/`. Acá quedan, textuales y en su',
    `> orden, los párrafos que el \`SKILL.md\` tenía hasta el commit \`${c.base.slice(0, 7)}\` (107 KB) y que el recorte de la`,
    '> story 7.7 del arnés (2026-09-19) sacó: los casos disparadores, las fechas, las mediciones y el detalle de',
    '> cada freno. Se lee para entender por qué una regla dice lo que dice, antes de relajarla o podarla.',
    '> La guarda que verifica que nada se perdió es `scripts/tests/test-skill-contract.js`.',
    '',
  ];
  fs.writeFileSync(HISTORIA, cab.join('\n') + '\n' + salen.join('\n\n') + '\n');
  console.log(`HISTORIA.md: ${salen.length} párrafos`);
}

// La guarda se prueba a sí misma antes de juzgar: si el criterio de «presente» se afloja, un
// comando puede desaparecer y T2 seguir verde. Cada caso es uno que el pase adversarial reprodujo.
function autoprueba() {
  const f = [];
  const esta = (e, t) => presente('comando', e, t);
  if (esta('marker.js adhoc', 'el registro va a `adhoc.log` (cupo 8)')) f.push('un nombre de archivo (`adhoc.log`) cuenta como `marker.js adhoc`');
  if (esta('pipeline.js advisor-runs', '| `advisor-runs/<sesión>.jsonl` | lanzamientos |')) f.push('una ruta (`advisor-runs/…`) cuenta como `pipeline.js advisor-runs`');
  if (esta('pipeline.js start', '- **clocki**: `start` · `stop`')) f.push('el `start` de otro script cuenta como `pipeline.js start`');
  if (!esta('marker.js adhoc', '- **marker.js**: `get` ·\n  `adhoc set|get|clear` · `clear`.')) f.push('la referencia rápida de dos renglones no cuenta');
  if (!esta('marker.js get', '- **marker.js**: `get` · `set`')) f.push('`get` en la referencia rápida no cuenta');
  if (frontmatter(lf('---\r\nname: x\r\n---\r\ncuerpo')) !== '---\nname: x\n---\n') f.push('el frontmatter con CRLF no se reconoce');
  if (parrafos(lf('primero\r\n\r\nsegundo')).length !== 2) f.push('los párrafos con CRLF no se separan');
  return f.map((x) => `T0 AutopruebaDeLaGuarda: ${x}`);
}

// Mínimos del contrato: un fixture vaciado (regeneración contra la base equivocada, git que falla a
// medias) daba «✅ contrato completo» sin haber verificado nada. Los números son la base de hoy con
// margen: 282 entradas y 161 párrafos.
const MIN_ENTRADAS = 200, MIN_PARRAFOS = 100;

function verificar(skillPath) {
  const fallas = autoprueba();
  const c = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const skill = leer(skillPath);
  const hist = fs.existsSync(HISTORIA) ? leer(HISTORIA) : '';
  const nEntradas = Object.values(c.entradas || {}).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0);
  const nParrafos = Array.isArray(c.parrafos) ? c.parrafos.length : 0;
  if (!c.frontmatter || nEntradas < MIN_ENTRADAS || nParrafos < MIN_PARRAFOS) {
    fallas.push(`T0 ContratoPoblado: el contrato está vacío o incompleto (${nEntradas} entradas, ${nParrafos} párrafos, frontmatter ${c.frontmatter ? 'sí' : 'no'}; mínimos ${MIN_ENTRADAS}/${MIN_PARRAFOS}) — regeneralo con --generate`);
  }

  // T1 — tamaño y frontmatter
  const bytes = Buffer.byteLength(skill, 'utf8');
  if (bytes > TOPE_BYTES) fallas.push(`T1 SkillMd_Tamano_Frontmatter: el SKILL.md pesa ${bytes} bytes (tope ${TOPE_BYTES})`);
  if (frontmatter(skill) !== c.frontmatter) fallas.push('T1 SkillMd_Tamano_Frontmatter: el frontmatter del SKILL.md no es el de la base');

  // T2 — contrato
  const texto = sinFrontmatter(skill) + '\n' + textoSteps();
  const ex = extraer(texto);
  const hist_ = new Set((c.historicos || []).map((h) => h.id));
  for (const [tipo, lista] of Object.entries(c.entradas)) {
    for (const e of lista) {
      if (hist_.has(e)) continue;
      if (!presente(tipo, e, texto, ex))fallas.push(`T2 SkillContrato_NadaFalta: falta ${tipo} «${e}» (ni en SKILL.md ni en steps/, ni en historicos)`);
    }
  }
  for (const h of c.historicos || []) {
    if (!h.motivo || !String(h.motivo).trim()) fallas.push(`T2 SkillContrato_NadaFalta: el histórico «${h.id}» no dice su motivo`);
  }

  // T3 — párrafos conservados. Con HISTORIA.md al lado, cuenta lo que trae; sin ella (el público solo), cuentan los
  // párrafos que el contrato declara mudados allá — y donde está, cada declarado tiene que estar de verdad.
  const enHistoria = new Set(Array.isArray(c.en_historia) ? c.en_historia : []);
  const tiene = new Set([...parrafos(skill), ...(hist ? parrafos(hist) : [])].map(hash));
  if (!hist) for (const h of enHistoria) tiene.add(h);
  else {
    const histHashes = new Set(parrafos(hist).map(hash));
    const mienten = c.parrafos.filter((p) => enHistoria.has(p.h) && !histHashes.has(p.h));
    for (const p of mienten.slice(0, 20)) fallas.push(`T3 Historia_TodoParrafoConservado: el contrato lo declara en HISTORIA.md y no está: «${p.inicio}…»`);
  }
  const perdidos = c.parrafos.filter((p) => !tiene.has(p.h));
  for (const p of perdidos.slice(0, 20)) fallas.push(`T3 Historia_TodoParrafoConservado: párrafo perdido: «${p.inicio}…»`);
  if (perdidos.length > 20) fallas.push(`T3 Historia_TodoParrafoConservado: … y ${perdidos.length - 20} párrafos perdidos más`);

  // T4 — las tres correcciones del laboratorio
  const cuerpo = sinFrontmatter(skill);
  if (!/test-gate[\s\S]{0,400}\b4\b[^\n]*(FRENO|frena)/i.test(cuerpo)) fallas.push('T4 SkillMd_CorreccionesLab: falta el exit 4 (FRENO) del test-gate');
  if (!/Step 8[^\n]*marker\.js clear[^\n]*review/i.test(cuerpo)) fallas.push('T4 SkillMd_CorreccionesLab: falta el cierre del Step 8 (`marker.js clear` + story en review)');
  if (!/Corrido de verdad: N de T/.test(cuerpo)) fallas.push('T4 SkillMd_CorreccionesLab: falta el resumen de la matriz del Step 7 («Corrido de verdad: N de T…»)');

  return fallas;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  // story 8.9 (tanda B3b): las opciones viejas siguen andando hasta el retiro
  require('../lib/legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/tests/test-skill-contract.js');
  const args = process.argv.slice(2);
  try {
    if (args.includes('--generate')) { generar(); process.exit(0); }
    if (args.includes('--history')) { historia(); process.exit(0); }
    const i = args.indexOf('--skill');
    const skillPath = i >= 0 ? path.resolve(args[i + 1]) : path.join(SKILL_DIR, 'SKILL.md');
    const fallas = verificar(skillPath);
    if (fallas.length) {
      console.log(`❌ test-skill-contract: ${fallas.length} falla(s)`);
      for (const f of fallas) console.log('   ' + f);
      process.exit(1);
    }
    console.log('✅ test-skill-contract: SKILL.md ≤ 25 KB, contrato completo, historia conservada, correcciones del laboratorio presentes');
  } catch (e) {
    console.log(`❌ test-skill-contract: no pude correr — ${e.message}`);
    process.exit(1);
  }
}

module.exports = { extraer, presente, parrafos, hash, verificar };
