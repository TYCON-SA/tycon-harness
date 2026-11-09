#!/usr/bin/env node
'use strict';
/**
 * control-size.js — el tamaño de cada control del arnés, y un aviso cuando crece de más. Sólo lee; nunca frena.
 * Casos: scripts/tests/control-size.test.js
 *
 * POR QUÉ EXISTE: algunos controles pasan las 90.000 letras, y el riesgo no es el tamaño sino que cueste demostrar que
 * cada protección funciona sola y junto a las demás. Un archivo grande, además, deja ciego al freno de guiones: no lo
 * lee entero (su tope por archivo) y deja de recorrer los módulos que carga (su tope de recorrido). Esto mide las dos
 * cosas y avisa en cada pedido, sin frenar: un aviso nuevo se mide antes de volverlo freno.
 *
 * QUÉ ES UN CONTROL: los guiones del primer nivel de skills/tycon-pipeline/scripts/, scripts/hooks/ y scripts/ci/
 * (`.js`, `.cjs`, `.mjs`, `.sh`), sin `*.test.*`. Las subcarpetas (lib/, tests/, …) no son controles.
 *
 * QUÉ CUENTA, por control:
 *   · letras: los caracteres del archivo.
 *   · subcomandos (una cuenta aproximada, para comparar en el tiempo): en un `.js`, los textos distintos que se comparan
 *     con la variable que el guion lee de sus argumentos (`const cmd = process.argv[2]`, `const [cmd] =
 *     process.argv.slice(2)`, o el primero de `argv = process.argv.slice(2)`), con `===` o en un `case` de su `switch`.
 *     Una variable que se llama igual pero sale de otro lado (el evento de un gancho) no cuenta. En un `.sh`, las ramas
 *     del `case` sobre `$1` (o sobre la variable que lo copia) en el nivel de arriba del guion, sin sangría: dentro de
 *     una función, `$1` es el argumento de la función. Un control sin ninguno sale «—», no 0.
 *   · quién lo llama: los archivos versionados (`git ls-files`) que lo nombran por su nombre, sin él mismo, sin pruebas
 *     y sin `.md`; los `.json` de configuración cuentan. Sin git, «no medido».
 *   · lo que no se puede leer va aparte, «no medido» con su motivo: nunca se cuenta como chico.
 *
 * EL RECORRIDO DEL FRENO: el freno de guiones (skills/tycon-pipeline/scripts/on-bash-write-gate.js, `guionesEnArchivo`)
 * sigue los `require` locales del guion que nombra un comando, con dos cortes que se leen de SU texto, nunca copiados:
 *   · por nivel (`hondo >= N`): un módulo del nivel N entra, pero lo que él carga no se mira;
 *   · por cantidad (`modulos[cuenta]++ >= M`): desde el módulo M+1 de una cuenta, el módulo no entra (ni se revisa ni se
 *     siguen sus `require`). Hay dos cuentas por comando entero, la de los módulos del arnés y la de los demás: con dos
 *     despachadores en el mismo comando el tope llega antes, así que lo medido acá por despachador es el caso más
 *     favorable.
 * Si el texto del freno no trae esos dos números, el aviso dice «no medido»: nunca calla. Un despachador que falta, o un
 * módulo suyo que no se puede leer, también se dice («no medido»). Un `require` local que no resuelve a un archivo no se
 * sigue, igual que en el freno: los dos ven el mismo árbol. Por cada despachador
 * (marker.js, pipeline.js y el freno mismo) se mide cuántos módulos locales alcanza y en cuántos niveles, sin tope, y se
 * avisa desde el tope por 0,75 (en niveles o en módulos, lo que llegue primero).
 *
 * USO:  node scripts/ci/control-size.js [--root <dir>] [--range <base>...<punta>] [--gate <archivo>] [--json]
 *   --root    el árbol a medir; por defecto, el del guion.
 *   --range   avisa sólo por lo que el rango toca: un control que queda por encima del tope y creció contra la base, y un
 *             despachador cuyo recorrido incluye un archivo tocado. Un rango que no se lee se dice («no medido») y se
 *             avisa como sin rango.
 *   --gate    el freno del que se lee el tope; por defecto, el del árbol.
 *   --json    lo mismo, como datos.
 * SALIDA: 0 siempre que corre (con avisos o sin ellos); 2 con un argumento que no entiende. Cada aviso es un renglón
 * que empieza con «⚠️ control-size: », que la CI pública levanta como aviso del pedido (scripts/ci/public-ci.sh).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOPE_LETRAS = 90000;
// la mitad del margen: el tope del freno será lo medido por dos, y el aviso sale en lo medido por 1,5
const FRACCION_AVISO = 0.75;
const CARPETAS = ['skills/tycon-pipeline/scripts', 'scripts/hooks', 'scripts/ci'];
const EXTENSIONES = /\.(?:js|cjs|mjs|sh)$/;
const DESPACHADORES = ['skills/tycon-pipeline/scripts/marker.js', 'skills/tycon-pipeline/scripts/pipeline.js',
  'skills/tycon-pipeline/scripts/on-bash-write-gate.js'];
const FRENO = 'skills/tycon-pipeline/scripts/on-bash-write-gate.js';
// un archivo más grande que esto no se mira para buscar quién llama (un dato generado, no código)
const TOPE_LLAMADOR = 3 * 1024 * 1024;

function uso(msg) {
  process.stderr.write(`control-size: ${msg}\n  uso: node scripts/ci/control-size.js [--root <dir>] [--range <base>...<punta>] [--gate <archivo>] [--json]\n`);
  process.exit(2);
}

function opciones(argv) {
  const o = { root: path.resolve(__dirname, '..', '..'), range: null, gate: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--root' || a === '--range' || a === '--gate') {
      if (!argv[i + 1]) uso(`${a} pide un valor`);
      o[a.slice(2)] = argv[++i];
    } else uso(`no entiendo ${a}`);
  }
  o.root = path.resolve(o.root);
  o.gate = o.gate ? path.resolve(o.gate) : path.join(o.root, FRENO);
  return o;
}

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, motivo: r.error.message };
  if (r.status !== 0) return { ok: false, motivo: (r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}` };
  return { ok: true, out: r.stdout };
}

const letrasDe = (texto) => { let n = 0; for (const _ of texto) n++; return n; };
const conPuntos = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── subcomandos ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Los nombres de las variables que guardan el subcomando que el guion lee de sus argumentos. */
function variablesDelSubcomando(texto) {
  const vars = new Set();
  for (const m of texto.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*process\.argv\[2\]/g)) vars.add(m[1]);
  for (const m of texto.matchAll(/\b(?:const|let|var)\s+\[\s*(\w+)[^\]]*\]\s*=\s*process\.argv\.slice\(2\)/g)) vars.add(m[1]);
  for (const m of texto.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*process\.argv\.slice\(2\)/g)) {
    const a = escapar(m[1]);
    for (const n of texto.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*${a}(?:\\[0\\]|\\.shift\\(\\))`, 'g'))) vars.add(n[1]);
  }
  return vars;
}

/** El cuerpo entre llaves que empieza en `desde` (el índice de la `{`). Sin cerrar, hasta el final. */
function bloque(texto, desde) {
  let hondo = 0;
  for (let i = desde; i < texto.length; i++) {
    if (texto[i] === '{') hondo++;
    else if (texto[i] === '}' && --hondo === 0) return texto.slice(desde, i + 1);
  }
  return texto.slice(desde);
}

function subcomandosJs(texto) {
  const vars = variablesDelSubcomando(texto);
  if (!vars.size) return null;
  const vistos = new Set();
  for (const v of vars) {
    const e = escapar(v);
    for (const m of texto.matchAll(new RegExp(`\\b${e}\\s*===?\\s*(['"])([^'"\\n]+)\\1`, 'g'))) vistos.add(m[2]);
    for (const m of texto.matchAll(new RegExp(`(['"])([^'"\\n]+)\\1\\s*===?\\s*${e}\\b`, 'g'))) vistos.add(m[2]);
    for (const m of texto.matchAll(new RegExp(`switch\\s*\\(\\s*${e}\\s*\\)\\s*\\{`, 'g'))) {
      for (const c of bloque(texto, m.index + m[0].length - 1).matchAll(/\bcase\s+(['"])([^'"\n]+)\1\s*:/g)) vistos.add(c[2]);
    }
  }
  return vistos.size || null;
}

// sólo el nivel de arriba del guion (sin sangría): dentro de una función, `$1` es el argumento de la función
function subcomandosSh(texto) {
  const vars = new Set(['1']);
  // `X=$1`, `X="${1:-…}"`, `X="${1:?…}"; shift` …
  for (const m of texto.matchAll(/^(\w+)=["']?\$\{?1(?::?[-?=+][^}]*)?\}?["']?\s*(?:;.*)?$/gm)) vars.add(m[1]);
  const vistos = new Set();
  const lineas = texto.split('\n');
  for (let i = 0; i < lineas.length; i++) {
    const c = lineas[i].match(/^case\s+"?\$\{?(\w+)(?::-[^}]*)?\}?"?\s+in\b/);
    if (!c || !vars.has(c[1])) continue;
    for (let j = i + 1; j < lineas.length && !/^\s*esac\b/.test(lineas[j]); j++) {
      const rama = lineas[j].match(/^\s*([A-Za-z][\w-]*(?:\s*\|\s*[A-Za-z-][\w-]*)*)\s*\)/);
      if (rama) for (const w of rama[1].split('|')) vistos.add(w.trim());
    }
  }
  return vistos.size || null;
}

const subcomandos = (ruta, texto) => (ruta.endsWith('.sh') ? subcomandosSh(texto) : subcomandosJs(texto));

// ── quién llama ────────────────────────────────────────────────────────────────────────────────────────────────────

const ultimasDos = (rel) => `${path.posix.basename(path.posix.dirname(rel))}/${path.posix.basename(rel)}`;

/**
 * Cuántos archivos versionados nombran a cada guion. Una sola pasada por archivo. Un nombre que se repite en el árbol
 * (dos archivos `x.js` en carpetas distintas) cuenta sólo cuando la mención trae su carpeta (`ci/x.js`, o una ruta
 * relativa que lleva a él); suelto no se sabe de cuál habla y no cuenta. La clave es el nombre, o `carpeta/nombre` si se
 * repite (`claveDe`).
 */
function llamadores(root) {
  const r = git(root, ['ls-files', '-z']);
  if (!r.ok) return { motivo: `no medido: sin git (${r.motivo})` };
  const lista = r.out.split('\0').filter(Boolean);
  const repetidos = new Map();
  for (const rel of lista) repetidos.set(path.posix.basename(rel), (repetidos.get(path.posix.basename(rel)) || 0) + 1);
  const claveDe = (rel) => ((repetidos.get(path.posix.basename(rel)) || 0) > 1 ? ultimasDos(rel) : path.posix.basename(rel));
  const cuenta = new Map();
  let sinLeer = 0;
  for (const rel of lista) {
    if (/\.md$/i.test(rel) || /(^|\/)tests?\//.test(rel) || /\.test\./.test(rel)) continue;
    let texto;
    try {
      const abs = path.join(root, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > TOPE_LLAMADOR) continue;
      texto = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      // borrado en el árbol y todavía en el índice: no hay nada que leer; cualquier otro error se cuenta y se dice
      if (e.code !== 'ENOENT') sinLeer++;
      continue;
    }
    if (texto.includes('\0')) continue;
    const claves = new Set();
    for (const m of texto.matchAll(/(?<![\w.-])((?:[\w.-]+\/)*)([\w.-]+\.(?:js|cjs|mjs|sh))(?![\w-])/g)) {
      const nombre = m[2];
      if ((repetidos.get(nombre) || 0) <= 1) { claves.add(nombre); continue; }
      // relativa al archivo que la nombra (`./x.js`, `../ci/x.js`) o con su carpeta adelante
      const ruta = /^\.\.?\//.test(m[1]) ? path.posix.join(path.posix.dirname(rel), m[1] + nombre) : m[1] + nombre;
      if (ruta.includes('/')) claves.add(ultimasDos(ruta));
    }
    claves.delete(claveDe(rel));
    for (const k of claves) cuenta.set(k, (cuenta.get(k) || 0) + 1);
  }
  const motivo = sinLeer ? `${sinLeer} archivo(s) que no se pudieron leer: la columna puede quedar corta` : null;
  return { cuenta, claveDe, motivo };
}

// ── el recorrido del freno ─────────────────────────────────────────────────────────────────────────────────────────

function topeDelFreno(gate) {
  let texto;
  try { texto = fs.readFileSync(gate, 'utf8'); } catch (e) {
    return { tope: null, motivo: `no medido: no pude leer el freno (${path.basename(gate)}: ${e.code || e.message})` };
  }
  const desde = texto.search(/\bfunction\s+guionesEnArchivo\s*\(/);
  let cuerpo = '';
  if (desde >= 0) {
    // hasta la próxima función de primer nivel, o hasta el final
    const resto = texto.slice(desde + 1).search(/\nfunction\s/);
    cuerpo = texto.slice(desde, resto < 0 ? texto.length : desde + 1 + resto);
  }
  const niveles = cuerpo.match(/\bhondo\s*>=\s*(\d+)/);
  const modulos = cuerpo.match(/\bmodulos\[\w+\]\+\+\s*>=\s*(\d+)/);
  if (!niveles || !modulos) return { tope: null, motivo: `no medido: no encontré el tope del recorrido en el freno (${path.basename(gate)}, guionesEnArchivo)` };
  return { tope: { niveles: Number(niveles[1]), modulos: Number(modulos[1]) } };
}

/** Los `require`/`import` locales de un archivo, resueltos a rutas reales que existen. */
function importsLocales(abs, texto) {
  const dir = path.dirname(abs);
  const out = [];
  for (const m of texto.matchAll(/(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g)) {
    for (const c of [m[2], ...['.js', '.cjs', '.mjs', '/index.js'].map((e) => m[2] + e)]) {
      try {
        const p = path.join(dir, c);
        if (fs.statSync(p).isFile()) { out.push(fs.realpathSync(p)); break; }
      } catch { /* esa forma no existe: la siguiente */ }
    }
  }
  return out;
}

/**
 * Cuántos módulos locales alcanza un despachador y en cuántos niveles, sin tope; y qué archivos recorre. Los niveles se
 * miden como los recorre el freno: en profundidad, en el orden de los `require`, y cada módulo con el nivel en que se lo
 * ve por primera vez. En anchura cada módulo tendría su camino más corto, y eso da menos niveles de los que el freno
 * recorre de verdad.
 */
function recorrido(abs) {
  const inicio = fs.realpathSync(abs);
  const nivel = new Map();
  const noLeidos = [];
  let maximo = 0;
  const visitar = (archivo, hondo) => {
    if (nivel.has(archivo)) return;
    nivel.set(archivo, hondo);
    if (hondo > maximo) maximo = hondo;
    let texto;
    // un módulo que no se lee deja el recorrido sin medir de ahí para abajo: se anota, no se calla
    try { texto = fs.readFileSync(archivo, 'utf8'); } catch { noLeidos.push(archivo); return; }
    for (const r of importsLocales(archivo, texto)) visitar(r, hondo + 1);
  };
  visitar(inicio, 0);
  return { modulos: nivel.size - 1, niveles: maximo, archivos: [...nivel.keys()], noLeidos };
}

// ── medir ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function medir(o) {
  const controles = [];
  const noMedidos = [];
  for (const carpeta of CARPETAS) {
    let nombres;
    try { nombres = fs.readdirSync(path.join(o.root, carpeta)); } catch (e) {
      // una carpeta que no está no tiene controles; una que está y no se lee es «no medido»
      if (e.code !== 'ENOENT') noMedidos.push({ ruta: carpeta, motivo: `no se pudo leer la carpeta (${e.code || e.message})` });
      continue;
    }
    for (const n of nombres) {
      if (!EXTENSIONES.test(n) || /\.test\./.test(n)) continue;
      const ruta = `${carpeta}/${n}`;
      const abs = path.join(o.root, carpeta, n);
      try {
        if (fs.lstatSync(abs).isDirectory()) continue;
        const texto = fs.readFileSync(abs, 'utf8');
        controles.push({ ruta, letras: letrasDe(texto), subcomandos: subcomandos(ruta, texto), llamadores: null });
      } catch (e) {
        noMedidos.push({ ruta, motivo: `no se pudo leer (${e.code || e.message})` });
      }
    }
  }
  const ll = llamadores(o.root);
  for (const c of controles) c.llamadores = ll.cuenta ? ll.cuenta.get(ll.claveDe(c.ruta)) || 0 : null;
  controles.sort((a, b) => b.letras - a.letras || a.ruta.localeCompare(b.ruta));

  // el rango: qué tocó y cuánto medía cada control en la base. Las rutas, relativas a --root aunque no sea la raíz de
  // git (`--relative`); un archivo movido o renombrado se compara con su ruta de antes (`-M`), no como si fuera nuevo
  let tocados = null;
  let rangoMotivo = null;
  let base = null;
  const rutaDeAntes = new Map();
  if (o.range) {
    const partes = o.range.split('...');
    const mb = partes.length === 2 ? git(o.root, ['merge-base', partes[0], partes[1]]) : { ok: false, motivo: 'el rango es <base>...<punta>' };
    const d = mb.ok ? git(o.root, ['diff', '--relative', '--name-status', '-M', o.range]) : mb;
    if (d.ok) {
      tocados = new Set();
      for (const linea of d.out.split('\n').filter(Boolean)) {
        const campos = linea.split('\t');
        const ahora = campos[campos.length - 1];
        tocados.add(ahora);
        if (/^[RC]/.test(campos[0]) && campos.length === 3) rutaDeAntes.set(ahora, campos[1]);
      }
      base = mb.out.trim();
    } else rangoMotivo = `no medido: no pude leer el rango ${o.range} (${d.motivo}); aviso como sin rango`;
  }
  const letrasEnLaBase = (ruta) => {
    const r = git(o.root, ['show', `${base}:./${rutaDeAntes.get(ruta) || ruta}`]);
    return r.ok ? letrasDe(r.out) : null;
  };

  const avisos = [];
  for (const c of controles) {
    if (c.letras <= TOPE_LETRAS) continue;
    if (tocados) {
      if (!tocados.has(c.ruta)) continue;
      const antes = letrasEnLaBase(c.ruta);
      if (antes !== null && c.letras <= antes) continue;
    }
    avisos.push(`${c.ruta} tiene ${conPuntos(c.letras)} letras; el tope es ${conPuntos(TOPE_LETRAS)} (aviso, no frena)`);
  }

  const freno = topeDelFreno(o.gate);
  const despachadores = [];
  const faltan = [];
  for (const ruta of DESPACHADORES) {
    const abs = path.join(o.root, ruta);
    if (!fs.existsSync(abs)) { faltan.push(ruta); continue; }
    const r = recorrido(abs);
    const relativa = (a) => path.relative(fs.realpathSync(o.root), a).split(path.sep).join('/');
    despachadores.push({ ruta, modulos: r.modulos, niveles: r.niveles, archivos: r.archivos, no_leidos: r.noLeidos.map(relativa) });
  }
  if (!freno.tope) avisos.push(freno.motivo);
  else {
    // lo que no se pudo medir se dice: un despachador que falta o un módulo que no se leyó
    for (const ruta of faltan) avisos.push(`no medido: falta el despachador ${ruta}; no se mide su recorrido`);
    for (const d of despachadores) {
      if (d.no_leidos.length) avisos.push(`no medido: el recorrido de ${d.ruta} queda corto; no se pudo leer ${d.no_leidos.join(', ')}`);
    }
    const umbral = { modulos: freno.tope.modulos * FRACCION_AVISO, niveles: freno.tope.niveles * FRACCION_AVISO };
    const real = (p) => { try { return fs.realpathSync(path.join(o.root, p)); } catch { return null; } };
    const tocadosReales = tocados ? new Set([...tocados].map(real).filter(Boolean)) : null;
    for (const d of despachadores) {
      if (d.modulos <= umbral.modulos && d.niveles <= umbral.niveles) continue;
      if (tocadosReales && !d.archivos.some((a) => tocadosReales.has(a))) continue;
      avisos.push(`${d.ruta} carga ${d.modulos} módulos locales en ${d.niveles} niveles; el freno de guiones no suma`
        + ` módulos pasado el módulo ${freno.tope.modulos} de cada cuenta del comando y no mira lo que cargan los del`
        + ` nivel ${freno.tope.niveles} (aviso con más de ${String(umbral.modulos).replace('.', ',')} módulos o más de`
        + ` ${String(umbral.niveles).replace('.', ',')} niveles, no frena)`);
    }
  }
  return {
    limite: TOPE_LETRAS,
    controles,
    no_medidos: noMedidos,
    llamadores_motivo: ll.motivo || null,
    recorrido: {
      freno: path.relative(o.root, o.gate) || o.gate,
      tope: freno.tope,
      motivo: freno.motivo || null,
      despachadores: despachadores.map(({ archivos, ...d }) => d),
      faltan,
    },
    rango: o.range && !rangoMotivo ? o.range : null,
    rango_motivo: rangoMotivo,
    avisos,
  };
}

function texto(j) {
  const l = [];
  l.push(`control-size: ${j.controles.length} controles; tope ${conPuntos(j.limite)} letras (aviso, no frena)`);
  l.push('  subcomandos: cuenta aproximada, para comparar en el tiempo; «—» = no lee un subcomando de sus argumentos');
  if (j.llamadores_motivo) l.push(`  quién llama: ${j.llamadores_motivo}`);
  l.push(`  ${'letras'.padStart(8)}  ${'subcom.'.padStart(7)}  ${'llaman'.padStart(6)}  control`);
  const celda = (v, n) => String(v === null ? '—' : v).padStart(n);
  for (const c of j.controles) l.push(`  ${celda(c.letras, 8)}  ${celda(c.subcomandos, 7)}  ${celda(c.llamadores, 6)}  ${c.ruta}`);
  if (j.no_medidos.length) {
    l.push('no medidos:');
    for (const n of j.no_medidos) l.push(`  no medido: ${n.ruta} — ${n.motivo}`);
  }
  const r = j.recorrido;
  if (r.tope) {
    l.push(`recorrido del freno (${r.freno}): no mira lo que cargan los del nivel ${r.tope.niveles}; no suma módulos pasado el ${r.tope.modulos} de cada cuenta del comando`);
    for (const d of r.despachadores) l.push(`  ${d.ruta}: ${d.modulos} módulos locales en ${d.niveles} niveles`);
  }
  if (j.rango_motivo) l.push(j.rango_motivo);
  for (const a of j.avisos) l.push(`⚠️ control-size: ${a}`);
  return `${l.join('\n')}\n`;
}

if (require.main === module) {
  const o = opciones(process.argv.slice(2));
  const j = medir(o);
  process.stdout.write(o.json ? `${JSON.stringify(j, null, 2)}\n` : texto(j));
}

module.exports = { medir, topeDelFreno, subcomandos, recorrido, TOPE_LETRAS, FRACCION_AVISO };
