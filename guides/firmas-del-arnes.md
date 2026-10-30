# Las firmas del dueño

Algunos pasos del arnés no los puede aprobar el agente que trabaja: los firma una persona. Esta guía lista todas esas
firmas, con el nombre que lleva cada una en el perfil del equipo. Sirve para decidir dos cosas del perfil:

- `approvals.delegated_signing`: qué firmas puede dar sola la sesión designada (la coordinadora), sin preguntarle al
  dueño.
- `approvals.owner_only`: qué firmas son sólo del dueño. Una firma no puede estar en las dos listas: si lo está, la
  lista de delegadas se lee rota y no delega nada.

Las dos listas se escriben sólo en el perfil del equipo: ni el archivo de la máquina ni una variable las cambian. Las
tablas de esta guía salen de `scripts/lib/signatures.js` con `node scripts/tools/signatures-guide.js --write`, y una
prueba falla si no coinciden.

## Los niveles

Cada firma tiene un nivel, según cuánto pesa lo que aprueba:

- **1 · rutina**: una decisión normal, que se deshace.
- **2 · excepción**: da por bueno algo sin verificarlo y deja deuda.
- **3 · irreversible**: no se deshace, o afloja un freno.

La coordinadora firma sola sólo la rutina. Un perfil que pone en `approvals.delegated_signing` una firma de nivel 2 o
más, por su id o por un grupo, no pasa la validación (`scripts/ci/check-profile-levels.js`). Una firma de hoy que junta
dos cosas de distinto peso cuenta con la mayor. Hay una excepción: el ok de guardar delegado no firma un cambio que toca
algo de lo sensible, así que por delegación vale 1.

La columna «Quién la ve» dice si la firma le llega al dev de producto o sólo a quien mantiene el arnés. La columna «Se
pide hoy con» dice con qué firma de la tabla siguiente se pide hoy. Varias de hoy se juntan en una sola, y una se parte
en dos. Los nombres de esta tabla todavía no se escriben en el perfil: llegan cuando cambie cómo se pide una firma.

