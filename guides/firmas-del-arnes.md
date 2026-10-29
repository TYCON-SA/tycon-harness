# Las firmas del dueño

Algunos pasos del arnés no los puede aprobar el agente que trabaja: los firma una persona. Esta guía lista todas esas
firmas, con el nombre que lleva cada una en el perfil del equipo. Sirve para decidir dos cosas del perfil:

- `approvals.delegated_signing`: qué firmas puede dar sola la sesión designada (la coordinadora), sin preguntarle al
  dueño.
- `approvals.owner_only`: qué firmas son sólo del dueño. Una firma no puede estar en las dos listas: si lo está, la
  lista de delegadas se lee rota y no delega nada.

Las dos listas se escriben sólo en el perfil del equipo: ni el archivo de la máquina ni una variable las cambian. La
lista sale de `scripts/lib/signatures.js`, y una prueba verifica que esta tabla diga lo mismo.

## Las firmas

La columna «¿Desde otra sesión?» dice si el comando se puede correr desde la pestaña de otra sesión (medido el
2026-10-26). Un escape se firma en la propia sesión o corriendo el comando en tu terminal, donde no hay freno. Dos
escapes, `escape:force-manual` y `escape:trust-ran`, los pide su guion en su forma exacta, como las firmas de guion:
desde otra sesión van con `--for-session <D>`.

En Windows la terminal no se lee: cada comando de la columna «Firmarla en la terminal» abre una ventana nueva con el
mismo comando, y ahí firmás escribiendo tres palabras al azar. La ventana vence a los 5 minutos sin firmar nada.

| Firma | Qué aprueba | Comando que la pide | ¿Desde otra sesión? | Firmarla en la terminal |
|---|---|---|---|---|
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

## Los grupos de la 8.116

Antes de este catálogo, `approvals.delegated_signing` aceptaba estos once nombres, y los sigue aceptando. Cada uno
vale por las firmas de su fila. `off` no es un grupo: quiere decir «ninguna». `adversarial-skip` es válido, pero no
delega nada: saltear el pase lo firma sólo el dueño.

`escape-phrases` no trae `escape:force-manual` ni `escape:trust-ran`: esas dos se piden con su propio guion, también
para otra sesión, y se delegan sólo nombrándolas. `approvals.owner_only` no acepta grupos: cada firma que el dueño se
reserva va por su id.

| Grupo | Firmas |
|---|---|
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

## Lo que la ventana no ve

El freno niega la ventana si la herramienta la lanzó una consola u otra herramienta, y el comando de firma se firma
entonces en la terminal. Hay un caso que no ve: una herramienta que el agente abre dentro de `tmux` y a la que le manda
teclas puede contestar su propia ventana. El servidor de `tmux` no tiene padre, y desde los procesos de la máquina no se
distingue un `tmux` de la persona de uno del agente.

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
