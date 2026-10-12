'use strict';
/**
 * runtime-waiver.js — la ÚNICA puerta para saltear la verificación runtime por-AC
 * (DODRT-C6), y es USER-ONLY por construcción física, no por regla.
 *
 * Objetivo (pedido explícito DevA 2026-07-10): el pipeline OBLIGA al agente a correr
 * los tests de cada AC; NO puede delegárselos al usuario. El único "obviar" lo decide
 * el humano — y sólo el humano.
 *
 * La asimetría que lo hace user-only: este proceso (el agente) corre SIN terminal
 * controladora — `open("/dev/tty")` devuelve ENXIO ("Device not configured"), verificado
 * empíricamente 2026-07-10. El usuario, sentado en su terminal, SÍ puede abrir /dev/tty.
 * `promptTty()` abre /dev/tty y lee la confirmación de AHÍ (no de stdin, que el agente sí
 * controla). Sin terminal → tira. El agente no puede satisfacerlo.
 *
 * ⚠️ LÍMITE HONESTO — hasta dónde llega y hasta dónde NO (verificado por 2 pases adversariales
 * 2026-07-10; este bloque NO puede sobre-vender la garantía, que es el pecado que todo esto combate):
 *
 *   El agente corre con el MISMO UID y tiene Bash + el código fuente de este archivo. El hash-chain
 *   es SHA-256 SIN clave (keyless): no es un secreto, cualquiera que lea este archivo lo recalcula.
 *
 *   🔴 2026-10-07 (story 7.17, guides/incident-log.md#case-firmas-ramas-paralelas-2026-10-07) — la cadena
 *   se lee como ÁRBOL, no como lista: cada entrada vale si engancha con ALGUNA entrada anterior válida del
 *   mismo archivo, o con el vacío (raíz). Y cada firma nueva se escribe como raíz. Con la lista, dos ramas
 *   que firmaban en paralelo enganchaban con la misma línea y al unirlas la segunda dejaba de enganchar con
 *   la anterior: desde ahí toda firma se descartaba en silencio y la matriz decía «esperan waiver». Una
 *   lista lineal es un árbol, así que los registros existentes se leen igual, bit a bit.
 *
 *   QUÉ FRENA (detecta y descarta): una línea agregada o cambiada a mano sin recalcular su `chain`
 *     (inventada, copiada de otra con otro contenido, o editada); una línea que engancha con otra que vino
 *     DESPUÉS en el archivo; todo lo que cuelga de una entrada descartada; una línea que no es JSON.
 *   QUÉ NO FRENA, igual que antes: una firma fabricada A PROPÓSITO. El agente puede reimplementar `sha()` +
 *     `canonical()` (son estas ~4 líneas) y escribir una entrada con el chain correcto (el re-ataque VECTOR
 *     2/3 lo demostró). NO hay forma de impedirlo con hashing keyless.
 *   NUEVO Y ACEPTADO: (a) una línea idéntica a otra válida vale (duplicada al unir ramas, o copiada); (b) una
 *     firma que se borró y se vuelve a pegar tal cual vuelve a valer — borrar una línea NO revoca una firma,
 *     lo que la vence es cambiar la declaración del AC (su `declHash`); (c) una raíz copiada de otro registro
 *     vale, y sólo aprueba un AC cuya story y declaración coincidan letra por letra con lo que un humano
 *     aprobó. Ninguna de las tres aprueba algo que un humano no haya aprobado desde su terminal.
 *
 *   No existe una llave que el agente no pueda leer en este modelo (mismo UID: un archivo 0600 lo
 *   leo; root/Keychain-con-Touch-ID lo tendría que montar el USUARIO). Así que la garantía REAL es:
 *   (a) NO hay vía cómoda/accidental — el ack agent-writable se eliminó, DOD_BYPASS/set-check/flags
 *       están cerrados; la ÚNICA vía SANCIONADA es el comando TTY que el agente no puede ejecutar.
 *   (b) Cada waiver se pinnea al `matrixHash`: si el código/evidencia cambian, deja de aplicar solo.
 *   (c) Una forja deliberada es un ACTO FLAGRANTE Y VISIBLE en el transcript (reimplementar crypto
 *       para escribir `approvedBy:"<humano>", tty:true` sin que el humano haya aprobado = mentir
 *       explícitamente en el log). No es prevención criptográfica; es "no-conveniente + a la vista".
 *
 *   Para prevención dura de verdad haría falta firma con secreto fuera del alcance del UID del
 *   agente (p.ej. Keychain con Touch-ID interactivo) — lo tendría que configurar el usuario.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const crypto = require('crypto');

const STATE_DIR = path.join(stateDirOf(os.homedir()));
// Path resuelto en CADA llamada (no cacheado a nivel módulo) para que los tests puedan
// aislar el log vía TYCON_WAIVER_LOG sin ensuciar el real. En producción esa env no existe.
function waiverLogPath() {
  return process.env.TYCON_WAIVER_LOG || path.join(STATE_DIR, 'runtime-waivers.jsonl');
}

// 🔴 2026-07-29 — el log firmado también vive DENTRO del repo, y ése es el que viaja.
// El del home sigue existiendo (compatibilidad: 38 stories aprobadas ahí) y se lee como
// segunda fuente, pero lo nuevo se escribe acá para que la aprobación del humano llegue a
// las otras máquinas y al CI junto con el código que aprueba.
function repoWaiverLogPath(repoRoot) {
  return path.join(repoRoot, '.tycon', 'runtime-waivers.jsonl');
}

/**
 * Hash de la DECLARACIÓN de un AC no-ejercitable: su `reason` + el test que lo cubre, tal
 * como están en el frontmatter `runtime_not_verifiable` de la story.
 *
 * Es el anclaje CORRECTO de un waiver, y reemplaza al `matrixHash` para lo nuevo. El
 * `matrixHash` pinnea los veredictos + las refs de evidencia de TODOS los ACs — evidencia que
 * vive en `.advisors/` (gitignoreado), así que en otra máquina o en CI no existe, el hash da
 * distinto y el waiver no engancha. Pero lo que el humano aprobó no fue el estado de la
 * evidencia: fue que ESE AC no se puede ejercer corriendo. Eso vive en la story, viaja con el
 * repo y es idéntico en toda máquina. Y se vence exactamente cuando debe: si alguien reescribe
 * la justificación, hay que volver a mirarlo.
 */
