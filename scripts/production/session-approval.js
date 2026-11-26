#!/usr/bin/env node
/**
 * session-approval.js — la aprobación de una sentencia de producción con el click del dueño en el cuadro de opciones de
 * la sesión, en lugar del cuadro del sistema de la Mac.
 *
 * La llama la puerta (tycon-prod-sql) cuando la pide una sesión de Claude Code: así el dueño aprueba también desde el
 * celular o desde la app, donde el cuadro del sistema no le llega. Un solo cuadro por sentencia: en este camino la puerta
 * no abre el del sistema.
 *
 *   node session-approval.js --host <host> --session <id> [--max-rows N] -- '<sentencia>'
 *
 * Salidas: 0 = hay un click vigente para esta sentencia y quedó usado (imprime el id de la aprobación) · 1 = no lo hay
 * (imprime qué mostrarle al dueño y cómo seguir) · 2 = no se puede verificar (imprime por qué).
 *
 * La verificación es la de las firmas del dueño sin terminal (scripts/lib/owner-approvals.js `buscar`), la misma de los
 * cambios de control: el gancho anota el click (owner-approval-record.js), y acá se relee la transcripción de la sesión
 * buscando ese cuadro, con esa pregunta entera y ese código, contestado por la persona con «Sí, aprobar». Sólo vale un
 * click (`clickDelDueno`): un «aprobado» escrito, un mensaje de otra sesión o de la oficina no. Vale en la pestaña de la
 * sesión o en la de la coordinadora confirmada, como cualquier click del dueño. Sirve una vez (`consumir`) y vence a los
 * VENCE_MIN minutos, menos que los 30 de las firmas: una sentencia se aprueba para correrla ya.
 *
 * El código ata el click a la sentencia: sale del servidor, la sentencia entera, el tope de filas y la sesión. Otra
 * sentencia, otro servidor u otra sesión piden otro click.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const FIRMA = 'production-query';
const VENCE_MIN = 10;
const SESION = /^[\w-]+$/;

/** El código de la sentencia: 12 letras de la huella de lo que se corre, dónde y para qué sesión. */
function codigoDe({ host, sentencia, maxFilas, sesion }) {
  return crypto.createHash('sha256').update([host, sentencia, String(maxFilas), sesion].join('\0')).digest('hex').slice(0, 12);
}

/** El cuadro de la sentencia, armado como el de toda firma (owner-approvals.js `cuadroDe`), con la sentencia entera. */
function cuadroDe({ host, sentencia, maxFilas, sesion }, oa = require(path.join(LIB, 'owner-approvals.js'))) {
  return oa.cuadroDe({
    firma: FIRMA,
    destino: sesion,
    que: `correr esta sentencia en la base de producción ${host}`,
    // la sentencia se ve entera y tal cual: la puerta ya rechazó las que no se muestran bien (invisibles, demasiado largas)
    queHace: [sentencia],
    todoQueHace: true,
    siSaleMal: 'un cambio queda hecho en producción; una lectura trae datos de producción a esta conversación',
    huella: codigoDe({ host, sentencia, maxFilas, sesion }),
    clickDelDueno: true,
    descripciones: ['la puerta corre esta sentencia una vez', 'no se corre nada'],
  });
}

/** El proceso de la herramienta que lanzó la puerta (`{ pid, inicio }`), o null si no está entre los padres. */
function herramientaDe(arbol, pid, ow) {
  if (!arbol) return null;
  const tool = ow.padres(arbol, pid).find(ow.esHerramienta);
  return tool ? { pid: tool.pid, inicio: tool.inicio } : null;
}

/** Lo que la sesión le muestra al dueño, y cómo sigue. */
function pedido(cuadro, motivo) {
  return [
    `Esta sentencia la aprueba el dueño con un click en esta sesión (${motivo}).`,
    `Mostrale AskUserQuestion con una sola pregunta, sin cambiarle una letra:`,
    cuadro.pregunta,
    `Las opciones: «${cuadro.opciones[0]}» y «${cuadro.opciones[1]}».`,
    `Con su click, repetí el mismo comando: la puerta lo verifica y corre. Un «aprobado» escrito no vale. El click vence a los ${VENCE_MIN} minutos y sirve para esta sentencia sola.`,
    `No se abre el cuadro del sistema de la Mac: en una sesión, éste es el único cuadro.`,
  ].join('\n');
}

