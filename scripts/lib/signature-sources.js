'use strict';
/**
 * signature-sources.js — de dónde sale lo que dice la pregunta de cada firma (owner-approvals.js `cuadroDe`).
 *
 * Lo que la sesión escribe en el comando es una cita: puede no decir lo que se aprueba. Lo que la pregunta dice que hace
 * la firma, qué archivos toca y dónde está lo completo sale de lo mismo que el dueño firmaría si lo abriera: el plan
 * escrito, el diff de los controles, los criterios de la historia, el informe de hallazgos o la nota de la vuelta.
 *
 *   · `partesDe({ firma, palabras, cwd, marcador, estado, destino })` → `{ queHace, archivos, completo, completoEnPalabras,
 *     fuente, cita }` (el plan suma `revision`, la línea del resultado de su revisión automática; `completoEnPalabras` dice
 *     dónde está lo completo sin la ruta, que va al detalle del cuadro; `queHaceALaVista`, cuando lo que se muestra no es
 *     la fuente), o null si
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
// dónde está lo completo, en palabras: el cuadro no muestra la ruta (va a su detalle)
const EL_PLAN = 'el plan, en la carpeta de la ejecución';
const EL_INFORME = 'el informe de hallazgos de la ejecución';
const LA_CARPETA = 'la carpeta de la ejecución';
const laHistoria = (m) => (m && m.storyId ? `la historia ${m.storyId}` : 'la historia de la ejecución');
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

/**
 * El repo de la corrida: el del marcador o, en un marcador viejo sin él, la raíz de git de su historia absoluta. Nunca la
 * carpeta desde donde corre el proceso: la pregunta de firma no puede cambiar según dónde se lanzó. Sin ninguno, null.
 */
function repoDelMarcador(m) {
  if (!m) return null;
  const r = require(path.join(PIPELINE, '..', 'lib', 'run-dir.js')).rutasDeLaCorrida(m);
  return r && typeof r.repoPath === 'string' && path.isAbsolute(r.repoPath) ? r.repoPath : null;
}