<!-- generado: niveles -->
| Firma | Nivel | Quién la ve | Qué aprueba | Se pide hoy con |
| --- | --- | --- | --- | --- |
| `plan-approval` | 1 · rutina | dev y mantenimiento | aprobar el plan (sube a 2 si la historia es delicada) | `plan-approval` |
| `extra-round` | 1 · rutina | dev y mantenimiento | una vuelta más de revisores | `extra-round` |
| `pending-approval` | 1 · rutina | dev y mantenimiento | abrir un pendiente nuevo en la lista | `pending-approval` |
| `save` | 1 · rutina | dev y mantenimiento | guardar: commit, push y pedidos, si ningún commit toca algo de lo sensible | `save` |
| `browser-test:prepare` | 1 · rutina | dev y mantenimiento | preparar la prueba con navegador | `browser-test` |
| `adhoc-lane` | 1 · rutina | dev y mantenimiento | abrir un arreglo rápido sin historia, dentro del cupo | `adhoc-lane` |
| `refresh-after-main` | 1 · rutina | sólo mantenimiento | refirmar los controles tras traer main, sin cambio propio | `refresh-after-main` |
| `save:sensible` | 2 · excepción | dev y mantenimiento | guardar cuando un commit toca algo de lo sensible | `save` |
| `adhoc-lane:sobre-cupo` | 2 · excepción | dev y mantenimiento | abrir un arreglo rápido cuando ya se pasó el cupo | todavía no se pide |
| `escape:DOD_BYPASS` | 2 · excepción | dev y mantenimiento | saltear todos los controles del commit | `escape:DOD_BYPASS` |
| `critical-waiver` | 2 · excepción | dev y mantenimiento | eximir un hallazgo crítico | `critical-waiver` |
| `runtime-waiver` | 2 · excepción | dev y mantenimiento | aceptar un criterio imposible de probar en vivo, o eximir la historia entera | `runtime-waiver`, `escape:dod_runtime_exempt` |
| `manual-test` | 2 · excepción | dev y mantenimiento | marcar un criterio como probado a mano | `manual-test`, `escape:ALLOW_DOD_EVIDENCE_WRITE` |
| `browser-test:no` | 2 · excepción | dev y mantenimiento | decir que no a la prueba con navegador | `browser-test` |
| `adversarial-skip` | 2 · excepción | dev y mantenimiento | saltear el pase adversarial | `adversarial-skip`, `escape:TYCON_NO_DEEP_REVIEW`, `escape:no-deep-review` |
| `lost-run` | 2 · excepción | dev y mantenimiento | dar por perdida una ejecución y cerrarla | `lost-run`, `escape:cerrar-la-ejecucion`, `escape:cerrar-como-deuda` |
| `escape:force-manual` | 2 · excepción | dev y mantenimiento | marcar a mano el estado de un control | `escape:force-manual` |
| `escape:trust-ran` | 2 · excepción | dev y mantenimiento | contar revisores sin constancia de que corrieron | `escape:trust-ran` |
| `escape:TYCON_TEST_GATE` | 2 · excepción | dev y mantenimiento | saltear sólo el portón de pruebas del commit | `escape:TYCON_TEST_GATE` |
| `escape:TYCON_STATUS_GATE` | 2 · excepción | dev y mantenimiento | cambiar a mano el estado de una historia | `escape:TYCON_STATUS_GATE`, `escape:cambiar-el-estado` |
| `escape:story-skill-bypass` | 2 · excepción | dev y mantenimiento | escribir una historia sin la skill de historias | `escape:story-skill-bypass` |
| `escape:set-autonomous` | 2 · excepción | dev y mantenimiento | cambiar el modo autónomo de una ejecución | `escape:set-autonomous` |
| `control-change` | 3 · irreversible | sólo mantenimiento | cualquier cambio de control | `control-change` |
| `escape:TYCON_SAFETY_OFF` | 3 · irreversible | dev y mantenimiento | apagar el freno de seguridad para un comando | `escape:TYCON_SAFETY_OFF` |
| `escape:TYCON_PROD_LINT` | 3 · irreversible | dev y mantenimiento | apagar el control de consultas a producción | `escape:TYCON_PROD_LINT` |
| `escape:TYCON_NEW_NAMES` | 3 · irreversible | sólo mantenimiento | apagar el control de nombres en lo que se publica | `escape:TYCON_NEW_NAMES` |
<!-- fin: niveles -->

## Las firmas

La columna «¿Desde otra sesión?» dice si el comando se puede correr desde la pestaña de otra sesión (medido el
2026-10-26). Un escape se firma en la propia sesión o corriendo el comando en tu terminal, donde no hay freno. Dos
escapes, `escape:force-manual` y `escape:trust-ran`, los pide su guion en su forma exacta, como las firmas de guion:
desde otra sesión van con `--for-session <D>`.

En Windows la terminal no se lee: cada comando de la columna «Firmarla en la terminal» abre una ventana nueva con el
mismo comando, y ahí firmás escribiendo tres palabras al azar. La ventana vence a los 5 minutos sin firmar nada.

