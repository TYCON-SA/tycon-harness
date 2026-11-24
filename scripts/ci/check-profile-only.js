#!/usr/bin/env node
'use strict';
// check-profile-only.js — que ninguna clave que vale sólo el perfil del equipo la pueda pisar la máquina.
//
// POR QUÉ EXISTE. La lista de esas claves (scripts/lib/profile-only.js) pide la constancia del dueño en cada cambio, pero
// el código que la aplica vive en scripts/lib/tycon-config.js, que se toca en casi cada pedido y no la pide. Este control
// carga la configuración del árbol con un archivo de máquina, un perfil por variable y las variables de cada clave, todos
// de laboratorio y con otro valor, y frena si alguna clave de la lista toma ese valor. Corre como pasada de la revisión
// (scripts/ci/controls-from-base.json) y pide la constancia en cada cambio: un pedido que afloja el filtro da rojo en su
// propia pasada, y uno que además afloja este control necesita la firma del dueño.
//
// Uso: node scripts/ci/check-profile-only.js [--root <árbol>]
// Salida: 0 ninguna clave se pisa · 1 alguna se pisa · 2 no pude medir (un tipo sin valor de laboratorio, un valor que
// no valida, la configuración que no carga). No poder medir nunca es verde.
const fs = require('fs');
const os = require('os');
const path = require('path');

const i = process.argv.indexOf('--root');
const ROOT = path.resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join(__dirname, '..', '..'));

class NoPude extends Error {}
const noPude = (m) => { throw new NoPude(m); };
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const primeraLinea = (e) => String((e && e.message) || e).split('\n')[0];
const temporales = [];
const carpeta = (n) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `profile-only-${n}-`)); temporales.push(d); return d; };

/** Lo que el árbol trae: la configuración, el catálogo de firmas y la lista firmada (nunca de un require fijo). */
function cargarDelArbol() {
  const de = (rel, que) => { try { return require(path.join(ROOT, 'scripts', 'lib', rel)); } catch (e) { return noPude(`${que} del árbol no carga (${primeraLinea(e)})`); } };
  const C = de('tycon-config.js', 'la configuración');
  const firmas = de('signatures.js', 'el catálogo de firmas');
  const firmada = de('profile-only.js', 'la lista de claves sólo del perfil');
  // la lista firmada manda: una configuración que aplica menos claves que ésa no se mide con la suya
  const lista = [...new Set([...(Array.isArray(firmada) ? firmada : []), ...(Array.isArray(C.PROFILE_ONLY) ? C.PROFILE_ONLY : [])])];
  if (!lista.length) noPude('ni profile-only.js ni la configuración declaran una clave que valga sólo el perfil');
  return { C, firmas, lista };
}

/** Un valor de laboratorio que valida para `tipo` y no es `hoy`; undefined si el tipo no tiene uno. */
function deLaboratorio(C, firmas, tipo, hoy) {
  const distinto = (candidatos) => candidatos.find((v) => !igual(v, hoy) && !C.validarTipo(tipo, v));
  const t = String(tipo);
  if (t === 'texto') return distinto(['sesion-de-laboratorio', 'otra-sesion-de-laboratorio']);
  if (t === 'url') return distinto(['https://laboratorio.example.invalid/', 'https://otro.example.invalid/']);
  if (t === 'cuentas') return distinto([['cuenta-de-laboratorio'], ['otra-cuenta']]);
  if (t === 'maquinas') return distinto([[{ id: '0123456789abcdef', label: 'laboratorio' }], [{ id: 'fedcba9876543210', label: 'otra' }]]);
  if (t.startsWith('opcion:')) return distinto(t.slice('opcion:'.length).split('|'));
  const rango = /^entero:(\d+)-(\d+)$/.exec(t);
  if (rango) { const out = []; for (let n = Number(rango[1]); n <= Number(rango[2]); n += 1) out.push(n); return distinto(out); }
  if (t === 'firmas') return distinto(['off', ...firmas.groupNames(), ...firmas.ids()]);
  if (t === 'firmas-ids') return distinto(firmas.ids().map((id) => [id]));
  if (t === 'niveles') return distinto(firmas.ids().filter((id) => firmas.effectiveLevel(id) !== null).map((id) => ({ [id]: 3 })));
  return undefined;
}

