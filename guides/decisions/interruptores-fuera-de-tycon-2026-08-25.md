---
estado: HECHO 2026-08-25 — barrido, 2 reproducciones, 2 arreglos cableados
origen: §5.3 del plan de controles apagables ("el hueco más grande que queda")
---

# Los interruptores de los hooks fuera de `.tycon/` — barrido del 2026-08-25

El plan de controles apagables cerró la familia `.tycon/advisors.yaml` y dejó escrito su punto
ciego: *"los hooks fuera de esa familia — el freno de comandos destructivos, los medidores, el
tracking de horas, el sync de memoria — no se probó si su propia configuración los apaga. Es el
hueco más grande que queda."* Esto es ese barrido.

## El censo

~40 variables `TYCON_*` gobiernan los hooks (censo mecánico por grep sobre los dos repos del
arnés). Se clasifican en cuatro familias, y la pregunta para cada una es la misma del plan:
**¿se puede apagar en silencio, sin dejar rastro?**

| Familia | Ejemplos | Veredicto |
|---|---|---|
| **Kill-switches por env** | `TYCON_SAFETY_GUARD=0`, `TYCON_RESPONSE_METER=0`, `TYCON_RETRO_PENDING=0`, `TYCON_UNPUSHED_NOTICE=0` (2026-08-25 — apaga SOLO los avisos ambientales; el modo `--scan` que usa el preflight del merge lo ignora a propósito, para que callar el reminder no apague el control del HITL) | Por diseño son la escotilla del DEV: por sesión, a la vista en el comando, sin persistencia. **El agujero no era el interruptor sino PERSISTIRLO** — ver reproducción 1 |
| **Sellos diarios** (`*-last-run`) | `bash-tests-last-run`, `controls-bench-last-run` | Estado local que la suite confía sin verificar quién lo escribió — ver reproducción 2 |
| **Opt-in por archivo** | `.engram-project` (sync de memoria), `TYCON_INSTINCT_MINING=1` | Su AUSENCIA es el default documentado, no un apagado silencioso: no son este patrón |
| **El registro de hooks** (`settings.json`) | borrar la entrada de un hook | **Auto-sanado**: `install-tycon-hooks.sh` lo re-instala en cada arranque. Su propio kill (`TYCON_NO_AUTOINSTALL=1`) cae en la familia 1 |

## Reproducción 1 — persistir el apagado en el rc del shell 🔴 ARREGLADO

Mandar un `export` de `TYCON_SAFETY_GUARD=0` al final de `~/.zshrc` **pasaba sin un solo aviso**.
Con eso el freno de mano queda apagado para TODAS las sesiones futuras, sin rastro y sin
vencimiento — y lo mismo con `TYCON_NO_AUTOINSTALL=1`, que apaga al instalador que re-sana a los
demás: el kill-switch de los kill-switches. Es el patrón C1 de la auditoría original
(`.tycon/advisors.yaml`), un piso más abajo: los interruptores viven en un archivo que nada
vigila y que el agente puede escribir.

**Arreglo: regla `HARNESS-C1` del safety-guard.** Bloquea la escritura al rc cuando las TRES
piezas están juntas: variable `TYCON_*` + valor de apagado + el rc como **destino** de la
escritura. Editar el rc para cualquier otra cosa sigue libre (alias, opt-ins como
`TYCON_CODEX=1`, lecturas). Si el dev quiere un apagado permanente, lo escribe él a mano — el
agente no persiste apagados.

Dos gajes del propio arreglo, que quedan de lección:

- **La regla se bloqueó a sí misma tres veces en sus primeros diez minutos**: la primera versión
  matcheaba las piezas sueltas en el TEXTO del comando, y frenó la escritura de su propio archivo
  de casos (que trae el comando de ataque como dato), su propia edición por Bash, y hasta esta
  guía. El ajuste: el rc tiene que ser el **destino** (redirección/`tee`/`sed -i` pegados al
  path), no una mención. Residual asumido: un heredoc cuyo contenido incluya el par
  redirección-más-rc literal sigue matcheando — raro; para escribir ESE contenido va la tool de
  escritura (que no pasa por este freno), y el override por comando queda auditado.
- **Regla nueva = falsos positivos nuevos**: se probó en las dos direcciones con 7 comandos antes
  de darla por buena (3 bloquean, 4 pasan — alias, opt-in, mención-sin-destino, lectura).

## Reproducción 2 — sellar la suite diaria a mano 🔴 ARREGLADO

Escribir la fecha de hoy en `~/.claude/.tycon-pipeline/bash-tests-last-run` **saltea la tanda
diaria del día sin error y sin rastro**: el instalador ve el sello de hoy y no corre nada.
Repetido cada día, las suites no corren nunca más y todo se ve normal.

**Arreglo: detección de sello-sin-reporte en `bench-notice.js`.** Usa lo que el flujo legítimo YA
produce: el job escribe SIEMPRE su reporte en `.bench/` **antes** del sello, así que un sello de
hoy con reporte viejo (o sin reporte) no salió del job — y se grita al arranque, por el mismo
canal donde ya se cobran los rojos del banco. No bloquea nada; dice exactamente qué borrar para
que la suite corra. Cubre los dos sellos con reporte (`bash-tests`, `controls-bench`); los sellos
sin reporte propio (`matrix`, `backfill`) quedan fuera y anotados acá — agregarles detección
requiere que sus jobs escriban reporte primero.

## Lo que se decidió NO tocar, con el motivo

- **Los kill-switches por env, como mecanismo**: son la escotilla del dev y está bien que existan.
  Lo que se cerró es su persistencia silenciosa, no su uso por sesión.
- **`TYCON_SAFETY_OFF=1 <cmd>`** (override por comando): ya deja constancia en `safety-guard.log`
  y el banco lo asserta — auditado desde antes de este barrido.
- **La config de clocki** (`settings.json → idleTimeoutMinutes`): alcance de facturación, no de
  integridad del código; un valor absurdo se nota en el tablero de horas. Aceptado documentado.
- **Los `.engram-project` ausentes**: opt-in por diseño, y el chequeo de deriva de engram ya avisa
  cuando un repo con memoria no tiene pin.

## Casos en el banco

`cases/hooks/22-arnes-no-se-apaga-solo.json` — 8 casos (5 de HARNESS-C1 con sus dos direcciones,
3 de la detección de sellos), cada uno verificado en ROJO desconectando su control. 🔴 Ese archivo
—y esta guía— contienen los comandos de ataque como dato: editarlos por heredoc de Bash dispara
HARNESS-C1 (el residual documentado) — usar la tool de escritura.
