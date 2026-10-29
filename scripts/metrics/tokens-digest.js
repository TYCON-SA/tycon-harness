#!/usr/bin/env node
/**
 * tokens-digest.js — rescata de cada corrida del pipeline lo que hoy se borra al mes.
 *
 * QUÉ RESCATA, y por qué importa
 * ------------------------------
 * El archivador del pipeline (`marker.js cmdClear`) ya guarda por corrida los tiempos de cada paso,
 * los frenos y cuántos agentes lanzó. Lo que NO guarda es el CONSUMO ni el HILO: eso vive sólo en la
 * conversación de Claude Code, que se borra a los 30 días. Medido sobre 215 corridas archivadas:
 * sólo 67 tienen su conversación viva, y cada semana se pierden las de esa semana.
 *
 * Tres cosas, entonces:
 *   1. El RESUMEN de consumo (tokens por modelo y por paso) → adentro del volcado, bajo `consumo`. Con la misma ventana
 *      que el hilo (`linesInWindow`): sólo el tramo de ESTA corrida, también para `por_paso` y `costo`.
 *   2. El HILO de la conversación, comprimido → `<volcado sin .json>.hilo.jsonl.gz`, al lado. Sin adjuntos, salvo
 *      el aviso de un hook que falló o se pasó de tiempo, reducido a nombre, evento, salida, categoría y el texto
 *      del error saneado y recortado (`reducirErrorDeHook`). Sólo el tramo de ESTA corrida (`ventanaDelHilo`): una
 *      sesión larga con varias corridas guardaba la sesión entera en cada una, y cada corrida la volvía a subir.
 *   3. El MENSAJE REAL del error de cada freno en rojo → `gates[i].mensaje`.
 *
 * DE QUÉ HERRAMIENTA, Y CUÁNTO COSTÓ
 * ----------------------------------
 * Las conversaciones de Claude Code se buscan en `$CLAUDE_CONFIG_DIR/projects` (si la variable está) y en
 * `~/.claude/projects`. Una corrida de Codex se lee de su propia sesión (`codex-usage.js`, en `$CODEX_HOME/sessions`
 * o `~/.codex/sessions`), con los mismos tipos de token que Claude. El proveedor (`modelProvider()`) se anota una vez
 * en `consumo.proveedor`. El costo en plata (`consumo.costo`) sale sólo de los precios declarados en
 * `model-prices.json`, por el nombre exacto del modelo y la franja horaria de cada respuesta. Sin precio, con la fecha
 * de revisión vencida, o con un tipo de token sin precio publicado, sale `no_medido` con su motivo, nunca un cero. Una
 * corrida de Claude, que no tiene precios en la tabla, no lleva la clave.
 *
 * 🔴 DE DÓNDE SALE EL MENSAJE. Medido sobre los volcados locales y del buzón, buscarlo en la
 * conversación no alcanza: en 43 frenos en rojo
 * el comando registrado NO aparece en la conversación —lo lanza un script (`test-gate.sh` →
 * `run-suites-json.js`, `runtime-matrix.js`)— y 26 corrieron en segundo plano, donde la
 * conversación sólo dice «Command running in background» y la salida va a un archivo que se borra.
 * Buscarlo en la conversación no puede funcionar. Por eso `marker.js run-check` guarda en su línea de
 * `gates.log` la COLA de la salida, ya saneada con `colaDeSalida` de este archivo (campo `cola`, sólo
 * en rojo), y acá se usa primero esa cola. El rescate por conversación queda para las corridas
 * anteriores, que no la tienen.
 *
 * DÓNDE VIVE, Y ADÓNDE VIAJA
 * --------------------------
 * Todo va a `~/.claude/.tycon-pipeline/timing-history/`, fuera de todo repositorio: el hilo contiene
 * prompts, rutas del disco y código de cliente, y no va a ningún repo. La copia del volcado que `marker.js`
 * deja en `.advisors/pipeline-runs/` la ignora git (verificado: `.gitignore:14`). Desde ahí SÍ viaja al
 * buzón de corridas de la organización: lo sube `upload-runs.js` (el volcado, el hilo y el cambio de git), a un contenedor que leen sólo quienes tienen el rol de lectura, y se
 * guarda entero y sin vencimiento.
 *
 * 🔴 CUATRO COSAS QUE SE MIDIERON ANTES DE ESCRIBIRLAS, no se supusieron:
 *
 *   (a) El mismo `usage` se repite en cada línea de una respuesta. Claude Code parte una respuesta
 *       en 1..9 líneas `type=assistant` (una por bloque: pensamiento, texto, cada herramienta) y
 *       TODAS repiten el mismo `message.id` y el mismo `usage`. Sumar por línea da 3,22× en la
 *       una corrida medida (579 líneas → 251 respuestas). Se deduplica por `message.id`.
 *
 *   (b) La marca de un freno es la hora de FIN del comando, no la de inicio. `marker.js cmdRunCheck`
 *       toma `t0`, ejecuta, y recién entonces escribe la línea (por eso trae `durationMs`). O sea
 *       que la invocación está ANTES de la marca: medido sobre los 185 frenos en rojo con la
 *       conversación viva, 36 de 37 emparejamientos caen antes (mediana −0,8 s, mínimo −31 s) y uno
 *       solo después (+7,3 s). Mirar hacia adelante rescata 22 y en 21 de esos 22 agarra la
 *       RE-EJECUCIÓN posterior — la que suele estar en verde. De ahí la ventana [−2 min, +15 s].
 *
 *   (c) La igualdad exacta de comando rescata CERO. El registro guarda el comando ya resuelto
 *       (`node /Users/…/marker.js …`); la conversación guarda el de la terminal, con un `cd`
 *       adelante, salto de línea y `~` sin expandir. Se empareja por contención DIRIGIDA (el del
 *       registro adentro del de la conversación) — que no es «por cercanía temática», lo único
 *       prohibido: eso daría 169 casos de basura.
 *
 *   (d) La conversación de una corrida se ubica por `sessionId` buscando en TODAS las carpetas de
 *       `~/.claude/projects/`. El `repoPath` del volcado no la deduce: puede ser un clon del scratchpad
 *       mientras la transcripción está bajo la carpeta del cwd real.
 *
 * REGLA CARDINAL: nunca un cero donde hubo ausencia. Si la conversación no está, `consumo` sale con
 * `estado` y `motivo` en castellano y SIN la clave `tokens` — un cero se lee como «no consumió nada».
 * Y «no la encontré» tiene dos causas que no se confunden: `projects/` ilegible es `no_medido`;
 * ausente con `projects/` legible es `borrada`.
 *
 * USO
 *   node tokens-digest.js --run <volcado.json> [--projects-dir D] [--json]
 *   node tokens-digest.js --pending [--history-dir D] [--projects-dir D] [--budget-ms N] [--json]
 *   node tokens-digest.js --all     [--history-dir D] [--projects-dir D] [--budget-ms N] [--json]
 *   (--runs-dir D: el registro de lanzamientos que usa el medidor de revisores encadenado)
 *
 * Salidas: 0 procesó (aunque alguna corrida quede `no_medido` — eso también es medir) · 2 no pudo
 * arrancar (argumentos mal, volcado ilegible). Nunca lanza: quien lo llama archiva igual.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const zlib = require('zlib');
const { readEnv } = require('../lib/legacy-names.js');

// ── Constantes, con su porqué ────────────────────────────────────────────────────────────────────

// Ventana del rescate del error. ASIMÉTRICA y hacia atrás — ver (b) en la cabecera.
const VENTANA_ATRAS_MS = 120000;
const VENTANA_ADELANTE_MS = 15000;
// Largo del mensaje rescatado. Es texto crudo de una herramienta: alcanza para entender qué falló.
const LARGO_MENSAJE = 700;
// Lo que NO es un mensaje del hilo. Medido sobre una transcripción real de 4,1 MB: `attachment`
// 381 KB, `file-history-snapshot` 60 KB, el resto son metadatos de la herramienta. Los `api-request*` son la copia de
// cada pedido a la API (el `-blob` trae el mensaje entero otra vez): con ellos cada comando queda tres veces en el hilo.
const TIPOS_DESCARTADOS = new Set([
  'attachment', 'file-history-snapshot', 'file-history-delta',
  'queue-operation', 'bridge-session', 'atis-latch', 'last-prompt', 'ai-title',
  'api-request', 'api-request-blob', 'api-request-shape', 'mode', 'cost-state',
]);
// Los únicos adjuntos que viajan: el aviso de un hook que falló sin frenar y el de uno que se pasó de tiempo (Claude
// Code lo anota como `hook_cancelled` con `timedOut`). Sin ellos, la revisión nocturna de las ejecuciones no ve un
// freno muerto (Node viejo en el PATH, un guion borrado por la autoactualización). Viajan reducidos: del `stderr` sale
// una categoría de esta lista, en orden, y su texto saneado y recortado: lo leen sólo quienes administran el buzón,
// como la conversación. En las sesiones de una máquina medida hay cientos de `carga` y de `No such file or
// directory`, y ningún «timed out» en un error.
const CATEGORIAS_HOOK = [
  ['node-viejo', /SyntaxError: Unexpected token/],
  ['carga', /Cannot find module|cjs\/loader/],
  // `(^|[\s/])node: No such…` cubre `env: node:` y el Node propio del arnés por su ruta (`…/bin/node: No such…`)
  ['node-ausente', /node: command not found|command not found: node|(^|[\s/])node: No such file or directory|is not recognized/],
  ['ruta-ausente', /No such file or directory/],
];
// Un nombre de hook o de evento más largo, o con saltos de línea, no es un nombre: no viaja.
const LARGO_NOMBRE_HOOK = 80;
// El texto del error que viaja: alcanza para saber qué falló sin llevar un stack entero.
const LARGO_TEXTO_HOOK = 300;
// Estados de un freno que cuentan como «quedó en rojo». `red:exit=N` es el formato real del registro.
const PREFIJOS_FALLO = ['red', 'fail', 'error', 'rojo'];
const FRENOS = new Set(['blocked', 'undeclared', 'missing', 'stale', 'rejected', 'denied']);

// ── Funciones puras (lo que los casos ejercitan) ─────────────────────────────────────────────────

function esRojo(status) {
  const s = String(status || '');
  if (!s) return false;
  return PREFIJOS_FALLO.some((p) => s.startsWith(p)) || FRENOS.has(s);
}

function ms(iso) {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? t : null;
}

function normalizar(cmd) {
  return String(cmd || '').split(/\s+/).filter(Boolean).join(' ');
}

/**
 * ¿Este nombre de variable / clave / encabezado guarda una credencial?
 *
 * Se parte el nombre en COMPONENTES —por `_`, por `-` y por cambio de minúscula a mayúscula— y se
 * juzga cada uno. Así `PASSWORD`, `dbPassword`, `X-Api-Key`, `access_token` y `client_secret` son
 * credenciales, y `PATH` (no es `PAT`), `primary_key`, `keyId` y `TaskCanceledException` no lo son.
 * `key` sola es demasiado genérica: cuenta sólo acompañada de un componente que la vuelva secreta
 * (`api`, `secret`, `access`, `private`, `auth`, `client`, `ssh`, `license`, `encryption`) o siendo
 * el nombre entero. `token` sí cuenta siempre, aunque tape un `CancellationToken:` de más — un
 * `authToken` que pasa es peor que un nombre de tipo tapado.
 */
