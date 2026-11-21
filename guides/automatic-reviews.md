# Las revisiones automáticas

Antes de programar, un agente revisa el **plan** de la historia; después de programar, el **pase adversarial** ejecuta el
código para buscarle defectos. Esta guía junta cuándo corre cada revisión, quién la lanza, con qué revisor, quién
aprueba, cuándo el dueño cuenta como ausente y cómo se configura. En inglés: [automatic-reviews.en.md](automatic-reviews.en.md).

Todo se configura en el sitio de la organización, pestaña Configuración, «Cómo trabaja Claude» (secciones **Revisión del
plan**, **Con qué corre la revisión**, **Pase adversarial** y **Vueltas de revisores**), y queda en `team-repos.json` del
repo del perfil. Un valor malo cae al de fábrica sólo en su clave, y se dice.

## Delicada o de rutina

Una historia es **delicada** si `pipeline.js risk-class` la marca así: toca seguridad, datos, frenos, firmas, el
instalador, producción, una migración, o declara `sensible:`. En duda, delicada. Lo demás es **de rutina**.

## Cuándo el dueño cuenta como ausente

- Está puesta **la marca de ausente**. La pone quien recibe el mensaje del dueño cuando dice que se va («seguí en
  autónomo», «me voy», «hasta mañana» o algo parecido): la coordinadora, o la propia sesión si no hay coordinadora, con
  `marker.js owner-away set --phrase "<lo que dijo>"`. Se borra sola cuando el dueño vuelve: un mensaje tipeado por él,
  un mensaje de la oficina verificado, una firma suya, o a las 24 horas. La oficina la muestra mientras está puesta.
- O la pregunta de una revisión lleva `plan_review.owner_away_minutes` minutos sin respuesta (de fábrica 20). Los
  minutos se cuentan desde que se anotó la pregunta (`marker.js review-ask`).

## Matriz 1: la revisión del plan

| ¿Delicada? | ¿Se corre? (de fábrica) | Quién aprueba si sale «aprobado» |
|---|---|---|
| Sí | Siempre, sin preguntar (`plan_review.delicate: always`) | El dueño, con el resultado en el cuadro. Si el perfil delega `plan-approval:delicada`, la coordinadora, sólo con el «aprobado» de la revisión que lanzó ella |
| No | Se le pregunta al dueño (`plan_review.routine: ask`). Dueño ausente: se revisa (`plan_review.routine_owner_away: review`) | La revisión, con o sin coordinadora (`plan_review.routine_approval: review`): con coordinadora, ella firma en nombre del dueño; sin coordinadora, se aprueba sin click. Con `person`, el dueño |

Se lanza con «Armar el plan» cerrado y sin una pregunta abierta a la persona sobre esta revisión (salvo que cuente como
ausente): antes, `plan-review` se niega sin lanzar nada y dice por qué. La cuarta vuelta de la misma historia, por
cualquier motivo, la decide una persona: su «review» a la pregunta, o la vuelta extra firmada; su ausencia no alcanza. La lanza la coordinadora (`marker.js plan-review --for-session <sesión>`); sin coordinadora, la propia sesión
(`marker.js plan-review`). La de la propia sesión aprueba un plan de rutina igual que la de la coordinadora; sólo
informa en una historia delicada o con `plan_review.routine_approval: person`. De fábrica corre una lente, «suposición
falsa»: lo que el plan cree del código y no es cierto. Los resultados:

| Resultado | Qué pasa |
|---|---|
| «aprobado» | Rutina: se aprueba, con o sin coordinadora (con coordinadora, ella firma; sin ella, `complete-step approve-plan` cierra sin click). Delicada, o con `plan_review.routine_approval: person`: le llega al dueño con «revisado, sin hallazgos» (una delicada la aprueba el arnés solo si el perfil pone `plan-approval:delicada` como trámite, con la revisión de la propia sesión) |
| «aprobado con notas» | Confirmados por debajo del corte de gravedad: cuenta como aprobado, la sesión los corrige al implementar y el cuadro los muestra |
| «rechazado» | Sólo por un confirmado en el corte (de fábrica, un defecto). La sesión corrige el plan y la revisión vuelve a correr. Llega al dueño al tope de rechazos seguidos (`review.max_rounds`, de fábrica 3), o enseguida con `plan_review.rejected_reaches_owner: true` |
| «sin veredicto» | Le llega al dueño con «no se pudo revisar: <motivo>». Si el plan o la historia cambiaron mientras corría, se reintenta una sola vez, con todos los cambios juntos. De la historia cuenta lo que define la construcción: su registro de después, «Ajustes después de la firma» y el `status` no la cambian; ante la duda, cuenta la historia entera |
| Se eligió no revisar | Aprueba el dueño, y el cuadro dice «sin revisión» |

