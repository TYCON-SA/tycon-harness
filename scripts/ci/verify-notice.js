#!/usr/bin/env node
'use strict';
// verify-notice.js — el texto del aviso de la verificación de lo publicado (story 8.26, tanda F2 · AC 24).
//
// POR QUÉ EXISTE. Con el arnés mantenido directo en el repo público, lo publicado no se retira solo: un nombre en un
// comentario o un secreto en las notas de una versión siguen ahí hasta que alguien los saque. La verificación de noche
// (scripts/publishing/mirror.js verify) los encuentra, pero una corrida roja a las seis de la mañana la ve quien entre
// a mirar el pipeline. Este guion arma, con el informe que `verify` deja (`--report`), el aviso que el pipeline le
// manda al dueño por Telegram: qué encontró, DÓNDE, y qué hacer con cada cosa.
//
// QUÉ GARANTIZA
//   · En verde no escribe nada: un aviso de todos los días se deja de leer. «Verde» es un 0 CON su informe en 0 y sin
//     hallazgos: un 0 sin un informe que se pueda leer no es verde, es «no se sabe qué miró», y se avisa.
//   · Con hallazgos, o con «no pude mirar», escribe el aviso. También si la verificación falló y su informe no está o
//     no se deja leer: eso no es silencio, es «no pudo mirar» y se dice.
//   · Manda el código con que terminó la verificación (`--exit`), no lo que diga el informe: un informe «verde» al
//     lado de una corrida que salió mal no tapa la falla.
//   · No agrega nada que el informe no traiga —y el informe nunca trae el texto hallado, sólo el lugar—. Lo que
//     escribió un tercero (una ruta de un pedido) entra en una línea, sin caracteres de control y con tope; el aviso
//     entero entra en un mensaje.
//   · Con el repo PRIVADO, lo que quedó en la historia de `main` no dispara el aviso (story 8.26, tanda F3 · AC 57):
//     ahí no hay nada que hacer hasta el corte —la guía lo acepta— y un aviso de todas las noches se deja de leer. Se
//     cuenta aparte, y el aviso sale sólo si hay algo más: otro hallazgo, un secreto (que se rota esté donde esté),
//     algo que nadie leyó (un binario sin permiso, un submódulo), una parte sin mirar, un «no medido» con `--strict`.
//     La verificación no cambia: sigue saliendo 1.
//     🔴 Es la única rama de este guion que CALLA con la verificación en rojo, así que falla cerrado: ante cualquier
//     duda (ver `setAside`) no separa nada y avisa todo. Y cuando calla lo dice dos veces: una línea con la cuenta
//     por la salida de error, y su propio código de salida (3), que el paso del pipeline exige para aceptar el silencio.
//
// USO
//   node scripts/ci/verify-notice.js --report <archivo> --exit <código de verify> [--run <número de corrida>]
//   node scripts/ci/verify-notice.js --did-not-finish [--run <número de corrida>]
//        (la verificación tenía que correr en esta corrida y no dejó ni su código: un paso anterior falló o la cortaron)
//   Por la salida: el aviso, o nada. Por la salida de error: una línea para el registro, si algo quedó aparte.
//   Códigos: 0 (escribió el aviso, o la verificación salió en verde) · 2 argumentos · 3 calló a propósito: lo único
//   que había son hallazgos aceptados de la historia del repo privado.
// No lee ninguna variable de entorno ni habla con la red: quien manda el aviso es el paso del pipeline
// (pipelines/azure-pipelines-publicacion.yml, «Avisar lo que encontró la verificación»). Casos: scripts/tests/verify-notice.test.js.

const fs = require('fs');