/** Las claves que la máquina, una variable o otro perfil pisan; vacío si ninguna. */
function medir() {
  const { C, firmas, lista } = cargarDelArbol();
  // lo que vale hoy, sin máquina ni variables: el valor de laboratorio tiene que ser otro
  const hoy = C.cargar({ home: carpeta('vacia'), env: {}, arnes: ROOT });
  const maquina = {}; const perfil = {}; const env = {}; const valorLab = {};
  for (const ruta of lista) {
    const [seccion, clave] = ruta.split('.');
    const tipo = (C.VOCABULARIO[seccion] || {})[clave];
    if (!tipo) noPude(`${ruta} está en la lista y no en el vocabulario`);
    const v = deLaboratorio(C, firmas, tipo, hoy.valores[seccion] && hoy.valores[seccion][clave]);
    if (v === undefined) noPude(`no sé armar un valor de laboratorio para ${ruta} (tipo ${JSON.stringify(tipo)}): sumalo acá`);
    valorLab[ruta] = v;
    (maquina[seccion] = maquina[seccion] || {})[clave] = v;
    (perfil[seccion] = perfil[seccion] || {})[clave] = v;
    for (const variable of [].concat((C.VARIABLES || {})[ruta] || [])) env[variable] = typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v);
  }
  const lab = carpeta('maquina');
  const archivo = C.rutaMaquina(lab);
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, `${JSON.stringify(maquina, null, 2)}\n`);
  // un perfil que no es el del árbol, nombrado por variable: tampoco manda en estas claves
  const otroPerfil = path.join(lab, 'perfil-de-laboratorio.json');
  fs.writeFileSync(otroPerfil, `${JSON.stringify(perfil, null, 2)}\n`);
  const c = C.cargar({ home: lab, env: Object.assign({}, env, { TYCON_PROFILE: otroPerfil }), arnes: ROOT });
  const rotas = c.errores.filter((e) => lista.includes(e.clave));
  if (rotas.length) noPude(`un valor de laboratorio no valida: ${rotas.map((e) => `${e.clave} (${e.motivo})`).join('; ')}`);
  const pisadas = [];
  for (const ruta of lista) {
    const [seccion, clave] = ruta.split('.');
    const efectivo = c.valores[seccion] && c.valores[seccion][clave];
    if (igual(efectivo, valorLab[ruta]) || ['maquina', 'env'].includes(c.origenes[ruta])) pisadas.push(`${ruta} (tomó ${JSON.stringify(efectivo)} de ${c.origenes[ruta]})`);
  }
  return { pisadas, total: lista.length };
}

let codigo = 2;
try {
  const { pisadas, total } = medir();
  if (pisadas.length) {
    console.error(`⛔ check-profile-only: la máquina, una variable o un perfil que no es el del árbol pisan claves que vale sólo el perfil del equipo: ${pisadas.join(', ')}. Esas claves abren la puerta a eximir un crítico o a firmar sin la persona: el filtro de tycon-config.js (PROFILE_ONLY) no puede dejarlas pasar.`);
    codigo = 1;
  } else {
    console.log(`✅ check-profile-only: las ${total} claves que vale sólo el perfil no las pisa la máquina, una variable ni otro perfil`);
    codigo = 0;
  }
} catch (e) {
  console.error(`⛔ check-profile-only: no pude medir: ${e instanceof NoPude ? e.message : primeraLinea(e)}. No poder medir no es verde.`);
} finally {
  for (const d of temporales) fs.rmSync(d, { recursive: true, force: true });
}
process.exit(codigo);
