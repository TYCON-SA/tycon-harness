#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * scripts/lib/tycon-config.js — LA configuración del arnés: rutas, servicios e integraciones, en un
 * solo lugar y con un solo orden (story 8.3, 2026-09-26).
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * Hasta la 8.3 «dónde está el arnés», «dónde viven los repos», «cuál es la organización de Azure
 * DevOps» y «a quién avisar por Telegram» estaban escritos en el código: valían en la máquina donde
 * se escribieron y en ninguna otra, y para publicar el núcleo había que sacarlos. Ahora cada valor
 * configurable sale de UNA cadena, siempre la misma:
 *
 *   1. variable de entorno            (`TYCON_GUIDES_DIR`, `TYCON_REPOS_ROOT`, `TYCON_ADO_ORG`/`ADO_ORG`,
 *                                      `TYCON_TELEGRAM_CHAT_ID`, `TYCON_CODEX`, y una `TYCON_<INTEGRACION>`
 *                                      por llave nueva: `TYCON_CLOCKIFY`, `TYCON_ENGRAM`, `TYCON_CODEGRAPH`,
 *                                      `TYCON_MAILBOX`, `TYCON_NIGHTLY`; `0`/`1`, y `detect` para Codex)
 *   2. el archivo de la máquina        (`~/.claude/tycon.json` — nunca versionado; es lo que toda sesión
 *                                      ve, incluidas las de la extensión de VS Code, que no cargan el rc)
 *   3. el perfil del equipo            (`team-profile.json` en la raíz del arnés, o `perfil-equipo.json`, el nombre
 *                                      de antes, que sigue valiendo — versionado, sólo valores
 *                                      del equipo; la exportación open source lo deja afuera)
 *   4. apagado / sin valor
 *
 * Una excepción, y sólo una (story 8.29, `PROFILE_WINS`): en `packs.default` el perfil del equipo le gana al archivo de
 * la máquina (variable › perfil › máquina). La página pública instala con `--packs all` antes de que llegue la capa del
 * equipo, y con el orden general esa elección le ganaba al perfil para siempre. El archivo de la máquina no se toca:
 * `explain` dice lo que quedó escrito ahí y no se usa (cuando difiere), y `explain --json` lo trae en `shadowed`.
 *
 * `node scripts/lib/tycon-config.js explain` imprime cada valor con su origen (`env`, `maquina`,
 * `perfil`, `apagado`/`sin-valor`; `default` para las claves que siempre tienen un valor —la política de
 * actualización `update.channel`/`update.apply`, story 8.13, la llave `update.skills_source`, story 8.18, `packs.default`, story 8.7, y `update.source`/`paths.tree`, story 8.13.1—; y tres orígenes derivados, dichos como tales: `ubicacion` para la
 * carpeta del propio arnés —`rutas.arnes` sale de TYCON_GUIDES_DIR o de dónde vive este archivo, nunca de un
 * archivo de configuración—, `plugin` para el chat de Telegram que ya vive en los archivos del plugin, y
 * `archivo-llave` para el buzón de corridas, que está prendido si existe su llave).
 *
 * ── LO QUE NO PUEDE PASAR EN SILENCIO (AC 2) ───────────────────────────────────────────────────
 * Un archivo ilegible, una clave fuera del vocabulario o un valor del tipo equivocado NO se leen como
 * «todo apagado»: es exactamente la falla que dejaría al equipo sin integraciones sin enterarse.
 *   · Un COMANDO frena: `leer()` tira `ConfigError` con TODOS los errores (archivo · clave · motivo) y
 *     la CLI sale 2.
 *   · Un HOOK (de Claude Code o de git) NO puede frenar ni denegar una herramienta por esto (un
 *     `PreToolUse` que sale con 2 deja la sesión sin Bash): usa `leerParaHook()`, que nunca tira,
 *     devuelve el aviso para stderr, y el hook lo imprime en CADA corrida —sin sello, sin silencio— y
 *     no hace la parte de la integración. Desde shell: `tycon-config.js validate --hook` (exit 0 siempre).
 *
 * ── LO PERSONAL NO VA EN EL PERFIL (AC 3) ───────────────────────────────────────────────────────
 * El perfil trae sólo valores del equipo: la organización de Azure DevOps y qué integraciones están
 * prendidas. Un chat_id, un email, un token, una llave —por nombre de clave o por forma del valor— o una
 * ruta de la máquina lo hacen inválido, con el motivo. Eso va en `~/.claude/tycon.json` o en su variable.
 *
 * El perfil se puede fijar o anular por variable: `TYCON_PROFILE=<ruta>` lo reemplaza y `TYCON_PROFILE=0`
 * corre SIN perfil (desde el clon interno el perfil se encuentra por la ubicación del script, y una
 * HOME temporal no lo saca: es lo que usan las pruebas «sin perfil»).
 *
 * Copia la falla fuerte del cargador de paquetes de la 8.2 (`lib/packs.js` de agent-skills): un archivo
 * roto frena, no degrada. `TYCON_SKILLS_DIR` no es de este lector (`lib/skills-dir.js`, dos semánticas,
 * decisión W3 de la revisión adversarial): `explain` sólo la muestra.
 *
 * ── LAS OCHO INTEGRACIONES (AC 9/10, tanda B) ──────────────────────────────────────────────────
 * `ado` (por `ado.org`), `telegram` (por `telegram.chat_id`) y las seis llaves de `integrations.*`
 * (`clockify`, `engram`, `codegraph`, `mailbox`, `codex`, `nightly`). Sin
 * configuración están APAGADAS. Quien las consume pregunta acá, nunca al ambiente ni al disco:
 *   · un COMANDO: `integracionParaComando(llave)` → `{ prendida, estado, origen, apagada }` (`apagada` es la línea
 *     que imprime, exit 0: «<integración> apagada en esta máquina — prender: …»); rota → tira `ConfigError`;
 *   · un HOOK: `integracionParaHook(llave)` nunca tira → `{ ok, prendida, estado, origen, aviso }`: rota → `ok:false`,
 *     `prendida:false` y el aviso para stderr (no hace su parte, no frena);
 *   · shell: `key <integracion> [--hook [--switch VAR]]` (0 prendida · 3 apagada · 2 rota; con --hook siempre 0 y el
 *     estado por stdout) e `integrations [--shell|--json]` (el instalador lee las ocho de una vez; rota → nada por stdout, exit 2).
 * La llave del buzón: `TYCON_MAILBOX_JSON` (la misma variable que lee upload-runs.js) dice dónde está; sin ella,
 * `scripts/metrics/corridas-buzon.json` del propio clon.
 *
 * Uso: node scripts/lib/tycon-config.js explain [--json]      → cada valor con su origen (exit 2 si está rota)
 *      node scripts/lib/tycon-config.js get <clave>            → el valor solo (exit 3 sin valor/apagado, 2 rota)
 *      node scripts/lib/tycon-config.js validate [--hook]      → 0 válida · 2 rota (con --hook: 0 siempre, aviso por stderr)
 *      node scripts/lib/tycon-config.js key <integracion> [--hook [--switch VAR]]   → prendida/apagada/detect (ver arriba)
 *      node scripts/lib/tycon-config.js integrations [--shell|--json] → las ocho de una vez (para el instalador)
 *      node scripts/lib/tycon-config.js set <clave> <valor>    → la escribe en ~/.claude/tycon.json con `setKey` (story 8.16,
 *                                      tanda D): 0 con «antes → después» · 2 clave desconocida, valor inválido o archivo roto
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ_ARNES = path.resolve(__dirname, '..', '..');
// Las variables renombradas a inglés (story 8.9, tanda B1): el nombre viejo sigue valiendo hasta el retiro. La biblioteca
// viaja con este archivo a la copia del freno de producción (instalar-freno.sh, ARCHIVOS); sin ella, paso directo.
const legacy = (() => { try { return require('./legacy-names.js'); } catch (_) { return null; } })();
// Los manifiestos de integrations/: los ajustes que pide cada integración. Sin la biblioteca (la copia del freno de
// producción no la trae) no hay integraciones que leer y lo demás sigue igual.
const integ = (() => { try { return require('./integrations.js'); } catch (_) { return null; } })();
let sinAnotarNivel = 0;   // ver `sinAnotar`, más abajo
const leerVariable = (env, nombre) => (legacy ? (sinAnotarNivel ? leerVariableSinAnotar(env, nombre) : legacy.readEnv(nombre, { env, where: 'scripts/lib/tycon-config.js' })) : env[nombre]);
/** Lo mismo que `legacy.readEnv` (gana el nombre nuevo; si no está, vale el viejo), sin anotar el uso: ver `sinAnotar`. */
function leerVariableSinAnotar(env, nombre) {
  if (env[nombre] !== undefined) return env[nombre];
  try {
    const e = legacy.usableEntries(legacy.loadMap()).find((x) => x.kind === 'env' && x.new === nombre);
    return e ? env[e.old] : undefined;
  } catch (_) { return undefined; }
}
// El perfil del equipo se llama team-profile.json; el nombre de antes, perfil-equipo.json, sigue valiendo sin fecha de
// retiro (vive en repos del equipo y en clones que el arnés no controla). Se busca primero el nuevo; con los dos, gana el
// nuevo. ESCRITOS acá, no importados de scripts/setup/harness/team.js: este archivo viaja solo a la copia del freno de
// producción (/opt). La misma pareja: team.js → PROFILE_PATH / LEGACY_PROFILE_PATH.
const NOMBRE_PERFIL = 'team-profile.json';
const NOMBRE_PERFIL_VIEJO = 'perfil-equipo.json';
/** El perfil en la raíz de un árbol: `{ ruta, nombre, viejo, ambos }` (sin ninguno, la ruta del nombre nuevo). Nunca tira. */
function perfilDelArbol(arnes) {
  const es = (n) => { try { return fs.statSync(path.join(arnes, n)).isFile(); } catch (_) { return false; } };
  const nuevo = es(NOMBRE_PERFIL);
  const viejo = es(NOMBRE_PERFIL_VIEJO);
  const nombre = nuevo || !viejo ? NOMBRE_PERFIL : NOMBRE_PERFIL_VIEJO;
  return { ruta: path.join(arnes, nombre), nombre, viejo: viejo && !nuevo, ambos: nuevo && viejo };
}
/** La línea suave sobre el nombre del perfil (el de antes, o los dos), o null. Nunca frena: el de antes sigue andando. */
function avisoNombrePerfil(rp) {
  if (!rp || rp.explicito || rp.anulado) return null;
  if (rp.ambos) return `están ${NOMBRE_PERFIL} y ${NOMBRE_PERFIL_VIEJO}: vale ${NOMBRE_PERFIL} y ${NOMBRE_PERFIL_VIEJO} no se usa — borralo (git rm ${NOMBRE_PERFIL_VIEJO})`;
  if (rp.viejo) return `el perfil usa el nombre de antes (${NOMBRE_PERFIL_VIEJO}): sigue andando; para pasarlo al nuevo, git mv ${NOMBRE_PERFIL_VIEJO} ${NOMBRE_PERFIL}`;
  return null;
}
// Los dos nombres del lugar del arnés (story 8.19): ~/.claude/tycon-harness, y el viejo, que sigue resolviendo en las
// máquinas ya instaladas. ESCRITOS acá, no importados de scripts/setup/harness/place.js: este archivo viaja solo a la
// copia del freno de producción en /opt. Copia declarada en scripts/tests/fixtures/harness-place-names.json.
const PLACE_NAME = 'tycon-harness';
const LEGACY_PLACE_NAME = 'tycon-claude-guides';
const NOMBRE_ENLACE = PLACE_NAME;
const LLAVE_BUZON = ['scripts', 'metrics', 'corridas-buzon.json'];

