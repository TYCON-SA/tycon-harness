#!/usr/bin/env node
'use strict';
/**
 * dependencies-notice.js — el cobrador de la revisión nocturna de dependencias.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * El nocturno corre en Azure DevOps y deja su snapshot en el repo. Si un día deja de correr —se
 * rotaron las credenciales, se despriorizó el pipeline, alguien lo deshabilitó— **nadie se entera**:
 * no hay error, no hay rojo, simplemente no aparece nada nuevo. Y "no corrió" se ve exactamente
 * igual que "corrió y no había nada", que es la peor confusión posible para una pieza de vigilancia.
 *
 * Es el mismo agujero del examen de revisores: un aviso que muestra una foto de hace días
 * sin decirlo no se nota, porque un número viejo se lee igual que uno fresco.
 *
 * ── LAS DOS REGLAS ──────────────────────────────────────────────────────────────────────────────
 * · **HABLA AUNQUE ESTÉ TODO BIEN.** Una línea. Si sólo hablara en rojo, el silencio de una noche
 *   tranquila y el silencio de una pieza muerta serían el mismo silencio.
 * · **PASADO EL UMBRAL, CALLA LOS NÚMEROS.** Una foto vieja hace perseguir vulnerabilidades que
 *   quizá ya se arreglaron, o —peor— tranquiliza con un "limpio" de hace nueve días. Se denuncia la
 *   ausencia y NO se muestran los números.
 *
 * · **UNA NOCHE QUE CORRIÓ PERO NO LE CONTÓ A NADIE ES ROJA**. El snapshot se commitea
 *   ANTES de hablar con nadie, así que una noche que midió perfecto y no pudo entregar el resumen
 *   diario deja un snapshot fresco y completo — que sin esta regla saldría «✅ no hay nada esperando
 *   decisión». La constancia es la clave `resumen` que deja `daily-summary.js` DESPUÉS de intentar:
 *   sin la clave, «NO consta»; con la clave y sin entrega, «NO se entregó: <motivo>»; entregado, la
 *   línea de siempre suma « · resumen entregado (Telegram)» sin agregar una línea.
 * · **EL VIGILANTE TIENE LA MISMA RED**. No nace un hook nuevo: un hook nuevo viaja por el
 *   instalador y una máquina con la línea vieja de arranque lo baja sin enchufarlo; éste ya está registrado en todas.
 *
 * · **LEE LO PUBLICADO, NO EL DISCO**. La pregunta es qué dejó la noche en `main`, y el
 *   checkout del arnés puede estar en otra rama —otra sesión trabajando—: leer el disco daría la foto del día
 *   anterior y gritaría «pedidos en modo simulado» y «NO cruzó», mientras el `origin/main` que ya está en la copia tiene los Bugs creados
 *   de verdad, el cruce hecho y el resumen entregado. (Es lo del último fetch: el pull del arranque
 *   corre en paralelo con este aviso, así que puede llegar una sesión tarde.) Tres rojos falsos en un arranque son la vía rápida a que el aviso deje de leerse. Por eso
 *   snapshots y fichas se leen de `origin/main` (sin red: sólo el ref que ya está); si esta copia no lo
 *   tiene, cae al disco **y lo dice** — «leí lo publicado» y «no pude» no son lo mismo. Las carpetas
 *   pasadas por variable (banco, suites) se leen del disco a propósito y sin nota.
 *
 * · **LAS FICHAS SE BUSCAN EN DOS CARPETAS HASTA EL RETIRO**. Las fichas viven en
 *   `inbox/dependencies/`. Una copia que todavía las tiene en la carpeta anterior —una rama sin mergear, un
 *   `origin/main` atrasado— no encuentra la nueva, y un aviso que mirara sólo ahí diría «✅ no hay nada
 *   esperando decisión» con hallazgos esperando: un verde falso fabricado por la mudanza. Por eso busca primero
 *   en la nueva y, si NO ESTÁ, en la vieja, en lo publicado y en el disco. El nombre de la vieja no está escrito
 *   acá: sale del mapa de renombres (`scripts/lib/renames.json`). Sin mapa al lado —el banco copia este hook
 *   solo, y la copia pública no lo trae— mira sólo la nueva. Y «no está» no es «no pude mirar»: un git que
 *   falla al preguntar no manda a la vieja, vuelve al disco y lo dice, como cualquier otro git a medias.
 *
 * Fail-open total: sin snapshots, o ilegibles, sale mudo. Nunca rompe el arranque de una sesión.
 * Apagado: TYCON_DEPS_NOTICE=0
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// Las variables renombradas a inglés: el nombre viejo sigue valiendo hasta el retiro. Sin la biblioteca al
// lado (el hook copiado a un arnés de mentira, como hace el banco): paso directo con el nombre nuevo, fail-open.
const leerVariable = (() => {
  try {
    const { readEnv } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
    return (n) => readEnv(n, { where: 'scripts/hooks/dependencies-notice.js' });
  } catch (_) { return (n) => process.env[n]; }
})();

// 🔴 El nocturno corre TODAS las noches, así que 3 días deja lugar a DOS corridas perdidas sin
// gritar. Es un umbral propio: NO es el `VEJEZ_MS` del examen de revisores (8 días, porque aquél
// corre dos veces por semana) ni el `STALE_MS` de paridad. Tres preguntas distintas, tres dueños.
const VEJEZ_MS = 3 * 24 * 60 * 60 * 1000;
const TOPE_A_MOSTRAR = 2;   // el mismo presupuesto de ruido del nocturno
// Cuántos días antes de que VENZA una deuda declarada hay que avisar. Cuando una deuda vence, el análisis deja de
// ampararla y el repo empieza a frenar sus propios pull requests: el equipo se entera cuando ya
// está trabado, y a nadie le queda claro por qué. El snapshot trae el dato; este aviso lo dice.
// Dos semanas alcanzan para pagarla o para decidir renovarla a conciencia.
const AVISO_DEUDA_DIAS = 14;

// ── De dónde se lee ──────────────────────────────────────────────────────────────────────────────
// Una fuente es `{ listar(dir) → nombres, leer(dir, nombre) → texto, exists(dir) → sí/no }`. `listar` tira
// si no puede mirar (los llamadores ya tratan eso como «sin historia»); `leer` tira si no puede leer
// («ilegible»); `exists` contesta «no» SÓLO cuando la carpeta no está, y tira si no pudo preguntar.
// 🔴 «No está» es ENOENT y nada más. Un permiso negado, o un archivo donde debería haber una carpeta, es «no
// pude mirar»: se tira, y quien llama lo dice.
const DISCO = {
  listar: (dir) => fs.readdirSync(dir),
  leer: (dir, nombre) => fs.readFileSync(path.join(dir, nombre), 'utf8'),
  exists: (dir) => {
    let st;
    try { st = fs.statSync(dir); }
    catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
    if (!st.isDirectory()) throw Object.assign(new Error(`ENOTDIR: no es una carpeta, '${dir}'`), { code: 'ENOTDIR' });
    return true;
  },
};

// ── La carpeta de las fichas, y la anterior ──────────────────────
const CARDS_FOLDER = ['inbox', 'dependencies'];

/**
 * La carpeta anterior de las fichas, como partes de una ruta relativa a la raíz del arnés;
 * `null` si no se puede saber. Sale del mapa de renombres que el hook tiene al lado: la entrada `kind: folder`
 * cuyo `new` es la carpeta de hoy. Nunca escrita acá, así el día del retiro se va con el mapa.
 *
 * Sin mapa (el banco copia este hook solo; la copia pública no lo trae), con el mapa roto o con una entrada
 * que no es una ruta relativa limpia: `null`, y el aviso mira sólo la carpeta nueva. Lo que sale de un archivo
 * no se usa a ciegas como ruta: nada absoluto, nada que suba con `..`.
 *
 * No pasa por `legacy-names.js` a propósito: leer la carpeta anterior es el respaldo previsto,
 * no un «uso de nombre viejo» que haya que anotar, y este hook tiene que andar copiado solo.
 */
