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
2026-10-26). Un escape se firma en la propia sesión o corriendo el comando en tu terminal, donde no hay freno.

| Firma | Qué aprueba | Comando que la pide | ¿Desde otra sesión? | Firmarla en la terminal |
|---|---|---|---|---|
| `plan-approval` | aprobar el plan de una story | `marker.js complete-step approve-plan --approved` | sí | `marker.js complete-step approve-plan --terminal` |
| `extra-round` | una vuelta más de revisores | `pipeline.js smart-reloop --extra-round` | sí | `pipeline.js smart-reloop --extra-round --terminal` |
| `refresh-after-main` | refirmar los controles tras traer main, sin cambio propio | `run-base-controls.sh approve` | sí | `run-base-controls.sh approve --terminal` |
| `control-change` | aprobar un cambio de los controles del repo | `run-base-controls.sh approve` | sí | `run-base-controls.sh approve --terminal` |
| `critical-waiver` | eximir un hallazgo crítico de los revisores | `marker.js waive-critical` | sí | `marker.js waive-critical --terminal` |
| `runtime-waiver` | aceptar un criterio imposible de probar en vivo | `marker.js runtime-waiver` | no, por la terminal | `marker.js runtime-waiver` |
| `manual-test` | marcar un criterio como probado a mano | `marker.js mark-tested --acs` | sí | `marker.js mark-tested --acs --terminal` |
| `browser-test` | preparar la prueba con navegador, o decirle que no | `e2e-setup.js prepare --ok (o decline --ok)` | sí | `e2e-setup.js prepare --terminal (o decline --terminal)` |
| `lost-run` | dar por perdida una ejecución y cerrarla | `marker.js clear-session --lost` | sí | `marker.js clear-session --lost --terminal` |
| `adversarial-skip` | saltear el pase adversarial con constancia | `marker.js sign-adversarial-skip (todavía no existe)` | todavía sin comando | — |
| `escape:TYCON_SAFETY_OFF` | apagar el freno de seguridad para un comando | `TYCON_SAFETY_OFF=1 <comando>` | no, por la terminal | `TYCON_SAFETY_OFF=1 <comando>` |
| `escape:TYCON_PROD_LINT` | apagar el control de consultas a producción para un comando | `TYCON_PROD_LINT=0 <comando>` | no, por la terminal | `TYCON_PROD_LINT=0 <comando>` |
| `escape:TYCON_NEW_NAMES` | apagar el control de nombres nuevos en lo que se publica | `TYCON_NEW_NAMES=0 <comando>` | no, por la terminal | `TYCON_NEW_NAMES=0 <comando>` |
| `escape:TYCON_TEST_GATE` | saltear el portón de pruebas del commit | `TYCON_TEST_GATE=1 <comando>` | no, por la terminal | `TYCON_TEST_GATE=1 <comando>` |
| `escape:DOD_BYPASS` | saltear los controles del commit (queda anotado) | `DOD_BYPASS=1 <comando>` | no, por la terminal | `DOD_BYPASS=1 <comando>` |
| `escape:TYCON_NO_DEEP_REVIEW` | apagar el pase adversarial de una ejecución | `TYCON_NO_DEEP_REVIEW=1 <comando>` | no, por la terminal | `TYCON_NO_DEEP_REVIEW=1 <comando>` |
| `escape:TYCON_STATUS_GATE` | cambiar a mano el estado de una story | `TYCON_STATUS_GATE=off <comando>` | no, por la terminal | `TYCON_STATUS_GATE=off <comando>` |
| `escape:story-skill-bypass` | usar una skill de stories fuera del pipeline | `invocar una skill de stories fuera del pipeline` | no, por la terminal | `correr el mismo comando en tu terminal` |
| `escape:set-autonomous` | cambiar el modo autónomo de una ejecución | `marker.js set-autonomous` | no, por la terminal | `correr el mismo comando en tu terminal` |
| `escape:cerrar-la-ejecucion` | cerrar una ejecución con un control en rojo | `marker.js clear` | no, por la terminal | `correr el mismo comando en tu terminal` |
| `escape:cerrar-como-deuda` | cerrar una ejecución dejando lo que falta como deuda | `marker.js close-as-debt` | no, por la terminal | `correr el mismo comando en tu terminal` |
| `escape:force-manual` | marcar a mano en verde la prueba de pantalla | `marker.js set-check dod green --force-manual` | no, por la terminal | `correr el mismo comando en tu terminal` |
| `escape:trust-ran` | contar los revisores sin la constancia de que corrieron | `pipeline.js check-count --trust-ran` | no, por la terminal | `correr el mismo comando en tu terminal` |
| `escape:ALLOW_DOD_EVIDENCE_WRITE` | escribir a mano la evidencia de la prueba en vivo | `escribir el archivo de evidencia de la prueba en vivo` | no, por la terminal | `correr el mismo comando en tu terminal` |
| `escape:dod_runtime_exempt` | eximir una story de la prueba en vivo | `poner dod_runtime_exempt: true en una story` | no, por la terminal | `correr el mismo comando en tu terminal` |
| `escape:no-deep-review` | saltear el pase adversarial de una ejecución | `pipeline.js start --no-deep-review` | no, por la terminal | `correr el mismo comando en tu terminal` |
| `escape:cambiar-el-estado` | cambiar a mano el estado de una story | `marker.js update-story-status` | no, por la terminal | `correr el mismo comando en tu terminal` |