// Vocabulario cerrado: sección → clave → tipo. Las claves que empiezan con `__` son comentarios
// (convención de `suites.json`) y se ignoran en cualquier nivel.
const VOCABULARIO = Object.freeze({
  // `rutas.arnes` no va en archivos: el arnés se encuentra por su ubicación o por TYCON_GUIDES_DIR / el enlace.
  // `tree` (story 8.13.1, AC 2): la carpeta del árbol gestionado; el lugar del arnés será un enlace a ella (la tanda A no
  // crea nada ahí). Tiene que ser ABSOLUTA (o con `~`): una relativa es un error, no «relativa al HOME» como `repos`.
  // `maintained` (story 8.23, tandas B y C): el clon que esta máquina MANTIENE (de ahí leen los avisos en una instalación
  // bajada). Lo escribe `harness.js config set paths.maintained`; acá sólo se lo conoce, para que el archivo que lo trae
  // no se lea como roto.
  // `maintainers` (story 8.26, tanda F1): el clon del repo de mantenimiento, de donde el freno antes de publicar lee la
  // lista privada. Lo escribe `harness.js config set paths.maintainers`; acá, igual, sólo se lo conoce. La primera versión
  // de la F1 lo escribía sin que estuviera acá: guardarlo dejaba la configuración de la máquina «rota» para este lector.
  // Toda clave que ese comando sabe escribir tiene que estar en este vocabulario (lo fija la prueba del freno, T56).
  // `team` y `operations`: los clones del perfil del equipo y del repo de operaciones de la organización, que edita la
  // página de configuración (`harness.js team-config`, que las pide la primera vez y las guarda con `config set`).
  rutas: Object.freeze({ repos: 'rutas', tree: 'ruta-absoluta', maintained: 'ruta-absoluta', maintainers: 'ruta-absoluta', team: 'ruta-absoluta', operations: 'ruta-absoluta' }),
  // `github.token` (story 8.23, tandas B y C): el permiso de sólo lectura de GitHub, en `~/.tycon/config.json`. Tipo
  // `secreto`: este lector sabe SI está y nunca qué dice —el valor no entra a `valores` (queda `true`), no sale en
  // `explain`, `get` ni en un error, y `set` no lo escribe (lo escribe `harness.js config set github.token`, por stdin)—.
  // En el perfil versionado es un error: es de una persona.
  github: Object.freeze({ token: 'secreto' }),
  // `azure.token` (story 8.25, fuente Azure DevOps de la capa del equipo): el PAT de sólo lectura (Code: Read) del repo del
  // equipo, con el mismo trato que `github.token` (lo escribe `harness.js config set azure.token`; nunca sale de su archivo)
  azure: Object.freeze({ token: 'secreto' }),
  ado: Object.freeze({ org: 'texto' }),
  telegram: Object.freeze({ chat_id: 'texto' }),
  integraciones: Object.freeze({
    clockify: 'llave', engram: 'llave', codegraph: 'llave', mailbox: 'llave', codex: 'llave-o-detectar', nightly: 'llave',
    // `instincts`: la grabadora de instintos (integrations/instincts/scripts/instinct-observe.js). Para el equipo la prende el perfil; la
    // variable y el archivo de la máquina sirven para apagarla o para probarla en una máquina.
    instincts: 'llave',
    // `claude` (story 8.23, tanda C · AC 24): la llave de la OTRA herramienta, con el vocabulario de `codex` (true, false o
    // "detect"). No es una de las ocho integraciones (no es un servicio): dice si el arnés enchufa a Claude Code. La leen
    // `toolKeys()` y `install`; `detect` —y nadie diciendo nada— es «si está instalada».
    claude: 'llave-o-detectar',
    // `timeTracking`: la integración de horas que eligió la organización (`none` o el nombre de una carpeta de
    // integrations/). Texto libre y no una lista cerrada: un valor que no corresponde a ninguna integración no rompe la
    // configuración; lo dice el evento de trabajo (scripts/lib/work-signal.js) y se trata como `none`. Los ajustes de una
    // integración van en `integrations.<nombre>` como objeto, con las claves que declara su manifiesto.
    timeTracking: 'texto',
    // `platform`: la plataforma del equipo para lo que no es de un repo (scripts/lib/platform/platform.js), por área:
    // `default`, y opcionales `workItems` (los pedidos de trabajo) y `queue` (la cola). Cada valor es el nombre de un
    // conector de integrations/; uno que no existe no rompe la configuración: la capa lo dice y lo trata como sin elegir.
    // Lo atado a un repo (pedidos de cambio, la CI) va por la plataforma del repo en team-repos.json, no por acá.
    platform: 'plataforma',
  }),
  // La política de actualización del arnés (story 8.13, AC 12): valores CERRADOS (`opcion:a|b`). Un valor fuera de la
  // lista es un error (8.3 AC 2), nunca «apagado» ni el default. `TYCON_UPDATE=0` (apagar del todo) no es una clave:
  // es un interruptor por hook, y lo lee `scripts/setup/harness/channel.js`.
  // `skills_source` (story 8.18, AC 30) es la llave de la transición de los dos repos internos a uno: de dónde lee las
  // skills una máquina del equipo que todavía tiene dos clones. `separate` = de su clon viejo de agent-skills, como
  // siempre; `unified` = ese clon re-apuntado al repo unido (lo hace `scripts/setup/harness/repoint.js`, y se deshace
  // volviendo a `separate`). La prende el perfil del equipo el día del corte; una máquina se queda afuera con
  // `separate` en su `~/.claude/tycon.json`, que le gana al perfil. También cerrada: un valor inventado es un error.
  // `source` (story 8.13.1, AC 2): de dónde instala la máquina — `internal` (el repo interno, lo de hoy) o `public` (la
  // copia pública más la capa privada). Sin que nadie diga nada, `public`: una máquina de afuera; el perfil del equipo
  // trae `internal` mientras el equipo no migra. También cerrada.
  update: Object.freeze({ channel: 'opcion:latest|stable', apply: 'opcion:auto|ask', skills_source: 'opcion:separate|unified', source: 'opcion:internal|public' }),
  // Los paquetes de revisores que se activan en un repo que no declara `packs:` (story 8.7, AC 8): `all` = todos los
  // instalados, `none` = ninguno. Lo pregunta `lib/packs.js` de agent-skills. Un paquete «opcional» es uno que quien no
  // lo usa no tiene que apagar: afuera, sin perfil, `none`; el perfil del equipo dice `all` (en el equipo nada cambia).
  // Una lista (`["bizuit", "clients"]`) activa exactamente ésos; por variable, separada por comas.
  packs: Object.freeze({ default: 'paquetes' }),
  // Cuánto instala el arnés (story 8.16, tanda C · AC 21): `minimal` (lo que hace falta para las guías, las skills, los
  // revisores y el pipeline como skill) o `full` (también los frenos, los bloques que cambian cómo contesta el asistente,
  // los hooks de git y las tareas de fondo). NO tiene valor por defecto: si nadie lo dice queda nulo («sin elegir») y el
  // aplicador se comporta como `full`, que es lo de siempre. El perfil del equipo fija `full`. Un valor fuera de la
  // lista es configuración ROTA, nunca `full`. Qué trae cada perfil lo dice scripts/setup/install-effects.json (`profiles`).
  // `install.home` (story 8.23, tanda D · AC 32): dónde vive el arnés de cada máquina. `claude` (también sin valor) es lo
  // de hoy: el clon en la carpeta de Claude Code; `tycon` hace que el arranque de cada máquina la mude sola a `~/.tycon`,
  // una vez. La prende el dueño en el perfil del equipo DESPUÉS de migrar su máquina a mano; hasta entonces no está.
  install: Object.freeze({ profile: 'opcion:minimal|full', home: 'opcion:claude|tycon' }),
  // La pregunta del modelo mayor en el pase adversarial ya no existe: el pase no ofrece Fable. La clave queda RETIRADA:
  // un archivo viejo que la tiene sigue validando (con cualquier valor), no da valor y se avisa (`retiradas`); `set` no
  // la escribe. Sin la sección, ese archivo se leería como roto.
  adversarial: Object.freeze({ model_question: 'retirada' }),
  // Cómo contesta el asistente: el idioma y el estilo del bloque de respuesta del CLAUDE.md (y del AGENTS.md),
  // y el tope de prosa que mide el medidor de estilo. Cerrados: cada estilo es un texto revisado en
  // claude-md-blocks/response-style/<estilo>.<idioma>.md, y un valor fuera de la lista es configuración ROTA (el
  // sincronizador deja el bloque que había). Sin valor: `neutral` en `es`, y el tope del estilo (TOPE_POR_ESTILO).
  response: Object.freeze({ language: 'opcion:es|en', style: 'opcion:executive|detailed|neutral', max_chars: 'entero:300-4000' }),
  // Quién puede reenviar el ok de un dev: el nombre de la sesión (la coordinadora de una organización) cuyos
  // mensajes valen como reenvío textual del ok del dev para eximir un crítico o firmar un criterio que no se puede probar
  // en vivo. Sin valor, nadie. Vale SÓLO desde el perfil del equipo (PROFILE_ONLY).
  // `delegated_signing`: qué firmas puede hacer esa misma sesión en nombre del dueño. Un valor solo (como siempre) o una
  // lista, de un vocabulario cerrado con todas las firmas del arnés; `off` va solo. Sin valor, ninguna. Sólo del perfil.
  // `delegated_machines`: en qué máquinas vale esa delegación, por la huella de `machine-id.js` (16 hex) y un nombre para
  // la persona. Sin valor, en ninguna. Sólo del perfil: si la máquina pudiera decirlo, el agente se elegiría solo.
  approvals: Object.freeze({
    relay_session: 'texto',
    delegated_signing: 'opciones:off|refresh-after-main|adversarial-skip|critical-waiver|escape-phrases|plan-approval|browser-test|runtime-waiver|manual-test|extra-round|control-change|lost-run',
    delegated_machines: 'maquinas',
  }),
  // Cómo se pone al día el freno de producción de cada máquina: `password` (o sin valor), con la contraseña
  // de su persona cada vez; `auto`, solo, con la versión publicada, en las máquinas que instalaron el permiso. Sólo del
  // perfil: si la máquina pudiera decir `auto`, el agente se abriría solo la actualización sin contraseña.
  guard: Object.freeze({ update: 'opcion:password|auto' }),
  // Si, además del arnés, una persona tiene que marcar cada criterio de la guía del tester como probado a mano antes de
  // cerrar la historia: `off` (o sin valor) = no; `required` = el cierre frena sin esa marca. Cerrada, para sumar un
  // valor sin romper archivos. Vale SÓLO desde el perfil del equipo (PROFILE_ONLY): el agente podría apagarse el freno.
  qa: Object.freeze({ manual_check: 'opcion:off|required' }),
  // El proveedor de modelos de esta máquina: de qué tabla de `team-repos.json → models.providers` sale el
  // modelo de cada nivel. Es de la máquina: en el perfil del equipo es un error. Sin valor se deriva de la herramienta
  // (`modelProvider`): una sesión de Codex es `openai`; todo lo demás, `anthropic`. Claude Code sobre Ollama se declara.
  models: Object.freeze({ provider: 'opcion:anthropic|openai|ollama|cursor' }),
});
// El tope de prosa de cada estilo cuando el perfil no fija `response.max_chars`: el de `executive` es el de
// siempre. Lo usan el sincronizador (lo escribe en el bloque) y el medidor (lo mide).
const TOPE_POR_ESTILO = Object.freeze({ executive: 1300, detailed: 3000, neutral: 2000 });
// Las claves que SIEMPRE tienen un valor: sin nadie que diga nada, éste, con origen `default` (la política no se apaga:
// una máquina de afuera, sin perfil, queda en «estable» y «preguntar»; el perfil del equipo trae `latest` + `auto`).
// `update.skills_source` nace en `separate`: sin que nadie diga nada, ninguna máquina re-apunta nada (story 8.18).
// `update.source` nace en `public` y `paths.tree` en la carpeta del mecanismo, sin el nombre del lugar (story 8.13.1); la
// ruta se escribe con `~` y se resuelve contra el HOME de quien lee.
const DEFAULTS = Object.freeze({
  'update.channel': 'stable', 'update.apply': 'ask', 'update.skills_source': 'separate', 'packs.default': 'none',
  'update.source': 'public', 'rutas.tree': '~/.claude/.tycon-pipeline/harness/tree',
  'response.language': 'es', 'response.style': 'neutral', 'guard.update': 'password',
});
// Las claves en las que el PERFIL DEL EQUIPO le gana al archivo de la máquina (story 8.29, decisión del dueño del
// 2026-10-11). Para todo lo demás el orden es el de siempre: variable › máquina › perfil. Para éstas: variable › perfil ›
// máquina. Hoy es una sola: los paquetes de revisores. La página pública instala con `--packs all`, el instalador lo
// escribe en el archivo de la máquina, y recién después llega la capa del equipo con su perfil: con el orden de siempre
// esa elección le ganaba al perfil para siempre, y el día que el equipo cambiara el perfil esas máquinas no se enteraban
// (el ensayo de Windows lo informaba como `guided:team:profile-origin` en toda máquina con la capa). El archivo de la
// máquina NO se toca: lo que tiene escrito queda ahí, sin efecto mientras el perfil declare la clave, y `explain` lo dice.
// Una integración apagada en la máquina, en cambio, sigue apagada aunque el perfil la prenda: eso no cambió.
// Quien quiera otros paquetes en UNA máquina del equipo usa la variable (`TYCON_PACKS_DEFAULT`), o `packs:` en el repo.
const PROFILE_WINS = Object.freeze(['packs.default']);
// Las claves retiradas (tipo `retirada`): por qué ya no hacen nada. Un archivo que todavía las tiene valida y se avisa.
const RETIRADAS = Object.freeze({
  'adversarial.model_question': 'ya no hace nada: el pase adversarial no ofrece Fable — se puede borrar',
});
// Las claves que vale SÓLO el perfil del equipo: ni una variable ni el archivo de la máquina las cambian. El
// perfil es versionado y se cambia con un pedido; la variable y el archivo de la máquina los puede escribir el agente que
// implementa, y esta clave abre la puerta a eximir un crítico: si las leyera, el agente se la abriría solo. Lo que el
// archivo de la máquina tenga escrito queda en `shadowed` con `by: 'solo-perfil'` y `explain` lo dice; `set` no la escribe.
const PROFILE_ONLY = Object.freeze(['approvals.relay_session', 'qa.manual_check', 'approvals.delegated_signing', 'guard.update', 'approvals.delegated_machines']);
/** Los paquetes que activa la organización (tipo `paquetes`): `all`, `none` o una lista de nombres de paquete. */
const NOMBRE_DE_PAQUETE = /^[a-z0-9][a-z0-9-]*$/;
// Los canales por los que sale un aviso; la misma lista que `CANALES` del módulo de avisos (lo fija T27).
const CANALES_DE_AVISO = Object.freeze(['telegram', 'slack', 'teams', 'mail']);
/** null si el valor es `all`, `none` o una lista no vacía de nombres distintos; si no, el motivo. */
function motivoPaquetes(valor) {
  if (typeof valor === 'string') return ['all', 'none'].includes(valor.trim()) ? null : `tiene que ser all, none o una lista de nombres de paquete, no ${JSON.stringify(valor)}`;
  if (!Array.isArray(valor) || !valor.length) return `tiene que ser all, none o una lista no vacía de nombres de paquete (para ninguno, none), no ${JSON.stringify(valor)}`;
  const malo = valor.find((n) => typeof n !== 'string' || !NOMBRE_DE_PAQUETE.test(n));
  if (malo !== undefined) return `${JSON.stringify(malo)} no es un nombre de paquete (minúsculas, dígitos y guiones)`;
  if (new Set(valor).size !== valor.length) return `la lista repite un paquete: ${JSON.stringify(valor)}`;
  return null;
}
/** El valor de `packs.default` escrito como texto (variable o `set`): `all`, `none` o `a,b`. `{ valor }` o `{ motivo }`. */
function paquetesDeTexto(texto) {
  const t = String(texto).trim();
  if (t === 'all' || t === 'none') return { valor: t };
  const lista = t.split(',').map((x) => x.trim());
  const m = motivoPaquetes(lista);
  return m ? { motivo: `«${t}»: ${m.replace(/^tiene que ser /, 'tiene que ser ')}` } : { valor: lista };
}