/**
 * Decide. `{ estado: 'aprobada', id } | { estado: 'pedir', texto } | { estado: 'error', texto }`. `buscar`, `arbol`,
 * `ahora` y `consumir` se pasan en las pruebas.
 */
function decidir({ host, sentencia, maxFilas, sesion, casa, cwd = process.cwd(), pid = process.pid, ahora = Date.now(), arbol, oa, ow } = {}) {
  if (!SESION.test(String(sesion || ''))) return { estado: 'error', texto: 'la sesión no tiene un identificador que se pueda leer' };
  oa = oa || require(path.join(LIB, 'owner-approvals.js'));
  ow = ow || require(path.join(LIB, 'owner-window.js'));
  const cuadro = cuadroDe({ host, sentencia, maxFilas, sesion }, oa);
  if (arbol === undefined) arbol = ow.arbolDeLaPlataforma();
  const herramienta = herramientaDe(arbol, pid, ow);
  if (!herramienta) return { estado: 'error', texto: arbol ? 'la puerta no la lanzó la consola de la sesión: desde una sesión se corre por su consola, y desde tu terminal, sin sesión, abre el cuadro del sistema' : 'no pude leer los procesos de la máquina, y sin ellos no sé de qué sesión es el click' };
  const r = oa.buscar({ casa, sesion, cuadro, coordinadora: oa.coordinadoraConfirmada(casa), ahora, cwd, herramienta, arbol });
  if (!r.ok) return r.noLeida ? { estado: 'error', texto: r.motivo } : { estado: 'pedir', texto: pedido(cuadro, r.motivo) };
  const edad = ahora - Date.parse(r.aprobacion.ts);
  if (!(edad >= 0 && edad <= VENCE_MIN * 60000)) return { estado: 'pedir', texto: pedido(cuadro, `el click tiene más de ${VENCE_MIN} minutos`) };
  const c = oa.consumir(casa, r.aprobacion, { ahora, firma: FIRMA, sesion });
  if (!c.ok) return { estado: 'pedir', texto: pedido(cuadro, c.motivo) };
  return { estado: 'aprobada', id: r.aprobacion.id };
}

function leerArgs(argv) {
  const o = { maxFilas: 50 };
  const corte = argv.indexOf('--');
  if (corte < 0 || corte !== argv.length - 2) return null;
  o.sentencia = argv[corte + 1];
  for (let i = 0; i < corte; i += 2) {
    const v = argv[i + 1];
    if (argv[i] === '--host') o.host = v;
    else if (argv[i] === '--session') o.sesion = v;
    else if (argv[i] === '--max-rows' && /^\d+$/.test(String(v))) o.maxFilas = Number(v);
    else return null;
  }
  return o.host && o.sesion && o.sentencia ? o : null;
}

if (require.main === module) {
  const a = leerArgs(process.argv.slice(2));
  if (!a) { process.stdout.write('uso: session-approval.js --host <host> --session <id> [--max-rows N] -- \'<sentencia>\'\n'); process.exit(2); }
  let r;
  try {
    const casa = require(path.join(LIB, 'real-home.js')).casaDeLaCuenta();
    // la puerta es el padre: su proceso es el que tiene que colgar de la consola de la sesión
    r = decidir({ ...a, casa, pid: process.ppid });
  } catch (e) { r = { estado: 'error', texto: `no pude verificar el click (${e.message})` }; }
  process.stdout.write(`${r.estado === 'aprobada' ? r.id : r.texto}\n`);
  process.exit(r.estado === 'aprobada' ? 0 : r.estado === 'pedir' ? 1 : 2);
}

module.exports = { FIRMA, VENCE_MIN, codigoDe, cuadroDe, herramientaDe, decidir, leerArgs };