function rutaDeLaHistoria(m) {
  if (!m || !m.storyPath) return null;
  if (path.isAbsolute(m.storyPath)) return m.storyPath;
  const repo = repoDelMarcador(m);
  return repo ? path.join(repo, m.storyPath) : null;
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
  const repo = repoDelMarcador(m);
  if (!repo) {
    process.stderr.write(`⚠️  el marcador de la historia ${m.storyId} no dice su repo ni trae su historia con ruta absoluta: sus firmas no entran en la lista.\n`);
    return null;
  }
  try { return require(PIPELINE).resolveRunDir(repo, String(m.storyId), false, rutaDeLaHistoria(m) || undefined, { marker: m }); } catch (e) {
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
  // varios archivos en un renglón se separan por «, », salvo dentro de una anotación entre paréntesis («(nuevo, 20 líneas)»)
  const archivos = renglones(seccion(texto, 'Archivos')).flatMap((l) => l.split(/,\s+(?![^(]*\))/)).map((a) => a.replace(/`/g, '').trim()).filter(Boolean);
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
  // una falta por renglón; si faltan las dos, a la vista van juntas en un renglón corto que el cuadro no corta, y cada
  // una entera en el detalle
  const corto = (e) => {
    const f = /falta la sección «## ([^»]+)»/.exec(e);
    if (f) return `le falta «## ${f[1]}»`;
    const n = /«## Qué hace» tiene (\d+)/.exec(e);
    return n ? `su «## Qué hace» tiene ${n[1]} líneas (van hasta ${LINEAS_DEL_PLAN})` : e;
  };
  const lasDos = s.errores && s.errores.length === 2 && s.errores.every((e) => /falta la sección/.test(e));
  const aLaVista = !s.errores || s.errores.length < 2 ? null : lasDos ? ['al plan le faltan las secciones «## Qué hace» y «## Archivos»: agregalas antes de pedir la firma']
    : [`el plan: ${s.errores.map(corto).join(' y ')}: corregilo antes de pedir la firma`];
  if (s.error) return { queHace: s.errores, ...(aLaVista ? { queHaceALaVista: aLaVista } : {}), completo: ruta, completoEnPalabras: EL_PLAN, fuente, cita, revision };
  return { queHace: s.queHace, archivos: s.archivos, completo: ruta, completoEnPalabras: EL_PLAN, fuente, cita, revision };
}

// volver a aprobar la maqueta (`approve-mockup`): firma como el plan, pero el cuadro es de la maqueta. Nombra la huella
// aprobada y la de ahora, y si cambian los textos que se comparan con la pantalla. La versión aprobada se lee del último
// commit, y sólo si su huella es la aprobada: sin ella, el cuadro dice que no sabe.
const LA_MAQUETA = 'la maqueta, en la carpeta de la guía del tester';
const SI_SALE_MAL_MAQUETA = 'se construye contra una maqueta que no querías, y la pantalla se compara con esos textos; se vuelve a aprobar la maqueta y se corrige la pantalla';
function deLaMaqueta(palabras, m) {
  const que = 'volver a aprobar la maqueta de una story';
  const cita = valor(palabras, '--approved');
  const mk = require(path.join(PIPELINE, '..', 'mockup.js'));
  const historia = rutaDeLaHistoria(m);
  let p = null;
  try { p = historia ? mk.mockupPaths(historia) : null; } catch (_) { p = null; }
  const html = p ? leer(p.mockup) : null;
  if (html == null) {
    const linea = p ? `no encuentro la maqueta en ${p.mockup}${porQueNo(p.mockup)}` : 'no sé dónde está la maqueta: la sesión no tiene una historia que la ubique';
    return { que, queHace: [linea], fuente: linea, cita, siSaleMal: SI_SALE_MAL_MAQUETA };
  }
  const nueva = mk.mockupHash(html);
  // la aprobada es la que anotó la ejecución (como la mira approve-mockup); el archivo de aprobación del repo no la prueba
  const vieja = m && m.mockupApproval && m.mockupApproval.sha256 ? String(m.mockupApproval.sha256) : null;
  const corta = (h) => h.slice(0, 12);
  const lineas = [];
  let textos = 'sin comparar';
  if (!vieja) lineas.push(`Primera aprobación de la maqueta en esta ejecución: huella ${corta(nueva)}`);
  else if (vieja === nueva) lineas.push(`La maqueta no cambió desde su aprobación: huella ${corta(nueva)}`);
  else {
    lineas.push(`Huella: ${corta(vieja)} → ${corta(nueva)}`);
    const r = git(path.dirname(p.mockup), ['show', `HEAD:./${path.basename(p.mockup)}`]);
    const antes = r.status === 0 && mk.mockupHash(r.stdout) === vieja ? mk.mockupTexts(r.stdout) : null;
    const ahora = mk.mockupTexts(html);
    if (!antes || !ahora) {
      textos = 'no sé';
      lineas.push('No sé si los textos que se comparan con la pantalla son los mismos: la versión aprobada no está en el último commit');
    } else {
      // como los compara la capa 10: por su texto, en cualquier pantalla; el motivo de una casilla es otra cosa
      const de = (ts) => [...new Set(ts.map((x) => `${x.kind === 'title' ? 'title' : ''}\u0000${String(x.text).replace(/\s+/g, ' ').trim()}`))];
      const a = de(antes); const b = de(ahora);
      const sale = a.filter((x) => !b.includes(x)); const entra = b.filter((x) => !a.includes(x));
      const nombres = (xs) => xs.slice(0, 3).map((x) => `«${x.split('\u0000')[1]}»`).join(', ') + (xs.length > 3 ? ` y ${xs.length - 3} más` : '');
      if (!sale.length && !entra.length) { textos = 'iguales'; lineas.push('Los textos que se comparan con la pantalla son los mismos: cambió el dibujo'); }
      else {
        textos = 'distintos';
        lineas.push(`Cambian los textos que se comparan con la pantalla: ${[sale.length ? `sale ${nombres(sale)}` : '', entra.length ? `entra ${nombres(entra)}` : ''].filter(Boolean).join('; ')}`);
      }
    }
  }
  return { que, queHace: lineas, completo: p.mockup, completoEnPalabras: LA_MAQUETA, fuente: [vieja || '', nueva, textos, ...lineas].join('\n'), cita, siSaleMal: SI_SALE_MAL_MAQUETA };
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
// variante), los de uso privado, que cada fuente dibuja a su manera, y el braille en blanco
const CLASE_QUE_NO_SE_VE = '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\p{Co}\\u{2800}]';
const NO_SE_VE = new RegExp(CLASE_QUE_NO_SE_VE, 'u');
// una marca de acento sin letra base (al principio, o después de algo que no es letra, número ni otra marca) se monta
// sobre lo que tiene al lado; con su letra es una tilde compuesta y se ve
const MARCA_SUELTA = /(^|[^\p{L}\p{N}\p{M}])\p{M}/u;
const NO_SE_VE_UNO = new RegExp(`^${CLASE_QUE_NO_SE_VE}$`, 'u');
const ES_BASE = /^[\p{L}\p{N}\p{M}]$/u;
// la ruta, para nombrarla en un motivo: con los escapes de JSON y con lo que no se ve escrito como su código, así se lee.
// Se decide sobre la ruta cruda, carácter por carácter: una marca detrás de un salto sigue sin letra base aunque el
// motivo escriba el salto con letras («\n»)
const rutaALaVista = (r) => {
  let t = '';
  let base = false;
  for (const c of String(r)) {
    const json = JSON.stringify(c).slice(1, -1);
    const suelta = /^\p{M}$/u.test(c) && !base;
    t += json !== c ? json : (NO_SE_VE_UNO.test(c) || suelta) ? `\\u{${c.codePointAt(0).toString(16)}}` : c;
    // una marca suelta tampoco es base de la que sigue
    base = ES_BASE.test(c) && !suelta;
  }
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
};
// las opciones que lee el guion (run-base-controls.sh `opt`), que sólo las lee separadas de su valor: pegadas con «=», la
// pregunta mostraría lo que el guion no firma
const OPCIONES_DEL_GUION = ['--root', '--base', '--entries', '--file', '--rev', '--out', '--range', '--expect'];
// el guion de los controles de este mismo árbol: arma la lista de una firma por rango como la arma al firmar
const GUION_DE_CONTROLES = path.join(__dirname, '..', 'ci', 'run-base-controls.sh');

/**
 * Las rutas de una firma por rango (`approve --base <rev> --range <base>...<punta> --expect <huella>`), que no nombra los
 * archivos: las arma el guion desde el pedido, como al firmar (`entries`), y tienen que dar la huella que pide el
 * comando. `{ rutas, entradas }`, `{ error }`, o null si el comando no es por rango.
 */
function rutasDelRango(palabras, raiz) {
  if (valor(palabras, '--range') == null || valor(palabras, '--entries') != null || valor(palabras, '--file') != null) return null;
  const base = valor(palabras, '--base');
  const rango = valor(palabras, '--range');
  const huella = valor(palabras, '--expect');
  if (!base || base.startsWith('--') || !rango || rango.startsWith('--')) return { error: 'la firma por rango no dice su base o su rango: no sé qué archivos de control firma' };
  if (!/^[0-9a-f]{64}$/.test(String(huella || ''))) return { error: 'la firma por rango no trae --expect con la huella de su lista: no sé qué archivos de control firma' };
  const r = spawnSync('bash', [GUION_DE_CONTROLES, 'entries', '--root', raiz, '--base', base, '--range', rango, '--expect', huella],
    { cwd: raiz, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  let leido = null;
  try { leido = r.status === 0 ? JSON.parse(String(r.stdout).trim()) : null; } catch (_) { leido = null; }
  if (!leido || !Array.isArray(leido.entries) || !leido.entries.length) {
    const motivo = String(r.stderr || r.stdout || '').trim().split('\n').pop() || (r.error && r.error.message) || 'el guion no contestó';
    return { error: `no pude armar la lista de la firma por rango (${motivo.slice(0, 200)})` };
  }
  for (const e of leido.entries) {
    if (!e || typeof e.path !== 'string' || !e.path) return { error: 'la lista de la firma por rango trae una entrada sin ruta' };
    const no = porQueNoSeVe(e.path);
    if (no) return { error: `la ruta «${rutaALaVista(e.path)}» de la lista ${no}` };
  }
  return { rutas: leido.entries.map((e) => e.path), entradas: leido.entries };
}

/**
 * Por qué una ruta no se vería en la pregunta tal como se firma, o null: «, » arma otra ruta en la lista, un salto, un
 * carácter de control, uno invisible o un separador de renglón cambian el texto, y los espacios de más, en las puntas o
 * que no son el común se ven como uno solo (owner-approvals.js `cuadroDe` junta los espacios).
 */
function porQueNoSeVe(ruta) {
  if (NO_SE_VE.test(ruta) || MARCA_SUELTA.test(ruta)) return 'trae un salto de línea, un carácter de control o uno que no se ve';
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

// los renglones con que la sesión que hizo el cambio explica, en sus commits, qué cambia el control, por qué y su riesgo
const EXPLICA = [['cambia', /^cambia-control$/i], ['porque', /^por-qu[eé]$/i], ['riesgo', /^riesgo$/i]];
/**
 * Lo que los commits de `rango` (o el commit `uno`) declaran sobre el cambio: `{ cambia, porque, riesgo, texto }`, con
 * cada valor sin repetir; null si ninguno declara nada; undefined si git no pudo leer los commits (no se sabe: el cuadro
 * queda como siempre). `texto` entra en la huella: otro texto pide otro click.
 */
function explicacionDe(raiz, { rango = null, uno = null }) {
  const r = rango ? git(raiz, ['log', '--format=%B%x00', `${rango[0]}..${rango[1]}`]) : git(raiz, ['log', '-1', '--format=%B%x00', uno]);
  if (r.status !== 0) return undefined;
  const valores = { cambia: [], porque: [], riesgo: [] };
  for (const linea of String(r.stdout).split(/\r?\n/)) {
    const m = /^([\p{L}-]+):\s*(\S.*?)\s*$/u.exec(linea.replace(/\0/g, ''));
    if (!m) continue;
    const clave = EXPLICA.find(([, re]) => re.test(m[1]));
    // sin una letra o un número no dice nada; con letras que no se ven (de control, de dirección, invisibles) el cuadro
    // mostraría otra cosa que lo escrito: no se muestra, y lo dice
    const valor = !/[\p{L}\p{N}]/u.test(m[2]) ? null : NO_SE_VE.test(m[2]) ? '(lo escrito trae letras que no se ven: no se muestra)' : m[2];
    if (clave && valor && !valores[clave[0]].includes(valor)) valores[clave[0]].push(valor);
  }
  if (!valores.cambia.length && !valores.porque.length && !valores.riesgo.length) return null;
  const out = Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, v.length ? v.join(' · ') : null]));
  return { ...out, texto: JSON.stringify(out) };
}

/** El cambio de los controles: cuántas líneas, qué rutas y el diff completo en un archivo de la carpeta de estado. */
function deControles(palabras, cwd, estado) {
  const raiz = path.resolve(cwd || process.cwd(), valor(palabras, '--root') || '.');
  const pedidas = rutasDelComando(palabras) || rutasDelRango(palabras, raiz);
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
    const explica = explicacionDe(raiz, { uno: firmada || 'HEAD' });
    return { queHace: [`Firma ${rutas.length} archivo(s) de control en su versión ${conArchivo ? `de ${firmada.slice(0, 12)}` : 'de la punta'} (sin base para comparar)`], archivos: rutas,
      completo: raiz, completoEnPalabras: `el repo ${path.basename(raiz)}`, explica, fuente: JSON.stringify({ entradas: entradas || rutas, blobs, explica: explica && explica.texto }) };
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
  // las que cambiaron: una ruta pedida sin cambio entre la base y la punta no sale en el numstat
  const cambiadas = num.stdout.split('\0').filter(Boolean);
  for (const l of cambiadas) {
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
  const cuantas = cambiadas.length < rutas.length ? `${cambiadas.length} de ${rutas.length} archivo(s) de control pedidos` : `${rutas.length} archivo(s) de control`;
  // lo que la sesión que hizo el cambio declara en sus commits: va primero en el cuadro, y entra en la huella
  const explica = explicacionDe(raiz, { rango });
  return { queHace: [`Cambia ${cuantas}: +${mas} −${menos} líneas`], archivos: rutas, completo, completoEnPalabras: completo ? 'el cambio, en un archivo de la ejecución' : null, explica,
    fuente: explica ? `${diff.stdout}\0${explica.texto}` : diff.stdout };
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
  return lineas.length ? { criterios: acs, queHace: lineas, completo: historia, completoEnPalabras: laHistoria(m), fuente: lineas.join('\n') } : null;
}

function hallazgosDe(dir) {
  const ruta = dir ? path.join(dir, 'findings.json') : null;
  const texto = ruta ? leer(ruta) : null;
  if (texto == null) return { ruta: null, lista: null, roto: porQueNo(ruta) || null };
  let j;
  try { j = JSON.parse(texto); } catch (e) { return { ruta, lista: null, texto, roto: ` (no se entiende: ${e.message})` }; }
  return { ruta, texto, lista: Array.isArray(j) ? j : (j && Array.isArray(j.findings) ? j.findings : []) };
}

/** El hallazgo crítico que se exime, del informe de hallazgos de la ejecución. */
function delCritico(palabras, m) {
  const regla = valor(palabras, '--rule');
  if (!regla) return null;
  const archivo = valor(palabras, '--file');
  const cita = valor(palabras, '--reason');
  const nombre = `${regla}${archivo ? ` en ${archivo}` : ''}`;
  const h = hallazgosDe(carpetaDeLaCorrida(m));
  const archivos = archivo ? [archivo] : [];
  if (!h.lista) return { queHace: [`Eximir ${nombre}: ${h.roto ? `no pude leer el informe de hallazgos${h.roto}` : 'no hay informe de hallazgos en esta ejecución'}`], archivos, completo: h.ruta, completoEnPalabras: EL_INFORME, fuente: h.texto || '', cita };
  const reglaDe = (f) => String(f.rule_id || f.ruleId || f.rule || '').trim();
  // la exención se anota con la clave regla|archivo (critical-waivers.js): sin --file sólo exime los que no tienen archivo
  const iguales = h.lista.filter((f) => f && reglaDe(f) === regla && String(f.file || '').trim() === String(archivo || '').trim());
  if (!iguales.length) return { queHace: [`Eximir ${nombre}: no está en el informe de hallazgos`], archivos, completo: h.ruta, completoEnPalabras: EL_INFORME, fuente: h.texto, cita };
  const lineas = iguales.map((f) => `${regla}${f.file ? ` en ${f.file}` : ''}: ${String(f.summary || f.title || f.reason || '(sin texto)').replace(/\s+/g, ' ').trim()}`);
  return { queHace: lineas, archivos: archivo ? archivos : [...new Set(iguales.map((f) => f.file).filter(Boolean))], completo: h.ruta, completoEnPalabras: EL_INFORME, fuente: h.texto, cita };
}

/**
 * La vuelta extra, en tres renglones: la vuelta que se pide, lo que sigue abierto en el informe de hallazgos de la
 * corrida (regla, archivo y si bloquea) y la nota de repensar de ESA vuelta (la de otra vuelta habla de lo anterior, y no
 * se muestra). Lo abierto y la nota van en la fuente: si cambian después del cuadro, el click no vale.
 */
function deLaVuelta(palabras, m) {
  const iter = valor(palabras, '--iter');
  const dir = carpetaDeLaCorrida(m);
  if (!iter || !/^\d+$/.test(iter)) return dir ? { queHace: ['Una vuelta más de revisores sobre lo que quedó abierto'], completo: dir, completoEnPalabras: LA_CARPETA, fuente: '' } : null;
  const ruta = dir ? path.join(dir, 'rethink', `iter-${iter}.json`) : null;
  const texto = ruta ? leer(ruta) : null;
  let n = null;
  let roto = porQueNo(ruta);
  try { n = texto ? JSON.parse(texto) : null; } catch (e) { roto = ` (${e.message})`; }
  const campos = n ? [n.repeated && `Se repitió: ${n.repeated}`, n.change ? `Cambia: ${n.change}` : n.keep && `Sigue igual: ${n.keep}`, n.story_change && `Cambia la historia: ${n.story_change}`].filter(Boolean) : [];
  // una nota que existe y no se lee no es «sin nota»
  const deLaNota = n ? `Nota de la vuelta ${iter}: ${campos.join('; ')}`
    : texto !== null && texto !== undefined ? `Nota de la vuelta ${iter}: no se entiende${roto}`
      : roto ? `No pude leer la nota de repensar de la vuelta ${iter}${roto}` : `Sin nota de repensar de la vuelta ${iter}`;
  const ab = abiertoDeLaCorrida(dir);
  const conNota = texto !== null && texto !== undefined;
  // dos renglones, los que muestra el cuadro: la vuelta con lo abierto, y la nota (la fuente es lo abierto y la nota)
  return { queHace: [`Vuelta ${iter} de revisores: ${ab.linea}`, deLaNota], completo: conNota ? ruta : dir, completoEnPalabras: conNota ? 'la nota de la vuelta, en la carpeta de la ejecución' : LA_CARPETA, fuente: JSON.stringify({ abiertos: ab.lista, nota: texto || null }) };
}

/**
 * Lo que sigue abierto en el informe de hallazgos de la ejecución: `{ linea, lista }`, un tramo por hallazgo abierto en un
 * solo renglón (la pregunta muestra tres renglones de «Qué hace», y la nota de la vuelta tiene que entrar). «No lo pude
 * leer» no es «nada», y una carpeta que no se ubica no es un informe que falta.
 */
function abiertoDeLaCorrida(dir) {
  const uno = (linea, lista) => ({ linea, lista });
  if (!dir) return uno('No pude ubicar la carpeta de la ejecución: no sé qué sigue abierto', { error: 'sin carpeta' });
  const rr = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'review-rounds.js'));
  const h = rr.hallazgosDe(dir);
  if (h.error) return uno(`No pude leer el informe de hallazgos: ${h.error}`, { error: h.error });
  if (!h.existe) return uno('No hay informe de hallazgos en esta ejecución', null);
  const lista = rr.abiertos(h.lista);
  if (!lista.length) return uno('Nada abierto en el informe de hallazgos', lista);
  return uno(`Sigue abierto: ${lista.map((a) => `${a.regla}${a.file ? ` en ${a.file}` : ''}, ${a.bloquea ? 'bloquea' : 'no bloquea'}`).join('; ')}`, lista);
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
function delArreglo(palabras, topes = null, { cwd = null, casa } = {}) {
  if (!palabras || palabras[1] !== 'adhoc' || palabras[2] !== 'set') return null;
  let p = null;
  try { p = JSON.parse(palabras[3] || ''); } catch (_) { p = null; }
  if (!p || typeof p !== 'object') return null;
  const conNumero = Number.isFinite(Number(p.maxFiles)) && Number(p.maxFiles) > 0;
  const maximo = conNumero ? null : (topes || topesLeidos()).maximo;
  const cupo = conNumero ? `hasta ${Number(p.maxFiles)} archivos de implementación, sin pruebas ni guías` : `el cupo de la organización (${maximo} archivos de implementación, o el que ya tenía)`;
  const datos = { 'sin-cambio': 'La sesión declara que no cambia de dónde salen los datos ni quién los ve', cambian: 'La sesión declara que cambia de dónde salen los datos o quién los ve' }[p.datos];
  const r = reposDelPedido(palabras, p, { cwd, casa });
  // con más de un repo, lo primero que lee el dueño son los repos y cuántos archivos de cada uno. Sin «:», que es donde
  // el cuadro corta el renglón al achicarse: los repos quedan a la vista
  const nombres = r ? r.repos.map((x) => `${x.nombre} (${x.archivos})`) : [];
  const enRepos = nombres.length > 1 ? ` en ${nombres.length} repos, ${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]},` : '';
  return {
    queHace: [`Abre un arreglo rápido${enRepos} sin historia, con ${cupo}`, ...(datos ? [datos] : [])],
    // los repos resueltos y su raíz real van en la huella: con otros repos, el click dado antes no vale
    fuente: r && r.hermanos ? `${palabras[3]}\n${r.repos.map((x) => `${x.nombre}\t${x.raiz}`).join('\n')}` : palabras[3],
    cita: String(p.reason || '') || null,
    ...(r && r.repos.length > 1 ? { archivos: r.archivos } : {}),
  };
}

/**
 * Los repos de la lista de un `adhoc set`, resuelta contra la carpeta del pedido (la de la sesión destino con
 * `--for-session`): `{ repos: [{ nombre, raiz, archivos }], archivos, hermanos }`, o null si no se puede resolver.
 */
function reposDelPedido(palabras, p, { cwd, casa }) {
  if (!Array.isArray(p.allowedFiles) || !p.allowedFiles.length) return null;
  const lib = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
  try {
    const L = require(path.join(lib, 'adhoc-list.js'));
    const i = palabras.indexOf('--for-session');
    const carpeta = i >= 0 && palabras[i + 1] ? L.carpetaDeLaSesion({ casa: casa || require('os').homedir(), sesion: palabras[i + 1] }) : cwd;
    if (!carpeta) return null;
    const n = L.normalizar(p.allowedFiles, { cwd: carpeta });
    if (!n.lista) return null;
    const RG = require(path.join(lib, 'repo-group.js'));
    const repos = L.reposDeLaLista(n.lista).map((raiz) => ({
      raiz, nombre: n.hermanos.get(raiz) || path.basename(RG.checkoutPrincipal(raiz) || raiz),
      archivos: n.lista.filter((f) => f.startsWith(raiz + path.sep)).length,
    }));
    return { repos, archivos: n.lista.map((f) => L.relDeLaLista(f, carpeta, n.hermanos)), hermanos: n.hermanos.size > 0 };
  } catch (_) { return null; }
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
// lo que se firma al retirar a OTRA sesión (`withdraw-relay --session <id>`, historia 8.314): el título de la lista y del cuadro
const RETIRAR_OTRA = 'retirar a otra sesión de coordinadora de la máquina';

function deLaDesignacion(firma, destino, cwd, palabras) {
  if (!destino) return null;
  let rol = null;
  try { rol = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js')).sesionQueReenvia().valor; } catch (_) { rol = null; }
  // `--session <id>` separado, como lo leen marker.js y retiraA: la forma pegada (`--session=<id>`) marker.js la niega, y
  // el cuadro no puede nombrar a una sesión que el comando no retira
  const i = firma === 'designation-withdraw' && palabras && palabras[1] === 'withdraw-relay' ? palabras.indexOf('--session') : -1;
  const otra = i >= 0 && palabras[i + 1] != null && !String(palabras[i + 1]).startsWith('-') ? String(palabras[i + 1]) : null;
  if (otra && otra !== destino) {
    // la que se retira ya no vive: el cuadro la nombra a ella, y dice quién lo pide y desde dónde
    const lineas = [`La sesión ${otra} deja de ser la «${rol || 'coordinadora'}» de esta máquina: ya no vive`, `La pide la sesión ${destino}, desde ${cwd || process.cwd()}`];
    const aLaVista = [`La sesión ${String(otra).slice(0, 8)} deja de ser la «${rol || 'coordinadora'}» de esta máquina: ya no vive`, `La pide la sesión ${String(destino).slice(0, 8)}, desde ${path.basename(cwd || process.cwd())}`];
    return { queHace: lineas, queHaceALaVista: aLaVista, fuente: lineas.join('\n'), que: RETIRAR_OTRA };
  }
  const verbo = firma === 'designation-set' ? 'pasa a ser' : 'deja de ser';
  // sin el rol en el perfil, nombrarla sólo la deja ordenar, y el cuadro lo dice: así no es el mismo cuadro que con el
  // rol (que la deja firmar), y un click dado sin perfil no vale si el perfil gana el rol antes de que corra el comando
  const modo = firma === 'designation-set' && !rol ? ': ordena, y las firmas siguen yendo a la persona' : '';
  // dos líneas: una carpeta larga no corta la que dice qué pasa
  const lineas = [`La sesión ${destino} ${verbo} la «${rol || 'coordinadora'}» de esta máquina${modo}`, `Su carpeta: ${cwd || process.cwd()}`];
  // con el rol, la fuente queda como estaba (la huella no cambia); lo que se ve dice la sesión por sus 8 letras y la carpeta por su nombre
  const aLaVista = [`La sesión ${String(destino).slice(0, 8)} ${verbo} la «${rol || 'coordinadora'}» de esta máquina${modo}`, `Su carpeta: ${path.basename(cwd || process.cwd())}`];
  return { queHace: lineas, queHaceALaVista: aLaVista, fuente: lineas.join('\n') };
}

/**
 * El rojo esperado de la matriz (`marker.js expect-red acmatrix --tests … --until …`): los criterios que la lista deja
 * sin evidencia en vivo, con su texto, las pruebas y la fecha, de la matriz de la historia de la corrida. Sin el comando
 * a la vista, sin la historia o sin la matriz, `{ error }`: sin los criterios a la vista no se firma. El de un control
 * (`expect-red <control> --tests …`, con la firma de cerrar como deuda) no tiene fecha ni matriz: el control, las
 * pruebas y la deuda. `de` (`control` o `matriz`): la firma que se pide, y el comando del otro rojo no se firma con ella.
 */
function delRojoEsperado(palabras, m, { de = null } = {}) {
  if (!palabras) return { error: 'el comando no está escrito tal cual (una envoltura, una variable): sin los criterios a la vista no se firma' };
  const pruebas = String(valor(palabras, '--tests') || '').split(',').map((t) => t.trim()).filter(Boolean);
  const control = String(palabras[2] || '').trim();
  const deUnControl = require('./owner-window.js').esRojoDeUnControl(palabras[2]);
  if (de === 'control' && !deUnControl) return { error: 'el rojo esperado de la matriz tiene su propia firma, con los criterios y la fecha' };
  if (de === 'matriz' && deUnControl) return { error: `el rojo esperado del control ${control} va con la firma de cerrar como deuda` };
  if (deUnControl) {
    if (!pruebas.length) return { error: 'el comando no dice las pruebas (--tests): sin ellas a la vista no se firma' };
    const deuda = m && m.cierre && m.cierre.estado === 'deuda' && m.cierre.deuda ? m.cierre.deuda : null;
    const linea = `Dejar el control ${control} en rojo esperado hasta el commit, con las pruebas ${pruebas.join(', ')}${deuda ? `, en la deuda ${deuda}` : ''}`;
    return { queHace: [linea], fuente: linea, que: `dejar ${control} en rojo esperado (pruebas ${pruebas.join(', ')})${deuda ? ` en la deuda ${deuda}` : ''}` };
  }
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
    return { criterios: c.covered, queHace: lineas, completo: historia, completoEnPalabras: laHistoria(m), fuente: lineas.join('\n'), que: `llevar al commit ${acs} sin evidencia en vivo (pruebas ${pruebas.join(', ')}), hasta el ${fecha}` };
  } catch (e) {
    return { error: `no pude calcular la matriz de la historia (${(e && e.message) || e}): sin sus criterios a la vista no se firma` };
  }
}

/**
 * La salida de una ejecución perdida (`marker.js restore <sesión>` o `clear-session <sesión> --lost`): de qué historia y
 * de qué sesión es, y cuándo se abrió. La apertura la busca la misma regla que el freno y marker.js (open-runs.js
 * `aperturaParaSalida`), en la carpeta de estado del cuadro; sin apertura, null (la pregunta dice lo que hace el comando).
 */
function deLaSalidaPerdida(palabras, cwd, estado, destino) {
  const sub = palabras[1];
  const sesion = palabras[2] != null ? String(palabras[2]) : '';
  const modo = sub === 'restore' ? 'restore' : sub === 'clear-session' && palabras.includes('--lost') ? 'lost' : null;
  if (!modo || !sesion || sesion.startsWith('-')) return null;
  const or = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'open-runs.js'));
  const ap = or.aperturaParaSalida(sesion, { modo, cwd, estado: estado || undefined, propia: destino });
  if (!ap) return null;
  const t = new Date(ap.ts);
  const dos = (n) => String(n).padStart(2, '0');
  const hora = Number.isFinite(t.getTime()) ? `${dos(t.getHours())}:${dos(t.getMinutes())} del ${dos(t.getDate())}/${dos(t.getMonth() + 1)}` : 'una hora que no se puede leer';
  const linea = `${modo === 'restore' ? 'Restaurar' : 'Cerrar como perdida'} la ejecución de la historia ${ap.story} (sesión ${sesion}), abierta ${ap.antes ? 'antes de las' : 'a las'} ${hora}`;
  return { queHace: [linea], fuente: linea };
}

/**
 * El pedido de alguien de afuera: el autor, el número, el título y cuántos archivos toca, preguntados a GitHub
 * (external-pr.js). Lo que se preguntó entra en la fuente: un click dado a otro pedido, u otro título, no se toma.
 */
function delPedidoDeAfuera(palabras, cwd, casa) {
  if (!palabras) return { error: 'el pedido de afuera no se lee entero: no hay cuadro' };
  const E = require('./external-pr.js');
  // las palabras vuelven a un comando con comillas simples donde hacen falta (una consulta de GraphQL lleva espacios)
  const comando = palabras.map((w) => (/^[\w@%+=:,./-]+$/.test(String(w)) ? String(w) : `'${String(w).replace(/'/g, "'\\''")}'`)).join(' ');
  const r = E.decidir(comando, { cwd, home: casa });
  if (!r || !r.firmas) return { error: (r && r.frena) || 'el comando no encola ni mergea un pedido de afuera' };
  return { que: 'encolar o mergear un pedido de alguien de afuera del equipo', queHace: r.firmas, fuente: r.firmas.join('\n') };
}

// lo que pasa si sale mal al cambiar o borrar un conjunto de reglas: no es que algo entre a main sin la CI, es que una
// regla que estaba deja de aplicarse
const SI_REEMPLAZA = 'el conjunto de reglas queda como lo escribe el comando; si le falta una regla que estaba (la revisión, la CI exigida, la cola), deja de aplicarse';
const SI_BORRA = 'lo que exigía el conjunto de reglas (la revisión, la CI exigida, la cola) deja de aplicarse';
// el archivo de `--input` que se lee para el cuadro: uno de verdad tiene unos pocos kilobytes
const TOPE_DEL_CUERPO = 256 * 1024;
const NOMBRE_DE_CLAVE = /^[\w.-]{1,60}(\[[\w.-]{1,60}\])?$/;
const CLAVES_A_LA_VISTA = 12;

/** Las claves de primer nivel del cuerpo JSON de `--input` (de una regla, su tipo), o `{ error }` si no se lee. */
function clavesDelCuerpo(archivo, cwd) {
  try {
    // la terminal expande la tilde antes de correr el comando: el cuadro lee el mismo archivo
    const tilde = /^~(?=[\\/]|$)/.test(archivo) ? require('os').homedir() + archivo.slice(1) : archivo;
    const ruta = path.resolve(cwd || process.cwd(), tilde);
    const st = fs.statSync(ruta);
    // un dispositivo o una tubería dice tamaño 0 y su lectura no termina: el cuadro no espera
    if (!st.isFile()) return { error: 'no es un archivo común' };
    if (st.size > TOPE_DEL_CUERPO) return { error: 'es demasiado grande para leerlo' };
    const cuerpo = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return { error: 'no es un objeto JSON' };
    const claves = [];
    for (const k of Object.keys(cuerpo)) {
      const tipos = k === 'rules' && Array.isArray(cuerpo.rules) ? cuerpo.rules.map((r) => r && typeof r.type === 'string' && `rules[${r.type}]`).filter(Boolean) : [];
      claves.push(...(tipos.length ? tipos : [k]));
    }
    return { claves };
  } catch (e) { return { error: e && e.code === 'ENOENT' ? 'no está' : 'no se puede leer' }; }
}

/** Lo que manda un comando que reemplaza un conjunto de reglas, en palabras: sus claves, o que no se ve. */
function loQueManda(manda, cwd) {
  const claves = [...(manda.campos || [])];
  let porQue = '';
  if (manda.archivo) {
    const c = clavesDelCuerpo(manda.archivo, cwd);
    if (c.error) porQue = ` (${path.basename(manda.archivo)} ${c.error})`;
    else claves.push(...c.claves);
  }
  // una clave con caracteres raros no se muestra tal cual: el cuadro no repite lo que el agente quiera escribir
  const todas = [...new Set(claves)];
  const vistas = todas.filter((k) => NOMBRE_DE_CLAVE.test(k));
  if (!vistas.length) return `no se ve qué manda${porQue}`;
  const mas = vistas.length > CLAVES_A_LA_VISTA || vistas.length < todas.length ? ' y otras' : '';
  return `${vistas.slice(0, CLAVES_A_LA_VISTA).join(', ')}${mas}${porQue}`;
}

/**
 * Saltear la cola o aflojar las reglas: lo que el lector (ci-bypass.js) dice de cada forma del comando. Sólo con un
 * conjunto de reglas de GitHub tiene texto propio (qué le hace y lo que manda); lo demás, el cuadro de siempre.
 */
function deSaltearLaCola(comando, cwd) {
  if (comando == null) return null;
  let hs;
  try { hs = require('./ci-bypass.js').leer(String(comando)); } catch (_) { return null; }
  // una parte que el lector no lee entera puede ser un merge: el cuadro de siempre, con la alarma
  if (hs.some((h) => !h.legible)) return null;
  const conjuntos = hs.filter((h) => h.conjunto);
  if (!conjuntos.length) return null;
  const queHace = [];
  for (const h of hs) if (!queHace.includes(h.motivo)) queHace.push(h.motivo);
  const corto = require('./owner-approvals.js').sinRutas(String(comando).replace(/\s+/g, ' ').trim());
  // lo que manda cada conjunto que se reemplaza, con su número cuando son varios
  const reemplazos = conjuntos.filter((h) => h.accion === 'replace');
  const reemplaza = reemplazos.length > 0;
  const mandas = reemplazos.map((h) => `${reemplazos.length > 1 ? `al ${h.conjunto}: ` : ''}${loQueManda(h.manda, cwd)}`);
  queHace.push(`${reemplaza ? `lo que manda: ${mandas.join('; ')}; ` : ''}el comando: ${corto}`);
  // con otra forma en el mismo comando (un merge con --admin), su consecuencia de siempre también vale: no se reemplaza
  const soloReglas = conjuntos.length === hs.length;
  return { ...(soloReglas ? { que: 'cambiar o borrar un conjunto de reglas de la rama', siSaleMal: reemplaza ? SI_REEMPLAZA : SI_BORRA } : {}),
    queHace, fuente: queHace.join('\n') };
}

function partesDe({ firma, palabras, comando, cwd, marcador, estado, destino, topes, casa } = {}) {
  if (firma === 'escape:merge-bypass') return deSaltearLaCola(comando, cwd);
  if (firma === 'designation-set' || firma === 'designation-withdraw') return deLaDesignacion(firma, destino, cwd, palabras);
  if (firma === 'escape:rojo-esperado-de-la-matriz') return delRojoEsperado(palabras, marcador, { de: 'matriz' });
  // el rojo esperado de un control va con la firma de cerrar como deuda: el cuadro dice el control, las pruebas y la deuda
  if (firma === 'escape:cerrar-como-deuda' && palabras && palabras[1] === 'expect-red') return delRojoEsperado(palabras, marcador, { de: 'control' });
  // volver al modo autónomo: el cuadro sale de la detención que el control de cierre anotó en el marcador de la sesión
  if (firma === 'autonomy-resume') return require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'autonomy-decision.js')).partes(marcador, { casa, sesion: destino });
  if (firma === 'escape:external-pr') return delPedidoDeAfuera(palabras, cwd, casa);
  if (!palabras) return null;
  if (firma === 'plan-approval') return palabras[1] === 'approve-mockup' ? deLaMaqueta(palabras, marcador) : delPlan(palabras, marcador, { estado, destino });
  if (firma === 'control-change' || firma === 'refresh-after-main') return deControles(palabras, cwd, estado);
  if (firma === 'manual-test') return deLaPruebaAMano(palabras, marcador);
  if (firma === 'critical-waiver') return delCritico(palabras, marcador);
  if (firma === 'extra-round') return deLaVuelta(palabras, marcador);
  if (firma === 'adhoc-lane' || firma === 'adhoc-lane:sobre-cupo') return delArreglo(palabras, topes, { cwd, casa });
  if (firma === 'adhoc-lane:datos' && estado && destino) return delFrenoDeDatos(palabras, estado, destino);
  if (firma === 'adhoc-lane:guardado-ajeno') return estado && destino ? delGuardadoAjeno(estado, destino) : { error: 'no sé de qué sesión es el guardado ajeno' };
  if (firma === 'lost-run') return deLaSalidaPerdida(palabras, cwd, estado, destino);
  return null;
}

module.exports = { RETIRAR_OTRA, partesDe, laHistoria,historiaDe, seccion, seccionesDelPlan, planDe, carpetaDeLaCorrida, valor, abiertoDeLaCorrida };
