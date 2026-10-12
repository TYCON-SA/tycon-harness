#!/usr/bin/env node
/**
 * pr-one-per-repo-guard.js — freno: no disparar dos construcciones del mismo pipeline al mismo tiempo.
 *
 * 🔴 POR QUÉ EXISTE (2026-09-03). En una sola jornada la cola de Azure se llenó CUATRO veces por la
 * misma causa, con dos variantes:
 *   · empujar de a poco a la misma rama (cada empujón encola una corrida y Azure no cancela la
 *     anterior), y
 *   · abrir una tanda de pull requests y después OTRA sobre los mismos repos, en vez de juntar los
 *     dos cambios en uno.
 * Las dos veces se prometió no repetirlo y se repitió por la otra puerta. Una regla que hay que
 * recordar no es un control: éste no depende de que nadie se acuerde.
 *
 * QUÉ HACE. Antes de que `az repos pr create` se ejecute, pregunta si ese repositorio ya tiene un
 * pull request abierto CON SU CONSTRUCCIÓN EN CURSO. Sólo entonces corta, y explica qué hacer.
 *
 * 🔴 QUÉ NO HACE, y es la corrección más importante: NO impide tener dos pull requests abiertos en
 * el mismo repo. Dos personas trabajando en cosas distintas del mismo repositorio es lo normal en un
 * equipo, y un freno que estorba el trabajo legítimo se apaga — y con él se pierde el caso que sí
 * importa. La primera versión de este hook, escrita el mismo día, bloqueaba ante CUALQUIER pull
 * request abierto; lo corrigió una pregunta del dev: "¿eso significa que ningún dev va a poder hacer
 * más de un PR por repo?". Sí, significaba eso, y estaba mal.
 *
 * 🔴 FALLA HACIA DEJAR PASAR, a propósito. Si no puede preguntar —sin credencial, sin `az`, la API
 * no contesta— NO bloquea: un freno que corta el trabajo cuando no pudo mirar se apaga en una tarde,
 * y con él se pierde el caso donde sí servía. Lo que no puede hacer es callarse: cuando no pudo
 * mirar, lo dice.
 *
 * Salida: exit 2 bloquea (el comando no corre) · exit 0 deja pasar.
 * Encender (para una tanda de cambios en varios repos): TYCON_PR_ONE_PER_REPO=1
 * Por default está APAGADO: en el día a día de un dev no tiene que estorbar.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

// 🔴 SE LEE LA ENTRADA ANTES DE DECIDIR NADA, incluso para apagarse. Salir sin drenar stdin le
// deja una tubería rota a quien escribe, y su comando falla por una razón que no tiene nada que ver
// con lo que este freno mira. Lo cazó su propio caso del apagado.
let payload; try { payload = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }

// 🔴 APAGADO POR DEFAULT (2026-09-03, segunda corrección del mismo día). Esto NO es para el día a
// día de nadie: en el trabajo normal, dos pull requests con sus construcciones corriendo en el mismo
// repo es perfectamente sano, y un freno que estorba eso se apaga y se lleva puesto el caso que sí
// importa. El caso que sí importa es el trabajo de MUCHOS REPOS A LA VEZ —un cambio del arnés que
// toca los cinco productos, una tanda de arreglos de CI— donde abrir tandas encima de tandas llena
// la cola de Azure de la organización entera. Eso pasó cuatro veces el 2026-09-03.
//
// Entonces: se enciende a propósito para ese tipo de trabajo, con TYCON_PR_ONE_PER_REPO=1, y para
// todos los demás no existe. La primera versión venía prendida y bloqueaba ante CUALQUIER pull
// request abierto; la corrigieron dos preguntas seguidas del dev, y las dos tenían razón.
if (require('../lib/legacy-names.js').readEnv('TYCON_PR_ONE_PER_REPO', { where: 'scripts/hooks/pr-one-per-repo-guard.js' }) !== '1') process.exit(0);
let cmd = '';
try { cmd = ((JSON.parse(payload || '{}').tool_input) || {}).command || ''; } catch { process.exit(0); }

// Sólo mira la creación de un pull request. Actualizar, listar o abandonar no se tocan.
// 🔴 Se lee con el lector COMPARTIDO (`lib/az-pr.js`), no con un regex propio (AZ-PR-PARSER-UNICO-1,
// 2026-09-06). El lector casero no entendía la forma `--org=…`, ni `--project="…"`, ni las formas
// cortas `-p/-r/-s/-t` (las comillas con espacios SÍ las leía): caía en «sin datos» y salía 0 EN
// SILENCIO — verde sin haber mirado. El compartido nació
// justamente porque su primera versión, un regex de una línea, falló doce veces en un día.
const az = require('../lib/az-pr.js');
const constancia = require('../lib/guard-record.js');
if (!az.pareceAzPr(cmd)) process.exit(0);
// 🔴 TODOS los `pr create` de la cadena, no el primero (revisión adversarial 2026-09-06): con
// `az … create -r R1 … && az … create -r R2 …` sólo se miraba R1. Es el patrón que ya usa
// pr-auto-complete-guard.js, y el motivo por el que nació la lib.
const creates = az.segmentos(cmd).filter((seg) => az.verboDePr(seg) === 'create');
if (!creates.length) process.exit(0);
let evCwd = ''; try { evCwd = String(JSON.parse(payload || '{}').cwd || ''); } catch { /* sin cwd */ }

