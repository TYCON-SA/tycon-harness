# Las firmas del dueño

Algunos pasos del arnés no los puede aprobar el agente que trabaja. Esta guía (en inglés, [firmas-del-arnes.en.md](firmas-del-arnes.en.md)) lista todas esas firmas, con el nombre que
lleva cada una en el perfil del equipo. Sirve para decidir dos cosas del perfil:

- `approvals.delegated_signing`: las firmas **de trámite**. Las da **el arnés solo**, en cualquier sesión y en cualquier
  máquina, con o sin coordinadora (ver «Las firmas de trámite las da el arnés»).
- `approvals.owner_only`: qué firmas son sólo del dueño. Una firma no puede estar en las dos listas: si lo está, la
  lista de trámite se lee rota y ninguna sale sola.

## Las firmas de trámite las da el arnés

Una firma que el perfil pone en `approvals.delegated_signing` no le llega a nadie: no abre ventana ni cuadro y no espera a
la coordinadora. El arnés la da solo, en la sesión que la pide (también para sí misma), en sesiones del arnés y de
productos, y en cualquier máquina, sin lista de máquinas.

- **Pasa por el mismo control de contenido que antes.** Cada guion comprueba lo suyo antes de firmar sin persona: el plan,
  con la revisión automática aprobada sobre ese mismo plan, y nunca el de una historia delicada (ese plan y su maqueta,
  sólo con el click o el «aprobado» del dueño, aunque el perfil nombre `plan-approval:delicada`); la comparación con main, que la historia no sea delicada; el
  guardado, con la historia limpia; el camino corto, dentro del cupo y sin rutas de riesgo alto; el pendiente, sobre un
  repo donde trabaja la sesión. Si ese control dice que no, la firma va a una persona, como siempre, y la ventana dice por
  qué no salió sola.
- **La constancia la escribe el arnés, no el agente.** Queda en el registro común de firmas con vía `automatic`,
  firmante «arnés (firma de trámite)», quién la pidió, para qué sesión y qué se firmó. En la consola de la sesión queda un
  aviso de una línea. La carpeta del estado y el registro siguen protegidos: el agente no los escribe.
- **Las listas se cambian sólo en el perfil del equipo**, con un pedido a ese repo. Una organización que quiere devolverle
  una firma a la persona la saca de `approvals.delegated_signing` o la pone en `approvals.owner_only`.
- **A una persona le quedan**: el cambio de controles (`control-change`), lo irreversible y producción (todo el nivel 3,
  con la emergencia), apagar un freno o saltear las pruebas o el pase (todo `approvals.owner_only`: `TYCON_NEW_NAMES`,
  `TYCON_TEST_GATE`, `DOD_BYPASS`, `adversarial-skip`, `no-deep-review` y los demás), y nombrar o retirar a la coordinadora.
  Ninguna de esas sale sola aunque un perfil la liste.
- **Eximir un hallazgo crítico (`critical-waiver`) tampoco sale sola**, aunque el perfil la liste: un crítico lo decide
  una persona, y la constancia del trámite no nombra a ninguna. Va por la delegación a la coordinadora, que nombra al
  dueño, o por el click del dueño. La terminal queda de emergencia.
- **Los escapes de trámite** (los `escape:…` de la lista, que pasan por el freno de seguridad) también salen solos, cada
  uno en su forma de siempre y sin otra firma en el mismo comando. Su constancia la escribe el freno de seguridad con vía
  `automatica`, y vale para lo que la pide después (cerrar como deuda, el rojo esperado de la matriz).

Lo que sigue sobre la delegación a la coordinadora vale para lo que el perfil no pone en la lista de trámite.

Las dos listas se escriben sólo en el perfil del equipo: ni el archivo de la máquina ni una variable las cambian. Las
tablas de esta guía salen de `scripts/lib/signatures.js` con `node scripts/tools/signatures-guide.js --write`, y una
prueba falla si no coinciden.

## Quién aprueba

Depende del repo, no de la máquina:

- En los repos del arnés, las firmas son del dueño, y la ventana dice «Firma del dueño».
- En cualquier otro repo, las aprueba el dev, y la ventana dice «Lo aprobás vos». Vale también en la máquina del dueño.

El repo se reconoce por su remoto (`scripts/lib/harness-repo.js`), no por el nombre de la carpeta. La firma se pide igual
en los dos casos: lo que cambia es quién la da.

## Los niveles

Cada firma tiene un nivel, según cuánto pesa lo que aprueba:

- **1 · rutina**: una decisión normal, que se deshace.
- **2 · excepción**: da por bueno algo sin verificarlo y deja deuda.
- **3 · irreversible**: no se deshace, o afloja un freno.

La coordinadora firma sola la rutina y, del nivel 2, sólo las excepciones de trámite («Qué excepciones se delegan», más abajo). Un perfil
que pone en `approvals.delegated_signing` otra firma de nivel 2 o más, por su id o por un grupo, no pasa la validación
(`scripts/ci/check-profile-levels.js`), y el lector del perfil la saca y lo avisa. Una firma de hoy que junta dos cosas
de distinto peso cuenta con la mayor. El ok de guardar delegado (`save`) no firma un cambio que toca algo de lo
sensible, así que por delegación vale 1; lo sensible se delega aparte, con `save:sensible`.

La columna «Quién la ve» dice si la firma le llega al dev de producto o sólo a quien mantiene el arnés. La columna «Se
pide hoy con» dice con qué firma de la tabla siguiente se pide hoy. Varias de hoy se juntan en una sola, y una se parte
en dos. En el perfil, los nombres de esta tabla se escriben sólo en `approvals.levels`, para subir el nivel de una firma.

<!-- generado: niveles -->
| Firma | Nivel | Quién la ve | Qué aprueba | Se pide hoy con |
| --- | --- | --- | --- | --- |
| `plan-approval` | 1 · rutina | dev y mantenimiento | aprobar el plan (nivel 2 si la historia es delicada: lo calcula risk-class, y entonces el plan y su maqueta los aprueba sólo el dueño, con su click o su «aprobado», aunque el perfil nombre plan-approval:delicada; el nivel 1 lo aprueba también el veredicto aprobado de la revisión automática, con o sin coordinadora, salvo con plan_review.routine_approval: person) | `plan-approval` |
| `extra-round` | 1 · rutina | dev y mantenimiento | una vuelta más de revisores | `extra-round` |
| `pending-approval` | 1 · rutina | dev y mantenimiento | abrir un pendiente nuevo en la lista | `pending-approval` |
| `save` | 1 · rutina | dev y mantenimiento | guardar: commit, push y pull requests, si ningún commit toca algo de lo sensible | `save` |
| `browser-test:prepare` | 1 · rutina | dev y mantenimiento | preparar la prueba con navegador | `browser-test` |
| `adhoc-lane` | 1 · rutina | dev y mantenimiento | abrir un arreglo rápido sin historia, dentro del cupo | `adhoc-lane` |
| `compare-waiver` | 1 · rutina | dev y mantenimiento | eximir de la comparación con main a un comando que la historia modifica (delegable sólo si el perfil la suma a approvals.delegated_signing) | `compare-waiver` |
| `refresh-after-main` | 1 · rutina | sólo mantenimiento | refirmar los controles tras traer main, sin cambio propio | `refresh-after-main` |
| `lost-run:particion` | 1 · rutina | dev y mantenimiento | cerrar una ejecución perdida que la partición de su historia en tandas dejó sin objeto (delegable sólo si el perfil la suma a approvals.delegated_signing) | `lost-run:particion` |
| `save:sensible` | 2 · excepción | dev y mantenimiento | guardar cuando un commit toca algo de lo sensible | `save` |
| `adhoc-lane:datos` | 2 · excepción | dev y mantenimiento | dejar pasar un arreglo rápido que cambia de dónde sale un dato o quién lo ve, sin historia (sólo el click del dueño) | `adhoc-lane:datos` |
| `adhoc-lane:guardado-ajeno` | 2 · excepción | dev y mantenimiento | dejar pasar una vez un guardado ajeno a un camino corto que espera sus revisores, con lo que guarda a la vista (el click o la terminal de una persona, o la coordinadora si el perfil se lo delega) | `adhoc-lane:guardado-ajeno` |
| `autonomy-resume` | 2 · excepción | dev y mantenimiento | volver al modo autónomo una ejecución que el control de cierre detuvo, con las vueltas en cero (sólo el click o la terminal del dueño) | `autonomy-resume` |
| `adhoc-lane:sobre-cupo` | 2 · excepción | dev y mantenimiento | abrir un arreglo rápido que pasa el tope de archivos del camino corto, aunque se recomienda una historia (cuentan sólo los archivos de implementación, sin pruebas ni guías) | `adhoc-lane:sobre-cupo` |
| `escape:DOD_BYPASS` | 2 · excepción | dev y mantenimiento | saltear todos los controles del commit | `escape:DOD_BYPASS` |
| `critical-waiver` | 2 · excepción | dev y mantenimiento | eximir un hallazgo crítico | `critical-waiver` |
| `runtime-waiver` | 2 · excepción | dev y mantenimiento | aceptar un criterio imposible de probar en vivo, o eximir la historia entera | `runtime-waiver`, `escape:dod_runtime_exempt` |
| `manual-test` | 2 · excepción | dev y mantenimiento | marcar un criterio como probado a mano | `manual-test`, `escape:ALLOW_DOD_EVIDENCE_WRITE` |
| `browser-test:no` | 2 · excepción | dev y mantenimiento | decir que no a la prueba con navegador | `browser-test` |
| `adversarial-skip` | 2 · excepción | dev y mantenimiento | saltear el pase adversarial | `adversarial-skip`, `escape:TYCON_NO_DEEP_REVIEW`, `escape:no-deep-review` |
| `atdd-skip` | 2 · excepción | dev y mantenimiento | saltear «pruebas primero» en una ejecución | `atdd-skip` |
| `review-skip` | 2 · excepción | dev y mantenimiento | contestar «skip» a la pregunta de si correr el pase adversarial sobre el código (sólo el dueño: su ventana, su click o su «aprobado») | `review-skip` |
| `lost-run` | 2 · excepción | dev y mantenimiento | dar por perdida una ejecución y cerrarla | `lost-run`, `escape:cerrar-la-ejecucion`, `escape:cerrar-como-deuda`, `escape:rojo-esperado-de-la-matriz` |
| `escape:force-manual` | 2 · excepción | dev y mantenimiento | marcar a mano el estado de un control | `escape:force-manual` |
| `escape:trust-ran` | 2 · excepción | dev y mantenimiento | contar revisores sin constancia de que corrieron | `escape:trust-ran` |
| `escape:TYCON_TEST_GATE` | 2 · excepción | dev y mantenimiento | saltear sólo el portón de pruebas del commit | `escape:TYCON_TEST_GATE` |
| `escape:TYCON_STATUS_GATE` | 2 · excepción | dev y mantenimiento | cambiar a mano el estado de una historia | `escape:TYCON_STATUS_GATE`, `escape:cambiar-el-estado` |
| `escape:TYCON_MUTATION_CHECK` | 2 · excepción | dev y mantenimiento | saltear el chequeo de mutantes de las pruebas | `escape:TYCON_MUTATION_CHECK`, `escape:no-mutation` |
| `escape:TYCON_STORY_REVIEW` | 2 · excepción | dev y mantenimiento | saltear la revisión de la historia antes del plan | `escape:TYCON_STORY_REVIEW` |
| `escape:story-skill-bypass` | 2 · excepción | dev y mantenimiento | escribir una historia sin la skill de historias | `escape:story-skill-bypass` |
| `escape:red-control-test-edit` | 2 · excepción | dev y mantenimiento | editar una prueba vieja de un control que estaba en rojo | `escape:red-control-test-edit` |
| `escape:set-autonomous` | 2 · excepción | dev y mantenimiento | cambiar el modo autónomo de una ejecución | `escape:set-autonomous` |
| `designation-confirm` | 2 · excepción | dev y mantenimiento | confirmar qué sesión es la coordinadora de esta máquina | `designation-confirm` |
| `designation-set` | 2 · excepción | dev y mantenimiento | nombrar a una sesión coordinadora de esta máquina, con un click en su pestaña | `designation-set` |
| `designation-withdraw` | 2 · excepción | dev y mantenimiento | retirar a la coordinadora de esta máquina, con un click en su pestaña | `designation-withdraw` |
| `control-change` | 3 · irreversible | sólo mantenimiento | cualquier cambio de control | `control-change` |
| `escape:TYCON_SAFETY_OFF` | 3 · irreversible | dev y mantenimiento | apagar el freno de seguridad para un comando (retirada: ya no apaga nada) | ya nada la pide |
| `escape:TYCON_PROD_LINT` | 3 · irreversible | dev y mantenimiento | apagar el control de consultas a producción (retirada: ya no apaga nada) | ya nada la pide |
| `escape:TYCON_NEW_NAMES` | 3 · irreversible | sólo mantenimiento | apagar el control de nombres en lo que se publica | `escape:TYCON_NEW_NAMES` |
| `emergency` | 3 · irreversible | dev y mantenimiento | la salida de emergencia: dejar pasar un comando que un freno para, con motivo y para ese comando solo | todavía no se pide |
| `escape:merge-bypass` | 3 · irreversible | dev y mantenimiento | mergear salteando la cola y la CI de main, o aflojar las políticas de la rama: un comando, nunca por delegación | `escape:merge-bypass` |
| `escape:external-pr` | 3 · irreversible | dev y mantenimiento | encolar o mergear un pull request de alguien de afuera del equipo: un comando, nunca por delegación | `escape:external-pr` |
<!-- fin: niveles -->

