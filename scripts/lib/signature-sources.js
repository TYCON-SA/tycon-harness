'use strict';
/**
 * signature-sources.js — de dónde sale lo que dice la pregunta de cada firma (owner-approvals.js `cuadroDe`).
 *
 * Lo que la sesión escribe en el comando es una cita: puede no decir lo que se aprueba. Lo que la pregunta dice que hace
 * la firma, qué archivos toca y dónde está lo completo sale de lo mismo que el dueño firmaría si lo abriera: el plan
 * escrito, el diff de los controles, los criterios de la historia, el informe de hallazgos o la nota de la vuelta.
 *
 *   · `partesDe({ firma, palabras, cwd, marcador, estado, destino })` → `{ queHace, archivos, completo, fuente, cita }` (el
 *     plan suma `revision`, la línea del resultado de su revisión automática), o null si
 *     la firma no tiene fuente propia (la pregunta dice lo que hace el comando), o `{ error }` si no hay nada que firmar
 *     (un cambio de control con el diff vacío, o con rutas que la pregunta no mostraría tal como se firman: no hay
 *     cuadro y el pedido se niega). `fuente` es el texto exacto que se
 *     mostró: entra a la huella del sello, así un click no vale si la fuente cambió después del cuadro.
 *   · `historiaDe(marcador)` → `{ id, titulo }` de la historia de la corrida, o null sin corrida.
 *   · `seccionesDelPlan(texto)` → `{ queHace, archivos }` o `{ error, errores }`: el plan dice qué hace en hasta 3 líneas y
 *     qué archivos toca, o no se firma (lo comprueba `marker.js complete-step approve-plan` antes de la ventana). `error`
 *     junta todo lo que falta en un texto; `errores`, una falta por renglón.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PIPELINE = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js');
const PLAN_FILE = 'step-02-bmad-plan.md';
const LINEAS_DEL_PLAN = 3;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** El valor de `--opcion` en las palabras del comando (también `--opcion=valor`), o null. */
function valor(palabras, opcion) {
  const p = palabras || [];
  const i = p.indexOf(opcion);
  if (i >= 0) return p[i + 1] != null ? String(p[i + 1]) : null;
  const pegado = p.find((w) => String(w).startsWith(`${opcion}=`));
  return pegado ? String(pegado).slice(opcion.length + 1) : null;
}

