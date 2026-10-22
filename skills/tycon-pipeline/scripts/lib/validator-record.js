'use strict';
/**
 * validator-record — ¿corrió el validador de historias sobre este archivo después de su última escritura?
 *
 * Llamar a la skill que crea historias no prueba que se siguieron sus pasos: un modelo puede invocarla, no hacer nada
 * de lo que dice y escribir la historia igual. Lo que sí prueba que la historia se revisó es una llamada al revisor
 * `tycon-story-validator` cuyo pedido nombra esa historia, con su respuesta, posterior a la última escritura del
 * archivo. Eso se lee de la cadena de la conversación que guarda la herramienta (`person-ok.leerConversacion` con
 * `soloCadena`), donde el agente no escribe: un renglón agregado al archivo por fuera no cuenta.
 *
 * La respuesta es el `tool_result` de la llamada, sin error. Un validador lanzado de fondo contesta primero con el
 * acuse de lanzamiento, que no alcanza: cuenta el aviso de fin (`<task-notification>` con el número de la llamada y
 * `completed`), que la herramienta agrega a la conversación al terminar el subagente.
 *
 * La ruta se reconoce como la nombra un agente: absoluta, relativa al repo, con `~`, o sólo el nombre del archivo.
 * Una respuesta que encontró problemas cuenta igual: este módulo prueba que se corrió, no qué dijo. Y sólo mira la
 * conversación de la sesión que escribe: un validador corrido en otra sesión, o antes de un `/clear`, no se ve.
 */
const os = require('os');
const path = require('path');

const VALIDADOR = /(^|:)tycon-story-validator$/;
const ESCRITURAS = ['Write', 'Edit', 'MultiEdit'];
const ACUSE = /^\s*Async agent launched/i;

const contenido = (r) => (r && r.message && Array.isArray(r.message.content) ? r.message.content : []);
const texto = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : '');
const unificar = (p) => String(p || '').replace(/\\/g, '/');

/** Las formas en que un agente nombra la historia, de la más larga a la más corta. */
function nombres(ruta, { repoRoot, home = os.homedir() } = {}) {
  const abs = unificar(path.resolve(String(ruta)));
  const out = [abs];
  if (repoRoot) {
    const rel = unificar(path.relative(path.resolve(repoRoot), path.resolve(String(ruta))));
    if (rel && !rel.startsWith('..')) out.push(rel);
  }
  const h = unificar(home);
  if (h && abs.startsWith(h + '/')) out.push('~' + abs.slice(h.length));
  out.push(path.basename(abs));
  return [...new Set(out)];
}

/** ¿El texto nombra la historia? El nombre tiene que terminar ahí: `story-x.md.bak` no es `story-x.md`. */
function nombra(t, formas) {
  const s = unificar(t);
  for (const f of formas) {
    let i = s.indexOf(f);
    while (i >= 0) {
      const antes = i > 0 ? s[i - 1] : '';
      const despues = s[i + f.length] || '';
      const sigue = s[i + f.length + 1] || '';
      const bordeAntes = !antes || !/[\w.-]/.test(antes) || (antes === '/' && !f.startsWith('/') && !f.startsWith('~') && !f.includes('/'));
      const bordeDespues = !despues || (!/[\w/-]/.test(despues) && !(despues === '.' && /\w/.test(sigue)));
      if (bordeAntes && bordeDespues) return true;
      i = s.indexOf(f, i + 1);
    }
  }
  return false;
}

const mismoArchivo = (a, b, cwd) => unificar(path.resolve(cwd || '/', String(a || ''))) === unificar(path.resolve(String(b)));

/**
 * Los registros de la conversación que cuentan: la cadena (`person-ok.enLaCadena`, desde el pedido) más las respuestas
 * que cuelgan de un registro de la cadena. Con llamadas en paralelo, Claude Code encadena las llamadas entre sí y la
 * respuesta de cada una queda como hija de su propia llamada, afuera de la cadena: sin esto, un validador lanzado junto
 * con otra herramienta no tendría respuesta. Sólo entran resultados de herramientas y avisos de la herramienta escritos
 * antes de la punta; en el orden del archivo.
 */
function conRespuestas(registros, { pedido } = {}) {
  const cadena = new Set(require('./person-ok.js').enLaCadena(registros, { pedido }));
  const uuids = new Set([...cadena].map((r) => r.uuid));
  let punta = -1;
  registros.forEach((r, i) => { if (cadena.has(r)) punta = i; });
  return registros.filter((r, i) => cadena.has(r) || (i < punta && r && !r.isSidechain && uuids.has(r.parentUuid) &&
    (r.type === 'attachment' || (r.type === 'user' && contenido(r).some((b) => b && b.type === 'tool_result')))));
}

