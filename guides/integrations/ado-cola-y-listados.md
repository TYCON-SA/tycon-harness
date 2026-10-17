# Azure DevOps — por qué el bloque de reglas dice lo que dice

> **Qué es este documento.** El bloque `claude-md-blocks/ado-runs-list-lag.md` se carga **entero,
> en cada sesión, en cada máquina del equipo**. Al 2026-09-06 pesaba **9.979 bytes** —el 27 % del
> `CLAUDE.md`— y casi todo ese peso era **explicación**: cada regla arrastraba su diagnóstico
> completo. Acá vive el porqué de cada regla; en el bloque queda
> la regla. Es la misma poda que se le hizo al bloque de estilo el 2026-09-03
> (`guides/response-style.md`), con el mismo criterio: **más texto normativo nunca fue la
> solución**, y una regla que hay que releer entera cada sesión para aplicar una línea es peso
> que se paga siempre y se usa casi nunca.
>
> **Antes de podar de nuevo, leé esto**: lo que quedó en el bloque quedó a propósito. Si una regla
> te parece redundante, el modo de falla que evita está acá abajo.

---

## 1 · Un listado atrasado no prueba que el run no existe (2026-08-20)

**Qué pasa:** tras un push a `main`, `az pipelines runs list` puede seguir sin mostrar el run del
commit durante más de 4 minutos. **Por qué engaña:** la ausencia se lee como "el trigger no
disparó", y un run manual encolado ahí queda DUPLICADO cuando el listado se refresca y aparece el
run real, corriendo desde el principio.

La forma de confirmar la ausencia, en orden:

1. **El bump delata al run**: si `origin/main` tiene un `chore: bump version ... [skip ci]`
   POSTERIOR al commit propio, un run YA corrió o está corriendo — no encolar nada.
2. **Probar por id**: `az pipelines runs show --id <N>` con los ids siguientes al último run
   conocido — el show por id NO laguea como el list (así aparece el run que el listado no muestra).
3. **La UI del pipeline** ante la duda, o esperar ≥5 min desde el push.

> ⚠️ **Nota de la poda (2026-09-06):** el bloque arrastraba una coletilla sobre la regla propia
> de un repo (forzar el disparo con un commit que toque un `.cs`) que **ya no es
> cierta**: esa regla se **retiró el 2026-09-02** cuando se corrigió el `paths.include` del
> pipeline (verificado: un merge que tocó sólo `tests/` disparó el CI de main).
> La coletilla no viaja al bloque nuevo.

## 2 · `runs list` tampoco muestra lo que está EN COLA (2026-09-04)

**Qué pasa:** después de cancelar despliegues encolados, `az pipelines runs list` proyecto por
proyecto no muestra nada, y la pantalla de **Jobs del grupo de agentes** todavía tiene trabajos
(medido: **17**, dos corriendo y quince esperando, de 13 corridas distintas). **Por qué engaña:**
el listado vacío se lee como **"cola limpia"**, y eso es dar por medido lo que no se midió.

`az pipelines runs list` responde por PROYECTO y con atraso; no es la cola. La cola se le pregunta
al **grupo de agentes**:

```bash
# los trabajos sin terminar del pool compartido (`<id>` = el de "Azure Pipelines" en tu organización)
GET https://dev.azure.com/<org>/_apis/distributedtask/pools/<id>/jobrequests?api-version=7.1
# → los que NO tienen finishTime son los que ocupan o esperan carril; `owner._links.self` lleva
#   a la corrida, y de ahí salen proyecto, rama y quién la pidió.
```

**Y cancelar no vacía la cola al instante:** la corrida pasa a `cancelling` y sus trabajos siguen
listados un rato. Volver a medir antes de afirmar nada.

🔴 Es la misma falla que la regla anterior, del otro lado: allá era *"no lo veo, entonces no
corrió"*; acá es *"no lo veo, entonces no hay nada"*. **Un listado que no cubre lo que estás
afirmando no es evidencia: es no haber mirado.**

## 3 · Cancelar la CORRIDA no saca su trabajo de la cola (2026-09-04)

**Qué pasa:** se cancelan decenas de corridas, todas quedan `completed/canceled`… y la pantalla
de **Jobs del grupo de agentes** sigue mostrando sus trabajos (medido: 20).

**Por qué:** la corrida y su **pedido de trabajo** (`jobrequest`) en el grupo de agentes son dos
objetos distintos. Cancelar la corrida saca el trabajo sólo si ya está asignado a un agente; si
está **esperando agente**, el pedido queda huérfano en la cola y Azure lo limpia recién a los
minutos. Con la cola llena, eso se ve exactamente igual que "no cancelaste nada".

**La forma que sí funciona** — se borra el pedido, no la corrida:

```bash
# 1. los pedidos vivos del pool (los que NO tienen finishTime)
GET  https://dev.azure.com/<org>/_apis/distributedtask/pools/<pool>/jobrequests?api-version=7.1
# 2. cada uno se BORRA por su id (204 = salió). El lockToken viene en el propio pedido; si no
#    tiene, va el nulo 00000000-0000-0000-0000-000000000000
DELETE https://dev.azure.com/<org>/_apis/distributedtask/pools/<pool>/jobrequests/<requestId>?lockToken=<tok>&api-version=7.1
```

