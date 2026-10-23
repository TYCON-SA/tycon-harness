#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * estimates.js — el registro de estimaciones de un repo de historias: la épica con un rango, el plan con un valor por
 * historia y la historia que lo ajusta al escribirla; el informe compara la suma con el rango de la épica.
 *
 * POR QUÉ EXISTE: estimar sirve si se puede ver cuánto se erró, y eso pide guardar cada versión, no la última. El
 * registro (`.tycon/estimates.jsonl`) es de sólo agregar: una línea JSON por estimación y la vigente de cada cosa es la
 * última que la nombra. Nada se pisa ni se borra, tampoco una línea ilegible: se cuenta y se sigue. Cada línea guarda la
 * unidad con que se escribió, así cambiar la unidad de la organización no reescribe nada; el informe convierte a horas
 * con las tasas de la organización y, si no puede (puntos sin tasa), no inventa una.
 *
 * El primer registro agrega `.tycon/estimates.jsonl merge=union` a `.gitattributes`: dos ramas que agregan líneas se
 * juntan sin conflicto en un merge local. Un merge hecho por el servidor puede no honrar el atributo; si dos pedidos
 * chocan en el registro, se resuelve con un merge local.
 *
 * Uso:
 *   node scripts/lib/estimates.js epic   --repo <ruta> --epic <id> --min <n> --max <n> [--assumptions <texto>]
 *   node scripts/lib/estimates.js plan   --repo <ruta> --story <id> --value <n>
 *   node scripts/lib/estimates.js story  --repo <ruta> --story <id> --value <n> [--proposed <n>] [--base <id,id>] [--confirmed-by <persona>]
 *   node scripts/lib/estimates.js report --repo <ruta> --epic <id>
 *   Todos aceptan --who <persona> (sin él, user.name de git del repo; sin ninguno, null), --org-config <team-repos.json>
 *   (sin él, el del árbol que corre) y --json.
 * Salidas: 0 listo · 2 entrada inválida (no escribe nada) · 3 no se pudo leer la configuración de la organización.
 * La línea trae siempre las quince claves de CLAVES, en ese orden, con null donde no aplica: es el contrato que leen
 * el sitio y la plataforma.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DISCOVERY = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-discovery.js');

const VERSION = 1;
const REGISTRO = path.join('.tycon', 'estimates.jsonl');
const ATRIBUTO = '.tycon/estimates.jsonl merge=union';
const CLAVES = ['v', 'nivel', 'epica', 'historia', 'valor', 'min', 'max', 'unidad', 'supuestos', 'propuesto', 'base', 'quien', 'confirmo', 'ejecucion', 'cuando'];
const NIVELES = ['epica', 'plan', 'historia', 'real'];
const UNIDADES = ['hours', 'days', 'points'];
const DEFAULTS = Object.freeze({ unit: 'hours', hours_per_day: 8, hours_per_point: null });
const SALIDA = { ok: 0, invalid: 2, org: 3 };

class Problema extends Error {
  constructor(message, code = SALIDA.invalid) { super(message); this.code = code; }
}

/** Una línea del registro con las quince claves, en orden; lo que no viene, null. */
function linea(campos) {
  const out = {};
  for (const k of CLAVES) out[k] = campos[k] === undefined ? null : campos[k];
  out.v = VERSION;
  return out;
}

/** El registro de un repo: `{ lines, unreadable }` (números de línea, desde 1). Sin archivo, vacío. Nunca escribe. */
function read(repo) {
  const file = path.join(repo, REGISTRO);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { lines: [], unreadable: [] };
    throw new Problema(`no pude leer ${file}: ${(e && e.code) || e}`, SALIDA.org);
  }
  const lines = [];
  const unreadable = [];
  text.replace(/^﻿/, '').split('\n').forEach((crudo, i) => {
    if (!crudo.trim()) return;
    let l = null;
    try { l = JSON.parse(crudo); } catch (_) { l = null; }
    if (legible(l)) lines.push(l);
    else unreadable.push(i + 1);
  });
  return { lines, unreadable };
}

