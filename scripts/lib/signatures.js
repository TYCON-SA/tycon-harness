'use strict';
/**
 * signatures.js — el catálogo de las firmas del dueño (@story-8.139).
 *
 * Una entrada por cada cosa que un freno le pide firmar a una persona. Lo leen el lector de la configuración (con qué
 * ids se escriben `approvals.delegated_signing` y `approvals.owner_only`) y la guía `guides/owner-signatures.md`, que
 * trae una fila por entrada. Sin dependencias: lo carga el lector.
 *
 * Cada entrada:
 *   id            el nombre con que se la nombra en el perfil del equipo; un escape es `escape:<nombre>`, con los
 *                 espacios como guiones y sin acentos.
 *   kind          cómo se pide: 'guion' (un guion que firma, y verifica la ventana) o 'freno' (un escape que el freno
 *                 deja pasar con la ventana). Las cuatro que se dan sobre un archivo (FIRMAS_DE_ARCHIVO) son 'guion':
 *                 `marker.js sign-file` las pide en la ventana y deja la constancia que consume el Edit o Write. Las de
 *                 POR_GUION también: su guion pide la firma y se puede pedir para otra sesión.
 *   approves      qué aprueba, en llano.
 *   command       el comando que la pide.
 *   otherSession  'yes' si el comando se puede correr desde la pestaña de otra sesión, 'no' si no, 'pending' si la firma
 *                 todavía no tiene comando.
 *   soloClick     la persona la aprueba sólo con su click, en la pestaña que trabaja, o en su terminal; `descripciones`
 *                 son las de las dos opciones de su cuadro, en el orden de las opciones. Para otra sesión, sólo la
 *                 coordinadora por delegación del perfil, si la firma es de DELEGABLE_EXCEPTIONS.
 *   clickDelDueno la aprueba sólo el click del dueño, en la pestaña que trabaja o en la de la coordinadora confirmada y
 *                 viva, o su terminal: nunca un «aprobado» escrito ni la ventana, y la delegación sólo si la firma es
 *                 de DELEGABLE_EXCEPTIONS. Lleva `descripciones`.
 *   terminal      cómo la firma el dueño en su terminal si lo prefiere (salvo lo irreversible, una firma también se aprueba
 *                 sin terminal: en la ventana de permiso o, donde no llega, con un click en el cuadro de opciones o un
 *                 «aprobado» escrito; owner-window.js), o null mientras no tenga comando.
 *   ifWrong       qué pasa si sale mal, en llano: lo muestra el cuadro de opciones.
 *   covers        los ids de LEVELS que aprueba: el suyo, o dos si la firma de hoy junta dos cosas de distinto peso,
 *                 u otro si es un escape que hace lo mismo que otra firma.
 *   level         el mayor nivel de lo que cubre.
 *   profiles      a quién se le pide: 'dev' (el dev de producto) y 'mant' (quien mantiene el arnés).
 *   retired       sólo en un escape que ya no apaga nada (RETIRADAS): el comando de la salida que queda en su lugar, la
 *                 emergencia. Sigue en el catálogo con su id y su comando para que un perfil que lo nombra se lea
 *                 igual; la guía lo muestra como retirado.
 *
 * LEVELS es la tabla de niveles del esquema de firmas, un nivel por id: 1 rutina, 2 excepción (da por bueno
 * algo sin verificarlo y deja deuda), 3 irreversible o afloja un freno. La coordinadora firma por delegación la rutina
 * y, del nivel 2, sólo las excepciones de trámite (DELEGABLE_EXCEPTIONS y DELEGABLE_FORMS, `delegable`). Sus ids todavía no se piden por su nombre: los
 * frenos piden las firmas de SIGNATURES, y cada una dice qué ids de la tabla cubre. Los renombres llegan cuando cambie
 * cómo se pide una firma.
 *
 * GROUPS es la tabla de equivalencias de los 11 valores que la 8.116 aceptaba en `approvals.delegated_signing` (`off`
 * aparte: es «ninguna»): `escape-phrases` son los escapes salvo los de POR_GUION, que se delegan sólo nombrándolos;
 * cada uno de los demás, su propia firma. En `owner_only`, que sólo restringe, `escape-phrases` son todos los escapes:
 * `expand(v, { restringe: true })`. El lector del perfil no acepta grupos ahí; quien lee la lista sin ese lector, igual.
 */

const AMBOS = Object.freeze(['dev', 'mant']);
const MANT = Object.freeze(['mant']);

// el tope del camino corto DE FÁBRICA: hasta acá alcanza la firma común; más lo elige la persona con su click. Cada
// organización lo cambia en su perfil (`short_path.max_files`), y el que rige le llega a firmaDelPedidoAdhoc del borde
const TOPE = 8;
const ADHOC = 'adhoc-lane';
const SOBRE_CUPO = 'adhoc-lane:sobre-cupo';
// el arreglo de un rojo de CI de un pedido abierto y ya revisado: atado al pedido y al control que falló, sin plan ni
// revisores, con un tope propio de archivos
const CI_ROJO = 'adhoc-lane:ci-rojo';
const TOPE_CI_ROJO = 3;
// cerrar una ejecución perdida que la partición de su historia dejó sin objeto: la forma de rutina de `lost-run`
const LOST_RUN_PARTICION = 'lost-run:particion';

// qué aprueba cada id de la tabla, en inglés: la pantalla del sitio lo muestra en ese idioma
const LEVELS_EN = Object.freeze({
  'plan-approval': 'approve the plan (level 2 if the story is sensitive: risk-class works it out, and then the plan and its mockup are approved only by the owner, with a click or an «approved», even if the profile names plan-approval:delicada; level 1 is also approved by the approved verdict of the automatic review, with or without a coordinator, unless plan_review.routine_approval is person)',
  'extra-round': 'one more round of reviewers',
  'pending-approval': 'open a new item in the pending list',
  'save': 'save: commit, push and pull requests, if no commit touches anything sensitive',
  'browser-test:prepare': 'prepare the browser test',
  'adhoc-lane': 'open a quick fix without a story, within the quota',
  'compare-waiver': 'exempt a command the story modifies from the comparison with main',
  'write-after-release': 'release the brake that follows a failed look at what a command wrote (never the stopped session: only the person, or the designated coordinator if the profile adds it to approvals.delegated_signing)',
  'refresh-after-main': 're-sign the controls after pulling main, with no change of your own',
  'save:sensible': 'save when a commit touches something sensitive',
  'adhoc-lane:sobre-cupo': 'open a quick fix that goes past the file limit of the short path, though a story is recommended (only implementation files count, not tests or guides)',
  'adhoc-lane:ci-rojo': 'open the fix of a CI red on an open pull request, with no plan or reviewers (up to 3 implementation files; the failed control and the touched tests run before saving)',
  'adhoc-lane:datos': 'let a quick fix that changes where a piece of data comes from, or who can see it, go through without a story (only the owner\'s click)',
  'adhoc-lane:guardado-ajeno': 'let a save that is not part of a quick fix waiting for its reviewers go through once, with what it saves in view (a person\'s click or terminal, or the coordinator if the profile delegates it)',
  'autonomy-resume': 'put a run the closing control stopped back into autonomous mode, with the rounds reset (only the owner\'s click or terminal)',
  'escape:DOD_BYPASS': 'skip every control of the commit',
  'critical-waiver': 'waive a critical finding',
  'runtime-waiver': 'accept a criterion that cannot be tested live, or exempt the whole story',
  'manual-test': 'mark a criterion as tested by hand',
  'browser-test:no': 'say no to the browser test',
  'adversarial-skip': 'skip the adversarial pass',
  'atdd-skip': 'skip "tests first" for a run',
  'review-skip': 'answer «skip» to the question of whether to run the adversarial pass on the code (only the owner: their window, click or typed «approved»)',
  'lost-run': 'give up on a run as lost and close it',
  'lost-run:particion': 'close a lost run that the split of its story into batches left without purpose',
  'escape:force-manual': "mark a control's result by hand",
  'escape:trust-ran': 'count reviewers with no record that they ran',
  'escape:TYCON_TEST_GATE': 'skip only the test gate of the commit',
  'escape:TYCON_STATUS_GATE': "change a story's status by hand",
  'escape:TYCON_MUTATION_CHECK': 'skip the mutation check of the tests',
  'escape:TYCON_STORY_REVIEW': "skip the story's review before planning",
  'escape:story-skill-bypass': 'write a story without the story skill',
  'escape:advisors_exempt': 'exempt a story from the reviewers',
  'escape:red-control-test-edit': "edit a control's old test that was failing",
  'escape:set-autonomous': 'change the autonomous mode of a run',
  'designation-confirm': 'confirm which session is the coordinator of this machine',
  'designation-set': "name a session as this machine's coordinator, with a click in its tab",
  'designation-withdraw': "withdraw this machine's coordinator, with a click in its tab",
  'control-change': 'any change to a control',
  'escape:TYCON_SAFETY_OFF': 'turn off the safety guard for one command (retired: it no longer turns anything off)',
  'escape:TYCON_PROD_LINT': 'turn off the production query control (retired: it no longer turns anything off)',
  'escape:TYCON_NEW_NAMES': 'turn off the names check on what is published',
  emergency: 'the emergency exit: let one command that a brake stops go through, with a reason and for that command only',
  'escape:merge-bypass': "merge skipping main's queue and CI, or loosen the branch policies: one command, never delegated",
  'escape:external-pr': 'queue or merge a pull request from someone outside the team: one command, never delegated',
});

