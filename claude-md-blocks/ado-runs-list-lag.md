<!-- requires-integration: ado -->
# ===================================================
# REGLA ADO — un listado no es evidencia de lo que no muestra
# ===================================================

**Principio único, del que salen las seis reglas de abajo: una acción con efectos —encolar un run,
commitear un trigger, reintentar, avisarle a un cliente que ya está en producción— NO se dispara
por lo que un listado no muestra. Se dispara por evidencia positiva del estado real.** Un listado
vacío, viejo, de otro alcance, o de un comando que falló, es *"no sé"*, nunca *"no existe"*.

Los seis casos reales que motivaron cada regla —con fechas, capturas y el diagnóstico completo—
viven en `~/.claude/tycon-harness/guides/ado-cola-y-listados.md`. Acá queda sólo la regla.

## 1. `runs list` está atrasado: la ausencia no prueba que el trigger no disparó

Antes de encolar un run manual (o meter un trigger commit), confirmar por evidencia directa:
(a) un `chore: bump version ... [skip ci]` posterior al commit propio ⇒ el run YA corrió, no
encolar nada; (b) `az pipelines runs show --id <N>` con los ids siguientes al último conocido —
el show por id NO laguea como el list; (c) la UI, o esperar ≥5 min desde el push.

## 2. `runs list` tampoco ES la cola — la cola vive en el grupo de agentes

Responde por PROYECTO y con atraso. Para saber qué corre o espera en la organización:

```bash
GET https://dev.azure.com/<org>/_apis/distributedtask/pools/<pool>/jobrequests?api-version=7.1
# los que NO tienen finishTime ocupan o esperan carril; owner._links.self lleva a la corrida
# (de ahí salen proyecto, rama y quién la pidió). <pool>: "Azure Pipelines" de tu org.
```

## 3. Cancelar la CORRIDA no saca su trabajo de la cola

La corrida y su **pedido de trabajo** son objetos distintos: si el pedido está esperando agente,
queda huérfano y Azure lo limpia recién a los minutos — se ve igual que "no cancelaste nada". Se
borra el pedido, no la corrida:

```bash
DELETE .../pools/<pool>/jobrequests/<requestId>?lockToken=<tok>&api-version=7.1   # 204 = salió
# lockToken viene en el propio pedido; si no tiene, va 00000000-0000-0000-0000-000000000000
```

🔴 **El orden importa**: primero se apaga lo que produce (procesos propios, auto-completar de los
pull requests), después se borran los pedidos, y recién entonces se mira. Al revés es barrer con la
canilla abierta. Y `owner.name` dice de quién es cada pedido: no borrar lo de otra persona.

## 4. Un vigilante AVISA; no re-encola solo

Re-encolar crea una corrida, ocupa un carril y puede terminar en un merge: eso no lo decide un lazo
cada dos minutos. El vigilante dice *"el PR N está trabado hace X, su control apunta al build B que
terminó bien hace Y"* y decide una persona. Si aun así se cablea: **una sola vez por evaluación**, y
**sólo** si el build terminó BIEN. Si falló, jamás — repetirlo sin leer por qué amplifica la caída.

Y **todo proceso de fondo propio es parte del sistema**: antes de explicar por qué pasa algo,
`ps aux` de lo propio. La causa puede ser uno mismo.

## 5. Una salida vacía puede ser un comando que FALLÓ

Mirá el código de salida ANTES de cualquier pipe (`rc=$?` o `set -o pipefail`). Nunca tapes el
error: `2>/dev/null`, `| sed`, `|| echo "ninguno"` convierten *"no pude preguntar"* en *"pregunté y
no hay"* — la mentira más barata de producir y la más cara de detectar. (Ojo con los nombres de
proyecto: no siempre es la sigla del producto; el exacto está en `ado_project` de `.tycon/ado-config.yaml`.)

## 6. `succeeded` habla de STAGING, no de PROD

PROD va detrás de una aprobación manual; si nadie la toca, expira, el stage queda `skipped` y el
build global igual dice `succeeded`. **Antes de decir "ya está en producción", mirar los stages del
timeline**, todos los de despliegue a producción del pipeline (puede haber más de uno):

```bash
az devops invoke --area build --resource timeline \
  --route-parameters project=<proj> buildId=<N> --api-version 7.1 -o json
# records con type=='Stage'. Desplegado ⟺ ESE stage con result=='succeeded'; skipped/ausente = no.
# Nunca por substring 'PROD': matchea NONPROD/PREPROD y pierde 'Production'.
```
