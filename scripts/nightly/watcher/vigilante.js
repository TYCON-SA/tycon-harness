#!/usr/bin/env node
/**
 * vigilante.js — el vigilante de producción del arnés TYCON.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * El arnés vigila cómo se FABRICA el software. Lo que está entregado y corriendo lo vigila un
 * humano: los incidentes de producción los detecta una persona
 * — un gestor, un supervisor, un usuario, el dev usando la app — y muchas veces
 * el dato ya está en una tabla antes de que alguien avise.
 *
 * Las alertas de Azure avisan QUE algo pasó. Esto hace lo que ninguna alerta hace: entra
 * a mirar POR QUÉ, agrupa la evidencia y deja un borrador para que a la mañana una persona decida.
 *
 * 🔴 **Sin humano en el disparo, con humano en toda acción.** Detecta, diagnostica y propone.
 * No reinicia, no despliega, no revierte, no crea work items. Todo lo que hace es leer y escribir
 * un borrador en este repo.
 *
 * ── LA FRONTERA CON LAS ALERTAS DE AZURE (regla permanente) ─────────────────────────────────────
 * Si un problema se puede expresar como "una métrica que Azure ya tiene cruzó un número", NO es de
 * esta pieza: es una alerta de Azure que falta crear. Lo que vive acá es lo SUB-UMBRAL: por
 * ejemplo, 8 errores en 2 horas, u 11 en 7 días — ninguno llega al "más de
 * 5 en 5 minutos" que dispara la alerta. Esta pieza y las alertas de Azure no se solapan.
 *
 * ── QUÉ LEE ─────────────────────────────────────────────────────────────────────────────────────
 * Sólo la API de administración del host Bizuit, con las credenciales que YA usan los pipelines de
 * deploy (`BIZEXT_<PROD>_USER/PASS`). No hay conexión de servicio a Azure en la organización,
 * así que Application Insights queda fuera de v1 con su gatillo declarado.
 *
 * Uso:
 *   node vigilante.js run    [--config <hosts.json>] [--fixture <dir>] [--out <dir>] [--pending <dir>] [--json] [--dry-run]
 *   node vigilante.js report [--pending <dir>] [--json]
 *   node vigilante.js note   --card <borrador> [--pr <n>] [--pr-closed <fecha>]
 *                            [--rejected <fecha> --reason <texto> --pr <n>] [--clear-rejection]
 * Exit: 0 siempre en `run` salvo error de uso — un problema de producción NO es un pipeline rojo;
 *       lo que no se pudo consultar se REPORTA (nunca se calla: una noche sin datos no puede
 *       parecerse a una noche tranquila).
 *
 * ── APAGADO DE FÁBRICA ──────────────────────────────────────────────────────────────────────────
 * El arnés publicado no trae ninguna configuración: qué hosts se miran, con qué credenciales y con
 * qué umbrales es un dato de cada organización, y vive en su repo de operaciones. Sin `--config` y
 * sin un `hosts.json` al lado de este guion, `run` no mira nada, lo dice en una línea y sale 0 sin
 * escribir. Con `--config` dada y un archivo que no se puede leer, sale 1: quien lo prendió espera
 * que mire. La forma del archivo (las claves de los umbrales, con su porqué, y una entrada por
 * producto: `{ "id", "url", "env_user", "env_pass", "plugins": [], "activo": true }`, donde
 * `env_user`/`env_pass` NOMBRAN las variables de entorno con las credenciales, nunca las traen) la
 * fija `scripts/tests/vigilante.test.js`. El pipeline que lo corre de noche, la cola de borradores
 * (`inbox/watcher/`) y el aviso los pone la organización.
 */
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// El guion vive en scripts/nightly/watcher/, tres niveles bajo la raíz del repo
const RAIZ = path.resolve(__dirname, '..', '..', '..');
const CONFIG_DEF = path.join(__dirname, 'hosts.json');
const OUT_DEF = path.join(RAIZ, '.dashboard', 'vigilante');
// La cola de borradores vive en inbox/watcher/; la foto de la noche, en .dashboard/vigilante/
const PENDING_DEF = path.join(RAIZ, 'inbox', 'watcher');

// ── utilidades ─────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = {
    cmd: argv[2] || 'help',
    config: CONFIG_DEF, fixture: null, out: OUT_DEF, pending: PENDING_DEF,
    json: false, dryRun: false, hoy: null,
    ficha: null, pr: null, rechazado: null, motivo: null, prCerrado: null, quitarRechazo: false,
  };
  for (let i = 3; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--config') { a.config = path.resolve(argv[++i]); a.configGiven = true; }
    else if (v === '--fixture') a.fixture = path.resolve(argv[++i]);
    else if (v === '--out') a.out = path.resolve(argv[++i]);
    else if (v === '--pending') a.pending = path.resolve(argv[++i]);
    else if (v === '--draft') a.borrador = path.resolve(argv[++i]);
    else if (v === '--today') a.hoy = argv[++i]; // sólo para tests: fija la fecha de la corrida
    // `note`: lo único que escribe el borrador desde afuera de una corrida. Lo llama
    // scripts/ci/open-pr-per-finding.sh, que no conoce el formato de ninguna de las dos colas.
    else if (v === '--card') a.ficha = path.resolve(argv[++i]);
    else if (v === '--pr') a.pr = argv[++i];
    else if (v === '--rejected') a.rechazado = argv[++i];
    else if (v === '--reason') a.motivo = argv[++i];
    else if (v === '--pr-closed') a.prCerrado = argv[++i];
    else if (v === '--clear-rejection') a.quitarRechazo = true;
    else if (v === '--json') a.json = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--help' || v === '-h') a.cmd = 'help';
  }
  return a;
}

const leerJson = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };

/** Mediana de una lista de números. `null` si está vacía — nunca 0 (0 es un dato, vacío es un hueco). */
function mediana(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/**
 * Normaliza el mensaje de error para agrupar. Colapsa números, GUIDs y comillas: así
 * "Timeout expired (id 4471)" y "(id 9982)" son EL MISMO problema — sin esto cada error es único
 * y no hay línea base posible.
 */
function normalizarMensaje(msg) {
  return String(msg || '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/['"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** La huella que agrupa: es lo que permite deduplicar, contar recurrencia y medir la pieza. */
function huella(producto, plugin, endpoint, estado, mensaje) {
  const base = [producto, plugin || '?', endpoint || '?', estado, normalizarMensaje(mensaje)].join('|');
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 8);
}

/** `v`, o `d` si `v` es null o undefined (sin `??`: este guion lo tiene que poder leer un Node viejo). */
function nn(v, d) { return v === undefined || v === null ? d : v; }

/** Campo tolerante a mayúsculas/minúsculas: la API puede devolver PascalCase o camelCase. */
function campo(obj, ...nombres) {
  for (const n of nombres) {
    if (obj == null) return undefined;
    if (obj[n] !== undefined) return obj[n];
    const k = Object.keys(obj).find((x) => x.toLowerCase() === n.toLowerCase());
    if (k) return obj[k];
  }
  return undefined;
}

function normalizarEjecucion(row) {
  return {
    ts: campo(row, 'executedAt', 'ExecutedAt', 'ts') || null,
    plugin: campo(row, 'pluginName', 'PluginName', 'plugin') || null,
    endpoint: campo(row, 'endpoint', 'Endpoint') || null,
    metodo: campo(row, 'httpMethod', 'HttpMethod') || null,
    estado: Number(campo(row, 'statusCode', 'StatusCode')) || 0,
    duracionMs: Number(campo(row, 'durationMs', 'DurationMs')) || null,
    mensaje: campo(row, 'errorMessage', 'ErrorMessage') || '',
    usuario: campo(row, 'username', 'Username') || null,
    ip: campo(row, 'clientIp', 'ClientIp') || null,
  };
}

/**
 * 🔴 Lo que sale de producción NO se escribe crudo. Este borrador se COMMITEA a un repo del equipo
 * y su resumen viaja por Telegram: un mensaje de error de producción trae lo que trae — cadenas de
 * conexión, "Login failed for user 'x'", correos, pedazos del payload del cliente. La política del
 * repo es explícita: acá no vive ninguna credencial, ni siquiera de prueba.
 *
 * Por eso lo que se persiste es el mensaje NORMALIZADO (que es además el que agrupa), con los
 * patrones peligrosos tachados. El crudo no se guarda: si hace falta, está en el host, que es donde
 * corresponde.
 */
const PATRONES_SENSIBLES = [
  [/(password|pwd|pass|secret|token|apikey|api[-_]?key|authorization)\s*[=:]\s*[^\s;,)"']+/gi, '$1=<tachado>'],
  [/(user\s*id|uid|initial catalog|data source|server)\s*=\s*[^\s;,)"']+/gi, '$1=<tachado>'],
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '<correo>'],
  [/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>'],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'bearer <tachado>'],
];
function tachar(texto) {
  let t = String(texto || '');
  for (const [re, rep] of PATRONES_SENSIBLES) t = t.replace(re, rep);
  return t;
}
/** Identidad de un usuario o IP: se guarda un seudónimo estable, no el dato. Sirve para agrupar
 *  ("todos los errores son del mismo") sin publicar de quién se trata. */
function seudonimo(valor) {
  if (!valor) return null;
  return `#${crypto.createHash('sha1').update(String(valor)).digest('hex').slice(0, 6)}`;
}

// ── lectura de la fuente ────────────────────────────────────────────────────────────────────────

/**
 * GET con token. Devuelve `{ok, data}` o `{ok:false, motivo}` — NUNCA lanza: un producto que no se
 * pudo consultar es un dato ("no medido, con motivo"), no un pipeline roto.
 */
function pedir(url, token, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.request(url, {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' },
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, motivo: `HTTP ${res.statusCode}` });
          try { resolve({ ok: true, data: JSON.parse(body) }); }
          catch { resolve({ ok: false, motivo: 'respuesta no es JSON' }); }
        });
      });
    } catch (e) { return resolve({ ok: false, motivo: String(e.message).slice(0, 120) }); }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, motivo: `timeout ${timeoutMs}ms` }); });
    req.on('error', (e) => resolve({ ok: false, motivo: String(e.message).slice(0, 120) }));
    req.end();
  });
}