// id, nivel, perfiles, qué aprueba
const LEVELS = Object.freeze([
  ['plan-approval', 1, AMBOS, 'aprobar el plan (nivel 2 si la historia es delicada: lo calcula risk-class, y entonces el plan y su maqueta los aprueba sólo el dueño, con su click o su «aprobado», aunque el perfil nombre plan-approval:delicada; el nivel 1 lo aprueba también el veredicto aprobado de la revisión automática, con o sin coordinadora, salvo con plan_review.routine_approval: person)'],
  ['pending-approval', 1, AMBOS, 'abrir un pendiente nuevo en la lista'],
  ['save', 1, AMBOS, 'guardar: commit, push y pull requests, si ningún commit toca algo de lo sensible'],
  ['browser-test:prepare', 1, AMBOS, 'preparar la prueba con navegador'],
  ['adhoc-lane', 1, AMBOS, 'abrir un arreglo rápido sin historia, dentro del cupo'],
  ['adhoc-lane:ci-rojo', 1, AMBOS, 'abrir el arreglo de un rojo de CI de un pull request abierto, sin plan ni revisores (hasta 3 archivos, pruebas incluidas; antes de guardar corren los controles de CI en local y las pruebas tocadas)'],
  ['compare-waiver', 1, AMBOS, 'eximir de la comparación con main a un comando que la historia modifica (delegable sólo si el perfil la suma a approvals.delegated_signing)'],
  ['refresh-after-main', 1, MANT, 'refirmar los controles tras traer main, sin cambio propio'],
  ['lost-run:particion', 1, AMBOS, 'cerrar una ejecución perdida que la partición de su historia en tandas dejó sin objeto (delegable sólo si el perfil la suma a approvals.delegated_signing)'],
  ['extra-round', 2, AMBOS, 'una vuelta más de revisores pasado el tope: la firma el dueño, con su click o su terminal; no es trámite ni la firma la coordinadora'],
  ['save:sensible', 2, AMBOS, 'guardar cuando un commit toca algo de lo sensible'],
  ['write-after-release', 2, AMBOS, 'liberar el freno que sigue a una mirada fallida de lo que escribió un comando (nunca la sesión frenada: sólo la persona, o la coordinadora designada si el perfil la suma a approvals.delegated_signing)'],
  ['adhoc-lane:datos', 2, AMBOS, 'dejar pasar un arreglo rápido que cambia de dónde sale un dato o quién lo ve, sin historia (sólo el click del dueño)'],
  ['adhoc-lane:guardado-ajeno', 2, AMBOS, 'dejar pasar una vez un guardado ajeno a un camino corto que espera sus revisores, con lo que guarda a la vista (el click o la terminal de una persona, o la coordinadora si el perfil se lo delega)'],
  ['autonomy-resume', 2, AMBOS, 'volver al modo autónomo una ejecución que el control de cierre detuvo, con las vueltas en cero (sólo el click o la terminal del dueño)'],
  ['adhoc-lane:sobre-cupo', 2, AMBOS, 'abrir un arreglo rápido que pasa el tope de archivos del camino corto, aunque se recomienda una historia (cuentan sólo los archivos de implementación, sin pruebas ni guías)'],
  ['escape:DOD_BYPASS', 2, AMBOS, 'saltear todos los controles del commit'],
  ['critical-waiver', 2, AMBOS, 'eximir un hallazgo crítico'],
  ['runtime-waiver', 2, AMBOS, 'aceptar un criterio imposible de probar en vivo, o eximir la historia entera'],
  ['manual-test', 2, AMBOS, 'marcar un criterio como probado a mano'],
  ['browser-test:no', 2, AMBOS, 'decir que no a la prueba con navegador'],
  ['adversarial-skip', 2, AMBOS, 'saltear el pase adversarial'],
  ['atdd-skip', 2, AMBOS, 'saltear «pruebas primero» en una ejecución'],
  ['review-skip', 2, AMBOS, 'contestar «skip» a la pregunta de si correr el pase adversarial sobre el código (sólo el dueño: su ventana, su click o su «aprobado»)'],
  ['lost-run', 2, AMBOS, 'dar por perdida una ejecución y cerrarla'],
  ['escape:force-manual', 2, AMBOS, 'marcar a mano el estado de un control'],
  ['escape:trust-ran', 2, AMBOS, 'contar revisores sin constancia de que corrieron'],
  ['escape:TYCON_TEST_GATE', 2, AMBOS, 'saltear sólo el portón de pruebas del commit'],
  ['escape:TYCON_STATUS_GATE', 2, AMBOS, 'cambiar a mano el estado de una historia'],
  ['escape:TYCON_MUTATION_CHECK', 2, AMBOS, 'saltear el chequeo de mutantes de las pruebas'],
  ['escape:TYCON_STORY_REVIEW', 2, AMBOS, 'saltear la revisión de la historia antes del plan'],
  ['escape:story-skill-bypass', 2, AMBOS, 'escribir una historia sin la skill de historias'],
  ['escape:advisors_exempt', 2, AMBOS, 'eximir una historia de los revisores'],
  ['escape:red-control-test-edit', 2, AMBOS, 'editar una prueba vieja de un control que estaba en rojo'],
  ['escape:set-autonomous', 2, AMBOS, 'cambiar el modo autónomo de una ejecución'],
  ['designation-confirm', 2, AMBOS, 'confirmar qué sesión es la coordinadora de esta máquina'],
  ['designation-set', 2, AMBOS, 'nombrar a una sesión coordinadora de esta máquina, con un click en su pestaña'],
  ['designation-withdraw', 2, AMBOS, 'retirar a la coordinadora de esta máquina, con un click en su pestaña'],
  ['control-change', 3, MANT, 'cualquier cambio de control'],
  ['escape:TYCON_SAFETY_OFF', 3, AMBOS, 'apagar el freno de seguridad para un comando (retirada: ya no apaga nada)'],
  ['escape:TYCON_PROD_LINT', 3, AMBOS, 'apagar el control de consultas a producción (retirada: ya no apaga nada)'],
  ['escape:TYCON_NEW_NAMES', 3, MANT, 'apagar el control de nombres en lo que se publica'],
  ['emergency', 3, AMBOS, 'la salida de emergencia: dejar pasar un comando que un freno para, con motivo y para ese comando solo'],
  ['escape:merge-bypass', 3, AMBOS, 'mergear salteando la cola y la CI de main, o aflojar las políticas de la rama: un comando, nunca por delegación'],
  ['escape:external-pr', 3, AMBOS, 'encolar o mergear un pull request de alguien de afuera del equipo: un comando, nunca por delegación'],
].map(([id, level, profiles, approves]) => Object.freeze({ id, level, profiles, approves, approvesEn: LEVELS_EN[id] || null })));

