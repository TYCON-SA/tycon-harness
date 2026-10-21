#!/usr/bin/env node
'use strict';
/**
 * advisor-liveness-on-change.js — cuando cambia la prosa de un revisor, se le toma el chequeo de vida
 * de ESE revisor, en el acto.
 *
 * ── POR QUÉ ────────────────────────────────────────────────────────────────────────
 * El chequeo de vida (`advisor-runner.js --liveness`) corre por CALENDARIO: martes y viernes a las 2 de
 * la mañana, toque alguien la prosa de un revisor o no. O sea que el momento en que un revisor se
 * rompe —cuando alguien le edita las instrucciones— y el momento en que nos enteramos están hasta
 * cuatro días separados, y en el medio ese revisor está auditando código de verdad, en silencio.
 *
 * Esto cierra esa distancia: el par canario del revisor tocado corre en el pre-commit del repo
 * donde vive su prosa (`~/.claude/agent-skills`, `agents/*.md`). Son 2 consultas y ~40 s, en un
 * commit que es raro y consecuente.
 *
 * ── LA DECISIÓN QUE LO HACE CREÍBLE ─────────────────────────────────────────────────────────────
 * 🔴 UN ROJO NO FRENA EL COMMIT POR SÍ SOLO. Con una sola corrida, el chequeo de vida NO distingue
 * un defecto de criterio de una moneda al aire — es una limitación de diseño, medida: los 2 rojos
 * que dio desde que existe fueron los DOS variación entre corridas, ninguno un defecto real. Un
 * gate que frena un commit por una moneda al aire se desactiva en una semana, y con él se va el día
 * que el rojo era de verdad.
 *
 * Entonces, ante un rojo, el propio gate CONFIRMA con 3 corridas de ese caso:
 *   · 3 de 3 en rojo  → es criterio: FRENA el commit (el revisor quedó roto por esta edición).
 *   · mixto           → es el CASO el que está mal diseñado, no el revisor: avisa y deja pasar.
 * Cuesta 3 consultas más, y sólo en el caso raro.
 *
 * ── QUÉ NO HACE, A PROPÓSITO ────────────────────────────────────────────────────────────────────
 * · No frena por plomería. Sin `claude`, sin red, sin sesión, timeout, o el corral escapándose →
 *   avisa fuerte y DEJA PASAR. Frenar un commit porque no había internet es la vía rápida a
 *   `--no-verify`, y ahí se pierde también el caso en que importaba.
 * · No corre si el commit toca muchos revisores a la vez (`TOPE_REVISORES`): una edición masiva no
 *   es el caso que esto viene a cazar, y 2 consultas × N vuelve inusable el commit. Lo dice y
 *   sugiere el barrido completo.
 * · No mira revisores sin canario: eso ya lo denuncia `--liveness` al arrancar.
 *
 * Uso:
 *   node advisor-liveness-on-change.js <agents/foo.md> [...]   # lo llama el pre-commit de AgentSkills
 *   node advisor-liveness-on-change.js --selftest              # lógica pura, sin gastar un solo modelo
 *
 * Apagado: TYCON_NO_LIVENESS_PRECOMMIT=1
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readEnv } = require('../lib/legacy-names.js');

const WHERE = 'scripts/hooks/advisor-liveness-on-change.js';
const TCG = path.resolve(__dirname, '..', '..');
const CASES_DIR = path.join(TCG, 'scripts', 'controls-bench', 'cases', 'advisors');
const RUNNER = path.join(TCG, 'scripts', 'controls-bench', 'advisor-runner.js');
const TOPE_REVISORES = parseInt(readEnv('TYCON_LIVENESS_REVIEWER_CAP', { where: WHERE }) || '3', 10);

/** De `agents/tycon-plugin-security-basics.md` al nombre del revisor. */
function advisorDeArchivo(p) {
  const b = path.basename(String(p || ''));
  return b.endsWith('.md') ? b.slice(0, -3) : null;
}

/** Los ids del par canario de un revisor, leídos de su archivo de casos. */
function canariosDe(advisor) {
  const f = path.join(CASES_DIR, `${advisor}.json`);
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
  const ids = (d.cases || []).filter((c) => c.canario === true).map((c) => c.id);
  return ids.length ? ids : null;
}

