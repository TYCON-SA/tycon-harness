'use strict';
/**
 * signatures.js — el catálogo de las firmas del dueño (@story-8.139).
 *
 * Una entrada por cada cosa que un freno le pide firmar a una persona. Lo leen el lector de la configuración (con qué
 * ids se escriben `approvals.delegated_signing` y `approvals.owner_only`) y la guía `guides/firmas-del-arnes.md`, que
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
 *                 son las de las dos opciones de su cuadro, en el orden de las opciones.
 *   clickDelDueno la aprueba sólo el click del dueño, en la pestaña que trabaja o en la de la coordinadora confirmada y
 *                 viva, o su terminal: nunca un «aprobado» escrito, la delegación ni la ventana. Lleva `descripciones`.
 *   terminal      cómo la firma el dueño en su terminal si lo prefiere (salvo lo irreversible, una firma también se aprueba
 *                 sin terminal: en la ventana de permiso o, donde no llega, con un click en el cuadro de opciones o un
 *                 «aprobado» escrito; owner-window.js), o null mientras no tenga comando.
 *   ifWrong       qué pasa si sale mal, en llano: lo muestra el cuadro de opciones.
 *   covers        los ids de LEVELS que aprueba: el suyo, o dos si la firma de hoy junta dos cosas de distinto peso,
 *                 u otro si es un escape que hace lo mismo que otra firma.
 *   level         el mayor nivel de lo que cubre.
 *   profiles      a quién se le pide: 'dev' (el dev de producto) y 'mant' (quien mantiene el arnés).
 *
 * LEVELS es la tabla de niveles del esquema de firmas, un nivel por id: 1 rutina, 2 excepción (da por bueno
 * algo sin verificarlo y deja deuda), 3 irreversible o afloja un freno. Sus ids todavía no se piden por su nombre: los
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

// qué aprueba cada id de la tabla, en inglés: la pantalla del sitio lo muestra en ese idioma
const LEVELS_EN = Object.freeze({
  'plan-approval': 'approve the plan (level 2 if the story is sensitive: risk-class works it out; the coordinator approves level 1 only with the approved verdict of the automatic review)',
  'extra-round': 'one more round of reviewers',
  'pending-approval': 'open a new item in the pending list',
  'save': 'save: commit, push and pull requests, if no commit touches anything sensitive',
  'browser-test:prepare': 'prepare the browser test',
  'adhoc-lane': 'open a quick fix without a story, within the quota',
  'compare-waiver': 'exempt a command the story modifies from the comparison with main',
  'refresh-after-main': 're-sign the controls after pulling main, with no change of your own',
  'save:sensible': 'save when a commit touches something sensitive',
  'adhoc-lane:sobre-cupo': 'open a quick fix that goes past the file limit of the short path, though a story is recommended (only implementation files count, not tests or guides)',
  'adhoc-lane:datos': 'let a quick fix that changes where a piece of data comes from, or who can see it, go through without a story (only the owner\'s click)',
  'adhoc-lane:guardado-ajeno': 'let a save that is not part of a quick fix waiting for its reviewers go through once, with what it saves in view (only a person\'s click or terminal)',
  'escape:DOD_BYPASS': 'skip every control of the commit',
  'critical-waiver': 'waive a critical finding',
  'runtime-waiver': 'accept a criterion that cannot be tested live, or exempt the whole story',
  'manual-test': 'mark a criterion as tested by hand',
  'browser-test:no': 'say no to the browser test',
  'adversarial-skip': 'skip the adversarial pass',
  'lost-run': 'give up on a run as lost and close it',
  'escape:force-manual': "mark a control's result by hand",
  'escape:trust-ran': 'count reviewers with no record that they ran',
  'escape:TYCON_TEST_GATE': 'skip only the test gate of the commit',
  'escape:TYCON_STATUS_GATE': "change a story's status by hand",
  'escape:story-skill-bypass': 'write a story without the story skill',
  'escape:set-autonomous': 'change the autonomous mode of a run',
  'designation-confirm': 'confirm which session is the coordinator of this machine',
  'designation-set': "name a session as this machine's coordinator, with a click in its tab",
  'designation-withdraw': "withdraw this machine's coordinator, with a click in its tab",
  'control-change': 'any change to a control',
  'escape:TYCON_SAFETY_OFF': 'turn off the safety guard for one command',
  'escape:TYCON_PROD_LINT': 'turn off the production query control',
  'escape:TYCON_NEW_NAMES': 'turn off the names check on what is published',
  emergency: 'the emergency exit: let one command that a brake stops go through, with a reason and for that command only',
  'escape:merge-bypass': "merge skipping main's queue and CI, or loosen the branch policies: one command, never delegated",
});

// id, nivel, perfiles, qué aprueba
const LEVELS = Object.freeze([
  ['plan-approval', 1, AMBOS, 'aprobar el plan (nivel 2 si la historia es delicada: lo calcula risk-class; la coordinadora aprueba el nivel 1 sólo con el veredicto aprobado de la revisión automática)'],
  ['extra-round', 1, AMBOS, 'una vuelta más de revisores'],
  ['pending-approval', 1, AMBOS, 'abrir un pendiente nuevo en la lista'],
  ['save', 1, AMBOS, 'guardar: commit, push y pull requests, si ningún commit toca algo de lo sensible'],
  ['browser-test:prepare', 1, AMBOS, 'preparar la prueba con navegador'],
  ['adhoc-lane', 1, AMBOS, 'abrir un arreglo rápido sin historia, dentro del cupo'],
  ['compare-waiver', 1, AMBOS, 'eximir de la comparación con main a un comando que la historia modifica (delegable sólo si el perfil la suma a approvals.delegated_signing)'],
  ['refresh-after-main', 1, MANT, 'refirmar los controles tras traer main, sin cambio propio'],
  ['save:sensible', 2, AMBOS, 'guardar cuando un commit toca algo de lo sensible'],
  ['adhoc-lane:datos', 2, AMBOS, 'dejar pasar un arreglo rápido que cambia de dónde sale un dato o quién lo ve, sin historia (sólo el click del dueño)'],
  ['adhoc-lane:guardado-ajeno', 2, AMBOS, 'dejar pasar una vez un guardado ajeno a un camino corto que espera sus revisores, con lo que guarda a la vista (sólo el click o la terminal de una persona)'],
  ['adhoc-lane:sobre-cupo', 2, AMBOS, 'abrir un arreglo rápido que pasa el tope de archivos del camino corto, aunque se recomienda una historia (cuentan sólo los archivos de implementación, sin pruebas ni guías)'],
  ['escape:DOD_BYPASS', 2, AMBOS, 'saltear todos los controles del commit'],
  ['critical-waiver', 2, AMBOS, 'eximir un hallazgo crítico'],
  ['runtime-waiver', 2, AMBOS, 'aceptar un criterio imposible de probar en vivo, o eximir la historia entera'],
  ['manual-test', 2, AMBOS, 'marcar un criterio como probado a mano'],
  ['browser-test:no', 2, AMBOS, 'decir que no a la prueba con navegador'],
  ['adversarial-skip', 2, AMBOS, 'saltear el pase adversarial'],
  ['lost-run', 2, AMBOS, 'dar por perdida una ejecución y cerrarla'],
  ['escape:force-manual', 2, AMBOS, 'marcar a mano el estado de un control'],
  ['escape:trust-ran', 2, AMBOS, 'contar revisores sin constancia de que corrieron'],
  ['escape:TYCON_TEST_GATE', 2, AMBOS, 'saltear sólo el portón de pruebas del commit'],
  ['escape:TYCON_STATUS_GATE', 2, AMBOS, 'cambiar a mano el estado de una historia'],
  ['escape:story-skill-bypass', 2, AMBOS, 'escribir una historia sin la skill de historias'],
  ['escape:set-autonomous', 2, AMBOS, 'cambiar el modo autónomo de una ejecución'],
  ['designation-confirm', 2, AMBOS, 'confirmar qué sesión es la coordinadora de esta máquina'],
  ['designation-set', 2, AMBOS, 'nombrar a una sesión coordinadora de esta máquina, con un click en su pestaña'],
  ['designation-withdraw', 2, AMBOS, 'retirar a la coordinadora de esta máquina, con un click en su pestaña'],
  ['control-change', 3, MANT, 'cualquier cambio de control'],
  ['escape:TYCON_SAFETY_OFF', 3, AMBOS, 'apagar el freno de seguridad para un comando'],
  ['escape:TYCON_PROD_LINT', 3, AMBOS, 'apagar el control de consultas a producción'],
  ['escape:TYCON_NEW_NAMES', 3, MANT, 'apagar el control de nombres en lo que se publica'],
  ['emergency', 3, AMBOS, 'la salida de emergencia: dejar pasar un comando que un freno para, con motivo y para ese comando solo'],
  ['escape:merge-bypass', 3, AMBOS, 'mergear salteando la cola y la CI de main, o aflojar las políticas de la rama: un comando, nunca por delegación'],
].map(([id, level, profiles, approves]) => Object.freeze({ id, level, profiles, approves, approvesEn: LEVELS_EN[id] || null })));

// lo que cubre cada firma de hoy que no es su propio id de la tabla: las dos que juntan dos cosas de distinto peso y
// los siete escapes que hacen lo mismo que otra firma
const COVERS = Object.freeze({
  'save': ['save', 'save:sensible'],
  'browser-test': ['browser-test:prepare', 'browser-test:no'],
  'escape:dod_runtime_exempt': ['runtime-waiver'],
  'escape:ALLOW_DOD_EVIDENCE_WRITE': ['manual-test'],
  'escape:TYCON_NO_DEEP_REVIEW': ['adversarial-skip'],
  'escape:no-deep-review': ['adversarial-skip'],
  'escape:cerrar-la-ejecucion': ['lost-run'],
  'escape:cerrar-como-deuda': ['lost-run'],
  'escape:cambiar-el-estado': ['escape:TYCON_STATUS_GATE'],
});
// lo que una firma cubre pero no se firma por delegación: el ok de guardar delegado no firma un cambio que toca algo de
// SENSITIVE (skills/tycon-pipeline/scripts/lib/save-ok.js)
const NOT_DELEGATED = Object.freeze(['save:sensible']);

const levelOf = (id) => LEVELS.find((l) => l.id === id);
const coversOf = (id) => COVERS[id] || [id];

const POR_VARIABLE = [
  ['TYCON_SAFETY_OFF', '1', 'apagar el freno de seguridad para un comando'],
  ['TYCON_PROD_LINT', '0', 'apagar el control de consultas a producción para un comando'],
  ['TYCON_NEW_NAMES', '0', 'apagar el control de nombres nuevos en lo que se publica'],
  ['TYCON_TEST_GATE', '1', 'saltear el portón de pruebas del commit'],
  ['DOD_BYPASS', '1', 'saltear los controles del commit (queda anotado)'],
  ['TYCON_NO_DEEP_REVIEW', '1', 'apagar el pase adversarial de una ejecución'],
  ['TYCON_STATUS_GATE', 'off', 'cambiar a mano el estado de una story'],
];

const CON_NOMBRE = [
  ['story-skill-bypass', 'escribir una story sin la skill de stories', 'file'],
  ['set-autonomous', 'cambiar el modo autónomo de una ejecución', 'marker.js set-autonomous'],
  ['cerrar-la-ejecucion', 'cerrar una ejecución con un control en rojo', 'marker.js clear'],
  ['cerrar-como-deuda', 'cerrar una ejecución dejando lo que falta como deuda', 'marker.js close-as-debt'],
  ['force-manual', 'marcar a mano el estado de un control', 'marker.js set-check <control> <estado> --force-manual [--for-session <D>]'],
  ['trust-ran', 'contar los revisores sin la constancia de que corrieron', 'pipeline.js check-count --repo <r> --story <s> --trust-ran [--for-session <D>]'],
  ['ALLOW_DOD_EVIDENCE_WRITE', 'escribir a mano la evidencia de la prueba en vivo', 'file'],
  ['dod_runtime_exempt', 'eximir una story de la prueba en vivo', 'file'],
  ['no-deep-review', 'saltear el pase adversarial de una ejecución', 'pipeline.js start --no-deep-review'],
  ['cambiar-el-estado', 'cambiar a mano el estado de una story', 'file'],
  ['merge-bypass', 'mergear salteando la cola y la CI de main, o aflojar las políticas de la rama', 'gh pr merge <n> --admin (o un merge, una regla o una política por la API)'],
];

// qué pasa si sale mal: lo dice el cuadro de opciones que arma el guion de la firma (owner-window.js `cuadroPara`). Cada
// firma trae el suyo, escapes incluidos: un mismo texto para todas no le dice a la persona qué arriesga con ésta
const SI_SALE_MAL = Object.freeze({
  'escape:TYCON_SAFETY_OFF': 'un comando que el freno de seguridad para, como un borrado grande o un push forzado, corre sin freno',
  'escape:TYCON_PROD_LINT': 'una consulta a producción corre sin que nadie mire si escribe o borra datos',
  'escape:TYCON_NEW_NAMES': 'un nombre viejo o interno sale en lo que se publica',
  'escape:TYCON_TEST_GATE': 'el commit entra sin correr las pruebas, y una prueba rota llega al pedido',
  'escape:DOD_BYPASS': 'el commit entra sin ningún control de cierre, y un criterio sin probar puede llegar a main; queda anotado',
  'escape:TYCON_NO_DEEP_REVIEW': 'la ejecución sigue sin el pase adversarial, y un error que él encontraría puede llegar a main',
  'escape:no-deep-review': 'la ejecución arranca sin el pase adversarial, y un error que él encontraría puede llegar a main',
  'escape:TYCON_STATUS_GATE': 'la historia cambia de estado sin los controles del orquestador, y puede quedar como hecha sin estarlo',
  'escape:cambiar-el-estado': 'el estado de la historia se escribe a mano, y puede quedar como hecha sin estarlo',
  'escape:story-skill-bypass': 'la historia se escribe sin el validador ni la revisión previa, y puede llegar al plan con huecos',
  'escape:set-autonomous': 'la ejecución cambia cómo se frena sola ante un control en rojo',
  'escape:cerrar-la-ejecucion': 'la ejecución se cierra con un control en rojo, y lo que frenaba queda sin arreglar',
  'escape:cerrar-como-deuda': 'la ejecución se cierra y lo que falta queda anotado como deuda, sin hacer',
  'escape:force-manual': 'un control queda en el estado escrito a mano, aunque nadie lo haya medido',
  'escape:trust-ran': 'los revisores cuentan como corridos sin constancia, y uno que no corrió pasa por corrido',
  'escape:ALLOW_DOD_EVIDENCE_WRITE': 'la evidencia de la prueba en vivo queda escrita a mano, y puede decir algo que no pasó',
  'escape:dod_runtime_exempt': 'la historia entera queda sin prueba en vivo, y un error puede llegar a producción',
  'escape:merge-bypass': 'el cambio entra a main sin la cola ni la CI, o una política de la rama queda floja, y lo que la CI frenaba llega a main',
  'plan-approval': 'se implementa un plan que no querías; se frena la ejecución y se rehace, y nada entra a main sin revisión',
  'extra-round': 'se gasta una vuelta más de revisores; no cambia el código',
  'refresh-after-main': 'queda firmado un control con lo que trajo main; se revierte con otro pedido',
  'control-change': 'un control queda cambiado y lo que frenaba puede pasar; se revierte con otro pedido',
  'critical-waiver': 'un hallazgo crítico entra sin arreglar',
  'compare-waiver': 'el cambio de ese comando entra sin compararse con la versión de main, y una diferencia que nadie declaró puede llegar a main',
  'runtime-waiver': 'un criterio queda sin probar en vivo, y un error puede llegar a producción',
  'manual-test': 'un criterio queda como probado sin una prueba automática que lo repita',
  'browser-test': 'se prepara la prueba con navegador, o queda sin ella y un error de pantalla puede pasar',
  'lost-run': 'la ejecución se cierra y lo que le faltaba queda sin hacer',
  'adversarial-skip': 'el código entra sin el pase adversarial, y un error que él encontraría puede llegar a main',
  'pending-approval': 'queda un pendiente de más en la lista; se cierra a mano',
  'adhoc-lane': 'la sesión escribe código sin historia; se cierra el arreglo, y nada entra a main sin revisión',
  'adhoc-lane:sobre-cupo': 'un cambio grande entra sin el plan ni las pruebas de una historia; se cierra el arreglo, y nada entra a main sin revisión',
  'adhoc-lane:datos': 'un cambio de permisos o de la fuente de un dato llega a producción sin que nadie revise quién lo ve, y una persona sin permiso puede quedar trabada',
  'adhoc-lane:guardado-ajeno': 'se guarda una vez algo que no es del camino corto mientras el carril espera sus revisores; si en verdad era del carril, entra sin ellos y se revierte con otro commit',
  save: 'se guarda en el repo y se abre el pedido; se revierte con otro commit',
  'designation-confirm': 'esa sesión firma en tu nombre lo que el perfil delega, hasta que se designe otra',
  'designation-set': 'una sesión que no querías firma en tu nombre lo que el perfil delega, hasta que la retires o nombres otra',
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
  'runtime-waiver': 'accept a criterion that cannot be tested live',
  'manual-test': 'mark a criterion as tested by hand',
  'browser-test': 'set up the browser test, or say no to it',
  'lost-run': 'give up a run as lost and close it',
  'adversarial-skip': 'skip the adversarial pass with a signed record',
  'pending-approval': 'open a new item in the pending list',
  'adhoc-lane': "open a session's quick fix, with no story",
  'adhoc-lane:sobre-cupo': 'open a quick fix that goes past the file limit of the short path, though a story is recommended',
  'adhoc-lane:datos': 'let a quick fix that changes where a piece of data comes from, or who can see it, go through without a story',
  'adhoc-lane:guardado-ajeno': 'let a save that is not part of a quick fix waiting for its reviewers go through once, with what it saves in view',
  save: 'save the story: commit, push and the pull requests',
  'escape:TYCON_SAFETY_OFF': 'turn off the safety guard for one command',
  'escape:TYCON_PROD_LINT': 'turn off the production query control for one command',
  'escape:TYCON_NEW_NAMES': 'turn off the new names control on what is published',
  'escape:TYCON_TEST_GATE': "skip the commit's test gate",
  'escape:DOD_BYPASS': "skip the commit's controls (it is logged)",
  'escape:TYCON_NO_DEEP_REVIEW': "turn off a run's adversarial pass",
  'escape:TYCON_STATUS_GATE': "change a story's status by hand",
  'escape:story-skill-bypass': 'write a story without the story skill',
  'escape:set-autonomous': "change a run's autonomous mode",
  'escape:cerrar-la-ejecucion': 'close a run with a control in red',
  'escape:cerrar-como-deuda': 'close a run leaving what is missing as debt',
  'escape:force-manual': "set a control's state by hand",
  'escape:trust-ran': 'count the reviewers without the record that they ran',
  'escape:ALLOW_DOD_EVIDENCE_WRITE': 'write the live test evidence by hand',
  'escape:dod_runtime_exempt': 'exempt a story from the live test',
  'escape:no-deep-review': "skip a run's adversarial pass",
  'escape:cambiar-el-estado': "change a story's status by hand",
  'escape:merge-bypass': "merge skipping main's queue and CI, or loosen the branch policies",
};

// las firmas que se dan sobre un archivo (`file` en vez del comando, en CON_NOMBRE): `marker.js sign-file` las pide en
// la ventana, y el Edit o Write que sigue consume la constancia
const FIRMAS_DE_ARCHIVO = Object.freeze(CON_NOMBRE.filter((f) => f[2] === 'file').map((f) => f[0]));
// los escapes que pide su propio guion, con su forma canónica: la terminal es esa forma con --terminal
const POR_GUION = Object.freeze(['force-manual', 'trust-ran']);
const kindDe = (id) => (!id.startsWith('escape:') || [...FIRMAS_DE_ARCHIVO, ...POR_GUION].includes(id.slice('escape:'.length)) ? 'guion' : 'freno');
const sobreArchivo = (nombre) => `marker.js sign-file ${nombre} <archivo>`;

const SIGNATURES = Object.freeze([
  { id: 'plan-approval', approves: 'aprobar el plan de una story', command: 'marker.js complete-step approve-plan --approved', otherSession: 'yes', terminal: 'marker.js complete-step approve-plan --terminal' },
  { id: 'extra-round', approves: 'pedir una vuelta más de revisores', command: 'pipeline.js smart-reloop --extra-round', otherSession: 'yes', terminal: 'pipeline.js smart-reloop --extra-round --terminal' },
  { id: 'refresh-after-main', approves: 'refirmar los controles tras traer main, sin cambio propio', command: 'run-base-controls.sh approve', otherSession: 'yes', terminal: 'run-base-controls.sh approve --terminal' },
  { id: 'control-change', approves: 'aprobar un cambio de los controles del repo', command: 'run-base-controls.sh approve', otherSession: 'yes', terminal: 'run-base-controls.sh approve --terminal' },
  { id: 'critical-waiver', approves: 'eximir un hallazgo crítico de los revisores', command: 'marker.js waive-critical', otherSession: 'yes', terminal: 'marker.js waive-critical --terminal' },
  { id: 'runtime-waiver', approves: 'aceptar un criterio imposible de probar en vivo', command: 'marker.js runtime-waiver', otherSession: 'yes', terminal: 'marker.js runtime-waiver <historia> --terminal' },
  { id: 'compare-waiver', approves: 'eximir de la comparación con main a un comando que la historia modifica', command: 'marker.js compare-waiver --story <S> --command <candidato> --reason <R>', otherSession: 'yes', terminal: 'marker.js compare-waiver --story <S> --command <candidato> --reason <R> --terminal' },
  { id: 'manual-test', approves: 'marcar un criterio como probado a mano', command: 'marker.js mark-tested --acs', otherSession: 'yes', terminal: 'marker.js mark-tested --acs --terminal' },
  { id: 'browser-test', approves: 'preparar la prueba con navegador, o decirle que no', command: 'e2e-setup.js prepare (o defer --no)', otherSession: 'yes', terminal: 'e2e-setup.js prepare --terminal (o defer --no --terminal)' },
  { id: 'lost-run', approves: 'dar por perdida una ejecución y cerrarla', command: 'marker.js clear-session --lost (o restore)', otherSession: 'yes', terminal: 'marker.js clear-session --lost --terminal (o restore --terminal)' },
  { id: 'adversarial-skip', approves: 'saltear el pase adversarial con constancia', command: 'marker.js sign-adversarial-skip --story <S> --reason <R>', otherSession: 'no', terminal: 'marker.js sign-adversarial-skip --story <S> --reason <R> --terminal' },
  { id: 'pending-approval', approves: 'abrir un pendiente nuevo en la lista de pendientes', command: 'marker.js approve-pending --id <CÓDIGO> --repo <carpeta>', otherSession: 'yes', terminal: 'marker.js approve-pending --id <CÓDIGO> --repo <carpeta> --terminal' },
  { id: 'adhoc-lane', approves: 'abrir el arreglo rápido de una sesión, sin historia', command: "marker.js adhoc set '<json>'", otherSession: 'yes', terminal: 'marker.js adhoc set --reason "<motivo>" [--max-files N] --data sin-cambio --file <ruta> --terminal --for-session <id>' },
  { id: 'adhoc-lane:sobre-cupo', approves: 'abrir un arreglo rápido que pasa el tope de archivos del camino corto, aunque se recomienda una historia', command: "marker.js adhoc set '<json con maxFiles mayor que el tope, por defecto 8>'", otherSession: 'no', terminal: 'marker.js adhoc set --reason "<motivo>" --max-files <N> --data sin-cambio --file <ruta> --terminal --for-session <id>',
    soloClick: true, descripciones: Object.freeze(['La sesión sigue con el arreglo. Pasa el tope de archivos del camino corto: lo elegís vos, en lugar de una historia.', 'No se abre el arreglo, y el trabajo va por una historia.']) },
  // dejar pasar el freno de los datos: sólo el click del dueño, en la pestaña que trabaja o en la de la coordinadora vigente;
  // nunca un «aprobado» escrito, la delegación ni la ventana de permiso
  { id: 'adhoc-lane:datos', approves: 'dejar pasar un arreglo rápido que cambia de dónde sale un dato o quién lo ve, sin historia', command: 'marker.js adhoc allow-data-change --changed <qué cambió> --recommends pasar --why <por qué>', otherSession: 'no',
    terminal: 'marker.js adhoc allow-data-change --changed <qué cambió> --recommends pasar --why <por qué> --terminal --for-session <id>',
    clickDelDueno: true, descripciones: Object.freeze(['Dejar pasar: sigue por camino corto, con este cambio de datos o de permisos.', 'No pasa: la sesión escribe la historia; o descarta lo del carril, si lo decís por la coordinadora.']) },
  // dejar pasar una vez un guardado ajeno al carril que espera sus revisores: sólo el click de una persona, en la pestaña
  // que trabaja o en la de la coordinadora, o su terminal; nunca la delegación, «hecho y avisado» ni un «aprobado» escrito
  { id: 'adhoc-lane:guardado-ajeno', approves: 'dejar pasar una vez un guardado ajeno a un camino corto que espera sus revisores, con lo que guarda a la vista', command: 'marker.js adhoc allow-foreign-save', otherSession: 'no',
    terminal: 'marker.js adhoc allow-foreign-save --terminal --for-session <id>',
    clickDelDueno: true, descripciones: Object.freeze(['Pasa una vez: este comando, tal como se ve, sin esperar los revisores del carril.', 'No pasa: la sesión espera los revisores y el pase del carril.']) },
  { id: 'save', approves: 'guardar la story: commit, push y los pull requests', command: 'marker.js approve-save [--for-session <D>]', otherSession: 'yes', terminal: 'marker.js approve-save --terminal --for-session <D>' },
  { id: 'designation-confirm', approves: 'confirmar qué sesión es la coordinadora de esta máquina', command: 'delegated-signing.js confirm-designation', otherSession: 'no', terminal: 'delegated-signing.js confirm-designation --terminal' },
  // nombrar y retirar a la coordinadora: el click del dueño en la pestaña de esa sesión, nunca por delegación
  { id: 'designation-set', approves: 'nombrar a esta sesión coordinadora de la máquina', command: 'marker.js designate-relay', otherSession: 'no', terminal: 'marker.js designate-relay --terminal',
    soloClick: true, descripciones: Object.freeze(['Esa sesión firma en tu nombre lo que el perfil delega, hasta que se nombre otra o la retires.', 'No cambia nada.']) },
  { id: 'designation-withdraw', approves: 'retirar a esta sesión de coordinadora de la máquina', command: 'marker.js withdraw-relay', otherSession: 'no', terminal: 'marker.js withdraw-relay --terminal',
    soloClick: true, descripciones: Object.freeze(['La sesión deja de firmar en tu nombre: las firmas vuelven a vos hasta que nombres otra.', 'No cambia nada: sigue siendo la coordinadora.']) },
  ...POR_VARIABLE.map(([nombre, valor, approves]) => ({
    id: `escape:${nombre}`, approves, command: `${nombre}=${valor} <comando>`, otherSession: 'no', terminal: `${nombre}=${valor} <comando>`,
  })),
  ...CON_NOMBRE.map(([nombre, approves, command]) => {
    if (command === 'file') return { id: `escape:${nombre}`, approves, command: sobreArchivo(nombre), otherSession: 'no', terminal: `${sobreArchivo(nombre)} --terminal` };
    if (POR_GUION.includes(nombre)) return { id: `escape:${nombre}`, approves, command, otherSession: 'yes', terminal: `${command.replace(' [--for-session <D>]', '')} --terminal` };
    return { id: `escape:${nombre}`, approves, command, otherSession: 'no', terminal: 'el mismo comando' };
  }),
].map((s) => {
  const covers = coversOf(s.id).map(levelOf);
  return Object.freeze({
    ...s, approvesEn: APPROVES_EN[s.id] || null, kind: kindDe(s.id), ifWrong: SI_SALE_MAL[s.id],
    covers: Object.freeze(covers.map((l) => l.id)),
    level: Math.max(...covers.map((l) => l.level)),
    profiles: Object.freeze(AMBOS.filter((p) => covers.some((l) => l.profiles.includes(p)))),
  });
}));

const ESCAPES = SIGNATURES.filter((s) => s.id.startsWith('escape:')).map((s) => s.id);
// lo que nunca se delega (delegated-signing.js NUNCA_DELEGABLES) tampoco entra al grupo que se delega junto
const FUERA_DEL_GRUPO = Object.freeze(['merge-bypass']);
const ESCAPES_DEL_GRUPO = ESCAPES.filter((id) => !POR_GUION.includes(id.slice('escape:'.length)) && !FUERA_DEL_GRUPO.includes(id.slice('escape:'.length)));

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
  'skills/tycon-pipeline/scripts/lib/approvals.js', 'skills/tycon-pipeline/scripts/lib/adversarial-skip.js',
  'skills/tycon-pipeline/scripts/lib/save-ok.js',
  // los que consumen o exigen una firma por un camino armado (`require(path.join(...))`, que la clausura no ve)
  'skills/tycon-pipeline/scripts/dispatch.js', 'skills/tycon-pipeline/scripts/on-*.js',
  'skills/tycon-pipeline/scripts/lib/story-skill-gate*.js', 'skills/tycon-pipeline/scripts/e2e-setup.js',
  // los frenos
  'scripts/hooks/safety-guard*', 'skills/tycon-pipeline/scripts/lib/marker-command.js', 'scripts/production/**',
  // el portón de carril: lo que deja editar sin historia
  'skills/tycon-pipeline/scripts/lib/story-gate.js', 'skills/tycon-pipeline/scripts/lib/story-gate-io.js',
  // lo que decide si la story está limpia: el pase, los hallazgos, las exenciones y el portón de pruebas
  'skills/tycon-pipeline/scripts/marker.js', 'skills/tycon-pipeline/scripts/pipeline.js',
  'skills/tycon-pipeline/scripts/lib/adversarial-verdict.js', 'skills/tycon-pipeline/scripts/lib/critical-waivers.js',
  'skills/tycon-pipeline/scripts/lib/runtime-waiver.js', 'skills/tycon-pipeline/scripts/test-gate.sh',
  'skills/tycon-pipeline/scripts/lib/test-gate-*.js', 'skills/tycon-pipeline/scripts/lib/test-scope.js',
  'scripts/lib/test-scope.js', 'scripts/lib/test-scope-options.json', '.test-gate.yaml',
  // lo que decide si se frena al guardar lo no revisado y qué evidencia en vivo cuenta
  'skills/tycon-pipeline/scripts/lib/frozen-tree.js', 'skills/tycon-pipeline/scripts/runtime-matrix.js',
  'skills/tycon-pipeline/scripts/smoke-run.sh',
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
 * organización (lo lee el borde, una vez, para el freno y el guion); sin él, el de fábrica.
 */
