'use strict';
/**
 * owner-approvals.js — la aprobación explícita de la persona, sin terminal: un click en el cuadro de opciones o un
 * mensaje suyo que sea un «aprobado» («aprobado», «apruebo», «sí, aprobado»). La anota un gancho
 * (scripts/hooks/owner-approval-record.js); la consume una firma (owner-window.js `decidir`) donde la ventana de permiso
 * no llega (una pestaña sin permisos, una sesión de fondo), en lugar de mandar a la terminal.
 *
 * Cada aprobación sirve para UNA firma y UN comando. La pregunta del cuadro la arma el guion (`cuadroDe`: qué se aprueba,
 * qué pasa si sale mal y el sello «firma <id> · sesión <id> · código <huella del comando>»), el agente la muestra tal cual
 * y se compara entera; el último mensaje del agente antes de un «aprobado» tiene que traer el sello. Vence a los 30
 * minutos. Vale en la sesión donde se dio o en la coordinadora designada y confirmada, si su proceso sigue vivo. Gana a la
 * delegación: lo que la coordinadora no puede firmar por su cuenta (un plan delicado, un guardado que toca algo sensible)
 * pasa con la aprobación de la persona. Lo irreversible (owner-window.js `TERMINAL_SIEMPRE`) no la acepta.
 *
 * Por qué el agente no la puede fingir:
 * - El modelo no puede llenar la respuesta del cuadro: la herramienta la descarta antes de mostrarlo.
 * - El gancho anota sólo si lo lanzó la herramienta, sin otra herramienta ni la consola de un agente en el medio: un
 *   agente que lo corre a mano, o que abre otra sesión en una pseudo-terminal y le escribe «aprobado», no anota nada.
 * - Al consumir se relee la transcripción de la sesión (la ruta sale del id de la sesión, no del registro): tiene que
 *   estar el mensaje tipeado por la persona (`origin.kind: human`, `promptSource: typed`, `entrypoint: cli`) a la hora
 *   del registro, o el cuadro con esa pregunta, contestado con esa opción a esa hora y no por un gancho
 *   (`permissionDecision.source: hook`).
 * - Para el click se revisan además las capas de configuración (también `managed-settings.d/` y `--settings`), los plugins
 *   instalados (`hooks.json`, los ganchos de su `plugin.json`, `--plugin-dir`) y el encabezado de skills y agentes: un
 *   gancho que no es del arnés sobre el cuadro (PreToolUse o PermissionRequest), o algo que no se puede leer, y el click no
 *   vale.
 * - El registro no se escribe, mueve ni borra por Edit, Write ni la consola (story-gate.js, on-bash-write-gate.js).
 * Lo que no cubre: un agente que rompa un freno a propósito (un guion que escribe a mano el registro y la transcripción),
 * y las banderas de una sesión de fondo, porque su proceso no las muestra.
 *
 * La parte de acá no depende de la herramienta salvo las funciones de Claude Code (la transcripción, las capas, el
 * árbol de procesos). En Codex no vale el click ni un mensaje: su conversación no distingue lo que tipeó la persona de
 * lo que mete un programa (guides/firmas-del-arnes.md §«En Codex»). Ahí la constancia es la firma en la terminal
 * (harness-sign.js `acknowledge`): un renglón `plataforma: 'codex'`, `via: 'terminal'`, y una marca aparte que tiene que
 * coincidir. La acepta sólo quien la pide con `plataformas` que incluye `'codex'`; las firmas de hoy no.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib');
const stateDir = (casa) => require(path.join(LIB, 'state-dir.js')).stateDir(casa);
// la carpeta de Claude Code de la cuenta, por el ayudante: el nombre no se escribe acá
const carpetaClaude = (casa) => require(path.join(LIB, 'state-dir.js')).claudeDir(casa);
// el lector de transcripciones por renglones: uno solo, el mismo que lee la conversación
const lector = () => require(path.join(LIB, 'jsonl-lines.js'));
const VENCE_MIN = 30;
// la distancia entre la hora del registro y la del renglón de la transcripción
const MARGEN_MS = 2 * 60 * 1000;
const SESION = /^[\w-]+$/;
const CUADRO = 'AskUserQuestion';
const APRUEBA = 'Sí, aprobar';
const NIEGA = 'No';
// el motivo de una aprobación sobre otra pregunta con el mismo sello: el texto cambió y el código no (el formato nuevo del
// cuadro después de actualizar el arnés, o un texto alterado). No se reconoce el formato viejo: hace falta otro click
const PREGUNTA_CAMBIADA = 'la pregunta cambió con el mismo código (puede ser el formato nuevo del arnés, después de actualizar): hace falta un click nuevo';
// lo que llega como prompt sin que lo haya escrito la persona: mensajes de otra sesión, de un canal, avisos de tareas
const ENVUELTO = /<(?:cross-session-message|channel|task-notification|teammate-message|system-reminder|local-command|command-name)\b/i;
// los ganchos del arnés que pueden escuchar el cuadro: el aviso de espera, el que anota el click, el estado de la sesión y
// el freno que no deja preguntar a una sesión abierta por la coordinadora
const PERMITIDOS = ['wait-notice.js', 'owner-approval-record.js', 'session-state.js', 'background-question-guard.js'];
// Cómo anota la herramienta un mensaje tipeado, medido en transcripciones reales: en la consola `cli · typed`, en la extensión
// del editor `claude-vscode · sdk`. Otra sesión llega con `system`, y un programa (`claude -p`) con `sdk-cli`.
// `queued`: lo que la persona escribe mientras el agente trabaja, también por el control remoto desde el celular; llega
// encolado y con origen humano (coordination.js `typedBy` ya lo cuenta así). Un mensaje de otra sesión llega con origen
// `peer` y no pasa el chequeo del origen (@story-8.319)
const TIPEADO = { cli: ['typed', 'queued'], 'claude-vscode': ['sdk'] };
const CLAUDE_P = 'sdk-cli';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const una = (s, n = 200) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const ow = () => require('./owner-window.js');

function carpeta(casa) { return path.join(stateDir(casa), 'owner-approvals'); }

// --- qué es una aprobación ------------------------------------------------------------------------------------------

// el mensaje entero es una aprobación: «aprobado», «apruebo», «aprobalo», «sí, aprobar»…, con un «ok», «sí» o «dale»
// adelante si se quiere, y a lo sumo unas palabras después que no la condicionen
const FORMA = /^(?:(?:ok|okay|sí|si|dale|listo|bien)[\s,.!:]+)*(?:aprobad[oa]s?|apruebo|aprobalo|aprobala|aprobá|sí,?\s*aprobar)(?=[\s,.!]|$)/u;
// lo que la condiciona o la deja para después, aunque empiece bien
const CONDICIONA = /(^|[^\p{L}])(?:no|nunca|tampoco|ni|jamás|jamas|salvo|excepto|menos|pero|después|despues|luego|mañana|manana|tarde|cuando|si|antes|todavía|todavia|aún|aun|esperá|espera)(?=[^\p{L}]|$)/u;

/**
 * ¿El texto aprueba, sin duda? El mensaje entero (hasta 60 letras) es un «aprobado», sin preguntas ni nada que lo niegue,
 * lo condicione o lo deje para después. Ante la duda, no aprueba.
 */
function esAprobacion(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFC').trim().replace(/[.!\s]+$/u, '');
  if (!t || t.length > 60 || /[?¿]/.test(t)) return false;
  const m = FORMA.exec(t);
  if (!m) return false;
  return !CONDICIONA.test(t.slice(m[0].length));
}

/** El prompt, si lo escribió la persona y es un «aprobado»; null si no. */
function mensajeDeLaPersona(prompt) {
  const t = String(prompt == null ? '' : prompt).trim();
  if (!t || ENVUELTO.test(t)) return null;
  return esAprobacion(t) ? t : null;
}

/**
 * Las respuestas del cuadro, tal como las devolvió la herramienta (`tool_response`, nunca `tool_input`): `{ ok,
 * respuestas: [[pregunta, respuesta]…] }` o `{ ok: false, motivo }`. Lo que vale para el cuadro entero se mira acá: sin
 * resolución por ausencia (`afkTimeoutMs`) ni preguntas sin contestar (`annotations.*.unanswered`), ninguna cuenta.
 */
function respuestasDelCuadro(salida) {
  const r = salida && typeof salida === 'object' ? salida : null;
  if (!r) return { ok: false, motivo: 'la herramienta no devolvió respuesta' };
  if (r.afkTimeoutMs !== undefined && r.afkTimeoutMs !== null) return { ok: false, motivo: 'el cuadro se resolvió solo, por ausencia' };
  const notas = r.annotations && typeof r.annotations === 'object' ? Object.values(r.annotations) : [];
  if (notas.some((n) => n && typeof n === 'object' && n.unanswered)) return { ok: false, motivo: 'una pregunta quedó sin contestar' };
  const respuestas = r.answers && typeof r.answers === 'object' ? Object.entries(r.answers) : [];
  return respuestas.length ? { ok: true, respuestas } : { ok: false, motivo: 'nadie contestó el cuadro' };
}

/** `{ ok, pregunta, respuesta }` si la respuesta a esa pregunta aprueba, o `{ ok: false, motivo }`. */
function unaRespuesta([pregunta, respuesta]) {
  if (typeof respuesta !== 'string' || !esAprobacion(respuesta)) return { ok: false, motivo: 'la opción elegida no aprueba' };
  return { ok: true, pregunta: String(pregunta), respuesta };
}

/**
 * La respuesta del cuadro a una pregunta: `{ ok, pregunta, respuesta }` si la persona eligió una opción que aprueba, o
 * `{ ok: false, motivo }`. Sin `pregunta`, el cuadro tiene que traer una sola. Con `pregunta`, se mira sólo la respuesta
 * a ésa, como si fuera un cuadro de una sola pregunta: en un cuadro con varias firmas, cada una tiene la suya.
 */
function respuestaDelCuadro(salida, { pregunta } = {}) {
  const todas = respuestasDelCuadro(salida);
  if (!todas.ok) return todas;
  if (pregunta === undefined) return todas.respuestas.length === 1 ? unaRespuesta(todas.respuestas[0]) : { ok: false, motivo: 'el cuadro tenía más de una pregunta' };
  const esa = todas.respuestas.find(([p]) => p === pregunta);
  return esa ? unaRespuesta(esa) : { ok: false, motivo: 'el cuadro no trae esa pregunta' };
}

/** Las preguntas del cuadro cuya respuesta aprueba, cada una como `{ pregunta, respuesta }`; ninguna si el cuadro no vale entero. */
function aprobadasDelCuadro(salida) {
  const todas = respuestasDelCuadro(salida);
  return todas.ok ? todas.respuestas.map(unaRespuesta).filter((r) => r.ok).map(({ pregunta, respuesta }) => ({ pregunta, respuesta })) : [];
}