// lo que cubre cada firma de hoy que no es su propio id de la tabla: las dos que juntan dos cosas de distinto peso y
// los ocho escapes que hacen lo mismo que otra firma
const COVERS = Object.freeze({
  'escape:no-mutation': ['escape:TYCON_MUTATION_CHECK'],
  'save': ['save', 'save:sensible'],
  'browser-test': ['browser-test:prepare', 'browser-test:no'],
  'escape:dod_runtime_exempt': ['runtime-waiver'],
  'escape:ALLOW_DOD_EVIDENCE_WRITE': ['manual-test'],
  'escape:TYCON_NO_DEEP_REVIEW': ['adversarial-skip'],
  'escape:no-deep-review': ['adversarial-skip'],
  'escape:cerrar-la-ejecucion': ['lost-run'],
  'escape:cerrar-como-deuda': ['lost-run'],
  'escape:rojo-esperado-de-la-matriz': ['lost-run'],
  'escape:cambiar-el-estado': ['escape:TYCON_STATUS_GATE'],
});
// lo que una firma cubre pero no se firma por delegación: el ok de guardar delegado no firma un cambio que toca algo de
// SENSITIVE (skills/tycon-pipeline/scripts/lib/save-ok.js)
const NOT_DELEGATED = Object.freeze(['save:sensible']);
// las excepciones (nivel 2) de trámite: la coordinadora las firma por delegación si el perfil del equipo las nombra en
// `approvals.delegated_signing`. Las demás de nivel 2 y todo el nivel 3 los firma una persona, aunque el perfil los nombre
const DELEGABLE_EXCEPTIONS = Object.freeze(['runtime-waiver', 'manual-test', 'escape:ALLOW_DOD_EVIDENCE_WRITE', 'escape:trust-ran',
  'lost-run', 'escape:cerrar-la-ejecucion', 'escape:cerrar-como-deuda', 'escape:rojo-esperado-de-la-matriz',
  'escape:TYCON_STATUS_GATE', 'escape:cambiar-el-estado', 'escape:set-autonomous',
  'adhoc-lane:guardado-ajeno', 'critical-waiver', 'escape:force-manual', 'escape:red-control-test-edit', 'write-after-release']);
// las firmas sólo del dueño que la coordinadora pide para otra sesión sin delegarlas: le llegan al dueño en la pestaña de
// ella (la ventana o el cuadro), así no tiene que entrar a la sesión que espera. Siguen siendo sólo suyas: el freno no
// las pasa por la delegación (owner-window.js)
const PARA_OTRA_SESION_SIN_DELEGAR = Object.freeze(['escape:dod_runtime_exempt', 'escape:advisors_exempt', 'escape:story-skill-bypass', 'autonomy-resume', 'adhoc-lane:datos']);
const otraSinDelegar = (id) => (PARA_OTRA_SESION_SIN_DELEGAR.includes(id) ? 'yes' : 'no');
// las dos formas de nivel 2 de una firma de rutina, que el perfil nombra con su propio nombre (no son firmas de
// SIGNATURES: se piden con la firma de la derecha, y su guion mira si el perfil nombra la forma): el guardado que toca
// algo sensible, que la coordinadora firma si el perfil lo delega, y el plan de una historia delicada, que el perfil
// puede nombrar sin que eso delegue nada: ese plan y su maqueta los aprueba sólo el dueño, con su click o su «aprobado»
// (lib/plan-review.js antesDeAprobar). La forma sigue en la lista para que un perfil que la nombra siga siendo válido
const PLAN_DELICADO = 'plan-approval:delicada';
const SAVE_SENSIBLE = 'save:sensible';
const DELEGABLE_FORMS = Object.freeze({ [PLAN_DELICADO]: 'plan-approval', [SAVE_SENSIBLE]: 'save' });

const levelOf = (id) => LEVELS.find((l) => l.id === id);
const coversOf = (id) => COVERS[id] || [id];

// los escapes que ya no apagan nada: el freno anota la variable y la deja sin efecto. Siguen en el catálogo, con su id y
// su comando, para que un perfil del equipo que los nombra en `approvals.owner_only` se siga leyendo entero; cada uno
// dice la salida que queda en su lugar, la emergencia que la persona firma en su terminal
const RETIRADAS = Object.freeze({
  'escape:TYCON_SAFETY_OFF': 'harness.js sign emergency --reason "<por qué>" --request <número>',
  'escape:TYCON_PROD_LINT': 'harness.js sign emergency --reason "<por qué>" --commit',
});

const POR_VARIABLE = [
  ['TYCON_SAFETY_OFF', '1', 'apagar el freno de seguridad para un comando (retirada: ya no apaga nada)'],
  ['TYCON_PROD_LINT', '0', 'apagar el control de consultas a producción para un comando (retirada: ya no apaga nada)'],
  ['TYCON_NEW_NAMES', '0', 'apagar el control de nombres nuevos en lo que se publica'],
  ['TYCON_TEST_GATE', '1', 'saltear el portón de pruebas del commit'],
  ['DOD_BYPASS', '1', 'saltear los controles del commit (queda anotado)'],
  ['TYCON_NO_DEEP_REVIEW', '1', 'pedir que se saltee el pase adversarial (esta firma no lo saltea: eso lo firma adversarial-skip)'],
  ['TYCON_STATUS_GATE', 'off', 'cambiar a mano el estado de una story'],
  ['TYCON_MUTATION_CHECK', 'off', 'saltear el chequeo de mutantes de las pruebas'],
  ['TYCON_STORY_REVIEW', '0', 'saltear la revisión de la historia antes del plan'],
];

const CON_NOMBRE = [
  ['story-skill-bypass', 'escribir una story sin la skill de stories', 'file'],
  ['red-control-test-edit', 'editar una prueba vieja de un control que estaba en rojo', 'file'],
  ['set-autonomous', 'cambiar el modo autónomo de una ejecución', 'marker.js set-autonomous false [--for-session <D>]'],
  ['cerrar-la-ejecucion', 'cerrar una ejecución con un control en rojo', 'marker.js clear'],
  ['cerrar-como-deuda', 'cerrar una ejecución dejando lo que falta como deuda, o dejar en esa deuda un control en rojo esperado', 'marker.js close-as-debt --reason "<texto>" --debt <DEF-id> [--for-session <D>]'],
  ['rojo-esperado-de-la-matriz', 'llevar al commit criterios sin evidencia en vivo, hasta una fecha', 'marker.js expect-red acmatrix --tests <T1,T2> --until <AAAA-MM-DD> [--for-session <D>]'],
  ['force-manual', 'marcar a mano el estado de un control', 'marker.js set-check <control> <estado> --force-manual [--for-session <D>]'],
  ['trust-ran', 'contar los revisores sin la constancia de que corrieron', 'pipeline.js check-count --repo <r> --story <s> --trust-ran [--for-session <D>]'],
  ['no-mutation', 'cerrar «Correr las pruebas» sin el chequeo de mutantes, con motivo', 'marker.js complete-step run-tests --no-mutation --reason <motivo>'],
  ['ALLOW_DOD_EVIDENCE_WRITE', 'escribir a mano la evidencia de la prueba en vivo', 'file'],
  ['dod_runtime_exempt', 'eximir una story de la prueba en vivo', 'file'],
  ['advisors_exempt', 'eximir una story de los revisores', 'file'],
  ['no-deep-review', 'correr los guiones del pase adversarial con un --env-file, que puede cambiar su decisión', 'node --env-file=<archivo> pipeline.js start|deep-review-gate (o marker.js mark-adversarial-skipped)'],
  ['cambiar-el-estado', 'cambiar a mano el estado de una story', 'file'],
  ['merge-bypass', 'mergear salteando la cola y la CI de main, o aflojar las políticas de la rama', 'gh pr merge <n> --admin (o un merge, una regla o una política por la API)'],
  ['external-pr', 'encolar o mergear un pull request de alguien de afuera del equipo', 'el comando que encola o mergea el pull request (o la API)'],
];

