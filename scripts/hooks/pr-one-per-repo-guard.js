#!/usr/bin/env node
/**
 * pr-one-per-repo-guard.js — freno: no disparar dos construcciones del mismo pipeline al mismo tiempo.
 *
 * 🔴 POR QUÉ EXISTE. La cola de Azure se llena por una misma causa, con dos variantes:
 *   · empujar de a poco a la misma rama (cada empujón encola una corrida y Azure no cancela la
 *     anterior), y
 *   · abrir una tanda de pull requests y después OTRA sobre los mismos repos, en vez de juntar los
 *     dos cambios en uno.
 * Una regla que hay que recordar no es un control: éste no depende de que nadie se acuerde.
 *
 * QUÉ HACE. Antes de que `az repos pr create` se ejecute, pregunta si ese repositorio ya tiene un
 * pull request abierto CON SU CONSTRUCCIÓN EN CURSO. Sólo entonces corta, y explica qué hacer.
 *
 * 🔴 QUÉ NO HACE, y es lo más importante: NO impide tener dos pull requests abiertos en
 * el mismo repo. Dos personas trabajando en cosas distintas del mismo repositorio es lo normal en un
 * equipo, y un freno que estorba el trabajo legítimo se apaga — y con él se pierde el caso que sí
 * importa. Bloquear ante CUALQUIER pull
 * request abierto impediría que un dev haga más de un PR por repo.
 *
 * 🔴 FALLA HACIA DEJAR PASAR, a propósito. Si no puede preguntar —sin credencial, sin `az`, la API
 * no contesta— NO bloquea: un freno que corta el trabajo cuando no pudo mirar se apaga en una tarde,
 * y con él se pierde el caso donde sí servía. Lo que no puede hacer es callarse: cuando no pudo
 * mirar, lo dice.
 *
 * Salida: exit 2 bloquea (el comando no corre) · exit 0 deja pasar.
 * Encender (para una tanda de cambios en varios repos): TYCON_PR_ONE_PER_REPO=1 en una máquina, o
 * `switches.pr_one_per_repo: "on"` en el perfil del equipo para todas (la variable puesta gana).
 * Por default está APAGADO: en el día a día de un dev no tiene que estorbar.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

// 🔴 SE LEE LA ENTRADA ANTES DE DECIDIR NADA, incluso para apagarse. Salir sin drenar stdin le
// deja una tubería rota a quien escribe, y su comando falla por una razón que no tiene nada que ver
// con lo que este freno mira.
let payload; try { payload = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }

// 🔴 APAGADO POR DEFAULT. Esto NO es para el día a
// día de nadie: en el trabajo normal, dos pull requests con sus construcciones corriendo en el mismo
// repo es perfectamente sano, y un freno que estorba eso se apaga y se lleva puesto el caso que sí
// importa. El caso que sí importa es el trabajo de MUCHOS REPOS A LA VEZ —un cambio del arnés que
// toca los cinco productos, una tanda de arreglos de CI— donde abrir tandas encima de tandas llena
// la cola de Azure de la organización entera.
//
// Entonces: se enciende a propósito para ese tipo de trabajo, con TYCON_PR_ONE_PER_REPO=1 en una máquina,
// o para toda la organización mientras dure esa tanda (`switches.pr_one_per_repo: "on"` del perfil, desde
// el sitio). Para todos los demás no existe. Prendido por defecto bloquearía ante CUALQUIER pull request.
// La variable de la máquina, puesta con cualquier valor, gana: `1` lo enciende y otro valor lo apaga en esa
// máquina. Sin variable, manda el perfil; con la configuración rota, queda apagado como de fábrica y se avisa.
const varOnePerRepo = require('../lib/legacy-names.js').readEnv('TYCON_PR_ONE_PER_REPO', { where: 'scripts/hooks/pr-one-per-repo-guard.js' });
let encendidoPorLaOrganizacion = false;
if (varOnePerRepo === undefined || varOnePerRepo === '') {
  try {
    const st = require('../lib/tycon-config.js').switchState('pr_one_per_repo');
    if (st.warning) process.stderr.write(`${st.warning}\n`);
    encendidoPorLaOrganizacion = st.value === 'on';
  } catch { encendidoPorLaOrganizacion = false; }
}
if (varOnePerRepo !== '1' && !encendidoPorLaOrganizacion) process.exit(0);
let cmd = '';
try { cmd = ((JSON.parse(payload || '{}').tool_input) || {}).command || ''; } catch { process.exit(0); }

// Sólo mira la creación de un pull request. Actualizar, listar o abandonar no se tocan.
// 🔴 Se lee con el lector COMPARTIDO (`lib/az-pr.js`), no con un regex propio. Un lector
// casero que no entienda la forma `--org=…`, ni `--project="…"`, ni las formas cortas `-p/-r/-s/-t`
// cae en «sin datos» y sale 0 EN SILENCIO — verde sin haber mirado. El compartido existe
// porque un regex de una línea falla con facilidad.
const az = require('../lib/az-pr.js');
const constancia = require('../lib/guard-record.js');
if (!az.pareceAzPr(cmd)) process.exit(0);
// 🔴 TODOS los `pr create` de la cadena, no el primero: con
// `az … create -r R1 … && az … create -r R2 …` sólo se miraría R1. Es el patrón que ya usa
// pr-auto-complete-guard.js.
const creates = az.segmentos(cmd).filter((seg) => az.verboDePr(seg) === 'create');
if (!creates.length) process.exit(0);
let evCwd = ''; try { evCwd = String(JSON.parse(payload || '{}').cwd || ''); } catch { /* sin cwd */ }