// lo que puede seguir a «sesión» en una frase sin nombrar ninguna; cualquier otra palabra cuenta como un id, y ante la duda
// la aprobación no vale y se pide de nuevo
const NO_ES_ID = new Set(['que', 'y', 'o', 'en', 'con', 'para', 'por', 'sin', 'a', 'al', 'su', 'sus', 'esta', 'este', 'es', 'se',
  'anterior', 'actual', 'nueva', 'nuevo', 'misma', 'mismo', 'propia', 'destino', 'coordinadora', 'principal', 'otra', 'otro']);

/** Lo que un texto nombra como sesión, en minúsculas: la palabra que sigue a «sesión» o a «sesión de», con o sin puntuación. */
function sesionesNombradas(texto) {
  return [...String(texto).matchAll(/(?:^|[^\p{L}\p{N}_-])sesi[oó]n[\s:=«"'`([]+(?:(?:de|del|la|el)\s+)*([\p{L}\p{N}_-]+)/giu)].map((m) => m[1].toLowerCase()).filter((s) => !NO_ES_ID.has(s));
}

// Los topes de la pregunta, medidos para un teléfono: lo que no entra va al detalle (`detalle`, aparte de la pregunta), y
// el corte siempre se ve («(sigue en el detalle)», «y N más en el detalle»), nunca a mitad de palabra ni con «…»
const LINEAS_QUE_HACE = 2;
const LARGO_DE_LINEA = 140;
const LARGO_DE_FRASE = 200;
const LARGO_DEL_TITULO = 80;
const MINIMO_QUE_HACE = 60;
// La pregunta entera, con su sello, que se ve sin desplazar en un teléfono encima de las dos opciones. Provisorio: la
// historia 8.275 lo fija en 600 hasta medirlo en la captura del teléfono del dueño (letras por renglón × renglones)
const LARGO_EN_TELEFONO = 600;
const SIGUE = '(sigue en el detalle)';
const sinPunto = (s) => String(s).replace(/[.\s]+$/, '');
const enUnRenglon = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/**
 * `texto` en un renglón de hasta `n` letras: si no entra, hasta la última oración que entra («. », «; » o «: ») o, sin
 * ninguna, hasta la última palabra entera, y « (sigue en el detalle)». Nunca deja menos de 20 letras: corta en la palabra.
 */
function recortar(texto, n) {
  const t = enUnRenglon(texto);
  if (t.length <= n) return t;
  const cabeza = t.slice(0, Math.max(1, n - SIGUE.length - 1));
  const enOracion = Math.max(...['. ', '; ', ': '].map((s) => cabeza.lastIndexOf(s)));
  const enPalabra = cabeza.lastIndexOf(' ');
  const corte = enOracion >= 20 ? enOracion : enPalabra > 0 ? enPalabra : cabeza.length;
  return `${sinPunto(cabeza.slice(0, corte)).replace(/[,;:]$/, '')} ${SIGUE}`;
}

// una ruta absoluta (`/…`, `~/…`, `C:\…`, `\\red\…`) donde no la precede una letra, un número, un punto, un guion ni «:»
// (así una URL o «host:/ruta» quedan como están). Un espacio sigue en la ruta sólo dentro de una carpeta, con dos tramos
// antes y otra barra después («/x/Mis Documentos/…»); después de un archivo («/x/a.js src/b.js») la ruta termina
const RUTA = /(?<![\p{L}\p{N}._\-~:\\/])((?:\\\\|\/|~\/|[A-Za-z]:[\\/])(?:[^\s»)\]"'`”’>|;&]|(?<=[\\/][^\\/]+[\\/][^\s\\/.»)\]"'`]+)\s(?=[^\s»)\]"'`\\/]+[\\/]))*)/gu;
/**
 * El texto con cada ruta absoluta por el nombre de su archivo: lo que se ve en el teléfono; la ruta, en el detalle. Un
 * comando de barra («/tycon-merge-to-main»: una palabra sola, sin punto) no es una ruta y queda como está.
 */
function sinRutas(texto) {
  return String(texto == null ? '' : texto).replace(RUTA, (todo, cruda) => {
    const [, ruta, cierre] = /^(.*?)([.,;:]*)$/.exec(cruda);
    if (/^\/[^/.]+$/.test(ruta)) return todo;
    const nombre = ruta.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return nombre ? `${nombre}${cierre}` : todo;
  });
}

/** Los números de los criterios: todos, o en tramos («AC 3 a 9 y 12») si hace falta achicar. */
function criteriosEnPalabras(nums, enTramos) {
  if (!enTramos) return nums.length > 1 ? `${nums.slice(0, -1).join(', ')} y ${nums[nums.length - 1]}` : String(nums[0]);
  const tramos = [];
  for (const n of nums) {
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && n === ultimo[1] + 1) ultimo[1] = n; else tramos.push([n, n]);
  }
  const dichos = tramos.flatMap(([a, b]) => (b - a >= 2 ? [`${a} a ${b}`] : a === b ? [String(a)] : [String(a), String(b)]));
  return dichos.length > 1 ? `${dichos.slice(0, -1).join(', ')} y ${dichos[dichos.length - 1]}` : dichos[0];
}

/** La primera oración del texto, sin su punto final. */
const primeraOracion = (s) => { const t = enUnRenglon(s); const m = /^(.+?[.!?])(\s|$)/.exec(t); return m ? sinPunto(m[1]) : t; };

/**
 * El cuadro de una firma: lo arma el guion, y el agente lo muestra tal cual. La pregunta dice, en este orden, lo que se
 * aprueba (`que`, con su verbo: no lleva «¿Aprobás» delante), la historia (`historia`: { id, titulo }; el título si
 * tiene hasta 80 letras) y la sesión por sus 8 primeras letras, los criterios, qué hace (`queHace`, hasta 2 renglones de
 * 140), cuántos archivos toca y de qué zonas (`archivos`, file-zones.js: las rutas no se muestran), dónde está lo
 * completo (`completoEnPalabras`; la ruta `completo`, en el detalle), qué pasa si sale mal, y al final la cita de la
 * sesión, que no reemplaza nada de lo anterior. `criterios`: los números de los criterios que se eximen o se marcan; van
 * todos, antes de «Qué hace», porque un número que no se ve no se aprobó. `nota`: por qué no se pudo leer la fuente; va
 * al final de «Qué hace». Ninguna ruta absoluta se ve: se dice por el nombre de su archivo, y entera en el detalle.
 *
 * El tope: la pregunta con su sello entra en `LARGO_EN_TELEFONO`, achicando en orden (el título al detalle, la cita a su
 * primera oración, «Qué hace» a un renglón, la revisión sin notas, los criterios en tramos, la cita al detalle, «Completo
 * en» al detalle, «Qué hace» al lugar que queda). Lo que se aprueba, la sesión, los números de los criterios, los archivos,
 * «si sale mal», lo que hace cada opción y el sello no se sacan; si igual no entra, `pasaElTope` lo dice y la pregunta se
 * da entera (`renglonDelTope`). Los cuadros del click del dueño no se achican: llevan lo que hace cada opción. Con
 * `todoQueHace` (el guardado ajeno) nada se corta, se resume ni se cambia: la fuente promete que todo lo que se aprueba
 * está a la vista.
 *
 * `sello`: lo que ata la aprobación a esa firma, esa sesión y lo que se mostró (`huella`); `texto`: la pregunta sin el
 * sello, la que muestra la ventana de permiso; `detalle`: los renglones enteros de lo que no entró, que no son parte de
 * la pregunta ni del cuadro de opciones (`comando`, el pedido sin los valores que nombran archivos, va ahí). Con
 * `soloClick`, sólo lo aprueba un click en la sesión que trabaja, y el cuadro se muestra con sus `descripciones`. Con
 * `clickDelDueno`, lo aprueba sólo un click, también en la pestaña de la coordinadora, y lo que hace cada opción va en la
 * pregunta.
 */
function cuadroDe(datos) {
  // con `explica` (lo que la sesión que hizo el cambio declara: qué cambia, por qué y su riesgo, o null si no declaró nada)
  // el cuadro dice eso primero, y la sesión, los conteos, «Completo en» y el «si sale mal» de siempre van al detalle
  if (datos.explica !== undefined) return cuadroQueExplica(datos);
  return cuadroDeSiempre(datos);
}

/**
 * El cuadro de un cambio que su sesión explica (hoy, el cambio de control): «¿Lo que se aprueba?», «Qué cambia», «Por
 * qué» y «Riesgo», en castellano llano y tal como los escribió la sesión; sin explicación, lo dice en vez de rellenar. Al
 * final el sello, igual que en todos los cuadros: ata el click a la firma, la sesión y lo que se mostró (`huella`, que
 * lleva también el texto de la explicación). El resto (la sesión, lo que la fuente cuenta, dónde está lo completo, el
 * «si sale mal» genérico) va al detalle.
 */
function cuadroQueExplica({ firma, destino, que, explica, queHace = [], archivos = [], completo = null, siSaleMal, cita = null, huella, soloClick = false, clickDelDueno = false, descripciones = null, comando = null }) {
  const sello = `firma ${firma} · sesión ${destino} · código ${huella}`;
  const vista = (s) => sinRutas(enUnRenglon(s));
  const partes = [`¿${recortar(vista(que), LARGO_DE_FRASE).replace(/^./, (c) => c.toUpperCase())}?`];
  const dichos = [];
  if (explica) {
    for (const [rotulo, valor] of [['Qué cambia', explica.cambia], ['Por qué', explica.porque], ['Riesgo', explica.riesgo]]) {
      dichos.push([rotulo, valor]);
      partes.push(`${rotulo}: ${valor ? sinPunto(vista(valor)) : 'el cambio no lo dice'}.`);
    }
  } else partes.push('El cambio no explica qué hace, por qué ni su riesgo: pedile a la sesión que lo escriba en sus commits (Cambia-control:, Por-que:, Riesgo:) antes de firmar.');
  if (clickDelDueno && !soloClick && Array.isArray(descripciones)) partes.push(`«${APRUEBA}»: ${sinPunto(vista(descripciones[0]))}. «${NIEGA}»: ${sinPunto(vista(descripciones[1]))}. Sólo vale tu click.`);
  const pregunta = `${partes.join(' ')} (${sello})`;
  const texto = pregunta.slice(0, pregunta.length - sello.length - 3);
  const detalle = [];
  // lo declarado se ve entero: si una ruta se cambió por su nombre, va también tal cual
  for (const [rotulo, valor] of dichos) if (valor && vista(valor) !== enUnRenglon(valor)) detalle.push(`${rotulo}: ${enUnRenglon(valor)}`);
  if (destino) detalle.push(`Sesión: ${destino}`);
  (queHace || []).map((l) => enUnRenglon(l)).filter(Boolean).forEach((l) => detalle.push(`Qué hace: ${l}`));
  const zonas = require('./file-zones.js').zonasDe(archivos);
  if (zonas) detalle.push(`Archivos: ${zonas}`);
  if (completo) detalle.push(`Completo en: ${enUnRenglon(completo)}`);
  if (siSaleMal) detalle.push(`Si sale mal: ${enUnRenglon(siSaleMal)}`);
  if (cita) detalle.push(`Cita: ${enUnRenglon(cita)}`);
  if (comando) detalle.push(`El comando: ${enUnRenglon(comando)}`);
  return { sello, texto, pregunta, opciones: [APRUEBA, NIEGA], detalle, largo: pregunta.length, tope: LARGO_EN_TELEFONO, pasaElTope: pregunta.length > LARGO_EN_TELEFONO,
    ...(soloClick ? { soloClick: true, descripciones } : {}), ...(clickDelDueno && !soloClick ? { clickDelDueno: true } : {}) };
}

function cuadroDeSiempre({ firma, destino, que, historia = null, criterios = [], queHace = [], todoQueHace = false, nota = null, archivos = [], completo = null, completoEnPalabras = null, revision = null, siSaleMal, cita = null, huella, soloClick = false, clickDelDueno = false, descripciones = null, comando = null }) {
  const sello = `firma ${firma} · sesión ${destino} · código ${huella}`;
  // lo que se ve: en un renglón y sin rutas absolutas (el guardado ajeno, tal cual)
  const vista = (s) => (todoQueHace ? String(s == null ? '' : s) : sinRutas(enUnRenglon(s)));
  const detalle = [];
  const alDetalle = (rotulo, entero, visto) => { if (entero && entero !== visto) detalle.push(`${rotulo}: ${entero}`); };
  const lineas = (queHace || []).map((l) => (todoQueHace ? String(l == null ? '' : l) : enUnRenglon(l))).filter(Boolean);
  const nums = [...new Set((criterios || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const notas = revision && revision.linea ? (revision.detalle || []).map((l) => enUnRenglon(String(l).replace(/^-\s*/, ''))).filter(Boolean) : [];
  const ses = String(destino == null ? '' : destino).slice(0, 8);
  const lo = recortar(vista(que), LARGO_DE_FRASE);
  const todo = enUnRenglon(completo);

  const armar = (nivel, largoQueHace = LARGO_DE_LINEA) => {
    const partes = [`¿${lo.charAt(0).toUpperCase()}${lo.slice(1)}?`];
    // la sesión sobre la que se firma, siempre: la coordinadora puede pedir la firma para otra
    if (historia && historia.id) {
      const id = String(historia.id).slice(0, 40);
      const titulo = historia.titulo && nivel < 1 && enUnRenglon(historia.titulo).length <= LARGO_DEL_TITULO ? vista(historia.titulo) : null;
      partes.push(!historia.titulo ? `Historia ${id} (sin título en su archivo), sesión ${ses}.` : titulo ? `Historia ${id}, «${titulo}», sesión ${ses}.` : `Historia ${id}, sesión ${ses}.`);
    } else if (destino) partes.push(`Sesión ${ses}.`);
    if (nums.length) partes.push(`Criterios: AC ${criteriosEnPalabras(nums, nivel >= 5)}.`);
    if (lineas.length) {
      const cuantas = todoQueHace ? lineas.length : nivel >= 3 ? 1 : LINEAS_QUE_HACE;
      const vistas = todoQueHace ? lineas : lineas.slice(0, cuantas).map((l) => sinPunto(recortar(vista(l), largoQueHace)));
      const resto = lineas.length - vistas.length;
      const mas = resto ? ` · y ${resto} más en el detalle` : '';
      partes.push(`Qué hace: ${vistas.join(' · ')}${mas}${nota ? ` ${sinPunto(recortar(vista(nota), LARGO_DE_LINEA))}` : ''}.`);
    }
    const zonas = require('./file-zones.js').zonasDe(archivos);
    if (zonas) partes.push(`Archivos: ${zonas}.`);
    if (todo && nivel < 7) partes.push(`Completo en: ${sinPunto(recortar(completoEnPalabras ? enUnRenglon(completoEnPalabras) : sinRutas(todo), LARGO_DE_FRASE))}.`);
    // el resultado de la revisión automática del plan, con sus notas debajo
    if (revision && revision.linea) {
      const debajo = nivel >= 4 ? [] : notas.slice(0, LINEAS_QUE_HACE).map((l) => sinPunto(recortar(vista(l), LARGO_DE_LINEA)));
      const masNotas = notas.length > debajo.length && debajo.length ? ` · y ${notas.length - debajo.length} más en el detalle` : '';
      partes.push(`Revisión automática: ${sinPunto(recortar(vista(revision.linea), LARGO_DE_FRASE))}${debajo.length ? `: ${debajo.join(' · ')}${masNotas}` : ''}.`);
    }
    partes.push(`Si sale mal: ${sinPunto(recortar(vista(siSaleMal), LARGO_DE_FRASE))}.`);
    if (cita && nivel < 6) partes.push(`Cita de la sesión: «${recortar(nivel >= 2 ? primeraOracion(vista(cita)) : vista(cita), LARGO_DE_FRASE)}».`);
    // el click del dueño: lo que hace cada opción va en la pregunta, que la coordinadora muestra tal cual desde su lista
    if (clickDelDueno && !soloClick && Array.isArray(descripciones)) partes.push(`«${APRUEBA}»: ${sinPunto(recortar(vista(descripciones[0]), LARGO_DE_FRASE))}. «${NIEGA}»: ${sinPunto(recortar(vista(descripciones[1]), LARGO_DE_FRASE))}. Sólo vale tu click.`);
    return `${partes.join(' ')} (${sello})`;
  };

  // el guardado ajeno y los cuadros del click del dueño no se achican (llevan lo que hace cada opción): se dan enteros,
  // con el aviso del tope si no entran
  let nivel = 0;
  if (!todoQueHace && !clickDelDueno) while (nivel < 7 && armar(nivel).length > LARGO_EN_TELEFONO) nivel += 1;
  // con todo lo demás achicado, «Qué hace» toma el lugar que queda, sin bajar de 60 letras
  let largoQueHace = LARGO_DE_LINEA;
  if (nivel === 7) while (largoQueHace > MINIMO_QUE_HACE && armar(nivel, largoQueHace).length > LARGO_EN_TELEFONO) largoQueHace -= 5;
  const pregunta = armar(nivel, largoQueHace);
  const texto = pregunta.slice(0, pregunta.length - sello.length - 3);

  // el detalle: lo entero de lo que no se vio entero, sin la lista de archivos (se cuentan; la huella la ata a la firma)
  // `entero`: el texto se ve tal cual (ni cortado ni con una ruta cambiada por su nombre)
  const entero = (s) => enUnRenglon(vista(s)) === enUnRenglon(s) && texto.includes(sinPunto(enUnRenglon(s)));
  // «Qué hace» del guardado ajeno se ve entero; lo demás de ese cuadro se corta como en cualquier otro, y va al detalle
  if (!todoQueHace) {
    const vistas = lineas.slice(0, nivel >= 3 ? 1 : LINEAS_QUE_HACE);
    if (lineas.length > vistas.length || !lineas.every(entero)) lineas.forEach((l) => detalle.push(`Qué hace: ${l}`));
    if (nota && !entero(nota)) detalle.push(`Nota: ${enUnRenglon(nota)}`);
  }
  if (historia && historia.titulo && !texto.includes(`«${vista(historia.titulo)}»`)) detalle.push(`Título: ${enUnRenglon(historia.titulo)}`);
  // sin la palabra «sesión»: el detalle va al lado de la pregunta, y un «aprobado» no puede leerlo como otra sesión
  if (cita && !entero(cita)) detalle.push(`Cita: ${enUnRenglon(cita)}`);
  if (revision && revision.linea && !entero(revision.linea)) detalle.push(`Revisión automática: ${enUnRenglon(revision.linea)}`);
  notas.forEach((l) => { if (!entero(l)) detalle.push(`Revisión: ${l}`); });
  if (!entero(siSaleMal)) detalle.push(`Si sale mal: ${enUnRenglon(siSaleMal)}`);
  if (clickDelDueno && !soloClick && Array.isArray(descripciones)) {
    [APRUEBA, NIEGA].forEach((op, k) => { if (!entero(descripciones[k])) detalle.push(`«${op}»: ${enUnRenglon(descripciones[k])}`); });
  }
  alDetalle('Lo que se aprueba', enUnRenglon(que), lo);
  if (todo) detalle.push(`Completo en: ${todo}`);
  if (comando) detalle.push(`El comando: ${enUnRenglon(comando)}`);
  return { sello, texto, pregunta, opciones: [APRUEBA, NIEGA], detalle, largo: pregunta.length, tope: LARGO_EN_TELEFONO, pasaElTope: pregunta.length > LARGO_EN_TELEFONO,
    ...(soloClick ? { soloClick: true, descripciones } : {}), ...(clickDelDueno && !soloClick ? { clickDelDueno: true } : {}) };
}

/** El renglón aparte de un cuadro que no entra en el teléfono, o null si entra. No frena nada. */
function renglonDelTope(cuadro) {
  return cuadro && cuadro.pasaElTope ? `Este cuadro pasa el tope del teléfono (${cuadro.largo} de ${cuadro.tope} letras): leelo en la máquina si no se ve entero.` : null;
}

/** Lo que acompaña al cuadro para quien lo muestra: el detalle (aparte de la pregunta) y el renglón del tope. */
function notasDelCuadro(cuadro) {
  const lineas = [];
  if (cuadro && Array.isArray(cuadro.detalle) && cuadro.detalle.length) lineas.push(`${DETALLE_TITULO}`, ...cuadro.detalle.map((l) => `- ${l}`));
  const tope = renglonDelTope(cuadro);
  if (tope) lineas.push(tope);
  return lineas;
}
const DETALLE_TITULO = 'Detalle (no va en el cuadro; mostralo si la persona lo pide):';

/** El sello con que termina una pregunta de `cuadroDe` (« (firma … · código …)», sin contar espacios al final), o null. */
function selloAlFinal(pregunta) {
  const p = String(pregunta || '').trimEnd();
  const i = p.lastIndexOf(' (firma ');
  return i >= 0 && p.endsWith(')') ? p.slice(i + 2, -1) : null;
}

/**
 * ¿El mensaje del agente trae la pregunta que armó el guion (`pregunta`; sin ella, el sello) y no nombra otra sesión que la
 * destino? Para el «aprobado» escrito. El sello solo, pegado a otra pregunta, haría aprobar una cosa y firmar otra. Lo que
 * dice la pregunta no cuenta como sesión nombrada: su detalle copia el motivo del comando.
 */
function traeElSello(texto, { sello, destino, pregunta }) {
  const t = String(texto || '');
  const resto = pregunta ? t.split(pregunta).join(' ') : t;
  return !!sello && t.includes(pregunta || sello) && sesionesNombradas(resto).every((s) => s === String(destino).toLowerCase());
}

// --- quién lanzó el gancho ------------------------------------------------------------------------------------------

/**
 * ¿Al gancho lo lanzó la herramienta, sin la consola de un agente ni otra herramienta en el medio? `{ ok, herramienta }`
 * o `{ ok: false, motivo }`. Un agente que corre el gancho a mano lo lanza desde su consola; uno que abre otra sesión en
 * una pseudo-terminal tiene esa consola arriba de la herramienta nueva. Sin árbol, no anota. En Windows, entre el gancho
 * y la herramienta sólo puede haber Git Bash o el mismo Node (medido): lo demás podría ser una consola que no se lee.
 */
function lanzadoPorLaHerramienta({ arbol, pid = process.pid, casa, plataforma = process.platform } = {}) {
  const w = ow();
  const enWindows = plataforma === 'win32';
  const a = w.arbolDeLaPlataforma(arbol, plataforma);
  if (!a) return { ok: false, motivo: 'no pude leer los procesos de la máquina' };
  const m = new Map(a.map((p) => [p.pid, p]));
  const consola = (p) => (enWindows ? w.esConsolaDeWindows(p) : w.desenvolver(p.comando, casa) !== null);
  const permitidoEnWindows = (p) => !!w.gitBashDe(p.ejecutable) || /^node\.exe$/i.test(String(p.ejecutable || '').split(/[\\/]/).pop());
  let p = m.get(pid);
  const vistos = new Set();
  while (p && !vistos.has(p.pid)) {
    vistos.add(p.pid);
    if (p.pid !== pid && w.esHerramienta(p)) break;
    if (p.pid !== pid && consola(p)) return { ok: false, motivo: 'al gancho lo lanzó la consola de un agente' };
    if (p.pid !== pid && enWindows && !permitidoEnWindows(p)) return { ok: false, motivo: 'al gancho no lo lanzó la herramienta' };
    p = m.get(p.ppid);
  }
  if (!p || !w.esHerramienta(p)) return { ok: false, motivo: 'al gancho no lo lanzó la herramienta' };
  const tool = p;
  for (let q = m.get(tool.ppid); q && !vistos.has(q.pid); q = m.get(q.ppid)) {
    vistos.add(q.pid);
    if (consola(q) || (w.esHerramienta(q) && !w.esAnfitrionDeFondoDe(tool, q, m.get(tool.ppid)))) return { ok: false, motivo: 'la herramienta la lanzó otra herramienta o la consola de un agente' };
  }
  return { ok: true, herramienta: { pid: tool.pid, inicio: tool.inicio } };
}

// --- el registro ----------------------------------------------------------------------------------------------------

/** Anota una aprobación de `registro.sesion`. Tira si no puede escribir. */
function anotar(casa, registro) {
  if (!registro || !SESION.test(String(registro.sesion || ''))) throw new Error('la aprobación no dice de qué sesión es');
  const dir = carpeta(casa);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${registro.sesion}.jsonl`), `${JSON.stringify(registro)}\n`);
}

function leerSesion(casa, sesion) {
  let texto;
  try { texto = fs.readFileSync(path.join(carpeta(casa), `${sesion}.jsonl`), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`no pude leer las aprobaciones de la sesión ${sesion} (${e.code || e.message})`);
  }
  const fuera = [];
  for (const l of texto.split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (r && typeof r === 'object') fuera.push({ ...r, id: sha(l) }); } catch (_) { /* renglón a medias */ }
  }
  return fuera;
}