// qué pasa si sale mal: lo dice el cuadro de opciones que arma el guion de la firma (owner-window.js `cuadroPara`). Cada
// firma trae el suyo, escapes incluidos: un mismo texto para todas no le dice a la persona qué arriesga con ésta
const SI_SALE_MAL = Object.freeze({
  'escape:TYCON_SAFETY_OFF': 'nada: está retirada y ya no apaga el freno de seguridad; la salida es la emergencia, que la persona firma en su terminal',
  'escape:TYCON_PROD_LINT': 'nada: está retirada y ya no apaga la revisión de producción; la salida es la emergencia del commit, que la persona firma en su terminal',
  'escape:TYCON_NEW_NAMES': 'un nombre viejo o interno sale en lo que se publica',
  'escape:TYCON_TEST_GATE': 'el commit entra sin correr las pruebas, y una prueba rota llega al pedido',
  'escape:DOD_BYPASS': 'el commit entra sin ningún control de cierre, y un criterio sin probar puede llegar a main; queda anotado',
  'escape:TYCON_NO_DEEP_REVIEW': 'nada: la variable sólo pide saltear el pase, y el pase corre igual; saltearlo lo firma adversarial-skip',
  'escape:no-deep-review': 'el archivo trae una variable que cambia la decisión del pase, y un cambio que lo necesitaba puede quedar sin él',
  'escape:TYCON_STATUS_GATE': 'la historia cambia de estado sin los controles del orquestador, y puede quedar como hecha sin estarlo',
  'escape:cambiar-el-estado': 'el estado de la historia se escribe a mano, y puede quedar como hecha sin estarlo',
  'escape:TYCON_MUTATION_CHECK': 'las pruebas cuentan sin el chequeo de mutantes, y una prueba que no verifica nada pasa por buena',
  'escape:no-mutation': 'el paso se cierra sin el chequeo de mutantes, y una prueba que no verifica nada pasa por buena',
  'escape:TYCON_STORY_REVIEW': 'la historia llega al plan sin su revisión previa, y un hueco que ella encontraría pasa a programarse',
  'escape:story-skill-bypass': 'la historia se escribe sin el validador ni la revisión previa, y puede llegar al plan con huecos',
  'escape:red-control-test-edit': 'la prueba de un control se corrige para que pase, y el control puede quedar apagado sin que nadie lo decida',
  'escape:set-autonomous': 'la ejecución cambia cómo se frena sola ante un control en rojo',
  'escape:cerrar-la-ejecucion': 'la ejecución se cierra con un control en rojo, y lo que frenaba queda sin arreglar',
  'escape:cerrar-como-deuda': 'la ejecución se cierra y lo que falta queda anotado como deuda, sin hacer, o el control queda en rojo hasta el commit',
  'escape:rojo-esperado-de-la-matriz': 'el commit entra con esos criterios sin evidencia en vivo hasta la fecha, y una falla que la prueba en vivo encontraría llega al pedido',
  'escape:force-manual': 'un control queda en el estado escrito a mano, aunque nadie lo haya medido',
  'escape:trust-ran': 'los revisores cuentan como corridos sin constancia, y uno que no corrió pasa por corrido',
  'escape:ALLOW_DOD_EVIDENCE_WRITE': 'la evidencia de la prueba en vivo queda escrita a mano, y puede decir algo que no pasó',
  'escape:dod_runtime_exempt': 'la historia entera queda sin prueba en vivo, y un error puede llegar a producción',
  'escape:advisors_exempt': 'la historia se cierra sin que ningún revisor la mire, y un error puede pasar sin que nadie lo vea',
  'escape:merge-bypass': 'el cambio entra a main sin la cola ni la CI, o una política de la rama queda floja, y lo que la CI frenaba llega a main',
  'escape:external-pr': 'el código de alguien de afuera entra a main, y lo que hace corre en cada máquina que se actualiza',
  'plan-approval': 'se implementa un plan que no querías; se frena la ejecución y se rehace, y nada entra a main sin revisión',
  'extra-round': 'se gasta una vuelta más de revisores; no cambia el código',
  'refresh-after-main': 'queda firmado un control con lo que trajo main; se revierte con otro pedido',
  'control-change': 'un control queda cambiado y lo que frenaba puede pasar; se revierte con otro pedido',
  'critical-waiver': 'un hallazgo crítico entra sin arreglar',
  'compare-waiver': 'el cambio de ese comando entra sin compararse con la versión de main, y una diferencia que nadie declaró puede llegar a main',
  'runtime-waiver': 'un criterio queda sin probar en vivo, y un error puede llegar a producción',
  'write-after-release': 'la sesión vuelve a correr comandos sin que nadie haya visto lo que escribió el comando que no se pudo mirar',
  'manual-test': 'un criterio queda como probado sin una prueba automática que lo repita',
  'browser-test': 'se prepara la prueba con navegador, o queda sin ella y un error de pantalla puede pasar',
  'lost-run': 'la ejecución se cierra y lo que le faltaba queda sin hacer',
  'lost-run:particion': 'se cierra una ejecución que la historia partida ya no necesitaba; lo hecho sigue en la copia de trabajo y se retoma con su tanda',
  'adversarial-skip': 'el código entra sin el pase adversarial, y un error que él encontraría puede llegar a main',
  'atdd-skip': 'el código entra sin que sus pruebas se hayan escrito antes, y una prueba hecha a la medida del código puede no ver un error',
  'review-skip': 'el código entra sin el pase adversarial que la celda preguntaba, y un error que él encontraría puede llegar a main',
  'pending-approval': 'queda un pendiente de más en la lista; se cierra a mano',
  'adhoc-lane': 'la sesión escribe código sin historia; se cierra el arreglo, y nada entra a main sin revisión',
  'adhoc-lane:sobre-cupo': 'un cambio grande entra sin el plan ni las pruebas de una historia; se cierra el arreglo, y nada entra a main sin revisión',
  'adhoc-lane:ci-rojo': 'un arreglo chico entra al pedido sin otra vuelta de revisores; lo frena el control que había fallado, y se revierte con otro commit',
  'adhoc-lane:datos': 'un cambio de permisos o de la fuente de un dato llega a producción sin que nadie revise quién lo ve, y una persona sin permiso puede quedar trabada',
  'adhoc-lane:guardado-ajeno': 'se guarda una vez algo que no es del camino corto mientras el carril espera sus revisores; si en verdad era del carril, entra sin ellos y se revierte con otro commit',
  'autonomy-resume': 'la sesión vuelve a iterar sola sobre un rojo que quizá necesitaba otra mirada',
  save: 'se guarda en el repo y se abre el pedido; se revierte con otro commit',
  'designation-confirm': 'esa sesión firma en tu nombre lo que el perfil delega, hasta que se designe otra',
  'designation-set': 'una sesión que no querías ordena esta máquina (y, con el perfil, firma en tu nombre lo que el perfil le delega), hasta que la retires o nombres otra',
  'designation-withdraw': 'las firmas que delegabas vuelven a vos hasta que nombres otra coordinadora',
});