// 🔴 Sin org/proyecto/repo en el comando NO se renuncia a preguntar (2026-09-06): más de la mitad
// de los `az repos pr create` reales del equipo (28 de 52 en las transcripciones) van sin `--org`,
// porque el CLAUDE.md recomienda `az devops configure --defaults` — y `az` resuelve por esos
// defaults y por el remote del cwd exactamente igual para el `list` que para el `create`. Se le
// pasan las MISMAS banderas que trae el comando, y que `az` resuelva lo que falta.
let noPudeMirar = false;   // ¿alguna consulta falló? (story 2.6: «no miré» ≠ «está bien»)
const bloqueos = [];
for (const segCreate of creates) {
  const org = az.flagDe(segCreate, 'org') || az.flagDe(segCreate, 'organization');
  const proyecto = az.flagDe(segCreate, 'project', 'p');
  const repo = az.flagDe(segCreate, 'repository', 'r');
  const rama = az.flagDe(segCreate, 'source-branch', 's');
  const donde = [proyecto, repo].filter(Boolean).join('/') || '(org/proyecto/repo por defaults de az)';
  const args = ['repos', 'pr', 'list', '--status', 'active', '-o', 'json'];
  if (org) args.push('--org', org);
  if (proyecto) args.push('--project', proyecto);
  if (repo) args.push('--repository', repo);

  let abiertos;
  try {
    const salida = execFileSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, cwd: evCwd || process.cwd() });
    abiertos = JSON.parse(salida || '[]');
  } catch (e) {
    // No pudo preguntar: NO bloquea, pero lo dice — "no miré" no puede parecer "está bien".
    console.error(`[pr-uno-por-repo] no pude consultar los pull requests de ${donde} (${(e.message || '').slice(0, 80)}). No bloqueo, pero NO verifiqué que no haya otro abierto.`);
    noPudeMirar = true;
    continue;
  }
  const enCurso = revisar(abiertos, org, rama);
  if (enCurso.length) bloqueos.push({ donde, enCurso });
}
if (!bloqueos.length) {
  // Creaba un pull request y no había otro abierto: `paso` (story 2.6).
  // 🔴 Pero si NO se pudo preguntar, eso no es «verifiqué y está bien»: es «no miré», y anotarlo
  //    como paso mezcla las dos cosas — exactamente la distinción que esta story existe para no
  //    perder (revisor de fallos silenciosos, 2026-09-16). Sin decisión, no hay línea.
  if (!noPudeMirar) constancia.anotar({ freno: 'pr-uno-por-repo', regla: 'pr-duplicado', veredicto: 'paso', cmd });
  process.exit(0);
}
bloquear(bloqueos);

function revisar(abiertos, org, rama) {

// Uno de la MISMA rama es este mismo pull request re-creado: no es el caso que este freno cuida.
const otros = (abiertos || []).filter((p) => !rama || p.sourceRefName !== `refs/heads/${rama}`);
if (!otros.length) return [];

// 🔴 LO QUE MOLESTA NO SON DOS PULL REQUESTS: SON DOS CORRIDAS A LA VEZ (corregido el 2026-09-03,
// el mismo día, por una pregunta del dev). La primera versión de este freno bloqueaba ante
// CUALQUIER pull request abierto en el repo — y eso le impide a dos personas trabajar en cosas
// distintas del mismo repositorio, que es lo normal en un equipo. Un freno que estorba el trabajo
// legítimo se apaga, y con él se pierde el caso que sí importa.
//
// Lo que llena la cola de Azure es que el MISMO pipeline corra dos veces en paralelo. Si el pull
// request que ya está abierto tiene su construcción terminada, abrir otro no le molesta a nadie.
// Entonces: se bloquea sólo si alguno de los abiertos tiene una construcción EN CURSO.
const enCurso = [];
for (const pr of otros) {
  let ev;
  try {
    ev = JSON.parse(execFileSync('az', [
      'repos', 'pr', 'policy', 'list', '--org', org, '--id', String(pr.pullRequestId), '-o', 'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }) || '[]');
  } catch (e) {
    // No pudo mirar ESTE: no se cuenta como en curso, y se dice. Falla hacia dejar trabajar.
    console.error(`[pr-uno-por-repo] no pude ver el estado del PR ${pr.pullRequestId}: no lo cuento.`);
    continue;
  }
  const corriendo = (ev || []).some((x) => {
    const tipo = ((x.configuration || {}).type || {}).displayName || '';
    return /build/i.test(tipo) && ['queued', 'running'].includes(String(x.status || '').toLowerCase());
  });
  if (corriendo) enCurso.push(pr);
}
return enCurso;
}

function bloquear(bloqueos) {
const cabeceras = bloqueos.map(({ donde, enCurso }) => `🔴 ${donde} YA TIENE ${enCurso.length} pull request CONSTRUYENDO:\n\n` +
  enCurso.map((p) => `  · PR ${p.pullRequestId} — ${p.title} (rama ${String(p.sourceRefName || '').replace('refs/heads/', '')})`).join('\n')).join('\n\n');
console.error(`${cabeceras}

Abrir otro AHORA encola una segunda corrida del mismo pipeline en paralelo, y así se llena la cola
de Azure — pasó cuatro veces el 2026-09-03. Dos salidas:

  1. Esperá a que esa construcción termine (suele ser cuestión de minutos) y abrí el tuyo.
  2. Si tu cambio va junto con el que ya está, sumáselo: commit en su rama y push.

Este freno NO te impide tener dos pull requests abiertos en el mismo repo — eso es normal y no
molesta a nadie. Sólo evita disparar dos construcciones del mismo pipeline al mismo tiempo.

Este freno está encendido porque alguien puso TYCON_PR_ONE_PER_REPO=1 para una tanda de cambios en
varios repos. Para saltearlo en un caso puntual, corré el comando sin esa variable.`);
constancia.anotar({ freno: 'pr-uno-por-repo', regla: 'pr-duplicado', veredicto: 'bloqueo', cmd });
process.exit(2);
}