### Qué garantiza la revisión que lanza la propia sesión

Sin coordinadora, el «aprobado» de la revisión que lanza la propia sesión aprueba un plan de rutina. Lo que garantiza:

- **Corre como otro proceso y con sus lentes**: `marker.js plan-review` devuelve el comando del corredor
  (`workflow-lite.js` con el guion del pase), con el revisor, el modelo y las lentes de la organización. No es la
  sesión que escribió el plan la que lo juzga.
- **El veredicto queda atado a la versión exacta del plan y de la historia**: la preparación guarda sus huellas; si el plan
  cambia mientras corre, queda «sin veredicto», y al aprobar se vuelven a calcular las dos. Un plan, una historia o una
  parte que cambiaron después de la revisión no se aprueban solos: hay que volver a lanzarla.
- **Sin veredicto o rechazado, el plan espera a una persona**, como con la coordinadora.
- **Queda anotada**: en gates.log (`plan-review` y `plan-approval-signed`), en el marcador (`planApproval.revision`) y en
  `approvals.jsonl` de la ejecución, a nombre de «revisión automática (<modelo>)». Viaja en el commit del pedido y la
  lee el portón de CI.
- **La sesión no puede escribirse el veredicto**: la carpeta `plan-review/` del estado está protegida contra lo que el
  agente escribe, mueve o borra, y el resultado vale sólo desde la ruta que nombró la preparación (el `--out` del
  corredor). El corredor del arnés pasa sólo con el pedido que preparó el arnés (`--args "$(cat '<…>.args.json')"`):
  con un pedido armado a mano, otro `--out`, un destino en una variable o relativo después de un `cd`, o revisores
  propios (`--agents-dir`, otra lista de `--runners`), el freno lo para. Con la herramienta Workflow
  de Claude Code el resultado pasa por la sesión, no llega a esa ruta, y el plan espera a una persona.
- **La sesión no puede sacarse el click**: la variable `TYCON_PLAN_ROUTINE_APPROVAL` sólo aprieta (`person`); en
  `review` no saca el que pide la organización. Una llave de quién aprueba mal escrita, o una configuración de la
  organización que no se lee o que la variable del arnés esconde, no aprueba sola: el plan espera a una persona, con el
  problema en el motivo.

Lo que **no** garantiza: que el plan sea lo que el dueño quería. La revisión busca errores sobre el código, no
intenciones. Por eso vale sólo para rutina: el dueño lo ve en el pedido (las aprobaciones de la ejecución) y puede
volver a pedir el click para todos los planes (`plan_review.routine_approval: person`). Y su límite, el de toda la
delegación: todas las sesiones corren con el mismo usuario del sistema, así que el arnés cierra el camino fácil (la
carpeta protegida y el resultado sólo del corredor), no una falsificación coordinada de la constancia y de gates.log.

## Matriz 2: la revisión del código (el pase adversarial)

| | Cambio chico (hasta `deep_review.small_max_files` archivos de código, de fábrica 6) | Cambio grande |
|---|---|---|
| Delicada | Corre siempre (`deep_review.delicate: always`) | Corre siempre |
| No delicada | De día, se pregunta (`deep_review.small_routine_day: ask`). Dueño ausente: corre (`deep_review.small_routine_owner_away: run`) | Corre (`deep_review.large_routine: run`) |

La lanza la propia sesión; la coordinadora sólo da el turno. Un cambio chico pero denso, o uno de riesgo NORMAL por
otro criterio que el tamaño, cuenta como grande. Lo de siempre sigue ganando: la constancia firmada de saltear, el
`always` del repo o de la organización, las banderas que lo fuerzan y la superficie compartida. Una ejecución de sólo
documentación no tiene pase.

## Matriz 3: con qué corre la revisión (las dos)

