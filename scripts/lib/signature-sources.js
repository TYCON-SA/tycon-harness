'use strict';
/**
 * signature-sources.js — de dónde sale lo que dice la pregunta de cada firma (owner-approvals.js `cuadroDe`).
 *
 * Lo que la sesión escribe en el comando es una cita: puede no decir lo que se aprueba. Lo que la pregunta dice que hace
 * la firma, qué archivos toca y dónde está lo completo sale de lo mismo que el dueño firmaría si lo abriera: el plan
 * escrito, el diff de los controles, los criterios de la historia, el informe de hallazgos o la nota de la vuelta.
 *
 *   · `partesDe({ firma, palabras, cwd, marcador, estado })` → `{ queHace, archivos, completo, fuente, cita }`, o null si
 *     la firma no tiene fuente propia (la pregunta dice lo que hace el comando). `fuente` es el texto exacto que se
 *     mostró: entra a la huella del sello, así un click no vale si la fuente cambió después del cuadro.
 *   · `historiaDe(marcador)` → `{ id, titulo }` de la historia de la corrida, o null sin corrida.
 *   · `seccionesDelPlan(texto)` → `{ queHace, archivos }` o `{ error }`: el plan dice qué hace en hasta 3 líneas y qué
 *     archivos toca, o no se firma (lo comprueba `marker.js complete-step approve-plan` antes de la ventana).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PIPELINE = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js');
const PLAN_FILE = 'step-02-bmad-plan.md';
const LINEAS_DEL_PLAN = 3;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** El valor de `--opcion` en las palabras del comando (también `--opcion=valor`), o null. */
function valor(palabras, opcion) {
  const p = palabras || [];
  const i = p.indexOf(opcion);
  if (i >= 0) return p[i + 1] != null ? String(p[i + 1]) : null;
  const pegado = p.find((w) => String(w).startsWith(`${opcion}=`));
  return pegado ? String(pegado).slice(opcion.length + 1) : null;
}

function leer(ruta) {
  try { return fs.readFileSync(ruta, 'utf8'); } catch (_) { return null; }
}

function rutaDeLaHistoria(m) {
  if (!m || !m.storyPath) return null;
  return path.isAbsolute(m.storyPath) ? m.storyPath : path.join(m.repoPath || process.cwd(), m.storyPath);
}