// por qué no se leyó la última ruta que no está: «no está» y «no pude leerla» le dicen cosas distintas a la persona
const sinLeer = new Map();
function leer(ruta) {
  try { return fs.readFileSync(ruta, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT' && ruta) sinLeer.set(ruta, e.code || e.message); else sinLeer.delete(ruta);
    return null;
  }
}
const porQueNo = (ruta) => (ruta && sinLeer.has(ruta) ? ` (no pude leerlo: ${sinLeer.get(ruta)})` : '');

function rutaDeLaHistoria(m) {
  if (!m || !m.storyPath) return null;
  return path.isAbsolute(m.storyPath) ? m.storyPath : path.join(m.repoPath || process.cwd(), m.storyPath);
}

/** La historia de la corrida con su título (`title:` del frontmatter), o null sin corrida. */
function historiaDe(m) {
  if (!m || !m.storyId) return null;
  const texto = leer(rutaDeLaHistoria(m) || '');
  const fm = texto && /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  const t = fm && /^title:\s*(.+?)\s*$/m.exec(fm[1]);
  const titulo = t ? t[1].replace(/^(["'])(.*)\1$/, '$2').trim() : null;
  return { id: String(m.storyId), titulo: titulo || null };
}

/** La carpeta de la corrida de la sesión del marcador, sin crearla; null sin corrida o sin clave. */
function carpetaDeLaCorrida(m) {
  if (!m || !m.storyId) return null;
  try { return require(PIPELINE).resolveRunDir(m.repoPath || process.cwd(), String(m.storyId), false, rutaDeLaHistoria(m) || undefined, { marker: m }); } catch (e) {
    // sin carpeta, las firmas de esa corrida no se listan: se dice, para que la lista corta no parezca completa
    process.stderr.write(`⚠️  no pude calcular la carpeta de la ejecución de la historia ${m.storyId} (${e.message}): sus firmas no entran en la lista.\n`);
    return null;
  }
}

/** El cuerpo de la sección `## <titulo>` del markdown, sin el título; null si no está. */
function seccion(texto, titulo) {
  const lineas = String(texto).split(/\r?\n/);
  const i = lineas.findIndex((l) => new RegExp(`^##\\s+${titulo}\\s*$`, 'i').test(l.trim()));
  if (i < 0) return null;
  const fin = lineas.findIndex((l, k) => k > i && /^#{1,2}\s/.test(l));
  return lineas.slice(i + 1, fin < 0 ? undefined : fin);
}
const renglones = (cuerpo) => (cuerpo || []).map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()).filter(Boolean);

function seccionesDelPlan(texto) {
  const queHace = renglones(seccion(texto, 'Qué hace'));
  const archivos = renglones(seccion(texto, 'Archivos')).flatMap((l) => l.split(/,\s+/)).map((a) => a.replace(/`/g, '').trim()).filter(Boolean);
  // todo lo que falta junto: de a una, la sesión se entera de la segunda en la vuelta siguiente
  const errores = [];
  if (!queHace.length) errores.push('el plan no dice qué hace en hasta 3 líneas: falta la sección «## Qué hace». Agregala al plan con hasta 3 líneas llanas de qué cambia');
  else if (queHace.length > LINEAS_DEL_PLAN) errores.push(`el plan no dice qué hace en hasta 3 líneas: su sección «## Qué hace» tiene ${queHace.length}. Dejala en 3 líneas llanas`);
  if (!archivos.length) errores.push('el plan no dice qué archivos toca: falta la sección «## Archivos». Agregala al plan con un archivo por renglón («- ruta»)');
  if (errores.length) return { error: errores.join('; y '), errores };
  return { queHace, archivos };
}

/** El plan escrito de la corrida: `{ ruta, texto }`; `texto` null si no está. */
function planDe(m) {
  const dir = carpetaDeLaCorrida(m);
  const ruta = dir ? path.join(dir, PLAN_FILE) : null;
  return { ruta, texto: ruta ? leer(ruta) : null };
}

/**
 * La línea del resultado de la revisión automática de este plan (lib/plan-review.js), o null sin estado o sin destino. La
 * línea entra en la fuente: la huella ata el click también a lo que dijo la revisión.
 */
function revisionDelPlan(m, estado, destino) {
  if (!estado || !destino || !m) return null;
  // si no se puede leer, el cuadro lo dice: sin la línea se leería como «no hubo revisión»
  try { return require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'plan-review.js')).lineaDelCuadro({ estado, destino, marker: m }); } catch (e) {
    return { linea: `no pude leer su resultado (${String((e && e.message) || e).split('\n')[0]})`, detalle: [] };
  }
}

function delPlan(palabras, m, { estado, destino } = {}) {
  const cita = valor(palabras, '--approved') || valor(palabras, '--mockup-approved');
  const { ruta, texto } = planDe(m);
  // la nota de por qué no se leyó va aparte: la línea se recorta, y una ruta larga se la comería
  if (texto == null) return { queHace: [`no encuentro el plan escrito${ruta ? ` en ${ruta}` : ' (la sesión no tiene una ejecución con carpeta)'}`], nota: porQueNo(ruta).trim() || null, fuente: '', cita };
  const revision = revisionDelPlan(m, estado, destino);
  const fuente = revision ? `${texto}\n${revision.linea}\n${revision.detalle.join('\n')}` : texto;
  const s = seccionesDelPlan(texto);
  // una falta por renglón: el cuadro corta cada renglón a 200, y las dos juntas no entran
  if (s.error) return { queHace: s.errores, completo: ruta, fuente, cita, revision };
  return { queHace: s.queHace, archivos: s.archivos, completo: ruta, fuente, cita, revision };
}

// sin programas externos: el cuadro se arma antes de la firma, y el repo lo nombra el comando. Las rutas van literales: un
// comodín o un «:(glob)» de la sesión no le hace mostrar a la pregunta archivos que el guion no firma
const git = (dir, args) => spawnSync('git', ['-c', 'core.fsmonitor=false', '--literal-pathspecs', '-C', dir, ...args], { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 });

/**
 * El commit de una revisión que escribió la sesión: `{ sha }`, o `{ motivo }` con por qué no. Lo que empieza con «-»
 * sería una opción de git, no una revisión.
 */
function commitDe(raiz, rev) {
  const r = String(rev || '');
  if (!r || r.startsWith('-') || /[\s\0]/.test(r)) return { motivo: `«${r}» no es una versión de ${raiz}` };
  return objetoDe(raiz, `${r}^{commit}`, `«${r}» no es una versión de ${raiz}`);
}

/** El blob de una ruta en un commit ya resuelto: `{ sha }`, `{ sha: 'borrado' }` si no está, o `{ motivo, gitFallo }`. */
function blobDe(raiz, commit, ruta) {
  const b = objetoDe(raiz, `${commit}:${ruta}`, null);
  return b.sha || b.gitFallo ? b : { sha: 'borrado' };
}

/** `rev-parse` de un objeto: `{ sha }`; `{ motivo }` si no existe; `{ motivo, gitFallo: true }` si git no pudo contestar. */
function objetoDe(raiz, objeto, noExiste) {
  const v = git(raiz, ['rev-parse', '--verify', '--quiet', '--end-of-options', objeto]);
  if (v.status === 0) return { sha: v.stdout.trim() };
  // con --quiet, lo que no existe sale 1 sin decir nada; lo demás es que git no pudo contestar
  if (v.status === 1 && !String(v.stderr || '').trim()) return { motivo: noExiste };
  const por = v.error ? (v.error.code || v.error.message) : String(v.stderr || '').trim().split('\n')[0] || `git salió ${v.status}`;
  return { motivo: `git no pudo leer ${raiz} (${por})`, gitFallo: true };
}

// los de control (C0 y C1), los de formato, que no se ven o dan vuelta el texto (ancho cero, dirección, guion blando), los
// separadores de renglón y de párrafo, que lo parten como un salto, los que se ignoran al mostrar (rellenos, selectores de
// variante) y el braille en blanco
const CLASE_QUE_NO_SE_VE = '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u{2800}]';
const NO_SE_VE = new RegExp(CLASE_QUE_NO_SE_VE, 'u');
// la ruta, para nombrarla en un motivo: entre comillas de JSON y con lo que no se ve escrito como su código, así se lee
const rutaALaVista = (r) => {
  const t = JSON.stringify(String(r)).slice(1, -1).replace(new RegExp(CLASE_QUE_NO_SE_VE, 'gu'), (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
};
// las opciones que lee el guion (run-base-controls.sh `opt`), que sólo las lee separadas de su valor: pegadas con «=», la
// pregunta mostraría lo que el guion no firma
const OPCIONES_DEL_GUION = ['--root', '--base', '--entries', '--file', '--rev', '--out'];

/**
 * Por qué una ruta no se vería en la pregunta tal como se firma, o null: «, » arma otra ruta en la lista, un salto, un
 * carácter de control, uno invisible o un separador de renglón cambian el texto, y los espacios de más, en las puntas o
 * que no son el común se ven como uno solo (owner-approvals.js `cuadroDe` junta los espacios).
 */
function porQueNoSeVe(ruta) {
  if (NO_SE_VE.test(ruta)) return 'trae un salto de línea, un carácter de control o uno que no se ve';
  if (ruta.includes(', ')) return 'trae «, », que en la pregunta se lee como el fin de una ruta y el principio de otra';
  if (ruta !== ruta.trim() || / {2}/.test(ruta) || /[^\S ]/.test(ruta)) return 'trae espacios en las puntas, seguidos o que no son el común, y la pregunta los muestra distintos';
  return null;
}

/**
 * Las rutas que firma el comando: `{ rutas, entradas }`, `{ error }` si no se pueden mostrar tal cual (entonces no hay
 * cuadro que aprobar), o null sin `--entries` ni `--file` (el guion sale con su uso: no firma nada).
 */
function rutasDelComando(palabras) {
  const pegada = (palabras || []).map(String).find((w) => OPCIONES_DEL_GUION.some((o) => w.startsWith(`${o}=`)));
  if (pegada) {
    const o = pegada.slice(0, pegada.indexOf('='));
    return { error: `${o}=… no lo lee el guion, que lee «${o} <valor>»: la pregunta mostraría otra cosa que lo que se firma` };
  }
  const crudo = valor(palabras, '--entries');
  const archivo = valor(palabras, '--file');
  if (crudo == null) {
    if (archivo == null) return null;
    if (!archivo || archivo.startsWith('--')) return { error: '--file no dice qué archivo de control se firma' };
    const no = porQueNoSeVe(archivo);
    return no ? { error: `la ruta «${rutaALaVista(archivo)}» de --file ${no}` } : { rutas: [archivo], entradas: null };
  }
  let entradas;
  try { entradas = JSON.parse(crudo); } catch (_) { return { error: '--entries no es JSON: no sé qué archivos de control se firman' }; }
  if (!Array.isArray(entradas) || !entradas.length) return { error: '--entries no es una lista de archivos con su ruta: no sé qué se firma' };
  const vistas = new Set();
  for (let i = 0; i < entradas.length; i++) {
    const e = entradas[i];
    if (!e || typeof e.path !== 'string' || !e.path) return { error: `la entrada ${i + 1} de --entries no trae ruta: no sé qué archivo firma` };
    const no = porQueNoSeVe(e.path);
    if (no) return { error: `la ruta «${rutaALaVista(e.path)}» de --entries ${no}` };
    if (vistas.has(e.path)) return { error: `la ruta «${rutaALaVista(e.path)}» está dos veces en --entries: la pregunta contaría un archivo de más` };
    vistas.add(e.path);
  }
  return { rutas: entradas.map((e) => e.path), entradas };
}

/** El cambio de los controles: cuántas líneas, qué rutas y el diff completo en un archivo de la carpeta de estado. */
function deControles(palabras, cwd, estado) {
  const raiz = path.resolve(cwd || process.cwd(), valor(palabras, '--root') || '.');
  const pedidas = rutasDelComando(palabras);
  if (!pedidas) return null;
  if (pedidas.error) return { error: pedidas.error };
  const { rutas, entradas } = pedidas;
  // lo que se muestra es lo que se firma: con --file, la versión de --rev (o la punta); con --entries, sus blobs, que
  // run-base-controls exige iguales a la punta, contra --base
  const conArchivo = !Array.isArray(entradas);
  const pedida = conArchivo ? (valor(palabras, '--rev') || 'HEAD') : valor(palabras, '--base');
  const noPude = (que) => ({ queHace: [`no pude leer el cambio de ${rutas.length} archivo(s) de control: ${que}`], archivos: rutas, fuente: JSON.stringify(entradas || rutas) });
  let rango = null;
  let firmada = null;
  if (conArchivo) {
    const f = commitDe(raiz, pedida);
    if (!f.sha) return noPude(f.motivo);
    firmada = f.sha;
    // un commit sin padre es el primero del repo: se firma sin base
    const padre = commitDe(raiz, `${firmada}^`);
    if (padre.sha) rango = [padre.sha, firmada];
    else if (padre.gitFallo) return noPude(padre.motivo);
  } else if (pedida) {
    const base = commitDe(raiz, pedida);
    const punta = commitDe(raiz, 'HEAD');
    if (!base.sha || !punta.sha) return noPude((base.sha ? punta : base).motivo);
    rango = [base.sha, punta.sha];
  }
  if (!rango) {
    // sin base, la huella lleva el contenido que se firma: un click no vale para otra versión del archivo
    const blobs = conArchivo ? rutas.map((r) => blobDe(raiz, firmada, r)) : null;
    const sinBlob = (blobs || []).find((b) => b.gitFallo);
    if (sinBlob) return noPude(sinBlob.motivo);
    // lo completo son los archivos mismos, en el repo: sus rutas ya van en «Archivos», y juntas no entrarían enteras
    return { queHace: [`Firma ${rutas.length} archivo(s) de control en su versión ${conArchivo ? `de ${firmada.slice(0, 12)}` : 'de la punta'} (sin base para comparar)`], archivos: rutas,
      completo: raiz, fuente: JSON.stringify({ entradas: entradas || rutas, blobs }) };
  }
  // diff-tree, entre dos commits ya resueltos: el comando de bajo nivel no corre los conversores ni el diff externo
  // que pueda configurar el repo
  const num = git(raiz, ['diff-tree', '-r', '-z', '--numstat', ...rango, '--', ...rutas]);
  const diff = git(raiz, ['diff-tree', '-r', '-p', ...rango, '--', ...rutas]);
  if (num.status !== 0 || diff.status !== 0) {
    return { queHace: [`no pude leer el cambio de ${rutas.length} archivo(s) de control contra ${rango[0]} (${String(num.stderr || diff.stderr || '').trim().split('\n')[0] || 'git falló'})`],
      archivos: rutas, fuente: JSON.stringify(entradas || rutas) };
  }
  // sin diff no hay nada que firmar (la carpeta ya no tiene el cambio: la sesión soltó su puesto). Un borrado, un
  // renombre o un cambio de modo traen diff aunque sumen 0 líneas
  if (!diff.stdout.trim()) {
    return { error: `el cambio de control está vacío entre ${rango[0].slice(0, 12)} y ${rango[1].slice(0, 12)}: no hay nada que firmar. Pedí la firma desde la carpeta donde está el cambio` };
  }
  let mas = 0;
  let menos = 0;
  const nombradas = new Set(rutas);
  for (const l of num.stdout.split('\0').filter(Boolean)) {
    const [a, b, ...ruta] = l.split('\t');
    // una ruta que es una carpeta trae el cambio de los archivos de adentro: la pregunta mostraría lo que no se firma
    if (!nombradas.has(ruta.join('\t'))) return { error: `el cambio trae ${rutaALaVista(ruta.join('\t'))}, que el pedido no nombra: alguna de sus rutas es una carpeta, no un archivo` };
    if (/^\d+$/.test(a)) mas += Number(a);
    if (/^\d+$/.test(b)) menos += Number(b);
  }
  let completo = null;
  if (estado) {
    const dir = path.join(estado, 'firmas');
    completo = path.join(dir, `diff-${sha(diff.stdout).slice(0, 16)}.patch`);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(completo, diff.stdout); } catch (_) { completo = null; }
  }
  return { queHace: [`Cambia ${rutas.length} archivo(s) de control: +${mas} −${menos} líneas`], archivos: rutas, completo, fuente: diff.stdout };
}

const acsDe = (palabras) => [...new Set(String(valor(palabras, '--acs') || '').split(/[,\s]+/).filter(Boolean).map(Number))].filter((n) => Number.isInteger(n) && n > 0);

/** Los criterios que se marcan probados a mano, de la historia de la corrida. */
function deLaPruebaAMano(palabras, m) {
  const historia = rutaDeLaHistoria(m);
  if (!historia) return null;
  const acs = acsDe(palabras);
  let criterios = [];
  let fallo = null;
  try { criterios = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'manual-checks.js')).criterios(historia); } catch (e) { fallo = e.code || e.message; }
  const lineas = acs.map((n) => { const c = criterios.find((x) => x.n === n); return `AC ${n}: ${c ? c.text : fallo ? `(no pude leer los criterios de la historia: ${fallo})` : '(no está en la historia)'}`; });
  return lineas.length ? { criterios: acs, queHace: lineas, completo: historia, fuente: lineas.join('\n') } : null;
}

function hallazgosDe(dir) {
  const ruta = dir ? path.join(dir, 'findings.json') : null;
  const texto = ruta ? leer(ruta) : null;
  if (texto == null) return { ruta: null, lista: null, roto: porQueNo(ruta) || null };
  let j;
  try { j = JSON.parse(texto); } catch (e) { return { ruta, lista: null, texto, roto: ` (no se entiende: ${e.message})` }; }
  return { ruta, texto, lista: Array.isArray(j) ? j : (j && Array.isArray(j.findings) ? j.findings : []) };
}

/** El hallazgo crítico que se exime, del informe de hallazgos de la corrida. */
function delCritico(palabras, m) {
  const regla = valor(palabras, '--rule');
  if (!regla) return null;
  const archivo = valor(palabras, '--file');
  const cita = valor(palabras, '--reason');
  const nombre = `${regla}${archivo ? ` en ${archivo}` : ''}`;
  const h = hallazgosDe(carpetaDeLaCorrida(m));
  const archivos = archivo ? [archivo] : [];
  if (!h.lista) return { queHace: [`Eximir ${nombre}: ${h.roto ? `no pude leer el informe de hallazgos${h.roto}` : 'no hay informe de hallazgos en esta ejecución'}`], archivos, completo: h.ruta, fuente: h.texto || '', cita };
  const reglaDe = (f) => String(f.rule_id || f.ruleId || f.rule || '').trim();
  // la exención se anota con la clave regla|archivo (critical-waivers.js): sin --file sólo exime los que no tienen archivo
  const iguales = h.lista.filter((f) => f && reglaDe(f) === regla && String(f.file || '').trim() === String(archivo || '').trim());
  if (!iguales.length) return { queHace: [`Eximir ${nombre}: no está en el informe de hallazgos`], archivos, completo: h.ruta, fuente: h.texto, cita };
  const lineas = iguales.map((f) => `${regla}${f.file ? ` en ${f.file}` : ''}: ${String(f.summary || f.title || f.reason || '(sin texto)').replace(/\s+/g, ' ').trim()}`);
  return { queHace: lineas, archivos: archivo ? archivos : [...new Set(iguales.map((f) => f.file).filter(Boolean))], completo: h.ruta, fuente: h.texto, cita };
}

/** La vuelta extra: su nota, o la carpeta de la corrida sin ella. */
function deLaVuelta(palabras, m) {
  const iter = valor(palabras, '--iter');
  const dir = carpetaDeLaCorrida(m);
  if (!iter || !/^\d+$/.test(iter)) return dir ? { queHace: ['Una vuelta más de revisores sobre lo que quedó abierto'], completo: dir, fuente: '' } : null;
  const ruta = dir ? path.join(dir, 'rethink', `iter-${iter}.json`) : null;
  const texto = ruta ? leer(ruta) : null;
  let n = null;
  let roto = porQueNo(ruta);
  try { n = texto ? JSON.parse(texto) : null; } catch (e) { roto = ` (su nota no se entiende: ${e.message})`; }
  if (!n) return { queHace: [`Una vuelta ${iter} de revisores sobre lo que quedó abierto${roto}`], completo: roto ? ruta : dir, fuente: texto || '' };
  const lineas = [n.repeated && `Se repitió: ${n.repeated}`, n.change ? `Cambia: ${n.change}` : n.keep && `Sigue igual: ${n.keep}`, n.story_change && `Cambia la historia: ${n.story_change}`].filter(Boolean);
  return { queHace: lineas, completo: ruta, fuente: texto };
}

// Los topes cuando el que arma el cuadro no los pasa: la lectura de story-gate-io.js, o los de fábrica si no carga
function topesLeidos() {
  const lib = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
  try { return require(path.join(lib, 'story-gate-io.js')).topesDelCaminoCorto(); } catch (_) {
    const g = require(path.join(lib, 'story-gate.js'));
    return { delegado: g.DELEGATED_ADHOC_MAX_FILES, maximo: g.DEFAULT_ADHOC_MAX_FILES, origen: 'fabrica' };
  }
}

/**
 * El arreglo rápido: el cupo es lo que se firma; el motivo lo escribió la sesión y va como cita. Sin número, el cupo es
 * el tope de la organización (`topes`, o la misma lectura que usan el guion y el freno): el cuadro dice lo que se abre.
 */
function delArreglo(palabras, topes = null) {
  if (!palabras || palabras[1] !== 'adhoc' || palabras[2] !== 'set') return null;
  let p = null;
  try { p = JSON.parse(palabras[3] || ''); } catch (_) { p = null; }
  if (!p || typeof p !== 'object') return null;
  const conNumero = Number.isFinite(Number(p.maxFiles)) && Number(p.maxFiles) > 0;
  const maximo = conNumero ? null : (topes || topesLeidos()).maximo;
  const cupo = conNumero ? `hasta ${Number(p.maxFiles)} archivos de implementación, sin pruebas ni guías` : `el cupo de la organización (${maximo} archivos de implementación, o el que ya tenía)`;
  const datos = { 'sin-cambio': 'La sesión declara que no cambia de dónde salen los datos ni quién los ve', cambian: 'La sesión declara que cambia de dónde salen los datos o quién los ve' }[p.datos];
  return { queHace: [`Abre un arreglo rápido sin historia, con ${cupo}`, ...(datos ? [datos] : [])], fuente: palabras[3], cita: String(p.reason || '') || null };
}

/** El valor de una bandera de las palabras del comando (`--changed <texto>`), o null. */
function bandera(palabras, nombre) {
  const i = palabras.indexOf(nombre);
  return i >= 0 && typeof palabras[i + 1] === 'string' ? palabras[i + 1] : null;
}

const RECOMIENDA = { pasar: 'dejar pasar', historia: 'escribir la historia', descartar: 'descartar lo del carril' };
/**
 * Dejar pasar el freno de los datos: qué lo frenó (lo anotó el freno de guardar en el carril, con el texto de la línea),
 * qué cambió de verdad y qué recomienda la sesión. El código del cuadro sale de esas señales: con otras, otro cuadro.
 */
function delFrenoDeDatos(palabras, estado, destino) {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(path.join(estado, 'adhoc', `${destino}.json`), 'utf8')); } catch (_) { a = null; }
  const f = a && a.frenoDatos;
  const ss = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'source-signals.js'));
  const h = f && Array.isArray(f.hallazgos) && f.hallazgos[0];
  const lo = h ? `Qué lo frenó: ${ss.descripcion(h)} («${String(h.texto || '').slice(0, 120)}»)${f.hallazgos.length > 1 ? `, y ${f.hallazgos.length - 1} más` : ''}`
    : 'Qué lo frenó: no hay un freno de datos anotado en este carril';
  const rec = bandera(palabras, '--recommends');
  const lineas = [lo, `Qué cambió de verdad: ${bandera(palabras, '--changed') || '(sin decir)'}`,
    `La sesión recomienda: ${RECOMIENDA[rec] || rec || '(sin decir)'}, porque ${bandera(palabras, '--why') || '(sin decir)'}. Ante la duda, historia`];
  return { queHace: lineas, fuente: `${(f && f.huella) || ''}\n${lineas.join('\n')}` };
}