// qué aprueba cada firma, en inglés: lo muestra la pantalla de Configuración en ese idioma
const APPROVES_EN = {
  'designation-confirm': 'confirm which session is the coordinator of this machine',
  'designation-set': "name this session as the machine's coordinator",
  'designation-withdraw': "withdraw this session as the machine's coordinator",
  'plan-approval': "approve a story's plan",
  'extra-round': 'one more round of reviewers',
  'refresh-after-main': 'sign the controls again after bringing in main, with no change of its own',
  'control-change': "approve a change to the repo's controls",
  'critical-waiver': "waive a reviewers' critical finding",
  'compare-waiver': 'exempt a command the story modifies from the comparison with main',
  'write-after-release': 'release the brake that follows a failed look at what a command wrote',
  'runtime-waiver': 'accept a criterion that cannot be tested live',
  'manual-test': 'mark a criterion as tested by hand',
  'browser-test': 'set up the browser test, or say no to it',
  'lost-run': 'give up a run as lost and close it',
  'lost-run:particion': 'close a lost run that the split of its story into batches left without purpose',
  'adversarial-skip': 'skip the adversarial pass with a signed record',
  'atdd-skip': 'skip "tests first" for a run, with a signed record',
  'review-skip': 'answer «skip» to the code pass question',
  'pending-approval': 'open a new item in the pending list',
  'adhoc-lane': "open a session's quick fix, with no story",
  'adhoc-lane:sobre-cupo': 'open a quick fix that goes past the file limit of the short path, though a story is recommended',
  'adhoc-lane:ci-rojo': 'open the fix of a CI red on an open pull request, with no plan or reviewers',
  'adhoc-lane:datos': 'let a quick fix that changes where a piece of data comes from, or who can see it, go through without a story',
  'adhoc-lane:guardado-ajeno': 'let a save that is not part of a quick fix waiting for its reviewers go through once, with what it saves in view',
  'autonomy-resume': 'put a run the closing control stopped back into autonomous mode, with the rounds reset',
  save: 'save the story: commit, push and the pull requests',
  'escape:TYCON_SAFETY_OFF': 'turn off the safety guard for one command (retired: it no longer turns anything off)',
  'escape:TYCON_PROD_LINT': 'turn off the production query control for one command (retired: it no longer turns anything off)',
  'escape:TYCON_NEW_NAMES': 'turn off the new names control on what is published',
  'escape:TYCON_TEST_GATE': "skip the commit's test gate",
  'escape:DOD_BYPASS': "skip the commit's controls (it is logged)",
  'escape:TYCON_NO_DEEP_REVIEW': 'ask to skip the adversarial pass (this signature does not skip it: adversarial-skip does)',
  'escape:TYCON_STATUS_GATE': "change a story's status by hand",
  'escape:TYCON_MUTATION_CHECK': 'skip the mutation check of the tests',
  'escape:TYCON_STORY_REVIEW': "skip the story's review before planning",
  'escape:no-mutation': 'close «Run the tests» without the mutation check, with a reason',
  'escape:story-skill-bypass': 'write a story without the story skill',
  'escape:red-control-test-edit': "edit a control's old test that was failing",
  'escape:set-autonomous': "change a run's autonomous mode",
  'escape:cerrar-la-ejecucion': 'close a run with a control in red',
  'escape:cerrar-como-deuda': 'close a run leaving what is missing as debt, or take a red check of that debt to the commit',
  'escape:rojo-esperado-de-la-matriz': 'take criteria without live evidence to the commit, until a date',
  'escape:force-manual': "set a control's state by hand",
  'escape:trust-ran': 'count the reviewers without the record that they ran',
  'escape:ALLOW_DOD_EVIDENCE_WRITE': 'write the live test evidence by hand',
  'escape:dod_runtime_exempt': 'exempt a story from the live test',
  'escape:advisors_exempt': 'exempt a story from the reviewers',
  'escape:no-deep-review': "run the adversarial pass scripts with an --env-file, which can change its decision",
  'escape:cambiar-el-estado': "change a story's status by hand",
  'escape:merge-bypass': "merge skipping main's queue and CI, or loosen the branch policies",
  'escape:external-pr': 'queue or merge a pull request from someone outside the team',
};

// las firmas que se dan sobre un archivo (`file` en vez del comando, en CON_NOMBRE): `marker.js sign-file` las pide en
// la ventana, y el Edit o Write que sigue consume la constancia
const FIRMAS_DE_ARCHIVO = Object.freeze(CON_NOMBRE.filter((f) => f[2] === 'file').map((f) => f[0]));
// los escapes que pide su propio guion, con su forma canónica: la terminal es esa forma con --terminal
const POR_GUION = Object.freeze(['force-manual', 'trust-ran']);
// los escapes del cierre que pide el marcador, como los de POR_GUION, pero que siguen en el grupo que se delega junto
const POR_EL_MARCADOR = Object.freeze(['set-autonomous', 'cerrar-como-deuda', 'rojo-esperado-de-la-matriz']);
// el rojo esperado de un control va con la firma de cerrar como deuda: la terminal nombra las dos formas exactas
const OTRA_FORMA_EN_LA_TERMINAL = Object.freeze({ 'cerrar-como-deuda': 'marker.js expect-red <control> --tests <T1,T2> --terminal' });
// los escapes que pide su paso, en la sesión que lo corre: el guion pide la firma justo antes de saltear, y no se pide
// para otra sesión ni entra al grupo que se delega junto
const POR_SU_PASO = Object.freeze(['no-mutation']);
const kindDe = (id) => (!id.startsWith('escape:') || [...FIRMAS_DE_ARCHIVO, ...POR_GUION, ...POR_EL_MARCADOR, ...POR_SU_PASO].includes(id.slice('escape:'.length)) ? 'guion' : 'freno');
const sobreArchivo = (nombre) => `marker.js sign-file ${nombre} <archivo>`;