const usada = (casa, id) => fs.existsSync(path.join(carpeta(casa), 'usadas', id));

/** Marca la aprobación como usada; `{ ok }` o `{ ok: false, motivo }` si ya la usó otra firma. */
function consumir(casa, aprobacion, { ahora = Date.now(), firma, sesion } = {}) {
  const dir = path.join(carpeta(casa), 'usadas');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, aprobacion.id), `${JSON.stringify({ ts: new Date(ahora).toISOString(), firma, sesion })}\n`, { flag: 'wx' });
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: e.code === 'EEXIST' ? 'esa aprobación ya la usó otra firma' : `no pude marcar la aprobación como usada (${e.code || e.message})` };
  }
}

/** Devuelve una aprobación recién marcada como usada, porque su pedido no se pudo escribir. Si tampoco se puede, queda usada y se pide de nuevo. */
function devolver(casa, aprobacion) {
  try { fs.unlinkSync(path.join(carpeta(casa), 'usadas', aprobacion.id)); } catch (_) { /* falla cerrado: una aprobación de menos */ }
}

// --- lo de Claude Code: la transcripción y los ganchos que escuchan el cuadro ------------------------------------------

/** La transcripción de la sesión: `~/.claude/projects/<carpeta>/<sesión>.jsonl`, de la casa de la cuenta. */
function transcripcionDe(casa, sesion) {
  if (!SESION.test(String(sesion || ''))) return null;
  const raiz = path.join(casa, '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(raiz, { withFileTypes: true }); } catch (_) { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const r = path.join(raiz, d.name, `${sesion}.jsonl`);
    if (fs.existsSync(r)) return r;
  }
  return null;
}