/**
 * El veredicto del gate a partir de lo que devolvió el motor. PURA a propósito: es la tabla de
 * decisión que hay que poder ejercer sin gastar un modelo (`--selftest`).
 *
 * @param {{code:number, rojos:Array<{key:string,clase:string}>}} primera  la corrida del par
 * @param {{flags:Array<boolean|null>}|null} confirmacion  las 3 corridas del caso rojo, si hubo
 * @returns {{accion:'pass'|'block'|'warn', motivo:string}}
 * (pasa · frena · avisa; la decisión no sale de este archivo)
 */
function decidir(primera, confirmacion) {
  if (primera.infra) return { accion: 'warn', motivo: `no se pudo medir (${primera.infra}) — el commit pasa, pero el revisor NO quedó verificado` };
  if (!primera.rojos.length) return { accion: 'pass', motivo: 'el par canario salió verde' };

  // Plomería: fuga del corral o corrida caída. No dice nada del criterio del revisor.
  const soloPlomeria = primera.rojos.every((r) => ['fuga', 'error', 'artefactos'].includes(r.clase));
  if (soloPlomeria) return { accion: 'warn', motivo: 'el rojo es de plomería, no de criterio — el commit pasa' };

  if (!confirmacion) return { accion: 'warn', motivo: 'hubo un rojo de criterio pero no se pudo confirmar con 3 ejecuciones — el commit pasa' };
  const f = confirmacion.flags.filter((x) => x === true || x === false);
  if (!f.length) return { accion: 'warn', motivo: 'la confirmación no produjo ejecuciones válidas — el commit pasa' };
  const todasMal = confirmacion.todasMal;
  if (todasMal) return { accion: 'block', motivo: 'el revisor falló su caso canario en las 3 ejecuciones — esta edición lo rompió' };
  return { accion: 'warn', motivo: 'la confirmación salió MIXTA: el problema es el caso, no el revisor — el commit pasa' };
}

/** Corre el motor y devuelve {code, rojos[], infra}. `infra` ≠ null ⇒ no se pudo medir. */
function correr(args) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', timeout: 8 * 60 * 1000 });
  if (r.error) return { code: -1, rojos: [], infra: r.error.message, salida: '' };
  const salida = `${r.stdout || ''}\n${r.stderr || ''}`;
  // Sin sesión / sin binario / sin red: el motor no falla "por criterio", falla por plomería.
  if (/command not found|ENOENT|not authenticated|401|no pude/i.test(salida) && r.status !== 0 && !/rojos=/.test(salida)) {
    return { code: r.status, rojos: [], infra: 'la herramienta no pudo correr', salida };
  }
  return { code: r.status, rojos: [], salida, infra: null };
}