const SIGNATURES = Object.freeze([
  { id: 'plan-approval', approves: 'aprobar el plan de una story', command: 'marker.js complete-step approve-plan --approved', otherSession: 'yes', terminal: 'marker.js complete-step approve-plan --terminal' },
  { id: 'extra-round', approves: 'pedir una vuelta más de revisores', command: 'pipeline.js smart-reloop --extra-round', otherSession: 'yes', terminal: 'pipeline.js smart-reloop --extra-round --terminal' },
  { id: 'refresh-after-main', approves: 'refirmar los controles tras traer main, sin cambio propio', command: 'run-base-controls.sh approve', otherSession: 'yes', terminal: 'run-base-controls.sh approve --terminal' },
  { id: 'control-change', approves: 'aprobar un cambio de los controles del repo', command: 'run-base-controls.sh approve', otherSession: 'yes', terminal: 'run-base-controls.sh approve --terminal' },
  { id: 'critical-waiver', approves: 'eximir un hallazgo crítico de los revisores', command: 'marker.js waive-critical', otherSession: 'yes', terminal: 'marker.js waive-critical --terminal' },
  { id: 'runtime-waiver', approves: 'aceptar un criterio imposible de probar en vivo', command: 'marker.js runtime-waiver', otherSession: 'yes', terminal: 'marker.js runtime-waiver <historia> --terminal' },
  { id: 'compare-waiver', approves: 'eximir de la comparación con main a un comando que la historia modifica', command: 'marker.js compare-waiver --story <S> --command <candidato> --reason <R>', otherSession: 'yes', terminal: 'marker.js compare-waiver --story <S> --command <candidato> --reason <R> --terminal' },
  { id: 'write-after-release', approves: 'liberar el freno que sigue a una mirada fallida de lo que escribió un comando', command: 'marker.js release-write-after --for-session <S> --reason <R>', otherSession: 'yes', terminal: 'marker.js release-write-after --for-session <S> --reason <R> --terminal' },
  { id: 'manual-test', approves: 'marcar un criterio como probado a mano', command: 'marker.js mark-tested --acs', otherSession: 'yes', terminal: 'marker.js mark-tested --acs --terminal' },
  { id: 'browser-test', approves: 'preparar la prueba con navegador, o decirle que no', command: 'e2e-setup.js prepare (o defer --no)', otherSession: 'yes', terminal: 'e2e-setup.js prepare --terminal (o defer --no --terminal)' },
  { id: 'lost-run', approves: 'dar por perdida una ejecución y cerrarla', command: 'marker.js clear-session --lost (o restore)', otherSession: 'yes', terminal: 'marker.js clear-session --lost --terminal (o restore --terminal)' },
  // la ejecución que la partición de su historia dejó sin objeto: el freno la elige por la bandera, y el guion comprueba
  // antes de la firma que la historia se partió después de la apertura
  { id: LOST_RUN_PARTICION, approves: 'cerrar una ejecución perdida que la partición de su historia en tandas dejó sin objeto', command: 'marker.js clear-session <S> --lost --partition', otherSession: 'yes', terminal: 'marker.js clear-session <S> --lost --partition --terminal' },
  { id: 'adversarial-skip', approves: 'saltear el pase adversarial con constancia', command: 'marker.js sign-adversarial-skip --story <S> --reason <R>', otherSession: 'no', terminal: 'marker.js sign-adversarial-skip --story <S> --reason <R> --terminal' },
  { id: 'atdd-skip', approves: 'saltear «pruebas primero» en una ejecución, con constancia', command: 'marker.js sign-atdd-skip --story <S> --reason <R>', otherSession: 'no', terminal: 'marker.js sign-atdd-skip --story <S> --reason <R> --terminal' },
  // la pregunta del pase del código la contesta la coordinadora en la pestaña donde el dueño contesta: su click o su
  // «aprobado» ahí, nunca la delegación. Con el dueño ausente y la celda en skip, `--by-profile` no pide firma
  { id: 'review-skip', approves: 'contestar «skip» a la pregunta del pase del código', command: 'marker.js review-answer --kind code --choice skip', otherSession: 'yes', terminal: 'marker.js review-answer --kind code --choice skip --terminal' },
  { id: 'pending-approval', approves: 'abrir un pendiente nuevo en la lista de pendientes', command: 'marker.js approve-pending --id <CÓDIGO> --repo <carpeta>', otherSession: 'yes', terminal: 'marker.js approve-pending --id <CÓDIGO> --repo <carpeta> --terminal' },
  { id: 'adhoc-lane', approves: 'abrir el arreglo rápido de una sesión, sin historia', command: "marker.js adhoc set '<json>'", otherSession: 'yes', terminal: 'marker.js adhoc set --reason "<motivo>" [--max-files N] --data sin-cambio --file <ruta> --terminal --for-session <id>' },
  { id: 'adhoc-lane:sobre-cupo', approves: 'abrir un arreglo rápido que pasa el tope de archivos del camino corto, aunque se recomienda una historia', command: "marker.js adhoc set '<json con maxFiles mayor que el tope, por defecto 8>'", otherSession: 'yes', terminal: 'marker.js adhoc set --reason "<motivo>" --max-files <N> --data sin-cambio --file <ruta> --terminal --for-session <id>',
    // como el freno de los datos: sólo el click del dueño, en la pestaña que trabaja o en la de la coordinadora vigente, o su
    // terminal; nunca la delegación, un «aprobado» escrito ni la ventana de permiso
    clickDelDueno: true, descripciones: Object.freeze(['La sesión sigue con el arreglo. Pasa el tope de archivos del camino corto: lo elegís vos, en lugar de una historia.', 'No se abre el arreglo, y el trabajo va por una historia.']) },
  // el arreglo del rojo de CI de un pedido abierto: el dueño en la ventana, su click o su terminal, o la coordinadora si el
  // perfil lo delega
  { id: CI_ROJO, approves: 'abrir el arreglo de un rojo de CI de un pull request abierto, sin plan ni revisores', command: 'marker.js adhoc set --ci-red <pedido> --check <control> --reason <motivo> --data sin-cambio --file <ruta>', otherSession: 'yes',
    terminal: 'marker.js adhoc set --ci-red <pedido> --check <control> --reason "<motivo>" --data sin-cambio --file <ruta> --terminal --for-session <id>' },
  // dejar pasar el freno de los datos: sólo el click del dueño, en la pestaña que trabaja o en la de la coordinadora vigente
  // (que lo pide para esa sesión con --for-session); nunca un «aprobado» escrito, la delegación ni la ventana de permiso
  { id: 'adhoc-lane:datos', approves: 'dejar pasar un arreglo rápido que cambia de dónde sale un dato o quién lo ve, sin historia', command: 'marker.js adhoc allow-data-change --changed <qué cambió> --recommends pasar --why <por qué>', otherSession: otraSinDelegar('adhoc-lane:datos'),
    terminal: 'marker.js adhoc allow-data-change --changed <qué cambió> --recommends pasar --why <por qué> --terminal --for-session <id>',
    clickDelDueno: true, descripciones: Object.freeze(['Dejar pasar: sigue por camino corto, con este cambio de datos o de permisos.', 'No pasa: la sesión escribe la historia; o descarta lo del carril, si lo decís por la coordinadora.']) },
  // dejar pasar una vez un guardado ajeno al carril que espera sus revisores: el click de una persona, en la pestaña que
  // trabaja o en la de la coordinadora, o su terminal; o la coordinadora, para otra sesión, si el perfil se lo delega.
  // Nunca «hecho y avisado» ni un «aprobado» escrito
  { id: 'adhoc-lane:guardado-ajeno', approves: 'dejar pasar una vez un guardado ajeno a un camino corto que espera sus revisores, con lo que guarda a la vista', command: 'marker.js adhoc allow-foreign-save', otherSession: 'yes',
    terminal: 'marker.js adhoc allow-foreign-save --terminal --for-session <id>',
    clickDelDueno: true, descripciones: Object.freeze(['Pasa una vez: este comando, tal como se ve, sin esperar los revisores del carril.', 'No pasa: la sesión espera los revisores y el pase del carril.']) },
  // volver al modo autónomo una ejecución que el control de cierre detuvo: sólo el click del dueño, en la pestaña que
  // trabaja o en la de la coordinadora (que la pide para esa sesión con --for-session), o su terminal (que deja un permiso
  // que la sesión detenida consume); nunca la delegación, «hecho y avisado» ni un «aprobado» escrito
  { id: 'autonomy-resume', approves: 'volver al modo autónomo una ejecución que el control de cierre detuvo, con las vueltas en cero', command: 'marker.js resume-autonomy', otherSession: otraSinDelegar('autonomy-resume'),
    terminal: 'marker.js resume-autonomy --terminal --for-session <id>',
    clickDelDueno: true, descripciones: Object.freeze(['La sesión vuelve a correr los controles y sigue arreglando sola, con vueltas nuevas', 'La sesión queda detenida hasta que entres a ella']) },
  { id: 'save', approves: 'guardar la story: commit, push y los pull requests', command: 'marker.js approve-save [--for-session <D>]', otherSession: 'yes', terminal: 'marker.js approve-save --terminal --for-session <D>' },
  { id: 'designation-confirm', approves: 'confirmar qué sesión es la coordinadora de esta máquina', command: 'delegated-signing.js confirm-designation', otherSession: 'no', terminal: 'delegated-signing.js confirm-designation --terminal' },
  // nombrar y retirar a la coordinadora: el click del dueño en la pestaña de esa sesión, nunca por delegación
  { id: 'designation-set', approves: 'nombrar a esta sesión coordinadora de la máquina', command: 'marker.js designate-relay', otherSession: 'no', terminal: 'marker.js designate-relay --terminal',
    soloClick: true, descripciones: Object.freeze(['Esa sesión ordena la máquina hasta que se nombre otra o la retires; con el perfil, también firma lo que el perfil le delega.', 'No cambia nada.']) },
  { id: 'designation-withdraw', approves: 'retirar a esta sesión de coordinadora de la máquina', command: 'marker.js withdraw-relay', otherSession: 'no', terminal: 'marker.js withdraw-relay --terminal',
    soloClick: true, descripciones: Object.freeze(['La sesión deja de firmar en tu nombre: las firmas vuelven a vos hasta que nombres otra.', 'No cambia nada: sigue siendo la coordinadora.']) },
  ...POR_VARIABLE.map(([nombre, valor, approves]) => ({
    id: `escape:${nombre}`, approves, command: `${nombre}=${valor} <comando>`, otherSession: 'no', terminal: `${nombre}=${valor} <comando>`,
  })),
  ...CON_NOMBRE.map(([nombre, approves, command]) => {
    // la terminal de la persona no tiene la sesión en el ambiente: sin --for-session la constancia no la usaría nadie
    // la coordinadora la pide para otra sesión sólo si es de las que el perfil puede delegar
    if (command === 'file') return { id: `escape:${nombre}`, approves, command: sobreArchivo(nombre), otherSession: DELEGABLE_EXCEPTIONS.includes(`escape:${nombre}`) ? 'yes' : otraSinDelegar(`escape:${nombre}`), terminal: `${sobreArchivo(nombre)} --terminal --for-session <sesión del agente>` };
    if (POR_GUION.includes(nombre) || POR_EL_MARCADOR.includes(nombre)) {
      const otra = OTRA_FORMA_EN_LA_TERMINAL[nombre];
      return { id: `escape:${nombre}`, approves, command, otherSession: 'yes', terminal: `${command.replace(' [--for-session <D>]', '')} --terminal${otra ? `, o ${otra}` : ''}` };
    }
    if (POR_SU_PASO.includes(nombre)) return { id: `escape:${nombre}`, approves, command, otherSession: 'no', terminal: `${command} --terminal --for-session <sesión>` };
    return { id: `escape:${nombre}`, approves, command, otherSession: 'no', terminal: 'el mismo comando' };
  }),
].map((s) => {
  const covers = coversOf(s.id).map(levelOf);
  return Object.freeze({
    ...s, approvesEn: APPROVES_EN[s.id] || null, kind: kindDe(s.id), ifWrong: SI_SALE_MAL[s.id],
    ...(RETIRADAS[s.id] ? { retired: RETIRADAS[s.id] } : {}),
    covers: Object.freeze(covers.map((l) => l.id)),
    level: Math.max(...covers.map((l) => l.level)),
    profiles: Object.freeze(AMBOS.filter((p) => covers.some((l) => l.profiles.includes(p)))),
  });
}));