/**
 * Los renglones de la transcripción, de a trozos (una de más de 512 MB no entra en un texto). Con `filtro`, sólo los que
 * lo traen; con `tope`, una que pasa del tope no se lee (`code: 'ETOPE'`).
 */
const renglones = (ruta, opciones) => lector().leerRenglones(ruta, opciones);

const bloques = (r) => (r && r.message && Array.isArray(r.message.content) ? r.message.content : []);
const textoDe = (r) => {
  const c = r && r.message && r.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b) => b && b.type === 'tool_result')) return null;
  return c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
};
const cerca = (r, ts) => { const t = Date.parse(r && r.timestamp); const u = Date.parse(ts); return Number.isFinite(t) && Number.isFinite(u) && Math.abs(t - u) <= MARGEN_MS; };

// el renglón que un proceso de terminal escribe en la transcripción al encender el control remoto
const CONTROL_REMOTO = 'bridge_status';

/**
 * ¿El proceso `pid` de la sesión `sesion` tiene ahora el control remoto encendido? Claude Code lo anota en el registro de
 * sesión del proceso (`sessions/<pid>.json`, `bridgeSessionId`), en la terminal y en la extensión; la
 * transcripción no sirve para esto: la extensión no escribe `bridge_status`, y el de un proceso anterior no dice nada del
 * actual. Sin el campo es `false`, salvo que haya un `bridge_status` posterior a su arranque: se apagó, el campo cambió
 * de nombre o lo escribió otra copia de la sesión, y la transcripción no dice cuál (`null`: se avisa de más, nunca de
 * menos). También es `null` un registro ilegible o una transcripción que no se lee. `undefined`: no hay dato, porque el proceso no tiene registro o es de otra sesión (otra herramienta, un pid
 * reusado). Dice que el control remoto estaba encendido, no desde qué aparato se contestó.
 */
function controlRemotoDelProceso(casa, pid, sesion) {
  if (!Number.isInteger(pid)) return undefined;
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(carpetaClaude(casa), 'sessions', `${pid}.json`), 'utf8')); } catch (e) {
    return e.code === 'ENOENT' ? undefined : null;
  }
  if (!s || s.sessionId !== sesion) return undefined;
  if (typeof s.bridgeSessionId === 'string' && s.bridgeSessionId) return true;
  const ruta = transcripcionDe(casa, sesion);
  if (!ruta) return false;
  try {
    return renglones(ruta, { filtro: CONTROL_REMOTO }).some((r) => r && r.type === 'system' && r.subtype === CONTROL_REMOTO && Date.parse(r.timestamp) >= s.startedAt) ? null : false;
  } catch (_) { return null; }
}

/**
 * El mensaje en la transcripción, tipeado por la persona a la hora del registro, después de un mensaje del agente que
 * trae el sello de la firma: `{ ok }` o `{ ok: false, motivo }`.
 */
function mensajeEnLaTranscripcion(ruta, a, { sello, destino, pregunta } = {}) {
  let rs;
  // el «aprobado» necesita los renglones en orden: no se filtra, y una transcripción que pasa del tope no se lee
  try { rs = renglones(ruta, { tope: true }); } catch (e) {
    if (e.code === 'ETOPE') return { ok: false, motivo: `la transcripción de esta pestaña pasa de ${lector().tamanoDelTope()}: un «aprobado» escrito no se puede confirmar; aprobá con el click del cuadro o en la terminal`, noLeida: true };
    return { ok: false, motivo: `no pude leer la transcripción (${e.code || e.message})`, noLeida: true };
  }
  const t = String(a.texto || '').trim();
  // el renglón más cercano a la hora del registro: dos «aprobado» seguidos no se validan contra el mismo
  let i = -1;
  let distancia = Infinity;
  rs.forEach((x, k) => {
    if (!x || x.type !== 'user' || String(textoDe(x) || '').trim() !== t || !cerca(x, a.ts)) return;
    const d = Math.abs(Date.parse(x.timestamp) - Date.parse(a.ts));
    if (d < distancia) { distancia = d; i = k; }
  });
  if (i < 0) return { ok: false, motivo: 'el mensaje no está en la transcripción de la sesión a esa hora' };
  const r = rs[i];
  if (r.isMeta === true || !r.origin || r.origin.kind !== 'human') return { ok: false, motivo: 'el mensaje no lo escribió una persona (lo mandó otra sesión o un programa)' };
  if (!(TIPEADO[r.entrypoint] || []).includes(r.promptSource)) {
    // bajo claude -p no hay quien apruebe escribiendo: el motivo dice dónde se aprueba
    const donde = r.entrypoint === CLAUDE_P ? ': bajo claude -p un mensaje escrito no vale como aprobación: aprobá en una sesión con ventana (la terminal o la extensión) o con el cuadro de la coordinadora' : '';
    return { ok: false, motivo: `el mensaje no lo tipeó una persona: llegó por ${una(r.entrypoint, 40)} · ${una(r.promptSource, 40)}${donde}` };
  }
  // lo que el agente dijo después del mensaje anterior de la persona: una pregunta se contesta una sola vez
  let antes = null;
  for (let k = i - 1; k >= 0 && antes === null; k--) {
    if (rs[k] && rs[k].type === 'user' && rs[k].origin && rs[k].origin.kind === 'human' && textoDe(rs[k]) !== null) break;
    if (rs[k] && rs[k].type === 'assistant' && textoDe(rs[k])) antes = textoDe(rs[k]);
  }
  if (!traeElSello(antes, { sello, destino, pregunta })) {
    // con el sello y sin la pregunta entera, la persona no vio qué aprueba: se dice eso, no que falta el sello
    if (pregunta && sello && String(antes || '').includes(sello) && !String(antes).includes(pregunta)) {
      return { ok: false, motivo: `lo último que dijo el agente antes del «aprobado» no trae la pregunta entera, sólo su sello: mostrale la pregunta tal cual la armó el freno; ${PREGUNTA_CAMBIADA}` };
    }
    return { ok: false, motivo: `lo último que dijo el agente antes del «aprobado» no trae «${sello}», o nombra otra sesión` };
  }
  return { ok: true };
}

// lo que dice la marca de ausente cuando no hay mensajes de la persona que leer (Codex, `claude -p`, una transcripción
// rota): se pierde el atajo de la marca, no la autonomía
const SIN_MENSAJES_DE_LA_PERSONA = 'no pude leer los mensajes de la persona: el dueño cuenta como ausente por los minutos sin respuesta';
const FRASE_RECIENTE_MS = 30 * 60 * 1000;