/**
 * Dejar pasar una vez un guardado ajeno al carril: lo que guarda, del pedido que anotó el freno de guardar (el comando,
 * el repo, la rama, hasta cinco nombres y cuántos más, los hooks y la configuración de la máquina que corre programas).
 * El código del cuadro sale de la huella del pedido: con otro pedido, otro cuadro. Sin pedido, no hay nada que firmar.
 */
function delGuardadoAjeno(estado, destino) {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(path.join(estado, 'adhoc', `${destino}.json`), 'utf8')); } catch (_) { a = null; }
  const p = a && a.guardadoAjeno;
  if (!p || !p.huella) return { error: 'no hay un guardado ajeno frenado en ese carril: lo anota el freno de guardar cuando frena' };
  const fa = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'adhoc-foreign-save.js'));
  const lineas = fa.lineasDe(p, { todo: true });
  // el destino, los hooks y la configuración que corre van en el cuadro que se clickea: no se recortan
  return { queHace: lineas, todoQueHace: true, fuente: `${p.huella}\n${lineas.join('\n')}` };
}

/**
 * Nombrar o retirar a la coordinadora: qué sesión, en qué carpeta. El id solo no le dice nada al dueño; la carpeta sí.
 * El rol es el que nombra el perfil del equipo (`approvals.relay_session`).
 */