const GUIDE = 'guides/publicacion-espejo.md, §«Si `verify` da 1»';
const MAX_MESSAGE = 3800;   // un mensaje de Telegram lleva hasta 4096 caracteres
const MAX_PLACE = 300;
const MAX_REASON = 300;
// en el orden en que hay que actuar: lo que se rota va primero
const GROUPS = Object.freeze([
  { key: 'rotate', title: 'Rotar PRIMERO (es un secreto), y después borrar y pedir la purga' },
  { key: 'delete-and-purge', title: 'Borrar, y además pedir la purga al soporte de GitHub' },
  { key: 'delete', title: 'Borrar (la rama, la marca o la versión)' },
  { key: 'edit', title: 'Corregir en la configuración del repo' },
  { key: 'see-guide', title: 'Ver la guía' },
]);
// Con el repo privado nada se purga (la guía: se arregla en el interno, y la historia queda hasta el corte): los dos
// títulos que nombran la purga tienen su variante. Las claves de los grupos son las mismas.
const PRIVATE_TITLES = Object.freeze({
  rotate: 'Rotar PRIMERO (es un secreto); el repo es privado: no se pide purga',
  'delete-and-purge': 'Repo privado, sin purga: lo de main se arregla en el interno y sale con la sincronización siguiente; un pedido se cierra; un texto se corrige',
});
const QUIET_EXIT = 3;   // «callé a propósito»: sólo había hallazgos aceptados
const HISTORY_PART = "a'";
// Lo que NUNCA queda aparte, esté donde esté: un secreto (se rota) y lo que nadie leyó —un binario sin permiso, un
// submódulo—, que no es «un nombre aceptado» sino «no se sabe qué hay». De un binario se sale declarándolo en la lista
// privada; un submódulo de la historia se sigue avisando hasta el corte.
const NEVER_ACCEPTED = Object.freeze(['secreto', 'secret-alert', 'sin-leer']);