function declHashFor(reason, coveredBy) {
  return sha(JSON.stringify([String(reason ?? '').trim(), String(coveredBy ?? '').trim()])).slice(0, 16);
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Contenido canónico de un waiver para el hash-chain (excluye el propio campo `chain`).
// 🔴 `declHashByAc` entra al canónico SÓLO si existe: así las 43 entries ya firmadas con el
// formato viejo siguen verificando bit a bit (agregarlo incondicionalmente rompería la cadena
// entera y dejaría sin efecto todo lo aprobado hasta hoy).
function canonical(e) {
  const base = [e.ts, String(e.story), [...e.acs].sort((a, b) => a - b), e.matrixHash, e.approvedBy || null];
  if (e.declHashByAc !== undefined) {
    base.push(Object.keys(e.declHashByAc).sort((a, b) => Number(a) - Number(b)).map((k) => [Number(k), e.declHashByAc[k]]));
  }
  return JSON.stringify(base);
}

// ¿Hay una terminal interactiva real? open(/dev/tty) es no-bloqueante: falla YA con
// ENXIO si no hay terminal controladora (caso del agente). No hace falta leer nada.
function hasTty() {
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r'); } catch { return false; }
  try { fs.closeSync(fd); } catch { /* ignore */ }
  return true;
}

// Prompt + lectura de UNA línea DESDE /dev/tty (no stdin). Tira si no hay terminal.
function promptTty(message) {
  let wfd;
  try { wfd = fs.openSync('/dev/tty', 'w'); } catch (e) {
    throw new Error('NO_TTY: este comando requiere una terminal interactiva real. El agente no puede ejecutarlo — lo corre el usuario.');
  }
  fs.writeSync(wfd, message);
  fs.closeSync(wfd);

  const rfd = fs.openSync('/dev/tty', 'r'); // ya sabemos que hay tty (el write funcionó)
  const bytes = [];
  const one = Buffer.alloc(1);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let n;
    try { n = fs.readSync(rfd, one, 0, 1, null); } catch { break; }
    if (n === 0) break;
    if (one[0] === 0x0a) break; // \n
    if (one[0] !== 0x0d) bytes.push(one[0]); // ignora \r
  }
  fs.closeSync(rfd);
  return Buffer.from(bytes).toString('utf8').trim();
}