/** La historia de la corrida con su título (`title:` del frontmatter), o null sin corrida. */
function historiaDe(m) {
  if (!m || !m.storyId) return null;
  const texto = leer(rutaDeLaHistoria(m) || '');
  const fm = texto && /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  const t = fm && /^title:\s*(.+?)\s*$/m.exec(fm[1]);
  const titulo = t ? t[1].replace(/^(["'])(.*)\1$/, '$2').trim() : null;
  return { id: String(m.storyId), titulo: titulo || null };
}

/** La carpeta de la corrida de la sesión del marcador, sin crearla; null sin corrida o sin clave. */
function carpetaDeLaCorrida(m) {
  if (!m || !m.storyId) return null;
  try { return require(PIPELINE).resolveRunDir(m.repoPath || process.cwd(), String(m.storyId), false, rutaDeLaHistoria(m) || undefined); } catch (_) { return null; }
}

/** El cuerpo de la sección `## <titulo>` del markdown, sin el título; null si no está. */
function seccion(texto, titulo) {
  const lineas = String(texto).split(/\r?\n/);
  const i = lineas.findIndex((l) => new RegExp(`^##\\s+${titulo}\\s*$`, 'i').test(l.trim()));
  if (i < 0) return null;
  const fin = lineas.findIndex((l, k) => k > i && /^#{1,2}\s/.test(l));
  return lineas.slice(i + 1, fin < 0 ? undefined : fin);
}
const renglones = (cuerpo) => (cuerpo || []).map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()).filter(Boolean);

function seccionesDelPlan(texto) {
  const queHace = renglones(seccion(texto, 'Qué hace'));
  if (!queHace.length) return { error: 'el plan no dice qué hace en hasta 3 líneas: falta la sección «## Qué hace». Agregala al plan con hasta 3 líneas llanas de qué cambia' };
  if (queHace.length > LINEAS_DEL_PLAN) return { error: `el plan no dice qué hace en hasta 3 líneas: su sección «## Qué hace» tiene ${queHace.length}. Dejala en 3 líneas llanas` };
  const archivos = renglones(seccion(texto, 'Archivos')).flatMap((l) => l.split(/,\s+/)).map((a) => a.replace(/`/g, '').trim()).filter(Boolean);
  if (!archivos.length) return { error: 'el plan no dice qué archivos toca: falta la sección «## Archivos». Agregala al plan con un archivo por renglón («- ruta»)' };
  return { queHace, archivos };
}

/** El plan escrito de la corrida: `{ ruta, texto }`; `texto` null si no está. */
function planDe(m) {
  const dir = carpetaDeLaCorrida(m);
  const ruta = dir ? path.join(dir, PLAN_FILE) : null;
  return { ruta, texto: ruta ? leer(ruta) : null };
}

function delPlan(palabras, m) {
  const cita = valor(palabras, '--approved') || valor(palabras, '--mockup-approved');
  const { ruta, texto } = planDe(m);
  if (texto == null) return { queHace: [`no encuentro el plan escrito${ruta ? ` en ${ruta}` : ' (la sesión no tiene una corrida con carpeta)'}`], fuente: '', cita };
  const s = seccionesDelPlan(texto);
  if (s.error) return { queHace: [s.error], completo: ruta, fuente: texto, cita };
  return { queHace: s.queHace, archivos: s.archivos, completo: ruta, fuente: texto, cita };
}

const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 });

/** El cambio de los controles: cuántas líneas, qué rutas y el diff completo en un archivo de la carpeta de estado. */
function deControles(palabras, cwd, estado) {
  const raiz = path.resolve(cwd || process.cwd(), valor(palabras, '--root') || '.');
  let rutas = [];
  let entradas = null;
  try { entradas = JSON.parse(valor(palabras, '--entries') || 'null'); } catch (_) { entradas = null; }
  if (Array.isArray(entradas)) rutas = entradas.map((e) => e && e.path).filter((p) => typeof p === 'string');
  else if (valor(palabras, '--file')) rutas = [valor(palabras, '--file')];
  const base = valor(palabras, '--base');
  const rev = valor(palabras, '--rev');
  const rango = base ? [base, 'HEAD'] : rev ? [`${rev}^`, rev] : null;
  if (!rutas.length) return null;
  if (!rango) {
    return { queHace: [`Firma ${rutas.length} archivo(s) de control en su versión de la punta (sin base para comparar)`], archivos: rutas,
      completo: rutas.map((r) => path.join(raiz, r)).join(', '), fuente: JSON.stringify(entradas || rutas) };
  }
  const num = git(raiz, ['diff', '--numstat', ...rango, '--', ...rutas]);
  const diff = git(raiz, ['diff', ...rango, '--', ...rutas]);
  if (num.status !== 0 || diff.status !== 0) {
    return { queHace: [`no pude leer el cambio de ${rutas.length} archivo(s) de control contra ${rango[0]} (${String(num.stderr || diff.stderr || '').trim().split('\n')[0] || 'git falló'})`],
      archivos: rutas, fuente: JSON.stringify(entradas || rutas) };
  }
  let mas = 0;
  let menos = 0;
  for (const l of num.stdout.split('\n')) {
    const [a, b] = l.split('\t');
    if (/^\d+$/.test(a)) mas += Number(a);
    if (/^\d+$/.test(b)) menos += Number(b);
  }
  let completo = null;
  if (estado) {
    const dir = path.join(estado, 'firmas');
    completo = path.join(dir, `diff-${sha(diff.stdout).slice(0, 16)}.patch`);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(completo, diff.stdout); } catch (_) { completo = null; }
  }
  return { queHace: [`Cambia ${rutas.length} archivo(s) de control: +${mas} −${menos} líneas`], archivos: rutas, completo, fuente: diff.stdout };
}

const acsDe = (palabras) => [...new Set(String(valor(palabras, '--acs') || '').split(/[,\s]+/).filter(Boolean).map(Number))].filter((n) => Number.isInteger(n) && n > 0);

/** Los criterios que se marcan probados a mano, de la historia de la corrida. */
function deLaPruebaAMano(palabras, m) {
  const historia = rutaDeLaHistoria(m);
  if (!historia) return null;
  const acs = acsDe(palabras);
  let criterios = [];
  try { criterios = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'manual-checks.js')).criterios(historia); } catch (_) { criterios = []; }
  const lineas = acs.map((n) => { const c = criterios.find((x) => x.n === n); return `AC ${n}: ${c ? c.text : '(no está en la historia)'}`; });
  return lineas.length ? { queHace: lineas, completo: historia, fuente: lineas.join('\n') } : null;
}

function hallazgosDe(dir) {
  const ruta = dir ? path.join(dir, 'findings.json') : null;
  const texto = ruta ? leer(ruta) : null;
  if (texto == null) return { ruta: null, lista: null };
  let j;
  try { j = JSON.parse(texto); } catch (_) { return { ruta, lista: null, texto }; }
  return { ruta, texto, lista: Array.isArray(j) ? j : (j && Array.isArray(j.findings) ? j.findings : []) };
}

/** El hallazgo crítico que se exime, del informe de hallazgos de la corrida. */
function delCritico(palabras, m) {
  const regla = valor(palabras, '--rule');
  if (!regla) return null;
  const archivo = valor(palabras, '--file');
  const cita = valor(palabras, '--reason');
  const nombre = `${regla}${archivo ? ` en ${archivo}` : ''}`;
  const h = hallazgosDe(carpetaDeLaCorrida(m));
  const archivos = archivo ? [archivo] : [];
  if (!h.lista) return { queHace: [`Eximir ${nombre}: no hay informe de hallazgos en esta corrida`], archivos, completo: h.ruta, fuente: h.texto || '', cita };
  const reglaDe = (f) => String(f.rule_id || f.ruleId || f.rule || '').trim();
  const iguales = h.lista.filter((f) => f && reglaDe(f) === regla && (!archivo || String(f.file || '') === archivo));
  if (!iguales.length) return { queHace: [`Eximir ${nombre}: no está en el informe de hallazgos`], archivos, completo: h.ruta, fuente: h.texto, cita };
  const lineas = iguales.map((f) => `${regla}${f.file ? ` en ${f.file}` : ''}: ${String(f.summary || f.title || f.reason || '(sin texto)').replace(/\s+/g, ' ').trim()}`);
  return { queHace: lineas, archivos: archivo ? archivos : [...new Set(iguales.map((f) => f.file).filter(Boolean))], completo: h.ruta, fuente: h.texto, cita };
}

/** La vuelta extra: su nota, o la carpeta de la corrida sin ella. */
function deLaVuelta(palabras, m) {
  const iter = valor(palabras, '--iter');
  const dir = carpetaDeLaCorrida(m);
  if (!iter || !/^\d+$/.test(iter)) return dir ? { queHace: ['Una vuelta más de revisores sobre lo que quedó abierto'], completo: dir, fuente: '' } : null;
  const ruta = dir ? path.join(dir, 'rethink', `iter-${iter}.json`) : null;
  const texto = ruta ? leer(ruta) : null;
  let n = null;
  try { n = texto ? JSON.parse(texto) : null; } catch (_) { n = null; }
  if (!n) return { queHace: [`Una vuelta ${iter} de revisores sobre lo que quedó abierto`], completo: dir, fuente: '' };
  const lineas = [n.repeated && `Se repitió: ${n.repeated}`, n.change ? `Cambia: ${n.change}` : n.keep && `Sigue igual: ${n.keep}`, n.story_change && `Cambia la historia: ${n.story_change}`].filter(Boolean);
  return { queHace: lineas, completo: ruta, fuente: texto };
}

/** El arreglo rápido: el cupo es lo que se firma; el motivo lo escribió la sesión y va como cita. */
function delArreglo(palabras) {
  if (!palabras || palabras[1] !== 'adhoc' || palabras[2] !== 'set') return null;
  let p = null;
  try { p = JSON.parse(palabras[3] || ''); } catch (_) { p = null; }
  if (!p || typeof p !== 'object') return null;
  const cupo = Number.isFinite(Number(p.maxFiles)) && Number(p.maxFiles) > 0 ? `hasta ${Number(p.maxFiles)} archivos de implementación, sin pruebas ni guías` : 'el cupo de siempre (8 archivos de implementación, o el que ya tenía)';
  return { queHace: [`Abre un arreglo rápido sin historia, con ${cupo}`], fuente: palabras[3], cita: String(p.reason || '') || null };
}

/**
 * Nombrar o retirar a la coordinadora: qué sesión, en qué carpeta. El id solo no le dice nada al dueño; la carpeta sí.
 * El rol es el que nombra el perfil del equipo (`approvals.relay_session`).
 */
function deLaDesignacion(firma, destino, cwd) {
  if (!destino) return null;
  let rol = null;
  try { rol = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js')).sesionQueReenvia().valor; } catch (_) { rol = null; }
  const verbo = firma === 'designation-set' ? 'pasa a ser' : 'deja de ser';
  const linea = `La sesión ${destino}, en ${cwd || process.cwd()}, ${verbo} la «${rol || 'coordinadora'}» de esta máquina`;
  return { queHace: [linea], fuente: linea };
}

function partesDe({ firma, palabras, cwd, marcador, estado, destino } = {}) {
  if (firma === 'designation-set' || firma === 'designation-withdraw') return deLaDesignacion(firma, destino, cwd);
  if (!palabras) return null;
  if (firma === 'plan-approval') return delPlan(palabras, marcador);
  if (firma === 'control-change' || firma === 'refresh-after-main') return deControles(palabras, cwd, estado);
  if (firma === 'manual-test') return deLaPruebaAMano(palabras, marcador);
  if (firma === 'critical-waiver') return delCritico(palabras, marcador);
  if (firma === 'extra-round') return deLaVuelta(palabras, marcador);
  if (firma === 'adhoc-lane' || firma === 'adhoc-lane:sobre-cupo') return delArreglo(palabras);
  return null;
}

module.exports = { partesDe, historiaDe, seccionesDelPlan, planDe, carpetaDeLaCorrida, valor };