function deLaDesignacion(firma, destino, cwd) {
  if (!destino) return null;
  let rol = null;
  try { rol = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js')).sesionQueReenvia().valor; } catch (_) { rol = null; }
  const verbo = firma === 'designation-set' ? 'pasa a ser' : 'deja de ser';
  // dos líneas: una carpeta larga no corta la que dice qué pasa
  const lineas = [`La sesión ${destino} ${verbo} la «${rol || 'coordinadora'}» de esta máquina`, `Su carpeta: ${cwd || process.cwd()}`];
  return { queHace: lineas, fuente: lineas.join('\n') };
}

/**
 * El rojo esperado de la matriz (`marker.js expect-red acmatrix --tests … --until …`): los criterios que la lista deja
 * sin evidencia en vivo, con su texto, las pruebas y la fecha, de la matriz de la historia de la corrida. Sin el comando
 * a la vista, sin la historia o sin la matriz, `{ error }`: sin los criterios a la vista no se firma.
 */
function delRojoEsperado(palabras, m) {
  if (!palabras) return { error: 'el comando no está escrito tal cual (una envoltura, una variable): sin los criterios a la vista no se firma' };
  const pruebas = String(valor(palabras, '--tests') || '').split(',').map((t) => t.trim()).filter(Boolean);
  const fecha = valor(palabras, '--until');
  if (!pruebas.length || !fecha) return { error: 'el comando no dice las pruebas (--tests) o la fecha (--until): sin ellas a la vista no se firma' };
  const historia = rutaDeLaHistoria(m);
  const texto = historia ? leer(historia) : null;
  if (!texto) return { error: `no encuentro la historia de la ejecución${historia ? ` (${historia})${porQueNo(historia)}` : ''}: sin sus criterios a la vista no se firma` };
  const lib = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts');
  let matriz;
  try {
    const rmx = require(path.join(lib, 'runtime-matrix.js'));
    matriz = rmx.compute({ storyPath: historia, ...rmx.opcionesDeTandaDelMarcador({ ...m, storyPath: historia }, historia) });
    if (matriz.structuralError) return { error: `la matriz de la historia no se puede calcular (${matriz.structuralError}): sin sus criterios a la vista no se firma` };
    const c = rmx.debtCoverage(matriz, pruebas);
    const textos = require(path.join(lib, 'lib', 'story-checks.js')).acTextsFromSpec(texto);
    const lineas = c.covered.map((n) => `AC ${n}: ${String(textos[n] || '(sin texto en la historia)').replace(/\s+/g, ' ').trim()}`);
    if (!lineas.length) lineas.push('Ningún criterio sin correr queda cubierto por esa lista: la firma no lleva nada al commit');
    lineas.push(`Pruebas de la lista: ${pruebas.join(', ')} · vence ${fecha}`);
    if (c.uncovered.length) lineas.push(`Sin cubrir por la lista (frenan igual): AC ${c.uncovered.join(', ')}`);
    if (c.unknown.length) lineas.push(`No están en la tabla de pruebas: ${c.unknown.join(', ')}`);
    const acs = c.covered.length ? `los AC ${c.covered.join(', ')}` : 'ningún criterio';
    return { criterios: c.covered, queHace: lineas, completo: historia, fuente: lineas.join('\n'), que: `llevar al commit ${acs} sin evidencia en vivo (pruebas ${pruebas.join(', ')}), hasta el ${fecha}` };
  } catch (e) {
    return { error: `no pude calcular la matriz de la historia (${(e && e.message) || e}): sin sus criterios a la vista no se firma` };
  }
}

function partesDe({ firma, palabras, cwd, marcador, estado, destino, topes } = {}) {
  if (firma === 'designation-set' || firma === 'designation-withdraw') return deLaDesignacion(firma, destino, cwd);
  if (firma === 'escape:rojo-esperado-de-la-matriz') return delRojoEsperado(palabras, marcador);
  if (!palabras) return null;
  if (firma === 'plan-approval') return delPlan(palabras, marcador, { estado, destino });
  if (firma === 'control-change' || firma === 'refresh-after-main') return deControles(palabras, cwd, estado);
  if (firma === 'manual-test') return deLaPruebaAMano(palabras, marcador);
  if (firma === 'critical-waiver') return delCritico(palabras, marcador);
  if (firma === 'extra-round') return deLaVuelta(palabras, marcador);
  if (firma === 'adhoc-lane' || firma === 'adhoc-lane:sobre-cupo') return delArreglo(palabras, topes);
  if (firma === 'adhoc-lane:datos' && estado && destino) return delFrenoDeDatos(palabras, estado, destino);
  if (firma === 'adhoc-lane:guardado-ajeno') return estado && destino ? delGuardadoAjeno(estado, destino) : { error: 'no sé de qué sesión es el guardado ajeno' };
  return null;
}

module.exports = { partesDe, historiaDe, seccionesDelPlan, planDe, carpetaDeLaCorrida, valor };