`emergency` todavía no tiene una firma de hoy que la pida: se da con `harness.js sign emergency --reason "<por qué>"
--request <número>` (el número lo da el cartel del freno) o `--commit`, en la terminal de la persona
(guides/safety-guard.md, «Saltear el freno»). `escape:TYCON_SAFETY_OFF` y `escape:TYCON_PROD_LINT` están marcadas
retiradas: ya no apagan nada (el freno anota la variable y la deja sin efecto), ya nada las pide, y la salida de los dos
frenos es la emergencia. Siguen en la tabla para que un perfil del equipo que las nombra en `approvals.owner_only` se
siga leyendo entero; sacarlas del catálogo pide migrar ese perfil.

### Qué excepciones se delegan

Ninguna se delega sola: cada una va con su nombre en `approvals.delegated_signing` del perfil del equipo (un grupo de
antes, como `escape-phrases`, no las trae), y vale con las mismas llaves que la rutina: la máquina en
`approvals.delegated_machines`, la coordinadora confirmada por el dueño, y pedida por ella para otra sesión, nunca para
sí. Queda en el registro con vía «delegación», como las de nivel 1. Lo que el perfil sube a 3 con `approvals.levels`
vuelve al dueño.

El plan de una historia delicada no está en esta tabla: su plan y su maqueta los aprueba sólo el dueño, con su click o su
«aprobado», aunque el perfil nombre `plan-approval:delicada`. Un perfil que la nombra sigue siendo válido; la forma no
delega nada.

| Se delega, si el perfil la nombra | Cómo la firma la coordinadora |
|---|---|
| `save:sensible`: guardar cuando un commit toca algo de lo sensible | con `save` (`approve-save --for-session`), con la historia limpia y el aviso entregado al dueño |
| `manual-test`, `critical-waiver`, `lost-run`, `escape:force-manual`, `escape:trust-ran` (y `extra-round`, que ya era rutina) | con el comando de la firma y `--for-session <sesión>`; si la sesión la pide para sí, el freno la desvía a la coordinadora |
| `escape:ALLOW_DOD_EVIDENCE_WRITE`, `escape:cambiar-el-estado`, `escape:red-control-test-edit` | `marker.js sign-file <firma> <archivo> --for-session <sesión>`: deja la constancia que usa el Edit o Write de esa sesión |
| `adhoc-lane:guardado-ajeno` | `marker.js adhoc allow-foreign-save --for-session <sesión>` |
| `escape:TYCON_STATUS_GATE`, `escape:set-autonomous`, `escape:cerrar-la-ejecucion`, `escape:cerrar-como-deuda`, `escape:rojo-esperado-de-la-matriz` | el perfil las acepta, pero su comando corre sólo en la sesión que trabaja y la coordinadora no tiene cómo firmarlas desde su pestaña: hasta que tengan esa vía, las sigue aprobando una persona. Una ejecución perdida la cierra la coordinadora con `lost-run` |

Quedan sólo del dueño, aunque un perfil las liste: `control-change` y todo el nivel 3 (`escape:TYCON_NEW_NAMES`,
`emergency`, `escape:merge-bypass`, `escape:external-pr`, y las retiradas `escape:TYCON_SAFETY_OFF` y
`escape:TYCON_PROD_LINT`, que ya no apagan nada); `designation-set`,
`designation-confirm` y `designation-withdraw`; `adhoc-lane:datos` y `adhoc-lane:sobre-cupo`; `escape:DOD_BYPASS`; `adversarial-skip` (con
`escape:TYCON_NO_DEEP_REVIEW` y `escape:no-deep-review`); `atdd-skip`; `escape:TYCON_TEST_GATE`; `escape:story-skill-bypass`;
`escape:dod_runtime_exempt` y `runtime-waiver` (aceptar un criterio imposible de probar en vivo: tampoco sale como
trámite); y decir que no a la prueba con navegador (`browser-test`).

## Quién firma cada nivel

El nivel que rige es el mayor entre la tabla de arriba y lo que suba el perfil (`approvals.levels`). Quién lo firma
depende de dos cosas: si tu máquina tiene coordinadora, y si estás para contestar. Buscá en la fila lo que hay que
firmar, y en la columna tu situación:

| Nivel | Lo que hay que firmar | Sin coordinadora, estás | Sin coordinadora, no estás | Con coordinadora, estás | Con coordinadora, no estás | La revisión automática |
|---|---|---|---|---|---|---|
| 1 · rutina | **Abrir el pull request** (`save`): los pull requests y el push a una rama compartida; el commit y el push a tu rama de trabajo no se firman. Es rutina porque se deshace; si un commit toca algo sensible, pasa a `save:sensible`, de nivel 2. | vos | espera | la coordinadora \* | la coordinadora \* | no aplica |
| 1 · rutina | **Pedir otra revisión** (`extra-round`). Es rutina porque sólo suma control: firmarla de más no daña nada. | vos | espera | la coordinadora \* | la coordinadora \* | no aplica |
| 1 · rutina | **Aprobar el plan** (`plan-approval`) de una historia que no es delicada. Es rutina porque decide qué se construye antes de construirlo, y se cambia. | la revisión que lanza la propia sesión, si da aprobado \*\*; si no, vos | la revisión que lanza la propia sesión, si da aprobado \*\*; si no, espera | vos, o la coordinadora, sólo con el veredicto aprobado de la revisión que ella lanza \*\* | la coordinadora, sólo con el veredicto aprobado de la revisión que ella lanza \*\* | su «aprobado» es lo único con que se aprueba sin vos: con coordinadora la lanza ella; sin ella, la propia sesión. Con `plan_review.routine_approval: person`, aprobás vos siempre |
| 1 · rutina | **Eximir un comando de la comparación con main** (`compare-waiver`): un comando que la historia modifica y que no se puede comparar con su versión de `main` (por ejemplo, porque usa la red). La firma es delegable sólo cuando el perfil del equipo la suma a `approvals.delegated_signing`, con un pedido al perfil que firma el dueño: amplía lo que firma la coordinadora. Hasta entonces, es tuya. | vos | espera | vos; la coordinadora \* sólo si el perfil la delega | espera; la coordinadora \* sólo si el perfil la delega | no aplica |
| 2 · excepción | **Aprobar el plan de una historia delicada** (`plan-approval` cuando `risk-class` dice `delicate`), con su maqueta | vos, con tu click o tu «aprobado» | espera | vos, con tu click o tu «aprobado» (también en la pestaña de la coordinadora); sin eso, nadie, aunque el perfil nombre `plan-approval:delicada` | espera | ataca el plan y avisa; su «aprobado» nunca aprueba un plan delicado |
| 2 · excepción | **Saltear un control** o aceptar un problema grave sin arreglarlo (`critical-waiver`, `escape:…` y las demás de nivel 2) | vos | espera | vos; las de trámite, la coordinadora \* si el perfil las delega (ver «Qué excepciones se delegan») | espera; las de trámite, la coordinadora \* si el perfil las delega | no aplica |
| 2 · excepción | **Aceptar un criterio imposible de probar en vivo** (`runtime-waiver`). Antes de la ventana, el arnés te muestra el criterio en pantalla: su texto, por qué no se puede probar en vivo y qué prueba lo cubre. | vos | espera | vos; la coordinadora \* sólo si el perfil la delega | espera; la coordinadora \* sólo si el perfil la delega | no aplica |
| 2 · excepción | **Marcar un criterio como probado a mano** (`manual-test`) | vos | espera | vos; la coordinadora \* sólo si el perfil la delega | espera; la coordinadora \* sólo si el perfil la delega | no aplica |
| 3 · irreversible | **La emergencia** (`emergency`): pasar por encima del freno de seguridad | vos, en tu terminal | espera | vos, en tu terminal | espera | no aplica |

- **Vos**: aprobás sin terminal. En una pestaña que pide permisos te aparece la ventana de permiso; en una que no pide, o
  en una sesión de fondo, aprobás con un click en el cuadro de opciones o con un «aprobado» escrito (ver «Aprobar sin
  terminal»). En Windows, siempre con el click o el «aprobado», o en tu terminal (ver «En Windows»). **La coordinadora**:
  la firma ella, sin molestarte; en Windows no hay delegación. **Espera**: nadie firma; el trabajo queda frenado en ese
  paso hasta que alguien firme, y no se rompe nada.
- \* **La coordinadora** firma sin ventana sólo lo que el perfil pone en `approvals.delegated_signing`, en las máquinas de
  `approvals.delegated_machines`, y sólo con la designación confirmada por el dueño (`designation-confirm`: con un click en
  la pestaña de la sesión designada, o en su terminal; ver «Aprobar en nombre del dueño»). Si la firma no está delegada, tu máquina no está en la lista o nadie confirmó la designación, la
  fila es igual que sin coordinadora. Lo que queda en 2 o más sale de esa lista, salvo las excepciones de trámite («Qué
  excepciones se delegan»); lo que queda en 3, siempre. Una designación de otra sesión anotada después y
  sin confirmar no desplaza a la confirmada: firma la confirmada hasta que el dueño confirme la otra.