/** El rango `[min, max]` de un tipo `entero:min-max`, o null si no es de ese tipo. */
function rangoDe(tipo) { const m = typeof tipo === 'string' ? /^entero:(\d+)-(\d+)$/.exec(tipo) : null; return m ? [Number(m[1]), Number(m[2])] : null; }
/** Las opciones de un tipo `opcion:a|b`, o null si no es de ese tipo. */
function optionsOf(tipo) { return typeof tipo === 'string' && tipo.startsWith('opcion:') ? tipo.slice('opcion:'.length).split('|') : null; }
/** Las opciones de un tipo `opciones:` (un valor solo, o una lista sin repetidos, de una lista cerrada). */
function subsetOf(tipo) { return typeof tipo === 'string' && tipo.startsWith('opciones:') ? tipo.slice('opciones:'.length).split('|') : null; }
const HUELLA_DE_MAQUINA = /^[0-9a-f]{16}$/;
const NOMBRE_DE_MAQUINA = /^[\p{L}\p{N} ._()-]{1,40}$/u;
/** Iguales por valor: dos listas con lo mismo no son «distintas» por ser dos objetos. */
function mismoValorPlano(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// Las secciones se ESCRIBEN en inglés en los archivos (story 8.9, tanda P · 2026-09-30): `paths` e `integrations`. El
// nombre de antes del renombre (`rutas`, `integraciones`) se sigue leyendo hasta el retiro —también en la copia de este
// archivo que vive en /opt con el freno de producción—; los dos juntos con valores distintos son un error del archivo. Por
// dentro (valores, orígenes, variables) las secciones conservan su nombre de siempre: nada de lo que las consume cambia.
const SECCION_EN_ARCHIVO = Object.freeze({ rutas: 'paths', integraciones: 'integrations' });
const SECCION_DE_ARCHIVO = Object.freeze({ paths: 'rutas', integrations: 'integraciones' });
const enArchivo = (seccion) => SECCION_EN_ARCHIVO[seccion] || seccion;
// Dos claves de integración y un valor también se ESCRIBEN en inglés (story 8.9, tanda G · 2026-10-03): `mailbox`,
// `nightly` y `"detect"`. Son lo que alguien de afuera tipea en su archivo y ve en `explain`. Los nombres de antes se
// siguen leyendo hasta el retiro —en el archivo de la máquina, en el perfil, por variable y cuando un hook de una copia un
// pull atrás pregunta por la llave—, y acá se pasan al nuevo: adentro y en todo lo que se imprime hay un solo nombre.
// Cuáles son los de antes lo dice el mapa de renombres (scripts/lib/renames.json), que también viaja a la copia de /opt
// del freno de producción: sin mapa —la copia pública— no hay ninguno, y sólo valen los nuevos.
const DETECT = 'detect';
const DONDE_CLAVES = '~/.claude/tycon.json';            // el `where` de las claves de este archivo en el mapa
const DONDE_VALORES = 'scripts/lib/tycon-config.js';    // …y el de sus valores
const tiene = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
let viejosDe = null;   // { mapa, nombres }: se recalcula sólo si el mapa cambió (la biblioteca lo relee por fecha)
/** Los nombres de antes: `{ claves: { integraciones: { <vieja>: <nueva> } }, detect: <valor viejo> | null }`. */
function nombresViejos() {
  const nada = { claves: { integraciones: {} }, detect: null };
  if (!legacy || typeof legacy.loadMap !== 'function' || typeof legacy.usableEntries !== 'function') return nada;
  let mapa;
  try { mapa = legacy.loadMap(); } catch (_) { return nada; }   // un mapa que no se deja leer es paso directo: lo dice la biblioteca
  if (viejosDe && viejosDe.mapa === mapa) return viejosDe.nombres;
  const nombres = nada;
  try {
    for (const e of legacy.usableEntries(mapa)) {
      if (e.kind === 'key' && e.where === DONDE_CLAVES && tiene(VOCABULARIO.integraciones, e.new)) nombres.claves.integraciones[e.old] = e.new;
      else if (e.kind === 'value' && e.where === DONDE_VALORES && e.option === 'codex' && e.new === DETECT) nombres.detect = e.old;
    }
  } catch (_) { /* paso directo */ }
  viejosDe = { mapa, nombres };
  return nombres;
}
/** ¿Es el valor `detect`, con su nombre de hoy o con el de antes? */
function esDetect(v) { if (v === DETECT) return true; const viejo = nombresViejos().detect; return viejo !== null && v === viejo; }
/** La clave de una sección con su nombre de hoy (la vieja de `integrations` → la nueva); cualquier otra, tal cual. */
function claveDeHoy(seccion, clave) { const v = nombresViejos().claves[seccion]; return v && tiene(v, clave) ? v[clave] : clave; }
/** Los nombres de antes de una clave de hoy (ninguno, o uno). */
function clavesViejasDe(seccion, clave) { const v = nombresViejos().claves[seccion] || {}; return Object.keys(v).filter((vieja) => v[vieja] === clave); }
/** Anota el uso de un nombre viejo de este archivo. Nunca rompe ni demora la lectura. */
// Una lectura que no puede escribir en la HOME (el plan de `harness.js install`, story 8.16 tanda B: sin conformidad la
// HOME queda idéntica): adentro de `sinAnotar(fn)` el uso de un nombre viejo no se anota en legacy-names.
function sinAnotar(fn) { sinAnotarNivel++; try { return fn(); } finally { sinAnotarNivel--; } }
function anotarViejo(kind, old, nuevo, home) {
  if (!legacy || sinAnotarNivel) return;
  try { legacy.recordUse({ kind, old, new: nuevo, script: 'scripts/lib/tycon-config.js' }, home ? { home } : {}); } catch (_) { /* anotar nunca rompe */ }
}
// Las dos herramientas que el arnés sabe enchufar (story 8.23, tanda C): cada una con su llave en `integrations`.
const TOOLS = Object.freeze(['claude', 'codex']);
// `claude` es una llave de herramienta y no una integración: las ocho siguen siendo ocho (`codex` es las dos cosas).
// `timeTracking` tampoco: es una elección, no una llave (filtro por tipo).
const INTEGRACIONES = Object.freeze(Object.keys(VOCABULARIO.integraciones).filter((k) => k !== 'claude' && String(VOCABULARIO.integraciones[k]).startsWith('llave')));
// Las ocho, en el orden en que se informan: las dos «por dato» (ado por ado.org, telegram por telegram.chat_id) y las seis llaves.
const LAS_OCHO = Object.freeze(['ado', ...INTEGRACIONES, 'telegram']);
// Cómo se prende cada una — la línea que un comando imprime cuando la necesitaba y está apagada (AC 10). Sin «0», sin «nada».
const COMO_SE_PRENDE = Object.freeze({
  ado: 'Azure DevOps apagado en esta máquina: no hay organización configurada — prender: ado.org en ~/.claude/tycon.json (o TYCON_ADO_ORG)',
  clockify: 'Clockify apagado en esta máquina — prender: integrations.clockify=true en ~/.claude/tycon.json (o TYCON_CLOCKIFY=1)',
  engram: 'engram apagado en esta máquina — prender: integrations.engram=true en ~/.claude/tycon.json (o TYCON_ENGRAM=1)',
  codegraph: 'CodeGraph apagado en esta máquina — prender: integrations.codegraph=true en ~/.claude/tycon.json (o TYCON_CODEGRAPH=1)',
  mailbox: 'buzón de corridas apagado en esta máquina: sin la llave — prender: la llave scripts/metrics/corridas-buzon.json del arnés interno (TYCON_MAILBOX_JSON=<ruta>), o integrations.mailbox=true en ~/.claude/tycon.json (TYCON_MAILBOX=1)',
  codex: 'Codex apagado en esta máquina — prender: integrations.codex=true o "detect" en ~/.claude/tycon.json (o TYCON_CODEX=1)',
  nightly: 'nocturnos del equipo apagados en esta máquina — prender: integrations.nightly=true en ~/.claude/tycon.json (o TYCON_NIGHTLY=1)',
  instincts: 'grabadora de instintos apagada en esta máquina — la prende el perfil del equipo (integrations.instincts=true); para probarla en una máquina: integrations.instincts=true en ~/.claude/tycon.json (o TYCON_INSTINCTS=1)',
  telegram: 'Telegram apagado en esta máquina: sin chat configurado — prender: telegram.chat_id en ~/.claude/tycon.json, TYCON_TELEGRAM_CHAT_ID, o el plugin de Telegram',
});

// Variables de entorno por clave, en orden de precedencia entre ellas (la primera que esté, gana).
const VARIABLES = Object.freeze({
  'rutas.arnes': ['TYCON_GUIDES_DIR'],
  'rutas.repos': ['TYCON_REPOS_ROOT'],
  'rutas.tree': ['TYCON_TREE'],
  'ado.org': ['TYCON_ADO_ORG', 'ADO_ORG'],
  'telegram.chat_id': ['TYCON_TELEGRAM_CHAT_ID'],
  'integraciones.clockify': ['TYCON_CLOCKIFY'],
  'integraciones.engram': ['TYCON_ENGRAM'],
  'integraciones.codegraph': ['TYCON_CODEGRAPH'],
  'integraciones.mailbox': ['TYCON_MAILBOX'],
  'integraciones.codex': ['TYCON_CODEX'],
  'integraciones.claude': ['TYCON_CLAUDE'],
  'integraciones.nightly': ['TYCON_NIGHTLY'],
  'integraciones.instincts': ['TYCON_INSTINCTS'],
  'integraciones.timeTracking': ['TYCON_TIME_TRACKING'],
  'update.channel': ['TYCON_UPDATE_CHANNEL'],
  'update.apply': ['TYCON_UPDATE_APPLY'],
  'update.skills_source': ['TYCON_UPDATE_SKILLS_SOURCE'],
  'update.source': ['TYCON_UPDATE_SOURCE'],
  'packs.default': ['TYCON_PACKS_DEFAULT'],
  'install.profile': ['TYCON_INSTALL_PROFILE'],
  'install.home': ['TYCON_INSTALL_HOME'],
  'response.language': ['TYCON_RESPONSE_LANGUAGE'],
  'response.style': ['TYCON_RESPONSE_STYLE'],
  'response.max_chars': ['TYCON_RESPONSE_MAX_CHARS'],
  'models.provider': ['TYCON_MODEL_PROVIDER'],
});

// Los interruptores por hook que ya existían siguen valiendo POR ENCIMA de la llave de su
// integración (AC 1). `explicar` los muestra cuando están puestos; no se leen acá.
const INTERRUPTORES_POR_HOOK = Object.freeze([
  'TYCON_ENGRAM_HOOK', 'TYCON_ENGRAM_DRIFT', 'TYCON_ENGRAM_MANIFEST_GUARD', 'TYCON_NO_ENGRAM_VERSION_CHECK',
  'TYCON_NO_ENGRAM_PROJECT_CHECK', 'TYCON_NO_UPLOAD_RUNS', 'TYCON_NO_DOWNLOAD_RUNS', 'TYCON_NO_THREAD_RESCUE',
  'TYCON_NO_COLLECT_FINDINGS', 'TYCON_NO_AZ_PROJECTS_REFRESH', 'TYCON_TG_ZOMBIE_SWEEP', 'TYCON_BENCH_NOTICE',
  'TYCON_DASHBOARD_NOTICE', 'TYCON_DEPS_NOTICE', 'TYCON_RETRO_STALENESS', 'TYCON_NO_NIGHTLY_EXAM',
  'TYCON_UPDATE',   // =0 apaga la actualización del arnés del todo (story 8.13); lo lee harness/channel.js
]);

// Lo personal, por NOMBRE de clave (además de lo que el vocabulario ya rechaza como desconocido).
const NOMBRES_PERSONALES = Object.freeze(['chat_id', 'chatid', 'email', 'mail', 'token', 'llave', 'key', 'secret', 'secreto', 'password', 'pat']);
const FORMAS_PERSONALES = Object.freeze([
  [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'parece un email'],
  [/^\d{6,}:[A-Za-z0-9_-]{30,}$/, 'parece un token de bot'],
  // formas conocidas de secreto que el corte de 32 caracteres no atrapaba (revisor de seguridad, story 8.3 vuelta 2);
  // van ANTES del corte genérico para que el motivo diga qué forma tiene. Lo que NO se detecta por forma —una
  // contraseña corta suelta— no se puede detectar por forma: por eso el perfil versionado sólo admite claves del
  // vocabulario, y `password`/`secret`/`token` no están en él.
  [/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/, 'parece un JWT'],
  [/^(?:AKIA|ASIA)[0-9A-Z]{16}$/, 'parece una llave de AWS'],
  [/^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/, 'parece un token de GitHub'],
  [/^xox[baprs]-[A-Za-z0-9-]{10,}$/, 'parece un token de Slack'],
  [/^sk-[A-Za-z0-9_-]{16,}$/, 'parece una llave de API'],
  [/^(?:pass(?:word|wd)?|pwd|secret|secreto|token|api[_-]?key|llave|clave|pat|chat(?:_?id)?)\s*[=:]\s*\S+$/i, 'parece una credencial escrita (nombre=valor)'],
  [/^-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'parece una clave privada'],
  [/^[A-Za-z0-9_-]{32,}$/, 'parece una llave o un token'],
]);

class ConfigError extends Error {
  constructor(errores) {
    const lista = (errores || []).map((e) => `  · ${e.archivo}${e.clave ? ` · ${e.clave}` : ''} · ${e.motivo}`);
    super(`🛑 configuración del arnés: ${errores.length} error(es). Un archivo roto NO se lee como «todo apagado» ` +
          `(story 8.3): se arregla el archivo o la variable.\n${lista.join('\n')}`);
    this.name = 'ConfigError';
    this.errores = errores;
  }
}

function esObjeto(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
/** `ado.org` en su forma canónica: `https://dev.azure.com/<org>`. Acepta también `https://<org>.visualstudio.com`
 *  (el origin real de varios repos del equipo), con usuario, con barra final o con espacios; cualquier otro texto
 *  queda recortado. Los scripts de shell derivan el NOMBRE como «lo que sigue a la última barra»: sin esto, una barra
 *  final o la forma visualstudio daban «sin organización» o «el clon no es del equipo» (pase adversarial, vuelta 1). */
function normalizarOrg(v) {
  const s = String(v == null ? '' : v).trim().replace(/\/+$/, '');
  let m = s.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/?#]+)/i);
  if (m) return `https://dev.azure.com/${m[1]}`;
  m = s.match(/^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com/i);
  if (m) return `https://dev.azure.com/${m[1]}`;
  return s;
}
/** El nombre de la organización (`equipo` en `https://dev.azure.com/equipo`). */
function nombreDeOrganizacion(org) { const s = normalizarOrg(org); return s ? s.split('/').pop() : ''; }
/** Una ruta de un archivo de configuración: recortada, `~` expandida, y si es relativa, relativa al HOME (nunca al
 *  cwd del proceso que la lee: el mismo tycon.json daba raíces distintas según qué hook lo leyera). */
function resolverRutaDeArchivo(v, home) {
  const e = expandirHome(String(v).trim(), home);
  return path.normalize(path.isAbsolute(e) ? e : path.join(home, e));
}
/** ¿Es una ruta absoluta (o con `~`, que se expande al HOME)? Una relativa no se resuelve contra nada: es un error. */
function esRutaAbsoluta(v) { const s = String(v).trim(); return /^~(?=$|[\\/])/.test(s) || path.isAbsolute(s); }
function normalizarValor(tipo, valor, home, clave) {
  if (tipo === 'secreto') return true;   // sólo «está»: el valor no sale de su archivo
  if (tipo === 'ruta') return resolverRutaDeArchivo(valor, home);
  // una ruta o varias (la carpeta de los repos puede ser más de una): una lista se resuelve ruta por ruta
  if (tipo === 'rutas') return Array.isArray(valor) ? valor.map((v) => resolverRutaDeArchivo(v, home)) : resolverRutaDeArchivo(valor, home);
  if (tipo === 'ruta-absoluta') return path.normalize(expandirHome(String(valor).trim(), home));
  if (clave === 'ado.org') return normalizarOrg(valor);
  if (tipo === 'llave-o-detectar' && esDetect(valor)) return DETECT;   // el valor viejo se lee como el nuevo
  if (tipo === 'paquetes' && typeof valor === 'string') return valor.trim();
  if (tipo === 'plataforma') return Object.fromEntries(Object.keys(valor).filter((k) => !esComentario(k)).map((k) => [k, String(valor[k]).trim().toLowerCase()]));
  if (tipo === 'maquinas') return valor.map((m) => ({ id: m.id.trim(), label: m.label.trim() }));
  // una lista de opciones sigue siendo lista y un valor solo sigue solo: quien lo lee pregunta con `delegaFirma`
  if (subsetOf(tipo)) return Array.isArray(valor) ? valor.map((v) => v.trim()) : String(valor).trim();
  if (Array.isArray(valor)) return valor.slice();
  return typeof valor === 'string' ? valor.trim() : valor;   // un booleano sigue siendo booleano
}
/** Un dato de una persona escondido en un comentario (`__doc`, `__nota`) del perfil versionado. El mensaje muestra SÓLO los
 *  primeros 6 caracteres del valor (alcanza para ubicarlo): el error llega a stderr de comandos que corren en CI, y un
 *  fragmento largo de un token ya es una fuga (revisor de seguridad, tanda B, vuelta 2). */
/** Lo que se muestra de un valor personal en un mensaje: 6 caracteres, y de un número puro (un chat_id, un teléfono)
 *  NINGÚN dígito — 6 de 10 dígitos dejan poco por adivinar (revisor de seguridad, tanda B, vuelta 3). */
function muestra(valor) { return /^\d+$/.test(valor) ? `número de ${valor.length} dígitos` : valor.slice(0, 6); }

// Lo que se frena en un comentario (story 8.3.1, decisión del dev 2026-09-29): SÓLO lo inequívoco. Antes había reglas
// que adivinaban —toda palabra de 32+ caracteres «parece un token», todo número de 9+ dígitos «parece un chat_id»— y
// con ellas una nota inocente («clave: integraciones.engram», un archivo, el número de un build) dejaba el perfil ROTO
// para todo el equipo (pase adversarial de la 8.3-B, `false-positive-edge-4`). Cada excepción que se le agregaba abría
// otro borde (cuatro vueltas de revisión en la 8.3.1). El perfil casi no se toca, entra por pull request y no sale en la
// copia pública; por eso acá se cobra sólo lo que no puede ser otra cosa, y un número de chat suelto en una nota queda
// para quien revisa el pull request (T3/T4/T5 de tycon-config.test.js). `clave`/`llave` no son nombres de credencial: en castellano son «la clave X» de la
// configuración. Los valores (no los comentarios) siguen pasando por el vocabulario cerrado y por FORMAS_PERSONALES.
const FORMAS_EN_COMENTARIO = Object.freeze([
  // una dirección con usuario no es un email: `git@github.com:org/repo`, `https://usuario@dev.azure.com/org` (lo que
  // documenta normalizarOrg) — sin barra antes del usuario ni `/` o `:pegado` después del dominio ([DEF-8.3.1-5])
  [/(?<![\w.%+\/-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-]*(?:\/|:\S))/, 'parece un email'],
  [/\d{6,}:[A-Za-z0-9_-]{30,}/, 'parece un token de bot'],
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/, 'parece un JWT'],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/, 'parece una llave de AWS'],
  [/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, 'parece un token de GitHub'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'parece un token de Slack'],
  [/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/, 'parece una llave de API'],
  // el guion bajo también separa: `DB_PASSWORD=…`, `TYCON_API_KEY=…` (revisor de seguridad de la 8.3.1, iter 5)
  // …y el valor tiene al menos un dígito o un símbolo: «token: revisar la doc» es prosa, no una credencial ([DEF-8.3.1-5])
  [/(?:^|[^A-Za-z0-9])(?:pass(?:word|wd)?|pwd|secret|secreto|token|api[_-]?key|chat_?id)\s*[=:]\s*(?=[^\s,;)\]}»"'`]*[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s,;)\]}»"'`])[^\s,;)\]}»"'`]{4,}/i, 'parece una credencial escrita (nombre=valor)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'parece una clave privada'],
]);
function personalEnComentario(v) {
  // Un objeto adentro de un comentario se mira como `clave=valor`: `{ telegram: { chat_id: '…' } }` es un chat escrito.
  const textos = [];
  (function juntar(x, k) {
    if (typeof x === 'string' || typeof x === 'number') textos.push(k ? `${k}=${x}` : String(x));
    else if (Array.isArray(x)) x.forEach((y) => juntar(y, k));   // la clave viaja a través de una lista
    else if (esObjeto(x)) Object.entries(x).forEach(([kk, y]) => juntar(y, kk));
  })(v);
  for (const t of textos) {
    for (const [re, forma] of FORMAS_EN_COMENTARIO) {
      const m = re.exec(t);
      if (m) return `valor personal en un comentario (${forma}: «${muestra(m[0].replace(/^[^A-Za-z0-9-]+/, ''))}…»): un comentario del perfil versionado tampoco puede traer datos de una persona`;
    }
  }
  return null;
}
function esComentario(clave) { return String(clave).startsWith('__'); }
function expandirHome(v, home) { return String(v).replace(/^~(?=$|[\\/])/, home); }
function real(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }

// ── archivos ─────────────────────────────────────────────────────────────────────────────────────

// story 8.23 (tanda C): una máquina sin Claude Code vive entera en `~/.tycon` y su configuración es `~/.tycon/config.json`
// (la misma donde `harness.js config set` guarda el permiso). Dónde vive lo sabe scripts/setup/harness/tycon-home.js; se
// carga SI ESTÁ, por su ruta: la copia de este archivo que viaja al freno de producción (/opt) no lo tiene al lado, y ahí
// vale la ruta de siempre (la tanda D lo lleva). Si está y no carga, tira.
const TYCON_HOME_LIB = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
const tyconHome = fs.existsSync(TYCON_HOME_LIB) ? require(TYCON_HOME_LIB) : null;
function rutaMaquina(home) { return tyconHome && typeof tyconHome.configFile === 'function' ? tyconHome.configFile(home) : path.join(home, '.claude', 'tycon.json'); }
/** El archivo de la máquina como se le dice a la persona: el de siempre, o `~/.tycon/config.json` donde la máquina vive ahí. */
function nombreArchivoMaquina(home) {
  const f = rutaMaquina(home || os.homedir());
  const h = home || os.homedir();
  return f.startsWith(h + path.sep) ? `~/${f.slice(h.length + 1).split(path.sep).join('/')}` : f;
}
/** La línea «cómo se prende» con el archivo que esta máquina lee de verdad. */
/**
 * La línea de cómo se prende una integración. Con la configuración cargada y Azure DevOps fuera de la plataforma que eligió
 * la organización, no dice «apagado» (no hay nada que prender en la máquina): dice qué eligió.
 */
function comoSePrende(llave, home, config) {
  if (llave === 'ado' && config && config.valores) {
    const elegida = plataforma(config).value;
    const todas = elegida ? Object.values(elegida) : [];
    if (todas.length && !todas.includes('azure-devops')) return `Azure DevOps no es la plataforma de tu organización (eligió ${[...new Set(todas)].join(' y ')} en integrations.platform del perfil)`;
  }
  return String(COMO_SE_PRENDE[llave] || '').split('~/.claude/tycon.json').join(nombreArchivoMaquina(home));
}

/** El perfil: `TYCON_PROFILE=0` = sin perfil (`anulado`); `TYCON_PROFILE=<ruta>` = ése; si no, el del arnés. */
function rutaPerfil(env, arnes, home) {
  const perfil = leerVariable(env, 'TYCON_PROFILE');
  const v = perfil === undefined ? '' : String(perfil).trim();
  if (v === '0') return { ruta: null, anulado: true };
  if (v) return { ruta: path.resolve(expandirHome(v, home || os.homedir())), anulado: false, explicito: true };
  const p = perfilDelArbol(arnes);
  return { ruta: p.ruta, anulado: false, viejo: p.viejo, ambos: p.ambos };
}

/**
 * El perfil del equipo de un árbol dado, SOLO (story 8.23, tanda G · AC 41): lo que declara, validado como perfil, sin
 * mirar la variable ni el archivo de la máquina. Lo usa la mudanza a ~/.tycon para pasar esos valores al archivo de la
 * máquina: la versión bajada no trae el perfil (el exportador lo deja afuera) y la primera máquina migrada quedó con las
 * integraciones, el paquete por defecto y la política de fábrica (2026-10-08). `TYCON_PROFILE` se respeta como en
 * `cargar` (una ruta explícita es «el perfil»; `0` es «sin perfil»).
 * @returns {{ estado: 'ausente'|'leido'|'roto'|'anulado', ruta: string|null, entradas: Array<{ ruta: string, seccion: string, clave: string, valor: any }>, errores: Array<{archivo, clave, motivo}>, aviso?: string|null }}
 *   `aviso`: la línea suave sobre el nombre del archivo (el de antes, o los dos; ver `avisoNombrePerfil`).
 *   `entradas` lleva cada valor con su ruta interna (`integraciones.engram`) y la sección y la clave CON EL NOMBRE DEL
 *   ARCHIVO de hoy (`integrations`, `engram`): lo que se escribe en otro archivo.
 */
function leerPerfil({ arnes, home = os.homedir(), env = process.env } = {}) {
  const rp = rutaPerfil(env, arnes || RAIZ_ARNES, home);
  if (rp.anulado) return { estado: 'anulado', ruta: null, entradas: [], errores: [] };
  const lp = leerJson(rp.ruta);
  if (lp.estado === 'roto') return { estado: 'roto', ruta: rp.ruta, entradas: [], errores: [{ archivo: rp.ruta, clave: null, motivo: lp.motivo }] };
  if (lp.estado === 'ausente') {
    if (rp.explicito) return { estado: 'roto', ruta: rp.ruta, entradas: [], errores: [{ archivo: rp.ruta, clave: null, motivo: 'TYCON_PROFILE apunta a un archivo que no existe' }] };
    return { estado: 'ausente', ruta: rp.ruta, entradas: [], errores: [] };
  }
  const v = sinAnotar(() => validarArchivo(lp.datos, { archivo: rp.ruta, esPerfil: true, home }));
  if (v.errores.length) return { estado: 'roto', ruta: rp.ruta, entradas: [], errores: v.errores };
  // `plano` ya trae cada clave con su nombre de hoy (validarArchivo pasa la vieja a la nueva); la sección, al del archivo
  const entradas = Object.entries(v.plano).map(([ruta, valor]) => {
    const [seccion, clave] = ruta.split('.');
    return { ruta, seccion: enArchivo(seccion), clave, valor };
  });
  return { estado: 'leido', ruta: rp.ruta, entradas, errores: [], aviso: avisoNombrePerfil(rp) };
}

/** @returns {{estado:'ausente'|'leido'|'roto', datos?:object, motivo?:string}} */
function leerJson(ruta) {
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { estado: 'ausente' };
    return { estado: 'roto', motivo: `no se pudo leer (${(e && e.code) || e.message})` };
  }
  let datos;
  try { datos = JSON.parse(texto.replace(/^﻿/, '')); }
  catch (e) { return { estado: 'roto', motivo: `JSON ilegible (${e.message})` }; }
  if (!esObjeto(datos)) return { estado: 'roto', motivo: 'el contenido tiene que ser un objeto JSON' };
  return { estado: 'leido', datos };
}

/** Motivo si el valor es personal por su forma, o null. */
function formaPersonal(valor) {
  if (typeof valor !== 'string') return null;
  const v = valor.trim();
  for (const [re, motivo] of FORMAS_PERSONALES) if (re.test(v)) return motivo;
  return null;
}

/**
 * Valida un archivo contra el vocabulario y devuelve las claves planas (`seccion.clave` → valor).
 * `esPerfil` agrega la regla de lo personal (AC 3).
 */
/**
 * Las secciones del archivo con su nombre de adentro (`paths` → `rutas`, `integrations` → `integraciones`; el nombre viejo
 * también vale). Las dos formas de la misma sección con contenido distinto → error, y esa sección no se lee.
 */
/** Igualdad por contenido, sin importar el orden de las claves de un objeto. */
function mismoValor(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => mismoValor(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && mismoValor(a[k], b[k]));
}

/**
 * El cuerpo de una sección con sus claves en el nombre de hoy, para comparar las dos formas de la sección: `{mailbox: true}`
 * y `{<su nombre viejo>: true}` dicen lo mismo. Si dos claves caen en el mismo nombre de hoy, el cuerpo queda como vino:
 * ese choque lo nombra después la validación de las claves.
 */
function cuerpoDeHoy(seccion, cuerpo) {
  if (!esObjeto(cuerpo)) return cuerpo;
  const out = {};
  for (const k of Object.keys(cuerpo)) {
    const hoy = claveDeHoy(seccion, k);
    if (tiene(out, hoy)) return cuerpo;
    out[hoy] = cuerpo[k];
  }
  return out;
}

function seccionesDeArchivo(datos, archivo, errores, home) {
  const out = {};
  const vista = {};   // sección de adentro → nombre con que vino
  const viejas = [];  // los nombres viejos de sección que trae el archivo, vengan primero o después
  for (const clave of Object.keys(datos)) {
    const seccion = SECCION_DE_ARCHIVO[clave] || clave;
    if (clave !== enArchivo(seccion)) viejas.push([clave, seccion]);
    if (!Object.prototype.hasOwnProperty.call(out, seccion)) { out[seccion] = datos[clave]; vista[seccion] = clave; continue; }
    if (!mismoValor(cuerpoDeHoy(seccion, out[seccion]), cuerpoDeHoy(seccion, datos[clave]))) {
      errores.push({ archivo, clave: enArchivo(seccion), motivo: `«${enArchivo(seccion)}» y su nombre viejo «${seccion}» están los dos con valores distintos — dejá sólo «${enArchivo(seccion)}»` });
      out[seccion] = undefined;
    }
  }
  // el nombre viejo de una sección se sigue leyendo en silencio; se anota el uso para saber cuándo retirarlo, también si
  // viene junto al nuevo (en cualquier orden: antes sólo se anotaba si venía primero). Adentro de `sinAnotar`, no
  for (const [vino, seccion] of viejas) {
    if (legacy && !sinAnotarNivel) {
      try { legacy.recordUse({ kind: 'key', old: vino, new: enArchivo(seccion), script: 'scripts/lib/tycon-config.js' }, { home }); } catch (_) { /* anotar nunca rompe */ }
    }
  }
  return { datos: Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)), vista };
}

/** Los ajustes de la organización que declara la integración `nombre` (`{ clave: tipo }`), o null si no hay tal. */
function ajustesDeIntegracion(nombre) {
  if (!integ || tiene(VOCABULARIO.integraciones, nombre)) return null;
  try { return integ.profileSettings(nombre); } catch (_) { return null; }
}
/** Los motivos por los que el manifiesto de la integración `nombre` no vale, o null si no hay uno roto con ese nombre. */
function problemaDeIntegracion(nombre) {
  if (!integ) return null;
  // si los manifiestos no se pueden leer, el motivo es ése (no «no hay uno roto»)
  try { const p = integ.listManifests().problems.find((x) => x.name === nombre); return p ? p.reasons : null; } catch (e) { return [`no se pudieron leer los manifiestos (${e.code || e.message})`]; }
}
/** Los secretos (`nombre.clave`) que declara la integración `nombre`. */
function secretosDeSeccion(nombre) {
  if (!integ) return [];
  try { return integ.secretKeys().filter((s) => s.integration === nombre).map((s) => s.key); } catch (_) { return []; }
}
/** El objeto de ajustes de una integración: cada clave declarada y de su tipo. */
function validarAjustes(ajustes, valor, rutaEnArchivo) {
  if (!esObjeto(valor)) return { errores: [{ clave: rutaEnArchivo, motivo: `tiene que ser un objeto con sus ajustes (${Object.keys(ajustes).join(', ') || 'ninguno'})` }] };
  const errores = [];
  const out = {};
  for (const k of Object.keys(valor)) {
    if (esComentario(k)) continue;
    if (!tiene(ajustes, k)) { errores.push({ clave: `${rutaEnArchivo}.${k}`, motivo: `clave desconocida (válidas: ${Object.keys(ajustes).join(', ') || 'ninguna'})` }); continue; }
    const err = validarTipo(ajustes[k], valor[k]);
    if (err) { errores.push({ clave: `${rutaEnArchivo}.${k}`, motivo: err }); continue; }
    out[k] = ajustes[k] === 'canales' ? valor[k].map((c) => c.trim()) : ajustes[k] === 'puerto' ? valor[k] : String(valor[k]).trim();
  }
  return { errores, valor: out };
}

function validarArchivo(datos0, { archivo, esPerfil, home }) {
  const errores = [];
  const plano = {};
  const retiradas = [];
  const { datos, vista } = seccionesDeArchivo(datos0, archivo, errores, home);
  // los errores nombran la sección como está escrita en ESE archivo (la persona busca lo que escribió)
  const comoVino = (seccion) => vista[seccion] || enArchivo(seccion);
  for (const seccion of Object.keys(datos)) {
    if (esComentario(seccion)) {
      // AC 3 también vale para los comentarios del perfil: un email, un chat o un token en `__doc` es lo mismo
      const m = esPerfil ? personalEnComentario(datos[seccion]) : null;
      if (m) errores.push({ archivo, clave: seccion, motivo: m });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(VOCABULARIO, seccion) && secretosDeSeccion(seccion).length) {
      errores.push({ archivo, clave: seccion, motivo: `«${seccion}» es de una integración y lleva secretos: no va en este archivo — se guarda con \`harness.js config set ${secretosDeSeccion(seccion)[0]}\`, aparte, sólo para tu usuario` });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(VOCABULARIO, seccion)) {
      errores.push({ archivo, clave: seccion, motivo: `clave desconocida (secciones válidas: ${Object.keys(VOCABULARIO).map(enArchivo).join(', ')})` });
      continue;
    }
    const cuerpo = datos[seccion];
    if (!esObjeto(cuerpo)) { errores.push({ archivo, clave: comoVino(seccion), motivo: 'tiene que ser un objeto con sus claves adentro' }); continue; }
    for (const claveEscrita of Object.keys(cuerpo)) {
      // la clave con su nombre de hoy: una vieja sola se lee en silencio (y se anota el uso); la vieja y la nueva juntas
      // valen si dicen lo mismo, y si no son un error del archivo y ninguna de las dos se lee
      const clave = claveDeHoy(seccion, claveEscrita);
      if (clave !== claveEscrita) {
        // se anota siempre, también junto a la nueva: al retiro, esa máquina tiene que haber figurado en el registro
        anotarViejo('key', claveEscrita, clave, home);
        if (tiene(cuerpo, clave)) {
          if (!mismoValor(cuerpo[clave], cuerpo[claveEscrita])) errores.push({ archivo, clave: `${comoVino(seccion)}.${clave}`, motivo: `«${clave}» y su nombre viejo «${claveEscrita}» están los dos con valores distintos — dejá sólo «${clave}»` });
          continue;   // la nueva se lee en su vuelta (o ninguna, si chocan)
        }
      } else if (clavesViejasDe(seccion, clave).some((vieja) => tiene(cuerpo, vieja) && !mismoValor(cuerpo[vieja], cuerpo[clave]))) {
        continue;   // choca con su nombre viejo: el error ya salió (o sale) en la vuelta de la vieja
      }
      const ruta = `${seccion}.${clave}`;
      const rutaEnArchivo = `${comoVino(seccion)}.${claveEscrita}`;
      if (esComentario(clave)) {
        const m = esPerfil ? personalEnComentario(cuerpo[clave]) : null;
        if (m) errores.push({ archivo, clave: rutaEnArchivo,motivo: m });
        continue;
      }
      const valor = cuerpo[claveEscrita];
      if (esPerfil && seccion === 'telegram') {
        errores.push({ archivo, clave: rutaEnArchivo,motivo: 'valor personal: un chat de Telegram es de una persona, no del equipo — va en ~/.claude/tycon.json o en TYCON_TELEGRAM_CHAT_ID' });
        continue;
      }
      if (esPerfil && seccion === 'github') {
        errores.push({ archivo, clave: rutaEnArchivo, motivo: 'valor personal: un permiso de GitHub es de una persona, no del equipo — se guarda con `harness.js config set github.token`, nunca en un archivo versionado' });
        continue;
      }
      if (esPerfil && seccion === 'azure') {
        errores.push({ archivo, clave: rutaEnArchivo, motivo: 'valor personal: un PAT de Azure DevOps es de una persona, no del equipo — se guarda con `harness.js config set azure.token`, nunca en un archivo versionado' });
        continue;
      }
      if (esPerfil && seccion === 'models') {
        errores.push({ archivo, clave: rutaEnArchivo, motivo: 'el proveedor de modelos es de la máquina, no del equipo — va en ~/.claude/tycon.json (`tycon-config.js set models.provider <proveedor>`) o en TYCON_MODEL_PROVIDER' });
        continue;
      }
      if (esPerfil && seccion === 'rutas') {
        errores.push({ archivo, clave: rutaEnArchivo,motivo: 'una ruta es de la máquina, no del equipo — va en ~/.claude/tycon.json o en su variable (TYCON_GUIDES_DIR / TYCON_REPOS_ROOT / TYCON_TREE)' });
        continue;
      }
      const tipo = VOCABULARIO[seccion][clave];
      const ajustes = !tipo && seccion === 'integraciones' ? ajustesDeIntegracion(clave) : null;
      if (ajustes) {
        const r = validarAjustes(ajustes, valor, rutaEnArchivo);
        if (r.errores.length) { errores.push(...r.errores.map((e) => Object.assign({ archivo }, e))); continue; }
        plano[ruta] = r.valor;
        continue;
      }
      const rota = !tipo && seccion === 'integraciones' ? problemaDeIntegracion(clave) : null;
      if (rota) { errores.push({ archivo, clave: rutaEnArchivo, motivo: `la integración «${clave}» tiene el manifiesto roto (${rota.join('; ')}): sus ajustes no se pueden validar` }); continue; }
      if (!tipo) {
        const motivo = NOMBRES_PERSONALES.includes(String(clave).toLowerCase())
          ? `valor personal (la clave «${clave}» nombra un dato de una persona: va en ~/.claude/tycon.json o en su variable), y además no está en el vocabulario`
          : `clave desconocida (válidas en «${comoVino(seccion)}»: ${Object.keys(VOCABULARIO[seccion]).join(', ')})`;
        errores.push({ archivo, clave: rutaEnArchivo,motivo });
        continue;
      }
      if (tipo === 'retirada') { retiradas.push({ archivo, clave: rutaEnArchivo, motivo: RETIRADAS[ruta] || 'ya no hace nada' }); continue; }
      const err = validarTipo(tipo, valor);
      if (err) { errores.push({ archivo, clave: rutaEnArchivo,motivo: err }); continue; }
      if (esPerfil) {
        // en una lista de máquinas, el texto libre es el nombre de cada una: pasa por la misma regla
        const forma = tipo === 'maquinas' ? valor.map((m) => formaPersonal(m.label)).find(Boolean) : formaPersonal(valor);
        if (forma) { errores.push({ archivo, clave: rutaEnArchivo,motivo: `valor personal (${forma}): va en ~/.claude/tycon.json o en su variable, nunca en un archivo versionado` }); continue; }
      }
      if (tipo === 'llave-o-detectar' && valor !== DETECT && esDetect(valor)) anotarViejo('value', valor, DETECT, home);
      plano[ruta] = normalizarValor(tipo, valor, home, ruta);
    }
  }
  return { errores, plano, retiradas };
}