const CREDENCIAL_FUERTE = new Set(['token', 'secret', 'password', 'passwd', 'pat', 'apikey', 'credential', 'credentials', 'bearer', 'authorization']);
const CREDENCIAL_CON_KEY = new Set(['api', 'secret', 'access', 'private', 'auth', 'client', 'ssh', 'license', 'encryption', 'signing']);
function esNombreDeCredencial(nombre) {
  const partes = String(nombre || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-]+/)
    .map((x) => x.toLowerCase())
    .filter(Boolean);
  if (partes.some((p) => CREDENCIAL_FUERTE.has(p))) return true;
  if (partes.includes('key')) return partes.length === 1 || partes.some((p) => CREDENCIAL_CON_KEY.has(p));
  return false;
}

/**
 * Tapa el VALOR de todo `nombre=valor` / `nombre: valor` / `"nombre":"valor"` cuyo nombre sea de
 * credencial. Es un bucle manual y no un `.replace` con callback a propósito: con un regex que capture nombre Y valor, en `user=admin&password=secreto`
 * el valor de `user=` —que no es credencial— se tragaría `admin&password=secreto` entero, y
 * `password=` no se miraría nunca. Acá lo inocente NO se consume: el escaneo sigue justo después
 * del `=` y encuentra al siguiente.
 */