- \*\* **El plan de rutina, con y sin coordinadora**: cuándo corre la revisión automática lo dice la matriz de la
  organización (`plan_review`, `guides/automatic-reviews.md`): en una delicada corre siempre; en una de rutina se
  le pregunta al dueño y, si el dueño está ausente, se revisa sin preguntar, se espera o se sigue sin revisión. Las tres
  salidas de una revisión: **aprobado** (también «aprobado con notas»: sólo un defecto rechaza), **rechazado** y
  **sin veredicto**. Con coordinadora, ella lanza la revisión (`marker.js plan-review --for-session <sesión>`) y aprueba en
  nombre del dueño sólo con «aprobado» sobre ese mismo plan, con `plan-approval` delegado. Sin coordinadora, la lanza la
  propia sesión (`marker.js plan-review`, sin `--for-session`), y con «aprobado» sobre ese mismo plan `complete-step
  approve-plan` cierra sin click: el mismo aprobado alcanza con y sin coordinadora. Con
  `plan_review.routine_approval: person` (o su nombre viejo, `plan_review.coordinator_approves: false`) un plan de rutina
  lo aprueba siempre una persona. Rechazado o sin veredicto, el plan espera a una persona. Una revisión informativa (la
  de la propia sesión en una historia delicada o con `person`) sólo informa y nunca firma
  (`steps/step-04-approve-plan.md`).
- **Con tu aprobación escrita, la firma es tuya, también en lo delicado.** Donde la ventana no llega, o cuando la coordinadora
  firmaría por delegación, vale tu click en el cuadro de opciones o tu «aprobado» tipeado. Gana a la delegación: un plan
  delicado o un guardado que toca algo sensible pasan, y quedan a tu nombre. El camino por defecto es el cuadro: la
  pregunta la arma el freno (qué se aprueba, qué pasa si sale mal y el sello «firma <id> · sesión <id> · código <huella
  del comando>»), se la da al agente al negar el comando, y el agente la muestra sin cambiarle una letra. Se compara
  entera: otra pregunta no firma nada. El «aprobado» queda para cuando el cuadro no se puede mostrar: lo último que te
  dijo el agente tiene que traer ese sello y no nombrar otra sesión. Cada aprobación sirve una vez, para ese comando, y
  vence a los 30 minutos. Sin ella, la coordinadora sigue frenada en lo delicado. Si un click no contó y la delegación
  firmó igual, el comando lo dice.
- **Todo se aprueba sin terminal salvo dos cosas**: la salida de emergencia y el `sudo` del freno de producción. Esas
  siguen en tu terminal porque no tienen vuelta atrás. Apagar el freno de seguridad o el control de producción ya no se
  firma: sus dos variables están retiradas y ya no apagan nada, y la salida de los dos es la emergencia. Lo demás, la
  terminal es opcional: la columna «Firmarla en la terminal» dice cómo, si la preferís.
- **Una aprobación dada en la pestaña de la coordinadora** vale para otra sesión sólo si la coordinadora está confirmada y
  el proceso de su herramienta que la anotó sigue vivo.
- **El registro de las aprobaciones** (`owner-approvals/` en la carpeta de estado, con lo gastado en `usadas/`) no se
  escribe, mueve ni borra por Edit, Write ni la consola. El click no vale si un gancho ajeno escucha el cuadro: se buscan
  en las capas de configuración (también `managed-settings.d/` y `--settings`), en los plugins (`hooks.json`, los ganchos
  de su `plugin.json`, `--plugin-dir`) y en el encabezado de skills y agentes. Lo que no ve: las banderas de una sesión de
  fondo, porque su proceso no las muestra.
- Con coordinadora, ella puede pedir algunas de nivel 2 (eximir un crítico, un criterio que no se prueba en vivo): las
  contesta una persona, salvo las excepciones de trámite que el perfil le delega («Qué excepciones se delegan»).
- **Si tu push ya despliega algo** (en tu equipo, subir a una rama dispara un despliegue), quien administra puede subir
  «Abrir el pull request» a nivel 2 desde el sitio: entonces lo firma siempre una persona.
- **Espera** quiere decir que nadie firma. El sistema no mira la hora: pide la firma igual y, si nadie contesta, la
  sesión queda frenada en ese paso.
- **La emergencia** (`emergency`) es la única salida para pasar por encima del freno de seguridad: la persona la firma en
  su terminal con `harness.js sign emergency`, con su motivo (cómo, en el párrafo de arriba). La terminal muestra qué se
  firma y pregunta «¿Firmás? (s/n)»: firma con `s`, `si` o `sí`, y cualquier otra respuesta es «no». En Windows se abre una
  ventana nueva y ahí se escriben tres palabras al azar. El agente no la puede correr.
- En los repos del arnés, el dueño ocupa el lugar del dev (ver «Quién aprueba»).
- «En la ventana» vale para Claude Code. Codex no tiene ventana de permiso, y el click y el «aprobado» no valen ahí: en
  Codex todo se firma en la terminal (`guides/safety-guard.md`, y abajo, «En Codex»).

## Aprobar sin terminal

Con `approvals.signature_list` en `on`, lo que el freno niega con su cuadro a la propia sesión queda anotado, y al volver la
persona se lo pasan de a uno con ese mismo cuadro. La lista no firma nada: un click vale por lo que pregunta el freno cuando la
sesión que lo pidió repite el comando. Lo delegado, lo irreversible y lo que corre otra sesión no dejan renglón. El detalle:
`guides/coordination.md`, «La lista de firmas».

**Un permiso no es una firma.** Con una coordinadora confirmada, el permiso que pide una sesión de fondo en modo normal
también llega como cuadro a su pestaña, con el pedido entero (`scripts/hooks/permission-relay.js`). Lo aprueba sólo tu
click en ese cuadro, para ese pedido y una vez: la coordinadora nunca, ni por delegación (`approvals.delegated_signing` no
lo cubre), ni con un «aprobado» escrito. Sin tu respuesta vuelve la ventana de siempre. El detalle:
`guides/coordination.md`, «El permiso de una sesión de fondo, como cuadro».

Con Claude Code, la mayoría de las firmas no piden la terminal. El camino depende de la pestaña:

- **La pestaña pide permisos:** te aparece la ventana de permiso y contestás «Sí». Ahí escribir «aprobado» no firma nada,
  salvo que la coordinadora la firmaría por delegación: entonces gana tu aprobación.
- **La pestaña no pide permisos, o la sesión corre de fondo:** la ventana no le llega a nadie seguro. Vale tu click en el
  cuadro de opciones o tu mensaje «aprobado». Sin eso, el freno niega el comando y le dice al agente cómo pedírtelo; lo
  de rutina en una pestaña sin permisos se hace y se avisa (ver «Lo de rutina en una pestaña sin permisos»).
- **En Windows:** siempre el click o el «aprobado», y la ventana de permiso no firma (ver «En Windows»).

**El plan se aprueba con el cuadro.** Si el plan trae «Qué hace» y «Archivos», el cuadro de su firma muestra qué hace,
cuántos archivos toca y de qué zonas, y dónde está el plan completo, y tu click cuenta como plan visto: no hace falta que el agente lo pegue antes en la conversación.
El plan entero te lo muestran si lo pedís. Vale sólo el click para contar como plan visto: un «aprobado» escrito, la
ventana de permiso o la terminal no muestran esas secciones. Un plan sin esas dos secciones sí tiene que estar entero en
la conversación.

**A distancia, igual.** Si la sesión tiene el control remoto encendido, el cuadro lo podés contestar desde claude.ai o
desde el teléfono, en la sesión que firma o en la coordinadora: tu click firma el plan, también el de una historia
delicada. Es el mismo cuadro con la misma prueba: la pregunta la arma el freno, el agente no puede contestarla, el click
sirve una vez para ese plan y vence a los 30 minutos. Lo probado es el click desde el teléfono; desde claude.ai en un
navegador no se midió. Tu «aprobado» escrito sobre esa pregunta también sigue valiendo.
Lo que hoy sólo se firma en la terminal (la emergencia) sigue ahí, con o sin control remoto. Las demás firmas de nivel 3
(`control-change`, `escape:TYCON_NEW_NAMES`, `escape:merge-bypass` y `escape:external-pr`) se aprueban como en la
máquina, así que también a distancia.

El riesgo que se acepta: quien tenga tu cuenta de claude.ai o tu teléfono con la sesión abierta puede contestar el
cuadro o escribir «aprobado», y el arnés no distingue si fuiste vos. Por eso:

- **Cada renglón del registro de firmas (`signatures.jsonl`) trae `remote_control`.** `true` si el proceso donde
  contestaste tenía el control remoto encendido en ese momento, `false` si no, y `null` si no contestó una persona
  (delegación, revisión, hecho y avisado, un comando) o no se pudo saber. Un renglón escrito antes de que existiera el
  campo se lee como `null`. Quiere decir «tenía el control remoto encendido», no «la respuesta llegó del teléfono»: la
  respuesta no dice desde qué aparato se dio, y con el control remoto encendido también podés contestar en la máquina.
- **Cada firma tuya con el control remoto encendido, o de la que no se pudo saber, te llega como aviso** por los canales
  de la sesión: qué se firmó, para qué sesión, por qué vía y a qué hora. Si no la diste vos, te enterás en el momento.
  También avisan las firmas que aprueba el freno con tu click o tu «aprobado», aunque no dejen renglón en el registro. Lo
  que aprobás en la ventana de permiso de una de ésas no pasa por el arnés y no avisa. Si el aviso no sale, la firma
  queda dada: se dice en pantalla o, si la aprobó el freno, en `hook-errors.log`.

Lo que tiene que cumplir esa aprobación:

- **Sirve para una sola firma y vence a los 30 minutos.** Un comando que pide dos firmas no la usa.
- **La pregunta la arma el freno.** Se la da al agente al negar el comando, con el sello «firma <id> · sesión <id> · código
  <huella>», y el agente la muestra sin cambiarle una letra. Tu click vale sólo con esa pregunta entera. Tu
  «aprobado» vale si lo último que te dijo el agente trae ese sello y no nombra otra sesión.
- **La pregunta dice qué aprobás, y se lee en un teléfono.** En este orden: lo que se aprueba («¿Eximir un hallazgo
  crítico de los revisores?»), la historia (con su título si tiene hasta 80 letras) y la sesión por sus 8 primeras
  letras, qué hace en 2 renglones de hasta 140 letras, cuántos archivos toca y de qué zonas («11 archivos: 6 de código
  (lib y tools), 4 pruebas, 1 historia»: las rutas no se muestran en ningún lado), dónde está lo completo dicho en
  palabras («el plan, en la carpeta de la ejecución», «el informe de hallazgos de la ejecución», «la historia 8.275»), qué
  pasa si sale mal con esa firma y, al final, la cita de la sesión. Ninguna ruta absoluta y ninguna frase cortada con
  «…»: lo que se corta dice «(sigue en el detalle)». La pregunta entera, con su sello, entra en 600 letras; para entrar
  se achica en orden (el título, la cita, «Qué hace» a un renglón, la revisión sin sus notas, los criterios en tramos)
  y nunca saca lo que se aprueba, la sesión, los criterios, los archivos, «si sale mal» ni el sello. Lo que no entra va
  al **detalle**, que owner-next imprime debajo de la pregunta y nunca va dentro del cuadro: mostralo si lo pedís. Un
  cuadro que igual no entra (el guardado ajeno, que se muestra entero) llega con el aviso «Este cuadro pasa el tope del
  teléfono»: leelo en la máquina.