function firmaDelPedidoAdhoc(args = [], tope = TOPE) {
  if (args.some((w) => w && typeof w === 'object' && !w.literal)) return SOBRE_CUPO;
  const a = args.map((w) => String(w && typeof w === 'object' ? w.texto : w));
  const limite = Number.isInteger(tope) && tope > 0 ? tope : TOPE;
  const dentro = (n) => Number.isInteger(n) && n <= limite;
  // la lista de archivos cuenta como el cupo pedido: más código que el tope es pasar el tope, aunque no diga maxFiles.
  // Si no se puede contar (falta el módulo de la lista), cuenta como sobre cupo
  const codigoDe = (rutas) => {
    try {
      const L = require(require('path').join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'adhoc-list.js'));
      return rutas.filter((f) => typeof f === 'string' && L.esCodigoRel(f)).length;
    } catch (_) { return Infinity; }
  };
  if (String(a[0] || '').startsWith('--')) {
    if (a.some((w) => w.startsWith('--max-files=') || w.startsWith('--file='))) return SOBRE_CUPO;
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

/**
 * Los ids que nombra un valor de la lista: un grupo, sus firmas; un id, él mismo; `off` o desconocido, ninguno. Con
 * `restringe` (la lista `owner_only`), `escape-phrases` son todos los escapes.
 */
function expand(v, { restringe = false } = {}) {
  if (restringe && v === 'escape-phrases') return [...ESCAPES];
  if (Object.prototype.hasOwnProperty.call(GROUPS, v)) return [...GROUPS[v]];
  return isId(v) ? [v] : [];
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

// Lo que no tiene vuelta atrás: sólo se firma en la terminal de la persona, nunca con un click ni con un «aprobado»
const ONLY_IN_TERMINAL = Object.freeze(['escape:TYCON_SAFETY_OFF', 'escape:TYCON_PROD_LINT', 'emergency']);

module.exports = { TOPE, SOBRE_CUPO, firmaDelPedidoAdhoc, SIGNATURES, LEVELS, GROUPS, FIRMAS_DE_ARCHIVO, SENSITIVE, REQUIERE_SENSIBLE, NOT_DELEGATED, ONLY_IN_TERMINAL, ids, groupNames, isId, expand, effectiveLevel, delegatedLevel };