const positivo = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const id = (x) => (typeof x === 'string' && x.trim() !== '') || (typeof x === 'number' && Number.isFinite(x));
/**
 * ¿Una línea se puede usar? La versión y el nivel conocidos, la unidad conocida, y lo que su nivel necesita: la épica
 * con su rango (`min` ≤ `max`, números mayores que 0); el plan, la historia y lo real con su historia, su épica y su
 * valor. Una línea legible con un campo roto cuenta como ilegible: sumarla daría un total falso.
 */
function legible(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l) || l.v !== VERSION || !NIVELES.includes(l.nivel)) return false;
  if (!UNIDADES.includes(l.unidad) || !id(l.epica)) return false;
  if (l.nivel === 'epica') return positivo(l.min) && positivo(l.max) && l.min <= l.max;
  // lo real son las horas del reloj: en otra unidad no se puede comparar
  if (l.nivel === 'real' && l.unidad !== 'hours') return false;
  return id(l.historia) && positivo(l.valor);
}

/** ¿La línea habla de esa cosa? `{ nivel, historia }` o `{ nivel: 'epica', epica }`. */
function nombra(l, { nivel, historia, epica }) {
  if (l.nivel !== nivel) return false;
  return nivel === 'epica' ? String(l.epica) === String(epica) : String(l.historia) === String(historia);
}
/** Todas las versiones de una cosa, en el orden del registro. */
function history(lines, cosa) { return lines.filter((l) => nombra(l, cosa)); }
/** La versión vigente de una cosa: la última que la nombra, o null. */
function current(lines, cosa) { const h = history(lines, cosa); return h.length ? h[h.length - 1] : null; }

/** Agrega una línea (y el atributo de merge, una sola vez). */
function append(repo, l) {
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  const attrs = path.join(repo, '.gitattributes');
  let previo = '';
  try { previo = fs.readFileSync(attrs, 'utf8'); } catch (_) { previo = ''; }
  if (!previo.split(/\r?\n/).some((x) => x.trim() === ATRIBUTO)) {
    fs.appendFileSync(attrs, `${previo && !previo.endsWith('\n') ? '\n' : ''}${ATRIBUTO}\n`);
  }
  // un registro sin salto final (un editor que lo sacó) no pega la línea nueva a la última
  const registro = path.join(repo, REGISTRO);
  let falta = false;
  try {
    const { size } = fs.statSync(registro);
    if (size > 0) {
      const fd = fs.openSync(registro, 'r');
      const ultimo = Buffer.alloc(1);
      try { fs.readSync(fd, ultimo, 0, 1, size - 1); } finally { fs.closeSync(fd); }
      falta = ultimo[0] !== 0x0a;
    }
  } catch (e) {
    // sin registro todavía, no falta nada; si está y no se lee, no se adivina: pegar la línea a la anterior la rompería
    if (!e || e.code !== 'ENOENT') throw new Problema(`no pude leer ${registro}: ${(e && e.code) || e}`, SALIDA.org);
  }
  fs.appendFileSync(registro, `${falta ? '\n' : ''}${JSON.stringify(l)}\n`);
}

/**
 * Las estimaciones de la organización: `estimates` de su `team-repos.json`, leído con el `team-repos.js` de su árbol
 * (o el de este, si ese no lo trae). Sin archivo o sin la clave, los valores por defecto. Tira con código 3 si el archivo
 * no se lee o la clave está mal escrita: no se adivina la unidad.
 */