function legacyCardsFolder(mapFile = path.join(__dirname, '..', 'lib', 'renames.json')) {
  try {
    const entries = JSON.parse(fs.readFileSync(mapFile, 'utf8')).entries;
    const stripSlash = (s) => String(s).replace(/\/+$/, '');
    const e = (Array.isArray(entries) ? entries : []).find((x) => x && typeof x === 'object' && x.kind === 'folder'
      && typeof x.new === 'string' && typeof x.old === 'string' && stripSlash(x.new) === CARDS_FOLDER.join('/'));
    if (!e) return null;
    const parts = stripSlash(e.old).split('/');
    const clean = parts.length > 0 && parts.every((p) => p && p !== '.' && p !== '..' && !/[\\\0]/.test(p))
      && !/^[A-Za-z]:/.test(parts[0]);
    return clean ? parts : null;
  } catch { return null; }
}

const PUBLICADO = 'refs/remotes/origin/main';
// Los caracteres de control (C0 y C1, DEL y los separadores de línea U+2028/U+2029), armados por código: escritos
// literales en el fuente cortarían la expresión regular.
const CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f)
  + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']+', 'g');
/** Un motivo en una línea: sin caracteres de control (va a la pantalla del arranque) y cortado. */
const unaLinea = (t, max) => String(t === undefined || t === null ? '' : t).replace(CONTROL, ' ').trim().slice(0, max);

/**
 * Lo publicado: el árbol de `origin/main` de la copia del arnés, sin salir a la red. Devuelve
 * `{ fuente, fallo }` o `{ motivo }` cuando no se puede (git ausente, no es la raíz de un repo, sin ese ref).
 *
 * 🔴 UN GIT QUE FALLA NO ES UNA CARPETA VACÍA. Los llamadores tratan
 * «`listar` tiró» como «sin historia» y «no pude leer una ficha» como «no hay pendientes»: con el disco
 * eso es cierto, con git no — un `ls-tree` que se pasa de los 5 s deja el aviso MUDO, y un `show` de
 * una ficha que falla da «✅ no hay nada esperando decisión». Por eso la fuente anota el PRIMER fallo
 * (y después falla al instante, sin sumar esperas), y `main` vuelve a evaluar desde el disco diciéndolo.
 */