/** null si el valor es del tipo; si no, el motivo. */
function validarTipo(tipo, valor) {
  switch (tipo) {
    case 'llave':
      return typeof valor === 'boolean' ? null : `tiene que ser un booleano (true/false), no ${JSON.stringify(valor)}`;
    case 'llave-o-detectar':
      return (typeof valor === 'boolean' || esDetect(valor)) ? null : `tiene que ser true, false o "${DETECT}", no ${JSON.stringify(valor)}`;
    case 'url':
      // la dirección de una instancia: https, o http sólo hacia esta máquina (para probar); un secreto nunca viaja en claro
      return (typeof valor === 'string' && /^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/\S*)?$/.test(valor.trim())) ? null : `tiene que empezar con https:// (o http://localhost para probar), no ${JSON.stringify(valor)}`;
    case 'texto':
    case 'ruta':
      return (typeof valor === 'string' && valor.trim()) ? null : `tiene que ser un texto no vacío, no ${JSON.stringify(valor)}`;
    case 'rutas':
      if (typeof valor === 'string' && valor.trim()) return null;
      return (Array.isArray(valor) && valor.length && valor.every((v) => typeof v === 'string' && v.trim())) ? null : `tiene que ser una ruta o una lista de rutas (textos no vacíos), no ${JSON.stringify(valor)}`;
    case 'secreto':
      // el motivo nunca repite el valor (ni un pedazo): llega a la salida de comandos y a registros
      return (typeof valor === 'string' && valor.trim() && !/\s/.test(valor.trim())) ? null : 'tiene que ser un texto sin espacios (el valor no se muestra)';
    case 'paquetes':
      return motivoPaquetes(valor);
    case 'canales': {
      // los canales de aviso: una lista, vacía para ninguno; un canal inventado es un error
      if (!Array.isArray(valor)) return `tiene que ser una lista de canales (${CANALES_DE_AVISO.join(', ')}; vacía para ninguno), no ${JSON.stringify(valor)}`;
      const malo = valor.find((c) => typeof c !== 'string' || !CANALES_DE_AVISO.includes(c.trim()));
      if (malo !== undefined) return `${JSON.stringify(malo)} no es un canal de aviso (${CANALES_DE_AVISO.join(', ')})`;
      return new Set(valor.map((c) => c.trim())).size === valor.length ? null : `la lista repite un canal: ${JSON.stringify(valor)}`;
    }
    case 'plataforma': {
      // un objeto con las áreas del contrato, cada una con el nombre de un conector; nada más (una credencial acá es
      // una clave desconocida: las credenciales son de cada máquina)
      if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) return `tiene que ser un objeto con las áreas (${AREAS_PLATAFORMA.join(', ')}), por ejemplo {"default": "github"}, no ${JSON.stringify(valor)}`;
      const claves = Object.keys(valor).filter((k) => !esComentario(k));
      if (!claves.length) return `no elige ninguna plataforma: al menos {"default": "<conector>"}`;
      const otra = claves.find((k) => !AREAS_PLATAFORMA.includes(k));
      if (otra !== undefined) return `«${otra}» no es un área de la plataforma (${AREAS_PLATAFORMA.join(', ')})`;
      const mala = claves.find((k) => !(typeof valor[k] === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(valor[k].trim().toLowerCase())));
      return mala === undefined ? null : `${mala}: tiene que ser el nombre de un conector (minúsculas, números y guiones), no ${JSON.stringify(valor[mala])}`;
    }
    case 'puerto':
      return (Number.isInteger(valor) && valor >= 1 && valor <= 65535) ? null : `tiene que ser un puerto (un entero de 1 a 65535), no ${JSON.stringify(valor)}`;
    case 'maquinas': {
      // las máquinas donde vale la firma por delegación: la huella de machine-id.js y un nombre para la persona
      const forma = 'una lista no vacía de {"id": "<16 hex de machine-id.js>", "label": "<nombre>"}';
      if (!Array.isArray(valor) || !valor.length) return `tiene que ser ${forma}, no ${JSON.stringify(valor)}`;
      for (const m of valor) {
        if (!esObjeto(m) || Object.keys(m).some((k) => k !== 'id' && k !== 'label')) return `cada máquina es {"id", "label"} y nada más, no ${JSON.stringify(m)}`;
        if (typeof m.id !== 'string' || !HUELLA_DE_MAQUINA.test(m.id.trim())) return `«${m.id}» no es una huella de machine-id.js (16 caracteres hexadecimales en minúsculas)`;
        if (typeof m.label !== 'string' || !m.label.trim()) return `la máquina ${m.id} no tiene nombre (label)`;
        // un nombre corto para la persona, sin forma de dato: ni @, ni dos puntos, ni signos de un token o una dirección
        if (!NOMBRE_DE_MAQUINA.test(m.label.trim())) return `el nombre de la máquina ${m.id} tiene que ser corto (hasta 40) y de letras, números, espacios, puntos, guiones o paréntesis`;
      }
      const ids = valor.map((m) => m.id.trim());
      return new Set(ids).size === ids.length ? null : `la lista repite una máquina: ${JSON.stringify(ids)}`;
    }
    case 'ruta-absoluta':
      if (!(typeof valor === 'string' && valor.trim())) return `tiene que ser un texto no vacío, no ${JSON.stringify(valor)}`;
      return esRutaAbsoluta(valor) ? null : `tiene que ser una ruta absoluta (o con ~), no ${JSON.stringify(valor)}: una relativa no se resuelve contra nada`;
    default: {
      const rango = rangoDe(tipo);
      if (rango) return (Number.isInteger(valor) && valor >= rango[0] && valor <= rango[1]) ? null : `tiene que ser un entero entre ${rango[0]} y ${rango[1]}, no ${JSON.stringify(valor)}`;
      const opciones = optionsOf(tipo);
      if (opciones) return (typeof valor === 'string' && opciones.includes(valor.trim())) ? null : `tiene que ser uno de: ${opciones.join(', ')} — no ${JSON.stringify(valor)}`;
      const varias = subsetOf(tipo);
      if (varias) return motivoDeOpciones(varias, valor);
      return `tipo desconocido en el vocabulario: ${tipo}`;
    }
  }
}