function taparCredencialesConNombre(txt) {
  const re = /(["']?)([A-Za-z][A-Za-z0-9_\-]*)\1(\s*[=:]\s*)/g;
  let out = '';
  let pos = 0;
  let m;
  while ((m = re.exec(txt)) !== null) {
    if (!esNombreDeCredencial(m[2])) continue;
    const ini = m.index + m[0].length;
    const q = txt[ini];
    let fin;
    let tapado;
    if (q === '"' || q === "'") {
      const cierre = txt.indexOf(q, ini + 1);
      fin = cierre < 0 ? txt.length : cierre + 1;
      tapado = `${q}<oculto>${q}`;
    } else {
      // El valor termina en espacio, `&` o comilla: en un cuerpo o una consulta el `&` separa
      // parámetros (un `&` DENTRO de una contraseña viaja codificado, `%26`), y tragárselo borraría
      // los parámetros inocentes que siguen (`&page=2`).
      const r = /[^\s&"']+/y;
      r.lastIndex = ini;
      fin = r.exec(txt) ? r.lastIndex : ini;
      tapado = '<oculto>';
    }
    out += txt.slice(pos, m.index) + m[0] + tapado;
    pos = fin;
    re.lastIndex = fin;
  }
  return out + txt.slice(pos);
}

/**
 * Saca del texto lo que identifica a una máquina o a una sesión. El mensaje rescatado es lo ÚNICO
 * que esta pieza publica que no nace de una lista blanca, así que la verificación (T13) va sobre lo
 * rescatado, no sobre lo dibujado.
 */
function sanear(txt, home) {
  const casa = home || os.homedir();
  const tmp = os.tmpdir();
  return String(txt || '')
    // 🔴 EL ORDEN IMPORTA. Si el home se colapsara a `~` en el PRIMER paso, la regla que borra rutas
    // absolutas no reconocería lo que queda: `/Users/<dev>/Proyectos/Cliente/a.cs` se publicaría como
    // `~/Proyectos/Cliente/a.cs` — o sea, sobreviviría exactamente el tramo que nombra al cliente.
    // Las rutas se borran ENTERAS primero; el colapso del home queda de respaldo, al final.
    // Credenciales SIN nombre de variable adelante: `Bearer x`, `Basic x`, `https://user:pass@host`.
    .replace(/\b(Bearer|Basic)\s+[^\s'"]+/gi, '$1 <oculto>')
    .replace(/(\bhttps?:\/\/)[^\s'"\/@]+:[^\s'"\/@]+@/gi, '$1<oculto>@')
    // Credenciales con nombre — `PASSWORD=`, `AZURE_DEVOPS_PAT=`, `dbPassword=`, `X-Api-Key:`,
    // `"access_token":"…"`. La decisión la toma `esNombreDeCredencial` por COMPONENTES del nombre
    // (partido por `_`, `-` y cambio de mayúscula), no un regex sobre la subcadena: tres vueltas de
    // revisores mostraron que cada regex tapaba de menos (`PASSWORD=` pelado, camelCase, JSON de un
    // curl) o de más (`PATH=` por `PAT`, `primary_key` por `key`). Ver la función y T26/T27/T31.
    .split('\u0000').map(taparCredencialesConNombre).join('\u0000')
    // Rutas, ENTERAS. Un espacio adentro cuenta como parte de la ruta si hasta la PRÓXIMA barra hay
    // puros caracteres de nombre de carpeta (`/Users/x/Cliente Grande SA/a.ts`): mejor tapar de más
    // que dejar el nombre del cliente a medias — pero sin tragarse el resto del renglón: una regla
    // que sólo mire «¿hay una barra más adelante?» dejaría que un `PATH=/usr/bin` al final se llevara puesto
    // todo lo del medio, credenciales y texto legítimo del error incluidos.
    .replace(/\/private\/tmp\/(?:[^\s'"]|\s(?=[\w .()-]*\/))*/g, '<carpeta temporal>')
    .replace(/\/tmp\/(?:[^\s'"]|\s(?=[\w .()-]*\/))*/g, '<carpeta temporal>')
    .replace(/\/(?:private\/)?var\/folders\/(?:[^\s'"]|\s(?=[\w .()-]*\/))*/g, '<carpeta temporal>')
    .split(tmp).join('<carpeta temporal>')
    .replace(/\/(?:Users|home)\/(?:[^\s'"]|\s(?=[\w .()-]*\/))*/g, '<ruta>')
    .replace(/[A-Za-z]:\\(?:[^\s'"]|\s(?=[\w .()-]*\\))*/g, '<ruta>')
    .split(casa).join('<ruta>')
    .replace(/~\/(?:[^\s'"]|\s(?=[\w .()-]*\/))*/g, '<ruta>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<correo>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<sesión>');
}

/**
 * La cola de una salida cruda, lista para guardar: sin códigos de color, saneada y con el mismo tope
 * de largo que el rescate. La usa también `marker.js run-check` (agent-skills) para escribir el campo
 * `cola` de `gates.log`: una sola forma de recortar y de sanear, no dos que se separan.
 * Se guarda la COLA y no la cabeza: los veredictos y los errores viven al final (ver mensajesDeError).
 */
function colaDeSalida(crudo, home) {
  const sinColor = String(crudo || '').replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '');
  const limpio = sanear(sinColor, home).trim();
  if (!limpio) return '';
  return limpio.length > LARGO_MENSAJE ? `…${limpio.slice(-LARGO_MENSAJE)}` : limpio;
}

/**
 * Los mensajes que YA vienen en el registro: la `cola` que `marker.js run-check` guardó al dar rojo.
 * Se vuelve a pasar por `colaDeSalida`: si `sanear` mejoró después de escrita la línea, la versión
 * nueva es la que se publica. Devuelve un Map de índice del gate → mensaje.
 */
function mensajesDeSalida(gates, home) {
  const out = new Map();
  for (let i = 0; i < (gates || []).length; i += 1) {
    const g = gates[i];
    if (!g || typeof g.cola !== 'string' || !esRojo(g.status)) continue;
    const texto = colaDeSalida(g.cola, home);
    if (texto) out.set(i, texto);
  }
  return out;
}

/**
 * Las marcas de `stepTimings` → tramos ordenados por hora.
 *
 * 🔴 Dos pasos cuyas marcas están INVERTIDAS (el 6 cerrado antes que el 5) se publican FUSIONADOS en
 * un balde `5+6`, con el consumo entre la marca anterior y la mayor de las dos. Pasa de verdad: 20
 * de 230 volcados medidos. Acá se DECLARA en vez de fingir un reparto que las marcas no sostienen —
 * asignar cada respuesta al primer corte que alcanza deja el 6 en cero y el 5 absorbiéndolo, callado.
 */
// El orden de un paso: por la tabla si tiene nombre de máquina, por su número si es del marcador viejo
// (`parseFloat` deja el 5b detrás del 5). Ordenar los nombres por `Number` daría NaN y un orden cualquiera.
// Sin la tabla (una copia suelta de scripts/), los nombres van al final, en su orden de marca.
let TABLA_PASOS;
function ordenDePaso(paso) {
  if (TABLA_PASOS === undefined) {
    try { TABLA_PASOS = require('../../skills/tycon-pipeline/scripts/lib/steps.js').STEPS; } catch (_) { TABLA_PASOS = null; }
  }
  const i = TABLA_PASOS ? TABLA_PASOS.findIndex((s) => s.id === paso) : -1;
  if (i >= 0) return i;
  const n = parseFloat(paso);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function cortesDePaso(stepTimings) {
  const marcas = Object.entries(stepTimings || {})
    .map(([paso, v]) => ({ paso, hasta: ms(v && v.completedAt) }))
    .filter((m) => m.hasta !== null)
    .sort((a, b) => ordenDePaso(a.paso) - ordenDePaso(b.paso));

  const cortes = [];
  let i = 0;
  while (i < marcas.length) {
    let fin = marcas[i].hasta;
    const nombres = [marcas[i].paso];
    // Absorbe a los siguientes mientras vengan con la marca hacia atrás — o EMPATADA: dos pasos con
    // la misma hora exacta dejan un intervalo de ancho cero, y el segundo saldría en cero, callado.
    while (i + 1 < marcas.length && marcas[i + 1].hasta <= fin) {
      i += 1;
      nombres.push(marcas[i].paso);
      fin = Math.max(fin, marcas[i].hasta);
    }
    cortes.push({ paso: nombres.join('+'), hasta: fin });
    i += 1;
  }
  return cortes.sort((a, b) => a.hasta - b.hasta);
}

/**
 * El consumo de una transcripción ya parseada.
 * `lineas` son objetos; `cortes` viene de cortesDePaso().
 */
function consumo(lineas, cortes) {
  const out = {
    estado: 'medido',
    respuestas: 0,
    sinteticos: 0,
    lineas_ilegibles: 0,
    tokens: { in: 0, out: 0, cache_new: 0, cache_read: 0 },
    por_modelo: {},
    por_paso: {},
    fuera_de_ventana: 0,
    hilo_hasta: null,
  };
  const vistos = new Set(); // dedup por message.id — ver (a) en la cabecera
  const paraCosto = [];

  for (const o of lineas) {
    const msg = o && o.message;
    if (!msg || !msg.usage) continue;
    const id = msg.id || null;
    if (id) {
      if (vistos.has(id)) continue;
      vistos.add(id);
    }
    const modelo = msg.model || 'sin modelo';
    if (modelo === '<synthetic>') { out.sinteticos += 1; continue; }

    const u = msg.usage;
    const ent = u.input_tokens || 0;
    const sal = u.output_tokens || 0;
    const nueva = u.cache_creation_input_tokens || 0;
    const leida = u.cache_read_input_tokens || 0;

    out.respuestas += 1;
    out.tokens.in += ent;
    out.tokens.out += sal;
    out.tokens.cache_new += nueva;
    out.tokens.cache_read += leida;

    const m = out.por_modelo[modelo]
      || (out.por_modelo[modelo] = { respuestas: 0, in: 0, out: 0, cache_new: 0, cache_read: 0 });
    m.respuestas += 1; m.in += ent; m.out += sal; m.cache_new += nueva; m.cache_read += leida;

    // El reparto por paso usa los tokens NUEVOS (entrada + salida + caché nueva). La caché LEÍDA se
    // cuenta en el total pero no acá: es un orden de magnitud mayor y taparía todo lo demás.
    const nuevos = ent + sal + nueva;
    const t = ms(o.timestamp);
    paraCosto.push({ modelo, t, in: ent, out: sal, cache_new: nueva, cache_read: leida });
    if (t === null) { out.fuera_de_ventana += nuevos; continue; }
    const corte = cortes.find((c) => t <= c.hasta);
    if (!corte) { out.fuera_de_ventana += nuevos; continue; }
    out.por_paso[corte.paso] = (out.por_paso[corte.paso] || 0) + nuevos;
  }
  // Lo que usa el costo, respuesta por respuesta y con su hora. No es enumerable: no viaja en la constancia.
  Object.defineProperty(out, 'paraCosto', { value: paraCosto, enumerable: false });
  return out;
}

// ── El costo, con la tabla de precios declarada ──────────────────────────────────────────────────────────────────

const TIPOS_DE_PRECIO = ['in', 'out', 'cache_read', 'cache_new'];
const DIAS_ISO = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** La tabla de precios (`model-prices.json`): `{models}` | `{error}`. */
function leerPrecios(ruta) {
  try {
    const t = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (!t || typeof t.models !== 'object' || t.models === null) return { error: `${path.basename(ruta)} no tiene la clave models` };
    return { models: t.models };
  } catch (e) {
    return { error: `no pude leer la tabla de precios ${path.basename(ruta)}: ${e.code || e.message}` };
  }
}

const aMinutos = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * El precio por millón que vale para un instante: el de la franja de esa hora, o el único. `null` si la entrada no
 * trae precio o sus franjas están mal escritas (hora ilegible, zona horaria que no existe): elegir una franja igual
 * cobraría la otra sin avisar.
 */
function precioEn(entrada, t) {
  const b = entrada.bands;
  if (!b) return entrada.per_million || null;
  const p = b.peak || {};
  const desde = aMinutos(p.from);
  const hasta = aMinutos(p.to);
  // sin zona horaria, Intl usaría la de la máquina que mide: la franja dependería de quién corre el medidor
  if (desde === null || hasta === null || desde === hasta || !Array.isArray(p.days) || typeof b.timezone !== 'string' || !b.timezone) return null;
  let partes;
  try {
    partes = new Intl.DateTimeFormat('en-US', { timeZone: b.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(t));
  } catch {
    return null;
  }
  const de = (tipo) => (partes.find((x) => x.type === tipo) || {}).value;
  const dia = DIAS_ISO[de('weekday')];
  const minuto = Number(de('hour')) * 60 + Number(de('minute'));
  if (!dia || !Number.isFinite(minuto)) return null;
  // una franja con `from` mayor que `to` cruza la medianoche (22:00 a 06:00); el día es el del instante
  const enHora = desde < hasta ? minuto >= desde && minuto < hasta : minuto >= desde || minuto < hasta;
  const enPico = p.days.includes(dia) && enHora;
  return (enPico ? p.per_million : (b.off_peak || {}).per_million) || null;
}

/**
 * El costo de una corrida. `respuestas` es la lista `{modelo, t, in, out, cache_new, cache_read}` (t en ms o null).
 * Devuelve el bloque `costo`, o `null` cuando la corrida no lleva costo: ningún modelo suyo está en la tabla y el
 * proveedor es `anthropic` (las corridas de Claude no ganan costo). Lo que decide si hay costo es el MODELO, por su
 * nombre exacto; el proveedor sólo separa «Claude» de «otro modelo sin precio».
 * Nunca un costo inventado ni uno viejo: sin precio, con el precio vencido, con una respuesta sin hora en un modelo con
 * franjas, o con un tipo de token sin precio declarado, sale `no_medido` con su motivo.
 */
function costo(respuestas, precios, { ahora, proveedor, motivoSinLista, sinHora } = {}) {
  const noMedido = (motivo) => ({ estado: 'no_medido', motivo, medido_en: new Date(ahora).toISOString() });
  const modelos = respuestas ? [...new Set(respuestas.map((r) => r.modelo))] : [];
  // Sin proveedor conocido (el lector de configuración falló), es de Claude sólo si todos sus modelos lo son: una
  // sesión de Codex o de Ollama no se queda sin costo y sin motivo porque no se supo el proveedor.
  const deClaude = proveedor && proveedor.provider
    ? proveedor.provider === 'anthropic'
    : modelos.length > 0 && modelos.every((m) => /^claude/i.test(String(m)));
  const sinProveedor = proveedor && !proveedor.provider && proveedor.problem ? ` (proveedor desconocido: ${proveedor.problem})` : '';
  const tabla = precios && precios.models ? precios.models : null;
  if (!respuestas) {
    return deClaude ? null : noMedido(`${motivoSinLista || 'no hay respuestas para calcular el costo'}${sinProveedor}`);
  }
  // Una tabla ilegible no deja saber si algún modelo tiene precio: se dice, también en una ejecución de Claude.
  if (!tabla) return noMedido(precios && precios.error ? precios.error : 'no hay tabla de precios');
  const conPrecio = modelos.filter((m) => Object.prototype.hasOwnProperty.call(tabla, m));
  if (!conPrecio.length) {
    if (deClaude) return null;
    return noMedido(`sin precio declarado en model-prices.json para ${modelos.join(', ') || 'el modelo de la ejecución'}${sinProveedor}`);
  }
  const sinPrecio = modelos.filter((m) => !conPrecio.includes(m));
  if (sinPrecio.length) return noMedido(`sin precio declarado en model-prices.json para ${sinPrecio.join(', ')}: un total sin esos modelos no es el de la ejecución`);
  const hoy = new Date(ahora).toISOString().slice(0, 10);
  const vencidos = conPrecio.filter((m) => !(tabla[m].review_before >= hoy));
  if (vencidos.length) return noMedido(`precio vencido en model-prices.json (review_before de ${vencidos.map((m) => `${m}: ${tabla[m].review_before}`).join(', ')}; hoy es ${hoy})`);
  const monedas = [...new Set(conPrecio.map((m) => tabla[m].currency))];
  if (monedas.length !== 1) return noMedido(`los modelos de la ejecución tienen precios en monedas distintas (${monedas.join(', ')})`);

  let total = 0;
  const porModelo = {};
  let sinHoraN = 0;
  const faltan = new Map();
  for (const r of respuestas) {
    const entrada = tabla[r.modelo];
    if (entrada.bands && r.t === null) { sinHoraN += 1; continue; }
    const pm = precioEn(entrada, r.t);
    if (!pm) return noMedido(`la entrada de ${r.modelo} en model-prices.json no trae precio por millón, o sus franjas están mal escritas (hora, días o zona horaria)`);
    let importe = 0;
    for (const k of TIPOS_DE_PRECIO) {
      const n = r[k] || 0;
      if (!n) continue;
      if (typeof pm[k] !== 'number') { faltan.set(`${r.modelo} (${k})`, (faltan.get(`${r.modelo} (${k})`) || 0) + n); continue; }
      importe += (n * pm[k]) / 1e6;
    }
    total += importe;
    porModelo[r.modelo] = (porModelo[r.modelo] || 0) + importe;
  }
  if (sinHoraN) {
    return noMedido(sinHora
      || `${sinHoraN} respuesta(s) de un modelo con franjas no tienen hora: sin hora no hay franja, y asignarle una sería inventar`);
  }
  if (faltan.size) {
    return noMedido(`model-prices.json no declara el precio de ${[...faltan.entries()].map(([k, n]) => `${k}, que la ejecución usó en ${n} tokens`).join('; ')}`);
  }
  const redondo = (v) => Math.round(v * 1e6) / 1e6;
  return {
    estado: 'medido',
    moneda: monedas[0],
    total: redondo(total),
    por_modelo: Object.fromEntries(Object.entries(porModelo).map(([m, v]) => [m, redondo(v)])),
    fuentes: Object.fromEntries(conPrecio.map((m) => [m, { fuente: tabla[m].source, revisado: tabla[m].checked, review_before: tabla[m].review_before }])),
    tabla: 'model-prices.json',
    medido_en: new Date(ahora).toISOString(),
  };
}

/**
 * El proveedor de modelos de la sesión, del lector de configuración del arnés (`modelProvider`). Se carga perezoso y
 * con fallo abierto: este archivo viaja suelto a algunas pruebas, sin `scripts/lib/`.
 */
function proveedorDe(opciones) {
  try {
    const { modelProvider } = require('../lib/tycon-config.js');
    const p = modelProvider({ env: opciones.env || process.env, home: opciones.home });
    return p.problem ? { provider: p.provider, origin: p.origin, problem: p.problem } : { provider: p.provider, origin: p.origin };
  } catch (e) {
    return { provider: null, origin: 'no_medido', problem: `no pude cargar el lector de configuración (${e.code || e.message})` };
  }
}

/**
 * ¿El ambiente que mide es de OTRA sesión que la de la ejecución? Pasa con el barrido de arranque: mide todas las
 * ejecuciones archivadas desde la sesión que abre. Sin id en el ambiente (a mano, por la línea de comando), no se sabe:
 * se usa el ambiente como siempre.
 */
function ambienteAjeno(env, sessionId) {
  const propia = env && (env.CLAUDE_CODE_SESSION_ID || env.TYCON_SESSION_ID || env.CODEX_SESSION_ID);
  return Boolean(propia && sessionId && propia !== sessionId);
}

/**
 * ¿Es una sesión de Codex? Lo dice lo que ya quedó anotado en la constancia, o el ambiente de la sesión que cierra. El
 * ambiente de otra sesión no dice nada de ésta: sin anotación, se busca primero la conversación de Claude Code.
 */
function esCodex(dump, env, sessionId) {
  if (dump.consumo && dump.consumo.herramienta === 'codex') return true;
  if (ambienteAjeno(env, sessionId)) return false;
  return Boolean(env && env.CODEX_SESSION_ID) && !(env && env.CLAUDE_CODE_SESSION_ID);
}

/**
 * ¿Es la línea con que Claude Code ENCOLA la notificación de un agente que terminó mientras el padre
 * estaba ocupado? Es un `queue-operation` (tipo descartado del hilo) y es la ÚNICA copia del
 * resultado de ese agente: no hay línea `user` (medido: 173 de 446
 * notificaciones de agente sólo viven así). Pesa ~2 KB (máximo medido 16 KB): se conserva.
 */
function esNotificacionEncolada(o) {
  return !!o && o.type === 'queue-operation' && o.operation === 'enqueue'
    && typeof o.content === 'string' && o.content.includes('<task-notification>');
}

/**
 * El aviso de un hook que falló sin frenar (`hook_non_blocking_error`) o que se pasó de tiempo (`hook_cancelled` con
 * `timedOut`), reducido: nombre, evento, código de salida, la categoría del error (CATEGORIAS_HOOK, `otro` si ninguna;
 * `tiempo` el que se pasó) y el texto del error saneado, sin controles y recortado. `stdout`, `command`, `cwd` y lo
 * demás no viajan. Cualquier otra línea → null.
 */
function reducirErrorDeHook(o) {
  const a = o && o.type === 'attachment' ? o.attachment : null;
  const tiempo = !!a && a.type === 'hook_cancelled' && a.timedOut === true;
  if (!a || (a.type !== 'hook_non_blocking_error' && !tiempo)) return null;
  // un nombre también pasa por sanear(): si alguna vez trae una ruta o una credencial, no viaja así
  const nombre = (v) => (typeof v === 'string' && v.length <= LARGO_NOMBRE_HOOK && !/[\r\n]/.test(v) ? sanear(v) : null);
  const stderr = !tiempo && typeof a.stderr === 'string' ? a.stderr : '';
  const cat = CATEGORIAS_HOOK.find(([, re]) => re.test(stderr));
  const texto = sanear(stderr).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, LARGO_TEXTO_HOOK);
  return {
    type: 'attachment',
    timestamp: o.timestamp,
    attachment: {
      type: a.type,
      hookName: nombre(a.hookName),
      hookEvent: nombre(a.hookEvent),
      exitCode: !tiempo && Number.isInteger(a.exitCode) ? a.exitCode : null,
      categoria: tiempo ? 'tiempo' : (cat ? cat[0] : 'otro'),
      texto: texto || null,
    },
  };
}

/** Los mensajes del hilo: lo que se pidió, lo que se respondió y las herramientas. Sin adjuntos —
 *  salvo la notificación ENCOLADA de un agente, que sin esto se perdería (ver esNotificacionEncolada), y el aviso
 *  de un hook que falló, reducido (ver reducirErrorDeHook). */
function hilo(lineas) {
  const out = [];
  for (const o of lineas) {
    if (!o || !o.type) continue;
    const hook = reducirErrorDeHook(o);
    if (hook) out.push(hook);
    else if (!TIPOS_DESCARTADOS.has(o.type) || esNotificacionEncolada(o)) out.push(o);
  }
  return out;
}

/**
 * El resultado real de la ejecución que dejó a cada freno en rojo.
 * `usos`: id de la llamada → {cmd, ts} · `resultados`: id → texto.
 * Devuelve un Map de índice del gate → mensaje ya saneado y recortado.
 */
function mensajesDeError(usos, resultados, gates, home) {
  const out = new Map();
  for (let i = 0; i < (gates || []).length; i += 1) {
    const g = gates[i];
    if (!g || !g.cmd || !g.ts || !esRojo(g.status)) continue;
    // Con cola propia no se busca en la conversación: la cola ES la salida de ese comando.
    if (typeof g.cola === 'string') continue;
    const marca = ms(g.ts);
    if (marca === null) continue;
    const objetivo = normalizar(g.cmd);
    if (!objetivo) continue;

    // Contención DIRIGIDA con BORDE: el comando del REGISTRO adentro del de la CONVERSACIÓN, y
    // delimitado — `npm test` no es `npm testx` (la subcadena plana
    // atribuiría la salida de otro comando). Al revés sobre-empareja: un `npm test` suelto en la
    // conversación no prueba nada sobre un freno cuyo comando es más largo.
    const contiene = new RegExp(`(?:^|[\\s;&|(])${objetivo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s;&|)])`);
    // Orden de preferencia, de mayor a menor: exacto > antes de la marca > después. Dentro de cada
    // grupo, el más cercano. 🔴 «Antes» le gana a «después» AUNQUE esté más lejos: la ventana hacia
    // adelante es mucho más chica (15 s) que hacia atrás (2 min), así que un candidato espurio
    // posterior casi siempre ganaría por cercanía absoluta: un triage a +7,3 s le ganaría a un
    // compilador a −11,8 s y se publicaría «NINGUNO de mis archivos» sin un solo error adentro.
    let elegido = null;
    let mejorRango = Infinity; // 0 exacto · 1 antes · 2 después
    let mejorDist = Infinity;
    for (const [id, v] of usos) {
      const t = ms(v.ts);
      if (t === null) continue;
      const dt = t - marca;
      if (dt < -VENTANA_ATRAS_MS || dt > VENTANA_ADELANTE_MS) continue;
      const cmd = normalizar(v.cmd);
      const esExacto = cmd === objetivo;
      if (!esExacto && !contiene.test(cmd)) continue;
      const rango = esExacto ? 0 : (dt <= 0 ? 1 : 2);
      const dist = Math.abs(dt);
      if (rango < mejorRango || (rango === mejorRango && dist < mejorDist)) {
        mejorRango = rango; mejorDist = dist; elegido = id;
      }
    }
    if (elegido === null) continue;

    const crudo = resultados.get(elegido);
    if (!crudo) continue;
    // El aviso de que el comando corre en segundo plano NO es el mensaje del error: la salida real
    // se fue a un archivo del scratchpad, que se borra. Publicarlo haría pasar un preámbulo por
    // evidencia.
    if (/^Command running in background/.test(crudo)) continue;
    // Se guarda la COLA, no la cabeza. El freno suele correr al final de un Bash compuesto
    // (`baseline | tail; echo ===; pipeline.js next; echo ===; <freno>`) y el resultado concatena
    // todas las salidas: recortar los primeros 700 caracteres publicaría el listado de próximos pasos
    // y cortaría justo ANTES del veredicto (un «🔴 ROJO» puede empezar pasado el carácter 800).
    // Los veredictos y los errores viven al final; los preámbulos, al principio.
    const texto = colaDeSalida(crudo, home);
    if (!texto) continue;
    out.set(i, texto);
  }
  return out;
}

// ── Borde: disco ─────────────────────────────────────────────────────────────────────────────────

/**
 * Ubica la transcripción de una sesión. Devuelve {ruta} | {estado:'borrada'|'no_medido', motivo}.
 * Las dos ausencias NO son la misma cosa — ver la regla cardinal en la cabecera.
 */
function ubicarTranscripcion(sessionId, projectsDir) {
  if (!sessionId) {
    return { estado: 'no_medido', motivo: 'la ejecución no anotó a qué sesión pertenece' };
  }
  // El identificador sale de un archivo JSON y se concatena a una ruta. Hoy el origen es confiable
  // —lo escribe el propio arnés— pero eso es una propiedad de hoy, no del código: sin esta guarda,
  // un identificador con separadores convierte la búsqueda en una lectura fuera de lugar.
  if (!/^[A-Za-z0-9._-]+$/.test(String(sessionId))) {
    return { estado: 'no_medido', motivo: `el identificador de sesión anotado no tiene forma de identificador (${String(sessionId).slice(0, 40)})` };
  }
  // Una o varias raíces: `~/.claude/projects` y, con CLAUDE_CONFIG_DIR, `$CLAUDE_CONFIG_DIR/projects`.
  const raices = Array.isArray(projectsDir) ? projectsDir : [projectsDir];
  let total = 0;
  let leidas = 0;
  const ilegibles = [];
  const ausentes = [];
  for (const raiz of raices) {
    let carpetas;
    try {
      carpetas = fs.readdirSync(raiz, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e) {
      // una raíz que no existe no puede guardar la conversación; una que existe y no se lee, sí
      (e.code === 'ENOENT' ? ausentes : ilegibles).push(`${raiz}: ${e.code || e.message}`);
      continue;
    }
    leidas += 1;
    total += carpetas.length;
    for (const c of carpetas) {
      const p = path.join(raiz, c, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return { ruta: p };
    }
  }
  // Con una raíz sin leer, «no está» no se puede afirmar: puede estar ahí. Sin ninguna raíz existente, tampoco.
  if (ilegibles.length || !leidas) {
    return {
      estado: 'no_medido',
      motivo: `no pude leer la carpeta de conversaciones (${[...ilegibles, ...ausentes].join('; ')})`,
    };
  }
  return {
    estado: 'borrada',
    motivo: `la conversación de esta ejecución ya no está (Claude Code las borra según cleanupPeriodDays); se buscó ${sessionId}.jsonl en las ${total} carpetas de conversaciones`,
  };
}

/** Dónde busca las conversaciones de Claude Code: `$CLAUDE_CONFIG_DIR/projects` si la variable está, y `~/.claude/projects`. */
function carpetasDeConversaciones(env, home) {
  const propia = path.join(home, '.claude', 'projects');
  if (!env || !env.CLAUDE_CONFIG_DIR) return [propia];
  const otra = path.join(env.CLAUDE_CONFIG_DIR, 'projects');
  return path.resolve(otra) === path.resolve(propia) ? [propia] : [otra, propia];
}

/** Lee la transcripción entera. Cuenta las líneas ilegibles en vez de descartarlas callada. */
function leerTranscripcion(ruta) {
  let crudo;
  try {
    crudo = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    return { error: `no pude leer la conversación: ${e.code || e.message}` };
  }
  const lineas = [];
  let ilegibles = 0;
  for (const l of crudo.split('\n')) {
    if (!l.trim()) continue;
    try { lineas.push(JSON.parse(l)); } catch { ilegibles += 1; }
  }
  return { lineas, ilegibles };
}

/** Índice de llamadas a herramienta con comando, y sus resultados. */
function indexarComandos(lineas) {
  const usos = new Map();
  const resultados = new Map();
  for (const o of lineas) {
    const c = o && o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const it of c) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'tool_use' && it.input && typeof it.input.command === 'string') {
        usos.set(it.id, { cmd: it.input.command, ts: o.timestamp });
      } else if (it.type === 'tool_result') {
        const v = it.content;
        resultados.set(it.tool_use_id, typeof v === 'string' ? v : JSON.stringify(v || ''));
      }
    }
  }
  return { usos, resultados };
}

function ultimaHora(lineas) {
  let max = null;
  for (const o of lineas) {
    const t = ms(o && o.timestamp);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max === null ? null : new Date(max).toISOString();
}

// El tramo de la conversación que es de la corrida. Antes del arranque se dejan unos minutos: el pedido que la abrió.
// Después del cierre, una hora: el pipeline sigue hablando tras el `clear` (el cierre truncado), y el cambio de git y
// el pedido que salen de la corrida se leen en esa cola.
const THREAD_WINDOW_BEFORE_MS = 10 * 60 * 1000;
const THREAD_WINDOW_AFTER_MS = 60 * 60 * 1000;

/**
 * Desde y hasta qué hora es de esta corrida. `null` sin hora de arranque (un volcado viejo): se guarda la conversación
 * entera, como siempre. `hasta` es `null` mientras la corrida no se archivó: queda abierta y sigue creciendo.
 * Una corrida que quedó sin cerrar (`sinCerrar`, la escribe `unclosed-runs.js`) no se archiva nunca: su marcador ya
 * desapareció, así que termina en su último freno registrado (o en su arranque, sin ninguno).
 */
function ventanaDelHilo(dump) {
  const marker = (dump && dump.marker) || {};
  const inicio = ms(marker.startedAt);
  if (inicio === null) return null;
  let ultimo = ms(dump.archivedAt);
  if (ultimo === null && dump.sinCerrar) {
    ultimo = inicio;
    for (const g of dump.gates || []) {
      const t = ms(g && g.ts);
      if (t !== null && t > ultimo) ultimo = t;
    }
  }
  const toque = ms(marker.lastTouch);
  if (ultimo !== null && toque !== null && toque > ultimo) ultimo = toque;
  return { desde: inicio - THREAD_WINDOW_BEFORE_MS, hasta: ultimo === null ? null : ultimo + THREAD_WINDOW_AFTER_MS };
}

/** ¿El instante (en ms) cae dentro de la ventana? Una ventana sin fin queda abierta hacia adelante. */
function isInWindow(t, ventana) {
  return t !== null && t >= ventana.desde && (ventana.hasta === null || t <= ventana.hasta);
}

/**
 * Las líneas de la conversación que cuentan para el consumo y el costo de la corrida: las de su ventana, la MISMA del
 * hilo. Sin ventana (un volcado viejo, sin hora de arranque) cuentan todas, como siempre.
 * Una línea con consumo y sin hora propia no es de ninguna corrida: en una sesión con varias, prestarle la hora de su
 * vecina (lo que hace el hilo) la podría cobrar en la corrida equivocada, o en dos. Se cuentan aparte, en `sinHora`
 * (una vez por respuesta), para que no se pierdan callados.
 */
function linesInWindow(lineas, ventana) {
  if (!ventana) return { lineas, sinHora: 0 };
  const sinHoraVistas = new Set();
  let sinHora = 0;
  const dentro = lineas.filter((o) => {
    const t = ms(o && o.timestamp);
    if (t === null && o && o.message && o.message.usage) {
      const id = o.message.id || null;
      if (!id || !sinHoraVistas.has(id)) sinHora += 1;
      if (id) sinHoraVistas.add(id);
    }
    return isInWindow(t, ventana);
  });
  return { lineas: dentro, sinHora };
}

/** La ventana con sus horas escritas, como se anota en el volcado. */
function windowAsIso(ventana) {
  return { desde: new Date(ventana.desde).toISOString(), hasta: ventana.hasta === null ? null : new Date(ventana.hasta).toISOString() };
}

const WHOLE_SESSION_REASON = 'medida antes de que el consumo se recortara al tramo de cada ejecución: trae el de la sesión entera, que ya publica otra ejecución de la misma sesión';

/**
 * De las corridas de UNA sesión, cuáles no pueden publicar su consumo. Una corrida medida antes del recorte (`medido` sin
 * `tramo`) trae el consumo de la sesión entera; si su conversación ya se borró, o la copia es de otra máquina, no se
 * puede recalcular. Para no sumarlo dos veces, lo publica una sola: la archivada más tarde, la que vio más de la sesión
 * (la misma que publicaba el tablero cuando juntaba una fila por sesión). Las demás sin tramo salen «no medido». Si
 * alguna corrida de la sesión ya tiene su tramo, ninguna sin tramo publica: su total incluye el de esa.
 * `dumps` son los volcados de la sesión; devuelve un Map índice → motivo de las que salen «no medido».
 */
function wholeSessionDuplicates(dumps) {
  const out = new Map();
  if (!Array.isArray(dumps) || dumps.length < 2) return out;
  const medido = (d) => d && d.consumo && d.consumo.estado === 'medido';
  const sinTramo = dumps.map((_, i) => i).filter((i) => medido(dumps[i]) && !dumps[i].consumo.tramo);
  if (!sinTramo.length) return out;
  const conTramo = dumps.some((d) => medido(d) && d.consumo.tramo);
  const archivo = (i) => String(dumps[i].archivedAt || (dumps[i].marker && dumps[i].marker.startedAt) || '');
  const queda = conTramo ? null : sinTramo.reduce((a, i) => (archivo(i) > archivo(a) ? i : a));
  for (const i of sinTramo) if (i !== queda) out.set(i, WHOLE_SESSION_REASON);
  return out;
}

/** Los mensajes dentro de la ventana. Uno sin hora toma la del anterior (o la del siguiente, si va primero). */
function recortarAVentana(mensajes, ventana) {
  if (!ventana) return mensajes;
  const horas = mensajes.map((o) => ms(o && o.timestamp));
  let previa = null;
  for (let i = 0; i < horas.length; i += 1) {
    if (horas[i] === null) horas[i] = previa;
    else previa = horas[i];
  }
  let siguiente = null;
  for (let i = horas.length - 1; i >= 0; i -= 1) {
    if (horas[i] === null) horas[i] = siguiente;
    else siguiente = horas[i];
  }
  return mensajes.filter((_, i) => isInWindow(horas[i], ventana));
}

function rutaHilo(volcado) {
  return `${volcado.replace(/\.json$/, '')}.hilo.jsonl.gz`;
}

// ── Una corrida ──────────────────────────────────────────────────────────────────────────────────

/**
 * El MEDIDOR de revisores corre encadenado a cada corrida que este rescate procesa:
 * así toda corrida nueva queda medida
 * sola en el barrido del arranque, sin correr `reviewers-cost.js` a mano.
 *
 * 🔴 `require` PEREZOSO y fail-open CON MOTIVO: este archivo lo llama `marker.js` desde OTRO repo
 * (agent-skills) en cada cierre del pipeline. Si el medidor no está (arnés partido, máquina
 * atrasada) o falla, el rescate del hilo YA quedó escrito y el volcado sale con `revisores`
 * anotado como `no_medido` y su motivo — nunca un cero, nunca en silencio, y nunca rompiendo lo
 * que sí se rescató. Un bloque `revisores` ya medido no se pisa con una ausencia.
 * Apagado: TYCON_NO_REVIEWER_COST=1.
 */
function encadenarMedidor(volcado, opciones) {
  const anotar = (motivo) => {
    try {
      const dump = JSON.parse(fs.readFileSync(volcado, 'utf8'));
      const previo = dump.revisores;
      // Sólo se anota la ausencia sobre NADA o sobre un `no_medido` anterior: `medido`, `parcial` y
      // `borrada` (terminal, con sus conteos) no se pisan.
      if (!previo || previo.estado === 'no_medido') {
        dump.revisores = { estado: 'no_medido', motivo, medido_en: new Date().toISOString() };
        escribirVolcado(volcado, dump);
      }
    } catch { /* el volcado se acaba de escribir; si ahora no se puede leer, el motivo vuelve igual */ }
    return { estado: 'no_medido', motivo };
  };
  if (readEnv('TYCON_NO_REVIEWER_COST', { where: 'scripts/metrics/tokens-digest.js' }) === '1') return anotar('el medidor de revisores está apagado en esta máquina (TYCON_NO_REVIEWER_COST=1)');
  let medidor;
  try {
    medidor = require('./reviewers-cost.js');
  } catch (e) {
    return anotar(`reviewers-cost.js no se pudo cargar (${e.code || e.message}): los revisores de esta ejecución no se midieron; el rescate del hilo se escribió igual`);
  }
  try {
    const r = medidor.procesarCorrida(volcado, { projectsDir: opciones.projectsDir, runsDir: opciones.runsDir, home: opciones.home });
    if (r.error) return anotar(`el medidor de revisores no pudo leer el volcado: ${r.error}`);
    const v = r.revisores || {};
    return {
      estado: v.estado || 'no_medido',
      lanzamientos: Number.isFinite(v.lanzamientos) ? v.lanzamientos : null,
      con_tokens: Number.isFinite(v.con_tokens) ? v.con_tokens : null,
      sin_resultado: Number.isFinite(v.sin_resultado) ? v.sin_resultado : null,
      no_persistido: r.no_persistido || null,
      separacion_ok: r.separacion ? r.separacion.ok : null,
    };
  } catch (e) {
    return anotar(`el medidor de revisores falló: ${e && e.message ? e.message.slice(0, 200) : 'motivo desconocido'}`);
  }
}

function procesarCorrida(volcado, opciones) {
  const res = rescatarCorrida(volcado, opciones);
  if (res.error) return res;
  res.revisores = encadenarMedidor(volcado, opciones);
  // Si el medidor no pudo ESCRIBIR su bloque, la corrida NO quedó rescatada entera: sube al
  // resultado para que `--run` salga ≠ 0 y el barrido lo cuente.
  if (res.revisores && res.revisores.no_persistido && !res.no_persistido) res.no_persistido = `revisores: ${res.revisores.no_persistido}`;
  return res;
}

/**
 * El consumo de una sesión de Codex (`codex-usage.js`), con su proveedor y su costo. Devuelve `{bloque}`, o `null`
 * cuando la sesión no se sabía de Codex y tampoco está en sus sesiones: entonces sigue el camino de Claude Code.
 */
function medirCodex(sessionId, codexDir, stepTimings, { proveedor, ahora, precios, sabida, env, home }) {
  let cu;
  try {
    cu = require('./codex-usage.js');
  } catch (e) {
    if (!sabida) return null;
    return { bloque: { estado: 'no_medido', herramienta: 'codex', motivo: `codex-usage.js no se pudo cargar (${e.code || e.message})`, proveedor, medido_en: new Date().toISOString() } };
  }
  const ubi = cu.ubicarSesion(sessionId, codexDir || cu.carpetaDeSesiones(env, home));
  if (!ubi.ruta) {
    if (!sabida) return null;
    return { bloque: { estado: 'no_medido', herramienta: 'codex', motivo: ubi.motivo, proveedor, medido_en: new Date().toISOString() } };
  }
  const leido = cu.leerSesion(ubi.ruta);
  if (leido.error) return { bloque: { estado: 'no_medido', herramienta: 'codex', motivo: leido.error, proveedor, medido_en: new Date().toISOString() } };
  const r = cu.consumoCodex(leido.lineas, cortesDePaso(stepTimings), sessionId);
  const bloque = { ...r.bloque, proveedor, medido_en: new Date().toISOString() };
  if (bloque.estado === 'medido') {
    bloque.lineas_ilegibles = leido.ilegibles;
    const k = costo(r.paraCosto || null, precios(), {
      ahora,
      proveedor,
      motivoSinLista: r.motivoCosto,
      sinHora: 'Codex da un total y no la hora de cada respuesta: un modelo con franjas de precio no se puede cobrar',
    });
    if (k) bloque.costo = k;
  }
  return { bloque };
}

function rescatarCorrida(volcado, opciones) {
  const projectsDir = opciones.projectsDir;
  const home = opciones.home || os.homedir();

  let dump;
  try {
    dump = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  } catch (e) {
    return { volcado, error: `volcado ilegible: ${e.code || e.message}` };
  }
  const marker = dump.marker || {};
  const sessionId = marker.sessionId || null;
  const res = { volcado, story: marker.storyId || null, sessionId, hilo: null, rescatados: 0 };

  // Los mensajes que el registro ya trae (la `cola` de run-check) van ANTES de buscar la conversación:
  // no dependen de ella, y una corrida con la conversación borrada los tiene que conservar igual.
  // Todas las salidas de abajo escriben este mismo `dump`.
  const deSalida = mensajesDeSalida(dump.gates, home);
  for (const [i, texto] of deSalida) {
    dump.gates[i].mensaje = texto;
    dump.gates[i].mensaje_fuente = 'salida';
  }
  res.rescatados = deSalida.size;

  // El proveedor se anota la PRIMERA vez que se mide, con el ambiente de la sesión que cierra; un re-proceso del
  // barrido de arranque corre en otra sesión y no lo pisa.
  // Si lo mide una sesión ajena, su proveedor no es el de esta ejecución: se anota que no se sabe, no el de la otra.
  const ajeno = ambienteAjeno(opciones.env || process.env, sessionId);
  const proveedor = opciones.proveedor || (dump.consumo && dump.consumo.proveedor)
    || (ajeno
      ? { provider: null, origin: 'no_medido', problem: 'la midió el barrido de otra sesión: el proveedor de esa sesión no es el de esta ejecución' }
      : proveedorDe(opciones));
  const ahora = opciones.ahora || new Date().toISOString();
  const precios = () => leerPrecios(opciones.preciosPath || path.join(__dirname, 'model-prices.json'));
  // la carpeta de Codex se resuelve adentro de medirCodex: codex-usage.js se carga con fallo abierto
  const codexDir = opciones.codexDir || null;

  const ubiClaude = esCodex(dump, opciones.env || process.env, sessionId) ? null : ubicarTranscripcion(sessionId, projectsDir);
  if (!ubiClaude || !ubiClaude.ruta) {
    // Sin conversación de Claude Code: una sesión de Codex se busca en sus sesiones. Una que se sabe de Codex y no está
    // sale `no_medido` (el barrido la reintenta), nunca `borrada`.
    const codex = medirCodex(sessionId, codexDir, marker.stepTimings, { proveedor, ahora, precios, sabida: !ubiClaude, env: opciones.env || process.env, home });
    if (codex) {
      if (codex.bloque.estado !== 'medido' && dump.consumo && dump.consumo.estado === 'medido') {
        dump.consumo.conversacion = { estado: codex.bloque.estado, motivo: codex.bloque.motivo, desde: new Date().toISOString() };
      } else {
        dump.consumo = codex.bloque;
      }
      res.consumo = dump.consumo;
      res.no_persistido = escribirVolcado(volcado, dump);
      return res;
    }
  }
  const ubi = ubiClaude;
  if (!ubi.ruta) {
    // 🔴 Lo que YA se midió no se pisa: `--all` reprocesa sin
    // condición, y si en ESA pasada la carpeta de conversaciones está mal apuntada o inaccesible,
    // se sobreescribirían tokens reales e hilo guardado con `estado: borrada` — y como «borrada» es
    // terminal para el barrido, no se recuperarían nunca. El resumen medido es una foto válida aunque
    // la conversación se haya ido después: se conserva, y se anota desde cuándo no está.
    if (dump.consumo && dump.consumo.estado === 'medido') {
      dump.consumo.conversacion = { estado: ubi.estado, motivo: ubi.motivo, desde: new Date().toISOString() };
      res.consumo = dump.consumo;
      res.no_persistido = escribirVolcado(volcado, dump);
      return res;
    }
    // Sin la clave `tokens`, a propósito: un cero se lee como «esta corrida no consumió nada».
    dump.consumo = { estado: ubi.estado, motivo: ubi.motivo, proveedor, medido_en: new Date().toISOString() };
    res.consumo = dump.consumo;
    res.no_persistido = escribirVolcado(volcado, dump);
    return res;
  }

  const leido = leerTranscripcion(ubi.ruta);
  if (leido.error) {
    // Lo ya medido se conserva, igual que sin conversación: una lectura que falla hoy (un permiso, un archivo a medio
    // escribir) no borra el consumo. Se anota y el barrido lo reintenta.
    if (dump.consumo && dump.consumo.estado === 'medido') {
      dump.consumo.conversacion = { estado: 'no_medido', motivo: leido.error, desde: new Date().toISOString() };
      res.consumo = dump.consumo;
      res.no_persistido = escribirVolcado(volcado, dump);
      return res;
    }
    dump.consumo = { estado: 'no_medido', motivo: leido.error, proveedor, medido_en: new Date().toISOString() };
    res.consumo = dump.consumo;
    res.no_persistido = escribirVolcado(volcado, dump);
    return res;
  }

  // El consumo y el costo, sólo del tramo de la sesión que es de esta corrida: con varias corridas en la misma sesión,
  // cada una cargaba el consumo de las demás y el tablero lo contaba varias veces.
  const ventana = ventanaDelHilo(dump);
  const delTramo = linesInWindow(leido.lineas, ventana);
  const cortes = cortesDePaso(marker.stepTimings);
  let c = consumo(delTramo.lineas, cortes);
  // Un tramo sin ninguna respuesta no es «consumió cero»: la conversación no tiene nada de esta corrida (se partió en
  // otra sesión, o las respuestas no traen hora). Sale sin la clave `tokens`, con su motivo.
  if (ventana && c.respuestas === 0) {
    c = { estado: 'no_medido', motivo: 'la conversación no tiene ninguna respuesta con consumo dentro del tramo de esta ejecución' };
  } else {
    c.lineas_ilegibles = leido.ilegibles;
  }
  if (ventana) {
    c.tramo = windowAsIso(ventana);
    c.sin_hora = delTramo.sinHora;
  }
  c.medido_en = new Date().toISOString();
  c.proveedor = proveedor;
  if (c.estado === 'medido') {
    const k = costo(c.paraCosto, precios(), { ahora, proveedor });
    if (k) c.costo = k;
  }
  dump.consumo = c;
  res.consumo = c;

  // El hilo. Se reescribe entero: idempotente sobre la misma entrada, actualizado si creció. Sólo el tramo de la corrida.
  const mensajes = recortarAVentana(hilo(leido.lineas), ventana);
  const destino = rutaHilo(volcado);
  try {
    const cuerpo = `${mensajes.map((m) => JSON.stringify(m)).join('\n')}\n`;
    fs.writeFileSync(destino, zlib.gzipSync(Buffer.from(cuerpo, 'utf8')));
    res.hilo = {
      archivo: destino,
      bytes: fs.statSync(destino).size,
      mensajes: mensajes.length,
      descartadas: leido.lineas.length - mensajes.length,
    };
    if (ventana) res.hilo.ventana = windowAsIso(ventana);
    // 🔴 `hilo_hasta` SÓLO avanza si el archivo llegó a escribirse. Si se fijara con lo leído de la
    // transcripción, sin mirar el resultado de la escritura, con el disco lleno o un permiso mal ese
    // tramo de conversación se perdería PARA SIEMPRE —`estaPendiente` lo daría por resuelto— y el barrido lo
    // contaría como salvado. Un número diciendo «todo bien» sobre algo que no se guardó.
    // Y se calcula sobre los MENSAJES que entran al archivo, no sobre todas las líneas: si la
    // última fuera un adjunto (que se descarta), avanzaría sin haber guardado ese contenido.
    c.hilo_hasta = ultimaHora(mensajes);
    // Cuándo se guardó y de qué tamaño era la transcripción: con eso `estaPendiente` guarda una conversación grande a
    // lo sumo una vez por día (ver THREAD_DAILY_MAX_SIZE_DEFAULT).
    c.hilo_guardado_en = ahora;
    try { c.transcripcion_bytes = fs.statSync(ubi.ruta).size; } catch { /* se movió recién; la próxima vez se mide */ }
  } catch (e) {
    res.hilo = { archivo: destino, error: `no pude guardar el hilo: ${e.code || e.message}` };
  }
  dump.hilo = res.hilo;

  // El mensaje real de cada freno en rojo.
  const { usos, resultados } = indexarComandos(leido.lineas);
  const msgs = mensajesDeError(usos, resultados, dump.gates, home);
  for (const [i, texto] of msgs) {
    dump.gates[i].mensaje = texto;
    dump.gates[i].mensaje_fuente = 'conversacion';
  }
  res.rescatados = deSalida.size + msgs.size;

  res.no_persistido = escribirVolcado(volcado, dump);
  return res;
}

/**
 * Escribe el volcado de forma atómica. Devuelve `null` si pudo, o el motivo si no.
 *
 * 🔴 No lanza. Si propagara, en el barrido —que corre en CADA arranque de sesión— una corrida sin
 * poder persistirse no dejaría rastro en ningún lado y se reintentaría para siempre, callada. El
 * motivo vuelve al llamador, que lo cuenta aparte y lo dice en el resumen: «no pude» tiene que verse.
 */
function escribirVolcado(ruta, dump) {
  const tmp = `${ruta}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(dump, null, 2), 'utf8');
    fs.renameSync(tmp, ruta);
    return null;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* el temporal puede no haberse creado */ }
    return `no pude escribir el volcado: ${e.code || e.message}`;
  }
}

// Una conversación viva y grande crece entre un arranque y el siguiente. Guardarla de nuevo en cada arranque reescribía
// 150 MB comprimidos, la subida los volvía a subir y cada máquina los volvía a bajar. Desde este tamaño de transcripción
// se guarda a lo sumo una vez por día; lo que crezca mientras tanto entra en la vuelta siguiente.
const THREAD_DAILY_MAX_SIZE_DEFAULT = 20 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ¿La transcripción pasa el tope y su hilo ya se guardó en las últimas 24 h? */
function grandeYaGuardadaHoy(ruta, c, opciones) {
  const env = opciones.env || process.env;
  const tope = Number(env.TYCON_THREAD_DAILY_MAX_SIZE) > 0 ? Number(env.TYCON_THREAD_DAILY_MAX_SIZE) : THREAD_DAILY_MAX_SIZE_DEFAULT;
  if (!c.hilo_guardado_en) return false;
  let bytes;
  try { bytes = fs.statSync(ruta).size; } catch { return false; }
  if (bytes < tope) return false;
  const ahora = ms(opciones.ahora || new Date().toISOString());
  return ahora - ms(c.hilo_guardado_en) < DAY_MS;
}

/**
 * ¿Esta corrida necesita que se le pase el rescate?
 * Sí si nunca se le pasó, o si su conversación CRECIÓ desde la última vez — que es el caso del
 * cierre truncado: el archivador corre en el `clear` y después el pipeline sigue hablando.
 * No si su conversación ya no está y eso quedó anotado: volver a mirarla no la trae de vuelta.
 */
function estaPendiente(volcado, projectsDir, opciones = {}) {
  let dump;
  try { dump = JSON.parse(fs.readFileSync(volcado, 'utf8')); } catch { return false; }
  const c = dump.consumo;
  if (!c) return true;
  // Sin bloque `revisores` también está pendiente: el medidor lo escribe SIEMPRE (medido o
  // con motivo), así que esto pasa una sola vez por corrida — no se reprocesa para siempre.
  if (!dump.revisores) return true;
  if (c.estado === 'borrada') return false;
  // Un tramo leído sin ninguna respuesta (`no_medido` con `tramo`) sigue la vara de abajo, como uno medido: vuelve sólo si
  // la conversación creció adentro de su tramo. Sin eso se releería en cada arranque sin cambiar nada.
  if (c.estado === 'no_medido' && !c.tramo) return true;
  const sid = (dump.marker || {}).sessionId;
  if (c.herramienta === 'codex') return codexCrecio(sid, c, opciones);
  const ubi = ubicarTranscripcion(sid, projectsDir);
  if (!ubi.ruta) return false;
  const ventana = ventanaDelHilo(dump);
  // Medida antes de que el consumo se recortara a la ventana (sin `tramo`): vuelve para que deje de cargar el consumo de
  // las otras corridas de su sesión, pero sólo si la conversación se puede leer; si no, se reintenta otro día.
  if (ventana && !c.tramo) return !leerTranscripcion(ubi.ruta).error;
  // Guardada después de que cerró su ventana: lo que la conversación crezca ya no es de esta corrida.
  if (ventana && ventana.hasta !== null && c.hilo_guardado_en && ms(c.hilo_guardado_en) > ventana.hasta) return false;
  if (grandeYaGuardadaHoy(ubi.ruta, c, opciones)) return false;
  const leido = leerTranscripcion(ubi.ruta);
  if (leido.error) return false;
  // La MISMA vara que usó `procesarCorrida` para escribir `hilo_hasta`: los mensajes que entran al
  // archivo (con el mismo recorte), no todas las líneas. Con dos varas distintas nunca coincidirían y se reprocesaría
  // siempre.
  const ultima = ultimaHora(recortarAVentana(hilo(leido.lineas), ventana));
  // Sin `hilo_hasta` sólo vale la pena volver si hay algo con hora: una conversación sin una
  // sola marca de tiempo se re-procesaría en cada arranque, para siempre, sin cambiar nada.
  if (!c.hilo_hasta) return ultima !== null;
  return ultima !== null && ms(ultima) > ms(c.hilo_hasta);
}

/** ¿La sesión de Codex ya medida tiene un `token_count` posterior al último que se leyó? */
function codexCrecio(sid, c, opciones) {
  try {
    const cu = require('./codex-usage.js');
    const dir = opciones.codexDir || cu.carpetaDeSesiones(opciones.env || process.env, opciones.home || os.homedir());
    const ubi = cu.ubicarSesion(sid, dir);
    if (!ubi.ruta) return false;
    const leido = cu.leerSesion(ubi.ruta);
    if (leido.error) return false;
    const hasta = cu.consumoCodex(leido.lineas, [], sid).bloque.leido_hasta;
    return Boolean(hasta) && (!c.leido_hasta || ms(hasta) > ms(c.leido_hasta));
  } catch {
    return false;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const arg = (n, def) => {
    const i = argv.indexOf(n);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const home = os.homedir();
  const projectsDir = arg('--projects-dir', null) || carpetasDeConversaciones(process.env, home);
  const historyDir = arg('--history-dir', path.join(stateDirOf(home), 'timing-history'));
  const budgetMs = parseInt(arg('--budget-ms', '60000'), 10);
  const comoJson = argv.includes('--json');
  const runsDir = arg('--runs-dir', path.join(stateDirOf(home), 'advisor-runs'));
  const opciones = { projectsDir, home, runsDir, env: process.env, codexDir: arg('--codex-dir', null), preciosPath: arg('--prices', null) };

  if (argv.includes('--run')) {
    const volcado = arg('--run', null);
    if (!volcado || !fs.existsSync(volcado)) {
      process.stderr.write('tokens-digest: --run necesita la ruta de un volcado que exista\n');
      return 2;
    }
    const r = procesarCorrida(volcado, opciones);
    process.stdout.write(comoJson ? `${JSON.stringify(r, null, 2)}\n` : resumenLegible([r]));
    // 🔴 No poder PERSISTIR sale ≠ 0: `marker.js`
    // llama a esto en CADA cierre del pipeline con la salida ignorada y sólo mira el código de
    // salida — con 0, creería que la corrida quedó rescatada mientras el volcado seguía sin `consumo`.
    // Un error al guardar el HILO, en cambio, ya quedó escrito adentro del volcado (`hilo.error`)
    // y el resumen sí se midió: ahí 0 es honesto, y ≠ 0 haría que marker.js pisara los tokens
    // reales con «no medido».
    return (r.error || r.no_persistido) ? 2 : 0;
  }

  const todas = argv.includes('--all');
  if (!todas && !argv.includes('--pending')) {
    process.stderr.write('tokens-digest: usá --run <volcado> | --pending | --all\n');
    return 2;
  }

  let volcados;
  try {
    volcados = fs.readdirSync(historyDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(historyDir, f))
      .sort();
  } catch (e) {
    process.stderr.write(`tokens-digest: no pude leer ${historyDir}: ${e.code || e.message}\n`);
    return 2;
  }

  const t0 = Date.now();
  const salida = {
    procesadas: [], salvadas: 0, sin_conversacion: 0, no_medidas: 0,
    rescatados: 0, bytes_hilo: 0, sin_tiempo: 0, no_persistidas: 0, total: volcados.length,
    revisores_medidos: 0, revisores_no_medidos: 0, revisores_separacion_rota: 0,
  };
  for (const v of volcados) {
    if (Date.now() - t0 > budgetMs) { salida.sin_tiempo += 1; continue; }
    // Un volcado que explota NO puede llevarse el barrido entero: son 230 y esto corre en cada
    // arranque de sesión. Se cuenta como «no medida» y se sigue con la siguiente.
    let r;
    try {
      if (!todas && !estaPendiente(v, projectsDir, opciones)) continue;
      r = procesarCorrida(v, opciones);
    } catch (e) {
      salida.procesadas.push(path.basename(v, '.json'));
      salida.no_medidas += 1;
      continue;
    }
    salida.procesadas.push(path.basename(v, '.json'));
    if (r.error) { salida.no_medidas += 1; continue; }
    // No poder ESCRIBIR no es lo mismo que no poder medir, y desde luego no es «salvada».
    if (r.no_persistido) { salida.no_persistidas += 1; continue; }
    const rv = r.revisores || {};
    if (rv.estado === 'medido' || rv.estado === 'parcial') salida.revisores_medidos += 1;
    else salida.revisores_no_medidos += 1;
    if (rv.separacion_ok === false) salida.revisores_separacion_rota += 1;
    const est = r.consumo && r.consumo.estado;
    if (est === 'borrada') salida.sin_conversacion += 1;
    else if (est === 'no_medido') salida.no_medidas += 1;
    else {
      salida.salvadas += 1;
      salida.rescatados += r.rescatados || 0;
      if (r.hilo && r.hilo.bytes) salida.bytes_hilo += r.hilo.bytes;
    }
  }
  process.stdout.write(comoJson ? `${JSON.stringify(salida, null, 2)}\n` : resumenBarrido(salida));
  return 0;
}

function resumenLegible(rs) {
  return rs.map((r) => {
    if (r.error) return `${path.basename(r.volcado)}: ${r.error}\n`;
    if (r.no_persistido) return `${path.basename(r.volcado)}: 🔴 ${r.no_persistido}\n`;
    const c = r.consumo || {};
    if (c.estado !== 'medido') return `${path.basename(r.volcado)}: ${c.estado} — ${c.motivo}\n`;
    const t = c.tokens;
    return `${path.basename(r.volcado)}: ${c.respuestas} respuestas · `
      + `${t.in} entrada / ${t.out} salida / ${t.cache_new} caché nueva / ${t.cache_read} caché leída · `
      + `hilo ${r.hilo && r.hilo.bytes ? `${Math.round(r.hilo.bytes / 1024)} KB` : 'no guardado'} · `
      + `${r.rescatados} mensaje(s) de error rescatado(s)`
      + (r.revisores ? ` · revisores: ${r.revisores.estado}${r.revisores.separacion_ok === false ? ' 🔴 SEPARACIÓN ROTA' : ''}` : '')
      + '\n';
  }).join('');
}

function resumenBarrido(s) {
  return `ejecuciones archivadas: ${s.total} · procesadas ahora: ${s.procesadas.length}\n`
    + `  salvadas (conversación viva): ${s.salvadas}\n`
    + `  sin conversación (ya se había borrado): ${s.sin_conversacion}\n`
    + `  no medidas (no pude mirar): ${s.no_medidas}\n`
    + (s.no_persistidas ? `  🔴 NO PUDE ESCRIBIR (se reintentan en el próximo arranque): ${s.no_persistidas}\n` : '')
    + `  mensajes de error rescatados: ${s.rescatados}\n`
    + `  hilo guardado: ${Math.round(s.bytes_hilo / 1048576)} MB\n`
    + `  revisores medidos (story 2.15): ${s.revisores_medidos} · no medidos: ${s.revisores_no_medidos}\n`
    + (s.revisores_separacion_rota ? `  🔴 con la separación medido/estimado ROTA: ${s.revisores_separacion_rota}\n` : '')
    + (s.sin_tiempo ? `  sin tiempo en este barrido (quedan para el próximo): ${s.sin_tiempo}\n` : '');
}

module.exports = {
  esRojo, normalizar, sanear, colaDeSalida, mensajesDeSalida, LARGO_MENSAJE, cortesDePaso, consumo, hilo, mensajesDeError,
  ventanaDelHilo, recortarAVentana, wholeSessionDuplicates, ubicarTranscripcion, carpetasDeConversaciones, leerTranscripcion, costo, leerPrecios, precioEn, indexarComandos, procesarCorrida, rescatarCorrida, encadenarMedidor, estaPendiente,
  esNotificacionEncolada, reducirErrorDeHook, CATEGORIAS_HOOK, TIPOS_DESCARTADOS,
};

if (require.main === module) {
  require('../lib/legacy-names.js').aliasArgv('scripts/metrics/tokens-digest.js', { exitCode: 2, prefix: 'tokens-digest: ' });
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`tokens-digest: ${e && e.stack ? e.stack : e}\n`);
    process.exit(2);
  }
}
