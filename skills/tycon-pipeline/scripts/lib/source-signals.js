'use strict';
/**
 * source-signals.js — las señales de que un cambio cambia de dónde sale un dato o quién lo puede ver, buscadas en lo
 * propio de un camino corto (@story-8.196).
 *
 * Las señales fuertes las declara cada paquete del stack en `shortPathSignals` de su `pack.json`: el núcleo no nombra
 * herramientas. El núcleo trae sólo la débil, el nombre del archivo. Una señal se busca en las líneas que el carril
 * agrega o borra (`git diff -U0` contra la base propia de cada repo, la de adhoc-base.js), nunca en lo que no tocó: las de
 * la copia de trabajo y las preparadas para guardar, y un archivo renombrado con su nombre viejo.
 *
 *   DEBILES                    las señales del núcleo: el nombre del archivo habla de roles o permisos.
 *   validarSenales(lista, p)   `{ validas, avisos }`: una señal rota es un aviso con el nombre del paquete, no un
 *                              paquete roto.
 *   cargar({ repo, packsDir }) `{ senales, avisos }`: las de los paquetes activos en `repo` más las del núcleo. Un
 *                              paquete roto sube (PackError): quien llama lo trata como «sin medir».
 *   buscar(adhoc, senales, o)  `{ hallazgos, avisos, fallas }`. `senales` es una lista, o una función repo → lista.
 *                              Un hallazgo: `{ id, strength, says, repo, file, line, borrada, texto }`; la línea de una
 *                              borrada es la del archivo de antes, y la débil no tiene línea. `fallas`: git que no
 *                              contestó, o un archivo nuevo que no se pudo leer; con una falla la medición está
 *                              incompleta.
 *   huella(hallazgos)          lo que cubre el click del dueño: las fuertes, contadas, sin el número de línea.
 *   descripcion(h)             «una llamada a un proceso, src/a.tsx:42».
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEBILES = Object.freeze([Object.freeze({ id: 'nombre-de-archivo', strength: 'weak', path: 'role|permis|polic|authoriz',
  says: 'el nombre del archivo habla de roles o permisos' })]);
const FUERZAS = ['strong', 'weak'];
const TEXTO_MAX = 200;
const SALIDA_MAX = 64 * 1024 * 1024;

/** Las señales válidas de un paquete y los avisos de las rotas, con el nombre del paquete. */
function validarSenales(lista, paquete) {
  const validas = [];
  const avisos = [];
  if (lista == null) return { validas, avisos };
  if (!Array.isArray(lista)) return { validas, avisos: [`paquete «${paquete}»: «shortPathSignals» no es una lista; no cuenta`] };
  lista.forEach((s, i) => {
    const nombre = s && typeof s.id === 'string' ? s.id : `#${i + 1}`;
    const no = (m) => avisos.push(`paquete «${paquete}», señal «${nombre}»: ${m}; no cuenta`);
    if (!s || typeof s !== 'object') return no('no es un objeto');
    if (typeof s.id !== 'string' || !/^[\w-]+$/.test(s.id)) return no('falta «id»');
    if (!FUERZAS.includes(s.strength)) return no('«strength» es strong o weak');
    if (typeof s.pattern !== 'string' || !s.pattern) return no('falta «pattern»');
    try { new RegExp(s.pattern); } catch (e) { return no(`«pattern» no compila (${e.message})`); }
    for (const k of ['files', 'exclude']) {
      if (s[k] != null && !(Array.isArray(s[k]) && s[k].every((g) => typeof g === 'string' && g))) return no(`«${k}» es una lista de rutas`);
    }
    if (typeof s.says !== 'string' || !s.says.trim()) return no('falta «says»');
    validas.push({ id: s.id, strength: s.strength, pattern: s.pattern, files: s.files || null, exclude: s.exclude || [], says: s.says.trim(), paquete });
  });
  return { validas, avisos };
}

/** Las señales de los paquetes activos en `repo`, más las del núcleo. */
function cargar({ repo, packsDir } = {}) {
  const packs = require('./packs.js');
  // con las banderas de detectStack: sin ellas, un revisor con `when.detection` vuelve inválido al paquete
  const instalados = packs.cargarPaquetes({ packsDir, banderas: packs.BANDERAS });
  const activos = packs.paquetesActivos({ repo, instalados, packsDir });
  const senales = [];
  const avisos = [];
  for (const p of activos) {
    const v = validarSenales(p.senales, p.nombre);
    senales.push(...v.validas);
    avisos.push(...v.avisos);
  }
  return { senales: [...senales, ...DEBILES], avisos };
}

