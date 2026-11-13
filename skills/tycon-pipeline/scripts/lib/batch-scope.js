'use strict';
/**
 * batch-scope.js — la parte de una historia que se está haciendo (la tanda que anota `marker.js set-batch`).
 *
 * Una parte vale si declara `files:` no vacío o, sin él, si la historia le ata al menos un archivo (la regla de atar,
 * `tandasQueNombran`: su lista son los atados más los que no se atan a ninguna tanda); cada archivo suyo está en
 * `files_to_create` o `files_to_modify` de la historia, y ningún archivo de código suyo es de otra parte abierta (dos
 * partes abiertas que comparten código se miden como la historia entera; una guía, `suites.json` o
 * `sprint-status.yaml` compartidos no la invalidan).
 * Con una parte válida, el riesgo, la marca de delicada y el tamaño del plan miden la parte más lo que el cambio toca;
 * el pase, su modelo y la revisión de la historia siguen por la historia entera. En duda (la historia no se lee, el
 * bloque no se entiende, la parte no está), la historia entera.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sinPunto = (r) => r.replace(/^\.\//, '');
// Los renglones de lista del frontmatter (`- ruta  # comentario`), con la ruta como la lee la lista (entre comillas o no).
function renglonesDeLista(fm) {
  return fm.split(/\r?\n/).map((l) => l.match(/^\s*-\s+(?:(["'])(.*?)\1|([^\s#]+))(.*)$/)).filter(Boolean)
    .map((m) => ({ ruta: sinPunto((m[2] !== undefined ? m[2] : m[3]).trim()), resto: m[4] }));
}

/**
 * Las tandas a las que la historia ata un archivo, cualquiera sea su estado: el comentario de su renglón en la lista
 * (`# tanda` y su nombre o su letra), una fila de la tabla de pruebas de esa tanda (`tests` / `tests_pending`) o una
 * tarea de esa tanda (`tasks` / `tasks_pending`) que lo nombra. Las tandas salen de `parsePipelinesBlock`, que lee
 * el bloque en forma de lista y de mapa. Devuelve `[{ name, status }]`. La usan la parte (`validarParte`) y la matriz.
 */