function postLogin(baseUrl, user, pass, timeoutMs = 20000) {
  return new Promise((resolve) => {
    // El contrato del host: AdminLoginRequest(Username, Password, TenantId='default').
    const cuerpo = JSON.stringify({ username: user, password: pass, tenantId: 'default' });
    let req;
    try {
      // 🔴 La ruta real es `api/auth/login` (AuthenticationController), no `api/admin/login`:
      // esa devuelve 404 en los hosts.
      req = https.request(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) },
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, motivo: `login HTTP ${res.statusCode}` });
          try {
            const d = JSON.parse(body);
            // AdminLoginResponse(Success, Token, User, Error): un 200 con Success=false ES un
            // login fallido, no un éxito silencioso.
            const ok = campo(d, 'success', 'Success');
            const t = campo(d, 'token', 'Token', 'admin_token', 'accessToken');
            if (ok === false) return resolve({ ok: false, motivo: `login rechazado: ${campo(d, 'error', 'Error') || 'sin detalle'}` });
            resolve(t ? { ok: true, token: t } : { ok: false, motivo: 'login sin token en la respuesta' });
          } catch { resolve({ ok: false, motivo: 'login: respuesta no es JSON' }); }
        });
      });
    } catch (e) { return resolve({ ok: false, motivo: String(e.message).slice(0, 120) }); }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, motivo: `login timeout ${timeoutMs}ms` }); });
    req.on('error', (e) => resolve({ ok: false, motivo: String(e.message).slice(0, 120) }));
    req.write(cuerpo); req.end();
  });
}

/**
 * Trae lo de un producto. Con `--fixture` lee de disco en vez de la red: es lo que hace que la
 * pieza tenga casos en el banco sin depender de producción ni de credenciales.
 */
async function traerProducto(prod, cfg, fixtureDir, desdeIso) {
  if (fixtureDir) {
    const f = path.join(fixtureDir, `${prod.id}.json`);
    const d = leerJson(f, null);
    if (!d) return { ok: false, motivo: `fixture ausente: ${path.basename(f)}` };
    return {
      ok: true,
      ejecuciones: (d.ejecuciones || []).map(normalizarEjecucion),
      salud: d.salud || {},
      stats: d.stats || {},
      totales: d.totales || {},
      fuente: d.fuente || ((d.ejecuciones || []).length ? 'ejecuciones' : 'stats'),
      degradada: d.degradada || null,
      hostLogs: d.hostLogs === undefined ? null : d.hostLogs,
      tablaLeida: d.tablaLeida !== false,
    };
  }
  const user = process.env[prod.env_user];
  const pass = process.env[prod.env_pass];
  if (!user || !pass) return { ok: false, motivo: `faltan credenciales (${prod.env_user}/${prod.env_pass})` };
  // Un solo login por producto: el host limita a 5 intentos por minuto (medido en producción).
  const login = await postLogin(prod.url, user, pass);
  if (!login.ok) return { ok: false, motivo: login.motivo };
  const T = login.token;

  // 1) Los plugins los da el HOST. Un plugin caído normalmente no recibe pedidos, así que
  //    deducirlos de los errores dejaría ciega justo a la regla que existe para verlo.
  const cargados = await pedir(`${prod.url}/api/admin/plugins/loaded`, T);
  const lista = cargados.ok
    ? (Array.isArray(cargados.data) ? cargados.data : (cargados.data.items || cargados.data.data || []))
    : [];
  const plugins = lista.map((p) => ({ id: campo(p, 'pluginId', 'PluginId', 'id'), nombre: campo(p, 'name', 'Name') }))
    .filter((p) => p.id != null);

  // 2) Salud y estadísticas POR PLUGIN — las dos fuentes que hoy funcionan de verdad.
  const salud = {}; const stats = {};
  if (!cargados.ok) salud.__lista = `no medido — no se pudo listar los plugins del host (${cargados.motivo})`;
  for (const p of plugins) {
    const h = await pedir(`${prod.url}/api/admin/plugins/${p.id}/health`, T);
    salud[p.nombre] = h.ok
      ? { estado: campo(h.data, 'status', 'Status') || 'desconocido',
          ultimoPedido: campo(h.data, 'lastRequestAt', 'LastRequestAt') || null,
          pedidos: nn(campo(h.data, 'requestCount', 'RequestCount'), null) }
      : `no medido — ${h.motivo}`;
    const st = await pedir(`${prod.url}/api/admin/plugins/${p.id}/executions/stats?days=1`, T);
    if (st.ok) {
      stats[p.nombre] = {
        total: nn(campo(st.data, 'totalExecutions', 'TotalExecutions'), null),
        fallidos: nn(campo(st.data, 'failedExecutions', 'FailedExecutions'), null),
        porCodigo: campo(st.data, 'executionsByStatusCode', 'ExecutionsByStatusCode') || {},
        porEndpoint: campo(st.data, 'executionsByEndpoint', 'ExecutionsByEndpoint') || {},
        duracionMediaMs: nn(campo(st.data, 'averageDurationMs', 'AverageDurationMs'), null),
      };
    }
  }

  // 3) La fuente RICA (una fila por error, con mensaje y usuario). Hoy el host devuelve la lista
  //    vacía con un total distinto de cero: la consulta filtra por inquilino y el conteo no, y las
  //    filas se guardan con el inquilino que manda una cabecera del llamador — así que ningún
  //    inquilino matchea. Está reportado. Acá NO se asume: se detecta cada noche y se declara.
  //    El día que lo arreglen, el vigilante lo nota solo y recupera deriva y desagregación.
  const TOPE = 500;
  const ej = await pedir(`${prod.url}/api/admin/executions?onlyErrors=true&fromDate=${encodeURIComponent(desdeIso)}&limit=${TOPE}`, T);
  let filas = []; let fuente = 'stats'; let degradada = null;
  if (!ej.ok) {
    degradada = `no se pudo leer el detalle de errores (${ej.motivo}) — quedan sólo estadísticas y salud`;
  } else {
    const crudas = Array.isArray(ej.data) ? ej.data : (ej.data.data || ej.data.items || ej.data.value || []);
    const total = nn(ej.data && nn(ej.data.total, ej.data.Total), null);
    if (crudas.length) { filas = crudas.map(normalizarEjecucion); fuente = 'ejecuciones'; }
    else if (total) {
      // El total del host cuenta desde 400 (su `onlyErrors` es >= 400), así que NO es comparable
      // con el conteo de 5xx de las estadísticas. Decirlo evita que dos números distintos para
      // cosas distintas se lean como una contradicción.
      degradada = `el host dice ${total} pedidos con error (cuenta desde 400) y devuelve la lista vacía: es el bug de inquilino del host, ya reportado. Sin el detalle por pedido no hay mensaje ni usuario, así que deriva y desagregación no se pueden evaluar`;
    }
  }
  const truncado = filas.length >= TOPE ? `sólo se leyeron los primeros ${TOPE} errores: puede haber más` : null;

  const hl = await pedir(`${prod.url}/api/admin/host-logs/stats?lastDays=1`, T);
  return {
    ok: true, ejecuciones: filas, salud, stats, fuente, degradada, truncado, tablaLeida: ej.ok,
    hostLogs: hl.ok ? hl.data : null, hostLogsMotivo: hl.ok ? null : hl.motivo,
  };
}

// ── las reglas ─────────────────────────────────────────────────────────────────────────────────

/**
 * ¿Azure ya avisó de esto? Se calcula sobre nuestros PROPIOS datos (más de N errores en cualquier
 * ventana de 5 minutos = la alerta `*-Http5xxBurst` ya sonó), porque la API de alertas de Azure no
 * es alcanzable sin conexión de servicio. Un hallazgo así NO suena y NO gasta presupuesto: el
 * diagnóstico se adjunta como complemento del mail que el equipo ya recibió.
 */