/**
 * ¿`frase` está en un mensaje tipeado por la persona en la transcripción de `sesion`, en los últimos 30 minutos antes de
 * `ahora`? El mismo criterio que el «aprobado» escrito: origen humano y tipeado (`TIPEADO`), nunca un mensaje envuelto
 * (otra sesión, un canal, un aviso) ni uno de un programa. La frase se busca dentro del mensaje, sin distinguir
 * mayúsculas ni espacios. `{ ok }`, o `{ ok: false, motivo, sinTranscripcion? }`.
 */
function fraseTipeadaReciente({ casa = os.homedir(), sesion, frase, ahora = Date.now() } = {}) {
  const ruta = transcripcionDe(casa, sesion);
  if (!ruta) return { ok: false, motivo: SIN_MENSAJES_DE_LA_PERSONA, sinTranscripcion: true };
  let rs;
  try { rs = renglones(ruta, { tope: true }); } catch (_) { return { ok: false, motivo: SIN_MENSAJES_DE_LA_PERSONA, sinTranscripcion: true }; }
  const normal = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const buscada = normal(frase);
  if (!buscada) return { ok: false, motivo: 'falta la frase del dueño' };
  const tipeada = rs.some((r) => {
    if (!r || r.type !== 'user' || r.isMeta === true || !r.origin || r.origin.kind !== 'human') return false;
    if (!(TIPEADO[r.entrypoint] || []).includes(r.promptSource)) return false;
    const texto = textoDe(r);
    if (texto === null || ENVUELTO.test(texto)) return false;
    const t = Date.parse(r.timestamp);
    return Number.isFinite(t) && t <= ahora + MARGEN_MS && ahora - t <= FRASE_RECIENTE_MS && normal(texto).includes(buscada);
  });
  return tipeada ? { ok: true }
    : { ok: false, motivo: `«${String(frase).slice(0, 80)}» no está en un mensaje tipeado por la persona en esta sesión en los últimos 30 minutos (un mensaje de otra sesión, de un canal o de un programa no cuenta)` };
}

function pistaDeVersion(renglon) {
  // el click ya se negó: esto sólo agrega qué actualizar, y si no se puede cargar la negativa queda igual
  try { return require('./claude-versions.js').clickHint(renglon); } catch (_) { return ''; }
}

/**
 * Dónde difiere la pregunta que armó el guion de la que contestó la persona: un renglón en `hook-errors.log` con el sello
 * (la firma y la sesión destino), la sesión del click, la huella y el largo de cada una, y desde el primer carácter
 * distinto hasta 40 de cada una. Sin la casa, o si no se puede escribir, no anota: la negativa es la misma.
 */
function anotarPreguntaDistinta({ casa, sello, sesion, esperada, recibida }) {
  if (!casa) return;
  try {
    const e = String(esperada || '');
    const r = String(recibida || '');
    let i = 0;
    while (i < e.length && i < r.length && e[i] === r[i]) i++;
    const huella = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
    fs.mkdirSync(stateDir(casa), { recursive: true });
    fs.appendFileSync(path.join(stateDir(casa), 'hook-errors.log'), `[${new Date().toISOString()}] owner-approvals: la pregunta del cuadro no es la del guion · ${una(sello, 200)} · click de ${una(sesion, 80)} · huellas ${huella(e)}/${huella(r)} (guion/cuadro) · largos ${e.length}/${r.length} · primer carácter distinto: ${i} · guion ${JSON.stringify(e.slice(i, i + 40))} · cuadro ${JSON.stringify(r.slice(i, i + 40))}\n\n`);
  } catch (_) { /* sin registro: la negativa es la misma */ }
}

/**
 * El cuadro en la transcripción: la pregunta es la que armó el guion, la respuesta es la del registro, a esa hora, y no la
 * dio un gancho. `{ ok }` o `{ ok: false, motivo }`.
 */
function clickEnLaTranscripcion(ruta, a, { pregunta, opciones, descripciones, sello, casa } = {}) {
  if (!a.tool_use_id) return { ok: false, motivo: 'el click no dice qué cuadro contestó' };
  let rs;
  // sólo los renglones que nombran ese cuadro: el resto de la transcripción no se convierte en objetos
  try { rs = renglones(ruta, { filtro: a.tool_use_id }); } catch (e) { return { ok: false, motivo: `no pude leer la transcripción (${e.code || e.message})`, noLeida: true }; }
  const llamado = rs.some((r) => r && r.type === 'assistant' && bloques(r).some((b) => b && b.type === 'tool_use' && b.id === a.tool_use_id && b.name === CUADRO));
  if (!llamado) return { ok: false, motivo: 'el cuadro no está en la transcripción de la sesión' };
  const r = rs.find((x) => bloques(x).some((b) => b && b.type === 'tool_result' && b.tool_use_id === a.tool_use_id));
  if (!r) return { ok: false, motivo: 'la respuesta del cuadro no está en la transcripción' };
  if (!cerca(r, a.ts)) return { ok: false, motivo: 'la respuesta del cuadro no es de la hora del registro' };
  const d = r.permissionDecision || (r.toolUseResult && r.toolUseResult.permissionDecision);
  // sin ese dato no se sabe si lo contestó un gancho, y uno ajeno se puede sacar antes de que se mire la configuración
  if (!d) return { ok: false, motivo: `la transcripción no dice quién contestó el cuadro${pistaDeVersion(r)}` };
  if (d.source === 'hook' || d.reasonType === 'hook') return { ok: false, motivo: 'el cuadro lo contestó un gancho, no la persona' };
  if (d.decision && d.decision !== 'accept') return { ok: false, motivo: 'el cuadro no se aceptó' };
  // sólo la respuesta a la pregunta del registro: en un cuadro con varias firmas, las otras son de otras firmas
  const dijo = respuestaDelCuadro(r.toolUseResult, { pregunta: a.pregunta });
  if (!dijo.ok) return { ok: false, motivo: `en la transcripción, ${dijo.motivo}` };
  if (dijo.pregunta !== a.pregunta || dijo.respuesta !== a.respuesta) return { ok: false, motivo: 'la respuesta del cuadro en la transcripción no es la del registro' };
  if (!pregunta || dijo.pregunta !== pregunta) {
    anotarPreguntaDistinta({ casa, sello, sesion: a.sesion, esperada: pregunta, recibida: dijo.pregunta });
    // con el mismo sello, la firma y lo que se firma son los mismos: lo que cambió es el texto
    const mismoSello = !!pregunta && !!selloAlFinal(pregunta) && selloAlFinal(dijo.pregunta) === selloAlFinal(pregunta);
    return { ok: false, motivo: mismoSello ? PREGUNTA_CAMBIADA : 'la pregunta del cuadro no es la que armó el guion para esta firma: mostrala tal cual' };
  }
  // con dos opciones que aprueban, la persona no tendría cómo decir que no
  const mostrada = ((r.toolUseResult && r.toolUseResult.questions) || []).find((q) => q && q.question === pregunta);
  const etiquetas = mostrada && Array.isArray(mostrada.options) ? mostrada.options.map((o) => o && o.label) : null;
  if (!opciones || JSON.stringify(etiquetas) !== JSON.stringify(opciones)) return { ok: false, motivo: 'las opciones del cuadro no son las que armó el guion: mostralas tal cual' };
  if (descripciones && JSON.stringify(mostrada.options.map((o) => o && o.description)) !== JSON.stringify(descripciones)) return { ok: false, motivo: 'las descripciones del cuadro no son las que armó el guion: mostralas tal cual' };
  return { ok: true };
}

/** La carpeta de la configuración administrada de Claude Code. */
function carpetaAdministrada(plataforma = process.platform) {
  if (plataforma === 'darwin') return '/Library/Application Support/ClaudeCode';
  return plataforma === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code';
}

/**
 * Las capas de configuración de Claude Code que pueden traer ganchos, para la carpeta `cwd`: las de la cuenta y del
 * proyecto, la administrada y su carpeta `managed-settings.d/` (sus `.json`; las copias con otro final no se cargan).
 */
function capas({ casa = os.homedir(), cwd, plataforma = process.platform, administrada = carpetaAdministrada(plataforma) } = {}) {
  const fuera = [path.join(casa, '.claude', 'settings.json'), path.join(casa, '.claude', 'settings.local.json')];
  if (cwd) fuera.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  fuera.push(path.join(administrada, 'managed-settings.json'));
  const d = path.join(administrada, 'managed-settings.d');
  try { for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) fuera.push(path.join(d, f)); } catch (e) { if (e.code !== 'ENOENT') fuera.push(d); }
  return fuera;
}

/** Las carpetas que hay adentro de una raíz, siguiendo los enlaces (una skill instalada suele ser un enlace). */
function subcarpetas(d) {
  let es;
  try { es = fs.readdirSync(d); } catch (e) { return e.code === 'ENOENT' ? [] : [{ ilegible: d }]; }
  return es.map((n) => path.join(d, n)).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } });
}

/**
 * Los archivos de ganchos de los plugins de `raices` (por defecto, los instalados en `~/.claude/plugins/cache`; todos,
 * porque uno sin habilitar puede habilitarse sin pasar por acá): su `hooks/hooks.json` y lo que nombre su `plugin.json`,
 * sea otro archivo o los ganchos mismos (`{ objeto, archivo }`). Los catálogos de `marketplaces/` no corren: no cuentan.
 */
function hooksDePlugins(casa = os.homedir(), raices = [path.join(carpetaClaude(casa), 'plugins', 'cache')]) {
  const fuera = [];
  const delManifiesto = (p) => {
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { fuera.push({ ilegible: p }); return; }
    // el manifiesto puede vivir en la carpeta `[.]claude-plugin/` del plugin (un nombre de Claude Code, no la carpeta de la cuenta)
    const raiz = /^[.]claude-plugin$/.test(path.basename(path.dirname(p))) ? path.dirname(path.dirname(p)) : path.dirname(p);
    for (const h of [].concat(j && j.hooks !== undefined ? j.hooks : [])) {
      if (typeof h === 'string') fuera.push(path.resolve(raiz, h));
      else if (h && typeof h === 'object') fuera.push({ objeto: h, archivo: p });
      else fuera.push({ ilegible: p });
    }
  };
  const recorrer = (d, n) => {
    if (n > 7) return;
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') fuera.push({ ilegible: d }); return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') recorrer(p, n + 1);
      else if (e.isFile() && e.name === 'hooks.json' && path.basename(d) === 'hooks') fuera.push(p);
      else if (e.isFile() && e.name === 'plugin.json') delManifiesto(p);
    }
  };
  for (const r of raices) recorrer(r, 0);
  return fuera;
}

/** El encabezado YAML de un `.md`, o null. Lee sólo el principio: un encabezado no ocupa más. */
function encabezadoDe(ruta) {
  const fd = fs.openSync(ruta, 'r');
  try {
    const b = Buffer.alloc(16384);
    const t = b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0));
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(t);
    return m ? m[1] : t.startsWith('---') ? t : null;
  } finally { fs.closeSync(fd); }
}