<!-- generado: firmas -->
| Firma | Qué aprueba | Comando que la pide | ¿Desde otra sesión? | Firmarla en la terminal |
| --- | --- | --- | --- | --- |
| `plan-approval` | aprobar el plan de una story | `marker.js complete-step approve-plan --approved` | sí | `marker.js complete-step approve-plan --terminal` |
| `extra-round` | una vuelta más de revisores | `pipeline.js smart-reloop --extra-round` | sí | `pipeline.js smart-reloop --extra-round --terminal` |
| `refresh-after-main` | refirmar los controles tras traer main, sin cambio propio | `run-base-controls.sh approve` | sí | `run-base-controls.sh approve --terminal` |
| `control-change` | aprobar un cambio de los controles del repo | `run-base-controls.sh approve` | sí | `run-base-controls.sh approve --terminal` |
| `critical-waiver` | eximir un hallazgo crítico de los revisores | `marker.js waive-critical` | sí | `marker.js waive-critical --terminal` |
| `runtime-waiver` | aceptar un criterio imposible de probar en vivo | `marker.js runtime-waiver` | sí | `marker.js runtime-waiver <historia> --terminal` |
| `manual-test` | marcar un criterio como probado a mano | `marker.js mark-tested --acs` | sí | `marker.js mark-tested --acs --terminal` |
| `browser-test` | preparar la prueba con navegador, o decirle que no | `e2e-setup.js prepare (o defer --no)` | sí | `e2e-setup.js prepare --terminal (o defer --no --terminal)` |
| `lost-run` | dar por perdida una ejecución y cerrarla | `marker.js clear-session --lost (o restore)` | sí | `marker.js clear-session --lost --terminal (o restore --terminal)` |
| `adversarial-skip` | saltear el pase adversarial con constancia | `marker.js sign-adversarial-skip --story <S> --reason <R>` | no, por la terminal | `marker.js sign-adversarial-skip --story <S> --reason <R> --terminal` |
| `pending-approval` | abrir un pendiente nuevo en la lista de pendientes | `marker.js approve-pending --id <CÓDIGO> --repo <carpeta>` | sí | `marker.js approve-pending --id <CÓDIGO> --repo <carpeta> --terminal` |
| `adhoc-lane` | abrir el arreglo rápido de una sesión, sin historia | `marker.js adhoc set '<json>'` | sí | `marker.js adhoc set '<json>' --terminal --for-session <id>` |
| `save` | guardar la story: commit, push y los pedidos | `marker.js approve-save [--for-session <D>]` | sí | `marker.js approve-save --terminal --for-session <D>` |
| `escape:TYCON_SAFETY_OFF` | apagar el freno de seguridad para un comando | `TYCON_SAFETY_OFF=1 <comando>` | no, por la terminal | `TYCON_SAFETY_OFF=1 <comando>` |
| `escape:TYCON_PROD_LINT` | apagar el control de consultas a producción para un comando | `TYCON_PROD_LINT=0 <comando>` | no, por la terminal | `TYCON_PROD_LINT=0 <comando>` |
| `escape:TYCON_NEW_NAMES` | apagar el control de nombres nuevos en lo que se publica | `TYCON_NEW_NAMES=0 <comando>` | no, por la terminal | `TYCON_NEW_NAMES=0 <comando>` |
| `escape:TYCON_TEST_GATE` | saltear el portón de pruebas del commit | `TYCON_TEST_GATE=1 <comando>` | no, por la terminal | `TYCON_TEST_GATE=1 <comando>` |
| `escape:DOD_BYPASS` | saltear los controles del commit (queda anotado) | `DOD_BYPASS=1 <comando>` | no, por la terminal | `DOD_BYPASS=1 <comando>` |
| `escape:TYCON_NO_DEEP_REVIEW` | apagar el pase adversarial de una ejecución | `TYCON_NO_DEEP_REVIEW=1 <comando>` | no, por la terminal | `TYCON_NO_DEEP_REVIEW=1 <comando>` |
| `escape:TYCON_STATUS_GATE` | cambiar a mano el estado de una story | `TYCON_STATUS_GATE=off <comando>` | no, por la terminal | `TYCON_STATUS_GATE=off <comando>` |
| `escape:story-skill-bypass` | escribir una story sin la skill de stories | `marker.js sign-file story-skill-bypass <archivo>` | no, por la terminal | `marker.js sign-file story-skill-bypass <archivo> --terminal` |
| `escape:set-autonomous` | cambiar el modo autónomo de una ejecución | `marker.js set-autonomous` | no, por la terminal | `el mismo comando` |
| `escape:cerrar-la-ejecucion` | cerrar una ejecución con un control en rojo | `marker.js clear` | no, por la terminal | `el mismo comando` |
| `escape:cerrar-como-deuda` | cerrar una ejecución dejando lo que falta como deuda | `marker.js close-as-debt` | no, por la terminal | `el mismo comando` |
| `escape:force-manual` | marcar a mano el estado de un control | `marker.js set-check <control> <estado> --force-manual [--for-session <D>]` | sí | `marker.js set-check <control> <estado> --force-manual --terminal` |
| `escape:trust-ran` | contar los revisores sin la constancia de que corrieron | `pipeline.js check-count --repo <r> --story <s> --trust-ran [--for-session <D>]` | sí | `pipeline.js check-count --repo <r> --story <s> --trust-ran --terminal` |
| `escape:ALLOW_DOD_EVIDENCE_WRITE` | escribir a mano la evidencia de la prueba en vivo | `marker.js sign-file ALLOW_DOD_EVIDENCE_WRITE <archivo>` | no, por la terminal | `marker.js sign-file ALLOW_DOD_EVIDENCE_WRITE <archivo> --terminal` |
| `escape:dod_runtime_exempt` | eximir una story de la prueba en vivo | `marker.js sign-file dod_runtime_exempt <archivo>` | no, por la terminal | `marker.js sign-file dod_runtime_exempt <archivo> --terminal` |
| `escape:no-deep-review` | saltear el pase adversarial de una ejecución | `pipeline.js start --no-deep-review` | no, por la terminal | `el mismo comando` |
| `escape:cambiar-el-estado` | cambiar a mano el estado de una story | `marker.js sign-file cambiar-el-estado <archivo>` | no, por la terminal | `marker.js sign-file cambiar-el-estado <archivo> --terminal` |
<!-- fin: firmas -->