/** null si `valor` es una opción de `varias`, o una lista no vacía de ellas sin repetir, con `off` sólo si va solo. */
function motivoDeOpciones(varias, valor) {
  const lista = Array.isArray(valor) ? valor : [valor];
  const como = `uno de: ${varias.join(', ')}, o una lista de ellos`;
  if (!lista.length) return `tiene que ser ${como}; una lista vacía no dice nada (para ninguna, «off» o sin valor)`;
  const malo = lista.find((v) => typeof v !== 'string' || !varias.includes(v.trim()));
  if (malo !== undefined) return `tiene que ser ${como} — no ${JSON.stringify(malo)}`;
  const limpios = lista.map((v) => v.trim());
  if (new Set(limpios).size !== limpios.length) return `la lista repite un valor: ${JSON.stringify(valor)}`;
  if (limpios.includes('off') && limpios.length > 1) return `«off» va solo: con otro valor no se sabe qué se quiso decir (${JSON.stringify(valor)})`;
  return null;
}

/** ¿El perfil delega la firma `firma`? Lee el valor solo y la lista igual; `off`, sin valor o una clave rota: no. */
function delegaFirma(valores, firma) {
  const v = valores && valores.approvals ? valores.approvals.delegated_signing : null;
  const lista = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
  return firma !== 'off' && lista.includes(firma);
}

/** El valor de una clave según el entorno: `{ valor, variable }`, `{ error }` o null si ninguna variable está. */
function valorDeEntorno(env, clave, tipo, home) {
  for (const variable of VARIABLES[clave] || []) {
    const crudo = leerVariable(env, variable);
    if (crudo === undefined || String(crudo).trim() === '') continue;
    const v = String(crudo).trim();
    if (tipo === 'llave' || tipo === 'llave-o-detectar') {
      if (v === '1') return { valor: true, variable };
      if (v === '0') return { valor: false, variable };
      if (tipo === 'llave-o-detectar' && esDetect(v)) {
        if (v !== DETECT) anotarViejo('value', v, DETECT, home);
        return { valor: DETECT, variable };
      }
      return { error: { archivo: 'entorno', clave: variable, motivo: `vale «${v}»; tiene que ser 0 o 1${tipo === 'llave-o-detectar' ? ` (o ${DETECT})` : ''}` } };
    }
    if (tipo === 'paquetes') {
      const p = paquetesDeTexto(v);
      return p.motivo ? { error: { archivo: 'entorno', clave: variable, motivo: `vale ${p.motivo}` } } : { valor: p.valor, variable };
    }
    const rango = rangoDe(tipo);
    if (rango) {
      const n = /^\d+$/.test(v) ? Number(v) : NaN;
      if (n >= rango[0] && n <= rango[1]) return { valor: n, variable };
      return { error: { archivo: 'entorno', clave: variable, motivo: `vale «${v}»; tiene que ser un entero entre ${rango[0]} y ${rango[1]}` } };
    }
    const opciones = optionsOf(tipo);
    if (opciones) {
      // un valor cerrado fuera de la lista es configuración ROTA, no el default (story 8.13: `nightly` no es «stable»)
      if (opciones.includes(v)) return { valor: v, variable };
      return { error: { archivo: 'entorno', clave: variable, motivo: `vale «${v}»; tiene que ser ${opciones.join(' o ')}` } };
    }
    // una ruta que tiene que ser absoluta (`paths.tree`, story 8.13.1): relativa por variable también es un error
    if (tipo === 'ruta-absoluta' && !esRutaAbsoluta(v)) {
      return { error: { archivo: 'entorno', clave: variable, motivo: `vale «${v}»; tiene que ser una ruta absoluta (o con ~)` } };
    }
    // la misma normalización que un valor de archivo: una ruta relativa por variable también va contra el HOME (vuelta 2)
    return { valor: normalizarValor(tipo, v, home, clave), variable };
  }
  return null;
}

/** El chat de Telegram que ya vive en los archivos del plugin (mismo criterio que tycon-telegram-notify.sh). */
function chatDelPlugin(home) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'channels', 'telegram', 'access.json'), 'utf8'));
    const a = Array.isArray(d.allowFrom) ? d.allowFrom : [];
    return a.length ? String(a[0]) : null;
  } catch (_) { return null; }
}

/** Dónde está la llave del buzón: `TYCON_MAILBOX_JSON` (la misma variable que lee upload-runs.js) o la del propio clon.
 *  Así las pruebas «sin nada» corren sin llave desde el clon interno, que la trae (AC 9, T9). */
function rutaLlaveBuzon(env, arnes) {
  const llave = leerVariable(env, 'TYCON_MAILBOX_JSON');
  const v = llave === undefined ? '' : String(llave).trim();
  return v ? path.resolve(v) : path.join(arnes, ...LLAVE_BUZON);
}

/** El lugar del arnés: ~/.claude/tycon-harness y, si falta o está colgado, el nombre viejo (8.3 AC 4, 8.19 AC 9). Sólo
 *  se mira; lo crea el instalador. Con sólo el viejo devuelve el del viejo, sin decir nada más. */
function estadoEnlace({ home, arnes }) {
  const place = oneNameState({ home, arnes, nombre: PLACE_NAME });
  if (place.estado !== 'falta' && place.estado !== 'colgado') return place;
  const legacy = oneNameState({ home, arnes, nombre: LEGACY_PLACE_NAME });
  return legacy.estado === 'ok' || legacy.estado === 'otro-clon' ? legacy : place;
}
function oneNameState({ home, arnes, nombre }) {
  const ruta = path.join(home, '.claude', nombre);
  let st;
  try { st = fs.lstatSync(ruta); } catch (_) { return { ruta, estado: 'falta', destino: null }; }
  if (!st.isSymbolicLink()) return { ruta, estado: st.isDirectory() ? 'carpeta' : 'otro', destino: null };
  let destino;
  try { destino = fs.readlinkSync(ruta); } catch (_) { destino = null; }
  const rd = real(ruta);
  if (!rd) return { ruta, estado: 'colgado', destino };
  const ra = real(arnes);
  return { ruta, estado: ra && rd === ra ? 'ok' : 'otro-clon', destino: rd };
}

// ── la carga ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Resuelve toda la configuración. NO tira: devuelve `errores` (vacío si está sana). Quien es comando usa
 * `leer()`; quien es hook usa `leerParaHook()`.
 * @param {object} [opts] env (default process.env) · home (default os.homedir()) · arnes (default el clon donde vive este archivo)
 */
function cargar(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const arnes = opts.arnes || RAIZ_ARNES;
  const errores = [];
  const retiradas = [];

  const rm = rutaMaquina(home);
  const lm = leerJson(rm);
  let planoMaquina = {};
  if (lm.estado === 'roto') errores.push({ archivo: rm, clave: null, motivo: lm.motivo });
  else if (lm.estado === 'leido') {
    const v = validarArchivo(lm.datos, { archivo: rm, esPerfil: false, home });
    errores.push(...v.errores); planoMaquina = v.plano; retiradas.push(...v.retiradas);
  }

  const rp = rutaPerfil(env, arnes, home);
  let estadoPerfil = rp.anulado ? 'anulado' : 'ausente';
  let planoPerfil = {};
  if (rp.ruta) {
    const lp = leerJson(rp.ruta);
    if (lp.estado === 'roto') { estadoPerfil = 'roto'; errores.push({ archivo: rp.ruta, clave: null, motivo: lp.motivo }); }
    else if (lp.estado === 'ausente' && rp.explicito) { estadoPerfil = 'roto'; errores.push({ archivo: rp.ruta, clave: null, motivo: 'TYCON_PROFILE apunta a un archivo que no existe' }); }
    else if (lp.estado === 'leido') {
      estadoPerfil = 'leido';
      const v = validarArchivo(lp.datos, { archivo: rp.ruta, esPerfil: true, home });
      errores.push(...v.errores); planoPerfil = v.plano; retiradas.push(...v.retiradas);
    }
  }

  // Las claves que vale sólo el perfil del equipo (PROFILE_ONLY) salen del perfil del ÁRBOL del arnés: ni
  // `TYCON_PROFILE=<ruta>` ni `TYCON_PROFILE=0` las cambian (una variable la puede poner el agente que implementa).
  let planoArbol = planoPerfil;
  if (rp.explicito || rp.anulado) {
    planoArbol = {};
    const pa = perfilDelArbol(arnes);
    const la = pa.ruta ? leerJson(pa.ruta) : { estado: 'ausente' };
    if (la.estado === 'roto') errores.push({ archivo: pa.ruta, clave: null, motivo: la.motivo });
    else if (la.estado === 'leido') {
      const v = validarArchivo(la.datos, { archivo: pa.ruta, esPerfil: true, home });
      // de ese perfil sólo importan las claves que vale sólo él: un error en otra clave lo dice su propia lectura
      for (const e of v.errores) if (PROFILE_ONLY.some((r) => String(e.clave || '').startsWith(r.split('.')[0]))) errores.push(e);
      for (const r of PROFILE_ONLY) if (Object.prototype.hasOwnProperty.call(v.plano, r)) planoArbol[r] = v.plano[r];
    }
  }

  const valores = Object.fromEntries(Object.keys(VOCABULARIO).map((s) => [s, {}]));
  const origenes = {};
  const variables = {};
  // lo que el archivo de la máquina tiene escrito y NO se usa porque el perfil del equipo gana en esa clave (story 8.29):
  // `{ 'packs.default': { value, origin: 'maquina', by: 'perfil' } }`. Se anota aunque los dos digan lo mismo, y aunque
  // una variable le gane a los dos: es un dato del archivo, no del valor vigente.
  const shadowed = {};
  const llaveBuzon = rutaLlaveBuzon(env, arnes);
  const hayLlaveBuzon = fs.existsSync(llaveBuzon);
  for (const seccion of Object.keys(VOCABULARIO)) {
    for (const clave of Object.keys(VOCABULARIO[seccion])) {
      const ruta = `${seccion}.${clave}`;
      const tipo = VOCABULARIO[seccion][clave];
      const esLlave = tipo === 'llave' || tipo === 'llave-o-detectar';
      const enMaquina = Object.prototype.hasOwnProperty.call(planoMaquina, ruta);
      const ganaElPerfil = PROFILE_WINS.includes(ruta) && Object.prototype.hasOwnProperty.call(planoPerfil, ruta);
      if (ganaElPerfil && enMaquina) shadowed[ruta] = { value: planoMaquina[ruta], origin: 'maquina', by: 'perfil' };
      if (PROFILE_ONLY.includes(ruta)) {
        if (enMaquina) shadowed[ruta] = { value: planoMaquina[ruta], origin: 'maquina', by: 'solo-perfil' };
        else if (rp.explicito && Object.prototype.hasOwnProperty.call(planoPerfil, ruta) && !mismoValorPlano(planoPerfil[ruta], planoArbol[ruta])) {
          shadowed[ruta] = { value: planoPerfil[ruta], origin: 'TYCON_PROFILE', by: 'solo-perfil' };
        }
        if (Object.prototype.hasOwnProperty.call(planoArbol, ruta)) { valores[seccion][clave] = planoArbol[ruta]; origenes[ruta] = 'perfil'; }
        else if (Object.prototype.hasOwnProperty.call(DEFAULTS, ruta)) { valores[seccion][clave] = DEFAULTS[ruta]; origenes[ruta] = 'default'; }
        else { valores[seccion][clave] = null; origenes[ruta] = 'sin-valor'; }
        continue;
      }
      const e = valorDeEntorno(env, ruta, tipo, home);
      if (e && e.error) { errores.push(e.error); }
      if (e && !e.error) { valores[seccion][clave] = e.valor; origenes[ruta] = 'env'; variables[ruta] = e.variable; continue; }
      if (ganaElPerfil) { valores[seccion][clave] = planoPerfil[ruta]; origenes[ruta] = 'perfil'; continue; }
      if (Object.prototype.hasOwnProperty.call(planoMaquina, ruta)) { valores[seccion][clave] = planoMaquina[ruta]; origenes[ruta] = 'maquina'; continue; }
      if (Object.prototype.hasOwnProperty.call(planoPerfil, ruta)) { valores[seccion][clave] = planoPerfil[ruta]; origenes[ruta] = 'perfil'; continue; }
      // los orígenes derivados, dichos como tales
      if (ruta === 'telegram.chat_id') {
        const chat = chatDelPlugin(home);
        if (chat) { valores[seccion][clave] = chat; origenes[ruta] = 'plugin'; continue; }
      }
      if (ruta === 'integraciones.mailbox' && hayLlaveBuzon) {
        valores[seccion][clave] = true; origenes[ruta] = 'archivo-llave'; continue;
      }
      // las claves que siempre tienen un valor (la política de actualización): el default, dicho como tal
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, ruta)) { valores[seccion][clave] = tipo === 'ruta-absoluta' ? normalizarValor(tipo, DEFAULTS[ruta], home, ruta) : DEFAULTS[ruta]; origenes[ruta] = 'default'; continue; }
      valores[seccion][clave] = esLlave ? false : null;
      origenes[ruta] = esLlave ? 'apagado' : 'sin-valor';
    }
  }

  // los ajustes de cada integración (`integrations.<nombre>`): los del perfil, con los de la máquina encima, clave por clave
  for (const ruta of new Set([...Object.keys(planoPerfil), ...Object.keys(planoMaquina)])) {
    const [seccion, clave] = ruta.split('.');
    if (seccion !== 'integraciones' || tiene(VOCABULARIO.integraciones, clave)) continue;
    const dePerfil = esObjeto(planoPerfil[ruta]) ? planoPerfil[ruta] : {};
    const deMaquina = esObjeto(planoMaquina[ruta]) ? planoMaquina[ruta] : {};
    valores.integraciones[clave] = Object.assign({}, dePerfil, deMaquina);
    origenes[ruta] = Object.keys(deMaquina).length ? 'maquina' : 'perfil';
  }

  // `rutas.arnes`: la variable (la salida explícita que lee agent-skills) o la ubicación de este clon. No sale de
  // ningún archivo: un `rutas.arnes` en tycon.json sería una clave que nadie lee, y el vocabulario la rechaza.
  {
    const e = valorDeEntorno(env, 'rutas.arnes', 'ruta', home);
    if (e && e.error) errores.push(e.error);
    if (e && !e.error) { valores.rutas.arnes = e.valor; origenes['rutas.arnes'] = 'env'; variables['rutas.arnes'] = e.variable; }
    else { valores.rutas.arnes = arnes; origenes['rutas.arnes'] = 'ubicacion'; }
  }
  const entorno = {
    TYCON_SKILLS_DIR: env.TYCON_SKILLS_DIR || null,
    TYCON_PROFILE: leerVariable(env, 'TYCON_PROFILE') === undefined ? null : String(leerVariable(env, 'TYCON_PROFILE')),
    interruptores: Object.fromEntries(INTERRUPTORES_POR_HOOK.map((k) => [k, leerVariable(env, k)]).filter(([, v]) => v !== undefined && String(v) !== '').map(([k, v]) => [k, String(v)])),
  };

  return {
    valores, origenes, variables, errores, retiradas, entorno, shadowed,
    archivos: { maquina: { ruta: rm, estado: lm.estado }, perfil: { ruta: rp.ruta, estado: estadoPerfil, aviso: estadoPerfil === 'ausente' ? null : avisoNombrePerfil(rp) } },
    enlace: estadoEnlace({ home, arnes }),
    buzon: { llave: llaveBuzon, presente: hayLlaveBuzon },
    arnes, home,
  };
}

