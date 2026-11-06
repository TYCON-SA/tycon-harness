'use strict';
// nightly-key.test.js — la llave del modelo de la noche en un solo lugar: el grupo de variables `harness-nightly-model`
// que enlazan los dos nocturnos con modelo, el paso que dice si la llave llegó (sin mostrarla) y los pasos del README
// para crear el grupo en orden. Lee los YAML como texto (no hay biblioteca de YAML en el arnés, a propósito) y corre de
// verdad los guiones de sus pasos sobre una carpeta de juguete. Sin red.
//
// Las copias que corren en el repo de operaciones se miran con el clon: `node scripts/tests/nightly-key.test.js
// --operations <clon>` (o la variable NIGHTLY_KEY_OPERATIONS). Sin el clon, esa prueba sale «no medido».
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'pipelines', 'operations');
const GRUPO = 'harness-nightly-model';
const PASO_LLAVE = 'Ver si llegó la llave del modelo de la noche';
const LLAVES = ['OLLAMA_API_KEY', 'ANTHROPIC_API_KEY'];
// los pasos que llaman al modelo, por el guion que corren; cuántos tiene cada nocturno
const MODELO = { 'dependency-audit.yml': { re: /scripts\/nightly\/findings\/propose\.js/, n: 1 }, 'instinct-proposals.yml': { re: /scripts\/instincts\/instinct-nightly\.js/, n: 2 } };
const DEFINICION_VIEJA = /variable\s+secreta\**\s+de\s+esta\s+definici/i;

const read = (file) => fs.readFileSync(file, 'utf8');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Los pasos de un YAML, a cualquier sangría (los de `instinct-proposals.yml` van dentro de `${{ if }}`). */
function pasos(texto) {
  const lines = texto.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^( *)- (script|template|task|checkout|bash):/);
    if (!m) continue;
    const d = m[1].length;
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].match(/^ */)[0].length > d)) j++;
    const block = lines.slice(i, j).join('\n');
    const nombre = (block.match(/displayName: '([^']*)'/) || [])[1] || null;
    const condition = (block.match(/^\s+condition: (.*)$/m) || [])[1] || null;
    // el guion: las líneas de `- script: |` más adentro que las claves del paso (d + 2)
    let script = null;
    if (m[2] === 'script' && /- script: \|\s*$/.test(lines[i])) {
      const cuerpo = [];
      for (let k = i + 1; k < j; k++) {
        const l = lines[k];
        if (l.trim() !== '' && l.match(/^ */)[0].length <= d + 2) break;
        cuerpo.push(l);
      }
      const sangria = Math.min(...cuerpo.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
      script = cuerpo.map((l) => l.slice(Math.min(sangria, l.match(/^ */)[0].length))).join('\n').replace(/\s+$/, '');
    }
    const env = {};
    const e = block.match(new RegExp(`^ {${d + 2}}env:\\n((?: {${d + 4},}\\S.*\\n?)*)`, 'm'));
    if (e) for (const l of e[1].split('\n')) { const kv = l.trim().match(/^(\w+): (.*)$/); if (kv) env[kv[1]] = kv[2]; }
    out.push({ block, nombre, condition, script, env });
  }
  return out;
}
/**
 * Cómo enlaza el grupo de la llave: por el parámetro `modelVariableGroup`, y sólo si trae valor (como el vigilante con
 * `hostsVariableGroup`; un grupo que no existe no deja arrancar el pipeline). Devuelve el valor por defecto del
 * parámetro, o null si el parámetro o el enlace condicional faltan.
 */
