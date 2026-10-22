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
 *   1. El RESUMEN de consumo (tokens por modelo y por paso) → adentro del volcado, bajo `consumo`.
 *   2. El HILO de la conversación, comprimido → `<volcado sin .json>.hilo.jsonl.gz`, al lado.
 *   3. El MENSAJE REAL del error de cada freno en rojo → `gates[i].mensaje`.
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
// 381 KB, `file-history-snapshot` 60 KB, el resto son metadatos de la herramienta.
const TIPOS_DESCARTADOS = new Set([
  'attachment', 'file-history-snapshot', 'file-history-delta',
  'queue-operation', 'bridge-session', 'atis-latch', 'last-prompt', 'ai-title',
]);
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
    if (t === null) { out.fuera_de_ventana += nuevos; continue; }
    const corte = cortes.find((c) => t <= c.hasta);
    if (!corte) { out.fuera_de_ventana += nuevos; continue; }
    out.por_paso[corte.paso] = (out.por_paso[corte.paso] || 0) + nuevos;
  }
  return out;
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

/** Los mensajes del hilo: lo que se pidió, lo que se respondió y las herramientas. Sin adjuntos —
 *  salvo la notificación ENCOLADA de un agente, que sin esto se perdería (ver esNotificacionEncolada). */
function hilo(lineas) {
  return lineas.filter((o) => o && o.type && (!TIPOS_DESCARTADOS.has(o.type) || esNotificacionEncolada(o)));
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
  let carpetas;
  try {
    carpetas = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    return {
      estado: 'no_medido',
      motivo: `no pude leer la carpeta de conversaciones (${projectsDir}): ${e.code || e.message}`,
    };
  }
  for (const c of carpetas) {
    const p = path.join(projectsDir, c, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return { ruta: p };
  }
  return {
    estado: 'borrada',
    motivo: `la conversación de esta ejecución ya no está (Claude Code las borra según cleanupPeriodDays); se buscó ${sessionId}.jsonl en las ${carpetas.length} carpetas de conversaciones`,
  };
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

  const ubi = ubicarTranscripcion(sessionId, projectsDir);
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
    dump.consumo = { estado: ubi.estado, motivo: ubi.motivo, medido_en: new Date().toISOString() };
    res.consumo = dump.consumo;
    res.no_persistido = escribirVolcado(volcado, dump);
    return res;
  }

  const leido = leerTranscripcion(ubi.ruta);
  if (leido.error) {
    dump.consumo = { estado: 'no_medido', motivo: leido.error, medido_en: new Date().toISOString() };
    res.consumo = dump.consumo;
    res.no_persistido = escribirVolcado(volcado, dump);
    return res;
  }

  const cortes = cortesDePaso(marker.stepTimings);
  const c = consumo(leido.lineas, cortes);
  c.lineas_ilegibles = leido.ilegibles;
  c.medido_en = new Date().toISOString();
  dump.consumo = c;
  res.consumo = c;

  // El hilo. Se reescribe entero: idempotente sobre la misma entrada, actualizado si creció.
  const mensajes = hilo(leido.lineas);
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
    // 🔴 `hilo_hasta` SÓLO avanza si el archivo llegó a escribirse. Si se fijara con lo leído de la
    // transcripción, sin mirar el resultado de la escritura, con el disco lleno o un permiso mal ese
    // tramo de conversación se perdería PARA SIEMPRE —`estaPendiente` lo daría por resuelto— y el barrido lo
    // contaría como salvado. Un número diciendo «todo bien» sobre algo que no se guardó.
    // Y se calcula sobre los MENSAJES que entran al archivo, no sobre todas las líneas: si la
    // última fuera un adjunto (que se descarta), avanzaría sin haber guardado ese contenido.
    c.hilo_hasta = ultimaHora(mensajes);
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

/**
 * ¿Esta corrida necesita que se le pase el rescate?
 * Sí si nunca se le pasó, o si su conversación CRECIÓ desde la última vez — que es el caso del
 * cierre truncado: el archivador corre en el `clear` y después el pipeline sigue hablando.
 * No si su conversación ya no está y eso quedó anotado: volver a mirarla no la trae de vuelta.
 */
function estaPendiente(volcado, projectsDir) {
  let dump;
  try { dump = JSON.parse(fs.readFileSync(volcado, 'utf8')); } catch { return false; }
  const c = dump.consumo;
  if (!c) return true;
  // Sin bloque `revisores` también está pendiente: el medidor lo escribe SIEMPRE (medido o
  // con motivo), así que esto pasa una sola vez por corrida — no se reprocesa para siempre.
  if (!dump.revisores) return true;
  if (c.estado === 'borrada') return false;
  if (c.estado === 'no_medido') return true;
  const sid = (dump.marker || {}).sessionId;
  const ubi = ubicarTranscripcion(sid, projectsDir);
  if (!ubi.ruta) return false;
  const leido = leerTranscripcion(ubi.ruta);
  if (leido.error) return false;
  // La MISMA vara que usó `procesarCorrida` para escribir `hilo_hasta`: los mensajes que entran al
  // archivo, no todas las líneas. Con dos varas distintas nunca coincidirían y se reprocesaría siempre.
  const ultima = ultimaHora(hilo(leido.lineas));
  // Sin `hilo_hasta` sólo vale la pena volver si hay algo con hora: una conversación sin una
  // sola marca de tiempo se re-procesaría en cada arranque, para siempre, sin cambiar nada.
  if (!c.hilo_hasta) return ultima !== null;
  return ultima !== null && ms(ultima) > ms(c.hilo_hasta);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const arg = (n, def) => {
    const i = argv.indexOf(n);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const home = os.homedir();
  const projectsDir = arg('--projects-dir', path.join(home, '.claude', 'projects'));
  const historyDir = arg('--history-dir', path.join(stateDirOf(home), 'timing-history'));
  const budgetMs = parseInt(arg('--budget-ms', '60000'), 10);
  const comoJson = argv.includes('--json');
  const runsDir = arg('--runs-dir', path.join(stateDirOf(home), 'advisor-runs'));
  const opciones = { projectsDir, home, runsDir };

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
      if (!todas && !estaPendiente(v, projectsDir)) continue;
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
  ubicarTranscripcion, leerTranscripcion, indexarComandos, procesarCorrida, rescatarCorrida, encadenarMedidor, estaPendiente,
  esNotificacionEncolada,
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