/** Los archivos que escribe un comando de la terminal: sus destinos y la ruta que devuelve el guion sin BMAD. */
function escritosPorTerminal(comando, cwd, salida) {
  const out = [];
  // sin el lector de destinos no se sigue a ciegas: el error sube a quien llama, que lo anota (el freno frena con el
  // motivo en gates.log; el cierre deja su línea unknown-error)
  const { destinosResueltos } = require('../on-bash-write-gate.js');
  for (const d of destinosResueltos(String(comando || ''), cwd || process.cwd())) out.push(d.abs);
  // `story-without-bmad.js write` escribe la historia desde node y devuelve `{"path": "<ruta>"}`
  const m = /"path"\s*:\s*"([^"]+\.md)"/.exec(String(salida || ''));
  if (m && /story-without-bmad\.js\s+write\b/.test(String(comando || ''))) out.push(m[1]);
  return out;
}

/** Las respuestas de cada llamada: `tool_use_id` → { error, acuse }, y los ids con aviso de fin `completed`. */
function respuestas(registros) {
  const resultados = new Map();
  const terminados = new Set();
  for (const r of registros) {
    for (const b of contenido(r)) {
      if (b && b.type === 'tool_result') {
        const t = texto(b.content);
        resultados.set(b.tool_use_id, { error: !!b.is_error, acuse: ACUSE.test(t), salida: t.slice(0, 4000) });
      }
    }
    const aviso = r && r.type === 'attachment' && r.attachment && typeof r.attachment.prompt === 'string' ? r.attachment.prompt
      : r && r.type === 'user' && typeof (r.message && r.message.content) === 'string' ? r.message.content : '';
    if (aviso.includes('<task-notification>') && /<status>\s*completed\s*<\/status>/.test(aviso)) {
      const m = aviso.match(/<tool-use-id>\s*([\w-]+)\s*<\/tool-use-id>/);
      if (m) terminados.add(m[1]);
    }
  }
  const respondio = (id) => { const res = resultados.get(id); return !!res && !res.error && (!res.acuse || terminados.has(id)); };
  return { resultados, respondio };
}

const esValidador = (b) => (b.name === 'Agent' || b.name === 'Task') && VALIDADOR.test(String((b.input || {}).subagent_type || ''));

/**
 * El estado de la historia en estos registros: `{ hay, escrita, llamadas }`. `hay` = una llamada al validador que la
 * nombra, con respuesta, posterior a la última escritura que no falló. `escrita` = la sesión la escribió.
 */
function enRegistros(registros, { ruta, repoRoot, home } = {}) {
  const formas = nombres(ruta, { repoRoot, home });
  const { resultados, respondio } = respuestas(registros);
  let ultimaEscritura = -1;
  const llamadas = [];
  registros.forEach((r, i) => {
    for (const b of contenido(r)) {
      if (!b || b.type !== 'tool_use') continue;
      const inp = b.input || {};
      if (ESCRITURAS.includes(b.name) && mismoArchivo(inp.file_path, ruta, r.cwd)) {
        const res = resultados.get(b.id);
        if (res && !res.error) ultimaEscritura = i;
      } else if (b.name === 'Bash') {
        // una escritura por la terminal también deja vieja la constancia: el validador no vio lo que quedó
        const res = resultados.get(b.id);
        if (res && !res.error && escritosPorTerminal(inp.command, r.cwd, res.salida).some((f) => mismoArchivo(f, ruta))) ultimaEscritura = i;
      } else if (esValidador(b) && nombra(inp.prompt || '', formas) && respondio(b.id)) {
        llamadas.push(i);
      }
    }
  });
  return { hay: llamadas.some((i) => i > ultimaEscritura), escrita: ultimaEscritura >= 0, llamadas: llamadas.length };
}

/** Cuántas llamadas al validador con respuesta hay en estos registros, nombren la historia que nombren. */
function respuestasDelValidador(registros) {
  const { respondio } = respuestas(registros);
  let n = 0;
  for (const r of registros) for (const b of contenido(r)) if (b && b.type === 'tool_use' && esValidador(b) && respondio(b.id)) n++;
  return n;
}

/**
 * La constancia para una sesión y una ruta: `{ legible, hay, escrita, llamadas, motivo? }`. `pedido` es la punta de la
 * cadena (el `tool_use_id` que se juzga); sin él, el último registro. Sin conversación legible, no hay constancia.
 */
function constancia({ sesion, ruta, repoRoot, pedido, home = os.homedir(), env = process.env } = {}) {
  const pok = require('./person-ok.js');
  const conv = pok.leerConversacion({ env, home, sesion });
  if (!conv.legible) return { legible: false, hay: false, escrita: false, llamadas: 0, motivo: conv.motivo };
  return { legible: true, ...enRegistros(conRespuestas(conv.registros, { pedido }), { ruta, repoRoot, home }) };
}

module.exports = { constancia, enRegistros, conRespuestas, escritosPorTerminal, respuestasDelValidador, nombres, nombra };