function tandasQueNombran(content, rel) {
  const fm = (String(content).match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  const cuerpo = String(content).slice(fm.length);
  const tandas = require('./story-checks.js').parsePipelinesBlock(content)
    .map((t) => ({ name: t.name, status: t.status, tests: [...t.tests, ...t.testsPending], tasks: [...t.tasks, ...t.tasksPending] }));
  if (!tandas.length) return [];
  const items = renglonesDeLista(fm);
  // el nombre del archivo, entero: ni pegado a otra palabra ni seguido de otra extensión (un punto final sí lo cierra).
  // Si otro archivo declarado se llama igual, el nombre solo no dice cuál es: hace falta la ruta entera.
  const gemelos = items.filter((it) => path.basename(it.ruta) === path.basename(rel) && it.ruta !== sinPunto(rel)).length;
  const buscado = (gemelos ? sinPunto(rel) : path.basename(rel)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // con la ruta entera, tampoco vale como cola de otra ruta más larga (`lib/src/a/x.js` no nombra a `src/a/x.js`)
  const antes = gemelos ? '[^\\w./-]' : '[^\\w.-]';
  const nombra = (texto) => new RegExp(`(^|${antes})${buscado}($|[^\\w.-]|\\.(?![\\w-]))`).test(texto);
  const atadas = new Set();
  // el comentario de su renglón en la lista que nombra la tanda, con la ruta como la lee la lista (entre comillas o no)
  for (const it of items) {
    if (it.ruta !== sinPunto(rel)) continue;
    for (const [, letra] of (it.resto.split('#')[1] || '').matchAll(/\btanda\s+([\w-]+)/gi)) {
      for (const t of tandas) if (t.name.toLowerCase() === letra.toLowerCase() || t.name.split('-')[0].toLowerCase() === letra.toLowerCase()) atadas.add(t);
    }
  }
  // una fila de la tabla de pruebas, por su ID
  for (const l of cuerpo.split(/\r?\n/)) {
    const fila = l.match(/^\|\s*([A-Za-z]+\d+\w*)\s*\|/);
    if (fila && nombra(l)) for (const t of tandas) if (t.tests.includes(fila[1])) atadas.add(t);
  }
  // una tarea, con sus renglones de continuación: hasta un renglón en blanco o un título
  for (const bloque of cuerpo.split(/\r?\n(?=\s*-\s*\[.\])/)) {
    const tarea = bloque.match(/^\s*-\s*\[.\][^\n]*?\bTask\s+(\d+)\b/);
    if (tarea && nombra(bloque.split(/\r?\n(?=\s*(?:#|\r?$))/m)[0])) for (const t of tandas) if (t.tasks.includes(Number(tarea[1]))) atadas.add(t);
  }
  return [...atadas].map((t) => ({ name: t.name, status: t.status }));
}

/**
 * La lista de una tanda que no declara `files:`: los archivos de la historia que se le atan (`tandasQueNombran`, o el
 * `files:` de otra parte, que ata a esa otra) más los que no se atan a ninguna tanda, que cualquiera puede tocar.
 * `{ files, atados }`: sin ningún atado propio, la tanda no tiene lista.
 */
function listaDerivada(texto, nombre, tandas) {
  const declarados = require('./run-size.js').declaredFiles(texto).map(normRuta).filter(Boolean);
  const deOtraParte = new Set();
  for (const t of tandas) if (t.name !== nombre && Array.isArray(t.files)) for (const f of t.files) deOtraParte.add(normRuta(f));
  const files = [];
  let atados = 0;
  for (const f of [...new Set(declarados)]) {
    const nombres = tandasQueNombran(texto, f).map((t) => t.name);
    if (nombres.includes(nombre)) { files.push(f); atados++; } else if (!nombres.length && !deOtraParte.has(f)) files.push(f);
  }
  return { files, atados };
}

/** Una ruta como la escribe la historia, en la forma en que se compara: sin comentario, comillas ni `./`, con `/`. */
function normRuta(f) {
  // sin la barra final: `src/db/` es la carpeta `src/db`
  return String(f || '').replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Lo que dos partes abiertas pueden compartir sin dejar de valer: lo que igual cuenta en la medición de cada una. */
const COMPARTIBLE = /(^|\/)(suites\.json|sprint-status\.ya?ml)$/i;

/** ¿El archivo cuenta como código para el pisado entre partes? La regla del tamaño (`classifyFile`), sin lo compartible. */
function esCodigoDeParte(f) {
  if (COMPARTIBLE.test(f)) return false;
  return require('./run-size.js').classifyFile(f).kind === 'code';
}

/**
 * La parte `nombre` de la historia (su texto): `{ existe, done, valid, reason, files, sensible, nombre }`. `existe: false`
 * si la historia no la tiene (o no tiene bloque). Nunca tira: lo que no se entiende da una parte inválida.
 */
function validarParte(texto, nombre) {
  const story = require('./story-checks.js');
  let tandas;
  try { tandas = story.parsePipelinesBlock(texto); } catch (e) { return { existe: false, valid: false, reason: `no pude leer el bloque pipelines (${e.message})`, nombre }; }
  const t = tandas.find((x) => x.name === nombre);
  if (!t) return { existe: false, valid: false, reason: `la parte «${nombre}» no está en la historia`, nombre };
  const done = String(t.status || '').toLowerCase() === 'done';
  const base = { existe: true, done, nombre, sensible: t.sensible || null };
  const declarada = Array.isArray(t.files) ? t.files.map(normRuta).filter(Boolean) : [];
  // sin `files:`, la lista sale de lo que la historia le ata a la tanda (más lo que no ata a ninguna)
  let derivada = null;
  if (!declarada.length) {
    derivada = listaDerivada(texto, nombre, tandas);
    if (!derivada.atados) return { ...base, valid: false, files: [], reason: `la parte ${nombre} no declara files: y ningún archivo atado a la tanda ${nombre}` };
  }
  const files = derivada ? derivada.files : declarada;
  const deLaHistoria = new Set(require('./run-size.js').declaredFiles(texto).map(normRuta));
  const fuera = files.filter((f) => !deLaHistoria.has(f));
  if (fuera.length) return { ...base, valid: false, files, reason: `${fuera[0]} está en files: de la parte ${nombre} y no en files_to_create ni files_to_modify de la historia` };
  for (const otra of tandas) {
    if (otra === t || String(otra.status || '').toLowerCase() === 'done') continue;
    // lo de la otra parte: su `files:` o, sin él, lo que la historia le ata (lo que no se ata a ninguna no pisa)
    const suyos = new Set(Array.isArray(otra.files) && otra.files.length ? otra.files.map(normRuta)
      : files.filter((f) => tandasQueNombran(texto, f).some((x) => x.name === otra.name)));
    const pisa = files.find((f) => suyos.has(f) && esCodigoDeParte(f));
    if (pisa) return { ...base, valid: false, files, reason: `${pisa} es código de la parte ${nombre} y de la parte abierta ${otra.name}: se mide la historia entera` };
  }
  return { ...base, valid: true, files, reason: null, ...(derivada ? { derivada: true } : {}) };
}

/**
 * La parte con la que se mide, o null (sin parte, o una que no vale: la historia entera). `story`: la ruta de la
 * historia; `batch`: el nombre de la parte. Una historia que no se lee da null.
 */
function parteMedible(story, batch) {
  if (!batch || !story) return null;
  let texto;
  try { texto = fs.readFileSync(story, 'utf8'); } catch (_) { return null; }
  const p = validarParte(texto, batch);
  return p.valid && !p.done ? p : null;
}

/** La huella de la lista de una parte: lo que la revisión del plan guarda y la aprobación delegada compara. */
function huellaDeLaLista(files) {
  return crypto.createHash('sha256').update([...(files || [])].map(normRuta).sort().join('\n')).digest('hex');
}

/** El valor de `sensible:` declarado (la historia o la parte), o null: el mismo formato que arriba. */
function sensibleDeclarado(valor) {
  if (valor === null || valor === undefined) return null;
  if (Array.isArray(valor)) return valor.length ? valor.join(', ') : null;
  const v = String(valor).replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').trim();
  return v && v !== '[]' && v.toLowerCase() !== 'false' ? v : null;
}

/**
 * El plan vuelve a «Aprobar el plan», pendiente con una persona: el paso sale de los hechos, entra a los pendientes y la
 * aprobación se borra. Devuelve el marcador (mutado). Sólo el esquema de pasos de ahora (2); en uno viejo no hace nada.
 */
function volverAlPlan(marker, { porDelicado = false } = {}) {
  if (!marker || marker.stepScheme !== 2) return marker;
  marker.stepsCompleted = (marker.stepsCompleted || []).filter((s) => String(s) !== 'approve-plan');
  const pend = (marker.stepsPending || []).map(String);
  if (!pend.includes('approve-plan')) marker.stepsPending = ['approve-plan', ...pend];
  delete marker.planApproval;
  // el cierre que lo devolvió a una persona queda anotado: hasta que una persona lo apruebe, ningún guardado pasa
  if (porDelicado) marker.planVueltoAPersona = { at: new Date().toISOString() };
  return marker;
}

/** ¿El plan volvió a una persona en el cierre y todavía no lo aprobó una? (la aprobación delegada no cuenta) */
const planEsperaPersona = (marker) => !!(marker && marker.planVueltoAPersona && (!marker.planApproval || marker.planApproval.mode === 'revision'));

/** La rama de trabajo de la que salen las ramas de historia en los repos de producto. */
const RAMA_DE_TRABAJO = 'dev';

/**
 * El cierre de una corrida con el plan aprobado por delegación: el diff entero (todo lo que la rama cambió contra el
 * merge-base más cercano con la rama principal o con `dev`, recién traídas, pruebas incluidas, más lo que está sin
 * guardar) se vuelve a medir con la marca de
 * delicada. `{ medir: false }` sin plan delegado; `{ problema }` si no se pudo medir (sin red, git que no contesta);
 * `{ delicado, archivos }` con lo medido. `delicada(files)`: la marca de la historia sobre esa lista (computeDelicate).
 */
function principalDe(repo, git) {
  const remotos = git(repo, ['remote']).split('\n').map((s) => s.trim()).filter(Boolean);
  const remoto = remotos.includes('origin') ? 'origin' : (remotos.length === 1 ? remotos[0] : null);
  if (!remoto) throw new Error(remotos.length ? `varios remotos y ninguno se llama origin (${remotos.join(', ')})` : 'el repo no tiene remoto');
  let rama = null;
  try { rama = git(repo, ['symbolic-ref', '--short', `refs/remotes/${remoto}/HEAD`]).replace(`${remoto}/`, '').trim(); } catch (_) { rama = null; }
  if (!rama) {
    for (const r of ['main', 'master']) {
      try { git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${remoto}/${r}`]); rama = r; break; } catch (_) { /* la siguiente */ }
    }
  }
  return { remoto, rama: rama || 'main' };
}

function cierreDelPlanDelegado({ marker, repo, delicada, git = gitDe }) {
  if (!marker || !marker.planApproval || marker.planApproval.mode !== 'revision') return { medir: false };
  if (!repo) return { problema: 'la corrida no dice su repo' };
  let base;
  try {
    // la rama principal del remoto: la que dice su HEAD, o main, o master; el remoto, origin o el único que hay
    const { remoto, rama } = principalDe(repo, git);
    git(repo, ['fetch', '--quiet', '--no-tags', remoto, rama]);
    const candidatas = [{ sha: git(repo, ['merge-base', 'HEAD', 'FETCH_HEAD']) }];
    // una rama que sale de `dev` se mide contra dev si está más cerca: lo que dev tiene de otras historias y todavía no
    // llegó a la principal no es de esta rama. Sin `dev` en el remoto, sólo la principal
    if (rama !== RAMA_DE_TRABAJO && git(repo, ['ls-remote', '--heads', remoto, `refs/heads/${RAMA_DE_TRABAJO}`])) {
      git(repo, ['fetch', '--quiet', '--no-tags', remoto, RAMA_DE_TRABAJO]);
      try { candidatas.push({ sha: git(repo, ['merge-base', 'HEAD', 'FETCH_HEAD']) }); } catch (e) {
        // exit 1: dev no tiene historia en común con la rama, y no sirve de base
        if (e.status !== 1) throw e;
      }
    }
    for (const c of candidatas) c.adelante = Number(git(repo, ['rev-list', '--count', `${c.sha}..HEAD`]));
    base = candidatas.sort((a, b) => a.adelante - b.adelante)[0].sha;
  } catch (e) { return { problema: `no pude traer la rama principal para medir el diff entero (${String(e.message || e).split('\n')[0]})` }; }
  let archivos;
  try {
    // separadas por NUL: sin eso git pone entre comillas y escapa una ruta con tildes o eñes, y las reglas no la reconocen
    const lista = ([sub, ...resto]) => git(repo, [sub, '-z', ...resto]).split('\0').filter(Boolean);
    // sin detección de renombres: un archivo movido cuenta por sus dos rutas (la vieja puede ser la delicada)
    archivos = [...new Set([...lista(['diff', '--name-only', '--no-renames', base]), ...lista(['diff', '--name-only', '--no-renames', '--cached', base]),
      ...lista(['ls-files', '--others', '--exclude-standard'])])];
  } catch (e) { return { problema: `no pude listar el diff entero (${String(e.message || e).split('\n')[0]})` }; }
  // sólo se descuenta el papeleo del arnés: la evidencia de `.advisors/` y los trozos de memoria
  const { esPapeleo } = require('./adhoc-list.js');
  archivos = archivos.filter((f) => !esPapeleo(f)).sort();
  const d = delicada(archivos);
  return { delicado: d && d.value ? d : null, archivos };
}

/**
 * El freno del cierre, con el marcador de la sesión (`markerPath`): `{ texto }` si no guarda, o null. Si el diff entero
 * sale delicado con el plan aprobado por la coordinadora, «Aprobar el plan» vuelve a pendiente con una persona (se
 * escribe en el marcador y en gates.log de `estado`); el código queda en la rama. Sin red, no guarda.
 */
function frenoDelCierre({ markerPath, estado, sid }) {
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (e) {
    // sin marcador no hay corrida que cerrar; uno que no se lee (roto, sin permiso) no deja saber si el plan era delegado
    if (e && e.code === 'ENOENT') return null;
    return { texto: `🔒 cierre: no pude leer el marcador de la corrida (${String(e.message || e).split('\n')[0]}). Sin leerlo no sé si el plan lo aprobó la coordinadora: no se guarda.` };
  }
  // el cierre ya lo devolvió a una persona: repetir el commit no lo saltea
  if (planEsperaPersona(marker)) {
    return { texto: '🔒 cierre: el diff entero salió delicado y «Aprobar el plan» volvió a una persona. Hasta que lo apruebe ella, no se guarda (la aprobación de la coordinadora no alcanza).' };
  }
  if (!marker || !marker.planApproval || marker.planApproval.mode !== 'revision') return null;
  const path = require('path');
  const repo = marker.repoPath || null;
  const story = marker.storyPath ? (path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(repo || process.cwd(), marker.storyPath)) : null;
  const pipeline = require('../pipeline.js');
  const r = cierreDelPlanDelegado({ marker, repo, delicada: (files) => (files.length ? pipeline.computeDelicate({ story, repo, files }) : { value: false }) });
  const io = require('./story-gate-io.js');
  if (r.problema) {
    try { io.appendLog(estado, 'gates.log', sid, { name: 'close-whole-diff', status: 'blocked', story: marker.storyId, reason: r.problema }); } catch (_) { /* el freno sale igual */ }
    return { texto: `🔒 cierre: ${r.problema}. El plan lo aprobó la coordinadora: sin medir el diff entero no se guarda.` };
  }
  if (!r.delicado) return null;
  volverAlPlan(marker, { porDelicado: true });
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
  try { io.appendLog(estado, 'gates.log', sid, { name: 'plan-reopened', status: 'ok', story: marker.storyId, motivo: 'el diff entero sale delicado', regla: r.delicado.rule, reason: r.delicado.reason }); } catch (_) { /* el freno sale igual */ }
  return {
    texto: [
      `🔒 cierre: el diff entero sale delicado — ${r.delicado.reason}.`,
      '  El plan lo aprobó la coordinadora para una parte; con este diff lo aprueba una persona. «Aprobar el plan» volvió a',
      '  pendiente, y el código queda en la rama.',
      '  Salidas (de una persona): aprobar el plan para el diff entero, o cerrar la historia como deuda con marker.js close-as-debt.',
    ].join('\n'),
  };
}

/**
 * Las rutas de `concurrency_paths:` de `.tycon/advisors.yaml` del repo (una lista; sin el archivo o sin declaración,
 * ninguna). Un archivo que existe y no se lee tira el error: quien llama lo dice, no lo toma como «sin declaración».
 */
function rutasDeConcurrencia(repo) {
  let texto;
  try { texto = fs.readFileSync(require('path').join(repo, '.tycon', 'advisors.yaml'), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const lineas = texto.split(/\r?\n/);
  const i = lineas.findIndex((l) => /^concurrency_paths\s*:/.test(l));
  if (i < 0) return [];
  const enLinea = lineas[i].replace(/^concurrency_paths\s*:\s*/, '').replace(/\s+#.*$/, '').trim();
  if (enLinea.startsWith('[')) return enLinea.replace(/^\[|\]$/g, '').split(',').map(normRuta).filter(Boolean);
  const out = [];
  for (const l of lineas.slice(i + 1)) {
    const it = l.match(/^\s+-\s*(.+?)\s*$/);
    if (it) { out.push(normRuta(it[1])); continue; }
    if (/^\S/.test(l)) break;
  }
  return out.filter(Boolean);
}
// `**/` es cero o más carpetas (`src/**/lock.js` también es src/lock.js), como en lib/match-glob.js; un `**` suelto, cualquier cosa
const comoPatron = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0002').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  .replace(/\u0002/g, '(?:.*/)?').replace(/\u0001/g, '.*')}(/.*)?$`);

/**
 * Las dos señales, como aviso (nunca cambian el riesgo, la delicada ni el pase): «ninguna prueba lo ataja» (un archivo
 * de código a modificar que ningún archivo de prueba del árbol nombra, por su nombre sin extensión; nunca se miran
 * `specs/qa/` ni `.advisors/`) y concurrencia (la parte toca una ruta que el repo declara en `concurrency_paths:`; sin
 * declaración, nada: no se mira el contenido). Con una parte válida, miran la parte; sin ella, la historia entera.
 * `raices`: el repo y sus compañeros declarados. Devuelve una lista de textos.
 */
function senales({ story, repo, batch, raices }) {
  const out = [];
  if (!story || !repo) return out;
  let texto;
  try { texto = fs.readFileSync(story, 'utf8'); } catch (e) {
    out.push(`ninguna prueba lo ataja: no medido, no pude leer la historia (${String(e.message || e).split('\n')[0]})`);
    return out;
  }
  const parte = batch ? parteMedible(story, batch) : null;
  const runSize = require('./run-size.js');
  const modificar = (() => {
    const m = texto.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return [];
    const lineas = m[1].split(/\r?\n/);
    const i = lineas.findIndex((l) => /^files_to_modify\s*:/.test(l));
    if (i < 0) return [];
    // la lista en línea (`[a, b]`), con un comentario en el renglón de la clave, o en bloque con comentarios entre ítems
    const enLinea = lineas[i].replace(/^files_to_modify\s*:\s*/, '').replace(/\s+#.*$/, '').trim();
    if (enLinea.startsWith('[')) return enLinea.replace(/^\[|\]$/g, '').split(',').map(normRuta).filter(Boolean);
    const r = [];
    for (const l of lineas.slice(i + 1)) {
      if (/^\s*(#.*)?$/.test(l)) continue;
      const it = l.match(/^\s*-\s+(.*)$/);
      if (it) r.push(normRuta(it[1])); else if (/^\S/.test(l)) break;
    }
    return r.filter(Boolean);
  })();
  const alcance = parte ? parte.files : runSize.declaredFiles(texto).map(normRuta);
  const codeFiles = require('./code-files.js');
  const aModificar = alcance.filter((f) => modificar.includes(f) && runSize.classifyFile(f).kind === 'code' && !codeFiles.isTestFile(f));
  if (aModificar.length) {
    const pruebas = [];
    const sinListar = [];
    for (const r of (raices && raices.length ? raices : [repo])) {
      let lista = [];
      try { lista = gitDe(r, ['ls-files']).split('\n').filter(Boolean); } catch (e) { sinListar.push(`${r} (${String(e.message || e).split('\n')[0]})`); }
      for (const f of lista) {
        if (/^(specs\/qa|\.advisors)\//.test(f) || !codeFiles.isTestFile(f)) continue;
        try { pruebas.push(fs.readFileSync(require('path').join(r, f), 'utf8')); } catch (_) { /* una que no se lee no nombra nada */ }
      }
    }
    const todo = pruebas.join('\n');
    // sin poder listar las pruebas de un repo, la señal no se mide: se dice, en vez de avisar sin base
    if (sinListar.length) out.push(`ninguna prueba lo ataja: no medido, no pude listar las pruebas de ${sinListar.join(', ')}`);
    else {
      for (const f of aModificar) {
        const nombre = require('path').posix.basename(f).replace(/\.[^.]+$/, '');
        const re = new RegExp(`(^|[^\\w-])${nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`);
        if (nombre && !re.test(todo)) out.push(`ninguna prueba lo ataja: ${f} se modifica y ningún archivo de prueba lo nombra`);
      }
    }
  }
  let conc = [];
  try { conc = rutasDeConcurrencia(repo).map(comoPatron); } catch (e) {
    out.push(`concurrencia: no medido, no pude leer .tycon/advisors.yaml (${String(e.message || e).split('\n')[0]})`);
  }
  for (const f of alcance) {
    if (conc.some((re) => re.test(f))) out.push(`concurrencia: ${f} está en concurrency_paths de .tycon/advisors.yaml`);
  }
  return out;
}

function gitDe(repo, args) {
  return require('child_process').execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
}

module.exports = { sinPunto, renglonesDeLista, tandasQueNombran, normRuta, validarParte, parteMedible, huellaDeLaLista, sensibleDeclarado, esCodigoDeParte, volverAlPlan, planEsperaPersona, cierreDelPlanDelegado, frenoDelCierre, senales, rutasDeConcurrencia };
