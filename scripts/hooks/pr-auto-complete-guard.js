#!/usr/bin/env node
/**
 * pr-auto-complete-guard.js — freno: un pull request a main, armado a mano y sin auto-complete, no sale.
 *
 * 🔴 POR QUÉ EXISTE (2026-09-03, un pull request del backend de un producto del equipo). El agente tenía listo un fix,
 * el repo declara `merge.mode: pr` y el skill `tycon-merge-to-main` sabe crear el pull request como
 * corresponde. Igual abrió el PR con `az repos pr create` suelto: sin `--auto-complete true` (el PR
 * queda abierto para siempre, nadie lo completa) y sin `--squash false` (con squash los commits
 * desaparecen de main y las notas de versión, que listan los commits desde la versión publicada,
 * colapsan a una línea). Lo vio el dev en la pantalla de Azure, al lado de otro PR que sí lo tenía.
 * El skill hacía lo correcto; lo que faltaba era algo que OBLIGARA a pasar por él. Una regla escrita
 * («usá el skill») es exactamente lo que falló ese día.
 *
 * QUÉ MIRA. Al CREAR, sólo los pull requests **a main/master**: el skill es el camino de esa rama,
 * y frenar un `feature → dev` con el consejo de usarlo sería un consejo equivocado — un freno que
 * estorba el trabajo legítimo se apaga, y con él el caso que sí importa (2ª revisión adversarial).
 * Al ACTUALIZAR no se puede acotar igual: `az repos pr update` identifica el PR por número y **no
 * dice a qué rama apunta**, así que se mira siempre (decisión fail-closed, con el escape a mano).
 * Por eso el mensaje del update no afirma "a main" — decirlo era falso (3ª revisión adversarial).
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
 * Apagar del todo: TYCON_PR_AUTO_COMPLETE_GUARD=0 (hasta la story 8.9 la variable tenía un nombre en castellano, que sigue
 * valiendo hasta el retiro del mapa de renombres).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const az = require('../lib/az-pr.js');
const constanciaFreno = require('../lib/guard-record.js');

const TAG = '[pr-sin-auto-complete]';
const ROMPE_SQUASH = 'los commits desaparecen de main y las notas de versión colapsan a una línea';
const A_MAIN = /^(?:refs\/heads\/)?(?:main|master)$/i;

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

let huboEscape = false;   // ¿ya se anotó el escape de este comando? (story 2.6)
// ¿este freno llegó a JUZGAR algún segmento? Un `--help`, un pull request que va a `dev` o un
// borrador son cosas que él mismo declara fuera de su alcance: anotarles un `paso` mete en su
// denominador comandos que nunca juzga (revisor spec-first, vuelta 2, 2026-09-16).
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

  if (az.tieneEscape(seg)) {
    constancia('PR_A_MANO', `TYCON_PR_BY_HAND=1: dejo armar el PR a mano. Queda dicho.`, az.textoDe(seg));
    huboEscape = true;
    continue;
  }

  const autoComplete = az.flagDe(seg, 'auto-complete');
  const squash = az.flagDe(seg, 'squash');
  const draft = az.flagDe(seg, 'draft');
  const destino = az.flagDe(seg, 'target-branch', 't');

  const faltas = [];
  if (verbo === 'create') {
    // Sólo los que van a main: el skill es el camino de esa rama (ver cabecera).
    if (destino !== null && !A_MAIN.test(destino)) continue;
    if (az.esCierto(draft)) {
      console.error(`${TAG} borrador (--draft): no lo freno ahora, un borrador no se completa solo. Al publicarlo (--draft false) van a hacer falta --auto-complete true y --squash false.`);
      continue;
    }
    huboJuicio = true;
    if (!az.esCierto(autoComplete)) faltas.push('sin `--auto-complete true`: el PR queda abierto para siempre, nadie lo completa');
    if (squash === null) faltas.push(`sin \`--squash false\` explícito: la estrategia la decide la política de la rama, y si es squash ${ROMPE_SQUASH}`);
    else if (!az.esFalso(squash)) faltas.push(`con \`--squash ${squash}\`: ${ROMPE_SQUASH}`);
  } else {
    huboJuicio = true;
    if (az.esFalso(autoComplete)) faltas.push('apaga el auto-complete de un PR ya creado: queda abierto para siempre');
    if (az.esCierto(squash)) faltas.push(`prende el squash de un PR ya creado: ${ROMPE_SQUASH}`);
    // Publicar un borrador es CREARLO de verdad: la tercera puerta al mismo resultado.
    if (az.esFalso(draft)) {
      if (!az.esCierto(autoComplete)) faltas.push('publica un borrador (`--draft false`) sin `--auto-complete true`: queda un PR normal que nadie completa');
      if (squash === null || !az.esFalso(squash)) faltas.push('publica un borrador sin `--squash false` explícito: la estrategia la decide la política de la rama');
    }
  }
  if (faltas.length) problemas.push({ seg, verbo, faltas });
}

// 🔴 UNA DECISIÓN, UNA LÍNEA — y el veredicto es el que tuvo EL COMANDO, no cada segmento (story 2.6).
// Un comando con dos `pr create` —uno salteado y otro mal armado— escribía `escape` Y `bloqueo`: dos
// decisiones donde hubo una, y encima el `escape` quedaba registrado como si algo hubiera pasado cuando
// el comando entero murió en 2 y no corrió nada. Por eso la constancia se escribe ACÁ, una sola vez,
// cuando ya se sabe qué decidió: si frenó es `bloqueo`, si no frenó pero hubo escape es `escape`, y si
// no frenó ni hubo escape es `paso` (revisor de fallos silenciosos, vuelta 2, 2026-09-16).
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
console.error(`🔴 Este pull request se está armando A MANO y no va a quedar bien${soloUpdates ? '' : ' (va a main)'}:
${detalle}

En los repos del equipo un pull request a main lo crea el skill de merge, que además del PR corre
el gate de build y tests y arma el mensaje que queda como descripción:

  Skill(skill="tycon-merge-to-main", args="source=${rama} target=main")

Si de verdad tiene que ir a mano, el comando lleva las dos banderas, explícitas:

  az repos pr create ... --auto-complete true --squash false

Un borrador recién creado no se toca (sí al publicarlo). Para saltear este freno una sola vez, a
propósito —por ejemplo para retener una entrega apagando el auto-complete—, el prefijo va PEGADO al
comando; desde el entorno no vale, porque exportado quedaría permanente y en silencio:

  TYCON_PR_BY_HAND=1 az repos pr ...

Caso que lo motivó: un pull request del backend de un producto, 2026-09-03 — el skill sabía hacerlo bien y
nada obligaba a usarlo.`);
process.exit(2);