- **El cambio de controles se aprueba con un click**, como las demás firmas de la máquina, o en tu terminal. La CI sigue
  siendo la segunda llave: un pedido que cambia un control pide la constancia de `control-change`, y sin ella sale en
  rojo. Antes del cuadro, la sesión te muestra la salida de `run-base-controls.sh pending` y el diff de esas rutas; nada
  lo frena, es lo que se espera de ella. El cuadro dice qué cambia, por qué y el riesgo, con lo que escribió la sesión en
  sus commits; cuántos archivos toca y de qué zonas va en el detalle.
- **El cambio de controles se explica primero.** El cuadro de `control-change` dice, después de lo que se aprueba, qué
  cambia en el comportamiento del control (qué deja de frenar, qué empieza a frenar), por qué y el riesgo concreto de ese
  cambio. Lo escribe la sesión que hizo el cambio, en sus commits, con tres renglones: `Cambia-control: …`,
  `Por-que: …` y `Riesgo: …`. El freno los lee de los mismos commits que firma, y su texto entra en el código del sello:
  si la explicación cambia, tu click ya no vale. Si el cambio no explica nada, el cuadro lo dice («el cambio no explica
  qué hace, por qué ni su riesgo») en vez de rellenar; si falta uno de los tres, dice «el cambio no lo dice». La sesión,
  cuántos archivos y líneas toca, dónde está el diff y el «si sale mal» de siempre van al detalle. Las demás firmas
  mantienen el cuadro de arriba.
- **Un click dado sobre el formato viejo no vale después de actualizar.** Si la pregunta cambió con el mismo código (el
  formato nuevo del arnés, o un texto alterado), la firma no se da, el renglón queda en la lista y la aprobación no se
  gasta: el motivo lo dice y hace falta un click nuevo.
  Lo que hace sale de lo que firmarías si lo abrieras, no de lo que escribió la sesión. La huella del sello incluye eso
  que se mostró: si el plan o el diff cambian después del cuadro, tu click ya no vale y el agente pide el cuadro de nuevo.
- **El código del sello sale del pedido en forma canónica, no del comando tal como se escribió.** El mismo pedido escrito
  de otra forma da el mismo cuadro y tu click le sirve: las opciones en otro orden, los criterios de `--acs` en otro orden
  o repetidos, la historia por ruta relativa o absoluta (si las dos llevan al mismo archivo desde donde lo lee el guion).
  Lo que cambia lo que firmás da otro código: otro valor, otra opción, otro criterio, la forma `--opcion=valor` (el guion
  no la lee igual que `--opcion valor`), o lo que se mostró (el texto de un criterio, el plan, el diff). Un comando que
  no tiene forma canónica (una palabra suelta entre las opciones, por ejemplo) se compara tal como se escribió. Los
  códigos de antes no se migran: al actualizar el arnés, un cuadro que ya habías aprobado se pregunta una vez más.
- **La das en la sesión que firma, o en la coordinadora con la designación confirmada.** Dada en la coordinadora, su proceso
  tiene que seguir vivo. La aprobación es tuya, no una delegación.
- **El mensaje es un «aprobado» claro.** «Aprobado», «apruebo» o «sí, aprobado», sin preguntas, negaciones ni condiciones.
  «No apruebo» o «¿lo aprobaste?» no cuentan.
- **El mensaje lo tipeás vos, en la consola o en la extensión del editor.** No cuenta uno que llega por un programa, por otra
  sesión, por un encargo o por Telegram. En esos casos, usá el click.
- **Ningún gancho ajeno escucha el cuadro.** Si un gancho que no es del arnés lo escucha, el click no vale, y el freno te
  pide escribir «aprobado».

Lo que no acepta el click ni el «aprobado», y se firma en tu terminal:

- la salida de emergencia (`emergency`);
- apagar el freno de seguridad para un comando (`escape:TYCON_SAFETY_OFF`): retirada, ya no apaga nada aunque se firme;
- apagar el control de consultas a producción (`escape:TYCON_PROD_LINT`): retirada, ya no apaga nada aunque se firme.

La contraseña que pide reinstalar el freno de producción no es una aprobación: la escribís vos, con `sudo`.

La terminal también es la salida cuando el freno no puede decidir:

- en Codex;
- en Windows, por la consola PowerShell o con una forma de consola que no es la medida;
- con el comando escondido detrás de otro (`cd … && <firma>`);
- con la herramienta lanzada por otra herramienta o por su consola;
- en una sesión sin pantalla (`-p`);
- con una consola de fondo viva: se cierra, o se firma en la terminal. No frenan, salvo en Windows: el `owner-wait` de
  la coordinadora, con la ruta completa de este mismo arnés y nada más en la línea, y el vigilante de sólo lectura de
  «Aprobar en nombre del dueño».

### En Codex

En Codex todo se firma en la terminal, y es una decisión, no algo que falta. Su cuadro (`request_user_input`) no sirve de
firma con la forma normal de abrir Codex: la terminal usa un servidor compartido, y otro programa conectado a ese servidor
contesta el cuadro con un resultado idéntico al de un click. El comando `codex queue`, además, mete un mensaje que para el
gancho se ve igual que uno tipeado. Medido en Codex 0.162.1.

Tampoco vale una respuesta escrita leída de la conversación de Codex. Medición del 2026-11-11, Codex 0.162.1:
**distingue: no**. Un mensaje tipeado por la persona en la terminal de Codex, uno metido con `codex queue`, uno mandado
por otro programa conectado a un servidor de Codex y uno tipeado por un programa en una pseudo-terminal dejan en la
conversación guardada los mismos renglones; cambian sólo los ids, las horas, el orden y el texto. Lo que manda otro
programa por el servidor queda marcado como escrito por el usuario. El gancho de prompt sí ve una diferencia: la
cadena de procesos que sube hasta la aplicación de terminal, y sus variables de terminal. Pero un programa la reproduce
idéntica abriendo Codex en una ventana de terminal con el mensaje ya escrito. Y la respuesta del cuadro dice qué se
contestó, no quién. Por eso, en Codex, la constancia de la persona es la firma en la terminal. Los renglones medidos,
sin datos reales, y el veredicto están en `scripts/tests/fixtures/codex-typed/`.

**Lo que vale en Codex.** Una constancia de la persona que pide una sesión de Codex (por ejemplo, la respuesta a una
pregunta que bloquea una historia) se da en su propia terminal, fuera de Codex, con el comando entero que muestra la
sesión: `harness.js sign acknowledge --session <sesión> --seal "<sello>" --text "<texto>"`. La terminal muestra la
sesión, el sello y el texto, y pregunta «¿Firmás? (s/n)»; en Windows, la ventana de las tres palabras al azar. Con «s»
anota un renglón en el registro de aprobaciones (`plataforma: codex`, `via: terminal`, no en el registro común de
firmas) y deja una marca aparte en `terminal-acknowledgments/` de la carpeta de estado; las dos tienen que coincidir, el
texto tiene que ser la pregunta que muestra la sesión, y
los frenos de escritura cuidan las dos carpetas. Vale 30 minutos, una sola vez y sólo para la sesión que nombra: no pasa
por la coordinadora. No firma si la lanzó la herramienta del agente o Codex (en Windows eso no se mira: cuida la
ventana). La aceptan sólo los controles que la piden con `plataformas` que incluye Codex, como la aprobación de la
intención de una historia; las firmas de hoy siguen como están. En Codex el click y la respuesta escrita no valen.

### En Windows

En Windows firmás con un click en el cuadro de opciones o con un «aprobado» escrito, si el agente corre la firma por su
consola Bash. El freno niega el comando la primera vez y le da al agente el cuadro para mostrarte; con tu click, el agente
repite el mismo comando. La otra salida es `--terminal`, que abre una ventana nueva donde escribís tres palabras al azar.
Para un arreglo rápido, ese comando es `marker.js adhoc set --reason "<motivo>" [--max-files N] --data sin-cambio
--file <ruta> [--file <ruta> …] --terminal --for-session <id>`, sin JSON.

Un arreglo rápido con archivos de varios repos (`<Nombre>/<ruta>` de un hermano declarado en `repo_group` en los dos
sentidos, en la rama principal del remoto) es `adhoc-lane` como uno de un solo repo: se firma por las mismas vías y se
delega igual. Los hermanos salen del grupo declarado, sin preguntarte; un repo que no está en el grupo no entra en la
lista por ninguna vía. Si otra sesión está viva en el checkout de un hermano, no se abre. Las pruebas van por repo
(`adhoc test --repo <Nombre>`).

Esto no firma en Windows:

- **La ventana de permiso.** Su pedido queda escrito antes de que contestes, y en Windows un programa puede declarar
  cualquier padre al crear un proceso (técnica conocida, no medida acá): mientras la ventana está abierta, un programa del
  agente podría imitar la consola y firmar sin tu «Sí». Con el click, el pedido se escribe después de que aprobaste ese
  comando exacto, y imitar la consola no le da nada nuevo.
- **La consola PowerShell.** Su línea no dice qué comando corre, así que no se puede comparar con lo que aprobaste. El
  freno lo niega antes de usar tu aprobación, y dice que se corra por Bash o con `--terminal`.
- **La delegación y «hecho y avisado».** Nada se firma sin una acción tuya.
- **Un escape que ningún guion comprueba y un guion de consola** (`run-base-controls.sh`). Van en tu terminal. El escape
  de una variable, o el de `marker.js` que mira sólo el freno (cerrar la ejecución, apagar el modo autónomo), no deja
  un pedido que un guion pueda comprobar. El guion de consola se identifica con un número de proceso de Git Bash, que no
  es el de Windows. Un escape que comprueba su guion (`set-check --force-manual`, `check-count --trust-ran`,
  `sign-file`) sí se firma con tu click o tu «aprobado»: corrido solo y en su forma exacta, es una firma de guion.

Una consola de fondo viva frena, y también una PowerShell viva, porque no se puede leer qué corre. Se cierra, o se firma en
la terminal.

**El freno ofrece sólo lo que anda en tu consola.** En Windows la firma por cuadro o por «aprobado» anda sólo desde la
consola Bash de Git. Si el agente pidió la firma desde la consola PowerShell, el freno no le ofrece la ventana, el cuadro
ni el «aprobado»: le dice que la corra por la consola Bash de Git (si está) o te da la forma de la terminal. Un escape que
ningún guion comprueba o un guion `.sh` van sólo por la terminal, también desde Bash de Git. La lista de firmas guarda con qué consola se pidió cada
una, y `owner-next` le da a la coordinadora la terminal en lugar del cuadro cuando el cuadro no firmaría; lo mismo con una
firma que no se da desde la pestaña de otra sesión.

**Un solo comando para las tres consolas.** La forma de la terminal es `node "<carpeta personal>/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js" …`,
con comillas dobles, sin `~`, sin `cd` ni `&&`, y con `--terminal --for-session <sesión>` al final: se pega igual en
Windows PowerShell 5.1, PowerShell 7 y cmd (y en bash). El arreglo rápido lleva además `--repo "<carpeta>"`, así tu terminal
puede estar en cualquier carpeta. Una ruta o una carpeta personal con `$`, `"`, una comilla invertida, `%` o un salto de
línea no se cita igual en las cuatro: ahí el freno no da la forma de la terminal y dice por qué.

