#!/usr/bin/env node
/**
 * pr-auto-complete-guard.js — freno: un pull request a main, armado a mano y sin auto-complete, no sale.
 *
 * 🔴 POR QUÉ EXISTE. Un agente con un fix listo, en un repo que declara `merge.mode: pr` y con el skill
 * `tycon-merge-to-main` que sabe crear el pull request como corresponde, puede abrir el PR con
 * `az repos pr create` suelto: sin `--auto-complete true` (el PR
 * queda abierto para siempre, nadie lo completa) y sin `--squash false` (con squash los commits
 * desaparecen de main y las notas de versión, que listan los commits desde la versión publicada,
 * colapsan a una línea). El skill hace lo correcto; lo que hace falta es algo que OBLIGUE a pasar por él,
 * porque una regla escrita («usá el skill») no alcanza.
 *
 * QUÉ MIRA. Al CREAR, sólo los pull requests **a main/master**: el skill es el camino de esa rama,
 * y frenar un `feature → dev` con el consejo de usarlo sería un consejo equivocado — un freno que
 * estorba el trabajo legítimo se apaga, y con él el caso que sí importa.
 * Al ACTUALIZAR no se puede acotar igual: `az repos pr update` identifica el PR por número y **no
 * dice a qué rama apunta**, así que se mira siempre (decisión fail-closed, con el escape a mano).
 * Por eso el mensaje del update no afirma "a main" — decirlo sería falso.
 *
 * QUÉ HACE. Para cada `az repos pr create` del comando —cada uno con SUS banderas, aunque vengan
 * varios encadenados— exige `--auto-complete true` y `--squash false` explícitos (sin el segundo la
 * estrategia la decide la política de la rama). Cierra además las otras dos puertas al mismo
 * resultado: un `az repos pr update` que APAGUE el auto-complete o PRENDA el squash, y el que
 * PUBLIQUE un borrador (`--draft false`) sin llevar las dos banderas. Mira sólo el texto del
 * comando —nada de red— con el lector de scripts/lib/az-pr.js.
 *
 * QUÉ NO HACE. Un borrador recién creado no se toca (no se completa solo por definición) y lo dice.
 * `--help`, listar, mostrar y abandonar tampoco. Salida para el caso puntual —incluido el legítimo
 * de apagar el auto-complete para retener una entrega—: `TYCON_PR_BY_HAND=1` como prefijo PEGADO al
 * comando, nunca desde el entorno (exportarla en el rc la volvería permanente y silenciosa); deja
 * constancia en stderr y en el mismo `bypass.log` que ya usa el freno de tests.
 *
 * Salida: exit 2 bloquea (el comando no corre) · exit 0 deja pasar.
 * Apagar del todo: TYCON_PR_AUTO_COMPLETE_GUARD=0 (la variable tuvo un nombre en castellano, que sigue
 * valiendo hasta el retiro del mapa de renombres).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const az = require('../lib/az-pr.js');
const constanciaFreno = require('../lib/guard-record.js');

const TAG = '[pr-sin-auto-complete]';

// 🔴 SE LEE LA ENTRADA ANTES DE DECIDIR NADA, incluso para apagarse (misma lección que
// pr-one-per-repo-guard.js: salir sin drenar stdin rompe la tubería de quien escribe).
let payload;
try { payload = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
if (require('../lib/legacy-names.js').readEnv('TYCON_PR_AUTO_COMPLETE_GUARD', { where: 'scripts/hooks/pr-auto-complete-guard.js' }) === '0') process.exit(0);

let cmd = '';
try {
  cmd = ((JSON.parse(payload || '{}').tool_input) || {}).command || '';
} catch {
  // No pudo leer: no frena —un freno que rompe la sesión por un bug propio se apaga— pero lo dice.
  console.error(`${TAG} no pude leer la entrada del hook: no freno, pero tampoco miré.`);
  process.exit(0);
}
if (typeof cmd !== 'string' || !az.pareceAzPr(cmd)) process.exit(0);

function constancia(tipo, texto, comando) {
  console.error(`${TAG} ${texto}`);
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'bypass.log'),
      JSON.stringify({ ts: new Date().toISOString(), type: tipo, command: String(comando).slice(0, 500) }) + '\n');
  } catch { /* la constancia en stderr ya salió */ }
}