const ESCAPES = SIGNATURES.filter((s) => s.id.startsWith('escape:')).map((s) => s.id);
// lo que nunca se delega (delegated-signing.js NUNCA_DELEGABLES) no entra al grupo que se delega junto; editar la prueba
// de un control tampoco: se delega sólo nombrándola
const FUERA_DEL_GRUPO = Object.freeze(['merge-bypass', 'external-pr', 'red-control-test-edit']);
const ESCAPES_DEL_GRUPO = ESCAPES.filter((id) => ![...POR_GUION, ...POR_SU_PASO].includes(id.slice('escape:'.length)) && !FUERA_DEL_GRUPO.includes(id.slice('escape:'.length)));

const GROUPS = Object.freeze(Object.fromEntries(['refresh-after-main', 'adversarial-skip', 'critical-waiver', 'escape-phrases',
  'plan-approval', 'browser-test', 'runtime-waiver', 'compare-waiver', 'manual-test', 'extra-round', 'control-change', 'lost-run']
  .map((g) => [g, Object.freeze(g === 'escape-phrases' ? ESCAPES_DEL_GRUPO : [g])])));

/**
 * Lo que el ok de guardar por delegación (`save`) no cubre: un cambio que toca algo de esta lista lo firma el dueño.
 * Rutas relativas a la raíz de cada repo, en minúsculas; `*` es un tramo sin `/` y `**` cualquier cosa. Además cuenta
 * todo archivo que hace `require` de uno de REQUIERE_SENSIBLE (save-ok.js lo mira en el texto, un nivel).
 */
const SENSITIVE = Object.freeze([
  // los que definen o verifican firmas
  'scripts/lib/signatures.js', 'scripts/lib/owner-window.js', 'scripts/lib/delegated-signing.js', 'scripts/lib/signature-sources.js',
  // el que confirma que un mensaje lo tipeó la persona, y la marca de ausente que lo usa: editarlos dejaría al agente
  // ponerse la marca solo
  'scripts/lib/owner-approvals.js', 'scripts/lib/owner-away.js',
  'skills/tycon-pipeline/scripts/lib/approvals.js', 'skills/tycon-pipeline/scripts/lib/adversarial-skip.js',
  'skills/tycon-pipeline/scripts/lib/atdd-skip.js',
  'skills/tycon-pipeline/scripts/lib/save-ok.js',
  // los que deciden qué cambiado después de la última vuelta de revisores no pide otra (el portón de «Preparar» y la vuelta
  // sin código que pasa el tope sola)
  'skills/tycon-pipeline/scripts/lib/reviewed-diff.js', 'skills/tycon-pipeline/scripts/lib/reloop-code.js',
  // los que consumen o exigen una firma por un camino armado (`require(path.join(...))`, que la clausura no ve)
  'skills/tycon-pipeline/scripts/dispatch.js', 'skills/tycon-pipeline/scripts/on-*.js',
  'skills/tycon-pipeline/scripts/lib/story-skill-gate*.js', 'skills/tycon-pipeline/scripts/e2e-setup.js',
  // los frenos
  'scripts/hooks/safety-guard*', 'skills/tycon-pipeline/scripts/lib/marker-command.js', 'scripts/production/**',
  // el portón de carril: lo que deja editar sin historia
  'skills/tycon-pipeline/scripts/lib/story-gate.js', 'skills/tycon-pipeline/scripts/lib/story-gate-io.js',
  // la mirada de después: la foto de lo protegido, y el freno que deja cuando no pudo mirar
  'skills/tycon-pipeline/scripts/lib/protected-photo.js', 'skills/tycon-pipeline/scripts/on-bash-write-after.js',
  // lo que decide si la story está limpia: el pase, los hallazgos, las exenciones y el portón de pruebas
  'skills/tycon-pipeline/scripts/marker.js', 'skills/tycon-pipeline/scripts/pipeline.js',
  // lo que sale de esos dos y del freno de guiones al partirlos sigue siendo sensible: lo que carga un sensible, lo es
  'skills/tycon-pipeline/scripts/lib/marker-*.js', 'skills/tycon-pipeline/scripts/lib/pipeline-*.js',
  'skills/tycon-pipeline/scripts/lib/bash-gate-*.js',
  // el nombre de la sesión lo carga el marcador al escribir: corre dentro de él
  'scripts/lib/session-name.js',
  // el lector del bloque `pipelines:` lo carga el cierre de tanda del marcador: decide si una tanda pasa a done
  'scripts/lib/pipelines-block.js',
  // lo que el cierre del marcador carga para decir que la sesión termina: corre dentro de él
  'skills/tycon-pipeline/scripts/lib/resume-state.js',
  // el registro de los frenos: el marcador lo carga al cerrar la ejecución de otra sesión, y en él queda el escape
  'skills/tycon-pipeline/scripts/lib/closing-record.js',
  'skills/tycon-pipeline/scripts/lib/adversarial-verdict.js', 'skills/tycon-pipeline/scripts/lib/critical-waivers.js',
  'skills/tycon-pipeline/scripts/lib/runtime-waiver.js', 'skills/tycon-pipeline/scripts/test-gate.sh',
  'skills/tycon-pipeline/scripts/lib/test-gate-*.js', 'skills/tycon-pipeline/scripts/lib/test-scope.js',
  'scripts/lib/test-scope.js', 'scripts/lib/test-scope-options.json', '.test-gate.yaml',
  // lo que decide si se frena al guardar lo no revisado y qué evidencia en vivo cuenta
  'skills/tycon-pipeline/scripts/lib/frozen-tree.js', 'skills/tycon-pipeline/scripts/lib/comment-only.js', 'skills/tycon-pipeline/scripts/runtime-matrix.js',
  'skills/tycon-pipeline/scripts/smoke-run.sh', 'skills/tycon-pipeline/scripts/lib/evidence-vs-commit.js',
  'skills/tycon-pipeline/scripts/lib/commit-story.js', 'skills/tycon-pipeline/scripts/lib/story-requests.js',
  'skills/tycon-pipeline/scripts/lib/nightly-coverage.js', 'skills/tycon-pipeline/scripts/lib/nightly-green.js',
  // el arreglo de un rojo de CI sin plan ni revisores, el cierre de una ejecución reemplazada sin firma y lo que una vuelta
  // de arreglo deja a seguimiento: los cargan marker.js y pipeline.js
  'skills/tycon-pipeline/scripts/lib/ci-red-lane.js', 'skills/tycon-pipeline/scripts/lib/replaced-run.js', 'skills/tycon-pipeline/scripts/lib/fix-scope.js',
  // lo que el cierre de «Armar el plan» comprueba de las suposiciones del plan: lo carga marker.js
  'skills/tycon-pipeline/scripts/lib/plan-assumptions.js',
  // lo que decide si el dueño se entera
  'scripts/lib/notify.js', 'scripts/lib/notify-mail.js', 'scripts/lib/tycon-*-notify.sh',
  'scripts/lib/integrations.js', 'scripts/lib/tycon-config.js',
  // lo que registra los ganchos y las plantillas de permisos que instala el arnés
  '**/hooks.json', 'scripts/setup/hooks-list.json', 'scripts/setup/harness/managed.js',
  'scripts/setup/harness/read-permissions.js', 'scripts/production/managed-settings*',
  // el poder de la coordinadora y cómo se usa el ok
  'scripts/tools/coordination.js', 'skills/tycon-pipeline/steps/step-11-prepare-commit.md',
  'guides/coordination.md', 'guides/coordination.en.md',
  // los permisos y el perfil del equipo
  // los ajustes de Claude con cualquier sufijo, en cualquier carpeta: más ancho que la carpeta de Claude, nunca menos
  '**/settings*.json', 'settings*.json',
  '**/team-profile.json', 'team-profile.json',
]);
const REQUIERE_SENSIBLE = Object.freeze(['signatures.js', 'owner-window.js', 'delegated-signing.js', 'approvals.js', 'notify.js']);