Los límites de esto:

- La forma de la consola se midió en una sola máquina (extensión de VS Code 2.1.289, Git Bash). Con otra versión u otra
  forma, se niega: es seguro, pero puede frenarte. En ese caso, usá `--terminal`.
- Git para Windows hace falta para firmar con un click, porque sin él la herramienta no tiene consola Bash, y para que
  corran los controles que son guiones de bash, entre ellos el freno de seguridad. Qué pasa con esos controles sin Git no
  se midió en una máquina sin Git: por eso se pide. El diagnóstico (`/tycon-harness`) avisa si falta, y no impide instalar.
  Para firmar sin él queda `--terminal`, en la ventana nueva.
- No está medido un usuario con espacios en la ruta, ni una carpeta temporal fuera de la casa de la cuenta: si la forma no
  coincide, se niega.
- Git Bash le cambia a un programa los argumentos que parecen rutas. Si uno llega distinto de lo que aprobaste, se niega y
  tu aprobación se pierde: hay que pedirla de nuevo.
- El gancho que anota tu aprobación se midió en una sesión sin pantalla (`claude -p`), no en una con pantalla.
- Un motivo con acentos todavía no se probó de punta a punta.

### En Linux

En Linux el click va por el mismo camino que en la Mac, pero no se probó en una máquina real con una sesión de VS Code. Si
la forma no coincide, se niega y queda `--terminal`.

## Las firmas

La columna «¿Desde otra sesión?» dice si el comando se puede correr desde la pestaña de otra sesión (medido el
2026-10-26). Un escape se firma en la pestaña de la propia sesión (con la ventana, o con tu click o tu «aprobado» dado ahí
o en la coordinadora) o corriendo el comando en tu terminal, donde no hay freno; en Windows, sólo en tu terminal. Los
escapes que pide su guion en su forma exacta, como las firmas de guion (`escape:force-manual`, `escape:trust-ran` y los
de `sign-file`), se firman igual que ellas, también en Windows con tu click o tu «aprobado»; desde otra sesión van con
`--for-session <D>`. Con un tubo atrás (`2>&1 | tail`) o una envoltura dejan de estar en su forma: el freno los niega
sin gastar tu aprobación y pide correrlos solos.

La columna «Firmarla en la terminal» es la otra salida, para quien la prefiera o donde hace falta (ver «Aprobar sin
terminal»). En Windows la terminal no se lee: cada uno de esos comandos abre una ventana nueva con el mismo comando, y ahí
firmás escribiendo tres palabras al azar. La ventana vence a los 5 minutos sin firmar nada.

Traer main a un pedido con un cambio de control ya firmado no pide otra firma. Si cada archivo de control es lo que firmó
el dueño, tal cual o con lo de main fusionado sin conflictos, el control de la base acepta la constancia que ya está y
`pending` dice que no hace falta firmar. Un conflicto resuelto a mano, o cualquier cambio propio después de la firma,
vuelve a pedir la firma del dueño.

<!-- generado: firmas -->
| Firma | Qué aprueba | Comando que la pide | ¿Desde otra sesión? | Firmarla en la terminal |
| --- | --- | --- | --- | --- |
| `plan-approval` | aprobar el plan de una story | `marker.js complete-step approve-plan --approved` | sí | `marker.js complete-step approve-plan --terminal` |
| `extra-round` | pedir una vuelta más de revisores | `pipeline.js smart-reloop --extra-round` | sí | `pipeline.js smart-reloop --extra-round --terminal` |
| `refresh-after-main` | refirmar los controles tras traer main, sin cambio propio | `run-base-controls.sh approve` | sí | `run-base-controls.sh approve --terminal` |
| `control-change` | aprobar un cambio de los controles del repo | `run-base-controls.sh approve` | sí | `run-base-controls.sh approve --terminal` |
| `critical-waiver` | eximir un hallazgo crítico de los revisores | `marker.js waive-critical` | sí | `marker.js waive-critical --terminal` |
| `runtime-waiver` | aceptar un criterio imposible de probar en vivo | `marker.js runtime-waiver` | sí | `marker.js runtime-waiver <historia> --terminal` |
| `compare-waiver` | eximir de la comparación con main a un comando que la historia modifica | `marker.js compare-waiver --story <S> --command <candidato> --reason <R>` | sí | `marker.js compare-waiver --story <S> --command <candidato> --reason <R> --terminal` |
| `manual-test` | marcar un criterio como probado a mano | `marker.js mark-tested --acs` | sí | `marker.js mark-tested --acs --terminal` |
| `browser-test` | preparar la prueba con navegador, o decirle que no | `e2e-setup.js prepare (o defer --no)` | sí | `e2e-setup.js prepare --terminal (o defer --no --terminal)` |
| `lost-run` | dar por perdida una ejecución y cerrarla | `marker.js clear-session --lost (o restore)` | sí | `marker.js clear-session --lost --terminal (o restore --terminal)` |
| `lost-run:particion` | cerrar una ejecución perdida que la partición de su historia en tandas dejó sin objeto | `marker.js clear-session <S> --lost --partition` | sí | `marker.js clear-session <S> --lost --partition --terminal` |
| `adversarial-skip` | saltear el pase adversarial con constancia | `marker.js sign-adversarial-skip --story <S> --reason <R>` | no, en la pestaña de esa sesión | `marker.js sign-adversarial-skip --story <S> --reason <R> --terminal` |
| `atdd-skip` | saltear «pruebas primero» en una ejecución, con constancia | `marker.js sign-atdd-skip --story <S> --reason <R>` | no, en la pestaña de esa sesión | `marker.js sign-atdd-skip --story <S> --reason <R> --terminal` |
| `review-skip` | contestar «skip» a la pregunta del pase del código | `marker.js review-answer --kind code --choice skip` | sí | `marker.js review-answer --kind code --choice skip --terminal` |
| `pending-approval` | abrir un pendiente nuevo en la lista de pendientes | `marker.js approve-pending --id <CÓDIGO> --repo <carpeta>` | sí | `marker.js approve-pending --id <CÓDIGO> --repo <carpeta> --terminal` |
| `adhoc-lane` | abrir el arreglo rápido de una sesión, sin historia | `marker.js adhoc set '<json>'` | sí | `marker.js adhoc set --reason "<motivo>" [--max-files N] --data sin-cambio --file <ruta> --terminal --for-session <id>` |
| `adhoc-lane:sobre-cupo` | abrir un arreglo rápido que pasa el tope de archivos del camino corto, aunque se recomienda una historia | `marker.js adhoc set '<json con maxFiles mayor que el tope, por defecto 8>'` | sí | `marker.js adhoc set --reason "<motivo>" --max-files <N> --data sin-cambio --file <ruta> --terminal --for-session <id>` |
| `adhoc-lane:datos` | dejar pasar un arreglo rápido que cambia de dónde sale un dato o quién lo ve, sin historia | `marker.js adhoc allow-data-change --changed <qué cambió> --recommends pasar --why <por qué>` | sí | `marker.js adhoc allow-data-change --changed <qué cambió> --recommends pasar --why <por qué> --terminal --for-session <id>` |
| `adhoc-lane:guardado-ajeno` | dejar pasar una vez un guardado ajeno a un camino corto que espera sus revisores, con lo que guarda a la vista | `marker.js adhoc allow-foreign-save` | sí | `marker.js adhoc allow-foreign-save --terminal --for-session <id>` |
| `autonomy-resume` | volver al modo autónomo una ejecución que el control de cierre detuvo, con las vueltas en cero | `marker.js resume-autonomy` | sí | `marker.js resume-autonomy --terminal --for-session <id>` |
| `save` | guardar la story: commit, push y los pull requests | `marker.js approve-save [--for-session <D>]` | sí | `marker.js approve-save --terminal --for-session <D>` |
| `designation-confirm` | confirmar qué sesión es la coordinadora de esta máquina | `delegated-signing.js confirm-designation` | no, en la pestaña de esa sesión | `delegated-signing.js confirm-designation --terminal` |
| `designation-set` | nombrar a esta sesión coordinadora de la máquina | `marker.js designate-relay` | no, en la pestaña de esa sesión | `marker.js designate-relay --terminal` |
| `designation-withdraw` | retirar a esta sesión de coordinadora de la máquina | `marker.js withdraw-relay` | no, en la pestaña de esa sesión | `marker.js withdraw-relay --terminal` |
| `escape:TYCON_SAFETY_OFF` | apagar el freno de seguridad para un comando (retirada: ya no apaga nada) | retirada: ya no apaga nada; la salida es la emergencia | no, sólo en tu terminal | `harness.js sign emergency --reason "<por qué>" --request <número>` |
| `escape:TYCON_PROD_LINT` | apagar el control de consultas a producción para un comando (retirada: ya no apaga nada) | retirada: ya no apaga nada; la salida es la emergencia | no, sólo en tu terminal | `harness.js sign emergency --reason "<por qué>" --commit` |
| `escape:TYCON_NEW_NAMES` | apagar el control de nombres nuevos en lo que se publica | `TYCON_NEW_NAMES=0 <comando>` | no, en la pestaña de esa sesión | `TYCON_NEW_NAMES=0 <comando>` |
| `escape:TYCON_TEST_GATE` | saltear el portón de pruebas del commit | `TYCON_TEST_GATE=1 <comando>` | no, en la pestaña de esa sesión | `TYCON_TEST_GATE=1 <comando>` |
| `escape:DOD_BYPASS` | saltear los controles del commit (queda anotado) | `DOD_BYPASS=1 <comando>` | no, en la pestaña de esa sesión | `DOD_BYPASS=1 <comando>` |
| `escape:TYCON_NO_DEEP_REVIEW` | pedir que se saltee el pase adversarial (esta firma no lo saltea: eso lo firma adversarial-skip) | `TYCON_NO_DEEP_REVIEW=1 <comando>` | no, en la pestaña de esa sesión | `TYCON_NO_DEEP_REVIEW=1 <comando>` |
| `escape:TYCON_STATUS_GATE` | cambiar a mano el estado de una story | `TYCON_STATUS_GATE=off <comando>` | no, en la pestaña de esa sesión | `TYCON_STATUS_GATE=off <comando>` |
| `escape:TYCON_MUTATION_CHECK` | saltear el chequeo de mutantes de las pruebas | `TYCON_MUTATION_CHECK=off <comando>` | no, en la pestaña de esa sesión | `TYCON_MUTATION_CHECK=off <comando>` |
| `escape:TYCON_STORY_REVIEW` | saltear la revisión de la historia antes del plan | `TYCON_STORY_REVIEW=0 <comando>` | no, en la pestaña de esa sesión | `TYCON_STORY_REVIEW=0 <comando>` |
| `escape:story-skill-bypass` | escribir una story sin la skill de stories | `marker.js sign-file story-skill-bypass <archivo>` | sí | `marker.js sign-file story-skill-bypass <archivo> --terminal --for-session <sesión del agente>` |
| `escape:red-control-test-edit` | editar una prueba vieja de un control que estaba en rojo | `marker.js sign-file red-control-test-edit <archivo>` | sí | `marker.js sign-file red-control-test-edit <archivo> --terminal --for-session <sesión del agente>` |
| `escape:set-autonomous` | cambiar el modo autónomo de una ejecución | `marker.js set-autonomous` | no, en la pestaña de esa sesión | `el mismo comando` |
| `escape:cerrar-la-ejecucion` | cerrar una ejecución con un control en rojo | `marker.js clear` | no, en la pestaña de esa sesión | `el mismo comando` |
| `escape:cerrar-como-deuda` | cerrar una ejecución dejando lo que falta como deuda | `marker.js close-as-debt` | no, en la pestaña de esa sesión | `el mismo comando` |
| `escape:rojo-esperado-de-la-matriz` | llevar al commit criterios sin evidencia en vivo, hasta una fecha | `marker.js expect-red acmatrix --tests <T1,T2> --until <AAAA-MM-DD>` | no, en la pestaña de esa sesión | `el mismo comando` |
| `escape:force-manual` | marcar a mano el estado de un control | `marker.js set-check <control> <estado> --force-manual [--for-session <D>]` | sí | `marker.js set-check <control> <estado> --force-manual --terminal` |
| `escape:trust-ran` | contar los revisores sin la constancia de que corrieron | `pipeline.js check-count --repo <r> --story <s> --trust-ran [--for-session <D>]` | sí | `pipeline.js check-count --repo <r> --story <s> --trust-ran --terminal` |
| `escape:no-mutation` | cerrar «Correr las pruebas» sin el chequeo de mutantes, con motivo | `marker.js complete-step run-tests --no-mutation --reason <motivo>` | no, en la pestaña de esa sesión | `marker.js complete-step run-tests --no-mutation --reason <motivo> --terminal --for-session <sesión>` |
| `escape:ALLOW_DOD_EVIDENCE_WRITE` | escribir a mano la evidencia de la prueba en vivo | `marker.js sign-file ALLOW_DOD_EVIDENCE_WRITE <archivo>` | sí | `marker.js sign-file ALLOW_DOD_EVIDENCE_WRITE <archivo> --terminal --for-session <sesión del agente>` |
| `escape:dod_runtime_exempt` | eximir una story de la prueba en vivo | `marker.js sign-file dod_runtime_exempt <archivo>` | sí | `marker.js sign-file dod_runtime_exempt <archivo> --terminal --for-session <sesión del agente>` |
| `escape:no-deep-review` | correr los guiones del pase adversarial con un --env-file, que puede cambiar su decisión | `node --env-file=<archivo> pipeline.js start|deep-review-gate (o marker.js mark-adversarial-skipped)` | no, en la pestaña de esa sesión | `el mismo comando` |
| `escape:cambiar-el-estado` | cambiar a mano el estado de una story | `marker.js sign-file cambiar-el-estado <archivo>` | sí | `marker.js sign-file cambiar-el-estado <archivo> --terminal --for-session <sesión del agente>` |
| `escape:merge-bypass` | mergear salteando la cola y la CI de main, o aflojar las políticas de la rama | `gh pr merge <n> --admin (o un merge, una regla o una política por la API)` | no, en la pestaña de esa sesión | `el mismo comando` |
| `escape:external-pr` | encolar o mergear un pull request de alguien de afuera del equipo | `el comando que encola o mergea el pull request (o la API)` | no, en la pestaña de esa sesión | `el mismo comando` |
<!-- fin: firmas -->