## Los grupos de la 8.116

Antes de este catálogo, `approvals.delegated_signing` aceptaba estos once nombres, y los sigue aceptando. Cada uno
vale por las firmas de su fila. `off` no es un grupo: quiere decir «ninguna». `adversarial-skip` es válido, pero no
delega nada: saltear el pase lo firma sólo el dueño.

`escape-phrases` no trae `escape:force-manual` ni `escape:trust-ran`: esas dos se piden con su propio guion, también
para otra sesión, y se delegan sólo nombrándolas. `approvals.owner_only` no acepta grupos: cada firma que el dueño se
reserva va por su id.

<!-- generado: grupos -->
| Grupo | Firmas |
| --- | --- |
| `refresh-after-main` | `refresh-after-main` |
| `adversarial-skip` | `adversarial-skip` |
| `critical-waiver` | `critical-waiver` |
| `escape-phrases` | `escape:TYCON_SAFETY_OFF`, `escape:TYCON_PROD_LINT`, `escape:TYCON_NEW_NAMES`, `escape:TYCON_TEST_GATE`, `escape:DOD_BYPASS`, `escape:TYCON_NO_DEEP_REVIEW`, `escape:TYCON_STATUS_GATE`, `escape:story-skill-bypass`, `escape:set-autonomous`, `escape:cerrar-la-ejecucion`, `escape:cerrar-como-deuda`, `escape:ALLOW_DOD_EVIDENCE_WRITE`, `escape:dod_runtime_exempt`, `escape:no-deep-review`, `escape:cambiar-el-estado` |
| `plan-approval` | `plan-approval` |
| `browser-test` | `browser-test` |
| `runtime-waiver` | `runtime-waiver` |
| `manual-test` | `manual-test` |
| `extra-round` | `extra-round` |
| `control-change` | `control-change` |
| `lost-run` | `lost-run` |
<!-- fin: grupos -->

## Lo que la ventana no ve

El freno niega la ventana si la herramienta la lanzó una consola u otra herramienta, y el comando de firma se firma
entonces en la terminal. Hay un caso que no ve: una herramienta que el agente abre dentro de `tmux` y a la que le manda
teclas puede contestar su propia ventana. El servidor de `tmux` no tiene padre, y desde los procesos de la máquina no se
distingue un `tmux` de la persona de uno del agente.