// ── las ocho integraciones ───────────────────────────────────────────────────────────────────────

/** La llave de una integración con su nombre de hoy: quien pregunta por el de antes recibe lo mismo. */
function llaveDeHoy(llave) { return claveDeHoy('integraciones', llave); }
function esIntegracion(llave) { return LAS_OCHO.includes(llaveDeHoy(llave)); }
/** La llave con su nombre de hoy, o tira si no es una de las ocho. `home`: dónde se anota el uso de un nombre viejo. */
function exigirIntegracion(llave, home) {
  if (!esIntegracion(llave)) throw new Error(`integración desconocida: «${llave}» (válidas: ${LAS_OCHO.join(', ')})`);
  const hoy = llaveDeHoy(llave);
  if (hoy !== llave) anotarViejo('key', llave, hoy, home);
  return hoy;
}
/** El estado de una integración según una configuración YA cargada: `prendida` · `apagada` · `detect` (sólo codex), y su origen. */
function estadoIntegracion(config, llave0) {
  const llave = exigirIntegracion(llave0, config && config.home);
  const v = config.valores;
  const o = config.origenes;
  if (llave === 'ado') return { estado: v.ado.org ? 'prendida' : 'apagada', origen: v.ado.org ? o['ado.org'] : 'sin-valor' };
  if (llave === 'telegram') return { estado: v.telegram.chat_id ? 'prendida' : 'apagada', origen: v.telegram.chat_id ? o['telegram.chat_id'] : 'sin-valor' };
  const val = v.integraciones[llave];
  return { estado: val === DETECT ? DETECT : (val ? 'prendida' : 'apagada'), origen: o[`integraciones.${llave}`] };
}
/** Las ocho de una vez: `{ ado: true, codex: 'detect', … }` (booleano, o `detect` para codex). */
function integraciones(config) {
  const out = {};
  for (const k of LAS_OCHO) { const e = estadoIntegracion(config, k).estado; out[k] = e === DETECT ? DETECT : e === 'prendida'; }
  return out;
}
/**
 * La integración de horas elegida, según una configuración YA cargada: `{ value, origin, legacy }`. `value` es `none` o
 * el nombre tal como está escrito (sin espacios a los lados, en minúsculas); si corresponde a una integración lo decide
 * scripts/lib/work-signal.js. Sin `timeTracking`, la llave vieja `integrations.clockify` dice `true` → `clockify` y
 * `false` → `none` (`legacy: true`, y se anota el uso del nombre viejo).
 */
function timeTracking(config) {
  const v = config.valores.integraciones.timeTracking;
  if (typeof v === 'string' && v.trim()) return { value: v.trim().toLowerCase(), origin: config.origenes['integraciones.timeTracking'], legacy: false };
  const o = config.origenes['integraciones.clockify'];
  if (o && o !== 'apagado') {
    anotarViejo('key', 'integrations.clockify', 'integrations.timeTracking', config.home);
    return { value: config.valores.integraciones.clockify ? 'clockify' : 'none', origin: o, legacy: true };
  }
  return { value: 'none', origin: 'sin-valor', legacy: false };
}
// las áreas de la plataforma del equipo: la copia de AREAS de scripts/lib/platform/contract.js (este lector no carga la
// capa; una prueba compara las dos)
const AREAS_PLATAFORMA = Object.freeze(['default', 'workItems', 'queue']);
/**
 * La plataforma elegida, según una configuración YA cargada: `{ value, origin, problem? }`; `value` null si no eligió
 * ninguna. `TYCON_PLATFORM` (de la máquina) cambia sólo el valor por defecto: las áreas que eligió el perfil se quedan.
 */
function plataforma(config, env = process.env) {
  const v = config.valores.integraciones.platform;
  const base = v && typeof v === 'object' ? { ...v } : null;
  const crudo = leerVariable(env, 'TYCON_PLATFORM');
  const variable = crudo === undefined ? '' : String(crudo).trim().toLowerCase();
  if (variable && !/^[a-z0-9][a-z0-9-]*$/.test(variable)) return { value: base, origin: config.origenes['integraciones.platform'] || 'sin-valor', problem: `TYCON_PLATFORM vale «${crudo}»; tiene que ser el nombre de un conector` };
  if (variable) return { value: { ...(base || {}), default: variable }, origin: 'entorno TYCON_PLATFORM' };
  return base ? { value: base, origin: config.origenes['integraciones.platform'] } : { value: null, origin: 'sin-valor' };
}
/**
 * Cómo contesta el asistente, según una configuración YA cargada: `{ language, style, max_chars, origen:
 * { language, style, max_chars } }`. `max_chars` sin valor es el tope del estilo (origen `estilo`).
 */
/**
 * El proveedor de modelos de esta máquina: `{ provider, origin, problem }`. Gana la variable
 * (`TYCON_MODEL_PROVIDER`, origen `env`), después el archivo de la máquina (`maquina`); sin ninguna, se deriva de la
 * herramienta (`derivado`): una sesión de Codex (`CODEX_SESSION_ID` sin `CLAUDE_CODE_SESSION_ID`) es `openai`, lo demás
 * `anthropic`. Con la clave mal escrita, `provider: null` y `origin: 'rota'`: no cae en el derivado. opts: `config` (ya
 * cargada) o lo de `cargar` (home, env, arnes); `env` para derivar. Nunca tira.
 */
function modelProvider(opts = {}) {
  const env = opts.env || process.env;
  let c = opts.config;
  if (!c) {
    try { c = cargar(opts); } catch (e) { return { provider: null, origin: 'rota', problem: `falla interna del lector (${e.message})` }; }
  }
  // la clave mal escrita en el archivo, o la variable con un valor fuera de la lista (su error lleva el nombre de la variable)
  const err = (c.errores || []).find((e) => e.clave === 'models' || String(e.clave || '').startsWith('models.') || VARIABLES['models.provider'].includes(e.clave));
  if (err) return { provider: null, origin: 'rota', problem: `${err.clave} · ${err.motivo}` };
  const v = c.valores && c.valores.models ? c.valores.models.provider : null;
  const origen = c.origenes ? c.origenes['models.provider'] : null;
  if (v && (origen === 'env' || origen === 'maquina')) return { provider: v, origin: origen, problem: null };
  const codex = Boolean(env.CODEX_SESSION_ID) && !env.CLAUDE_CODE_SESSION_ID;
  return { provider: codex ? 'openai' : 'anthropic', origin: 'derivado', problem: null };
}
function respuesta(config) {
  const r = config.valores.response;
  const o = config.origenes;
  const tope = r.max_chars === null || r.max_chars === undefined ? TOPE_POR_ESTILO[r.style] : r.max_chars;
  return {
    language: r.language, style: r.style, max_chars: tope,
    origen: { language: o['response.language'], style: o['response.style'], max_chars: r.max_chars === null || r.max_chars === undefined ? 'estilo' : o['response.max_chars'] },
  };
}
/**
 * Las llaves de las dos herramientas (story 8.23, tanda C · AC 24), según una configuración YA cargada:
 * `{ claude: { value, origin }, codex: { value, origin } }` con `value` = true · false · 'detect'. `origin: 'apagado'` es
 * «nadie dijo nada» (ni variable, ni archivo, ni perfil): quien decide qué enchufar lo trata como `detect`, no como
 * «apagada a propósito». `detect` sigue a la herramienta INSTALADA (su ejecutable o su configuración propia:
 * scripts/setup/harness/tools.js), no a «ya desplegada».
 */
function toolKeys(config) {
  const out = {};
  for (const t of TOOLS) out[t] = { value: config.valores.integraciones[t], origin: config.origenes[`integraciones.${t}`] };
  return out;
}
/** Modo COMANDO: rota → tira `ConfigError`. `prendida` es true también para `detect`. `apagada` es la línea a imprimir. */
function integracionParaComando(llave0, opts) {
  const llave = exigirIntegracion(llave0, opts && opts.home);
  const c = leer(opts);
  const { estado, origen } = estadoIntegracion(c, llave);
  return { prendida: estado !== 'apagada', estado, origen, apagada: comoSePrende(llave, opts && opts.home, c), config: c };
}
/** Modo HOOK: nunca tira. Rota → `ok:false`, `prendida:false` y el aviso (el hook lo imprime y no hace su parte).
 *  `opts.interruptor` = el interruptor por hook que ya existía (`TYCON_ENGRAM_HOOK`, …): puesto en `1` manda PRENDIDA y en
 *  `0` APAGADA por encima de la llave, en los dos sentidos (decisión de la 8.3; antes `=1` con la llave apagada no hacía nada:
 *  el instalador registraba el hook y el hook igual decía «apagado» — pase adversarial de la tanda B). */
function integracionParaHook(llave0, opts) {
  const llave = exigirIntegracion(llave0, opts && opts.home);
  const inter = opts && opts.interruptor;
  const env = (opts && opts.env) || process.env;
  const valorInter = inter && INTERRUPTORES_POR_HOOK.includes(inter) ? leerVariable(env, inter) : undefined;
  if (valorInter !== undefined && (String(valorInter) === '1' || String(valorInter) === '0')) {
    const prendida = String(valorInter) === '1';
    return { ok: true, prendida, estado: prendida ? 'prendida' : 'apagada', origen: `interruptor ${inter}=${valorInter}`, apagada: comoSePrende(llave, opts && opts.home), config: null };
  }
  const r = leerParaHook(opts);
  if (!r.ok) return { ok: false, prendida: false, estado: 'rota', origen: null, aviso: r.aviso, errores: r.errores, apagada: comoSePrende(llave, opts && opts.home) };
  const { estado, origen } = estadoIntegracion(r.config, llave);
  return { ok: true, prendida: estado !== 'apagada', estado, origen, apagada: comoSePrende(llave, opts && opts.home, r.config), config: r.config };
}

/** Modo COMANDO: tira `ConfigError` si hay errores. */
function leer(opts) {
  const c = cargar(opts);
  if (c.errores.length) throw new ConfigError(c.errores);
  return c;
}

/** El aviso que imprime un hook (por stderr, en cada corrida). */
function avisoParaHook(errores) {
  const lista = errores.map((e) => `   · ${e.archivo}${e.clave ? ` · ${e.clave}` : ''} · ${e.motivo}`);
  return [
    '⚠️ tycon: la configuración del arnés está ROTA — este hook no hace su parte hasta que se arregle',
    '   (no frena ni deniega nada por esto; un archivo roto tampoco se lee como «todo apagado»):',
    ...lista,
    '   Verificar con: node scripts/lib/tycon-config.js validate',
  ].join('\n');
}

/** Modo HOOK: nunca tira. `{ ok:true, config }` o `{ ok:false, aviso, errores }`. */
function leerParaHook(opts) {
  let c;
  try { c = cargar(opts); }
  catch (e) { return { ok: false, aviso: avisoParaHook([{ archivo: 'tycon-config.js', clave: null, motivo: `falla interna del lector (${e.message})` }]), errores: [] }; }
  if (c.errores.length) return { ok: false, aviso: avisoParaHook(c.errores), errores: c.errores };
  return { ok: true, config: c };
}

/** `valor(config, 'ado.org')` — la sección con el nombre del archivo (`paths.repos`) o el de adentro (`rutas.repos`).
 *  Quien pregunta por una clave con su nombre de antes recibe lo mismo, y el uso queda anotado (también por `get`). */
function valor(config, clave) {
  const [s0, k0] = String(clave).split('.');
  const s = SECCION_DE_ARCHIVO[s0] || s0;
  const k = claveDeHoy(s, k0);
  if (k !== k0) anotarViejo('key', k0, k, config && config.home);
  return config && config.valores && config.valores[s] ? config.valores[s][k] : undefined;
}

// ── explicar ─────────────────────────────────────────────────────────────────────────────────────