// Los escapes de terminal, y los caracteres de control de ASCII y de Latin-1 más los dos separadores de línea de
// Unicode. Armados por su código: escritos en una expresión, los dos últimos cortarían la línea de este archivo.
const ESCAPES = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, 'g');
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');
/** Un texto del informe, en una línea: sin caracteres de control ni escapes de terminal, y con tope. */
function oneLine(value, max) {
  const text = typeof value === 'string' ? value : '?';
  const flat = text.replace(ESCAPES, '').replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
/** La letra de una parte y el nombre de una categoría: cortos y sin nada raro, o «?». */
const label = (value) => (typeof value === 'string' && /^[A-Za-z0-9'_-]{1,40}$/.test(value) ? value : '?');

function parseArgs(argv) {
  const valued = new Map([['--report', 'report'], ['--exit', 'exit'], ['--run', 'run']]);
  const args = {};
  let unfinished = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--did-not-finish') { unfinished = true; continue; }
    const key = valued.get(argv[i]);
    const value = argv[i + 1];
    if (!key || value === undefined || value.startsWith('--')) return null;
    args[key] = value;
    i += 1;
  }
  // el número de corrida viene del ambiente del pipeline: sólo se imprime si tiene su forma (`20261010.3`, `12345`)
  const run = typeof args.run === 'string' && /^[0-9A-Za-z][0-9A-Za-z._-]{0,40}$/.test(args.run) ? args.run : null;
  // `--did-not-finish`: la verificación tenía que correr y no dejó ni su código. No hay informe ni código que pasar.
  if (unfinished) return args.report === undefined && args.exit === undefined ? { unfinished: true, run } : null;
  if (!args.report || !/^[0-9]{1,3}$/.test(String(args.exit === undefined ? '' : args.exit))) return null;
  return { report: args.report, exit: Number(args.exit), run };
}

/** El informe, o null si no está o no es el de `verify`. */
function readReport(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.command !== 'verify') return null;
  return data;
}

/**
 * Lo aceptado, aparte (story 8.26, tanda F3 · AC 57). Devuelve los hallazgos que se avisan (`rest`) y cuántos quedaron
 * aparte (`accepted`). Un hallazgo queda aparte sólo si se cumple TODO, exactamente:
 *   · el informe dice que el repo es privado (`private === true`; `false`, `null` —no se pudo leer— o ausente, no);
 *   · la verificación terminó en 1 y el informe dice 1 (hallazgos, y nada raro entre la corrida y su informe);
 *   · es de la parte (a') y llegó a `main`: está en la historia y ningún borrado lo saca. Lo que está en un pedido o
 *     cuelga de una rama o de una marca tiene algo para hacer, y se avisa;
 *   · no es un secreto ni algo que nadie leyó: `rotateFirst` es `false` y su categoría no está en `NEVER_ACCEPTED`.
 * Cualquier otra forma —un campo que falta, otro tipo, un hallazgo que no es un objeto— va a lo que se avisa: la
 * regla es POR HALLAZGO. El que no se deja leer se avisa él; los demás, que sí son exactamente lo aceptado, quedan
 * aparte, y el aviso —que entonces sale siempre— dice cuántos.
 */
function setAside({ exit }, data, findings) {
  if (data.private !== true || exit !== 1 || data.exit !== 1) return { rest: findings, accepted: 0 };
  const isAccepted = (f) => Boolean(f) && typeof f === 'object' && !Array.isArray(f)
    && f.part === HISTORY_PART && f.reach === 'main' && f.rotateFirst === false
    && typeof f.category === 'string' && !NEVER_ACCEPTED.includes(f.category);
  const rest = findings.filter((f) => !isAccepted(f));
  return { rest, accepted: findings.length - rest.length };
}

/** El aviso y lo que quedó aparte: `{ text, accepted }`. `text` vacío es «nada que avisar». */
function compose({ exit, run, unfinished = false }, data) {
  const where = `Arnés — verificación de lo publicado${run ? ` (corrida ${run})` : ''}`;
  const only = (text) => ({ text, accepted: 0 });
  if (unfinished) {
    return only([`${where}: NO PUDO MIRAR — tenía que correr en esta corrida y no llegó a terminar (un paso anterior falló, o la cortaron).`,
      'Eso NO es «limpio»: hasta que vuelva a correr bien, lo publicado no lo mira nadie. El motivo está en el registro de la corrida.'].join('\n'));
  }
  // Una lista del informe que falta es una lista vacía (el informe de un `verify` que frenó antes de mirar trae sólo el
  // código y el motivo); una que está y NO es una lista es un informe que no se puede leer.
  const listOf = (value) => (value === undefined ? [] : Array.isArray(value) ? value : null);
  const allFindings = data ? listOf(data.findings) : null;
  const allBlind = data ? listOf(data.couldNotLook) : null;
  // 🔴 Sin un informe que se pueda leer no hay «verde», salga con el código que salga: `verify` deja SIEMPRE su informe
  // cuando se lo piden, así que un 0 sin informe no es una verificación limpia, es una que no se sabe qué miró.
  if (!data || allFindings === null || allBlind === null) {
    return only([`${where}: NO PUDO MIRAR — terminó con código ${exit} y no dejó un informe que se pueda leer.`,
      'Eso NO es «limpio»: no se sabe qué miró. El motivo está en el registro de la corrida.'].join('\n'));
  }
  const blind = allBlind.filter((x) => x && typeof x === 'object');
  // lo que no es un objeto en «no pude mirar» no se pierde: cuenta como una parte sin nombre
  if (blind.length !== allBlind.length) blind.push({ part: '?', reason: 'el informe trae una parte sin mirar que no se puede leer' });
  if (exit === 0 && data.exit === 0 && !allFindings.length && !blind.length) return only('');
  // Lo aceptado, aparte. 🔴 Si lo «no medido» del informe no se deja leer, no se separa nada: no se puede saber si
  // además de la historia había algo sin medir.
  const allUnmeasured = listOf(data.notMeasured);
  const { rest: findings, accepted } = allUnmeasured === null ? { rest: allFindings, accepted: 0 } : setAside({ exit }, data, allFindings);
  // Un «no medido» es «algo más» cuando la corrida lo exigía (`--strict`) o el informe no dice si lo exigía. Sólo se
  // mira cuando algo quedó aparte: sin eso el aviso es el de siempre.
  const unmeasured = accepted && data.strict !== false ? allUnmeasured.map((x) => (x && typeof x === 'object' ? x : { part: '?', reason: 'el informe trae una parte sin medir que no se puede leer' })) : [];
  if (accepted && !findings.length && !blind.length && !unmeasured.length) return { text: '', accepted };
  const lines = [];
  const parts = [...new Set(blind.map((x) => `(${label(x.part)})`))].join(', ');
  const reason = blind.length ? oneLine(blind[0].reason, MAX_REASON) : oneLine(data.message, MAX_REASON);
  const unmeasuredText = unmeasured.length ? `${[...new Set(unmeasured.map((x) => `(${label(x.part)})`))].join(', ')} — ${oneLine(unmeasured[0].reason, MAX_REASON)}` : '';
  const titleOf = (group) => (data.private === true && PRIVATE_TITLES[group.key]) || group.title;
  if (findings.length) {
    lines.push(`${where}: ${findings.length} hallazgo(s). Lo publicado no se retira solo.`);
    const groupOf = (f) => (f && typeof f === 'object' ? (f.rotateFirst === true ? 'rotate' : GROUPS.some((g) => g.key === f.action) ? f.action : 'see-guide') : 'see-guide');
    for (const group of GROUPS) {
      const mine = findings.filter((f) => groupOf(f) === group.key);
      if (!mine.length) continue;
      lines.push(`${titleOf(group)} (${mine.length}):`);
      for (const f of mine) {
        const item = f && typeof f === 'object' ? f : {};
        lines.push(`· (${label(item.part)}) [${label(item.category)}] ${oneLine(item.place, MAX_PLACE)}`);
      }
    }
    if (blind.length) lines.push(`Además no se pudo mirar: ${parts} — ${reason}`);
    if (exit !== 1) lines.push(`(La verificación terminó con código ${exit}.)`);
    if (unmeasured.length) lines.push(`Además quedó sin medir: ${unmeasuredText}`);
  } else if (blind.length || (exit === 2 && data.exit === 2)) {
    lines.push(`${where}: NO PUDO MIRAR${parts ? ` ${parts}` : ''}.`);
    lines.push(`Motivo: ${reason || 'está en el registro de la corrida'}`);
    lines.push('«No pude mirar» no es «limpio»: hasta que vuelva a correr bien, eso no lo mira nadie.');
    if (unmeasured.length) lines.push(`Además quedó sin medir: ${unmeasuredText}`);
  } else if (unmeasured.length) {
    // sólo pasa con algo aparte: lo único que hay, además de la historia aceptada, es una parte que no se midió
    lines.push(`${where}: quedó sin medir ${unmeasuredText}`);
    lines.push('«Sin medir» no es «limpio»: esa parte no la miró nadie en esta corrida.');
  } else {
    // la corrida salió mal y el informe no dice por qué (dice otra cosa, o es el de otra corrida): no se da por bueno
    lines.push(`${where}: NO PUDO MIRAR — terminó con código ${exit} y su informe (que dice ${Number.isInteger(data.exit) ? data.exit : '?'}) no trae hallazgos ni partes sin mirar.`);
    lines.push('Algo no cierra, y eso no es «limpio»: el motivo está en el registro de la corrida.');
  }
  // lo que cierra el aviso: cuántos quedaron aparte (si alguno) y dónde está el paso a paso
  const closing = [...(accepted ? [`Aparte: ${accepted} hallazgo(s) en la historia del repo privado, aceptados hasta el corte (no se listan).`] : []), `Paso a paso: ${GUIDE}.`];
  // el aviso entra en un mensaje: si no, se cortan los lugares del final y se dice cuántos quedaron afuera
  // (lo que no es un lugar —el encabezado, los títulos, lo que no se pudo mirar, el cierre— va siempre: su lugar se reserva antes)
  const isPlace = (line) => line.startsWith('· ');
  let size = 80 + [...lines.filter((l) => !isPlace(l)), ...closing].reduce((n, l) => n + l.length + 1, 0);
  const kept = [];
  let dropped = 0;
  for (const line of lines) {
    if (!isPlace(line)) { kept.push(line); continue; }
    if (size + line.length + 1 > MAX_MESSAGE) { dropped += 1; continue; }
    kept.push(line);
    size += line.length + 1;
  }
  if (dropped) kept.push(`… y ${dropped} más (están en el registro de la corrida).`);
  return { text: [...kept, ...closing].join('\n'), accepted };
}

/** Sólo el texto del aviso (lo que quedó aparte lo dice `compose`). */
const build = (args, data) => compose(args, data).text;

function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write('uso: verify-notice.js --report <archivo> --exit <código de verify> [--run <número de corrida>]\n'
      + '     verify-notice.js --did-not-finish [--run <número de corrida>]\n');
    return 2;
  }
  const { text, accepted } = compose(args, args.unfinished ? null : readReport(args.report));
  // la línea del registro: una cuenta, sin lugares. Va por la salida de error —la salida es el aviso, que viaja a Telegram—
  if (accepted) {
    process.stderr.write(`▸ ${accepted} hallazgo(s) en la historia del repo privado, aceptados hasta el corte: ${text ? 'no van en el aviso, que sale por lo demás' : 'no se avisan'} (${GUIDE}).\n`);
  }
  if (text) process.stdout.write(`${text}\n`);
  // 🔴 callar con la verificación en rojo se dice con un código propio: el paso del pipeline no acepta ese silencio por
  // una línea en la salida de error (ahí escribe cualquier aviso de node), sino por este código
  return !text && accepted ? QUIET_EXIT : 0;
}

module.exports = { build, compose, setAside, parseArgs, readReport, oneLine, GROUPS, QUIET_EXIT };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