// 🔴 Sin org/proyecto/repo en el comando NO se renuncia a preguntar: más de la mitad
// de los `az repos pr create` reales del equipo van sin `--org`,
// porque el CLAUDE.md recomienda `az devops configure --defaults` — y `az` resuelve por esos
// defaults y por el remote del cwd exactamente igual para el `list` que para el `create`. Se le
// pasan las MISMAS banderas que trae el comando, y que `az` resuelva lo que falta.
let noPudeMirar = false;   // ¿alguna consulta falló? («no miré» ≠ «está bien»)
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
  // Creaba un pull request y no había otro abierto: `paso`.
  // 🔴 Pero si NO se pudo preguntar, eso no es «verifiqué y está bien»: es «no miré», y anotarlo
  //    como paso mezcla las dos cosas. Sin decisión, no hay línea.
  if (!noPudeMirar) constancia.anotar({ freno: 'pr-uno-por-repo', regla: 'pr-duplicado', veredicto: 'paso', cmd });
  process.exit(0);
}
bloquear(bloqueos);

function revisar(abiertos, org, rama) {

// Uno de la MISMA rama es este mismo pull request re-creado: no es el caso que este freno cuida.
const otros = (abiertos || []).filter((p) => !rama || p.sourceRefName !== `refs/heads/${rama}`);
if (!otros.length) return [];

// 🔴 LO QUE MOLESTA NO SON DOS PULL REQUESTS: SON DOS CORRIDAS A LA VEZ. Bloquear ante
// CUALQUIER pull request abierto en el repo le impediría a dos personas trabajar en cosas
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

Abrir otro AHORA encola una segunda ejecución del mismo pipeline en paralelo, y así se llena la cola
de Azure — pasó cuatro veces el 2026-09-03. Dos salidas:

  1. Esperá a que esa construcción termine (suele ser cuestión de minutos) y abrí el tuyo.
  2. Si tu cambio va junto con el que ya está, sumáselo: commit en su rama y push.

Este freno NO te impide tener dos pull requests abiertos en el mismo repo — eso es normal y no
molesta a nadie. Sólo evita disparar dos construcciones del mismo pipeline al mismo tiempo.

${encendidoPorLaOrganizacion
    ? `Este freno está encendido para toda la organización (perfil del equipo, switches.pr_one_per_repo) por una
tanda de cambios en varios repos. Para apagarlo en esta máquina, poné TYCON_PR_ONE_PER_REPO=0 en su entorno
ANTES de abrir la sesión: pegada al comando no sirve, porque el freno lee el entorno de la sesión.`
    : `Este freno está encendido porque esta máquina tiene TYCON_PR_ONE_PER_REPO=1 para una tanda de cambios en
varios repos. Para apagarlo, sacá esa variable del entorno (o ponela en 0) ANTES de abrir la sesión: pegada al
comando no sirve, porque el freno lee el entorno de la sesión.`}`);
constancia.anotar({ freno: 'pr-uno-por-repo', regla: 'pr-duplicado', veredicto: 'bloqueo', cmd });
process.exit(2);
}