function gitPorDefecto(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: SALIDA_MAX });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(String(r.stderr || '').split('\n')[0] || `git salió con ${r.status}`);
  return r.stdout;
}

const ESCAPES = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
/** Una ruta de una cabecera del diff (pedido con `--no-prefix`: la ruta tal cual, sin `a/` ni `b/`, diga lo que diga la
 * configuración del dev): git pone entre comillas (con escapes de C) la que lleva comillas, tabs o barras, y le agrega
 * un tab al final a la que lleva un espacio. */
function rutaDeCabecera(resto) {
  let r = resto;
  if (r.startsWith('"')) {
    const bytes = [];
    for (let i = 1; i < r.length && r[i] !== '"'; i++) {
      if (r[i] !== '\\') { bytes.push(...Buffer.from(r[i], 'utf8')); continue; }
      const o = /^[0-7]{3}/.exec(r.slice(i + 1));
      if (o) { bytes.push(parseInt(o[0], 8)); i += 3; } else { i++; bytes.push(...Buffer.from(ESCAPES[r[i]] || r[i] || '', 'utf8')); }
    }
    r = Buffer.from(bytes).toString('utf8');
  } else if (r.endsWith('\t')) r = r.slice(0, -1);
  return r === '/dev/null' ? null : r;
}

/**
 * Las líneas `+` y `-` de un diff `-U0`, por archivo: `[{ file, line, borrada, texto }]`, con `binarios`: los archivos
 * que git no muestra por línea. Dentro de un tramo se cuentan sus líneas (la cabecera `@@` dice cuántas): un renglón que
 * empieza con «-- » o «++ » es del tramo, no la cabecera de otro archivo.
 */
function lineasDelDiff(salida) {
  const out = [];
  out.binarios = [];
  let viejo = null;
  let nuevo = null;
  let a = 0;
  let b = 0;
  let quedanA = 0;
  let quedanB = 0;
  for (const l of String(salida).split('\n')) {
    if (quedanA > 0 && l.startsWith('-')) { if (viejo !== null) out.push({ file: viejo, line: a, borrada: true, texto: l.slice(1) }); a++; quedanA--; continue; }
    if (quedanB > 0 && l.startsWith('+')) { if (nuevo !== null) out.push({ file: nuevo, line: b, borrada: false, texto: l.slice(1) }); b++; quedanB--; continue; }
    if (l.startsWith('\\')) continue;
    quedanA = 0;
    quedanB = 0;
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      a = Number(h[1]);
      b = Number(h[3]);
      quedanA = h[2] === undefined ? 1 : Number(h[2]);
      quedanB = h[4] === undefined ? 1 : Number(h[4]);
      continue;
    }
    if (l.startsWith('diff --git ')) { viejo = null; nuevo = null; continue; }
    if (l.startsWith('--- ')) { viejo = rutaDeCabecera(l.slice(4)); continue; }
    if (l.startsWith('+++ ')) { nuevo = rutaDeCabecera(l.slice(4)); continue; }
    const bin = /^Binary files (.+) and (.+) differ$/.exec(l);
    if (bin) {
      const r = rutaDeCabecera(bin[2]) || rutaDeCabecera(bin[1]);
      if (r) out.binarios.push(r);
    }
  }
  return out;
}

/** Los nombres viejos de los archivos que git ve renombrados contra `sha`, en la copia de trabajo o en lo preparado. */
function nombresViejos(git, repo, sha, nuevos) {
  const quiero = new Set(nuevos);
  const viejos = new Set();
  for (const donde of [[], ['--cached']]) {
    const t = git(repo, ['diff', ...donde, '-M', '--name-status', '-z', '--no-color', '--no-ext-diff', sha]).split('\0');
    for (let i = 0; i < t.length && t[i];) {
      if (/^[RC]/.test(t[i])) {
        if (t[i].startsWith('R') && quiero.has(t[i + 2])) viejos.add(t[i + 1]);
        i += 3;
      } else i += 2;
    }
  }
  return [...viejos].filter((v) => !quiero.has(v));
}

const aplica = (s, rel) => {
  const { matchGlob } = require('./match-glob.js');
  if (s.files && !s.files.some((g) => matchGlob(rel, g))) return false;
  return !(s.exclude || []).some((g) => matchGlob(rel, g));
};
const corto = (t) => { const x = String(t).trim(); return x.length > TEXTO_MAX ? `${x.slice(0, TEXTO_MAX)}…` : x; };