function orgEstimates(orgConfig) {
  const file = orgConfig ? path.resolve(orgConfig) : path.join(ROOT, 'team-repos.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT' && !orgConfig) return { ...DEFAULTS };
    throw new Problema(`no pude leer la configuración de la organización (${file}: ${(e && e.code) || e})`, SALIDA.org);
  }
  const propio = path.join(path.dirname(file), 'scripts', 'lib', 'team-repos.js');
  const lector = fs.existsSync(propio) ? propio : path.join(ROOT, 'scripts', 'lib', 'team-repos.js');
  let TR;
  // un lector que está y no carga no se reemplaza callado: se dice (como models-env.js)
  try { TR = require(lector); } catch (e) {
    throw new Problema(`no pude cargar el lector de la configuración de la organización (${lector}: ${String((e && e.message) || e).split('\n')[0]})`, SALIDA.org);
  }
  const r = TR.parse(String(text).replace(/^﻿/, ''));
  const sec = r.sectionProblems && r.sectionProblems.estimates;
  if (sec && sec.length) throw new Problema(`la configuración de la organización no vale (${sec[0].path}: ${sec[0].message})`, SALIDA.org);
  if (!r.ok) {
    const p = r.problems[0] || { path: '', message: 'no vale' };
    throw new Problema(`la configuración de la organización no vale (${p.path || file}: ${p.message})`, SALIDA.org);
  }
  const e = (r.data && r.data.estimates) || {};
  // un lector anterior a la clave la deja pasar sin mirarla: la unidad se mira acá también
  if (e.unit !== undefined && !UNIDADES.includes(e.unit)) {
    throw new Problema(`la configuración de la organización no vale (estimates.unit: tiene que ser ${UNIDADES.join(', ')}, es ${JSON.stringify(e.unit)})`, SALIDA.org);
  }
  // y las tasas: una rota da un total NaN, y NaN no cae debajo ni encima de ningún rango
  for (const k of ['hours_per_day', 'hours_per_point']) {
    if (e[k] !== undefined && !positivo(e[k])) {
      throw new Problema(`la configuración de la organización no vale (estimates.${k}: tiene que ser un número de horas mayor que 0, es ${JSON.stringify(e[k])})`, SALIDA.org);
    }
  }
  return {
    unit: e.unit || DEFAULTS.unit,
    hours_per_day: e.hours_per_day || DEFAULTS.hours_per_day,
    hours_per_point: e.hours_per_point || DEFAULTS.hours_per_point,
  };
}

/** Las horas de un valor en su unidad, o null si no hay tasa. */
function aHoras(valor, unidad, org) {
  if (unidad === 'hours') return valor;
  if (unidad === 'days') return valor * org.hours_per_day;
  if (unidad === 'points') return org.hours_per_point ? valor * org.hours_per_point : null;
  return null;
}
const redondo = (n) => Math.round(n * 100) / 100;

/**
 * El informe de una épica: el rango vigente, la suma del plan, la suma vigente (la historia si la hay, si no el plan),
 * si cae dentro, debajo o encima del rango y por cuánto, y cada historia con sus versiones. Con una sola unidad se
 * compara en esa unidad; con unidades mezcladas, en horas; si alguna no pasa a horas, las sumas por unidad y sin marca.
 */