Las constancias de las firmas viven en la carpeta de estado del arnés: el registro `gates.log` y los archivos que deja
cada firma (el del arreglo rápido, `adhoc/<sesión>.json`, entre ellos). El portón de edición abre el arreglo rápido sólo
si el archivo trae la hora de su firma y el registro tiene el renglón `adhoc-lane-signed` de esa sesión y esa hora. Eso
frena los errores y los atajos: un archivo copiado, escrito suelto o dejado por una versión vieja del arnés no abre. No
frena a un agente que esquive el freno de la carpeta de estado: el agente corre con el mismo usuario que la persona, y
quien escribe el archivo por una vía que el freno no ve escribe también el renglón. La barrera contra eso es el freno de
la carpeta de estado, que niega toda escritura ahí que no sea de los guiones del arnés.

## Lo delegado no está protegido

La sesión de la coordinadora es un agente. Si decide aprobar una firma delegada por su cuenta,
el arnés no lo distingue de un ok del dueño. Por eso a la lista de delegadas sólo va lo de bajo riesgo: aprobar planes, la vuelta extra de revisores y refirmar los
controles tras traer `main`.

Tocar un freno es sólo del dueño: aprobar un cambio de los controles, los escapes que apagan un freno (salvo los dos de
abajo), eximir pruebas o un crítico, aceptar un criterio imposible de probar y saltear el pase adversarial.

## Aprobar en nombre del dueño

La sesión designada corre la firma desde su pestaña, con `--for-session <sesión>`, y el freno la deja correr sin
ventana sólo si se cumple todo esto:

- el perfil del equipo pone la firma en `approvals.delegated_signing` (un grupo cuenta por cada firma que nombra) y no en
  `approvals.owner_only`: si está en las dos, gana «sólo del dueño»;
- esta máquina está en `approvals.delegated_machines`;
- la sesión que la corre es la designada, y el dueño confirmó la designación en su terminal;
- la sesión destino no es la propia, ni trabaja la misma story que una ejecución abierta de la sesión designada.

El arreglo rápido de otra pestaña (`adhoc-lane`) se declara así desde la sesión designada de la misma máquina, con
`marker.js adhoc set '<json>' --for-session <sesión>`; por esta vía el cupo queda en 8 archivos como mucho. La
coordinadora de otra máquina no lo declara: se lo pide a la designada de la máquina destino (`guides/coordination.md`).
No entra en ninguno de los grupos de la 8.116: para delegarla, el perfil la nombra.

Si falta algo, sale la ventana en la pestaña de la designada. El guion firma con `via: delegacion`. Un escape es siempre
de la sesión que lo corre, así que nunca se delega. Refirmar los controles tras traer `main` se delega sólo cuando el
clasificador comprueba que es eso; si no, es un cambio de control, que es sólo del dueño.

El ok de guardar (`save`) suma tres límites cuando va por delegación, y los comprueba antes de firmar:

- la story terminó limpia: el commit preparado sin cambios después, las pruebas de la suite completa y el pase
  adversarial posteriores al último cambio, ningún crítico (ni eximido) y ninguna exención en la corrida;
- el cambio no toca nada de la lista de lo sensible de `scripts/lib/signatures.js` (firmas, frenos, avisos, permisos,
  el perfil, el poder de la coordinadora);
- el aviso le llegó al dueño por un canal de la lista del perfil (`integrations.notify.channels`).

Si falta una, el guion lo dice y no firma: el ok lo da el dueño.

### La ejecución trabada de otra sesión

Una ejecución que quedó abierta en otra sesión le impide a esa sesión arrancar la siguiente. La designada la cierra
desde su pestaña:

- si la ejecución no está perdida, `marker.js clear-session <sesión>` la cierra sin firma;
- si quedó perdida (le falta el marcador o la copia de su apertura), `marker.js clear-session <sesión> --lost
  --for-session <sesión>` pide la firma `lost-run`. Corre sin ventana si el perfil la delega, y si no, sale la ventana.

La ventana muestra la story y la sesión que se cierran, que son las que nombra el comando. Si `--for-session` nombra
otra sesión, no se pide. `marker.js clear` cierra sólo la ejecución propia: con `--for-session` sale 2.
`marker.js restore <sesión>` rearma la ejecución perdida en la sesión que corre el comando, y firma para ésa.