| Opción (`review_runner.order`) | Qué corre | Dónde se declara |
|---|---|---|
| `claude` (de fábrica) | Claude Code por terminal | `integrations/review-runner/integration.json` |
| `codex` | Codex por terminal | ídem |
| `cursor` | el agente de Cursor por terminal | ídem |
| `claude-ollama` | Claude Code con los modelos de Ollama | ídem |
| `custom` | el comando que escribe la organización (`review_runner.custom_command`) | el perfil (`team-repos.json`) |

La primera de la lista es «el revisor» y las demás, el orden de respaldo: si uno llega a su tope de uso o falla, el
mismo agente se relanza con el siguiente. En el modo código sólo corre un revisor confinado. Con
`review_runner.verifiers: per_lens` (de fábrica) la revisión lanza un verificador por clase de hallazgo, en vez de uno
por hallazgo.

## La gravedad que frena y el tope de vueltas

Sólo un hallazgo confirmado con gravedad en el corte `review.blocking_severity` (de fábrica `bug`) rechaza el plan o es
CRITICAL en el código; lo demás confirmado son notas o avisos. El tope de vueltas `review.max_rounds` (de fábrica 3) vale
para las dos revisiones; un repo lo ajusta en su `.tycon/advisors.yaml`, por commit. No hay ajuste por máquina.

## Los críticos de los revisores los anota el arnés

El agente arma `findings.json` con lo que dijeron los revisores, pero no es el único que lo escucha. Cada revisor del
paso «Revisores» cierra su respuesta con un renglón fijo: `Veredicto: limpio`, o `Veredicto: hallazgos (SEC-C1, SEC-C1,
SEC-W2) · bloquea: sí`, con la regla una vez por hallazgo. Cuando el revisor termina, el arnés lee ese renglón de la
respuesta del propio revisor y anota cuántos críticos dio de cada regla. Lo anota en el estado de la máquina, en una
zona que el agente no puede escribir. Lo lee el gancho del fin de un subagente en Claude Code, y el lanzador de los
revisores en Codex.

Al escribir los hallazgos y al cerrar el paso «Hallazgos», el arnés compara `findings.json` con lo anotado, y frena si:

- falta un crítico, o aparece con una gravedad menor;
- un crítico figura como arreglado sin una vuelta posterior del mismo revisor que ya no lo reporte;
- un crítico figura como refutado sin la constancia del verificador;
- un revisor del set no dejó un renglón que se pueda leer.

Un revisor ilegible nunca cuenta como «sin críticos». Si cerró sin el renglón de veredicto, el arnés se lo pide una sola
vez, al mismo revisor y sin que cambie su revisión: en Claude Code, el gancho del fin del subagente lo hace seguir con ese
pedido; en Codex, el lanzador lo corre una vez más sobre el mismo contexto, con su propio reporte. Lo que conteste
después cuenta en la misma vuelta, y el pedido no suma una vuelta ni una salida. Si tampoco lo da, el cierre lo dice
(«ya se le pidió el renglón una vez») y queda la exención de una persona: `marker.js waive-critical --rule SIN-REPORTE
--file <revisor> --reason '<por qué>'`. Si nunca se le pidió (por ejemplo, el gancho no corrió), el cierre dice primero
cómo pedírselo al mismo agente. Una exención por delegación no alcanza para dar algo por arreglado: eso lo cierra una
vuelta nueva del revisor o el dueño. Una ejecución sin nada anotado (por ejemplo, de antes de este control) lo dice en
una línea y sigue.

El revisor que reportó un crítico vuelve a la vuelta siguiente mientras ese crítico siga abierto: aunque el descuento
mecánico o el cálculo por diferencias lo saquen del set, y aunque el agente todavía no haya escrito los hallazgos. Sale
cuando un reporte suyo posterior ya no lo trae, o cuando el crítico tiene un destino que se sostiene: refutado con la
constancia del verificador, diferido, o eximido por el dueño.

## Las opciones