function grupoPorParametro(texto) {
  const p = texto.match(/^ {2}- name: modelVariableGroup\n((?: {4}.*\n)*)/m);
  if (!p) return null;
  const v = texto.match(/^variables:\n((?:(?: .*)?\n)*?)(?=^\S)/m);
  const enlace = /^ {2}- \$\{\{ if ne\(parameters\.modelVariableGroup, ''\) \}\}:\n {6}- group: \$\{\{ parameters\.modelVariableGroup \}\}$/m;
  if (!v || !enlace.test(v[1])) return null;
  const d = p[1].match(/^ {4}default: '([^']*)'/m);
  return d ? d[1] : null;
}
/** El guion de un paso, con las macros de Azure reemplazadas. */
function guion(texto, nombre, vars) {
  const p = pasos(texto).find((x) => x.nombre === nombre);
  assert.ok(p && p.script, `falta el paso script «${nombre}»`);
  let body = p.script;
  for (const [k, v] of Object.entries(vars)) body = body.split(`$(${k})`).join(v);
  assert.doesNotMatch(body, /\$\([A-Z][A-Za-z]+\.[A-Za-z.]+\)/, 'no quedó ninguna macro de Azure sin reemplazar');
  return { paso: p, body };
}
function carpeta() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-key-'));
  dirs.push(base);
  return base;
}
function sinLlaves(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!LLAVES.includes(k) && !/^(BUILD_|SYSTEM_|AGENT_)/.test(k)) e[k] = v;
  return { ...e, ...extra };
}
/** `porDefecto`: '' en el modelo público (ningún grupo con su nombre escrito); el nombre del grupo en la copia. */
function comprobarNocturno(texto, file, porDefecto) {
  assert.strictEqual(grupoPorParametro(texto), porDefecto, `${file}: enlaza el grupo por modelVariableGroup (por defecto «${porDefecto}»)`);
  if (porDefecto === '') assert.doesNotMatch(texto, /^\s*- group:(?!\s*\$\{\{\s*parameters\.)/m, `${file}: ningún grupo con su nombre escrito`);
  // por el bloque entero: en instinct-proposals.yml uno de los dos es una tarea AzureCLI@2 (el guion va en inlineScript)
  const delModelo = pasos(texto).filter((p) => MODELO[path.basename(file)].re.test(p.block));
  assert.strictEqual(delModelo.length, MODELO[path.basename(file)].n, `${file}: los pasos que llaman al modelo`);
  for (const p of delModelo) for (const k of LLAVES) assert.strictEqual(p.env[k], `$(${k})`, `${file}: «${p.nombre}» recibe ${k} en su env:`);
  const llave = pasos(texto).find((p) => p.nombre === PASO_LLAVE);
  assert.ok(llave, `${file}: trae el paso «${PASO_LLAVE}»`);
  assert.strictEqual(llave.condition, null, `${file}: el paso de la llave corre con y sin efectos`);
  for (const k of LLAVES) assert.strictEqual(llave.env[k], `$(${k})`, `${file}: el paso de la llave recibe ${k}`);
}

test('8.155-Nocturnos_EnlazanElGrupo @story-8.155 @ac-1: los dos enlazan el grupo por parámetro (vacío de fábrica), cada paso del modelo recibe las dos llaves y la cabecera nombra el grupo', () => {
  for (const f of Object.keys(MODELO)) comprobarNocturno(read(path.join(DIR, f)), f, '');
  const cabecera = read(path.join(DIR, 'instinct-proposals.yml')).split('\n').filter((l) => l.startsWith('#')).join('\n');
  assert.match(cabecera, new RegExp(GRUPO), 'la cabecera de instinct-proposals.yml nombra el grupo');
  assert.doesNotMatch(cabecera, DEFINICION_VIEJA, 'y ya no dice «variable secreta de esta definición»');
});

test('8.155-Nocturnos_SinLlave_SalenComoHoy @story-8.155 @ac-2: una llave que llega como `$(NOMBRE)` cuenta como ausente y nada se pone rojo', async () => {
  // dependency-audit.yml: el paso del modelo, corrido de verdad con un propose.js de mentira que anota qué llave le llegó
  const job = path.join(carpeta(), 'job');
  fs.mkdirSync(path.join(job, 'scripts', 'nightly', 'findings'), { recursive: true });
  const out = path.join(job, 'llaves.json');
  fs.writeFileSync(path.join(job, 'scripts', 'nightly', 'findings', 'propose.js'),
    'const v = (k) => process.env[k] === undefined ? "ausente" : "puesta"; require("fs").writeFileSync(process.env.LAB_OUT, JSON.stringify({ ollama: v("OLLAMA_API_KEY"), anthropic: v("ANTHROPIC_API_KEY") }));\n');
  const texto = read(path.join(DIR, 'dependency-audit.yml'));
  const nombre = pasos(texto).find((p) => p.script && MODELO['dependency-audit.yml'].re.test(p.script)).nombre;
  const { body } = guion(texto, nombre, { 'Build.SourcesDirectory': job });
  const r = spawnSync('bash', ['-c', body], { cwd: job, env: sinLlaves({ OLLAMA_API_KEY: '$(OLLAMA_API_KEY)', ANTHROPIC_API_KEY: '$(ANTHROPIC_API_KEY)', LAB_OUT: out }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(read(out)), { ollama: 'ausente', anthropic: 'ausente' });
  // instinct-proposals.yml: el literal lo descarta el lector de la llave, sin llamar a la red
  const { llamar } = require(path.join(ROOT, 'scripts', 'instincts', 'instinct-model.js'));
  let llamadas = 0;
  const nightly = { ok: true, provider: 'ollama', model: 'm', secret: { env: 'OLLAMA_API_KEY', present: true } };
  const res = await llamar({ nightly, prompt: 'p', env: { OLLAMA_API_KEY: '$(OLLAMA_API_KEY)' }, fetchImpl: async () => { llamadas += 1; throw new Error('sin red'); } });
  assert.deepStrictEqual(res, { ok: false, fallo: 'sin_llave' });
  assert.strictEqual(llamadas, 0, 'sin llave no se llama al modelo');
});

/** La sección del README que crea el grupo y sus pasos numerados. */
function seccionDelGrupo() {
  const t = read(path.join(DIR, 'README.md'));
  const i = t.search(new RegExp(`^## \\d+\\. .*grupo`, 'm'));
  assert.ok(i >= 0, 'el README tiene una sección del grupo');
  const resto = t.slice(i + 3);
  const fin = resto.search(/^## /m);
  const sec = fin >= 0 ? t.slice(i, i + 3 + fin) : t.slice(i);
  const items = [];
  for (const l of sec.split('\n')) {
    const m = l.match(/^(\d+)\. (.*)$/);
    if (m) items.push(m[2]); else if (items.length && /^ {3}\S/.test(l)) items[items.length - 1] += ` ${l.trim()}`;
  }
  return { todo: t, sec, items };
}

test('8.155-Readme_PasosDelGrupo @story-8.155 @ac-3: el grupo, sus dos variables, las dos definiciones, sólo ésas, el valor sólo por la pantalla y la variable vieja al final', () => {
  const { todo, sec, items } = seccionDelGrupo();
  for (const s of [GRUPO, ...LLAVES, 'dependency-audit', 'instinct-proposals']) assert.ok(sec.includes(s), `la sección nombra ${s}`);
  assert.match(sec, /sólo\s+para\s+(?:esas|las)\s+dos\s+definiciones/i, 'se autoriza sólo para esas dos');
  assert.match(sec, /nunca[^.]*(?:Open access|todas las pipelines)/i, 'nunca para todas las pipelines');
  assert.match(sec, /secret/i, 'el valor va marcado como secreto');
  assert.match(sec, /nunca\s+en\s+una\s+línea\s+de\s+comandos[^.]*archivo/i, 'nunca en una línea de comandos ni en un archivo');
  assert.ok(items.length >= 5, `los pasos van numerados (${items.length})`);
  assert.match(items[items.length - 1], /variable vieja/i, 'sacar la variable vieja es el último paso');
  assert.doesNotMatch(todo, DEFINICION_VIEJA, 'el README ya no dice «variable secreta de esta definición»');
});

test('8.155-Readme_ElGrupoAntesDelEnlace @story-8.155 @ac-11: crear y autorizar, probar sin efectos y ver «llegó», mergear, y la variable vieja al final', () => {
  const { sec, items } = seccionDelGrupo();
  const donde = (re) => items.findIndex((x) => re.test(x));
  const crear = donde(new RegExp(`(?:Cre[aá]|cre[aá]).*${GRUPO}|${GRUPO}.*(?:Library|Biblioteca)`));
  const autorizar = donde(/Pipeline permissions|autoriz/i);
  const probar = donde(/az pipelines run --id <id de dependency-audit>/);
  const mergear = donde(/merge/i);
  const vieja = donde(/variable vieja/i);
  assert.ok(crear >= 0 && autorizar > crear && probar > autorizar && mergear > probar && vieja > mergear,
    `orden: crear ${crear} < autorizar ${autorizar} < probar ${probar} < mergear ${mergear} < vieja ${vieja}`);
  assert.match(items[probar], /--id <id de instinct-proposals>/, 'la prueba corre las dos definiciones');
  assert.match(items[probar], /llegó/, 'y pide ver «llegó» en la llave del proveedor');
  assert.match(items[probar], /sin pedir permiso/i, 'y que arranquen sin pedir permiso');
  const corridas = sec.split('\n').filter((l) => /az pipelines run/.test(l));
  assert.ok(corridas.length >= 1, 'el comando de la prueba está escrito');
  for (const l of corridas) assert.match(l, /--parameters efectos=false/, `toda corrida de prueba va sin efectos: ${l.trim()}`);
});

test('8.155-Nocturnos_DiceSiLlegoLaLlave @story-8.155 @ac-11: «llegó» con la llave, «no llegó» con el literal, vacía o en blanco; nunca el valor ni su largo', () => {
  const LLAVE_INVENTADA = 'valor-inventado-de-prueba';
  const casos = [
    ['cargada', LLAVE_INVENTADA, 'llegó'],
    ['literal', '$(OLLAMA_API_KEY)', 'no llegó'],
    ['vacía', '', 'no llegó'],
    ['en blanco', '   ', 'no llegó'],
    ['sin definir', undefined, 'no llegó'],
  ];
  for (const f of Object.keys(MODELO)) {
    const texto = read(path.join(DIR, f));
    const { paso, body } = guion(texto, PASO_LLAVE, {});
    assert.doesNotMatch(body, /set -x|xtrace/, `${f}: el paso no traza sus comandos`);
    assert.strictEqual(paso.condition, null, `${f}: sin condición de efectos`);
    for (const [caso, valor, quiere] of casos) {
      const extra = valor === undefined ? { ANTHROPIC_API_KEY: LLAVE_INVENTADA } : { OLLAMA_API_KEY: valor, ANTHROPIC_API_KEY: LLAVE_INVENTADA };
      const r = spawnSync('bash', ['-c', body], { cwd: carpeta(), env: sinLlaves(extra), encoding: 'utf8' });
      const salida = `${r.stdout}${r.stderr}`;
      assert.strictEqual(r.status, 0, `${f} ${caso}: sale 0 (${salida})`);
      assert.match(r.stdout, new RegExp(`^OLLAMA_API_KEY: ${quiere}$`, 'm'), `${f} ${caso}: ${salida}`);
      assert.match(r.stdout, /^ANTHROPIC_API_KEY: llegó$/m, `${f} ${caso}: la otra llave`);
      assert.ok(!salida.includes(LLAVE_INVENTADA) && !salida.includes('inventado'), `${f} ${caso}: el valor no sale`);
      assert.ok(!salida.includes(String(LLAVE_INVENTADA.length)), `${f} ${caso}: su largo tampoco`);
    }
  }
});

/** El clon del repo de operaciones: `--operations <clon>` o NIGHTLY_KEY_OPERATIONS. */
function clonDeOperaciones() {
  const i = process.argv.indexOf('--operations');
  return (i >= 0 && process.argv[i + 1]) || process.env.NIGHTLY_KEY_OPERATIONS || null;
}

test('8.155-Operaciones_EnlazaElGrupo @story-8.155 @ac-4: las dos copias que corren en el repo de operaciones enlazan el grupo, como la plantilla', (t) => {
  const clon = clonDeOperaciones();
  if (!clon) { t.skip('no medido: falta --operations <clon del repo de operaciones>'); return; }
  for (const f of Object.keys(MODELO)) {
    const file = path.join(clon, 'pipelines', f);
    assert.ok(fs.existsSync(file), `el repo de operaciones trae pipelines/${f}`);
    comprobarNocturno(read(file), `operaciones/${f}`, GRUPO);
  }
});