function fuentePublicada(raiz, gitCmd = 'git') {
  const git = (args) => execFileSync(gitCmd, ['-C', raiz, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
  const porque = (e) => (e && e.code === 'ENOENT' ? 'no se pudo ejecutar git'
    : e && e.code === 'ETIMEDOUT' ? 'git tardó más de 5 s' : `git salió ${e && e.status != null ? e.status : 'con error'}`);
  try {
    const top = git(['rev-parse', '--show-toplevel']).trim();
    // `.native`: en macOS y Windows normaliza las mayúsculas; la versión JS conserva las de la ruta
    // escrita y una línea de arranque con otra caja leería del disco en cada sesión.
    if (fs.realpathSync.native(top) !== fs.realpathSync.native(raiz)) return { motivo: 'la carpeta del arnés no es la raíz de un repo git' };
  } catch (e) { return { motivo: e && e.code === 'ENOENT' ? 'no se pudo ejecutar git' : 'la carpeta del arnés no es un repo git' }; }
  try { git(['rev-parse', '--verify', '--quiet', `${PUBLICADO}^{commit}`]); }
  catch (e) { return { motivo: e && (e.code === 'ENOENT' || e.code === 'ETIMEDOUT') ? porque(e) : 'esta copia no tiene origin/main' }; }
  const rel = (dir) => path.relative(raiz, dir).split(path.sep).join('/');
  let fallo = null;
  const anotado = (que, fn) => (...a) => {
    if (fallo) throw new Error(fallo);
    try { return fn(...a); } catch (e) { fallo = `no pude ${que} lo publicado: ${porque(e)}`; throw e; }
  };
  // La entrada de UNA ruta en lo publicado, `<modo> <tipo> <sha>\t<ruta>`: sin la barra final `ls-tree` nombra
  // la ruta misma — una línea si está, ninguna si no. Un git que falla acá queda anotado como cualquier otro
  // listado: «no pude mirar» no se lee como «no está».
  const entryOf = anotado('listar', (dir) => git(['ls-tree', PUBLICADO, '--', rel(dir)]).trim());
  return {
    fallo: () => fallo,
    fuente: {
      listar: anotado('listar', (dir) => {
        const r = rel(dir);
        return git(['ls-tree', '--name-only', PUBLICADO, '--', `${r}/`]).split('\n').filter(Boolean)
          .map((x) => x.slice(r.length + 1));
      }),
      leer: anotado('leer', (dir, nombre) => git(['show', `${PUBLICADO}:${rel(dir)}/${nombre}`])),
      // 🔴 Se mira el TIPO, no el nombre: un archivo llamado como la carpeta
      // contaría como «está», y el aviso ni caería a la carpeta anterior ni diría error: imprimiría el ✅. La misma
      // regla que el disco: algo que está y no es una carpeta se tira. Y se tira FUERA de `anotado`: git anduvo,
      // así que no es un fallo de lo publicado que mande a leer el disco; lo dice quien llama.
      exists: (dir) => {
        const entry = entryOf(dir);
        if (!entry) return false;
        if (/^\d+ tree /.test(entry)) return true;
        throw Object.assign(new Error(`ENOTDIR: no es una carpeta, '${rel(dir)}' en lo publicado`), { code: 'ENOTDIR' });
      },
    },
  };
}

function snapshots(dir, fuente = DISCO) {
  try {
    return fuente.listar(dir)
      .filter((f) => /^dependencias-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
  } catch { return []; }
}

/**
 * En cuál de las dos carpetas están las fichas pendientes para ESTA fuente: la nueva si está; si no está, la
 * vieja cuando está; si no está ninguna, la nueva (y el listado dirá que no hay). La nueva gana siempre: la
 * vieja es el respaldo de una copia atrasada, no una segunda cola.
 * Tira si la fuente no pudo preguntar, o si donde va la carpeta hay otra cosa — el llamador lo dice.
 * Por la nueva se pregunta SIEMPRE, también sin carpeta vieja conocida: en lo publicado un archivo donde va la
 * carpeta se lista vacío sin error, y sólo la pregunta lo distingue de «no hay fichas».
 */
function cardsFolderFor(dir, legacyDir, fuente) {
  if (typeof fuente.exists !== 'function') return dir;
  if (fuente.exists(path.join(dir, 'pending'))) return dir;
  return legacyDir && fuente.exists(path.join(legacyDir, 'pending')) ? legacyDir : dir;
}

/** El motivo de un error, en una línea y recortado: va adentro de una línea del aviso de arranque. */
function reasonOf(e) {
  return String((e && e.message) || e || 'sin motivo').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Las fichas que esperan decisión: `{ cards, error }`.
 *
 * 🔴 «NO ESTÁ» Y «NO PUDE LEER» NO SON LO MISMO. Un `catch` que devolviera la lista vacía
 * haría que una carpeta sin permiso, un archivo donde debería
 * haber una carpeta o una ficha que no se deja leer salieran «✅ no hay nada esperando decisión» — una noche
 * tranquila fabricada por un error de lectura. Por eso:
 *   · la carpeta no está (ENOENT al listar o al preguntar) → sin fichas y sin error: es legítimo;
 *   · cualquier otro error, o una ficha listada que no se pudo leer → `error` con el motivo, y `cards` vacío:
 *     si una no se leyó, no se sabe cuántas esperan, y un número a medias se leería como el total.
 * Nunca tira: el aviso lo dice en una línea y el arranque sigue.
 */
function pendientes(dir, fuente = DISCO, legacyDir = null) {
  let queue;
  let names;
  try {
    queue = path.join(cardsFolderFor(dir, legacyDir, fuente), 'pending');
    names = fuente.listar(queue).filter((f) => f.endsWith('.yaml'));
  } catch (e) {
    return e && e.code === 'ENOENT' ? { cards: [], error: null } : { cards: [], error: reasonOf(e) };
  }
  try {
    const cards = names
      .map((f) => {
        const t = fuente.leer(queue, f);
        const c = (k) => (t.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [, ''])[1].trim();
        return { id: f.replace(/\.yaml$/, ''), paquete: c('paquete'), severidad: c('severidad'), noches: Number(c('noches')) || 1 };
      })
      .sort((a, b) => b.noches - a.noches);
    return { cards, error: null };
  } catch (e) { return { cards: [], error: reasonOf(e) }; }
}

/**
 * La etiqueta de un repo del snapshot — LA MISMA que arma el nocturno (`producto/basename(ruta)`,
 * más la subruta cuando la hay). Se repite acá a propósito y no se requiere del hermano: el banco
 * de controles copia este hook solo a su sandbox y un `require` de un vecino lo rompería (misma
 * razón que `constaEntregado`).
 */
function etiquetaRepo(r) {
  const base = String(r.ruta || '').split('/').filter(Boolean).pop() || r.ruta || '?';
  return `${r.producto}/${base}${r.subruta ? `/${r.subruta}` : ''}`;
}

/**
 * Las deudas declaradas que vencen pronto, o que YA vencieron.
 *
 * 🔴 Sólo cuentan las declaraciones que amparan ALGO (`paquetes > 0`): un archivo vacío —el estado
 * al que se llega cuando la deuda se paga— tiene fecha igual, y avisar por él sería ruido puro.
 * 🔴 Una fecha ilegible se trata como VENCIDA, no se ignora: si no se puede saber hasta cuándo
 * ampara, no ampara. Es la misma regla fail-closed que usa la vejez del snapshot acá arriba.
 */
function deudasQueVencen(snap, ahora) {
  const hoy = Math.floor(ahora / 86400000);
  return (snap.repos || []).flatMap((r) => {
    const d = r && r.declaracion;
    if (!d || !d.existe || !(d.paquetes > 0)) return [];
    const t = Date.parse(`${d.vence}T12:00:00Z`);
    if (isNaN(t)) return [{ repo: etiquetaRepo(r), vence: d.vence || '(sin fecha)', paquetes: d.paquetes, dias: -Infinity }];
    return [{ repo: etiquetaRepo(r), vence: d.vence, paquetes: d.paquetes, dias: Math.floor(t / 86400000) - hoy }];
  }).sort((a, b) => a.dias - b.dias);
}

function evaluar({ outDir, pendingDir, ahora, fuente = DISCO, legacyPendingDir = null }) {
  const files = snapshots(outDir, fuente);
  if (!files.length) return { estado: 'sin-historia' };

  const ultimo = files[files.length - 1];
  const fecha = ultimo.slice('dependencias-'.length, -'.json'.length);
  // Fecha ilegible = vieja. Fail-closed: un NaN compara false y dejaría la foto "fresca" para
  // siempre.
  const t = Date.parse(`${fecha}T12:00:00Z`);
  const dias = isNaN(t) ? Infinity : Math.floor((ahora - t) / 86400000);
  if (isNaN(t) || (ahora - t) > VEJEZ_MS) return { estado: 'detenida', fecha, dias };

  let snap;
  try { snap = JSON.parse(fuente.leer(outDir, ultimo)); }
  catch { return { estado: 'ilegible', fecha }; }
  // 🔴 JSON válido que no es un objeto (`null`, un número, una lista) también es ilegible: sin esta guarda
  // `snap.corrida_completa` tiraba y el catch fail-open del main callaba el aviso ENTERO.
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return { estado: 'ilegible', fecha };

  const queue = pendientes(pendingDir, fuente, legacyPendingDir);
  return {
    estado: 'al-dia',
    fecha,
    dias,
    completa: !!snap.corrida_completa,
    linea_base: !!snap.linea_base,
    no_medidos: (snap.no_medidos || []).map((x) => x.ruta),
    deudas: deudasQueVencen(snap, ahora),
    pendientes: queue.cards,
    // El motivo, si las fichas no se pudieron leer (`null` si se leyeron o si la carpeta no está): con él,
    // `pendientes` vacío NO quiere decir «no hay nada esperando».
    pendingError: queue.error,
    // `undefined` y `null` NO son lo mismo que una sección vacía: la clave ausente quiere decir que
    // la noche no intentó crear pedidos. Se conserva la diferencia hasta `redactar`.
    pedidos: Object.prototype.hasOwnProperty.call(snap, 'pedidos') ? snap.pedidos : undefined,
    // Ídem para el resumen diario: la clave ausente es «el paso no dejó constancia».
    resumen: Object.prototype.hasOwnProperty.call(snap, 'resumen') ? snap.resumen : undefined,
    // Ídem para el cruce «pedido cerrado, vulnerabilidad viva»: ausente = la noche no cruzó.
    cruce: Object.prototype.hasOwnProperty.call(snap, 'cruce') ? snap.cruce : undefined,
  };
}

/**
 * ¿El resumen consta como entregado? 🔴 LA MISMA REGLA que `entregado()` de
 * scripts/nightly/dependencies/daily-summary.js — no se requiere de allá a propósito: el banco copia
 * este hook solo a su sandbox y un `require` de un hermano lo rompería.
 * La suite `daily-summary.test.sh` compara las dos con la misma tabla de casos.
 */
function constaEntregado(r) {
  if (!r || typeof r !== 'object') return false;
  return !!r.entregado_el || (r.message_id !== null && r.message_id !== undefined && !r.motivo);
}

/** La línea del resumen de una cola: `null` si se entregó (la noche buena no suma líneas). */
function lineaResumen(cab, resumen) {
  if (resumen === undefined) return `🔴 ${cab}: la noche corrió pero el resumen NO consta como entregado (el paso del resumen no dejó constancia)`;
  if (constaEntregado(resumen)) return null;
  const motivo = String((resumen && resumen.motivo) || 'sin motivo escrito').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `🔴 ${cab}: el resumen NO se entregó: ${motivo}`;
}

/** El vigilante: sólo su red de entrega. Sus hallazgos se deciden en sus pull requests y en el resumen. */
function evaluarVigilante({ vigOut, ahora, fuente = DISCO }) {
  let files;
  try { files = fuente.listar(vigOut).filter((f) => /^vigilante-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); }
  catch { return { estado: 'sin-historia' }; }
  if (!files.length) return { estado: 'sin-historia' };
  const ultimo = files[files.length - 1];
  const fecha = ultimo.slice('vigilante-'.length, -'.json'.length);
  const t = Date.parse(`${fecha}T12:00:00Z`);
  const dias = isNaN(t) ? Infinity : Math.floor((ahora - t) / 86400000);
  if (isNaN(t) || (ahora - t) > VEJEZ_MS) return { estado: 'detenido', fecha, dias };
  let snap;
  try { snap = JSON.parse(fuente.leer(vigOut, ultimo)); }
  catch { return { estado: 'ilegible', fecha }; }
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return { estado: 'ilegible', fecha };   // ídem: `null` no puede callar todo
  return { estado: 'al-dia', fecha, resumen: Object.prototype.hasOwnProperty.call(snap, 'resumen') ? snap.resumen : undefined };
}

function redactarVigilante(w, o = {}) {
  // todavía no se estrenó en esta máquina — salvo en la que espera los nocturnos (`o.espera`): ahí «no hay foto» se dice
  if (w.estado === 'sin-historia') {
    if (!o.espera) return null;
    // sin foto y con la copia del clon vieja: tampoco se sabe (puede haber una foto que esta copia no trajo)
    const clon = o.clon || 'el clon de mantenimiento';
    return o.copia ? `🟠 vigilante: no sé si corrió — no hay ninguna foto en mi copia ${clon.replace(/^el /, 'del ')} y ${o.copia}`
      : `🔴 vigilante: no hay ninguna foto del vigilante en ${clon}`;
  }
  if (w.estado === 'detenido') {
    // foto vencida y la copia del clon sin traer desde antes: no prueba que no corrió (ver scripts/lib/night-data.js)
    if (o.copia) return `🟠 vigilante: no sé si corrió — su última foto es del ${w.fecha} y ${o.copia}`;
    // Sin números a propósito: la misma regla que dependencias para una foto vieja.
    return `🔴 el vigilante no dejó snapshot desde el ${w.fecha}` +
      (w.dias === Infinity ? ' (fecha ilegible)' : ` (hace ${w.dias} día(s))`) + ': su resumen no puede haberse entregado';
  }
  if (w.estado === 'ilegible') return `🔴 el último snapshot del vigilante (${w.fecha}) está presente pero ILEGIBLE — no se puede saber si su resumen se entregó.`;
  // en la máquina que espera los nocturnos, el vigilante que corrió y entregó también habla: dice sólo lo que este aviso
  // mide (su red de entrega), no que sus productos estén sanos
  return lineaResumen(`vigilante (${w.fecha})`, w.resumen) || (o.espera ? `✅ vigilante (${w.fecha}): corrió y entregó su resumen` : null);
}

/**
 * Las líneas de los pedidos de trabajo del líder.
 *
 * 🔴 LA AUSENCIA DE LA SECCIÓN NO SE LEE COMO «NO HABÍA NADA QUE PEDIR». El guion de pedidos escribe
 * `pedidos` SIEMPRE que pudo hablar con Azure, aunque no haya creado nada; si la clave falta, ese paso
 * no corrió o no pudo intentar nada — y eso se ve idéntico a una noche tranquila si nadie lo dice.
 * Van al FINAL de las demás líneas a propósito: la línea ✅ de «no hay nada esperando decisión» se
 * decide antes y no cambia (el banco la exige).
 */
function lineasPedidos(v) {
  const cab = `pedidos de trabajo (${v.fecha})`;
  if (v.pedidos === undefined) return [`🔴 ${cab}: la noche corrió pero NO intentó crear pedidos — la sección no está en el snapshot. No es «no había nada que pedir».`];
  const p = v.pedidos || {};
  const L = [];
  const fallidos = Array.isArray(p.fallidos) ? p.fallidos : [];
  // Dos cosas distintas, en dos líneas: el pedido que NO SALIÓ (identidad de DevA, duplicados, crear)
  // y el que salió igual pero con un fallo en el camino (no se pudieron leer los administradores o la
  // iteración, no se pudo comentar o anotar). Sumarlos en «no se pudieron crear» mentiría sobre los
  // segundos; callarlos escondería justo el permiso de leer grupos, que nadie verificó todavía.
  // 🔴 Se cuentan PEDIDOS (pares ficha+proyecto), no entradas: un par con la lectura de administradores
  // fallida Y el `crear` fallido no existe y no puede figurar también como «creado con fallos»; y un
  // pedido con dos fallos posteriores es uno, no dos.
  // El paso que resuelve la identidad del líder se llama `lead-identity`; los registros anteriores lo llaman
  // `identidad-` más un nombre de persona, y se siguen reconociendo por el prefijo mientras
  // esos registros existan.
  const PASOS_DE_CREACION = ['lead-identity', 'duplicados', 'crear'];
  const esDeCreacion = (paso) => PASOS_DE_CREACION.includes(paso) || /^identidad-/.test(String(paso || ''));
  const par = (x) => `${x && x.ficha}|${x && x.proyecto}`;
  const validos = fallidos.filter((x) => x && typeof x === 'object');
  const deCreacion = validos.filter((x) => esDeCreacion(x.paso));
  const noSalieron = new Set(deCreacion.map(par));
  const posteriores = validos.filter((x) => !esDeCreacion(x.paso) && !noSalieron.has(par(x)));
  const conFallos = new Set(posteriores.map(par));
  // el paso viejo lleva el nombre de una persona: se muestra con el nombre nuevo
  const pasoVisible = (paso) => (/^identidad-/.test(String(paso || '')) ? 'lead-identity' : paso);
  if (noSalieron.size) L.push(`🟠 ${cab}: ${noSalieron.size} pedido(s) no se pudieron crear — ${pasoVisible(deCreacion[0].paso)}: ${deCreacion[0].motivo}`);
  if (conFallos.size) L.push(`🟠 ${cab}: ${conFallos.size} pedido(s) con fallos que no impidieron crearlos — ${posteriores[0].paso}: ${posteriores[0].motivo}`);
  if (p.simulado) L.push(`🟡 ${cab}: pedidos en modo simulado: ${(p.creados || []).length} habrían salido (no se creó nada; se enciende con azure.pedidos_activos).`);
  return L;
}

/**
 * Las líneas del cruce «pedido cerrado, vulnerabilidad viva».
 *
 * 🔴 LA AUSENCIA DE LA CLAVE NO SE LEE COMO «TODO COINCIDE». El nocturno escribe `cruce` SIEMPRE; si
 * falta, la noche corrió con un guion que no cruza (o se rompió antes), y eso tiene que decirse. Y un
 * pedido no leído no coincide con nada: se cobra aparte. La noche en orden no suma una sola línea.
 */
function lineasCruce(v) {
  const cab = `pedidos de trabajo (${v.fecha})`;
  if (v.cruce === undefined) return [`🔴 ${cab}: la noche corrió pero NO cruzó el estado de los pedidos con la medición — no se puede decir que coincidan.`];
  // 🔴 Presente pero no un objeto (`null`, una lista, un texto): ILEGIBLE, no «todo coincide» (misma clase
  // que el snapshot `null`, que callaría el aviso).
  if (!v.cruce || typeof v.cruce !== 'object' || Array.isArray(v.cruce)) {
    return [`🔴 ${cab}: el cruce del estado de los pedidos está ILEGIBLE en el snapshot — no se puede decir que coincidan.`];
  }
  const c = v.cruce;
  const lista = (k) => (Array.isArray(c[k]) ? c[k].filter((x) => x && typeof x === 'object') : []);
  const L = [];
  if (c.consultado === false) L.push(`🟠 ${cab}: no pudo leer el estado de los pedidos (${String(c.motivo || 'sin motivo escrito').replace(/\s+/g, ' ').slice(0, 200)}).`);
  const cv = lista('cerrados_vivos');
  if (cv.length) {
    L.push(`🔴 ${cab}: ${cv.length} pedido(s) cerrado(s) con la vulnerabilidad viva — ${cv.slice(0, TOPE_A_MOSTRAR).map((x) => `${x.ficha} en ${x.proyecto}`).join(' · ')}` +
      (cv.length > TOPE_A_MOSTRAR ? ` (+${cv.length - TOPE_A_MOSTRAR} más)` : ''));
  }
  const nl = lista('no_leidos');
  if (nl.length && c.consultado !== false) L.push(`🟠 ${cab}: ${nl.length} pedido(s) no leído(s): no se puede decir que coincidan — ${nl[0].ficha} en ${nl[0].proyecto}: ${String(nl[0].motivo || '').slice(0, 160)}`);
  else if (nl.length) L.push(`🟠 ${cab}: ${nl.length} pedido(s) no leído(s): no se puede decir que coincidan.`);
  const hu = lista('huerfanos');
  if (hu.length) L.push(`🟠 ${cab}: ${hu.length} Bug(s) del arnés que ninguna ficha nombra — ${hu.slice(0, TOPE_A_MOSTRAR).map((x) => `${x.id} en ${x.proyecto}`).join(' · ')}`);
  // «No pude buscar» no es «no hay Bugs sueltos»: se dice, con el primer proyecto.
  const nc = lista('huerfanos_no_consultados');
  if (nc.length) L.push(`🟠 ${cab}: no se pudo buscar Bugs sueltos en ${nc.length} proyecto(s) — ${nc[0].proyecto}: ${String(nc[0].motivo || '').slice(0, 160)}`);
  return L;
}

function redactar(v, o = {}) {
  const L = [];
  // todavía no se estrenó: no hay nada que cobrar — salvo en la máquina que espera los nocturnos (`o.espera`), donde
  // una pieza que nunca dejó foto y una sana no pueden dar el mismo silencio
  if (v.estado === 'sin-historia') {
    if (!o.espera) return null;
    // sin foto y con la copia del clon vieja: tampoco se sabe (puede haber una foto que esta copia no trajo)
    const clon = o.clon || 'el clon de mantenimiento';
    return o.copia ? `🟠 dependencias: no sé si la revisión nocturna corrió — no hay ninguna foto en mi copia ${clon.replace(/^el /, 'del ')} y ${o.copia}`
      : `🔴 dependencias: no hay ninguna foto de la revisión nocturna en ${clon}`;
  }

  if (v.estado === 'detenida') {
    if (o.copia) return `🟠 dependencias: no sé si la revisión nocturna corrió — su última foto es del ${v.fecha} y ${o.copia}`;
    L.push(`🔴 la revisión nocturna de dependencias NO ESTÁ CORRIENDO — su última mirada es del ${v.fecha}` +
           (v.dias === Infinity ? ' (fecha ilegible)' : `, hace ${v.dias} día(s)`));
    L.push('   No se muestran sus números a propósito: una foto vieja tranquiliza o hace perseguir');
    L.push('   cosas ya arregladas. Revisar el pipeline "Revisión nocturna de dependencias" en Azure DevOps.');
    return L.join('\n');
  }
  if (v.estado === 'ilegible') {
    L.push(`🔴 el último snapshot de dependencias (${v.fecha}) está presente pero ILEGIBLE — la noche no se puede leer.`);
    return L.join('\n');
  }

  const cab = `dependencias (${v.fecha})`;
  const noEntregado = lineaResumen(cab, v.resumen);
  if (v.no_medidos.length) L.push(`⚠️ ${cab}: ${v.no_medidos.length} repo(s) NO MEDIDO(s) — ${v.no_medidos.join(', ')}. No medido ≠ limpio.`);
  if (!v.completa && !v.no_medidos.length) L.push(`⚠️ ${cab}: la ejecución quedó incompleta.`);

  // 🔴 Las deudas que vencen van ANTES de los hallazgos del día: una deuda vencida no es un aviso
  // nuevo que alguien pueda decidir, es un repo que ya empezó a frenarse solo. Las vencidas y las
  // que están por vencer se dicen por separado porque piden cosas distintas: una hay que
  // destrabarla hoy, la otra da tiempo para pagarla o para decidir renovarla.
  const vencidas = (v.deudas || []).filter((d) => d.dias < 0);
  const porVencer = (v.deudas || []).filter((d) => d.dias >= 0 && d.dias <= AVISO_DEUDA_DIAS);
  const comoSale = (d) => `${d.repo} (${d.paquetes}, ${d.vence})`;
  if (vencidas.length) {
    L.push(`🔴 ${cab}: ${vencidas.length} deuda(s) declarada(s) YA VENCIDA(s) — ${vencidas.slice(0, TOPE_A_MOSTRAR).map(comoSale).join(' · ')}` +
      (vencidas.length > TOPE_A_MOSTRAR ? ` (+${vencidas.length - TOPE_A_MOSTRAR} más)` : ''));
    L.push('   Vencida = ya no ampara: esos repos frenan sus propios pull requests hasta que se pague o se renueve.');
  }
  if (porVencer.length) {
    L.push(`🟠 ${cab}: ${porVencer.length} deuda(s) declarada(s) por vencer — ${porVencer.slice(0, TOPE_A_MOSTRAR).map((d) => `${comoSale(d)}, en ${d.dias} día(s)`).join(' · ')}` +
      (porVencer.length > TOPE_A_MOSTRAR ? ` (+${porVencer.length - TOPE_A_MOSTRAR} más)` : ''));
    L.push('   Cuando vence, el repo empieza a frenar solo. Se paga, o se renueva la fecha a conciencia.');
  }

  if (v.pendingError) {
    // 🔴 Ni un número ni el ✅: no se pudo leer, y eso no es «no hay nada esperando» (ver `pendientes`).
    L.push(`🔴 ${cab}: no pude leer las fichas que esperan decisión (${v.pendingError}) — no se sabe cuántos hallazgos esperan.`);
  } else if (v.pendientes.length) {
    const top = v.pendientes.slice(0, TOPE_A_MOSTRAR);
    L.push(`🟠 ${cab}: ${v.pendientes.length} hallazgo(s) esperando decisión — ${top.map((p) => `${p.paquete} [${p.severidad}], ${p.noches} noche(s)`).join(' · ')}` +
           (v.pendientes.length > TOPE_A_MOSTRAR ? ` (+${v.pendientes.length - TOPE_A_MOSTRAR} más)` : ''));
    L.push('   Se deciden en su pull request.');
  } else if (!L.length && !noEntregado) {
    // Habla igual. Es la única forma de que "corrió y no había nada" no se confunda con "no corrió".
    // 🔴 Pero NO al lado de un resumen que no llegó: el lector se queda con el verde.
    L.push(`✅ ${cab}: miró${v.linea_base ? ' (línea base)' : ''} y no hay nada esperando decisión.`);
  }
  if (noEntregado) L.push(noEntregado);
  else if (L.length) L[0] += ' · resumen entregado (Telegram)';   // la noche buena no suma una línea
  L.push(...lineasPedidos(v));
  L.push(...lineasCruce(v));
  return L.join('\n');
}

function main() {
  if (process.env.TYCON_DEPS_NOTICE === '0' || process.env.TYCON_EVAL_SANDBOX === '1') return 0;
  // de qué árbol se leen los .dashboard del nocturno: la variable manda; si no, lo decide scripts/lib/night-data.js —en un
  // clon, éste; en una versión bajada, el clon del repo de operaciones que la máquina declara (`paths.operations`):
  // dependencias, vigilante y el resumen diario guardan ahí (leídos del clon de
  // mantenimiento, dirían la noche anterior), o ninguno—. Sin esa biblioteca al lado, se usa
  // (tycon-home.js); si este archivo viaja suelto, este árbol.
  const own = path.resolve(__dirname, '..', '..');
  const homeLib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
  const nightLib = path.join(__dirname, '..', 'lib', 'night-data.js');
  let N = null;
  // 🔴 si la biblioteca ESTÁ y no carga, se dice: tragarlo dejaría este aviso mudo justo con el árbol roto
  try { N = fs.existsSync(nightLib) ? require(nightLib) : null; } catch (e) {
    console.log(`🔴 avisos de los nocturnos: no pude cargar scripts/lib/night-data.js (${unaLinea((e && e.message) || e, 160)}) — no sé de qué clon leer la noche`);
    return 0;
  }
  const noche = process.env.TYCON_DEPS_REPO ? { dir: process.env.TYCON_DEPS_REPO, source: 'own', problem: null }
    : N ? (typeof N.resolveOperations === 'function' ? N.resolveOperations(own) : N.resolve(own))
      : { dir: fs.existsSync(homeLib) ? require(homeLib).maintainedDir(require('os').homedir(), own) : own, source: 'own', problem: null };
  // el clon de mantenimiento (de donde leen banco, suites y examen) o el de operaciones (de donde lee este aviso) no está
  // declarado, o no sirve: se dice UNA vez por arranque, en UNA línea, y la dice este aviso
  const mant = N && typeof N.resolveOperations === 'function' ? N.resolve(own) : { problem: null };
  if (N && (mant.problem || noche.problem)) {
    console.log(typeof N.resolveOperations === 'function' ? N.problemLine(mant.problem, noche.problem) : N.problemLine(noche.problem));
    if (noche.problem) return 0;
  }
  const raiz = noche.dir;
  if (!raiz) return 0;
  const outDir = process.env.TYCON_DEPS_OUT || path.join(raiz, '.dashboard', 'dependencias');
  const pendingDir = process.env.TYCON_DEPS_PENDING || path.join(raiz, ...CARDS_FOLDER);
  // La carpeta de antes de la mudanza sólo respalda a la carpeta por defecto: una pasada por variable es una
  // decisión explícita de leer ESA, y no se le busca reemplazo.
  const legacy = process.env.TYCON_DEPS_PENDING ? null : legacyCardsFolder();
  const legacyPendingDir = legacy ? path.join(raiz, ...legacy) : null;
  const vigOutVar = leerVariable('TYCON_WATCHER_OUT');
  const vigOut = vigOutVar || path.join(raiz, '.dashboard', 'vigilante');
  const ahoraVar = leerVariable('TYCON_DEPS_NOW');
  const ahora = ahoraVar ? Date.parse(ahoraVar) : Date.now();
  // Carpetas pasadas por variable = una decisión explícita de leer ESE disco (banco, suites): sin nota.
  const explicito = ['TYCON_DEPS_OUT', 'TYCON_DEPS_PENDING'].some((k) => process.env[k]) || !!vigOutVar;
  const nota = (motivo) => `ℹ️ dependencias y vigilante: leído del disco, no de lo publicado (${motivo}) — si esta copia está en otra rama o atrasada, la foto puede ser vieja.`;
  // la máquina que declara su clon de operaciones ESPERA los nocturnos: ahí cada cola dice siempre una línea. Y con
  // la foto vencida (o sin ninguna) mira de cuándo es su copia del clon: si no se trae desde antes, no prueba que el
  // nocturno no corrió.
  const espera = (noche.source === 'operations' || noche.source === 'maintainers') && !explicito;
  const clon = N && typeof N.cloneName === 'function' ? N.cloneName(noche.source) : 'el clon de mantenimiento';
  // Cada cola por separado: un error inesperado en una no puede callar la otra. En la máquina que espera los nocturnos
  // tampoco la calla a ella: una cola sin línea es una pieza rota, así que el error se dice.
  const parte = (cola, fn) => {
    try { return fn(); } catch (e) {
      return espera ? `🔴 ${cola}: no pude evaluar la noche (${unaLinea((e && e.message) || e, 160)})` : null;
    }
  };
  let copiaVieja = false;
  // `vence`: el instante (ms) en que la foto dejó de valer; sin foto, hace cuánto tendría que haber una
  const copia = (vence) => {
    if (!espera || isNaN(vence)) return null;
    const texto = N.copyAfter(raiz, vence, clon);
    if (texto) copiaVieja = true;
    return texto;
  };
  const copiaDe = (estado, fecha, detenida) => (estado === detenida ? copia(Date.parse(`${fecha}T12:00:00Z`) + VEJEZ_MS)
    : estado === 'sin-historia' ? copia(ahora - VEJEZ_MS) : null);
  const todo = (fuente) => [
    parte('dependencias', () => { const v = evaluar({ outDir, pendingDir, ahora, fuente, legacyPendingDir }); return redactar(v, { espera, clon, copia: copiaDe(v.estado, v.fecha, 'detenida') }); }),
    parte('vigilante', () => { const w = evaluarVigilante({ vigOut, ahora, fuente }); return redactarVigilante(w, { espera, clon, copia: copiaDe(w.estado, w.fecha, 'detenido') }); }),
  ].filter(Boolean);
  let partes;
  let motivo = null;
  if (explicito) partes = todo(DISCO);
  else {
    const pub = (() => { try { return fuentePublicada(raiz, process.env.TYCON_DEPS_GIT || 'git'); } catch (e) { return { motivo: `no pude preguntarle a git (${e.message})` }; } })();
    if (pub.fuente) {
      partes = todo(pub.fuente);
      // lo evaluado con un git a medias no se muestra (ni lo que esa pasada anotó de la copia)
      if (pub.fallo()) { motivo = pub.fallo(); copiaVieja = false; partes = todo(DISCO); }
    } else { motivo = pub.motivo; partes = todo(DISCO); }
  }
  if (partes.length && motivo) partes.push(nota(motivo));
  // Cómo traerla: una vez por arranque, y la dice este aviso. No sólo cuando una de SUS dos colas dijo «no sé»: el banco,
  // las suites y el tablero vencen un día antes (2 días contra 3), y en esa ventana lo dirían ellos sin el comando. Son
  // hasta dos clones —el de operaciones (este aviso y el tablero) y el de mantenimiento (banco y suites)—: un renglón por
  // cada uno que esté viejo, y uno solo si son el mismo.
  if (partes.length && espera) {
    const viejos = [];
    if (copiaVieja || N.copyOlderThan(raiz, N.SHORTEST_PHOTO_LIFE_MS, ahora)) viejos.push(raiz);
    if (mant.dir && mant.source === 'maintainers' && N.copyOlderThan(mant.dir, N.SHORTEST_PHOTO_LIFE_MS, ahora)) viejos.push(mant.dir);
    for (const d of [...new Set(viejos)]) partes.push(N.fetchHint(d));
  }
  // Lo que sale viene en parte de fotos y fichas publicadas (nombres de paquetes, de repos, motivos): va a la pantalla
  // del arranque sin caracteres de control. Los saltos de línea entre renglones son del aviso y se conservan.
  if (partes.length) console.log(partes.join('\n').split('\n').map((l) => l.replace(CONTROL, ' ')).join('\n'));
  return 0;
}

// 🔴 `process.exitCode`, NO `process.exit()`: las escrituras a una tubería son asincrónicas y
// `process.exit()` se lleva puesto lo que falte escribir. Acá el aviso es corto, pero la forma es
// la misma que corta un informe largo en 8192 bytes.
// El fail-open se conserva tal cual: un aviso roto no puede impedir arrancar una sesión.
if (require.main === module) {
  try { process.exitCode = main(); }
  catch { process.exitCode = 0; }
}
module.exports = { evaluar, redactar, fuentePublicada, lineasPedidos, lineasCruce, constaEntregado, lineaResumen, evaluarVigilante, redactarVigilante, legacyCardsFolder, VEJEZ_MS };