/** Lee el reporte que el motor acaba de escribir y saca los rojos con su clase. */
function rojosDelReporte(archivo) {
  let d;
  try { d = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (_) { return null; }
  const out = [];
  for (const [key, caso] of Object.entries(d.results || {})) {
    for (const [tool, v] of Object.entries(caso.tools || {})) {
      if (v && v.pass === false) out.push({ key, tool, clase: v.clase || 'criterio', flags: v.flags || [] });
    }
  }
  return out;
}

function selftest() {
  const casos = [
    ['par verde → pasa', decidir({ rojos: [] }, null).accion === 'pass'],
    ['no se pudo medir → avisa, NO frena (sin red no se bloquea un commit)',
      decidir({ rojos: [], infra: 'sin sesión' }, null).accion === 'warn'],
    ['🔴 rojo de criterio confirmado 3/3 → FRENA',
      decidir({ rojos: [{ key: 'x', clase: 'criterio' }] }, { flags: [true, true, true], todasMal: true }).accion === 'block'],
    ['🔴 rojo de criterio con confirmación MIXTA → avisa, no frena (es el caso, no el revisor)',
      decidir({ rojos: [{ key: 'x', clase: 'criterio' }] }, { flags: [true, true, false], todasMal: false }).accion === 'warn'],
    ['una fuga del corral no frena un commit',
      decidir({ rojos: [{ key: 'x', clase: 'fuga' }] }, null).accion === 'warn'],
    ['una ejecución caída no frena un commit',
      decidir({ rojos: [{ key: 'x', clase: 'error' }] }, null).accion === 'warn'],
    ['un rojo de criterio SIN confirmación no frena (no se bloquea sobre una sospecha)',
      decidir({ rojos: [{ key: 'x', clase: 'criterio' }] }, null).accion === 'warn'],
    ['criterio + plomería juntos: sigue siendo criterio y se confirma',
      decidir({ rojos: [{ key: 'x', clase: 'criterio' }, { key: 'y', clase: 'fuga' }] }, { flags: [true, true, true], todasMal: true }).accion === 'block'],
    ['el nombre del revisor sale del archivo', advisorDeArchivo('agents/tycon-plugin-security-basics.md') === 'tycon-plugin-security-basics'],
    ['un archivo que no es .md no da revisor', advisorDeArchivo('agents/README.txt') === null],
    ['un revisor real tiene canarios', Array.isArray(canariosDe('tycon-silent-failure-hunter'))],
    ['un revisor inventado no tiene canarios', canariosDe('no-existe-este-revisor') === null],
  ];
  let bad = 0;
  for (const [n, ok] of casos) { console.log(`${ok ? '✅' : '❌'} vida-on-change: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ vida-on-change: ${casos.length}/${casos.length} verdes`);
  return bad ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (readEnv('TYCON_NO_LIVENESS_PRECOMMIT', { where: WHERE }) === '1') return 0;

  const advisors = [...new Set(argv.filter((a) => !a.startsWith('--')).map(advisorDeArchivo).filter(Boolean))];
  const conCanario = advisors.filter((a) => canariosDe(a));
  if (!conCanario.length) return 0;                       // sin canario: ya lo denuncia `--liveness`

  if (conCanario.length > TOPE_REVISORES) {
    console.error(`ℹ  el commit toca ${conCanario.length} revisores — el chequeo de vida por-commit no corre (tope ${TOPE_REVISORES}).`);
    console.error(`   Para una edición masiva conviene el barrido completo: node ${path.relative(process.cwd(), RUNNER)} --liveness`);
    return 0;
  }

  let frena = false;
  for (const advisor of conCanario) {
    const ids = canariosDe(advisor);
    console.error(`▸ chequeo de vida de ${advisor} (${ids.length} caso(s), ~40 s)…`);
    const r = correr(['--liveness', '--tool', 'claude', '--runs', '1', '--only', ids.join(','), '--json', `/tmp/vida-precommit-${process.pid}.json`]);
    const rojos = r.infra ? [] : (rojosDelReporte(`/tmp/vida-precommit-${process.pid}.json`) || []);
    const primera = { rojos, infra: r.infra };

    let confirmacion = null;
    const deCriterio = rojos.filter((x) => x.clase === 'criterio');
    if (deCriterio.length) {
      console.error(`▸ salió rojo — confirmando con 3 ejecuciones antes de decidir (un rojo de una ejecución es una SOSPECHA)…`);
      const c = correr(['--tool', 'claude', '--runs', '3', '--only', deCriterio[0].key.split('::')[1], '--json', `/tmp/vida-confirm-${process.pid}.json`]);
      if (!c.infra) {
        const rc = rojosDelReporte(`/tmp/vida-confirm-${process.pid}.json`) || [];
        const v = rc.find((x) => x.key === deCriterio[0].key);
        // Rojo en las 3: el motor lo reporta como rojo NO inestable (mixto ⇒ clase 'inestable').
        confirmacion = { flags: (v && v.flags) || [], todasMal: !!v && v.clase !== 'inestable' };
      }
    }

    const { accion, motivo } = decidir(primera, confirmacion);
    if (accion === 'block') {
      console.error(`\n⛔ ${advisor}: ${motivo}`);
      console.error(`   Caso: ${deCriterio[0].key}`);
      console.error(`   Miralo con: node ${RUNNER} --tool claude --runs 3 --only ${deCriterio[0].key.split('::')[1]} --save-output`);
      console.error(`   Si estás seguro de que el caso está mal y no el revisor: TYCON_NO_LIVENESS_PRECOMMIT=1 git commit ...`);
      frena = true;
    } else if (accion === 'warn') {
      console.error(`⚠️  ${advisor}: ${motivo}`);
    } else {
      console.error(`✅ ${advisor}: sigue vivo`);
    }
  }
  return frena ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { decidir, advisorDeArchivo, canariosDe };