function explicar(opts = {}) {
  const c = cargar(opts);
  const v = c.valores;
  const o = c.origenes;
  const fmt = (x) => (x === null || x === undefined ? '' : Array.isArray(x) ? x.join(', ') : String(x));
  const integracionesTexto = {};
  const estado = (llave) => {
    const val = v.integraciones[llave];
    const texto = val === DETECT ? DETECT : (val ? 'prendida' : 'apagada');
    return `${texto} (${o[`integraciones.${llave}`]}${llave === 'mailbox' && val ? `; llave ${c.buzon.presente ? 'presente' : 'AUSENTE'}` : ''})`;
  };
  for (const llave of INTEGRACIONES) integracionesTexto[llave] = estado(llave);
  // la llave de Claude Code (story 8.23, tanda C) va aparte de INTEGRACIONES pero se muestra igual (clase 26)
  if (v.integraciones && v.integraciones.claude !== undefined && o['integraciones.claude'] !== undefined) integracionesTexto.claude = estado('claude');
  // dos integraciones cuya llave es un dato, no un booleano (tabla de la story): ADO por la organización, Telegram por el chat
  integracionesTexto.ado = v.ado.org ? `prendida (por ado.org, ${o['ado.org']})` : 'apagada (sin ado.org)';
  integracionesTexto.telegram = v.telegram.chat_id ? `prendida (chat por ${o['telegram.chat_id']})` : 'apagada (sin chat)';
  const integraciones = integracionesTexto;

  const enlaceTexto = {
    ok: 'apunta a este clon', falta: 'FALTA (lo crea el instalador)', colgado: `COLGADO → ${c.enlace.destino}`,
    'otro-clon': `apunta a OTRO clon: ${c.enlace.destino} (re-apuntar: install-tycon-hooks.sh --link <ruta>)`,
    carpeta: 'es una carpeta real, no un enlace (no se toca)', otro: 'existe y no es un enlace',
  }[c.enlace.estado];

  if (opts.json) {
    // `shadowed` (story 8.29): lo que el archivo de la máquina tiene escrito y no se usa porque el perfil del equipo gana
    return { valores: v, origenes: o, variables: c.variables, integraciones, archivos: c.archivos, enlace: c.enlace, entorno: c.entorno, errores: c.errores, retiradas: c.retiradas, shadowed: c.shadowed };
  }
  // lo que la máquina tiene escrito y no se usa (story 8.29): se dice sólo cuando lo vigente sale del perfil y DIFIERE
  // —toda máquina instalada con la página pública tiene `all` escrito, y el perfil del equipo también dice `all`: decirlo
  // siempre sería un aviso fijo en todo el equipo—
  const unused = (ruta) => {
    const s = c.shadowed[ruta];
    if (!s || o[ruta] !== s.by || mismoValor(s.value, valor(c, ruta))) return '';
    return `; ${c.archivos.maquina.ruta} dice ${fmt(s.value)} y no se usa: en esta clave gana el perfil del equipo`;
  };
  const L = [];
  L.push(`configuración del arnés · ${os.hostname()} · clon ${c.arnes}`);
  L.push(`  archivo de la máquina: ${c.archivos.maquina.ruta} (${c.archivos.maquina.estado})`);
  L.push(`  perfil del equipo: ${c.archivos.perfil.ruta || '—'} (${c.archivos.perfil.estado === 'anulado' ? 'anulado por TYCON_PROFILE=0' : c.archivos.perfil.estado})`);
  if (c.archivos.perfil.aviso) L.push(`  aviso: ${c.archivos.perfil.aviso}`);
  L.push(`  paths.arnes = ${fmt(v.rutas.arnes)} (${o['rutas.arnes']})   enlace ${c.enlace.ruta}: ${enlaceTexto}`);
  L.push(`  paths.repos = ${v.rutas.repos ? `${v.rutas.repos} (${o['rutas.repos']})` : 'sin valor (la deduce scripts/lib/repos-root.js: sesiones, vecino; si nada la da, «sin raíz»)'}`);
  // la carpeta del árbol gestionado (story 8.13.1): siempre con valor, siempre con origen
  L.push(`  paths.tree = ${fmt(v.rutas.tree)} (${o['rutas.tree']})`);
  L.push(`  ado.org = ${v.ado.org ? `${v.ado.org} (${o['ado.org']})` : 'sin valor'}`);
  L.push(`  telegram.chat_id = ${v.telegram.chat_id ? `${v.telegram.chat_id} (${o['telegram.chat_id']})` : 'sin valor'}`);
  L.push('  integrations:');
  for (const llave of LAS_OCHO) L.push(`    ${llave.padEnd(10)} ${integraciones[llave]}`);
  // la política de actualización (story 8.13): siempre con valor, siempre con origen
  L.push(`  update.channel = ${fmt(v.update.channel)} (${o['update.channel']})`);
  L.push(`  update.apply = ${fmt(v.update.apply)} (${o['update.apply']})`);
  // la llave de la transición a un solo repo (story 8.18): de dónde lee las skills una máquina con dos clones
  L.push(`  update.skills_source = ${fmt(v.update.skills_source)} (${o['update.skills_source']})`);
  // de dónde instala la máquina (story 8.13.1): siempre con valor, siempre con origen
  L.push(`  update.source = ${fmt(v.update.source)} (${o['update.source']})`);
  // los paquetes de revisores en un repo que no declara `packs:` (story 8.7): siempre con valor, siempre con origen
  L.push(`  packs.default = ${fmt(v.packs.default)} (${o['packs.default']}${unused('packs.default')})`);
  // el perfil de instalación (story 8.16): sin valor por defecto; sin elegir, el aplicador se comporta como `full`
  L.push(`  install.profile = ${v.install.profile ? `${v.install.profile} (${o['install.profile']})` : 'sin elegir'}`);
  // dónde vive el arnés (story 8.23, tanda D): sin valor es `claude` (el clon de hoy); `tycon` muda cada máquina sola
  L.push(`  install.home = ${v.install.home ? `${v.install.home} (${o['install.home']})` : 'claude (sin valor: el clon en la carpeta de Claude Code; con tycon, cada máquina se muda sola a ~/.tycon en el arranque)'}`);
  // el proveedor de modelos de la máquina: sin valor, el que sale de la herramienta
  const prov = modelProvider({ config: c, env: opts.env || process.env });
  L.push(`  models.provider = ${prov.provider ? `${prov.provider} (${prov.origin === 'derivado' ? 'derivado: sin declarar, de la herramienta de esta sesión' : prov.origin})` : `ROTO (${prov.problem})`}`);
  // las claves retiradas que un archivo todavía tiene: no hacen nada, se pueden borrar
  for (const r of c.retiradas || []) L.push(`  ${r.clave} (${r.archivo}): ${r.motivo}`);
  // quién puede reenviar el ok de un dev: sólo del perfil; lo que diga la máquina se nombra y no se usa
  {
    const s = c.shadowed['approvals.relay_session'];
    const donde = s && s.origin === 'TYCON_PROFILE' ? `el perfil de TYCON_PROFILE (${c.archivos.perfil.ruta})` : c.archivos.maquina.ruta;
    const ignorado = s ? `; ${donde} dice ${fmt(s.value)} y no se usa: vale sólo desde el perfil del equipo del árbol del arnés` : '';
    L.push(`  approvals.relay_session = ${v.approvals.relay_session ? `${v.approvals.relay_session} (${o['approvals.relay_session']}${ignorado})` : `sin valor (nadie reenvía${ignorado})`}`);
  }
  // la firma delegada y cómo se actualiza el freno: sólo del perfil, como relay_session
  for (const [ruta, sinValor] of [['approvals.delegated_signing', 'off'], ['guard.update', 'password']]) {
    const s = c.shadowed[ruta];
    const donde = s && s.origin === 'TYCON_PROFILE' ? `el perfil de TYCON_PROFILE (${c.archivos.perfil.ruta})` : c.archivos.maquina.ruta;
    const ignorado = s ? `; ${donde} dice ${fmt(s.value)} y no se usa: vale sólo desde el perfil del equipo del árbol del arnés` : '; vale sólo desde el perfil del equipo';
    const [sec, k] = ruta.split('.');
    const val = Array.isArray(v[sec][k]) ? v[sec][k].join(', ') : v[sec][k];
    L.push(`  ${ruta} = ${val || sinValor} (${o[ruta]}${ignorado})`);
  }
  {
    const m = v.approvals.delegated_machines;
    const s = c.shadowed['approvals.delegated_machines'];
    const ignorado = s ? `; ${s.origin === 'TYCON_PROFILE' ? 'el perfil de TYCON_PROFILE' : c.archivos.maquina.ruta} trae otra lista y no se usa` : '';
    L.push(`  approvals.delegated_machines = ${Array.isArray(m) ? `${m.length} máquina(s): ${m.map((x) => x.label).join(', ')}` : 'ninguna'} (${o['approvals.delegated_machines']}${ignorado}; vale sólo desde el perfil del equipo)`);
  }
  const extras = [];
  if (c.entorno.TYCON_SKILLS_DIR) extras.push(`TYCON_SKILLS_DIR=${c.entorno.TYCON_SKILLS_DIR} (lib/skills-dir.js, no es de este lector)`);
  if (c.entorno.TYCON_PROFILE !== null) extras.push(`TYCON_PROFILE=${c.entorno.TYCON_PROFILE}`);
  const inter = Object.entries(c.entorno.interruptores).map(([k, val]) => `${k}=${val}`);
  if (inter.length) extras.push(`interruptores por hook (mandan por encima de la llave): ${inter.join(' · ')}`);
  if (extras.length) L.push(`  variables: ${extras.join(' · ')}`);
  if (c.errores.length) { L.push('  🛑 errores:'); for (const e of c.errores) L.push(`    · ${e.archivo}${e.clave ? ` · ${e.clave}` : ''} · ${e.motivo}`); }
  return L.join('\n');
}

// ── escribir una clave (story 8.16, tanda C · AC 21) ─────────────────────────────────────────────────────────────
// UN escritor de `~/.claude/tycon.json`: `install --profile` escribe el perfil con esto, y desde la tanda D también
// `tycon-config.js set` y `channel.js`. Valida la clave y el tipo contra el vocabulario, no escribe sobre un archivo roto
// (ilegible o que no pasa su validación: se arregla primero), escribe atómico conservando el resto del archivo —también
// el nombre con que ya está escrita cada sección y cada clave— y dice dos cosas que la persona tiene que saber:
//   · si una variable de entorno le gana a lo que acaba de escribir (lo escrito no hace efecto mientras esté puesta);
//   · si el freno de producción instalado tiene un lector de configuración que no conoce la sección: esa copia lee el
//     mismo archivo y rechaza una sección que no conoce, así que va a decir «configuración ROTA» hasta reinstalarlo (la
//     regla de `guardWarning` de scripts/setup/harness/channel.js, generalizada a cualquier sección). Medido el
//     2026-10-04: la copia instalada no lee el perfil del equipo, sólo el archivo de la máquina.
const GUARD_LIB = '/opt/tycon/lib/tycon-config.js';
/** ¿El lector del freno instalado conoce la sección (y, con `clave`, la clave dentro de ella)? `true` (o no hay freno) ·
 *  `false` · el motivo si no se pudo leer (no poder leerlo no es «lo conoce»: se avisa igual, con el motivo). */
function guardKnows(guardLib, seccion, clave) {
  let texto;
  try { texto = fs.readFileSync(guardLib, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return true;   // sin freno instalado: nada que avisar
    return `no pude leerlo (${(e && e.code) || e.message})`;
  }
  // la sección como clave de un objeto, congelado o no (`update: Object.freeze({` o `update: {`): `channel.js` miraba sólo
  // «update:», y desde la tanda D escribe por acá (AC 34: el mismo resultado que antes)
  const cuerpo = new RegExp(`\\b${seccion}\\s*:\\s*(?:Object\\.freeze\\s*\\(\\s*)?\\{([^}]*)\\}`).exec(texto);
  if (!cuerpo) return false;
  // la clave adentro (story 8.13.1): un freno que ya conoce `update` pero no `update.source` rechaza la clave nueva igual
  // que una sección nueva — mirar sólo la sección dejaba escribir `source` o `tree` sin aviso
  return !clave || new RegExp(`(?:^|[\\s,{])${clave}\\s*:`).test(cuerpo[1]);
}
function escribirAtomico(file, texto) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  // los permisos del archivo que se reemplaza se conservan (story 8.23, tanda C): `~/.tycon/config.json` guarda el permiso
  // de GitHub sólo para el usuario (0600), y reescribirlo con los de fábrica lo dejaba legible para todos
  let mode = null;
  try { mode = fs.statSync(file).mode & 0o777; } catch (_) { mode = null; }
  try { fs.writeFileSync(tmpFile, texto, mode === null ? undefined : { mode }); fs.renameSync(tmpFile, file); } catch (e) { try { fs.rmSync(tmpFile, { force: true }); } catch (_) { /* ya no está */ } throw e; }
}
/**
 * Las claves de tipo `secreto` del vocabulario que `datos` trae con valor (`github.token`, `azure.token`…): la lista sale del
 * vocabulario, no de una clave fija — un secreto nuevo entra acá solo (pase adversarial 8.25 A1a-azure: `azure.token` quedaba afuera).
 */
function secretosPresentes(datos) {
  if (!esObjeto(datos)) return [];
  const claves = [];
  for (const [seccion, campos] of Object.entries(VOCABULARIO)) {
    if (!esObjeto(campos)) continue;
    const bloque = esObjeto(datos[seccion]) ? datos[seccion] : (esObjeto(datos[enArchivo(seccion)]) ? datos[enArchivo(seccion)] : null);
    if (!bloque) continue;
    for (const [k, tipo] of Object.entries(campos)) if (tipo === 'secreto' && typeof bloque[k] === 'string' && bloque[k]) claves.push(`${seccion}.${k}`);
  }
  return claves;
}
/**
 * Un archivo de configuración que trae un secreto (el permiso de GitHub, el PAT de Azure DevOps) queda sólo para el usuario,
 * también después de reescribirlo (en Windows el reemplazo hereda los permisos de la carpeta). Lo hace quien sabe hacerlo:
 * github-auth.js, si está al lado del árbol (en la copia del freno no está, y allá ese archivo no existe). Devuelve el aviso, o null.
 */
function restringirSiTraeSecreto(file, datos) {
  const secretos = secretosPresentes(datos);
  if (!secretos.length) return null;
  const que = `trae ${secretos.length === 1 ? 'un secreto' : 'secretos'} (${secretos.join(', ')})`;
  const lib = path.join(__dirname, '..', 'setup', 'harness', 'github-auth.js');
  try {
    if (!fs.existsSync(lib)) { fs.chmodSync(file, 0o600); return null; }
    const r = require(lib).restrictToUser(file);
    return r && r.ok ? null : `no pude dejar ${file} sólo para tu usuario (${(r && r.reason) || 'sin detalle'}): ${que}`;
  } catch (e) { return `no pude dejar ${file} sólo para tu usuario (${e.code || e.message}): ${que}`; }
}
/**
 * Escribe `clave` (`seccion.clave`, con el nombre de archivo de la sección o el de adentro) en `~/.claude/tycon.json`.
 * @returns {{ ok: boolean, file: string, before?: *, after?: *, warning?: string|null, reason?: string }}
 */