/**
 * La firma que pide un `adhoc set`, para que el freno y el guion nunca discrepen. `args`: lo que sigue a `set`, cada palabra
 * como texto (ya leída) o como `{ texto, literal }`. Una palabra que no se lee hasta correr, o un cupo que no se entiende,
 * cuenta como sobre cupo. Sin número sigue la firma común: conserva el cupo que tenía el carril. `tope`: el de la
 * organización (lo lee el borde, una vez, para el freno y el guion); sin él, el de fábrica. `cwd`: la carpeta del pedido;
 * con ella, `<Nombre>/<ruta>` de un repo hermano se cuenta sin el prefijo, como en su repo.
 */
function firmaDelPedidoAdhoc(args = [], tope = TOPE, { cwd = null } = {}) {
  if (args.some((w) => w && typeof w === 'object' && !w.literal)) return SOBRE_CUPO;
  const a = args.map((w) => String(w && typeof w === 'object' ? w.texto : w));
  const limite = Number.isInteger(tope) && tope > 0 ? tope : TOPE;
  const dentro = (n) => Number.isInteger(n) && n <= limite;
  // la lista de archivos cuenta como el cupo pedido: más código que el tope es pasar el tope, aunque no diga maxFiles.
  // Si no se puede contar (falta el módulo de la lista), cuenta como sobre cupo
  const codigoDe = (rutas) => {
    try {
      const L = require(require('path').join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'adhoc-list.js'));
      return rutas.filter((f) => typeof f === 'string' && L.esCodigoRel(f, { cwd })).length;
    } catch (_) { return Infinity; }
  };
  if (String(a[0] || '').startsWith('--')) {
    if (a.some((w) => w.startsWith('--max-files=') || w.startsWith('--file='))) return SOBRE_CUPO;
    // el arreglo de un rojo de CI: su propia firma, con su tope; un cupo pedido o más archivos que el tope, pruebas
    // incluidas, no es esta vía
    if (a.includes('--ci-red') || a.some((w) => w.startsWith('--ci-red='))) {
      if (a.includes('--max-files') || a.some((w) => w.startsWith('--ci-red='))) return SOBRE_CUPO;
      const deLaLista = a.flatMap((w, i) => (w === '--file' ? [a[i + 1]] : []));
      return deLaLista.length <= TOPE_CI_ROJO ? CI_ROJO : SOBRE_CUPO;
    }
    const lista = a.flatMap((w, i) => (w === '--file' ? [a[i + 1]] : []));
    if (lista.length && !dentro(codigoDe(lista))) return SOBRE_CUPO;
    const i = a.indexOf('--max-files');
    return i < 0 || (/^\d+$/.test(a[i + 1] || '') && dentro(Number(a[i + 1]))) ? ADHOC : SOBRE_CUPO;
  }
  let p;
  try { p = JSON.parse(a[0]); } catch (_) { return SOBRE_CUPO; }
  if (!p || typeof p !== 'object') return SOBRE_CUPO;
  if (Array.isArray(p.allowedFiles) && !dentro(codigoDe(p.allowedFiles))) return SOBRE_CUPO;
  return p.maxFiles === undefined || dentro(p.maxFiles) ? ADHOC : SOBRE_CUPO;
}

function ids() { return SIGNATURES.map((s) => s.id); }
function groupNames() { return Object.keys(GROUPS); }
function isId(v) { return SIGNATURES.some((s) => s.id === v); }
function isForm(v) { return Object.prototype.hasOwnProperty.call(DELEGABLE_FORMS, v); }
function formNames() { return Object.keys(DELEGABLE_FORMS); }

/**
 * Los ids que nombra un valor de la lista: un grupo, sus firmas; un id, él mismo; `off` o desconocido, ninguno. Con
 * `restringe` (la lista `owner_only`), `escape-phrases` son todos los escapes.
 */
function expand(v, { restringe = false } = {}) {
  if (restringe && v === 'escape-phrases') return [...ESCAPES];
  // la forma de rutina de lost-run: «lost-run» en owner_only la cubre, y en delegated_signing no (la delegación no mira
  // niveles: un perfil que ya delega «lost-run» la delegaría sin un pedido aparte)
  if (restringe && v === 'lost-run') return ['lost-run', LOST_RUN_PARTICION];
  if (Object.prototype.hasOwnProperty.call(GROUPS, v)) return [...GROUPS[v]];
  return isId(v) || isForm(v) ? [v] : [];
}

/**
 * El nivel que rige para un id de LEVELS: el mayor entre el de la tabla y el que pone el perfil del equipo
 * (`approvals.levels`, `{ id: nivel }`). El perfil sólo sube: un nivel menor que el de la tabla no cuenta. null si el id
 * no está en la tabla.
 */
function effectiveLevel(id, raised) {
  const l = levelOf(id);
  if (!l) return null;
  const n = raised && typeof raised === 'object' && Number.isInteger(raised[id]) ? raised[id] : 0;
  return Math.max(l.level, n);
}

/**
 * El nivel que alcanza una firma de SIGNATURES cuando la da la coordinadora por delegación: el mayor de lo que cubre,
 * sin lo que la delegación no firma (NOT_DELEGATED), con lo que suba el perfil (`raised`, como en effectiveLevel). null
 * si el id no es una firma.
 */
function delegatedLevel(id, raised) {
  const s = SIGNATURES.find((x) => x.id === id);
  if (!s) return null;
  return Math.max(...s.covers.filter((c) => !NOT_DELEGATED.includes(c)).map((c) => effectiveLevel(c, raised)));
}

/**
 * ¿El perfil puede delegar `id` a la coordinadora? La rutina (nivel 1 por delegación), y las excepciones de trámite
 * (DELEGABLE_EXCEPTIONS y las formas de DELEGABLE_FORMS) mientras sigan en nivel 2: lo que el perfil sube a 3 con
 * `approvals.levels` (`raised`), o una rutina que sube a 2, vuelve a una persona. false si el id no existe.
 */
function delegable(id, raised) {
  if (isForm(id)) {
    if (delegatedLevel(DELEGABLE_FORMS[id], raised) >= 2) return false;
    return !levelOf(id) || effectiveLevel(id, raised) <= 2;
  }
  const n = delegatedLevel(id, raised);
  if (n === null) return false;
  return n < 2 || (n === 2 && DELEGABLE_EXCEPTIONS.includes(id) && delegatedLevel(id) === 2);
}

// Lo que no tiene vuelta atrás: sólo se firma en la terminal de la persona, nunca con un click ni con un «aprobado»
const ONLY_IN_TERMINAL = Object.freeze(['escape:TYCON_SAFETY_OFF', 'escape:TYCON_PROD_LINT', 'emergency']);

module.exports = { TOPE, SOBRE_CUPO, CI_ROJO, TOPE_CI_ROJO, LOST_RUN_PARTICION, firmaDelPedidoAdhoc, SIGNATURES, LEVELS, GROUPS, FIRMAS_DE_ARCHIVO, SENSITIVE, REQUIERE_SENSIBLE, NOT_DELEGATED, DELEGABLE_EXCEPTIONS, PARA_OTRA_SESION_SIN_DELEGAR, DELEGABLE_FORMS, PLAN_DELICADO, SAVE_SENSIBLE, ONLY_IN_TERMINAL, ids, groupNames, formNames, isId, isForm, expand, effectiveLevel, delegatedLevel, delegable };