function report(registro, epica, org) {
  const { lines, unreadable } = registro;
  const E = String(epica);
  const rango = current(lines, { nivel: 'epica', epica });
  // una historia es de la épica de su última línea de plan o historia: si su `epic:` cambió, cuenta sólo en la nueva, y
  // con las líneas que escribió bajo ella
  const ultima = new Map();
  for (const l of lines) if (l.nivel === 'plan' || l.nivel === 'historia') ultima.set(String(l.historia), String(l.epica));
  const ids = [...ultima].filter(([, e]) => e === E).map(([h]) => h);
  const historias = ids.map((h) => {
    const suyas = lines.filter((l) => String(l.historia) === h && String(l.epica) === E && (l.nivel === 'plan' || l.nivel === 'historia'));
    const plan = current(suyas, { nivel: 'plan', historia: h });
    const hist = current(suyas, { nivel: 'historia', historia: h });
    return { historia: h, plan, vigente: hist || plan, versiones: suyas };
  });
  const base = { ok: true, epica: E, sin_estimaciones: false, unreadable, rango: null, unidad: null, suma_plan: null, suma_vigente: null, dentro: null, fuera: null, por: null, sumas_por_unidad: null, motivo: null, historias };
  if (!rango && !historias.length) return { ...base, sin_estimaciones: true, motivo: 'la épica no tiene estimaciones en el registro' };

  // lo que se compara con el rango es la vigente; un plan ya ajustado no frena la comparación
  const comparadas = [...(rango ? [rango] : []), ...historias.map((h) => h.vigente)];
  const planes = historias.map((h) => h.plan).filter(Boolean);
  const unidades = [...new Set([...comparadas, ...planes].map((l) => l.unidad))];
  const una = unidades.length === 1 ? unidades[0] : null;
  const conv = (l, v) => (una ? v : aHoras(v, l.unidad, org));
  const sinTasa = (ls) => (una ? [] : ls.filter((l) => aHoras(1, l.unidad, org) === null));
  const sumar = (ls) => (ls.length ? redondo(ls.reduce((s, l) => s + conv(l, l.valor), 0)) : null);
  const noPasan = sinTasa(comparadas);
  if (noPasan.length) {
    const sumas = {};
    for (const h of historias) sumas[h.vigente.unidad] = redondo((sumas[h.vigente.unidad] || 0) + h.vigente.valor);
    return {
      ...base,
      rango: rango ? { min: rango.min, max: rango.max, unidad: rango.unidad, supuestos: rango.supuestos } : null,
      sumas_por_unidad: sumas,
      motivo: `unidades mezcladas y ${[...new Set(noPasan.map((l) => l.unidad))].join(', ')} sin tasa a horas (estimates.hours_per_point de la organización): no se compara con el rango`,
    };
  }
  const planSinTasa = sinTasa(planes);
  const sumaPlan = planSinTasa.length ? null : sumar(planes);
  const sumaVigente = sumar(historias.map((h) => h.vigente));
  const out = {
    ...base, unidad: una || 'hours', suma_plan: sumaPlan, suma_vigente: sumaVigente,
    motivo: planSinTasa.length ? `el plan tiene ${[...new Set(planSinTasa.map((l) => l.unidad))].join(', ')} sin tasa a horas: no se suma` : null,
  };
  if (!rango) return { ...out, motivo: [out.motivo, 'la épica no tiene rango: no se compara'].filter(Boolean).join('; ') };
  const min = redondo(conv(rango, rango.min));
  const max = redondo(conv(rango, rango.max));
  out.rango = { min, max, unidad: out.unidad, supuestos: rango.supuestos };
  if (sumaVigente === null) return { ...out, motivo: 'la épica no tiene historias estimadas: no se compara' };
  if (sumaVigente < min) return { ...out, dentro: false, fuera: 'debajo', por: redondo(min - sumaVigente) };
  if (sumaVigente > max) return { ...out, dentro: false, fuera: 'encima', por: redondo(sumaVigente - max) };
  return { ...out, dentro: true, fuera: null, por: 0 };
}

// ── el comando ──────────────────────────────────────────────────────────────────────────────────