function readRawLines(logPath) {
  return readNumberedLines(logPath).map((l) => l.text);
}

// Las líneas no vacías con su número FÍSICO (contado desde 1), para que un aviso pueda decir «archivo:línea».
// Sin la marca de orden de bytes que agregan algunos editores de Windows: pegada a la primera línea, rompía su
// JSON y, como todo cuelga de ahí, descartaba el registro entero (story 7.17).
function readNumberedLines(logPath) {
  let raw;
  try { raw = fs.readFileSync(logPath || waiverLogPath(), 'utf8'); } catch { return []; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const out = [];
  raw.split('\n').forEach((l, i) => { const text = l.replace(/\r$/, ''); if (text) out.push({ text, line: i + 1 }); });
  return out;
}

// Verifica la cadena de hashes, leída como ÁRBOL (story 7.17). Devuelve
// { ok, entries, brokenAt, total, discarded }:
//   - `entries`: las válidas, en orden del archivo (lo que leían todos los llamadores, sin cambios).
//   - `brokenAt`: índice (entre las líneas no vacías, como siempre) de la primera descartada, o -1.
//   - `discarded`: [{ line, entry|null, motivo }] con la línea FÍSICA desde 1 y el motivo:
//       json                  no es JSON
//       cuelga-de-descartada  su padre es una línea descartada
//       padre-posterior       su padre está más abajo en el archivo
//       sin-padre             ninguna línea ni el vacío dan su chain: la editaron, o su padre ya no está
function verifyChain(logPath) {
  const lines = readNumberedLines(logPath);
  const parsed = lines.map(({ text, line }) => { try { return { e: JSON.parse(text), line }; } catch { return { e: null, line }; } });
  // Una línea que no tiene la forma de una firma se descarta como `json`, nunca hace caer al lector: una sola línea
  // así tumbaba la lectura entera, y con ella todas las firmas del registro (pase adversarial de la 7.17).
  const linkOf = (padre, e) => { try { return sha(padre + canonical(e)).slice(0, 16); } catch { return null; } };
  const tieneForma = (e) => !!e && typeof e === 'object' && Array.isArray(e.acs)
    && (e.declHashByAc === undefined || (e.declHashByAc !== null && typeof e.declHashByAc === 'object'))
    && linkOf('', e) !== null;
  const validChains = new Set();
  const validIdx = new Set();
  const entries = [];
  const pendientes = [];
  parsed.forEach(({ e }, i) => {
    if (!tieneForma(e)) { pendientes.push(i); return; }
    let ok = e.chain === linkOf('', e);
    if (!ok) for (const p of validChains) { if (e.chain === linkOf(p, e)) { ok = true; break; } }
    if (ok) { validChains.add(e.chain); validIdx.add(i); entries.push(e); } else pendientes.push(i);
  });
  // El motivo de cada descartada se busca contra TODAS las líneas (el padre puede estar descartado o más abajo).
  const discarded = pendientes.map((i) => {
    const { e, line } = parsed[i];
    // La entrada leída se conserva aunque no tenga forma de firma: así se sabe de qué story es y el aviso la ve.
    if (!tieneForma(e)) return { line, entry: e && typeof e === 'object' && !Array.isArray(e) ? e : null, motivo: 'json' };
    let motivo = 'sin-padre';
    for (let j = 0; j < parsed.length; j++) {
      const p = parsed[j].e;
      if (j === i || !p || typeof p.chain !== 'string' || e.chain !== linkOf(p.chain, e)) continue;
      motivo = j > i ? 'padre-posterior' : (validIdx.has(j) ? 'sin-padre' : 'cuelga-de-descartada');
      break;
    }
    return { line, entry: e, motivo };
  });
  return { ok: discarded.length === 0, entries, brokenAt: pendientes.length ? pendientes[0] : -1, total: lines.length, discarded };
}

// Escribe un waiver TTY-confirmado con hash-chain. Sólo lo llama el comando marker.js
// runtime-waiver, DESPUÉS de que promptTty() confirmó al humano.
function appendWaiver({ story, acs, matrixHash, approvedBy, nowIso, declHashByAc, logPath, migratedFrom }) {
  const destino = logPath || waiverLogPath();
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  // 🔴 Story 7.17: la firma nueva va SIN padre (raíz). Antes enganchaba con la última línea, y así un revert
  // (la línea sale), un cherry-pick con la unión deduplicada (queda antes que su padre) o una línea rota más
  // arriba la descartaban. El `chain` de una raíz es el hash de su propio contenido: editarla se sigue viendo.
  const prev = '';
  const e = { ts: nowIso, story: String(story), acs: [...acs].sort((a, b) => a - b), matrixHash, approvedBy: approvedBy || null, tty: true };
  if (declHashByAc !== undefined) e.declHashByAc = declHashByAc;
  if (migratedFrom !== undefined) e.migratedFrom = migratedFrom;
  e.chain = sha(prev + canonical(e)).slice(0, 16);
  // Si el archivo quedó sin salto final (recortado a mano en un editor, o una resolución de conflicto), la firma nueva
  // se pegaba a la última línea y se perdían las dos, sin aviso (pase adversarial de la 7.17).
  let sep = '';
  try { const st = fs.statSync(destino); if (st.size > 0) { const fd = fs.openSync(destino, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd); if (b[0] !== 0x0a) sep = '\n'; } } catch { /* no existe todavía: nada que separar */ }
  fs.appendFileSync(destino, sep + JSON.stringify(e) + '\n', 'utf8');
  return e;
}

// Set de ACs waiveados para (story, matrixHash) — SÓLO cuenta una entry válida de la cadena
// (story 7.17: engancha con alguna anterior válida, o es raíz). Un waiver cuyo matrixHash no
// matchea el actual NO cuenta (drift).
/**
 * ACs waiveados para una story. Dos formas de llamarla, a propósito:
 *
 *   waivedAcs(story, 'matrixHash')                              ← firma vieja, sigue viva
 *   waivedAcs(story, { matrixHash, declHashByAc, repoRoot })    ← firma nueva
 *
 * Un AC cuenta como waiveado si hay una entry con cadena INTACTA que lo cubra y que enganche
 * por alguna de las dos vías:
 *   (a) por DECLARACIÓN — `declHashByAc[ac]` de la entry coincide con el de la story HOY.
 *       Es machine-independent: viaja con el repo y vale en cualquier máquina y en CI.
 *   (b) por matrixHash — formato viejo, sólo válido en la máquina donde se aprobó.
 *
 * Se leen DOS logs: el del repo (`.tycon/runtime-waivers.jsonl`, commiteado) y el del home
 * (legacy). Cada uno con su propia cadena — una entrada descartada invalida lo que cuelga de ella
 * EN ESE archivo, no en el otro (story 7.17: la cadena se lee como árbol).
 *
 * `story` es la CLAVE de la story (story 1.17.1, `lib/evidence-key.js`), no el número a secas: con número único son
 * lo mismo, así que las firmas vigentes no cambian; con número repetido es `<tema>__<número>`. Quien computa la
 * matriz pregunta por la clave, y por el número solo únicamente para nombrar las firmas viejas que ya no cuentan.
 */
// La declaración que la entrada ancló para el AC `n`. Las claves se comparan por NÚMERO, como las normaliza
// `canonical()`: si no, renombrar «3» a «03» dejaba el `chain` válido y la entrada caía al camino viejo por
// matrixHash, salteando el anclaje a la declaración (pase adversarial de la 7.17).
function declDeLaEntrada(e, n) {
  if (!e.declHashByAc || typeof e.declHashByAc !== 'object') return undefined;
  for (const k of Object.keys(e.declHashByAc)) if (Number(k) === Number(n)) return e.declHashByAc[k];
  return undefined;
}

function waivedAcs(story, arg2) {
  const opts = typeof arg2 === 'string' || arg2 === undefined ? { matrixHash: arg2 } : arg2;
  const matrixHash = opts.matrixHash;
  const declHashByAc = opts.declHashByAc || {};
  const logs = [];
  if (opts.repoRoot) logs.push(repoWaiverLogPath(opts.repoRoot));
  logs.push(waiverLogPath());

  const out = new Set();
  for (const log of logs) {
    const { entries } = verifyChain(log); // sólo el prefijo con cadena válida
    for (const e of entries) {
      if (String(e.story) !== String(story)) continue;
      const porMatrix = matrixHash !== undefined && e.matrixHash === matrixHash;
      for (const n of e.acs) {
        const declEntry = declDeLaEntrada(e, n);
        if (declEntry !== undefined) {
          // 🔴 La entry declara anclaje por justificación → ÉSE manda, y el matrixHash NO lo
          // rescata. Si no fuera así, en la máquina donde se aprobó (donde el matrixHash sigue
          // matcheando) reescribir la razón no vencería nada — que es justo lo que el anclaje
          // nuevo existe para lograr.
          if (declHashByAc[n] !== undefined && declEntry === declHashByAc[n]) out.add(n);
          continue;
        }
        if (porMatrix) out.add(n); // entry legacy (sin declaración): sigue valiendo como antes
      }
    }
  }
  return out;
}

/**
 * Las firmas DESCARTADAS de una story (story 7.17) — lo que la matriz tiene que NOMBRAR en vez de decir
 * «esperan waiver» a secas. Mismos dos registros y mismas opciones que `waivedAcs`. Devuelve:
 *   - `acs`:   [{ ac, log, line, approvedBy, ts, motivo }] — cada AC de una firma descartada que HOY
 *              engancharía (por la declaración de hoy, o por matrixHash si la entrada es legacy). Una firma
 *              de una declaración vieja no está: volver a firmarla no aprobaría nada.
 *   - `lines`: [{ log, line, motivo }] — toda línea descartada de esta story, para el aviso de cadena. Las de
 *              otras stories no: el registro sólo crece, y un aviso global quedaría prendido para siempre.
 */
function discardedFor(story, arg2) {
  const opts = typeof arg2 === 'string' || arg2 === undefined ? { matrixHash: arg2 } : arg2;
  const declHashByAc = opts.declHashByAc || {};
  const logs = [];
  if (opts.repoRoot) logs.push(repoWaiverLogPath(opts.repoRoot));
  logs.push(waiverLogPath());
  const acs = [];
  const lines = [];
  for (const log of logs) {
    for (const d of verifyChain(log).discarded) {
      const e = d.entry;
      if (!e || String(e.story) !== String(story)) continue;
      const acsDe = Array.isArray(e.acs) ? e.acs : [];
      const antes = acs.length;
      for (const n of acsDe) {
        const declEntry = declDeLaEntrada(e, n);
        const engancharia = declEntry !== undefined
          ? declHashByAc[n] !== undefined && declEntry === declHashByAc[n]
          : opts.matrixHash !== undefined && e.matrixHash === opts.matrixHash;
        if (engancharia) acs.push({ ac: n, log, line: d.line, approvedBy: e.approvedBy || null, ts: e.ts || null, motivo: d.motivo });
      }
      // El registro de la HOME lo comparten todos los repos de la máquina, y la entrada no dice de cuál es: ahí una
      // línea cuenta para el aviso sólo si engancharía con esta story. La del repo es de este repo.
      const esDelRepo = opts.repoRoot && log === repoWaiverLogPath(opts.repoRoot);
      if (esDelRepo || acs.length > antes) lines.push({ log, line: d.line, motivo: d.motivo });
    }
  }
  return { acs, lines };
}

module.exports = {
  hasTty, promptTty, appendWaiver, waivedAcs, verifyChain, waiverLogPath, repoWaiverLogPath, declHashFor, discardedFor,
};