/**
 * Los ganchos sobre el cuadro de un encabezado de skill o de agente (`hooks:`), como `{ evento, comando }`. Lee los
 * renglones sin intérprete de YAML: un evento sin `matcher`, o con uno que alcanza al cuadro, cuenta entero; ante la duda,
 * cuenta.
 */
function ganchosDelEncabezado(texto) {
  const fuera = [];
  const rs = String(texto || '').split(/\r?\n/);
  const inicio = rs.findIndex((l) => /^hooks\s*:/.test(l));
  if (inicio < 0) return fuera;
  // un comentario pegado al margen no cierra el bloque
  const fin = rs.findIndex((l, i) => i > inicio && /^[^\s#]/.test(l));
  const bloque = rs.slice(inicio, fin < 0 ? rs.length : fin);
  let evento = null;
  let tramo = [];
  const cerrar = () => {
    if (!['PreToolUse', 'PermissionRequest'].includes(evento)) return;
    const matchers = tramo.map((l) => /\bmatcher\s*:\s*["']?([^"'#]*?)["']?\s*$/.exec(l)).filter(Boolean).map((m) => m[1]);
    if (matchers.length && !matchers.some(alcanzaAlCuadro)) return;
    const comandos = tramo.map((l) => /\bcommand\s*:\s*(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => m[1].replace(/^["']|["']$/g, ''));
    for (const comando of comandos.length ? comandos : ['(sin comando a la vista)']) if (!esPermitido(comando)) fuera.push({ evento, comando });
  };
  for (const l of bloque.slice(1)) {
    const m = /^\s*["']?([A-Za-z]+)["']?\s*:\s*(?:\[\s*)?$/.exec(l);
    if (m && /^[A-Z]/.test(m[1])) { cerrar(); evento = m[1]; tramo = []; continue; }
    // el evento y sus ganchos en una sola línea: no se lee el matcher, y ante la duda cuenta
    const enLinea = /^\s*["']?(PreToolUse|PermissionRequest)["']?\s*:\s*\S/.exec(l);
    if (enLinea) fuera.push({ evento: enLinea[1], comando: una(l.trim(), 160) });
    tramo.push(l);
  }
  cerrar();
  // una forma en una sola línea (`hooks: { PreToolUse: … }`), o un evento que no se pudo leer, cuenta
  if (/\b(?:PreToolUse|PermissionRequest)\b/.test(rs[inicio])) fuera.push({ evento: 'PreToolUse', comando: una(rs[inicio], 160) });
  return fuera;
}

/**
 * Los `.md` con encabezado que pueden traer ganchos: skills y agentes (también comandos) de la cuenta, del proyecto y de
 * los plugins instalados. Las carpetas `skills/` y `agents/` de un plugin se buscan en todos los niveles que recorre
 * `hooksDePlugins`.
 */
function encabezadosPosibles({ casa = os.homedir(), cwd, pluginDirs = [] } = {}) {
  const fuera = [];
  const deRaiz = (raiz) => {
    for (const d of subcarpetas(path.join(raiz, 'skills'))) { if (typeof d === 'object') fuera.push(d); else fuera.push(path.join(d, 'SKILL.md')); }
    for (const nombre of ['agents', 'commands']) {
      let es;
      try { es = fs.readdirSync(path.join(raiz, nombre)); } catch (e) { if (e.code !== 'ENOENT') fuera.push({ ilegible: path.join(raiz, nombre) }); continue; }
      for (const f of es) if (f.endsWith('.md')) fuera.push(path.join(raiz, nombre, f));
    }
  };
  // la carpeta de la cuenta y la del proyecto, que se llama igual
  deRaiz(carpetaClaude(casa));
  if (cwd) deRaiz(path.join(cwd, path.basename(carpetaClaude(casa))));
  const recorrer = (d, n) => {
    if (n > 7) return;
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') fuera.push({ ilegible: d }); return; }
    if (es.some((e) => e.isDirectory() && ['skills', 'agents', 'commands'].includes(e.name))) deRaiz(d);
    for (const e of es) if (e.isDirectory() && !['node_modules', '.git', 'skills', 'agents', 'commands'].includes(e.name)) recorrer(path.join(d, e.name), n + 1);
  };
  for (const r of [path.join(carpetaClaude(casa), 'plugins', 'cache'), ...pluginDirs]) recorrer(r, 0);
  return fuera;
}

/**
 * Lo que la línea del proceso de la herramienta suma a sus capas: `--settings <archivo>` y `--plugin-dir <carpeta>`. Con
 * la línea partida por espacios: un valor que no se puede leer (una ruta con espacios, JSON en línea) queda como archivo y
 * no se puede abrir, y entonces el click no vale.
 */
function banderasDe(linea) {
  const w = String(linea || '').trim().split(/\s+/);
  const settings = [];
  const pluginDirs = [];
  w.forEach((x, i) => {
    const m = /^--(settings|plugin-dir)(?:=(.*))?$/.exec(x);
    if (!m) return;
    const v = m[2] !== undefined ? m[2] : w[i + 1];
    (m[1] === 'settings' ? settings : pluginDirs).push(v || '');
  });
  return { settings, pluginDirs };
}

/** ¿El matcher de un gancho alcanza al cuadro? Vacío o `*` alcanza a todo; una expresión, si la acepta. */
function alcanzaAlCuadro(matcher) {
  const m = matcher == null ? '' : String(matcher).trim();
  if (m === '' || m === '*') return true;
  try { return new RegExp(`^(?:${m})$`).test(CUADRO); } catch (_) { return m.includes(CUADRO); }
}

/**
 * ¿El comando es un gancho del arnés que puede escuchar el cuadro? Por su ruta dentro de este arnés o la instalada, y
 * nada más en la línea (ni `;`, `&`, `|`, ni sustituciones).
 */
function esPermitido(comando, raiz = ROOT) {
  const c = String(comando || '').trim();
  if (!c || /[;&|`\n]|\$\(/.test(c)) return false;
  return PERMITIDOS.some((n) => {
    const ruta = path.join(raiz, 'scripts', 'hooks', n);
    // en Windows la configuración escribe la ruta con barras normales
    return c.includes(ruta) || c.includes(ruta.replace(/\\/g, '/')) || c === `@tcg:${n}` || new RegExp(`(^|[\\s"'])[^\\s"']*/\\.tycon/harness/scripts/hooks/${n.replace('.', '\\.')}(["']?)$`).test(c);
  });
}

/**
 * ¿Es un gancho del arnés instalado cuyo archivo ya no está? Lo deja una versión que volvió atrás: `node <ruta>`, sola en
 * la línea, con la ruta en la carpeta de ganchos del arnés de `casa` o de esta copia, y sin el archivo. No corre nada, así
 * que no anula el click. Con el archivo presente, o en otra carpeta, sigue siendo ajeno.
 */
function ganchoDelArnesSinArchivo(comando, casa) {
  const c = String(comando || '').trim();
  if (!c || /[;&|`\n<>]|\$\(/.test(c)) return false;
  // lo que el shell expande no es la ruta escrita: una variable o un comodín pueden llevar a otro programa. La tilde, sólo
  // al principio de una palabra (una ruta corta de Windows la trae en el medio: PROGRA~1)
  if (/[$*?[\]{}]/.test(c) || /(?:^|[\s"])~/.test(c)) return false;
  // la barra invertida es separador sólo en Windows: en otro sistema el shell la come y corre otra ruta
  if (process.platform !== 'win32' && c.includes('\\')) return false;
  const m = /^(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))$/.exec(c);
  if (!m) return false;
  const igual = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  // el intérprete: `node` del PATH, el Node del arnés de `casa` o el que corre esto; un `node` en otra carpeta puede ser
  // cualquier programa, y ése sí contestaría el cuadro
  const bin = (m[1] || m[2]).replace(/\\/g, '/');
  const nodoDelArnes = path.join(casa || os.homedir(), '.tycon', 'node').replace(/\\/g, '/');
  const esNode = /^node(?:\.exe)?$/i.test(bin) || igual(bin, process.execPath.replace(/\\/g, '/'))
    || (/\/node(?:\.exe)?$/i.test(bin) && !bin.split('/').includes('..') && igual(bin.slice(0, nodoDelArnes.length + 1), `${nodoDelArnes}/`));
  if (!esNode) return false;
  const ruta = (m[3] || m[4]).replace(/\\/g, '/');
  if (!path.isAbsolute(ruta) && !/^[A-Za-z]:\//.test(ruta)) return false;
  const carpetas = [path.join(casa || os.homedir(), '.tycon', 'harness', 'scripts', 'hooks'), path.join(ROOT, 'scripts', 'hooks')].map((d) => d.replace(/\\/g, '/'));
  const dir = ruta.slice(0, ruta.lastIndexOf('/'));
  if (!/^[A-Za-z0-9._-]+\.js$/.test(ruta.slice(ruta.lastIndexOf('/') + 1)) || !carpetas.some((d) => igual(d, dir))) return false;
  try { fs.statSync(ruta); return false; } catch (e) { return e.code === 'ENOENT'; }
}

/**
 * Los ganchos ajenos que escuchan el cuadro: `{ ajenos: [{ archivo, evento, comando }], ilegibles: [archivo] }`. Mira
 * PreToolUse y PermissionRequest en las capas de configuración, en lo que suman las banderas del proceso (`linea`, la de
 * la herramienta), en los plugins instalados y en el encabezado de skills y agentes.
 */
function escuchasDelCuadro({ casa = os.homedir(), cwd, plataforma, administrada, linea } = {}) {
  const ajenos = [];
  const ilegibles = [];
  const { settings, pluginDirs } = banderasDe(linea);
  const archivos = [...capas({ casa, cwd, plataforma, ...(administrada ? { administrada } : {}) }).map((a) => ({ a, plugin: false })),
    ...hooksDePlugins(casa, [path.join(carpetaClaude(casa), 'plugins', 'cache'), ...pluginDirs]).map((a) => ({ a, plugin: true }))];
  const delObjeto = (hooks, a) => {
    for (const evento of ['PreToolUse', 'PermissionRequest']) {
      for (const g of Array.isArray(hooks[evento]) ? hooks[evento] : []) {
        if (!g || !alcanzaAlCuadro(g.matcher)) continue;
        for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
          const comando = h && (h.command || h.url || h.prompt || h.type);
          if (!esPermitido(h && h.command) && !ganchoDelArnesSinArchivo(h && h.command, casa)) ajenos.push({ archivo: a, evento, comando: una(comando, 160) });
        }
      }
    }
  };
  for (const { a, plugin } of archivos) {
    if (a && typeof a === 'object' && a.ilegible) { ilegibles.push(a.ilegible); continue; }
    if (a && typeof a === 'object') { delObjeto(a.objeto.hooks || a.objeto, a.archivo); continue; }
    let j;
    try { j = JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') ilegibles.push(a); continue; }
    delObjeto((j && (plugin && !j.hooks ? j : j.hooks)) || {}, a);
  }
  // pedida en la línea del proceso: si no se puede leer, no se sabe qué trae
  for (const a of settings) {
    let j;
    try { j = JSON.parse(fs.readFileSync(a, 'utf8')); } catch (_) { ilegibles.push(a || '--settings'); continue; }
    delObjeto((j && j.hooks) || {}, a);
  }
  for (const a of encabezadosPosibles({ casa, cwd, pluginDirs })) {
    if (typeof a === 'object') { ilegibles.push(a.ilegible); continue; }
    let t;
    try { t = encabezadoDe(a); } catch (e) { if (e.code !== 'ENOENT') ilegibles.push(a); continue; }
    for (const g of ganchosDelEncabezado(t)) ajenos.push({ archivo: a, evento: g.evento, comando: una(g.comando, 160) });
  }
  return { ajenos, ilegibles };
}

// --- quién anotó una aprobación dada en otra sesión -----------------------------------------------------------------

/**
 * La aprobación dada en otra sesión (la coordinadora) la anotó el proceso de esa sesión, que sigue vivo: el proceso que
 * dice el registro está en el árbol, con su misma hora de inicio, es la herramienta, y Claude Code lo tiene como esa sesión
 * (`sessions/<pid>.json` en la carpeta de Claude Code de la cuenta). `{ ok, linea, cwd }` o `{ ok: false, motivo }`.
 */
function procesoQueLaAnoto({ a, arbol, casa }) {
  const w = ow();
  const h = a.herramienta;
  if (!h || !Number.isInteger(h.pid)) return { ok: false, motivo: 'el registro no dice qué proceso la anotó' };
  if (!arbol) return { ok: false, motivo: 'no pude leer los procesos de la máquina', noLeida: true };
  const p = arbol.find((x) => x.pid === h.pid);
  if (!p || p.inicio !== h.inicio || !w.esHerramienta(p)) return { ok: false, motivo: `el proceso de la sesión ${a.sesion} que la anotó ya no está` };
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(carpetaClaude(casa), 'sessions', `${h.pid}.json`), 'utf8')); } catch (e) {
    return e.code === 'ENOENT' ? { ok: false, motivo: `no sé de qué sesión es el proceso ${h.pid}` } : { ok: false, motivo: `no pude leer de qué sesión es el proceso ${h.pid} (${e.code || e.message})`, noLeida: true };
  }
  if (!s || s.sessionId !== a.sesion) return { ok: false, motivo: `el proceso ${h.pid} no es de la sesión ${a.sesion}` };
  // otra copia viva de la sesión (abierta con `--resume` por un agente, desprendida de su consola) también se anota como ella
  const otros = arbol.filter((x) => x.pid !== h.pid && w.esHerramienta(x)).filter((x) => {
    try { return JSON.parse(fs.readFileSync(path.join(carpetaClaude(casa), 'sessions', `${x.pid}.json`), 'utf8')).sessionId === a.sesion; } catch (e) { return e.code !== 'ENOENT'; }
  });
  if (otros.length) return { ok: false, motivo: `hay más de un proceso vivo de la sesión ${a.sesion}: no sé cuál anotó la aprobación` };
  return { ok: true, linea: p.comando, cwd: s.cwd ? String(s.cwd) : null };
}

// --- la coordinadora ------------------------------------------------------------------------------------------------

/**
 * La sesión coordinadora designada y confirmada por el dueño (la misma que lee la delegación, delegated-signing.js), o
 * null. Sin confirmar, un «aprobado» escrito en su pestaña no vale para otras sesiones; sin `approvals.relay_session` en
 * el perfil del equipo, tampoco: la coordinadora ordena y no firma. `env` y `arnes`, para las pruebas.
 */
function coordinadoraConfirmada(casa, { env, arnes } = {}) {
  try {
    const ds = require('./delegated-signing.js');
    if (!ds.firmaPorElDueno({ env, home: casa, arnes }).ok) return null;
    const p = ds.accountPaths(casa);
    const d = require(path.join(LIB, 'critical-waivers.js')).designacionVigente({ dir: p.state });
    if (!d || d.error || !SESION.test(String(d.sesion || ''))) return null;
    const raw = fs.readFileSync(path.join(p.state, 'gates.log'), 'utf8');
    for (const l of raw.split('\n')) {
      if (!l.includes('relay-designation-confirmed')) continue;
      let g;
      try { g = JSON.parse(l); } catch (_) { continue; }
      if (ds.confirmaLaDesignacion(g, d)) return d.sesion;
    }
    return null;
  } catch (_) { return null; }
}

// --- buscar la aprobación para una firma ----------------------------------------------------------------------------

/** En qué herramienta se dio la aprobación: su campo `plataforma`, o `'claude'` (las anotadas antes del campo). */
function plataformaDe(a) { return a && a.plataforma ? String(a.plataforma) : 'claude'; }

/**
 * La constancia de Codex: se dio en la terminal (`via: 'terminal'`), contesta el sello del cuadro con su pregunta como
 * texto, y la marca que dejó
 * harness-sign.js `acknowledge` coincide con el renglón (sesión, sello, texto, hora y la huella del renglón, que es su
 * `id`). `{ ok }` o `{ ok: false, motivo }`.
 */
function constanciaDeLaTerminal(a, { casa, cuadro }) {
  if (a.via !== 'terminal' || a.tipo !== 'terminal') return { ok: false, motivo: 'en Codex la constancia se da en la terminal (harness.js sign acknowledge)' };
  if (a.sello !== cuadro.sello) return { ok: false, motivo: 'la constancia de la terminal es de otro sello: lo que se mostró cambió, o es de otra pregunta' };
  // el sello es una huella que la persona no lee: lo que firmó es el texto, y tiene que ser la pregunta del cuadro
  if (cuadro.pregunta && a.texto !== cuadro.pregunta) return { ok: false, motivo: PREGUNTA_CAMBIADA };
  let m;
  try { m = require('./harness-sign.js').marcaDeConstancia({ casa, sesion: a.sesion, ts: a.ts }); } catch (e) {
    return { ok: false, motivo: `no pude leer la marca de la terminal (${e.code || e.message})`, noLeida: true };
  }
  if (!m) return { ok: false, motivo: 'falta la marca de la terminal de esa constancia (la deja harness.js sign acknowledge)' };
  if (m.sesion !== a.sesion || m.sello !== a.sello || m.texto !== a.texto || m.ts !== a.ts) return { ok: false, motivo: 'la marca de la terminal no coincide con la constancia del registro' };
  if (m.renglon !== a.id) return { ok: false, motivo: 'la marca de la terminal es de otro renglón del registro' };
  return { ok: true };
}

/**
 * La aprobación vigente para la firma `firma` pedida desde `sesion` sobre `destino` (por defecto, la misma): sin usar, de
 * los últimos 30 minutos, dada en `sesion` o en la coordinadora (`coordinadora`: su id, o null), contestando el cuadro
 * que armó el guion para ese comando (`cuadro`: `{ pregunta, sello }`, de `cuadroDe`). La de la propia sesión tiene que
 * venir del mismo proceso de la herramienta que firma (`herramienta`: { pid, inicio }); la de la coordinadora, de su
 * proceso vivo (`arbol`, se lee si falta). `validar(aprobacion, contexto)` la confirma contra la transcripción y los
 * ganchos; se pasa en las pruebas. `cwd` y `casa` son los de la firma, nunca los del registro. `plataformas`: en qué
 * herramientas se acepta la aprobación (de fábrica, sólo `'claude'`); con `'codex'`, vale la constancia de la terminal
 * de esa misma sesión (`constanciaDeLaTerminal`), también para un cuadro de sólo click. `{ ok, aprobacion, via,
 * plataforma }` o `{ ok: false, motivo }`, con `noLeida: true` si no se pudo leer el registro, o una aprobación que puede
 * ser de esta firma no se pudo confirmar porque falló una lectura: no se sabe si está aprobada.
 */
function buscar({ casa, sesion, destino = sesion, cuadro, coordinadora = null, ahora = Date.now(), cwd, herramienta = null, validar, arbol, plataformas = ['claude'] } = {}) {
  if (!SESION.test(String(sesion || ''))) return { ok: false, motivo: 'la firma no dice de qué sesión es' };
  if (!cuadro || !cuadro.pregunta || !cuadro.sello) return { ok: false, motivo: 'no pude armar el cuadro de esta firma' };
  // un cuadro de sólo click vale en la pestaña que hace el trabajo: ni la coordinadora ni un mensaje escrito lo contestan
  const soloClick = !!cuadro.soloClick;
  // un cuadro de «click del dueño» lo contesta su click, también en la pestaña de la coordinadora confirmada: no un mensaje
  const sinMensaje = soloClick || !!cuadro.clickDelDueno;
  const sesiones = [sesion, ...(!soloClick && coordinadora && coordinadora !== sesion && SESION.test(coordinadora) ? [coordinadora] : [])];
  let candidatas = [];
  try { for (const s of sesiones) candidatas.push(...leerSesion(casa, s).filter((r) => r.sesion === s)); } catch (e) { return { ok: false, motivo: e.message, noLeida: true }; }
  const pide = new Set(Array.isArray(plataformas) ? plataformas : ['claude']);
  candidatas = candidatas.filter((r) => {
    const edad = ahora - Date.parse(r.ts);
    if (!(edad >= 0 && edad <= VENCE_MIN * 60000) || usada(casa, r.id)) return false;
    const plataforma = plataformaDe(r);
    if (!pide.has(plataforma)) return false;
    // la de Codex se confirma abajo, con su marca; vale sólo en la sesión que la nombra, no por la coordinadora
    if (plataforma === 'codex') return r.sesion === sesion;
    if (!(r.tipo === 'click' || (r.tipo === 'mensaje' && !sinMensaje))) return false;
    // la de la propia sesión la anotó el mismo proceso de la herramienta que firma: otra copia de la sesión (abierta con
    // `--resume` por un agente) no aprueba por ella
    return !herramienta || r.sesion !== sesion || (r.herramienta && r.herramienta.pid === herramienta.pid && r.herramienta.inicio === herramienta.inicio);
  }).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if (!candidatas.length) return { ok: false, motivo: soloClick ? 'no hay un click en el cuadro de esta pestaña de los últimos 30 minutos sin usar'
    : sinMensaje ? 'no hay un click del dueño en el cuadro, en esta pestaña o en la de la coordinadora, de los últimos 30 minutos sin usar'
      : 'no hay un click en el cuadro ni un «aprobado» tuyo de los últimos 30 minutos sin usar' };
  // un «Sí» a esta misma firma y sesión con otro código: la fuente (el plan, el diff, el hallazgo) cambió después del cuadro
  const mismaFirma = cuadro.sello.slice(0, cuadro.sello.lastIndexOf('código '));
  // de qué firma es cada candidato: el click lo dice el sello con que termina su pregunta (el que pone `cuadroDe`; la
  // pregunta de otra firma puede citar este sello más adentro); la constancia de Codex, su sello; un «aprobado» escrito
  // no lo dice hasta validarlo
  const conPregunta = (a) => plataformaDe(a) !== 'codex' && a.tipo === 'click' && typeof a.pregunta === 'string';
  const conSello = (a) => plataformaDe(a) === 'codex' && typeof a.sello === 'string';
  const selloDe = (a) => (conSello(a) ? a.sello : conPregunta(a) ? selloAlFinal(a.pregunta) : null);
  // la constancia de Codex a esta firma y sesión es de esta firma con cualquier código: su motivo ya dice si cambió
  const deEstaFirma = (a) => (conSello(a) ? a.sello.startsWith(`${mismaFirma}código `) : selloDe(a) === cuadro.sello);
  const deOtroCodigo = (a) => !deEstaFirma(a) && String(selloDe(a) || '').startsWith(`${mismaFirma}código `);
  const cambio = candidatas.some((a) => a.tipo === 'click' && a.respuesta === APRUEBA && typeof a.pregunta === 'string'
    && String(selloAlFinal(a.pregunta) || '').startsWith(`${mismaFirma}código `) && selloAlFinal(a.pregunta) !== cuadro.sello);
  // no, si hay uno con el sello de esta firma: se valida, y su motivo dice por qué no vale
  if (cambio && !candidatas.some((a) => a.pregunta === cuadro.pregunta || deEstaFirma(a))) return { ok: false, motivo: 'lo que se mostró cambió: pedí el cuadro de nuevo' };
  const check = validar || ((a, ctx) => validarEnClaude(a, ctx));
  let leido = arbol;
  // el motivo que se muestra es el de esta firma: el de un click a otra firma confunde al buscar la causa
  let propio = null;
  let sinPregunta = null;
  let ajeno = null;
  // una lectura que falló (la transcripción, la configuración, los procesos) no es una negativa: no se sabe. Cuenta si el
  // candidato es de esta firma o no se sabe de cuál es (un «aprobado» escrito); uno de otra firma no dice nada de ésta
  let noLeida = false;
  const falla = (a, dicho, sinLeer = false) => {
    if (sinLeer && (deEstaFirma(a) || !selloDe(a))) noLeida = true;
    // sin motivo, igual cuenta: si no, un click de esta firma que falla callado deja «son de otras firmas»
    const m = dicho || 'no se pudo confirmar';
    if (deEstaFirma(a)) propio = propio || m;
    // sin un sello legible (un «aprobado», un click cuya pregunta no termina en uno) no se sabe de qué firma es
    else if (!selloDe(a)) sinPregunta = sinPregunta || m;
    else ajeno = ajeno || m;
  };
  for (const a of candidatas) {
    if (plataformaDe(a) === 'codex') {
      const t = constanciaDeLaTerminal(a, { casa, cuadro });
      if (t.ok) return { ok: true, aprobacion: a, via: 'terminal', plataforma: 'codex' };
      falla(a, t.motivo, t.noLeida);
      continue;
    }
    let proceso = null;
    if (a.sesion !== sesion) {
      if (leido === undefined) leido = ow().arbolDeLaPlataforma();
      proceso = procesoQueLaAnoto({ a, arbol: leido, casa });
      if (!proceso.ok) { falla(a, proceso.motivo, proceso.noLeida); continue; }
    } else if (herramienta) {
      if (leido === undefined) leido = ow().arbolDeLaPlataforma();
      const p = (leido || []).find((x) => x.pid === herramienta.pid);
      // sin la línea del proceso no se miran los ganchos que suman sus banderas: la aprobación no se puede confirmar
      if (!p) { falla(a, leido ? 'no encontré el proceso de la herramienta entre los procesos de la máquina' : 'no pude leer los procesos de la máquina', !leido); continue; }
      proceso = { linea: p.comando };
    }
    const v = check(a, { casa, cwd, cuadro, destino, linea: proceso && proceso.linea, cwdAprobacion: proceso && proceso.cwd });
    if (v && v.ok) return { ok: true, aprobacion: a, via: a.tipo, plataforma: plataformaDe(a) };
    falla(a, v && v.motivo, Boolean(v && v.noLeida));
  }
  // sin motivo del click de esta firma: uno a esta misma firma y sesión con otro código dice que lo mostrado cambió
  const clicks = candidatas.filter((a) => a.tipo === 'click').length;
  const deOtras = clicks === 1 ? 'no hay un click para esta firma: el click reciente es de otra firma'
    : `no hay un click para esta firma: los ${clicks} clicks recientes son de otras firmas`;
  // sin clicks, sólo constancias de Codex de otras firmas: su motivo, como hasta ahora
  const motivo = propio || (candidatas.some(deOtroCodigo) ? 'lo que se mostró cambió: pedí el cuadro de nuevo' : null) || sinPregunta
    || (clicks ? deOtras : ajeno);
  return { ok: false, motivo: `la aprobación no vale: ${motivo || 'no se pudo confirmar'}`, ...(noLeida ? { noLeida: true } : {}) };
}

/**
 * El click de la persona para el renglón `permiso` cuyo cuadro es `cuadro` (signature-list.js `cuadroDePermiso`): sólo un
 * click (nunca un «aprobado» escrito ni una delegación), anotado por la herramienta en la pestaña de la coordinadora
 * confirmada `coordinadora`, con su proceso vivo, sin usar, después de `desde` (la hora del renglón) y de los últimos 30
 * minutos, contestando esa pregunta entera con «Sí, aprobar». Se confirma como cualquier click (`validarEnClaude`: la
 * transcripción y los ganchos que escuchan el cuadro), en la carpeta de la pestaña donde se contestó (sin ella, `carpeta`,
 * la del pedido). `{ ok, aprobacion }`
 * o `{ ok: false, motivo }`, con `noLeida` si una lectura falló. `validar` y `arbol`, para las pruebas. No la gasta: eso
 * lo hace quien decide (`consumir`), una sola vez.
 */
function buscarPermiso({ casa, cuadro, coordinadora, carpeta = null, desde = 0, ahora = Date.now(), arbol, validar } = {}) {
  if (!SESION.test(String(coordinadora || ''))) return { ok: false, motivo: 'no hay coordinadora confirmada' };
  if (!cuadro || !cuadro.pregunta || !cuadro.sello) return { ok: false, motivo: 'no pude armar el cuadro de este permiso' };
  let candidatas;
  try { candidatas = leerSesion(casa, coordinadora); } catch (e) { return { ok: false, motivo: e.message, noLeida: true }; }
  candidatas = candidatas.filter((r) => {
    const t = Date.parse(r.ts);
    return r.sesion === coordinadora && plataformaDe(r) === 'claude' && r.tipo === 'click' && r.respuesta === APRUEBA && r.pregunta === cuadro.pregunta
      && t >= desde && ahora - t >= 0 && ahora - t <= VENCE_MIN * 60000 && !usada(casa, r.id);
  }).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if (!candidatas.length) return { ok: false, motivo: 'no hay un click de la persona en el cuadro de este permiso' };
  const check = validar || ((a, ctx) => validarEnClaude(a, ctx));
  const leido = arbol === undefined ? ow().arbolDeLaPlataforma() : arbol;
  let motivo = null;
  let noLeida = false;
  for (const a of candidatas) {
    const p = procesoQueLaAnoto({ a, arbol: leido, casa });
    if (!p.ok) { motivo = motivo || p.motivo; noLeida = noLeida || Boolean(p.noLeida); continue; }
    // sin la carpeta de la pestaña, la del pedido: siempre se miran los ganchos de alguna carpeta, nunca ninguna
    const donde = p.cwd || carpeta || casa;
    const v = check(a, { casa, cwd: donde, cuadro: { ...cuadro, clickDelDueno: true }, destino: coordinadora, linea: p.linea, cwdAprobacion: donde });
    if (v && v.ok) return { ok: true, aprobacion: a };
    motivo = motivo || (v && v.motivo) || 'no se pudo confirmar';
    noLeida = noLeida || Boolean(v && v.noLeida);
  }
  return { ok: false, motivo: `el click no vale: ${motivo}`, ...(noLeida ? { noLeida: true } : {}) };
}

/**
 * La confirmación con lo que deja Claude Code: la transcripción de la sesión donde se aprobó y, para el click, los
 * ganchos que escuchan el cuadro, en la carpeta de la firma y en la de la pestaña donde se contestó (`cwdAprobacion`).
 * `linea`: la del proceso de la herramienta que lo mostró. El «aprobado» sólo tiene que traer el sello: el texto lo
 * escribió el agente, y lo que lo ata a esta firma es el sello.
 */
function validarEnClaude(a, { casa = os.homedir(), cwd, cuadro, destino, linea, cwdAprobacion } = {}) {
  const ruta = transcripcionDe(casa, a.sesion);
  if (!ruta) return { ok: false, motivo: `no encontré la transcripción de la sesión ${a.sesion}`, noLeida: true };
  if (a.tipo === 'mensaje') return mensajeEnLaTranscripcion(ruta, a, { sello: cuadro.sello, destino, pregunta: cuadro.pregunta });
  for (const c of [...new Set([cwd, cwdAprobacion].filter(Boolean))]) {
    const e = escuchasDelCuadro({ casa, cwd: c, linea });
    if (e.ilegibles.length) return { ok: false, motivo: `no pude leer ${e.ilegibles[0]}, y sin leerla no sé si un gancho contestó el cuadro`, noLeida: true };
    if (e.ajenos.length) return { ok: false, motivo: `un gancho que no es del arnés escucha el cuadro (${e.ajenos[0].evento} en ${e.ajenos[0].archivo}): mientras esté, el click no vale; ${cuadro && (cuadro.soloClick || cuadro.clickDelDueno) ? 'queda la terminal' : 'escribí «aprobado»'}` };
  }
  return clickEnLaTranscripcion(ruta, a, { pregunta: cuadro.pregunta, opciones: cuadro.opciones, descripciones: cuadro.descripciones, sello: cuadro.sello, casa });
}

module.exports = { VENCE_MIN, ENVUELTO, PERMITIDOS, TIPEADO, APRUEBA, NIEGA, PREGUNTA_CAMBIADA, LARGO_EN_TELEFONO, DETALLE_TITULO, carpeta, esAprobacion, mensajeDeLaPersona, respuestaDelCuadro, aprobadasDelCuadro, cuadroDe, recortar, sinRutas, renglonDelTope, notasDelCuadro, traeElSello, lanzadoPorLaHerramienta,
  anotar, leerSesion, consumir, devolver, transcripcionDe, fraseTipeadaReciente, SIN_MENSAJES_DE_LA_PERSONA, controlRemotoDelProceso, mensajeEnLaTranscripcion, clickEnLaTranscripcion, capas, hooksDePlugins, ganchosDelEncabezado, banderasDe, alcanzaAlCuadro, esPermitido,
  escuchasDelCuadro, procesoQueLaAnoto, coordinadoraConfirmada, buscar, buscarPermiso, validarEnClaude, plataformaDe, constanciaDeLaTerminal };