## Los grupos de la 8.116

Antes de este catálogo, `approvals.delegated_signing` aceptaba once de estos nombres, y los sigue aceptando;
`compare-waiver` se sumó con la comparación con main (historia 8.167). Cada uno vale por las firmas de su fila. `off` no es un grupo: quiere decir «ninguna». `adversarial-skip` es válido, pero no
delega nada: saltear el pase lo firma sólo el dueño.

`escape-phrases` no trae `escape:force-manual` ni `escape:trust-ran`: esas dos se piden con su propio guion, también
para otra sesión, y se delegan sólo nombrándolas. `approvals.owner_only` no acepta grupos: cada firma que el dueño se
reserva va por su id.

`lost-run` no trae `lost-run:particion`, la forma de rutina de cerrar una ejecución que la partición de su historia dejó
sin objeto: un perfil que ya delega `lost-run` no la delega sin pedirla por su id. Al reservar, sí: `lost-run` en
`approvals.owner_only` la vuelve sólo del dueño también.

<!-- generado: grupos -->
| Grupo | Firmas |
| --- | --- |
| `refresh-after-main` | `refresh-after-main` |
| `adversarial-skip` | `adversarial-skip` |
| `critical-waiver` | `critical-waiver` |
| `escape-phrases` | `escape:TYCON_SAFETY_OFF`, `escape:TYCON_PROD_LINT`, `escape:TYCON_NEW_NAMES`, `escape:TYCON_TEST_GATE`, `escape:DOD_BYPASS`, `escape:TYCON_NO_DEEP_REVIEW`, `escape:TYCON_STATUS_GATE`, `escape:TYCON_MUTATION_CHECK`, `escape:TYCON_STORY_REVIEW`, `escape:story-skill-bypass`, `escape:set-autonomous`, `escape:cerrar-la-ejecucion`, `escape:cerrar-como-deuda`, `escape:rojo-esperado-de-la-matriz`, `escape:ALLOW_DOD_EVIDENCE_WRITE`, `escape:dod_runtime_exempt`, `escape:no-deep-review`, `escape:cambiar-el-estado` |
| `plan-approval` | `plan-approval` |
| `browser-test` | `browser-test` |
| `runtime-waiver` | `runtime-waiver` |
| `compare-waiver` | `compare-waiver` |
| `manual-test` | `manual-test` |
| `extra-round` | `extra-round` |
| `control-change` | `control-change` |
| `lost-run` | `lost-run` |
<!-- fin: grupos -->

## Lo que la ventana no ve

El freno niega la ventana si la herramienta la lanzó una consola u otra herramienta, y el comando de firma se firma
entonces en la terminal. El click y el «aprobado» tampoco valen ahí. Hay un caso que no ve: una herramienta que el agente abre dentro de `tmux` y a la que le manda
teclas puede contestar su propia ventana. El servidor de `tmux` no tiene padre, y desde los procesos de la máquina no se
distingue un `tmux` de la persona de uno del agente.

Las constancias de las firmas viven en la carpeta de estado del arnés: el registro `gates.log` y los archivos que deja
cada firma (el del arreglo rápido, `adhoc/<sesión>.json`, entre ellos). El portón de edición abre el arreglo rápido sólo
si el archivo trae la hora de su firma y el registro tiene el renglón `adhoc-lane-signed` de esa sesión y esa hora. Eso
frena los errores y los atajos: un archivo copiado, escrito suelto o dejado por una versión vieja del arnés no abre. No
frena a un agente que esquive el freno de la carpeta de estado: el agente corre con el mismo usuario que la persona, y
quien escribe el archivo por una vía que el freno no ve escribe también el renglón. La barrera contra eso es el freno de
la carpeta de estado, que niega toda escritura ahí que no sea de los guiones del arnés.

Un click o un «aprobado» los anota un gancho que lanza la herramienta. Al usarlos, el arnés relee la transcripción de la
sesión: tiene que estar el mensaje tipeado por la persona, o el cuadro contestado por ella y no por un gancho. Un agente
que corre el gancho a mano no anota nada. Lo que no cubre: un agente que rompa un freno a propósito para escribir a mano
el registro y la transcripción, porque corre con el mismo usuario que la persona.

Además, cada firma que da un guion deja un renglón en un registro común, `signatures.jsonl`, en la misma carpeta que
`gates.log`. Lo escribe `scripts/lib/signature-log.js`. El renglón dice quién firmó y por qué vía (la ventana, el click,
el mensaje, la terminal, la delegación o «hecho y avisado»); si fue delegada, quién la pidió y sobre qué sesión; también el id y el nivel de la firma en el
catálogo, la huella de la máquina, la hora y el motivo. Los registros de cada guion siguen como están. Si el registro
común no se puede escribir, la firma igual vale y el guion lo avisa. Los escapes del freno de seguridad no pasan por
ahí: su constancia se escribe al pedir la ventana, antes de que la persona conteste.

## Lo delegado no está protegido

La sesión de la coordinadora es un agente. Si decide aprobar una firma delegada por su cuenta,
el arnés no lo distingue de un ok del dueño. Por eso a la lista de delegadas sólo va lo de bajo riesgo: aprobar planes, la vuelta extra de revisores y refirmar los
controles tras traer `main`.

Tocar un freno es sólo del dueño: aprobar un cambio de los controles, los escapes que apagan un freno (salvo los dos de
abajo), eximir pruebas o un crítico, aceptar un criterio imposible de probar y saltear el pase adversarial.

**Mergear salteando la CI (`merge-bypass`) nunca se delega.** La pide el freno de la sesión (regla GIT-C5) cuando un
comando saltea la cola y la CI de main o afloja las políticas de la rama: `gh pr merge --admin`, un merge o un cambio de
reglas por la API, `--bypass-policy` en Azure DevOps. Es nivel 3: la aprueba la persona en la ventana o, sin ventana,
con un click en el cuadro de opciones o un «aprobado», y vale para ese comando, una vez. En Codex se da en la terminal,
como las demás. Aunque el perfil la nombre en `approvals.delegated_signing`, la coordinadora no la firma: saltear la CI
es aflojar todos los controles juntos. El camino normal sigue siendo encolar el pedido: `gh pr merge <n> --merge`.

**Encolar o mergear un pedido de afuera (`external-pr`) tampoco se delega.** La pide el freno de la sesión (regla GIT-C7)
cuando un comando encola o mergea un pedido de GitHub cuyo autor no está en `pull_requests.team_authors` del perfil del equipo:
el merge del pedido por su comando (con o sin `--auto`), `enqueuePullRequest`, `enablePullRequestAutoMerge` o `mergePullRequest` por la
API, o un merge sobre `pulls/<n>/merge`. Un bot es de afuera salvo que el perfil lo nombre. Sin lista en el perfil, es del equipo la cuenta con la que
el CLI de GitHub está autenticado en la máquina; si no se puede leer, frena. El cuadro dice el autor, el
número, el título y cuántos archivos toca el pedido. Es nivel 3, se aprueba como `merge-bypass` y vale para ese comando,
una vez. Si el freno no puede saber de quién es el pedido (sin red, el número armado por la terminal, el perfil roto),
frena sin pedir firma. Los pedidos del equipo pasan sin pregunta.

**Un mensaje de la oficina nunca vale como firma ni como permiso para firmar por delegación.** Lo que el dueño le escribe a
una sesión desde `/office` le llega como el aviso de un gancho, que la herramienta anota como aviso del sistema y no como la
persona: el registro de aprobaciones sólo acepta lo tipeado en la pestaña y el click en el cuadro, y un cuadro abierto sigue
esperando. Un agente de la misma cuenta puede leer el token de la oficina e imitar el mensaje; por eso no firma, ni siquiera
con «aprobado». La sesión lo comprueba con `office-message.js verify <id>` y lo trata sólo como una indicación.

## Aprobar en nombre del dueño

La sesión designada corre la firma desde su pestaña, con `--for-session <sesión>`, y el freno la deja correr sin
ventana sólo si se cumple todo esto:

- el perfil del equipo pone la firma en `approvals.delegated_signing` (un grupo cuenta por cada firma que nombra) y no en
  `approvals.owner_only`: si está en las dos, gana «sólo del dueño»;
- esta máquina está en `approvals.delegated_machines`;
- la sesión que la corre es la designada, y el dueño confirmó la designación (con su click en esa pestaña, o en su terminal);
- la sesión destino no es la propia, ni trabaja la misma historia que una ejecución abierta de la sesión designada;
- ninguna consola de fondo viva de la designada, salvo un vigilante de sólo lectura (abajo).

**El vigilante de sólo lectura no quita la firma por delegación.** La coordinadora puede tener de fondo, y firmar
igual, sólo esta forma exacta, para cualquier plataforma:

- `node <coordination.js> pr-wait --repo <organización/repo> --number <número>`, con `--interval <segundos>` opcional y
  el `coordination.js` de este mismo arnés: repite sólo la lectura del pedido por la capa de plataforma, y termina
  cuando deja de estar abierto.
- `node <coordination.js> pr-wait --repo <organización/repo> --story <historia>`, con el mismo `--interval` opcional:
  espera a que la historia abra su pedido. Lee sólo la lista de pedidos abiertos, y termina con el número y el título
  del pedido cuando aparece uno de la rama `story/<historia>`, o con la historia al principio del título («8.32 A: …»)
  o al principio de un paréntesis («(8.32 A)»). Un título que sólo la cita no cuenta, ni un revert, ni el de la rama
  de un bot de dependencias.
- En las dos, `--repo` también va como `<organización>/<proyecto>/<repo>`: un repo de Azure DevOps que `team-repos.json`
  no declara, leído con su proyecto, sin mirar el perfil.

Los números van escritos tal cual, y la línea no lleva nada más: ni tubos, ni `&&` o `;`, ni redirecciones, ni nada
armado con `$`. Cualquier otra consola de fondo sigue frenando, también el vigilante propio de una plataforma o un bucle
escrito a mano que sólo consulta: desde la línea de comando el freno no puede saber si además escribe, y por eso la
lectura de un pedido va por `pr-wait`. Una ejecución suelta de la CI no se vigila de fondo. El
freno, al negar, dice que hay una consola de fondo viva que no es un vigilante de sólo lectura, y nunca muestra su línea
de comando. En Windows no cambia nada.

**La firma que pide la sesión que trabaja, para sí, va sola a la coordinadora.** Si la sesión que implementa corre una
firma que el perfil delega, sin `--for-session`, y la coordinadora la podría firmar por delegación, el freno la niega
sin ventana ni cuadro. A la sesión le dice que espere el aviso de la coordinadora, y en la lista de firmas deja el comando exacto que va a
correr la coordinadora: el mismo, con `--for-session <sesión>` al final y las rutas absolutas, porque ella lo corre
desde su carpeta. El freno pregunta las mismas llaves de arriba, como si ya lo corriera ella. Antes de desviar, gana una
aprobación explícita de la persona (su click o su «aprobado»); lo de rutina en una pestaña sin permisos sigue «hecho y
avisado»; y lo que el guion iba a negar (un pendiente ya aprobado) se niega con su texto, sin renglón.

- `owner-next` le da ese comando sólo a la coordinadora, y sólo si el pedido está en la conversación de la sesión que lo
  pidió: con su id, con ese mismo comando y con algo escrito después. Un renglón escrito a mano para otra sesión no la
  hace firmar. A cualquier otra sesión no le da nada.
- La firma sale como siempre, del proceso de la coordinadora y por la delegación; su renglón del registro común lleva
  `routed: true`.
- **El respaldo.** Si la coordinadora no la firma en `approvals.delegation_wait_minutes` (10 por defecto, de 1 a 60, sólo
  del perfil), o deja de estar viva, el renglón se lee como del dueño, con su cuadro de siempre y una nota que dice por
  qué. No depende de que ella lo lea.
- **Lo que no se desvía:** las firmas sólo del dueño o que el perfil no delega; la máquina fuera de
  `approvals.delegated_machines`; sin coordinadora confirmada y viva; la que pide la coordinadora para sí; Windows; y el
  camino corto (`adhoc-lane`), porque abierto por la coordinadora el carril quedaría a su nombre y en su carpeta. Si una
  firma delegable no se desvió, la ventana o el cuadro dicen el motivo («No se desvió a la coordinadora: …»).

Pasar el tope de 8 archivos del camino corto (por defecto) es otra firma, `adhoc-lane:sobre-cupo`: la elige el dueño con
su click en el cuadro, en la pestaña que hace el trabajo o en la de la coordinadora vigente, o en su terminal, y queda
anotado. Es como el freno de los datos: un «aprobado» escrito no la da, ni la ventana de permiso, ni la delegación, aunque
el perfil la nombre. Cuentan sólo los archivos de implementación, sin pruebas ni guías. Su renglón en el registro
es `adhoc-lane:sobre-cupo-signed`, y abre el portón igual que `adhoc-lane-signed`.

Un camino corto que cambia de dónde sale un dato o quién lo puede ver no guarda: el freno de guardar busca en las líneas
del carril las señales del paquete del stack y, con una fuerte, frena. Al abrir, la sesión ya respondió esa pregunta
(`"datos"`), y con «cambian» no abre. Dejarlo pasar es la firma `adhoc-lane:datos` (`marker.js adhoc allow-data-change`),
de nivel 2: la aprueba sólo el click del dueño, en la pestaña que trabaja o en la de la coordinadora confirmada y viva, o
su terminal. Un «aprobado» escrito no la da, ni la ventana de permiso, ni la delegación. El cuadro dice qué lo frenó, qué
cambió de verdad y qué recomienda la sesión, con «Sí, aprobar» (dejar pasar) y «No» (la sesión escribe la historia, o
descarta lo del carril si el dueño lo dice). El click cubre esas señales: otra línea con una señal, o la misma editada,
frena de nuevo. Ante la duda, historia.

La maqueta aprobada de un arreglo que toca una pantalla se compara con lo construido por sus textos, no por el dibujo: el
detalle está en `guides/coordination.md`.

El arreglo rápido de otra pestaña (`adhoc-lane`) se declara así desde la sesión designada de la misma máquina, con
`marker.js adhoc set '<json>' --for-session <sesión>`; por esta vía el cupo es de 5 archivos como mucho por defecto (pedir más se niega, y
el freno da el cuadro para que lo apruebe una persona), el arreglo nunca toca lo sensible de `scripts/lib/signatures.js` y, antes de abrirlo, al dueño le llega una línea por los canales
de los avisos, como el ok de guardar (sin entrega, no hay arreglo). La
coordinadora de otra máquina no lo declara: se lo pide a la designada de la máquina destino (`guides/coordination.md`).
No entra en ninguno de los grupos de la 8.116: para delegarla, el perfil la nombra.

**La lista de archivos.** Todo camino rápido nuevo se abre con su lista cerrada de archivos (`"allowedFiles"` en el
JSON; en la terminal, `--file <ruta>` por cada uno): rutas relativas, una por una, sin comodines, sin carpetas y sin
`..`. Sin lista, o con una inválida, `adhoc set` se niega antes de pedir la firma, la pida quien la pida. La ventana
muestra la lista en el comando y el resumen dice cuántos archivos son. Editar fuera de la lista frena, y ampliarla es
otra firma del mismo tipo; por delegación, la lista nueva contiene entera la firmada. Pasan sin nombrarlas la prueba de
un archivo de la lista, la evidencia de `.advisors/` y la memoria de `.engram/`.

Lo que no se delega (ni lo abre «hecho y avisado» una pestaña sin permisos), y entonces lo abre una persona:

- un motivo con un salto de línea (eso se niega siempre: la ventana muestra un renglón), vago («varios», «arreglos»,
  «pendientes», «etc.») o con varios temas («;», «+», varias comas, o una coma y después una «y»);
- un segundo camino rápido delegado sobre el mismo repo: hay uno por repo;
- un camino rápido que toca una ruta de riesgo alto.

El límite de la consola: el portón de edición ve las herramientas de edición y lo que lee de la consola; lo que no ve
(un archivo movido o generado por un programa) lo frena el freno de guardar, que compara todo lo que cambió contra la
lista y nombra lo que sobra. Un carril delegado, además, no guarda nada de lo sensible.

**El plan de una parte.** Cuando la ejecución anota su tanda con `marker.js set-batch` y la parte vale (declara `files:`
o, sin él, la historia le ata archivos; sus archivos están en la historia y no pisa el código de otra parte abierta), la
marca de delicada del plan se mide por la parte más lo que el cambio toca, con coordinadora y sin ella. Es lo único que
afloja: una parte que no es delicada la aprueba la revisión automática, en vez del dueño (medido el 31/10: 82 de 115
partes recientes dejan de ser delicadas). Ese
plan queda atado a la lista de la parte, la que quedó al aprobar: editar código fuera de ella frena, y al cerrar se
mide el diff entero; si sale delicado, «Aprobar el plan» vuelve al dueño y el código queda en la rama. Si la revisión
aprobó el plan antes de anotar la tanda, anotarla con el plan igual no lo reabre cuando la parte declara `files:`: el
plan queda atado a esa lista, la que la historia declaraba al anotarla (después no se amplía); sin `files:` declarado,
o con el plan cambiado, «Aprobar el plan» vuelve a pendiente. El pase
adversarial, su modelo y la revisión de la historia siguen por la historia entera. Una historia cuyas partes no
declaran `files:` ni le atan ningún archivo a la tanda se sigue midiendo entera: la ganancia llega cuando las historias
dicen de qué parte es cada archivo (`story-format.md` §1.1, «La parte que vale»).

**Las pruebas y la rama del camino rápido.** Dos reglas más, para todo camino rápido con su lista:

- Si cambiaste código, no guarda sin una ejecución de pruebas en verde sobre lo que guardás. La corrés vos con
  `marker.js adhoc test -- <el comando de las pruebas>`, que anota el resultado y la huella de lo probado. Si cambiás
  código después, esa ejecución se vence y hay que repetirla. Si sólo tocaste guías o datos, no la pide.
- Si pasaste el tope de archivos con tu click, el código no se guarda en la rama principal del repo (la que el remoto
  tiene por defecto; si no se puede leer, `main` y `master`): creá vos una rama con `git switch -c <nombre>` y guardá
  ahí, con las pruebas en verde. Dentro del tope, esta regla no mira la rama.

Quién cambia los topes del camino corto: cada organización, en el perfil del equipo (`short_path.coordinator_max_files`,
de 1 a 6, y `short_path.max_files`, de 1 a 12; por defecto, 5 y 8), desde la sección «Los topes del camino corto» del sitio
o con un pedido al repo del perfil. Ese cambio no pide firma, pero nunca se aplica solo: lo aprueba una persona que no sea
quien lo propone. Ni la máquina ni una variable los cambian. Subir el máximo (el 6 o el 12) es un cambio de control
(`control-change`), sólo del dueño.