| Opción | Qué hace | Clave | Valores | De fábrica | Cuándo cambiarla |
|---|---|---|---|---|---|
| O1 | Revisión del plan en historias delicadas | `plan_review.delicate` | `always` · `ask` | `always` | `ask` si preferís decidir cada vez, aun en lo delicado |
| O2 | Revisión del plan en historias de rutina | `plan_review.routine` | `always` · `ask` · `never` | `ask` | `always` para no preguntar nunca; `never` si tu equipo no la quiere |
| O3 | Revisión del plan de rutina con el dueño ausente | `plan_review.routine_owner_away` | `review` · `wait` · `skip` | `review` | `wait` si preferís que espere; `skip` para seguir sin revisión |
| O4 | Quién aprueba un plan de rutina revisado sin defectos: la revisión (con o sin coordinadora) o una persona | `plan_review.routine_approval` | `review` · `person` | `review` | `person` si querés firmar vos todos los planes (el nombre viejo, `plan_review.coordinator_approves: false`, vale lo mismo) |
| O5 | Un plan rechazado le llega al dueño enseguida | `plan_review.rejected_reaches_owner` | `true` · `false` | `false` | `true` si querés ver cada rechazo, no sólo al llegar al tope |
| O6 | Revisión del código en historias delicadas | `deep_review.delicate` | `always` · `ask` | `always` | `ask` si preferís decidir cada vez |
| O7 | Hasta cuántos archivos de código un cambio es chico | `deep_review.small_max_files` | entero de 1 a 50 | `6` | más alto si tus historias tocan muchos archivos chicos |
| O8 | Revisión del código, rutina y chica, con el dueño presente | `deep_review.small_routine_day` | `ask` · `run` · `skip` | `ask` | `run` para correrla siempre; `skip` para lo de antes |
| O9 | Revisión del código, rutina y chica, con el dueño ausente | `deep_review.small_routine_owner_away` | `run` · `skip` · `wait` | `run` | `wait` si preferís que espere al dueño |
| O10 | Revisión del código, rutina y grande | `deep_review.large_routine` | `run` · `ask` | `run` | `ask` si preferís decidir cada vez |
| O11 | El revisor | `review_runner.order[0]` | `claude` · `codex` · `cursor` · `claude-ollama` · `custom` | `claude` | si tu equipo trabaja con otra herramienta |
| O12 | El orden de respaldo de los revisores | `review_runner.order` | lista sin repetidos de esos valores | `["claude"]` | para tener un respaldo cuando uno llega a su tope de uso |
| O13 | Minutos sin respuesta para contar al dueño como ausente | `plan_review.owner_away_minutes` | entero de 5 a 240 | `20` | más si el dueño suele contestar tarde |
| O14 | El comando del revisor propio (sólo con `custom`) | `review_runner.custom_command` | texto | — | con un revisor que no es de los de fábrica |
| O15 | El tope de vueltas, el mismo para el plan y el código | `review.max_rounds` | entero de 1 a 6 | `3` | menos para cortar antes; más si tus historias son largas |
| O16 | Cuántos verificadores | `review_runner.verifiers` | `per_lens` · `per_finding` | `per_lens` | `per_finding` para medir uno por hallazgo |
| O17 | Desde qué gravedad un hallazgo confirmado frena | `review.blocking_severity` | `bug` · `robustness` · `all` | `bug` | `robustness` o `all` para frenar también por lo demás |
| O18 | Qué lentes corre la revisión del plan | `plan_review.lenses` | lista de `suposicion-falsa` · `ac-sin-cubrir` · `prueba-que-falta` · `riesgo-sin-defensa` | `["suposicion-falsa"]` | sumar lentes para una revisión más amplia, a cambio de más agentes |

## Si la coordinadora no atiende

Una sesión no queda quieta esperando a una coordinadora que no atiende. Lo decide el arnés, nunca la sesión:

- **La revisión del plan.** Si la coordinadora designada no está viva (Claude Code borró su archivo de sesión, o su
  proceso ya no está), la revisión la lanza la propia sesión. Si está viva, el arnés anota el pedido al cerrar el plan;
  si ella no lanza la revisión en `plan_review.coordinator_wait_minutes` minutos (de fábrica 10, de 1 a 120), la lanza
  la sesión. Sin saber si vive, la sesión la espera esos minutos.
- **La pregunta a la persona.** El freno del cuadro le manda la pregunta a la coordinadora y lo anota. Si en esos mismos
  minutos ella no contesta, la sesión vuelve a preguntar y la pregunta le llega a la persona.
- **La coordinadora se entera sola:** su aviso de cada turno nombra cada plan que espera su revisión y cada pregunta que
  le mandó el freno, con los minutos que le quedan.

Esta clave todavía no está en la pantalla del sitio: se cambia con un pedido al perfil del equipo.