function yaAlertadoPorAzure(filas, umbralRafaga) {
  const ts = filas.map((f) => Date.parse(f.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  for (let i = 0; i < ts.length; i++) {
    let n = 0;
    for (let j = i; j < ts.length && ts[j] - ts[i] <= 5 * 60 * 1000; j++) n++;
    if (n > umbralRafaga) return true;
  }
  return false;
}

/**
 * Evalúa las cuatro reglas de un producto. PURA (no toca disco ni red): es lo que la hace testeable
 * y lo que permite reproducir incidentes históricos contra datos reales.
 */
function evaluar({ producto, ejecuciones, salud, stats, totales, base, cfg, modoFrio, fuente, ahoraIso }) {
  const hallazgos = [];
  const errores = ejecuciones.filter((e) => e.estado >= 500);
  const piso = cfg.umbral_piso;
  // Informativo a nivel producto (va al snapshot). 🔴 NO se usa para silenciar: la marca de "de
  // esto Azure ya avisó" se decide POR GRUPO más abajo. Estamparla en todos los hallazgos
  // del producto haría que una ráfaga en un endpoint tapara del aviso a un plugin caído que no
  // tiene nada que ver.
  const rafagaAzure = yaAlertadoPorAzure(errores, cfg.umbral_rafaga_azure);

  // (1) SALUD — un plugin caído es hallazgo directo, sin línea base. Corre incluso en modo frío:
  // es la única señal que no necesita historia para significar algo.
  for (const [plugin, info] of Object.entries(salud || {})) {
    if (plugin === '__lista') continue;
    const estado = (info && typeof info === 'object') ? info.estado : info;
    const s = String(estado).toLowerCase();
    if (s.startsWith('no medido')) continue;
    if (!['running', 'healthy', 'ok'].includes(s)) {
      hallazgos.push({
        regla: 'salud', producto, plugin, endpoint: null,
        huella: huella(producto, plugin, 'health', 'health', s),
        severidad: 'alta',
        // Explícito y no por omisión: un plugin caído JAMÁS hereda la ráfaga de otro endpoint.
        // Azure no alerta por esto — si se lo dejara implícito, cualquier refactor futuro podría
        // silenciarlo sin que se note.
        ya_alertado: false,
        senal: { estado_plugin: estado },
        diagnostico: `El host reporta el plugin "${plugin}" en estado "${estado}". "Subido" no es "corriendo": el deploy termina en upload+activate sin verificarlo.`,
      });
    }
  }
  // (1b) LATIDO — un plugin que venía recibiendo pedidos y hoy no recibe ninguno. Es lo único que
  // ve el caso de un gateway que "late" y no atiende: la salud dice Running.
  for (const [plugin, info] of Object.entries(salud || {})) {
    if (plugin === '__lista' || !info || typeof info !== 'object' || !info.ultimoPedido) continue;
    const horas = (Date.parse(ahoraIso || new Date().toISOString()) - Date.parse(info.ultimoPedido)) / 3600000;
    if (Number.isFinite(horas) && horas >= cfg.horas_sin_pedidos) {
      hallazgos.push({
        regla: 'latido', producto, plugin, endpoint: null, ya_alertado: false,
        huella: huella(producto, plugin, 'latido', 'latido', 'sin pedidos'),
        severidad: 'media',
        senal: { horas_sin_pedidos: Math.round(horas), ultimo_pedido: info.ultimoPedido, pedidos_historicos: info.pedidos },
        diagnostico: `El plugin "${plugin}" no recibe un pedido desde hace ${Math.round(horas)} h (último: ${info.ultimoPedido}). Su salud dice "${info.estado}": está vivo y no lo está usando nadie — o dejó de atender sin decirlo.`,
        evidencia: [],
      });
    }
  }

  if (modoFrio) return { hallazgos, rafagaAzure, modo: 'solo-linea-base' };

  // (2b) GOTEO POR ESTADÍSTICAS — el camino cuando el host no entrega el detalle de cada error.
  // Más grueso (no hay mensaje ni usuario, así que agrupa por plugin y código de estado), pero es
  // real y hoy es lo único que hay. Cuando el host devuelva las filas, manda la regla fina.
  if (fuente !== 'ejecuciones') {
    for (const [plugin, st] of Object.entries(stats || {})) {
      for (const [codigo, cant] of Object.entries(st.porCodigo || {})) {
        if (Number(codigo) < 500 || !cant) continue;
        const fp = huella(producto, plugin, `codigo-${codigo}`, codigo, 'stats');
        const m = base[fp] === undefined ? null : base[fp];
        const umbral = Math.max(piso, Math.ceil(cfg.factor * (m || 0)));
        if (cant < umbral) continue;
        hallazgos.push({
          regla: m === null || m === 0 ? 'deriva' : 'goteo', producto, plugin, endpoint: null, ya_alertado: false,
          huella: fp, origen: 'stats', severidad: cant >= umbral * 2 ? 'alta' : 'media',
          senal: { errores: cant, estado_http: Number(codigo), total_pedidos: st.total, linea_base_mediana: m, umbral_aplicado: umbral },
          diagnostico: `${cant} × ${codigo} en el plugin "${plugin}" en 24 h sobre ${nn(st.total, '?')} pedidos (mediana previa ${m === null ? 'sin historia' : m}, umbral ${umbral}). Sin el detalle por pedido no se puede decir en qué endpoint ni con qué mensaje: el host no lo está entregando.`,
          evidencia: [],
        });
      }
    }
  }

  // Agrupación por huella
  const grupos = new Map();
  for (const e of errores) {
    const fp = huella(producto, e.plugin, e.endpoint, e.estado, e.mensaje);
    if (!grupos.has(fp)) grupos.set(fp, { fp, plugin: e.plugin, endpoint: e.endpoint, estado: e.estado, filas: [] });
    grupos.get(fp).filas.push(e);
  }

  for (const g of grupos.values()) {
    const n = g.filas.length;
    const m = base[g.fp] === undefined ? null : base[g.fp];
    const umbral = Math.max(piso, Math.ceil(cfg.factor * (m || 0)));
    const total = nn(totales[`${g.plugin}|${g.endpoint}`], null);

    // (2) DERIVA — un tipo de error que NUNCA se había visto. La señal más limpia del corpus
    // (por ejemplo, una MissingMethodException nueva tras un update del framework).
    const esNuevo = m === null || m === 0;
    // (3) GOTEO — persistente por debajo del umbral de ráfaga de Azure.
    const esGoteo = n >= umbral;

    // Cada grupo decide POR SÍ MISMO si ya fue alertado por Azure (ver arriba).
    const grupoYaAlertado = yaAlertadoPorAzure(g.filas, cfg.umbral_rafaga_azure);

    if (esNuevo && n >= piso) {
      hallazgos.push(armar(g, 'deriva', 'alta', n, m, umbral, total, producto,
        `Tipo de error NUEVO: ${n} × ${g.estado} con un mensaje que no aparece en los ${cfg.ventana_linea_base_dias} días previos.`, grupoYaAlertado));
    } else if (esGoteo) {
      hallazgos.push(armar(g, 'goteo', n >= umbral * 2 ? 'alta' : 'media', n, m, umbral, total, producto,
        `${n} × ${g.estado} en la ventana (mediana previa ${m}, umbral ${umbral}).`, grupoYaAlertado));
    } else {
      // (4) DESAGREGACIÓN — el total está sano pero una rebanada concentra los errores.
      // Por ejemplo, una cuenta de servicio pierde un permiso y sólo ella falla; todo lo
      // que Azure mira dice "bien".
      // 🔴 UN solo hallazgo por grupo: usuario e IP suelen ser la misma persona, y como los dos
      // comparten la huella, el segundo borrador PISARÍA al primero.
      let reportado = false;
      for (const dim of ['usuario', 'ip']) {
        if (reportado) break;
        const porDim = new Map();
        for (const f of g.filas) { const k = f[dim] || '(sin dato)'; porDim.set(k, (porDim.get(k) || 0) + 1); }
        for (const [k, cnt] of porDim) {
          if (k === '(sin dato)') continue;
          if (cnt >= piso && cnt / n >= cfg.concentracion_min) {
            // El dato identificatorio va SEUDONIMIZADO: alcanza para decir "son todos el mismo",
            // que es la señal, sin publicar de quién se trata en un repo y en Telegram.
            hallazgos.push(armar(g, 'desagregacion', 'media', n, m, umbral, total, producto,
              `${cnt} de ${n} errores concentrados en un solo ${dim} (${seudonimo(k)}, ${Math.round(100 * cnt / n)}%). El total del endpoint no llama la atención; la rebanada sí.`, grupoYaAlertado));
            reportado = true;
            break;
          }
        }
      }
    }
  }
  return { hallazgos, rafagaAzure, modo: 'normal' };
}

function armar(g, regla, severidad, n, m, umbral, total, producto, diagnostico, yaAlertado) {
  return {
    regla, producto, plugin: g.plugin, endpoint: g.endpoint, huella: g.fp, severidad, origen: 'ejecuciones',
    ya_alertado: !!yaAlertado,
    senal: {
      errores: n,
      total_pedidos: total,
      linea_base_mediana: m,
      umbral_aplicado: umbral,
      estado_http: g.estado,
    },
    diagnostico,
    // La evidencia va TACHADA y con el usuario seudonimizado: esto se commitea a un repo del
    // equipo. Lo crudo sigue en el host, que es donde corresponde que esté.
    evidencia: g.filas.slice(0, 10).map((f) => ({
      ts: f.ts, estado: f.estado, duracion_ms: f.duracionMs,
      usuario: seudonimo(f.usuario), mensaje: tachar(f.mensaje).slice(0, 200),
    })),
  };
}

// ── borradores (el ciclo de vida por archivo ES el contador) ────────────────────────────────────

const CARPETAS = ['pending', 'promoted', 'archived'];

function listarBorradores(pendingDir) {
  const out = [];
  for (const c of CARPETAS) {
    const d = path.join(pendingDir, c);
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.yaml')); } catch { continue; }
    for (const f of files) {
      const texto = fs.readFileSync(path.join(d, f), 'utf8');
      out.push({ carpeta: c, archivo: path.join(d, f), texto, campos: camposDe(texto) });
    }
  }
  return out;
}

/** Lector mínimo de los campos escalares del borrador — mismo espíritu que el resto del arnés. */
function camposDe(texto) {
  const g = (k) => { const m = texto.match(new RegExp(`^${k}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm')); return m ? m[1] : null; };
  return {
    id: g('id'), fecha: g('fecha'), producto: g('producto'), regla: g('regla'),
    huella: g('huella'), veredicto: g('veredicto'), severidad: g('severidad'),
    vista_por_ultima_vez: g('vista_por_ultima_vez'), noches_seguidas: Number(g('noches_seguidas')) || 1,
    // `null` es el valor vacío del sello, no una fecha: sin este colapso un borrador recién
    // escrito parecería ya recordado y el recordatorio no sonaría NUNCA.
    // El renglón que escribe escribirBorrador lleva un comentario (`null  # la noche en que…`): se corta antes.
    recordado_el: ((s) => (!s || s === 'null' ? null : s))((g('recordado_el') || '').replace(/\s+#.*$/, '').trim()),
    plugin: g('plugin'), endpoint: g('endpoint'), origen: g('origen'),
    // El diagnóstico se escribe con JSON.stringify y suele traer comillas ADENTRO (el nombre del
    // plugin va entrecomillado), así que el lector escalar de arriba lo devolvería vacío — y el PR
    // saldría con el título mocho y "(sin diagnóstico)" en el cuerpo.
    diagnostico: leerTexto(texto, 'diagnostico'),
  };
}

/** Un campo de texto largo del YAML: escrito con JSON.stringify, se lee con JSON.parse. */
function leerTexto(texto, clave) {
  const m = texto.match(new RegExp(`^${clave}:\\s*(.+)$`, 'm'));
  if (!m) return null;
  const crudo = m[1].trim();
  if (!crudo.startsWith('"')) return crudo;
  try { return JSON.parse(crudo); } catch { return crudo.replace(/^"|"$/g, ''); }
}

function escribirBorrador(dir, h, fecha, extra) {
  fs.mkdirSync(dir, { recursive: true });
  const id = `${fecha}-${h.producto}-${h.huella}`;
  const p = path.join(dir, `${id}.yaml`);
  const y = [
    '# Borrador del vigilante de producción — NO es una story.',
    '# Sin `story:` ni `approach:` a propósito: un `story:` en el frontmatter lo bloquea',
    '# story-skill-gate y un `approach:` dispara el recordatorio de work item en ADO.',
    '# Se convierte en story SÓLO por decisión humana: /tycon-vigilante approve <id>',
    `id: "${id}"`,
    // una ficha del ciclo de la noche (scripts/nightly/findings/): la causa es la huella del hallazgo
    'fuente: "vigilante"',
    `causa: "${h.huella}"`,
    `fecha: "${fecha}"`,
    `producto: "${h.producto}"`,
    `regla: "${h.regla}"`,
    `severidad: "${h.severidad}"`,
    `huella: "${h.huella}"`,
    `plugin: ${JSON.stringify(h.plugin || null)}`,
    `endpoint: ${JSON.stringify(h.endpoint || null)}`,
    // de qué datos salió: las filas de detalle o las estadísticas por código (el control de las noches lo necesita)
    ...(h.origen ? [`origen: "${h.origen}"`] : []),
    'senal:',
    ...Object.entries(h.senal).map(([k, v]) => `  ${k}: ${v === null ? 'null' : JSON.stringify(v)}`),
    `diagnostico: ${JSON.stringify(h.diagnostico)}`,
    ...(extra && extra.ultimoDeploy ? [`ultimo_deploy: ${JSON.stringify(extra.ultimoDeploy)}`] : []),
    ...(extra && extra.yaAlertado ? ['ya_alertado_por_azure: true  # no suena: complementa el mail que el equipo ya recibió'] : []),
    'evidencia:',
    ...(h.evidencia || []).map((e) => `  - ${JSON.stringify(e)}`),
    // 🔴 El hecho ya se decidió y volvió después del silencio. La marca viaja al borrador y al
    // snapshot: sin ella nadie —ni la persona que lo
    // recibe, ni el pull request— puede distinguir un hecho nuevo de uno que ya se descartó una
    // vez. Con `note --rejected` archivando fichas, esa diferencia es lo que
    // explica por qué algo que "ya se había decidido" está pidiendo decisión de nuevo.
    ...(h.reincidente ? ['reincidente:',
      `  desde: "${h.reincidente.desde}"`,
      `  veredicto_previo: ${h.reincidente.veredicto_previo}`] : []),
    '',
    '# ── Lo que decide la persona que lo lee ──────────────────────────────────────────────',
    '# util       → terminó en trabajo real (approve lo mueve a promoted/ y crea la story)',
    '# descartado → no servía; el motivo es OBLIGATORIO y alimenta la calibración',
    '# ignorado   → nadie lo tocó en 7 días. Cuenta PEOR que descartado: el fracaso que',
    '#              perseguimos no es equivocarse, es que a nadie le importe.',
    'veredicto: pendiente',
    'motivo: null',
    `vista_por_ultima_vez: "${fecha}"`,
    'noches_seguidas: 1',
    'recordado_el: null  # la noche en que se avisó que este borrador lleva días sin decisión (una sola vez)',
    '',
  ].join('\n');
  fs.writeFileSync(p, y, 'utf8');
  return p;
}

/** Un hallazgo repetido NO crea un segundo borrador: actualiza el que ya está abierto. */
function actualizarRepetido(b, fecha) {
  let t = b.texto;
  const n = (Number(b.campos.noches_seguidas) || 1) + 1;
  t = t.replace(/^vista_por_ultima_vez:.*$/m, `vista_por_ultima_vez: "${fecha}"`);
  t = t.replace(/^noches_seguidas:.*$/m, `noches_seguidas: ${n}`);
  fs.writeFileSync(b.archivo, t, 'utf8');
  return n;
}

/**
 * Los borradores que llevan días esperando una decisión.
 *
 * 🔴 Por qué existe: el aviso nocturno sólo suena por hallazgos NUEVOS, así que un borrador ya
 * abierto no vuelve a sonar nunca — se pudre en la casilla y a los 7 días se archiva solo como
 * `ignorado`, que es exactamente el fracaso que esta pieza jura perseguir ("no equivocarse, que a
 * nadie le importe"). Sin esta línea, el único recordatorio era acordarse.
 *
 * Se mide desde `fecha` (cuándo entró a la cola) y NO desde `vista_por_ultima_vez`: lo que
 * envejece acá es la DECISIÓN que falta, no la señal. Un problema visto las cinco noches sigue
 * teniendo cero decisiones tomadas.
 *
 * Suena UNA sola vez por borrador (el sello `recordado_el`): el presupuesto de ruido manda una
 * noche muda de cada dos, y un recordatorio que se repite todas las noches se lee como ruido de
 * fondo y se filtra — que es la forma elegante de volver al problema original.
 */
function pendientesQueEnvejecen(pendingDir, hoy, dias) {
  const out = [];
  for (const b of listarBorradores(pendingDir)) {
    if (b.carpeta !== 'pending') continue;
    if ((b.campos.veredicto || 'pendiente') !== 'pendiente') continue;
    if (b.campos.recordado_el) continue; // ya se avisó por éste
    const f = Date.parse(b.campos.fecha || '');
    if (!Number.isFinite(f)) continue;
    const edad = Math.floor((Date.parse(hoy) - f) / 86400000);
    if (edad < dias) continue;
    out.push({ ...b, edad });
  }
  return out.sort((a, b) => b.edad - a.edad);
}

/** Estampa el sello para que el recordatorio no vuelva a sonar por el mismo borrador. */
function marcarRecordados(borradores, hoy) {
  for (const b of borradores) {
    const t = /^recordado_el:/m.test(b.texto)
      ? b.texto.replace(/^recordado_el:.*$/m, `recordado_el: "${hoy}"`)
      : `${b.texto.replace(/\n*$/, '')}\nrecordado_el: "${hoy}"\n`;
    fs.writeFileSync(b.archivo, t, 'utf8');
  }
  return borradores.length;
}

/**
 * A los 7 días sin que nadie lo toque, un pendiente pasa solo a `ignorado`.
 *
 * 🔴 Se mide desde la ÚLTIMA VEZ QUE SE VIO, no desde que se creó. Con la fecha de creación, un
 * problema que sigue vivo —un plugin caído ocho noches seguidas— se auto-archivaría a la séptima
 * y, como el dedup respeta lo archivado, quedaría mudo PARA SIEMPRE. Un problema que persiste tiene
 * que gritar más, no menos.
 */
function marcarIgnorados(pendingDir, hoy) {
  const dirP = path.join(pendingDir, 'pending');
  const dirA = path.join(pendingDir, 'archived');
  // Devuelve los IDS, no un número: el pipeline tiene que abandonar el PR de cada uno. Un PR
  // abierto cuyo borrador ya se archivó es peor que ninguno — pide una decisión sobre algo que el
  // sistema ya dio por perdido, y esa clase de PR es la que enseña a no mirar la lista.
  const ids = [];
  for (const b of listarBorradores(pendingDir).filter((x) => x.carpeta === 'pending')) {
    // uno que está contando sus noches sin aparecer no se archiva: las N noches ganan a los 7 días
    if (/^noches_sin_aparecer:[ \t]*[1-9]/m.test(b.texto)) continue;
    const f = Date.parse(b.campos.vista_por_ultima_vez || b.campos.fecha || '');
    if (!Number.isFinite(f)) continue;
    if ((Date.parse(hoy) - f) / 86400000 < 7) continue;
    fs.mkdirSync(dirA, { recursive: true });
    const t = b.texto.replace(/^veredicto:.*$/m, 'veredicto: ignorado')
      .replace(/^motivo:.*$/m, 'motivo: "nadie lo miró en 7 días (marcado solo)"');
    fs.writeFileSync(path.join(dirA, path.basename(b.archivo)), t, 'utf8');
    fs.unlinkSync(b.archivo);
    ids.push(b.campos.id);
  }
  void dirP;
  return ids;
}

// ── el control de las noches ──────────────────────────────────────────────────────────────────

/**
 * Lo que se midió de un producto esa noche: `{ ok, lista, salud: { <plugin>: sí/no }, tabla, stats: { <plugin>: sí } }`.
 * `lista` es la lista de plugins del host; `salud`, la de cada plugin que se leyó. `tabla` son las filas de detalle de
 * los errores: cuentan si se leyeron enteras (sin el corte de las primeras filas), si el host no las negó con la lista
 * vacía y un total distinto de cero, y fuera del arranque en frío. `stats`, los plugins cuyas estadísticas por código
 * se leyeron, también fuera del arranque en frío.
 */
function medidaDelProducto(datos, frio) {
  if (!datos.ok) return { ok: false };
  const salud = {};
  for (const [plugin, info] of Object.entries(datos.salud || {})) {
    if (plugin === '__lista') continue;
    const estado = info && typeof info === 'object' ? info.estado : info;
    // sólo un estado de texto es una medición: uno que falta o malformado no es «se midió y no apareció»
    salud[plugin] = typeof estado === 'string' && estado.trim() !== '' && !estado.toLowerCase().startsWith('no medido');
  }
  const stats = {};
  if (!frio) for (const plugin of Object.keys(datos.stats || {})) stats[plugin] = true;
  return { ok: true, lista: !(datos.salud && datos.salud.__lista), salud, stats,
    tabla: datos.tablaLeida !== false && !frio && !datos.truncado && (datos.fuente === 'ejecuciones' || !datos.degradada) };
}

/**
 * ¿Se midió esa noche lo que produce el hallazgo? La salud y el latido necesitan la salud de su plugin. El resto, la
 * misma fuente que lo dio (`origen`): uno de las estadísticas por código, las estadísticas de su plugin; uno de las
 * filas de detalle (o sin `origen`, anterior a la marca), las filas. Todo necesita el login y la lista de plugins. Una
 * noche no medida no es «no apareció».
 */
function medidaPara({ producto, regla, plugin, origen }, medidas) {
  const m = producto && Object.hasOwn(medidas, producto) ? medidas[producto] : null;
  if (!m || !m.ok || !m.lista) return false;
  if (regla === 'salud' || regla === 'latido') return Boolean(plugin && m.salud && m.salud[plugin] === true);
  if (origen === 'stats') return Boolean(plugin && m.stats && m.stats[plugin] === true);
  return m.tabla === true;
}

const FMT_BORRADOR = () => require('../findings/sources.js').FUENTES.vigilante.formato;
// las marcas de la propuesta, del contador y de las fallas del análisis, que una reapertura borra
const CLAVES_QUE_SE_REINICIAN = ['noches_sin_aparecer', 'noche_contada', 'resuelta_el', 'aviso_volvio_el', 'aviso_cerrado_el', 'decidido_en_sitio',
  'propuesta_accion', 'propuesta_razon', 'propuesta_modelo', 'propuesta_motivo', 'propuesta_fallas', 'propuesta_fallo_el',
  'analisis_motivo', 'analisis_fallas', 'analisis_fallo_el'];

/**
 * Un resuelto o un ignorado de `archived/` que vuelve se reabre en `pending/` con el mismo archivo: otra vez pendiente,
 * el veredicto de antes en `veredicto_anterior`, el día en `reaparecio_el`, una noche más vista, y sin la propuesta, el
 * contador ni el análisis del modelo. Primero se escribe el de `pending/` y después se borra el archivado.
 */
function reabrirBorrador(b, pendingDir, hoy) {
  const fmt = FMT_BORRADOR();
  let t = b.texto;
  for (const k of CLAVES_QUE_SE_REINICIAN) t = fmt.quitarClave(t, k);
  // el análisis del modelo era de la vez anterior: la noche lo vuelve a escribir; el de una persona se conserva
  t = t.replace(/^analisis:[ \t]*\n(?:[ \t]+[a-z_]+:.*\n?)*/m, (b) => (/^[ \t]+autor:[ \t]*"?modelo"?[ \t]*$/m.test(b) ? '' : b));
  t = t.replace(/^veredicto:.*$/m, 'veredicto: pendiente');
  t = fmt.ponerEscalar(t, 'veredicto_anterior', b.campos.veredicto || 'pendiente');
  t = fmt.ponerEscalar(t, 'reaparecio_el', JSON.stringify(hoy));
  t = t.replace(/^vista_por_ultima_vez:.*$/m, `vista_por_ultima_vez: "${hoy}"`);
  t = t.replace(/^noches_seguidas:.*$/m, `noches_seguidas: ${(Number(b.campos.noches_seguidas) || 1) + 1}`);
  const destino = path.join(pendingDir, 'pending', path.basename(b.archivo));
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, t, 'utf8');
  fs.unlinkSync(b.archivo);
}

/**
 * Una noche más para cada borrador de `pending/` y `promoted/`: el visto hoy pierde su contador; el que no se vio cuenta
 * la noche sólo si lo que lo produce se midió (`medidaPara`). A las N noches (`findings.resolve_after_nights`) queda
 * resuelto con `resuelta_el` y pasa a `archived/`. Devuelve los ids resueltos.
 */
function controlarNoches({ pendingDir, hoy, medidas, vistasHoy, operations }) {
  const CYCLE = require('../findings/cycle.js');
  const n = CYCLE.nochesParaResolver(operations);
  if (!n.ok) { console.error(`noches del vigilante: ${n.motivo}; esta noche no se cuenta`); return []; }
  const fmt = FMT_BORRADOR();
  const resueltos = [];
  for (const b of listarBorradores(pendingDir)) {
    if (b.carpeta === 'archived' || ['descartado', 'ignorado'].includes(b.campos.veredicto)) continue;
    const e = fmt.leerFicha(b.texto).escalares;
    const contador = /^\d+$/.test(String(e.noches_sin_aparecer || '')) ? Number(e.noches_sin_aparecer) : 0;
    const contada = /^\d{4}-\d{2}-\d{2}$/.test(String(e.noche_contada || '')) ? e.noche_contada : null;
    if (vistasHoy.has(b.campos.huella)) {
      if (contador || contada) fs.writeFileSync(b.archivo, fmt.quitarClave(fmt.quitarClave(b.texto, 'noches_sin_aparecer'), 'noche_contada'), 'utf8');
      continue;
    }
    const medida = medidaPara(b.campos, medidas);
    const r = CYCLE.contarNoche({ contador, presente: false, medida, n: n.n, hoy, nocheContada: contada });
    let t = b.texto;
    if (medida && contada !== hoy) {
      t = fmt.ponerEscalar(t, 'noches_sin_aparecer', String(r.contador));
      t = fmt.ponerEscalar(t, 'noche_contada', JSON.stringify(hoy));
    }
    if (r.resuelta) {
      t = fmt.ponerEscalar(fmt.quitarClave(fmt.quitarClave(t, 'noches_sin_aparecer'), 'noche_contada'), 'resuelta_el', JSON.stringify(hoy));
      const destino = path.join(pendingDir, 'archived', path.basename(b.archivo));
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, t, 'utf8');
      fs.unlinkSync(b.archivo);
      resueltos.push(b.campos.id);
    } else if (t !== b.texto) fs.writeFileSync(b.archivo, t, 'utf8');
  }
  return resueltos;
}

// ── comandos ───────────────────────────────────────────────────────────────────────────────────

async function cmdRun(a) {
  // Apagado de fábrica (ver la cabecera): sin configuración propia no hay nada que mirar, y se dice.
  if (!a.configGiven && !fs.existsSync(a.config)) {
    console.log(`⏸ vigilante apagado: no hay configuración (${a.config}). Se prende con --config <hosts.json> desde el repo de operaciones de la organización.`);
    return 0;
  }
  const cfg = leerJson(a.config, null);
  if (!cfg) { console.error(`⚠ no pude leer la config: ${a.config}`); return 1; }
  const hoy = a.hoy || new Date().toISOString().slice(0, 10);
  // las decisiones confirmadas en el sitio que otra persona aprobó, antes de mirar los borradores; a la
  // salida de error, para no romper la de --json
  if (!a.dryRun) for (const l of require('../findings/cycle.js').aplicarDecisiones({ fuente: 'vigilante', dir: a.pending }).lineas) console.error(l);
  // el pedido de trabajo de cada arreglo decidido que todavía no lo tiene; la carpeta del vigilante vive en
  // <operaciones>/inbox/watcher
  if (!a.dryRun) {
    const ops = path.resolve(a.pending, '..', '..');
    try {
      const pedidos = await require('../findings/cycle.js').pedirTrabajo({ fuente: 'vigilante', dir: a.pending, operations: path.join(ops, 'operations.json'), repoDir: ops });
      for (const l of pedidos.lineas) console.error(l);
    } catch (e) { console.error(`pedidos del vigilante: el paso falló (${(e && e.constructor && /^[A-Za-z_]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'error')}); esta noche no se pidió ninguno`); }
  }
  // 🔴 Desde AHORA hacia atrás, no desde la medianoche del día: con la medianoche la ventana real
  // sería de 33 h (el pipeline corre 08:00 UTC) y la franja 23:00–08:00 se contaría DOS veces, en dos
  // líneas base distintas. Con `--today` (tests) se usa el mediodía de ese día como ancla estable.
  const ancla = a.hoy ? Date.parse(`${hoy}T12:00:00Z`) : Date.now();
  const desde = new Date(ancla - cfg.ventana_horas * 3600 * 1000).toISOString();

  // Línea base: las últimas N noches de snapshots COMMITEADOS. Git es la base de datos (mismo
  // patrón que el nocturno de métricas). Una noche "no medida" se excluye: es un agujero, no un 0.
  const historicos = [];
  try {
    for (const f of fs.readdirSync(a.out).filter((x) => /^vigilante-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().slice(-cfg.ventana_linea_base_dias)) {
      const d = leerJson(path.join(a.out, f), null);
      if (d && d.conteos) historicos.push(d);
    }
  } catch { /* primera noche */ }

  const activos = (cfg.productos || []).filter((p) => p.activo);
  const resultado = { fecha: hoy, generado: new Date().toISOString(), productos: {}, conteos: {}, hallazgos: [], no_medido: [] };
  const nuevos = []; const repetidos = [];
  const abiertos = listarBorradores(a.pending);
  const modoFrio = historicos.length < cfg.noches_arranque_frio;
  // lo que se midió de cada producto y las huellas vistas esta noche: con eso se cuentan las noches sin aparecer
  const medidas = {};
  const vistasHoy = new Set();

  for (const prod of activos) {
    const datos = await traerProducto(prod, cfg, a.fixture, desde);
    if (!datos.ok) {
      medidas[prod.id] = medidaDelProducto(datos, true);
      // 🔴 Una noche sin datos NO puede parecerse a una noche tranquila. Es la muerte silenciosa
      // más probable de esta pieza (misma lección que el debut del portón de CI que no corrió, en el registro de incidentes del equipo).
      resultado.productos[prod.id] = { ok: false, motivo: datos.motivo };
      resultado.no_medido.push(`${prod.id}: ${datos.motivo}`);
      continue;
    }
    if (datos.truncado) resultado.no_medido.push(`${prod.id}: ${datos.truncado}`);
    // 🔴 El hueco se ESCRIBE cada noche. Si el detalle por pedido no llega, deriva y desagregación
    // no tienen insumo — y eso no puede parecerse a "no encontré nada".
    if (datos.degradada) resultado.no_medido.push(`${prod.id}: ${datos.degradada}`);
    // 🔴 Sólo cuentan las noches en que ESTE producto se pudo medir. Si no, tres noches con las
    // credenciales rotas consumirían el arranque en frío y la primera noche con datos saldría en modo
    // normal con la línea base vacía: un error viejo y conocido se reportaría como "tipo NUEVO,
    // severidad alta".
    const nochesDelProducto = historicos.filter((h) => h.conteos && h.conteos[prod.id] !== undefined);
    const frioProducto = nochesDelProducto.length < cfg.noches_arranque_frio;
    medidas[prod.id] = medidaDelProducto(datos, frioProducto);
    // 🔴 Y se rellena con CERO la noche medida en que la huella no apareció. Sin eso la mediana se
    // calcularía sólo sobre las noches en que el error existió — un error esporádico (3 ocurrencias
    // una noche de cada 14) tendría mediana 3 y umbral 9, así que su goteo quedaría
    // por debajo. Además `m === 0` sería inalcanzable, o sea código muerto.
    const huellasVistas = new Set();
    for (const h of nochesDelProducto) for (const fp of Object.keys(h.conteos[prod.id])) huellasVistas.add(fp);
    const baseMediana = {};
    for (const fp of huellasVistas) {
      baseMediana[fp] = mediana(nochesDelProducto.map((h) => h.conteos[prod.id][fp] || 0));
    }

    const { hallazgos, rafagaAzure, modo } = evaluar({
      producto: prod.id, ejecuciones: datos.ejecuciones, salud: datos.salud,
      stats: datos.stats || {}, totales: datos.totales || {}, base: baseMediana, cfg,
      modoFrio: frioProducto, fuente: datos.fuente, ahoraIso: new Date(ancla).toISOString(),
    });

    // Conteos de ESTA noche → son la línea base de las próximas.
    // Los conteos de esta noche son la línea base de las próximas — y tienen que estar en la MISMA
    // clave que la regla que los va a leer, si no la comparación no existe.
    const conteos = {};
    if (datos.fuente === 'ejecuciones') {
      for (const e of datos.ejecuciones.filter((x) => x.estado >= 500)) {
        const fp = huella(prod.id, e.plugin, e.endpoint, e.estado, e.mensaje);
        conteos[fp] = (conteos[fp] || 0) + 1;
      }
    } else {
      for (const [plugin, st] of Object.entries(datos.stats || {})) {
        for (const [codigo, cant] of Object.entries(st.porCodigo || {})) {
          if (Number(codigo) < 500 || !cant) continue;
          conteos[huella(prod.id, plugin, `codigo-${codigo}`, codigo, 'stats')] = cant;
        }
      }
    }
    resultado.conteos[prod.id] = conteos;
    // una huella con errores esta noche se vio, aunque no pase el umbral: la mediana sube con un error que sigue
    // llegando parejo, y contarlo como «no apareció» lo resolvería mientras pasa
    for (const fp of Object.keys(conteos)) vistasHoy.add(fp);
    // las estadísticas se leen también la noche en que mandan las filas: un hallazgo que salió de ellas se ve ahí
    for (const [plugin, st] of Object.entries(datos.stats || {})) {
      for (const [codigo, cant] of Object.entries(st.porCodigo || {})) {
        if (Number(codigo) >= 500 && cant) vistasHoy.add(huella(prod.id, plugin, `codigo-${codigo}`, codigo, 'stats'));
      }
    }
    // 🔴 El conteo de errores sale de la fuente que SE USÓ. Mostrar las filas de detalle
    // (0 por un bug del host) mientras el aviso dice 158 daría dos números distintos para lo mismo en
    // la misma pantalla, que es exactamente la confusión que esta pieza existe para evitar.
    const erroresContados = datos.fuente === 'ejecuciones'
      ? datos.ejecuciones.filter((x) => x.estado >= 500).length
      : Object.values(datos.stats || {}).reduce((n, st) => n + Object.entries(st.porCodigo || {})
        .filter(([c]) => Number(c) >= 500).reduce((m, [, v]) => m + (v || 0), 0), 0);
    resultado.productos[prod.id] = {
      ok: true, modo, errores: erroresContados,
      hallazgos: hallazgos.length, ya_alertado_por_azure: rafagaAzure,
      host_logs: datos.hostLogs === null ? 'no medido — tabla apagada en prod (§6.4 del inventario)' : 'ok',
      fuente: datos.fuente,
      truncado: datos.truncado || null,
      plugins_mirados: Object.keys(datos.salud || {}).filter((k) => k !== '__lista').length,
    };

    for (const h of hallazgos) {
      vistasHoy.add(h.huella);
      const yaAbierto = abiertos.find((b) => b.campos.huella === h.huella && b.carpeta === 'pending');
      if (yaAbierto) {
        if (!a.dryRun) actualizarRepetido(yaAbierto, hoy);
        repetidos.push(h.huella);
        continue;
      }
      // 🔴 Lo archivado calla, pero NO para siempre — y no todo por igual:
      //   · `descartado` = alguien lo miró y decidió que no servía → se respeta 60 días;
      //   · `ignorado`   = nadie lo miró → se respeta 7, porque no hubo decisión que respetar.
      // Sin esta ventana, un problema descartado en marzo que VUELVE en agosto por otra causa no
      // sonaría nunca más. Y como el propio README dice que ignorado "cuenta
      // peor que descartado", darle el mismo silencio sería contradecirse.
      // 🔴 La MÁS RECIENTE, no la primera que devuelva el sistema de archivos (que no ordena): con
      // más de una vida archivada de la misma huella, la ventana de silencio se evaluaría contra una
      // decisión arbitraria y el `reincidente.desde` señalaría una vida cualquiera.
      // 🔴 Lo aceptado (`promoted/`, veredicto `util`) también es una decisión, con la misma ventana
      // que lo descartado. Mirar sólo `archived/` haría que un hallazgo aceptado que se repite la
      // noche siguiente vuelva a escribir su ficha en `pending/` y abra otro borrador y otro pedido
      // por el mismo hecho, que ya tiene el suyo.
      const archivado = abiertos
        .filter((b) => b.campos.huella === h.huella && (b.carpeta === 'archived' || b.carpeta === 'promoted'))
        .sort((a, b) => String(b.campos.vista_por_ultima_vez || b.campos.fecha || '')
          .localeCompare(String(a.campos.vista_por_ultima_vez || a.campos.fecha || '')))[0];
      // un resuelto o un ignorado que vuelve se reabre, el mismo borrador, aun dentro de su silencio; el descartado
      // conserva su ventana
      if (archivado && archivado.carpeta === 'archived'
        && (archivado.campos.veredicto === 'ignorado' || /^resuelta_el:[ \t]*"?\d{4}-\d{2}-\d{2}/m.test(archivado.texto))) {
        if (!a.dryRun) reabrirBorrador(archivado, a.pending, hoy);
        repetidos.push(h.huella);
        continue;
      }
      // una aceptada que sigue viva suma la aparición en su ficha: tratarla como silencio dejaría quieta
      // `vista_por_ultima_vez`, y pasada la ventana se escribiría otro borrador de la misma huella
      if (archivado && archivado.carpeta === 'promoted') {
        if (!a.dryRun) actualizarRepetido(archivado, hoy);
        repetidos.push(h.huella);
        continue;
      }
      if (archivado) {
        const dias =(Date.parse(hoy) - Date.parse(archivado.campos.vista_por_ultima_vez || archivado.campos.fecha || '')) / 86400000;
        const tope = archivado.campos.veredicto === 'ignorado' ? cfg.dias_silencio_ignorado : cfg.dias_silencio_descartado;
        if (Number.isFinite(dias) && dias < tope) { repetidos.push(h.huella); continue; }
        h.reincidente = { desde: archivado.campos.fecha, veredicto_previo: archivado.campos.veredicto };
      }
      if (!a.dryRun) escribirBorrador(path.join(a.pending, 'pending'), h, hoy, { yaAlertado: rafagaAzure });
      nuevos.push(h);
      // El `id` viaja en el resultado porque el pipeline lo necesita para abrir un PR por hallazgo
      // nuevo: sin esto tendría que reconstruirlo, y dos lugares que arman el mismo nombre se
      // separan solos.
      resultado.hallazgos.push({ id: `${hoy}-${h.producto}-${h.huella}`, regla: h.regla, producto: h.producto, huella: h.huella, severidad: h.severidad, plugin: h.plugin, endpoint: h.endpoint });
    }
  }

  // las noches sin aparecer, antes de marcar ignorados (uno que cuenta no se archiva), y el aviso al pedido de lo
  // que volvió; como el pedido, un error del aviso no corta la noche
  const operaciones = path.resolve(a.pending, '..', '..');
  resultado.resueltos_ids = a.dryRun ? [] : controlarNoches({ pendingDir: a.pending, hoy, medidas, vistasHoy, operations: path.join(operaciones, 'operations.json') });
  if (!a.dryRun) {
    try {
      const avisos = await require('../findings/cycle.js').avisarQueVolvio({ fuente: 'vigilante', dir: a.pending, operations: path.join(operaciones, 'operations.json'), hoy, repoDir: operaciones });
      for (const l of avisos.lineas) console.error(l);
    } catch (e) { console.error(`avisos del vigilante: el paso falló (${(e && e.constructor && /^[A-Za-z_]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'error')}); se avisa mañana`); }
    // y a su pedido cerrado, que la falla sigue
    try {
      const cerrados = await require('../findings/cycle.js').avisarCerradoConFallaViva({ fuente: 'vigilante', dir: a.pending, operations: path.join(operaciones, 'operations.json'), hoy, repoDir: operaciones, vistas: vistasHoy });
      for (const l of cerrados.lineas) console.error(l);
    } catch (e) { console.error(`pedidos cerrados del vigilante: el paso falló (${(e && e.constructor && /^[A-Za-z_]{1,30}$/.test(e.constructor.name) ? e.constructor.name : 'error')}); se mira mañana`); }
  }
  const ignorados = a.dryRun ? [] : marcarIgnorados(a.pending, hoy);
  resultado.nuevos = nuevos.length;
  resultado.repetidos = repetidos.length;
  resultado.marcados_ignorados = ignorados.length;
  resultado.ignorados_ids = ignorados; // los lee el pipeline para abandonar sus PR
  resultado.modo = modoFrio ? `solo-linea-base (noche ${historicos.length + 1}/${cfg.noches_arranque_frio})` : 'normal';
  // El modo REAL es por producto (uno puede llevar 14 noches medidas y otro ninguna).

  // El aviso: sólo si hay algo que decir, y como máximo los N de mayor severidad. El tope es sobre
  // el AVISO, jamás sobre el registro — descartar en silencio es lo que esta casa no hace.
  const avisables = nuevos.filter((h) => !h.ya_alertado);
  // La cola que envejece: se calcula DESPUÉS de marcar ignorados (lo que ya se archivó no se
  // recuerda) y sólo si el aviso va a llegar a alguien.
  //
  // 🔴 En modo mudo NO se estampa el sello: el recordatorio suena una sola vez por borrador, así
  // que gastarlo contra un aviso que nadie recibe es quemarlo en silencio — la falla que este
  // recordatorio venía justamente a cerrar.
  const mudo = process.env.TYCON_WATCHER_QUIET === '1';
  const porRecordar = mudo ? [] : pendientesQueEnvejecen(a.pending, hoy, nn(cfg.dias_recordatorio_pendiente, 3));
  resultado.aviso = construirAviso(hoy, avisables, resultado.no_medido, cfg, porRecordar);
  resultado.recordados = (!a.dryRun && resultado.aviso) ? marcarRecordados(porRecordar, hoy) : 0;

  if (!a.dryRun) {
    fs.mkdirSync(a.out, { recursive: true });
    fs.writeFileSync(path.join(a.out, `vigilante-${hoy}.json`), `${JSON.stringify(resultado, null, 2)}\n`, 'utf8');
  }
  if (a.json) { console.log(JSON.stringify(resultado, null, 2)); return 0; }

  console.log(`🌙 vigilante ${hoy} — modo ${resultado.modo}`);
  for (const [id, p] of Object.entries(resultado.productos)) {
    console.log(p.ok
      ? `   ${id}: ${p.errores} errores (${p.fuente === 'ejecuciones' ? 'detalle por pedido' : 'sólo estadísticas'}) · ${p.hallazgos} hallazgo(s)${p.ya_alertado_por_azure ? ' · ráfaga ya alertada por Azure' : ''}`
      : `   ${id}: ∅ NO MEDIDO — ${p.motivo}`);
  }
  console.log(`   nuevos: ${nuevos.length} · repetidos: ${repetidos.length} · marcados ignorados: ${ignorados.length} · recordatorios: ${resultado.recordados}`);
  if (resultado.aviso) console.log(`\n--- aviso ---\n${resultado.aviso}`);
  return 0;
}

/**
 * El aviso por hallazgo: SÓLO CANTIDADES. Sale a un servicio de afuera (Telegram, Slack o Teams, por
 * scripts/lib/notify.js): ni producto, ni plugin, ni endpoint, ni diagnóstico, ni id. El detalle está en los borradores
 * (`/tycon-vigilante review`). `cfg` queda por la firma de siempre (el tope de hallazgos ya no aplica: no se listan).
 */
function construirAviso(fecha, hallazgos, noMedido, cfg, recordatorio) {
  // Una noche sin hallazgos PERO con borradores pudriéndose sí tiene algo que decir: el silencio
  // no miente sobre producción, pero tampoco puede tapar una casilla que nadie mira.
  const esperando = recordatorio ? recordatorio.length : 0;
  if (!hallazgos.length && !noMedido.length && !esperando) return null;
  const l = [`vigilante ${fecha}: ${hallazgos.length} hallazgo(s) nuevo(s), ${noMedido.length} sin medir, ${esperando} borrador(es) esperando`];
  if (esperando) l.push(`el más viejo espera hace ${recordatorio[0].edad} día(s)`);
  l.push('Revisar: /tycon-vigilante review');
  return l.join('\n');
}

/**
 * `note` — RECHAZAR EL PULL REQUEST ES `/tycon-vigilante reject`.
 *
 * El caso que lo funda: la rama de un hallazgo recibe su pull request, una persona lo rechaza horas
 * después, y a la mañana siguiente el pipeline abre otro —que también se rechaza, para que aparezca
 * un tercero—. Serían tres pull requests para una decisión ya tomada, porque
 * "no hay PR activo" y "nunca tuvo uno" se ven igual. Lo evita archivar la ficha a mano con
 * `/tycon-vigilante reject`: esto automatiza eso.
 *
 * 🔴 Y acá el rechazo SÍ archiva, al revés que en dependencias. La diferencia no es un descuido:
 * un borrador del vigilante es una HIPÓTESIS y descartarla es una decisión completa; una ficha de
 * dependencias es un hecho MEDIDO que sigue en `main` aunque el aviso no interese. Por eso el
 * guion compartido no decide nada de esto — llama a `note` y cada cola hace lo suyo.
 */
function cmdAnotar(a) {
  if (!a.ficha || !fs.existsSync(a.ficha)) { console.error('error: falta --card <archivo existente>'); return 2; }
  if (a.quitarRechazo && a.rechazado === null) {
    // En dependencias un pull request reactivado borra el rechazo; acá la ficha ya está archivada y
    // la decisión se retoma con `/tycon-vigilante`. El compartido llama a los dos igual: contesta la cola.
    console.log('no aplica en el vigilante: la ficha ya está archivada — se retoma con /tycon-vigilante');
    return 0;
  }
  if (a.pr === null && a.rechazado === null && a.prCerrado === null) { console.error('error: note sin acción'); return 2; }
  if (a.pr !== null && !/^\d+$/.test(String(a.pr))) {
    console.error(`error: --pr tiene que ser el número del pull request, no «${a.pr}»`); return 2;
  }
  if (a.rechazado !== null && !/^\d{4}-\d{2}-\d{2}$/.test(a.rechazado)) {
    console.error(`error: --rejected espera una fecha YYYY-MM-DD, no «${a.rechazado}»`); return 2;
  }

  let t = fs.readFileSync(a.ficha, 'utf8');
  // Una clave escalar nueva: se reemplaza si está, y si no se agrega DESPUÉS de `noches_seguidas:`
  // —donde `escribirBorrador` termina la parte mecánica— o al final, como hace `marcarRecordados`.
  // 🔴 La cadena de reemplazo va SIEMPRE por una función. Con la forma `txt.replace(re, `${k}: ${v}`)`,
  // `String.replace` interpreta los patrones `$&`, `$'`, `` $` `` y `$$` que traiga el valor — y el
  // valor acá es el comentario de rechazo escrito por una persona. Reproducido: `$&` inyectaba
  // `motivo: null` en el medio del texto, y `$'` copiaba el resto ENTERO de la ficha adentro del
  // valor, dejándola con claves duplicadas y un `motivo:` multilínea que ningún lector por
  // expresión regular puede leer. `JSON.stringify` protege las comillas, no los patrones `$`.
  const poner = (txt, k, v) => {
    const re = new RegExp(`^${k}:.*$`, 'm');
    if (re.test(txt)) return txt.replace(re, () => `${k}: ${v}`);
    const anclaN = /^noches_seguidas:.*$/m;
    if (anclaN.test(txt)) return txt.replace(anclaN, (l) => `${l}\n${k}: ${v}`);
    return `${txt.replace(/\n*$/, '')}\n${k}: ${v}\n`;
  };

  if (a.pr !== null) t = poner(t, 'pr', String(Number(a.pr)));
  if (a.prCerrado !== null) t = poner(t, 'pr_cerrado', a.prCerrado);
  if (a.rechazado !== null) {
    // 🔴 `JSON.stringify` y no comillas a mano: `camposDe` corta en la primera comilla, así que un
    // motivo con comillas adentro —«fue una "caida" de azure», textual de un rechazo real— dejaría el
    // campo mocho. Es el mismo defecto que ya mordió con el diagnóstico, y `leerTexto` lo deshace.
    const texto = String(a.motivo || '').trim() || 'sin motivo escrito';
    t = t.replace(/^veredicto:.*$/m, () => 'veredicto: descartado');
    t = poner(t, 'motivo', JSON.stringify(`${texto} (rechazo del PR !${a.pr}, ${a.rechazado})`));
    // El pull request ya está cerrado y su fecha se conoce: anotarlo acá evita que el barrido de
    // archivadas vuelva a preguntarle a Azure por algo que este mismo paso acaba de leer.
    if (a.prCerrado === null) t = poner(t, 'pr_cerrado', a.rechazado);
    const destino = path.join(path.dirname(path.dirname(a.ficha)), 'archived', path.basename(a.ficha));
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, t, 'utf8');
    if (path.resolve(destino) !== path.resolve(a.ficha)) fs.unlinkSync(a.ficha);
    return 0;
  }
  if (t !== fs.readFileSync(a.ficha, 'utf8')) fs.writeFileSync(a.ficha, t, 'utf8');
  return 0;
}

function cmdReport(a) {
  const bs = listarBorradores(a.pending);
  const porVeredicto = { pendiente: 0, util: 0, descartado: 0, ignorado: 0 };
  const porRegla = {};
  for (const b of bs) {
    const v = b.campos.veredicto || 'pendiente';
    porVeredicto[v] = (porVeredicto[v] || 0) + 1;
    const r = b.campos.regla || '?';
    porRegla[r] = porRegla[r] || { total: 0, util: 0 };
    porRegla[r].total++;
    if (v === 'util') porRegla[r].util++;
  }
  const total = bs.length;
  const utilidad = total ? { num: porVeredicto.util, den: total } : null;
  // ≥80% archivado sobre ≥10 hallazgos ⇒ el umbral está mal. La pieza lo dice; NO se auto-ajusta:
  // una pieza que se calibra sola para dejar de molestar converge siempre a callarse.
  const descartadosEIgnorados = porVeredicto.descartado + porVeredicto.ignorado;
  const veredicto = total < 10 ? `datos insuficientes (${total} hallazgos, hacen falta ≥10)`
    : descartadosEIgnorados / total >= 0.8 ? '⚠ RUIDOSA: ≥80% sin usar — subir el umbral (con commit, no sola)'
      : descartadosEIgnorados / total >= 0.5 ? 'vigilar: más de la mitad sin usar' : 'dentro de presupuesto';

  const out = { total, por_veredicto: porVeredicto, utilidad, por_regla: porRegla, veredicto_umbral: veredicto };
  if (a.json) { console.log(JSON.stringify(out, null, 2)); return 0; }
  const pct = utilidad ? `${Math.round(100 * utilidad.num / utilidad.den)}% (${utilidad.num}/${utilidad.den})` : '—';
  console.log(`vigilante: ${total} hallazgos · ${porVeredicto.util} útiles (${pct}) · ${porVeredicto.descartado} descartados · ${porVeredicto.ignorado} ignorados`);
  for (const [r, v] of Object.entries(porRegla)) console.log(`  ${r}: ${v.util}/${v.total} útil`);
  console.log(`  veredicto: ${veredicto}`);
  return 0;
}

/**
 * El texto del pull request con el que se decide un hallazgo.
 *
 * 🔴 Por qué el PR y no un mail: un mail no tiene dueño ni estado — se lee y se pierde. Un PR queda
 * en la lista de cada revisor hasta que alguien lo toca, y el rechazo OBLIGA a escribir el motivo,
 * que si no dependería de que la persona se acordara. Ese motivo es el dato que calibra la pieza: sin
 * él, "no servía" y "nadie lo miró" son indistinguibles, y esa diferencia es la que decide si el
 * vigilante sigue existiendo.
 *
 * El cuerpo se escribe para alguien que NO leyó el YAML: qué pasó, en castellano, y qué significa
 * cada botón. Un PR que hay que abrir el archivo para entender es un PR que se posterga.
 */
function textoPr(campos, senal) {
  const donde = [campos.plugin, campos.endpoint].filter((x) => x && x !== 'null').join(' ');
  // El título no repite lo que ya dice el `donde`: "acme — X: El plugin "X" no recibe…" gasta
  // la mitad del renglón que se ve en la lista de PRs en decir dos veces el mismo nombre.
  const primeraFrase = (campos.diagnostico || '').split(/(?<=\.)\s/)[0] || '';
  const resumen = primeraFrase
    .replace(/^El plugin\s+"[^"]+"\s*/i, '')
    .replace(/^El endpoint\s+\S+\s*/i, '')
    .replace(/\.$/, '');
  const titulo = `🌙 Vigilante · ${campos.producto}${donde ? ` — ${donde}` : ''}: ${resumen.slice(0, 80)}`;
  const cuerpo = [
    '## Qué pasó',
    '',
    campos.diagnostico || '(sin diagnóstico)',
    '',
    `**Regla**: ${campos.regla} · **Severidad**: ${campos.severidad} · **Noches seguidas**: ${campos.noches_seguidas}`,
    ...(senal && senal.length ? ['', '**La señal**:', ...senal.map((l) => `- ${l}`)] : []),
    '',
    'Ninguna alerta de Azure ve esto: por debajo del umbral de ráfaga, o directamente otra métrica.',
    '',
    '## Qué decidís acá',
    '',
    '- **Aprobar y mergear** → esto es trabajo real. El borrador pasa a `promoted/`; la story se',
    '  crea después por la vía normal (`/tycon-vigilante approve`), con su formato y su work item.',
    '- **Rechazar** → no servía. 🔴 El comentario del rechazo ES el motivo, y no es opcional: es lo',
    '  único que distingue "lo miré y no era" de "nadie lo miró", y de esa diferencia depende que',
    '  esta pieza siga existiendo.',
    '',
    `_Borrador: \`inbox/watcher/pending/${campos.id}.yaml\` · el vigilante no tocó nada en producción._`,
  ].join('\n');
  return { titulo, cuerpo };
}

/** `pr-text --draft <path>`: el pipeline lo usa para armar el PR. Línea 1 = título. */
function cmdPrTexto(a) {
  if (!a.borrador || !fs.existsSync(a.borrador)) { console.error('⚠ falta --draft <path>'); return 1; }
  const texto = fs.readFileSync(a.borrador, 'utf8');
  const senal = (texto.match(/^senal:\n((?:  .*\n)*)/m) || [, ''])[1]
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/_/g, ' ').replace(/"/g, ''));
  const { titulo, cuerpo } = textoPr(camposDe(texto), senal);
  console.log(titulo);
  console.log('---CUERPO---');
  console.log(cuerpo);
  return 0;
}

function ayuda() {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 40).map((l) => l.replace(/^ ?\*ampersand?\/?/, '').replace(/^\s*\*\s?/, '')).join('\n'));
  return 0;
}

async function main() {
  const a = parseArgs(process.argv);
  if (a.cmd === 'run') return cmdRun(a);
  if (a.cmd === 'report') return cmdReport(a);
  if (a.cmd === 'pr-text') return cmdPrTexto(a);
  if (a.cmd === 'note') return cmdAnotar(a);
  return ayuda();
}

if (require.main === module) {
  // Los nombres viejos (subcomandos y opciones en castellano) siguen andando hasta el retiro
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/watcher/vigilante.js', { exitCode: 2, prefix: 'error: ' });
  main().then((c) => process.exit(c || 0)).catch((e) => {
    // 🔴 Sin esto, una excepción no manejada mataría el proceso y la noche quedaría indistinguible
    // de una tranquila (el pecado que esta pieza jura no cometer). Se imprime con el mismo texto
    // que busca el pipeline para levantar el aviso.
    console.log(`   ∅ NO MEDIDO — el vigilante se cayó: ${e && e.message}`);
    console.error(e && e.stack);
    process.exit(0);
  });
}
module.exports = {
  normalizarMensaje, huella, mediana, evaluar, yaAlertadoPorAzure, camposDe, construirAviso, listarBorradores, escribirBorrador, marcarIgnorados, medidaDelProducto, medidaPara, controlarNoches, pendientesQueEnvejecen, marcarRecordados, textoPr, cmdAnotar, cmdReport, leerTexto,
  // las rutas por omisión, para que una prueba vea adónde escribe la noche sin correrla (T30)
  defaults: { root: RAIZ, config: CONFIG_DEF, out: OUT_DEF, pending: PENDING_DEF },
};