Un pendiente nuevo de otra sesión (`pending-approval`) se aprueba así desde la sesión designada, con
`marker.js approve-pending --id <CÓDIGO> --repo <carpeta> --for-session <sesión>`. La delegación vale sólo si la
carpeta es de esa sesión: el repo de su ejecución abierta, el worktree donde vive la historia de esa ejecución (suele
ser el privado; el clon principal no cuenta, porque lo comparten varias historias), el de un arreglo rápido que declaró
ella misma, o, si es una sesión de fondo que abrió la coordinadora y trabaja sin ejecución (modo ágil), la copia que
armó ella: un worktree agregado que ninguna otra sesión nombra, y donde esa sesión declaró el pendiente con
`marker.js declare-pending --id <CÓDIGO> --repo <su copia>`. El arnés no sabe quién armó una copia: sin esa
declaración, una copia de la coordinadora que nadie nombra pasaría por la de la sesión. La declaración vale como de la
sesión que corre el comando, y el freno la niega si el comando trae una variable de sesión. Tampoco puede ser un repo de la coordinadora: ni su checkout, ni los de su ejecución abierta y su historia, ni
el de su arreglo rápido. Si uno de los repos de ella no se encuentra, la delegación se niega. Los repos se
comparan por la carpeta real, así que otra forma de escribir la ruta no cambia el resultado.

**Límite declarado:** el arnés no sabe quién escribió el pendiente, sólo de quién es el repo. Si la coordinadora
escribe un pendiente en el repo de otra sesión, se lo puede aprobar sola. Esa vía no se usa: un pendiente que abre la
coordinadora lo aprueba el dueño.

Si falta algo, sale la ventana en la pestaña de la designada; si esa pestaña no pide permisos, el dueño lo aprueba ahí
con un click o un «aprobado» (ver «Aprobar sin terminal»). El guion firma con `via: delegacion`. Un escape es siempre
de la sesión que lo corre, así que nunca se delega. Refirmar los controles tras traer `main` se delega sólo cuando el
clasificador comprueba que es eso; si no, es un cambio de control, que es sólo del dueño.

Guardar se autoriza en la ventana de permiso, no con una firma: autorización siempre, firma nunca, y donde tiene
consecuencias: la persona aprueba el pull request, no cada commit. El commit y el empuje de la rama de trabajo los hace el
agente sin preguntar; se deshacen, y lo que no se deshace ya tiene su firma de control. La firma `save` y
`marker.js approve-save` siguen en el catálogo, y el freno las pide sólo si el perfil del equipo dice
`approvals.local_commit: coordinator`: entonces el commit de una ejecución no guarda sin ese ok vigente, que la
coordinadora da por delegación con los controles de siempre (ejecución limpia, nada sensible, aviso entregado). Si el
perfil no dice con certeza quién firma el commit, la ventana pregunta.

Saltear «pruebas primero» en una ejecución (`atdd-skip`) lo firma el dueño, como saltear el pase adversarial: el agente
lo pide con `complete-step implement --no-atdd` o `set-flag atddBypass`, el pedido anota la muestra, y el dueño firma
`marker.js sign-atdd-skip --story <S> --reason <R>` en la ventana o en su terminal. Vale para la ejecución entera y se
pide sólo cuando el freno frena.

El control del commit corre además el freno de publicación sobre lo que agrega ese commit: lo que el empuje frenaría (un
secreto, un nombre de la lista) frena el commit, y no queda historia que reescribir. La ventana ya preguntó, así que ese
sí se pierde. Sin poder mirar, el commit sigue con un aviso, y el empuje vuelve a mirar. El mensaje, el autor, los commits
anteriores y otro remoto público que no sea `origin` los sigue mirando sólo el empuje. Sin la lista, en la CI o en una
máquina de afuera, no mira.

El gancho del comando lo hace cumplir, no la memoria del agente. En una ejecución o en un camino rápido (el carril
firmado de `marker.js adhoc set`, sin vencer), el commit y el empuje de la rama de trabajo pasan sin pregunta (con sus
frenos) y quedan en `gates.log`. Antes de todo pull request que se crea o se mergea, y de todo empuje a una rama
compartida (`main`, `master`, `dev`, `release/*`, o una rama que no se sabe), el gancho le pregunta a la persona en la
ventana de permiso de siempre, con la evidencia de la ejecución; con el sí, sale. En una ejecución, antes de preguntar
frena si el paso «Preparar el pull request» no cerró o si el código cambió desde su foto. Lo lee también escondido en `bash -c`, con `-C` o desde una variable. Los comandos de pedido son los que
declaran los conectores de plataforma en `changeRequestCommands` de su `integration.json`, y además los de
`rawCommands` que dicen `pr` y terminan en `create`, `new` o `merge`; si alguna integración no se puede leer, un
comando que dice `pr` es una duda. Una frase en el chat o
un mensaje de otra sesión no saltean la ventana. En una pestaña que no pide permisos (la ventana se aprobaría sola), el
gancho abre el pull request sin preguntar y lo dice en pantalla, con la misma evidencia. Cerrar la ejecución ya no pide nada. Lo delicado (frenos, firmas,
controles, producción) lo cubre la firma de control del pedido, que es del dueño y no cambia.

### Lo de rutina en una pestaña sin permisos: hecho y avisado

En una pestaña que no pide permisos la ventana se aprobaría sola. Ahí, las cuatro firmas de nivel 1 se hacen sin firma
y quedan en el registro de firmas con la vía `notified` («hecho y avisado»): aprobar un pendiente, el ok de guardar, el
plan y abrir un arreglo rápido. Pasan por los mismos controles que la delegación de la coordinadora:

- el ok de guardar, sólo con la historia limpia y sin nada sensible;
- el plan, con la revisión automática aprobada; uno delicado, nunca: lo aprueba el dueño con su click o su «aprobado»;
- la maqueta (`approve-mockup`), igual que el plan, y nunca la de la propia sesión: la revisión que lanzó la sesión que
  implementa no cuenta para una pantalla, así que en su pestaña sin permisos la maqueta pide el click;
- el pendiente (`approve-pending`), sólo si lo pide la coordinadora confirmada para otra sesión y sobre un repo de esa
  sesión: el que abrió una sesión no se lo aprueba ella misma;
- el arreglo rápido, con el cupo delegado y sin tocar lo sensible.

La regla vale para toda firma que sale sin persona, por «hecho y avisado» o por la delegación: pasa por el control
previo de su guion, y una firma cuyo guion no trae ese control no sale por esas vías (pide el click). Lo que el perfil
puede delegar y no tenía control propio (eximir de la comparación con main, preparar la prueba con navegador, cerrar
una ejecución que la partición de su historia dejó sin objeto) sale sólo con una historia de rutina. Un evento de la
herramienta que no dice el modo de la pestaña cuenta como una pestaña sin permisos.

A la persona le llega el aviso por los canales de la sesión. Subir el tope de un arreglo rápido que ya existe sigue
siendo una firma. Todo lo de nivel 2 y 3 también: eximir un crítico, saltear el pase, un criterio que no se prueba en
vivo, cambiar un estado a mano, cerrar una ejecución perdida o como deuda, y cualquier cambio de control. Sin aprobación,
eso se niega en la pestaña sin permisos, y la negativa dice cómo aprobarlo con un click o un «aprobado» (lo que no los
acepta, en la terminal). Si la persona aprobó, la firma es suya y queda con esa vía, también en lo de rutina.

En una sesión de fondo no hay «hecho y avisado»: nadie ve el aviso en la pestaña, así que todo pide la aprobación.

Tres arreglos de la misma tanda:

- **Pendientes en un worktree:** un worktree agregado nunca cuenta como repo de la coordinadora, aunque ella pida la
  firma parada en él. Sólo cuentan su checkout y los clones principales donde trabaja.
- **El ok de guardar y lo preparado:** el chequeo previo del ok mira lo preparado cuando hay algo preparado, así un
  cambio que entra en dos commits se firma sin sacar del disco el resto. Las salidas y capturas de una prueba en vivo
  que su registro nombra con la misma huella cuentan como evidencia; una suelta, no.
- **`adhoc set`:** un motivo de más de 200 caracteres y un tope menor que los archivos ya tocados se niegan antes de
  abrir la ventana o pedir la firma.

La pregunta nombra la forma (`git push`, `… pr create`…) y el repo, nunca el comando, que puede traer una credencial;
tampoco la rama escrita en el comando; en un camino rápido, también su motivo. Un camino rápido es del repo de los
archivos que anotó (si todavía no anotó ninguno, de cualquiera); un pedido pregunta siempre. Dentro de una ejecución o de
un camino rápido, lo que el gancho no puede leer con certeza pregunta igual,
guarde o no: «no pude leer este comando». Entran el comando entero en una variable, un shell que lee de un tubo, `<<<`
o un heredoc, una función o un alias que no está en la copia del shell de la sesión, un programa que no se encuentra y
dice `commit`, `push` o `pr`, un subcomando de git que no es de git (un alias que no se resuelve en cuatro pasos, la
corrección automática), más de cuatro niveles de anidación, una ruta de Windows sin sus barras, la carpeta que sale de
una variable, un programa armado de un texto (`env -S`, `sudo -s`), una comilla o un heredoc sin cerrar, y el programa
escrito con comodines o llaves. Así, una forma nueva pregunta por defecto. Los comentarios y el mensaje de un heredoc
con comillas se leen como el shell: no corren. Los alias y las funciones de la copia del shell que guarda la sesión se
leen como lo que corren: `ll` o `gst` no preguntan, y un alias que empuja pregunta como el push. Las redirecciones de la
salida (`2>&1`, `> log`, `2>/dev/null`) no son una duda. Sin ejecución ni camino rápido, nada de esto pasa. Si el gancho mismo
no carga, frena dentro de una ejecución, y fuera deja pasar con un aviso.

Lo que no ve: un guion o un programa que guarda sin nombrar git en el comando (`node guardar.js`, `bash guion.sh`,
un programa que lee el comando de un archivo), los alias propios del programa de la plataforma,
los comandos de pedido que no lo crean ni lo mergean (la API, marcarlo listo, cambiarlo), los commits que hacen `merge`, `cherry-pick`, `revert`,
`am` o `commit-tree`, y
un alias o una función de la sesión que se llama como un programa del PATH (`ls`) y guarda por dentro sin decirlo.
Frena de más: un alias o una función que dos copias del shell definen distinto, o cuyo cuerpo no se lee entero (son
pocos y no de uso diario). El push a la rama actual armada por otro comando (`$(git branch --show-current)`) se lee
como `HEAD`; una rama que sale de otro comando o de una variable frena con el ok, como destino incierto.

### La ejecución trabada de otra sesión

Una ejecución que quedó abierta en otra sesión le impide a esa sesión arrancar la siguiente. La designada la cierra
desde su pestaña:

- si la ejecución no está perdida, `marker.js clear-session <sesión>` la cierra sin firma;
- si quedó perdida (le falta el marcador o la copia de su apertura), `marker.js clear-session <sesión> --lost
  --for-session <sesión>` pide la firma `lost-run`. Corre sin ventana si el perfil la delega, y si no, sale la ventana.

La ventana muestra la historia y la sesión que se cierran, que son las que nombra el comando. Donde la ventana no llega, se
aprueba con un click o un «aprobado» (ver «Aprobar sin terminal»). Si `--for-session` nombra
otra sesión, no se pide. `marker.js clear` cierra sólo la ejecución propia: con `--for-session` sale 2.
`marker.js restore <sesión>` rearma la ejecución perdida en la sesión que corre el comando, y firma para ésa.