## Los grupos de la 8.116

Antes de este catálogo, `approvals.delegated_signing` aceptaba estos once nombres, y los sigue aceptando. Cada uno
vale por las firmas de su fila. `off` no es un grupo: quiere decir «ninguna». Un grupo cuya firma todavía no tiene
comando (`adversarial-skip`) es válido, pero no habilita nada.

| Grupo | Firmas |
|---|---|
| `refresh-after-main` | `refresh-after-main` |
| `adversarial-skip` | `adversarial-skip` |
| `critical-waiver` | `critical-waiver` |
| `escape-phrases` | `escape:TYCON_SAFETY_OFF`, `escape:TYCON_PROD_LINT`, `escape:TYCON_NEW_NAMES`, `escape:TYCON_TEST_GATE`, `escape:DOD_BYPASS`, `escape:TYCON_NO_DEEP_REVIEW`, `escape:TYCON_STATUS_GATE`, `escape:story-skill-bypass`, `escape:set-autonomous`, `escape:cerrar-la-ejecucion`, `escape:cerrar-como-deuda`, `escape:force-manual`, `escape:trust-ran`, `escape:ALLOW_DOD_EVIDENCE_WRITE`, `escape:dod_runtime_exempt`, `escape:no-deep-review`, `escape:cambiar-el-estado` |
| `plan-approval` | `plan-approval` |
| `browser-test` | `browser-test` |
| `runtime-waiver` | `runtime-waiver` |
| `manual-test` | `manual-test` |
| `extra-round` | `extra-round` |
| `control-change` | `control-change` |
| `lost-run` | `lost-run` |

## Lo delegado no está protegido

La sesión de la coordinadora es un agente. Si decide aprobar una firma delegada por su cuenta,
el arnés no lo distingue de un ok del dueño. Por eso a la lista de delegadas sólo va lo de bajo riesgo: aprobar planes, la vuelta extra de revisores y refirmar los
controles tras traer `main`.

Tocar un freno es sólo del dueño: aprobar un cambio de los controles, los escapes que apagan un freno (salvo los dos de
abajo), eximir pruebas o un crítico, aceptar un criterio imposible de probar y saltear el pase adversarial.

## Aprobar en nombre del dueño

Tres firmas las puede aprobar la sesión designada en nombre del dueño: `escape:force-manual`, `escape:trust-ran` y
`extra-round`. Hace falta todo esto:

- el perfil del equipo las pone en `approvals.delegated_signing` y no en `approvals.owner_only`;
- el dueño escribe a mano «aprobá force-manual», «aprobá trust-ran» o «aprobá una vuelta más» en el chat de la sesión
  designada. Lo pegado, lo que llega de otra sesión o de una herramienta no cuenta, y «aprobá todo» no nombra ninguna
  firma;
- después, la sesión designada le manda a la sesión que trabaja un mensaje que aprueba esa firma («apruebo
  force-manual»), dentro de los 30 minutos del pedido del dueño.

Cada «aprobá» del dueño sirve para una sola firma, y su uso queda anotado. Para la vuelta extra, el pedido del dueño
tiene que ser posterior al aviso del tope, y la sesión que trabaja corre `pipeline.js smart-reloop --extra-round
--delegated`. Para los dos escapes no hay comando aparte: el freno lo busca solo.