let huboEscape = false;   // ¿ya se anotó el escape de este comando?
// ¿este freno llegó a JUZGAR algún segmento? Un `--help`, un pull request que va a `dev` o un
// borrador son cosas que él mismo declara fuera de su alcance: anotarles un `paso` mete en su
// denominador comandos que nunca juzga.
let huboJuicio = false;
const problemas = [];
for (const seg of az.segmentos(cmd)) {
  if (az.pideAyuda(seg)) continue;

  // Código adentro de una cadena que va a un intérprete: no se puede juzgar lo que se ejecuta.
  if (az.pasaCodigoAUnInterprete(seg)) {
    problemas.push({ seg, verbo: 'interprete', faltas: ['el comando viaja adentro de una cadena que ejecuta otro intérprete, así que no puedo leer sus banderas — y lo que no pude mirar no está aprobado'] });
    huboJuicio = true;
    continue;
  }

  const verbo = az.verboDePr(seg);
  if (verbo !== 'create' && verbo !== 'update') continue;

  // La regla vive en `faltasDe` (scripts/lib/az-pr.js): la misma que lee la revisión nocturna de las ejecuciones.
  // Se juzga ANTES de mirar el prefijo: un prefijo puesto sobre un tramo que pasaría igual no es un salteo, y anotarlo
  // llenaba el registro de salteos que no eran.
  const { juzgado, borrador, faltas } = az.faltasDe(seg);
  let sobra = false;
  if (az.tieneEscape(seg)) {
    if (faltas.length) {
      constancia('PR_A_MANO', `TYCON_PR_BY_HAND=1: dejo armar el PR a mano. Queda dicho.`, az.textoDe(seg));
      huboEscape = true;
      continue;
    }
    sobra = true;
  }
  // Una línea por tramo: un borrador con el prefijo dice las dos cosas en la misma línea.
  const SOBRA = 'TYCON_PR_BY_HAND=1: el prefijo sobra, este pedido pasa igual sin él; no lo anoto como salteo.';
  if (borrador) {
    console.error(`${TAG} ${sobra ? SOBRA + ' ' : ''}borrador (--draft): no lo freno ahora, un borrador no se completa solo. Al publicarlo (--draft false) van a hacer falta --auto-complete true y --squash false.`);
    continue;
  }
  if (sobra) console.error(`${TAG} ${SOBRA}`);
  if (!juzgado) continue;
  huboJuicio = true;
  if (faltas.length) problemas.push({ seg, verbo, faltas });
}

// 🔴 UNA DECISIÓN, UNA LÍNEA — y el veredicto es el que tuvo EL COMANDO, no cada segmento.
// Un comando con dos `pr create` —uno salteado y otro mal armado— escribiría `escape` Y `bloqueo`: dos
// decisiones donde hubo una, y el `escape` quedaría registrado como si algo hubiera pasado cuando
// el comando entero murió en 2 y no corrió nada. Por eso la constancia se escribe ACÁ, una sola vez,
// cuando ya se sabe qué decidió: si frenó es `bloqueo`, si no frenó pero hubo escape es `escape`, y si
// no frenó ni hubo escape es `paso`.
// Sólo se anota si el freno TUVO algo que decidir: juzgó un segmento, o se lo saltearon con el
// escape declarado. Un `--help`, un pull request que va a `dev` o un borrador no son decisiones.
if (huboJuicio || huboEscape) {
  constanciaFreno.anotar({
    freno: 'pr-sin-auto-complete', regla: 'sin-auto-complete',
    veredicto: problemas.length ? 'bloqueo' : (huboEscape ? 'escape' : 'paso'), cmd,
  });
}
if (!problemas.length) process.exit(0);

const rama = problemas.map((p) => (p.verbo === 'create' ? az.flagDe(p.seg, 'source-branch', 's') : null)).find(Boolean) || '<rama>';
const detalle = problemas.map((p) => {
  const cabeza = az.textoDe(p.seg).replace(/\s+/g, ' ').slice(0, 110);
  const rotulo = p.verbo === 'create' ? 'CREAR' : (p.verbo === 'update' ? 'ACTUALIZAR' : 'NO PUEDO LEER');
  return `  ${rotulo}: ${cabeza}${cabeza.length >= 110 ? '…' : ''}\n${p.faltas.map((f) => `    · ${f}`).join('\n')}`;
}).join('\n');

const soloUpdates = problemas.every((p) => p.verbo === 'update');
// Las dos formas legítimas que el freno veía frenadas una y otra vez: el pedido que espera una aprobación (se crea en
// borrador) y el que se retiene apagando la entrada automática (el prefijo es su salida).
const esperaAprobacion = problemas.some((p) => p.verbo === 'create' && !az.esCierto(az.flagDe(p.seg, 'auto-complete')));
const retiene = problemas.some((p) => p.verbo === 'update' && az.esFalso(az.flagDe(p.seg, 'auto-complete')));
const formas = [
  esperaAprobacion ? 'Si el pedido espera una aprobación, crealo en borrador (`--draft true`) y, cuando se apruebe, publicalo con `--draft false --auto-complete true --squash false`.' : null,
  retiene ? 'Para retener una entrega ya encolada (apagar la entrada automática), el prefijo es la salida: `TYCON_PR_BY_HAND=1` pegado a ese mismo `update`.' : null,
].filter(Boolean);
console.error(`🔴 Este pull request se está armando A MANO y no va a quedar bien${soloUpdates ? '' : ' (va a main)'}:
${detalle}

En los repos del equipo un pull request a main lo crea el skill de merge, que además del PR corre
el gate de build y tests y arma el mensaje que queda como descripción:

  Skill(skill="tycon-merge-to-main", args="source=${rama} target=main")

Si de verdad tiene que ir a mano, el comando lleva las dos banderas, explícitas:

  az repos pr create ... --auto-complete true --squash false
${formas.length ? `\n${formas.join('\n')}\n` : ''}
Un borrador recién creado no se toca (sí al publicarlo). Para saltear este freno una sola vez, a
propósito —por ejemplo para retener una entrega apagando el auto-complete—, el prefijo va PEGADO al
comando; desde el entorno no vale, porque exportado quedaría permanente y en silencio:

  TYCON_PR_BY_HAND=1 az repos pr ...

Caso que lo motivó: un pull request del backend de un producto, 2026-09-03 — el skill sabía hacerlo bien y
nada obligaba a usarlo.`);
process.exit(2);