`owner.name` del pedido es el número de build y `owner._links.self` lleva a la corrida: de ahí sale
proyecto, rama y quién la pidió, para no borrar lo de otra persona.

🔴 **Y el orden importa**: primero se apaga lo que produce (procesos propios, auto-completar de los
pull requests), después se borran los pedidos, y recién entonces se mira. Al revés es barrer con la
canilla abierta.

## 4 · Un vigilante que RE-ENCOLA es una fábrica de corridas (2026-09-04)

**Qué pasa:** un vigilante de fondo que, al ver la política de un pull request `rejected` o
`queued` con su build ya terminado, la **vuelve a encolar** —pensado para destrabar la política
que se cuelga— no distingue ese caso de una validación que falla de verdad. Si un servicio
externo está degradado (por ejemplo, el registro de avisos de npm), las validaciones fallan, el
vigilante las re-encola, vuelven a fallar y se re-encolan otra vez, en varios repos a la vez.
**Por qué engaña:** quien cancela corridas a mano no sospecha de **sus propios procesos, que las
crean de nuevo**, y cree que la cola está controlada. La señal: varias corridas del mismo pipeline
sobre el MISMO commit de merge.

De ahí salen las tres reglas del bloque:

1. **Un vigilante AVISA; no re-encola solo.** Re-encolar es una acción con efectos —crea una
   corrida, ocupa un carril, puede desembocar en un merge— y ésas no las toma un lazo cada dos
   minutos. Ante una política trabada, el vigilante dice *"el pull request N está trabado hace X:
   su control apunta al build B, que terminó bien hace Y"*, y decide una persona. Es el mismo
   criterio que la revisión nocturna de dependencias, que abre un pull request para que alguien
   decida en vez de arreglar sola.
   Si aun así alguien cablea el re-encolado, va con techo y con motivo: **una sola vez por
   evaluación**, y **sólo** cuando el build al que apunta la política terminó BIEN (el caso de la
   política colgada). Si el build **falló**, jamás: falló por algo, y repetirlo sin leer por qué es
   amplificar la caída, no destrabarla.
2. **Antes de cancelar nada, apagar lo que produce.**
3. **Todo proceso de fondo que uno deja corriendo es parte del sistema.** Antes de afirmar por qué
   pasa algo, `ps aux` de lo propio. La causa puede ser uno mismo.

🔴 El criterio es el mismo que pone un **presupuesto de tiempo** al reintento de un guion: *un
reintento tiene que ayudar con un tropiezo, no amplificar una caída*. Vale para el guion y para
quien lo opera. **Una regla que se escribe
para el código y no se aplica a la propia conducta no está aprendida.**

## 5 · El vacío puede ser un comando que FALLÓ (2026-09-04)

**Qué pasa:** un `az` **falla** (por ejemplo: el proyecto no se llama `Acme`, se llama
`Acme Logistica`), el error se lo come el `| sed` del final y la salida queda vacía — idéntica a
"no hay ninguno". **Por qué engaña:** se afirma *"ese repo no tiene pull request abierto"* sin
haber podido preguntar, y se da por cerrado un trabajo que tenía un pull request abierto sin ver.

Es el mismo defecto que un listado vacío de carpetas leído como "no hay nada" (con el error tapado
por `2>/dev/null`), una capa más arriba. Desde el 2026-09-06 hay además un
control que lo mira solo: `scripts/hooks/failed-query-notice.js` avisa cuando una consulta a un
servicio devolvió vacío con el código de salida enmascarado, y cuando el `--project` de un `az` no
existe en la organización.

## 6 · `succeeded` habla de STAGING, no de PROD (2026-08-28)

En los pipelines del equipo el deploy a PROD va detrás de una aprobación manual que se toca
DESPUÉS de validar en staging — es el flujo normal, no una excepción. Si nadie la aprueba,
expira (24h), ADO marca el stage `skipped` SIN fallar el build, y el resultado global queda
`succeeded` habiendo desplegado solo staging. Medido: dos builds del mismo pipeline, uno
`canceled` y otro `succeeded` — mismo hecho de fondo, ninguno llegó a prod.

```bash
az devops invoke --area build --resource timeline \
  --route-parameters project=<proj> buildId=<N> --api-version 7.1 -o json
# → records con type=='Stage': listá los nombres y decidí por el/los stage(s) de despliegue a
#   producción REALES del pipeline — nunca por substring 'PROD' a secas (matchea NONPROD/PREPROD
#   y pierde 'Production'). Desplegado ⟺ ESE stage con result=='succeeded'; skipped/ausente = no.
```

Un `skipped` ahí = quedó en staging (lo esperable hasta que alguien apruebe), no "falló".

---

## Lo que las seis tienen en común

**Una acción con efectos —encolar un run, commitear un trigger, reintentar, avisarle a un
cliente— no se dispara por lo que un listado NO muestra: se dispara por evidencia positiva del
estado real.** Un listado vacío, viejo, de otro alcance o de un comando que falló es *"no sé"*,
nunca *"no existe"*.