/** Las señales en las líneas que agrega o borra lo propio del carril, cada repo contra su base. */
function buscar(adhoc, senales, { repos = [], sinSeguir = false, git = gitPorDefecto } = {}) {
  const base = require('./adhoc-base.js');
  const { isCodeFile } = require('./story-gate.js');
  const propios = base.propiosDelCarril(adhoc, { repos, sinSeguir, suma: () => true });
  const hallazgos = [];
  const avisos = [...propios.avisos];
  const fallas = [...propios.fallas];
  for (const repo of Object.keys(propios.porRepo)) {
    const rels = propios.porRepo[repo];
    if (!rels.length) continue;
    try {
      const lista = typeof senales === 'function' ? senales(repo) : senales;
      const deLinea = lista.filter((s) => s.pattern).map((s) => ({ ...s, re: new RegExp(s.pattern) }));
      const deRuta = lista.filter((s) => s.path).map((s) => ({ ...s, re: new RegExp(s.path, 'i') }));
      const { sha, aviso } = base.basePropia(repo, adhoc);
      if (aviso) avisos.push(aviso);
      const sinSeguirDeGit = new Set(git(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...rels]).split('\0').filter(Boolean));
      const seguidos = rels.filter((r) => !sinSeguirDeGit.has(r));
      const lineas = [];
      if (sha && seguidos.length) {
        // con su nombre viejo, un archivo renombrado muestra sólo lo que cambió (y lo que se borró al moverlo); los
        // sin prefijos, para que la configuración del dev no cambie las cabeceras
        const rutas = [...seguidos, ...nombresViejos(git, repo, sha, seguidos)];
        const diff = (donde) => lineasDelDiff(git(repo, ['diff', ...donde, '-U0', '--no-color', '-M', '--no-ext-diff', '--no-prefix', sha, '--', ...rutas]));
        const deLaCopia = diff([]);
        // lo preparado para guardar es lo que guarda el commit: lo que no está en la copia de trabajo también cuenta
        const cuenta = new Map();
        const clave = (l) => `${l.file}\0${l.borrada}\0${l.texto}`;
        for (const l of deLaCopia) cuenta.set(clave(l), (cuenta.get(clave(l)) || 0) + 1);
        const preparado = diff(['--cached']);
        lineas.push(...deLaCopia);
        for (const l of preparado) {
          const n = cuenta.get(clave(l)) || 0;
          if (n) cuenta.set(clave(l), n - 1); else lineas.push(l);
        }
        for (const b of new Set([...deLaCopia.binarios, ...preparado.binarios])) avisos.push(`camino corto: ${b} es binario; no se buscaron señales en él`);
      }
      for (const rel of rels.filter((r) => sinSeguirDeGit.has(r) || !sha)) {
        let txt;
        try { txt = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch (e) {
          // borrado: no hay líneas que buscar. Cualquier otra cosa deja la medición incompleta
          if (e && e.code === 'ENOENT') continue;
          fallas.push(`camino corto: no pude leer ${rel} en ${repo} (${e && e.code ? e.code : String(e)})`);
          continue;
        }
        txt.split('\n').forEach((t, i) => lineas.push({ file: rel, line: i + 1, borrada: false, texto: t }));
      }
      for (const l of lineas) {
        for (const s of deLinea) {
          if (aplica(s, l.file) && s.re.test(l.texto)) hallazgos.push({ id: s.id, strength: s.strength, says: s.says, repo, file: l.file, line: l.line, borrada: l.borrada, texto: corto(l.texto) });
        }
      }
      for (const rel of rels) {
        if (!isCodeFile(rel)) continue;
        for (const s of deRuta) if (s.re.test(rel)) hallazgos.push({ id: s.id, strength: s.strength, says: s.says, repo, file: rel, line: null, borrada: false, texto: '' });
      }
    } catch (e) {
      fallas.push(`camino corto: no pude leer las líneas cambiadas en ${repo} (${String((e && e.message) || e).split('\n')[0]})`);
    }
  }
  return { hallazgos, avisos, fallas };
}

/** La huella de las señales fuertes: id, archivo, texto de la línea y si es borrada; contadas, sin el número de línea. */
function huella(hallazgos) {
  const filas = hallazgos.filter((h) => h.strength === 'strong').map((h) => `${h.repo}\t${h.file}\t${h.id}\t${h.borrada ? '-' : '+'}\t${h.texto}`).sort();
  return crypto.createHash('sha256').update(filas.join('\n')).digest('hex').slice(0, 16);
}

const descripcion = (h) => `${h.says}, ${h.file}${h.line ? `:${h.line}` : ''}${h.borrada ? ' (borrada)' : ''}`;

module.exports = { DEBILES, validarSenales, cargar, buscar, huella, descripcion, lineasDelDiff };