function setKey(home = os.homedir(), clave, valorNuevo, { env = process.env, guardLib = null, arnes = null } = {}) {
  // `TYCON_GUARD_LIB_FOR_TEST`: sólo para las pruebas (la copia instalada del freno es de cada máquina)
  guardLib = guardLib || (env && env.TYCON_GUARD_LIB_FOR_TEST) || GUARD_LIB;
  const file = rutaMaquina(home);
  const [s0, k0, ...resto] = String(clave || '').split('.');
  const seccion = SECCION_DE_ARCHIVO[s0] || s0;
  const k = seccion && tiene(VOCABULARIO, seccion) ? claveDeHoy(seccion, k0) : k0;
  if (resto.length || !seccion || !tiene(VOCABULARIO, seccion) || !k || !tiene(VOCABULARIO[seccion], k)) {
    const validas = Object.entries(VOCABULARIO).flatMap(([s, ks]) => Object.keys(ks).map((x) => `${enArchivo(s)}.${x}`));
    return { ok: false, file, reason: `clave desconocida «${clave}» (válidas: ${validas.join(', ')})` };
  }
  const tipo = VOCABULARIO[seccion][k];
  // un secreto no pasa por acá (quedaría en el argv de quien llama y en su historial): lo escribe quien lo lee por stdin
  if (PROFILE_ONLY.includes(`${seccion}.${k}`)) return { ok: false, file, reason: `${enArchivo(seccion)}.${k} vale sólo desde el perfil del equipo (team-profile.json, con un pedido al repo del perfil o desde la pestaña Configuración del sitio): en el archivo de la máquina no se usa` };
  if (tipo === 'secreto') return { ok: false, file, reason: `${enArchivo(seccion)}.${k} no se escribe por acá: harness.js config set ${enArchivo(seccion)}.${k} (lee el valor por stdin y nunca lo muestra)` };
  if (tipo === 'retirada') return { ok: false, file, reason: `${enArchivo(seccion)}.${k} ${RETIRADAS[`${seccion}.${k}`] || 'ya no hace nada'}` };
  const err = validarTipo(tipo, valorNuevo);
  if (err) return { ok: false, file, reason: `${enArchivo(seccion)}.${k}: ${err}` };
  const valorEscrito = typeof valorNuevo === 'string' ? valorNuevo.trim() : valorNuevo;
  const lm = leerJson(file);
  if (lm.estado === 'roto') return { ok: false, file, reason: `${file}: ${lm.motivo} — no se escribe sobre un archivo roto; arreglalo primero (node scripts/lib/tycon-config.js validate)` };
  const datos = lm.estado === 'leido' ? lm.datos : {};
  if (lm.estado === 'leido') {
    const v = sinAnotar(() => validarArchivo(datos, { archivo: file, esPerfil: false, home }));
    if (v.errores.length) return { ok: false, file, reason: `${file} está roto (${v.errores.map((e) => `${e.clave ? `${e.clave} · ` : ''}${e.motivo}`).join(' | ')}) — no se escribe sobre un archivo roto; arreglalo primero` };
  }
  // la sección y la clave con el nombre que ya tienen en el archivo; si no están, con el de hoy. Si el archivo trae las dos
  // formas (la de hoy y la de antes, con el mismo valor: el lector lo acepta), se escriben LAS DOS — escribir sólo una
  // dejaría dos valores distintos y el archivo roto (pase adversarial de la tanda C, clase 13)
  const nombresSeccion = Object.keys(datos).filter((x) => (SECCION_DE_ARCHIVO[x] || x) === seccion);
  if (!nombresSeccion.length) nombresSeccion.push(enArchivo(seccion));
  let before = null;
  for (const nombreSeccion of nombresSeccion) {
    const cuerpo = esObjeto(datos[nombreSeccion]) ? datos[nombreSeccion] : {};
    const nombresClave = Object.keys(cuerpo).filter((x) => claveDeHoy(seccion, x) === k);
    if (!nombresClave.length) nombresClave.push(k);
    for (const nombreClave of nombresClave) {
      if (before === null && tiene(cuerpo, nombreClave)) before = cuerpo[nombreClave];
      cuerpo[nombreClave] = valorEscrito;
    }
    datos[nombreSeccion] = cuerpo;
  }
  // un ~/.claude/tycon.json que es un enlace (la configuración en un repo de dotfiles) se escribe en su destino: un rename
  // sobre el enlace lo reemplazaba por un archivo suelto y el destino no se enteraba (pase adversarial, clase 10)
  let destino = file;
  try { if (fs.lstatSync(file).isSymbolicLink()) destino = fs.realpathSync(file); } catch (_) { /* no está, o el enlace cuelga: se escribe en su lugar */ }
  try { escribirAtomico(destino, `${JSON.stringify(datos, null, 2)}\n`); } catch (e) { return { ok: false, file, reason: `no pude escribir ${destino}: ${e.message}` }; }
  const avisos = [];
  const sinRestringir = restringirSiTraeSecreto(destino, datos);
  if (sinRestringir) avisos.push(`ojo: ${sinRestringir}`);
  const ruta = `${seccion}.${k}`;
  const e = sinAnotar(() => valorDeEntorno(env, ruta, tipo, home));
  if (e && e.error) avisos.push(`ojo: la variable ${e.error.clave} ${e.error.motivo}: la configuración queda ROTA mientras esté puesta`);
  else if (e && JSON.stringify(e.valor) !== JSON.stringify(normalizarValor(tipo, valorEscrito, home, ruta))) avisos.push(`ojo: la variable ${e.variable}=${JSON.stringify(e.valor).replace(/^"|"$/g, '')} le gana a lo escrito en ${file}: el valor vigente sigue siendo el de la variable`);
  // en las claves donde gana el perfil del equipo (story 8.29) lo escrito queda en el archivo —es de la persona— pero no
  // hace efecto mientras el perfil la declare: se dice, igual que con la variable, y con el camino para cambiarlo acá
  if (PROFILE_WINS.includes(ruta)) {
    const lp = sinAnotar(() => leerPerfil({ arnes: arnes || undefined, home, env }));
    const delPerfil = lp.estado === 'leido' ? lp.entradas.find((x) => x.ruta === ruta) : null;
    // un perfil que ESTÁ y no se deja leer no es «no hay perfil»: no se pudo saber si gana, y con él así la
    // configuración entera queda rota (todo comando que la lea va a frenar). Se dice, como con una variable inválida
    if (lp.estado === 'roto') {
      const e0 = lp.errores[0] || {};
      avisos.push(`ojo: no pude leer el perfil del equipo (${e0.archivo || lp.ruta}${e0.clave ? ` · ${e0.clave}` : ''}: ${e0.motivo || 'ilegible'}): no sé si le gana a lo escrito en ${file}, y la configuración queda ROTA mientras siga así`);
    }
    if (delPerfil) avisos.push(`ojo: el perfil del equipo fija ${enArchivo(seccion)}.${k} en ${delPerfil.valor} y le gana a lo escrito en ${file}: no hace efecto mientras el perfil lo declare (para cambiarlo en esta máquina: la variable ${(VARIABLES[ruta] || [])[0]})`);
  }
  const conoce = guardKnows(guardLib, seccion, k);
  const queNoConoce = conoce === false && guardKnows(guardLib, seccion) === true ? `la clave «${enArchivo(seccion)}.${k}»` : `la sección «${enArchivo(seccion)}»`;
  if (conoce === false) avisos.push(`ojo: el freno de producción instalado (${guardLib}) es anterior a ${queNoConoce} y va a decir «configuración ROTA» hasta reinstalarlo: sudo bash ~/.claude/tycon-claude-guides/scripts/production/install-guard.sh`);
  else if (conoce !== true) avisos.push(`ojo: el freno de producción instalado (${guardLib}): ${conoce} — si es anterior a la sección «${enArchivo(seccion)}», va a decir «configuración ROTA» hasta reinstalarlo: sudo bash ~/.claude/tycon-claude-guides/scripts/production/install-guard.sh`);
  return { ok: true, file, before, after: valorEscrito, warning: avisos.length ? avisos.join(' · ') : null };
}

/**
 * El lector de un perfil del equipo como TEXTO, para la configuración de la organización (scripts/lib/org-config.js,
 * sección «Paquetes»): las mismas reglas con que se lee el perfil (vocabulario cerrado, nada personal). `{ ok, data,
 * problems: [{ path, message }] }`. No lee nada de la máquina ni anota usos de nombres viejos.
 */
function parse(texto) {
  let datos;
  try { datos = JSON.parse(String(texto)); } catch (e) { return { ok: false, data: null, problems: [{ path: '', message: `no es JSON válido: ${String((e && e.message) || e).split('\n')[0]}` }] }; }
  if (!esObjeto(datos)) return { ok: false, data: null, problems: [{ path: '', message: 'el perfil tiene que ser un objeto JSON' }] };
  const { errores } = sinAnotar(() => validarArchivo(datos, { archivo: NOMBRE_PERFIL, esPerfil: true, home: os.homedir() }));
  const problems = errores.map((e) => ({ path: e.clave || '', message: e.motivo }));
  return { ok: problems.length === 0, data: problems.length ? null : datos, problems };
}
/** Las secciones del perfil que este lector conoce, con su nombre en el archivo (lo mira `lectorSabe` de org-config.js). */
const KEYS = Object.freeze(Object.keys(VOCABULARIO).map((s) => enArchivo(s)));

module.exports = {
  parse, KEYS, motivoPaquetes, paquetesDeTexto, CANALES_DE_AVISO,
  VOCABULARIO, DEFAULTS, PROFILE_WINS, PROFILE_ONLY, INTEGRACIONES, LAS_OCHO, TOOLS, toolKeys, COMO_SE_PRENDE, VARIABLES, INTERRUPTORES_POR_HOOK, RAIZ_ARNES, NOMBRE_PERFIL, NOMBRE_PERFIL_VIEJO, perfilDelArbol, avisoNombrePerfil, NOMBRE_ENLACE, PLACE_NAME, LEGACY_PLACE_NAME, DONDE_CLAVES, ConfigError,
  rutaMaquina, nombreArchivoMaquina, comoSePrende, rutaPerfil, leerPerfil, rutaLlaveBuzon, cargar, leer, leerParaHook, avisoParaHook, valor, explicar, estadoEnlace, formaPersonal,
  normalizarOrg, nombreDeOrganizacion, resolverRutaDeArchivo, personalEnComentario,
  esIntegracion, estadoIntegracion, integraciones, timeTracking, plataforma, validarTipo, delegaFirma, AREAS_PLATAFORMA, respuesta, modelProvider, TOPE_POR_ESTILO, integracionParaComando, integracionParaHook, sinAnotar, setKey, cli,
};

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
/**
 * La línea de comandos, como función (story 8.36): sale con `process.exit`, como siempre. La llama el arranque de este
 * archivo como programa y la tanda del aplicador (scripts/setup/applier-batch.js), que atrapa esa salida en su mismo
 * proceso. Los nombres viejos de subcomandos y opciones los traduce el arranque, antes de llamarla.
 */
function cli(argv) {
  const cmd = argv[0];
  const usage = 'uso: tycon-config.js explain [--json] | get <clave> | validate [--hook] | key <integracion> [--hook [--switch VAR]] | integrations [--shell|--json] | response [--json] | set <clave> <valor>';
  // `set <clave> <valor>` (story 8.16, tanda D · AC 34): lo que antes se editaba a mano en ~/.claude/tycon.json, con el
  // escritor único (`setKey`). Una llave acepta true, false, 1 o 0 (y `integrations.codex`, además, detect); una opción,
  // sus valores; un texto o una ruta, un texto no vacío. Nunca escribe sobre un archivo roto.
  if (cmd === 'set') {
    const clave = argv[1];
    const crudo = argv[2];
    if (!clave || crudo === undefined || argv.length > 3) { process.stderr.write(`${usage}\n`); process.exit(2); }
    const [s0, k0] = String(clave).split('.');
    const seccion = SECCION_DE_ARCHIVO[s0] || s0;
    const tipo = tiene(VOCABULARIO, seccion) && k0 ? VOCABULARIO[seccion][claveDeHoy(seccion, k0)] : undefined;
    let valorNuevo = crudo;
    if (tipo === 'llave' || tipo === 'llave-o-detectar') {
      const v = String(crudo).trim().toLowerCase();
      if (v === 'true' || v === '1') valorNuevo = true;
      else if (v === 'false' || v === '0') valorNuevo = false;
      else if (tipo === 'llave-o-detectar' && esDetect(String(crudo).trim())) valorNuevo = DETECT;
      else { process.stderr.write(`${clave}: vale «${crudo}»; tiene que ser true, false, 1 o 0${tipo === 'llave-o-detectar' ? ` (o ${DETECT})` : ''}\n`); process.exit(2); }
    }
    if (tipo === 'paquetes') {
      const p = paquetesDeTexto(crudo);
      if (p.motivo) { process.stderr.write(`${clave}: vale ${p.motivo}\n`); process.exit(2); }
      valorNuevo = p.valor;
    }
    // varias carpetas, separadas como en el PATH (`:` en Mac y Linux, `;` en Windows): se guardan como lista
    if (tipo === 'rutas') { const l = String(crudo).split(path.delimiter).map((x) => x.trim()).filter(Boolean); if (l.length > 1) valorNuevo = l; }
    if (rangoDe(tipo) && /^\d+$/.test(String(crudo).trim())) valorNuevo = Number(String(crudo).trim());
    const r = setKey(os.homedir(), clave, valorNuevo);
    if (!r.ok) { process.stderr.write(`tycon-config.js set: ${r.reason}\n`); process.exit(2); }
    const fmt = (x) => (x === null || x === undefined ? '(sin valor)' : Array.isArray(x) ? x.join(',') : String(x));
    process.stdout.write(`${clave}: ${fmt(r.before)} → ${fmt(r.after)} en ${r.file}\n`);
    process.stdout.write('se aplica en el próximo arranque, o ya con `harness.js apply`; para ver antes qué cambia, `harness.js apply --dry-run`\n');
    if (r.warning) process.stdout.write(`${r.warning}\n`);
    process.exit(0);
  }
  if (cmd === 'key') {
    const llave = argv[1];
    if (!esIntegracion(llave)) { process.stderr.write(`integración desconocida: ${llave || '(vacía)'} — válidas: ${LAS_OCHO.join(', ')}\n${usage}\n`); process.exit(2); }
    if (argv.includes('--hook')) {
      const iI = argv.indexOf('--switch');
      const r = integracionParaHook(llave, iI >= 0 ? { interruptor: argv[iI + 1] } : undefined);
      if (!r.ok) process.stderr.write(r.aviso + '\n');
      process.stdout.write(r.estado + '\n');           // prendida · apagada · detect · rota — siempre exit 0: un hook no frena por esto
      process.exit(0);
    }
    let r;
    try { r = integracionParaComando(llave); } catch (e) { process.stderr.write(e.message + '\n'); process.exit(2); }
    process.stdout.write(r.estado + '\n');
    process.exit(r.prendida ? 0 : 3);
  }
  if (cmd === 'integrations') {
    let c;
    try { c = leer(); } catch (e) { process.stderr.write(e.message + '\n'); process.exit(2); }   // rota: NADA por stdout (no se lee como «todo apagado»)
    const ocho = integraciones(c);
    // la herramienta de horas elegida va en la misma respuesta (`timeTracking`, con la llave vieja leída y sin anotarla):
    // así quien ya pregunta por las integraciones no lanza otro proceso para saberla
    // sólo un nombre de integración (minúsculas, números y guiones): el valor es texto libre del perfil o de una variable, y
    // la forma shell la lee el instalador línea por línea; otro valor no se imprime (el instalador dice que no la supo)
    const raw = sinAnotar(() => timeTracking(c)).value;
    const tool = typeof raw === 'string' && /^[a-z0-9-]+$/.test(raw) ? raw : null;
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(Object.assign({}, ocho, { timeTracking: tool })) + '\n'); process.exit(0); }
    // forma shell: una asignación por integración, sólo `0` · `1` · `detect` (el instalador las evalúa tal cual), y la
    // herramienta de horas en su propia variable
    for (const k of LAS_OCHO) process.stdout.write(`TYCON_INTEG_${k.toUpperCase()}=${ocho[k] === DETECT ? DETECT : (ocho[k] ? '1' : '0')}\n`);
    if (tool) process.stdout.write(`TYCON_TIME_TOOL=${tool}\n`);
    process.exit(0);
  }
  // `time-tracking`: la integración de horas elegida (`none` o su nombre, con la llave vieja leída), para el instalador.
  // Rota: nada por stdout y exit 2, como `integrations`.
  if (cmd === 'time-tracking') {
    let c;
    try { c = leer(); } catch (e) { process.stderr.write(e.message + '\n'); process.exit(2); }
    // sin anotar el nombre viejo: lo pregunta el instalador, también con -Check, que no escribe nada en la casa
    process.stdout.write(sinAnotar(() => timeTracking(c)).value + '\n');
    process.exit(0);
  }
  // `response --json`: idioma, estilo y tope del bloque de respuesta, ya resueltos (lo leen los
  // sincronizadores de bloques). Rota: nada por stdout y exit 2 —el sincronizador deja el bloque que había—.
  if (cmd === 'response') {
    let c;
    try { c = leer(); } catch (e) { process.stderr.write(e.message + '\n'); process.exit(2); }
    const r = respuesta(c);
    process.stdout.write((argv.includes('--json') ? JSON.stringify(r) : `${r.style} ${r.language} ${r.max_chars}`) + '\n');
    process.exit(0);
  }
  if (cmd === 'explain') {
    const c = cargar();
    if (c.errores.length) { process.stderr.write(new ConfigError(c.errores).message + '\n'); process.exit(2); }
    const out = explicar({ json: argv.includes('--json') });
    process.stdout.write((typeof out === 'string' ? out : JSON.stringify(out, null, 2)) + '\n');
    process.exit(0);
  }
  if (cmd === 'get') {
    const clave = argv[1];
    if (!clave || !/^[a-z]+\.[a-z_]+$/.test(clave)) { process.stderr.write(`${usage}\n`); process.exit(2); }
    let c;
    try { c = leer(); } catch (e) { process.stderr.write(e.message + '\n'); process.exit(2); }
    const val = valor(c, clave);
    if (val === undefined) { process.stderr.write(`clave desconocida: ${clave}\n`); process.exit(2); }
    if (val === null || val === false) process.exit(3);       // sin valor / apagada: exit 3, para que un $(…) vacío no se lea como «pregunté y no hay»
    // un valor con objetos adentro (la lista de máquinas) sale como JSON; String() daría «[object Object]»
    const conObjetos = typeof val === 'object' && (!Array.isArray(val) || val.some((x) => x && typeof x === 'object'));
    process.stdout.write((val === true ? '1' : conObjetos ? JSON.stringify(val) : String(val)) + '\n');
    process.exit(0);
  }
  if (cmd === 'validate') {
    if (argv.includes('--hook')) {
      const r = leerParaHook();
      if (!r.ok) process.stderr.write(r.aviso + '\n');
      process.exit(0);
    }
    const c = cargar();
    if (c.errores.length) { process.stderr.write(new ConfigError(c.errores).message + '\n'); process.exit(2); }
    process.stdout.write(`✅ configuración válida (máquina: ${c.archivos.maquina.estado} · perfil: ${c.archivos.perfil.estado})\n`);
    for (const r of c.retiradas || []) process.stdout.write(`ojo: ${r.clave} en ${r.archivo}: ${r.motivo}\n`);
    process.exit(0);
  }
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

if (require.main === module) {
  // Los subcomandos y opciones viejos siguen andando (story 8.9, tanda B3a): sólo acá, nunca al cargar la biblioteca.
  if (legacy) legacy.aliasArgv('scripts/lib/tycon-config.js', { exitCode: 2 });
  cli(process.argv.slice(2));
}