function opciones(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Problema(`${a} necesita un valor`);
      o[a.slice(2)] = v;
      i++;
    } else o._.push(a);
  }
  return o;
}
function numero(nombre, v) {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n) || n <= 0) throw new Problema(`${nombre} tiene que ser un número mayor que 0 (es ${JSON.stringify(v === undefined ? null : v)})`);
  return n;
}
// lo que llega de una persona o de otro archivo y se guarda tal cual en el registro: con forma, y sin caracteres que
// cambien el sentido de una línea de comandos
const PERSONA = /^[\p{L}\p{N} ._@'-]{1,80}$/u;
const ID_HISTORIA = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
function persona(nombre, v) {
  if (!PERSONA.test(String(v))) throw new Problema(`${nombre} tiene que ser un nombre o un correo de hasta 80 caracteres, sin ; $ \` ni saltos de línea (es ${JSON.stringify(v)})`);
  return String(v);
}
function quien(o, repo) {
  if (o.who) return persona('--who', o.who);
  const r = spawnSync('git', ['-C', repo, 'config', 'user.name'], { encoding: 'utf8' });
  const nombre = r.status === 0 ? String(r.stdout || '').trim() : '';
  return nombre || null;
}
/** La épica de una historia, del `epic:` de su frontmatter. `D` es el buscador de historias (se cambia en las pruebas). */
function epicaDe(repo, id, D = require(DISCOVERY)) {
  const { stories, partial } = D.discoverStories(repo, { cache: false });
  const s = stories.find((x) => String(x.id) === String(id));
  // una búsqueda cortada por su tope de tiempo no prueba que la historia no exista
  if (!s && partial) throw new Problema(`la búsqueda de historias en ${repo} no terminó (quedó incompleta por su tope de tiempo): no sé si la historia ${id} existe; volvé a correrlo o subí TYCON_STORY_SCAN_BUDGET_MS`, SALIDA.org);
  if (!s) throw new Problema(`la historia ${id} no existe en ${repo}`);
  if (!s.epic) throw new Problema(`la historia ${id} no tiene epic: en su frontmatter`);
  return String(s.epic);
}

function run(argv) {
  const o = opciones(argv);
  const cmd = o._[0];
  if (!['epic', 'plan', 'story', 'report'].includes(cmd)) throw new Problema(`nivel desconocido: ${cmd === undefined ? '(ninguno)' : cmd} (válidos: epic, plan, story, report)`);
  if (!o.repo) throw new Problema('falta --repo');
  const repo = path.resolve(o.repo);
  if (!fs.existsSync(repo)) throw new Problema(`no existe ${repo}`);
  const org = orgEstimates(o['org-config']);
  const registro = read(repo);
  if (cmd === 'report') {
    if (!o.epic) throw new Problema('falta --epic');
    return report(registro, o.epic, org);
  }
  const comun = { unidad: org.unit, quien: null, cuando: null };
  let l;
  if (cmd === 'epic') {
    if (!o.epic) throw new Problema('falta --epic');
    const min = numero('--min', o.min);
    const max = numero('--max', o.max);
    if (min > max) throw new Problema(`--min (${min}) es mayor que --max (${max})`);
    l = { ...comun, nivel: 'epica', epica: String(o.epic), min, max, supuestos: o.assumptions || null };
  } else {
    if (!o.story) throw new Problema('falta --story');
    const valor = numero('--value', o.value);
    l = { ...comun, nivel: cmd === 'plan' ? 'plan' : 'historia', historia: String(o.story), valor };
    if (cmd === 'story') {
      if (o.proposed !== undefined) l.propuesto = numero('--proposed', o.proposed);
      if (o.base !== undefined) {
        l.base = String(o.base).split(',').map((x) => x.trim()).filter(Boolean);
        const mala = l.base.find((x) => !ID_HISTORIA.test(x));
        if (mala !== undefined) throw new Problema(`--base tiene que ser una lista de ids de historia separados por comas (${JSON.stringify(mala)} no lo es)`);
      }
      if (o['confirmed-by'] !== undefined) l.confirmo = persona('--confirmed-by', o['confirmed-by']);
    }
    l.epica = epicaDe(repo, o.story);
  }
  l.quien = quien(o, repo);
  l.cuando = new Date().toISOString();
  const escrita = linea(l);
  append(repo, escrita);
  return { ok: true, linea: escrita, unreadable: registro.unreadable };
}

function texto(r) {
  if (!r.ok) return `estimates: ${r.reason}`;
  if (r.linea) return `estimates: anotada ${r.linea.nivel} ${r.linea.historia || r.linea.epica} (${r.linea.valor !== null && r.linea.valor !== undefined ? r.linea.valor : `${r.linea.min}–${r.linea.max}`} ${r.linea.unidad})`;
  if (r.sin_estimaciones) return `estimates: la épica ${r.epica} no tiene estimaciones`;
  const marca = r.dentro === null ? r.motivo : r.dentro ? 'dentro del rango' : `${r.fuera} del rango por ${r.por}`;
  const rango = r.rango ? `${r.rango.min}–${r.rango.max}` : 'sin rango';
  return `estimates: épica ${r.epica} · rango ${rango} · plan ${r.suma_plan === null ? '—' : r.suma_plan} · vigente ${r.suma_vigente === null ? '—' : r.suma_vigente} ${r.unidad || ''} · ${marca}${r.unreadable.length ? ` · líneas ilegibles: ${r.unreadable.join(', ')}` : ''}`;
}

if (require.main === module) {
  const json = process.argv.includes('--json');
  let r;
  let code = SALIDA.ok;
  try { r = run(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof Problema)) throw e;
    r = { ok: false, reason: e.message };
    code = e.code;
  }
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : `${texto(r)}\n`);
  process.exitCode = code;
}

module.exports = { CLAVES, NIVELES, UNIDADES, VERSION, REGISTRO, DEFAULTS, linea, read, legible, history, current, append, orgEstimates, epicaDe, aHoras, report, run };
