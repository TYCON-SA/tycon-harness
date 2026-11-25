# Las integraciones y las guías de quien mantiene

Las fichas de este grupo de [las piezas del arnés](../harness-pieces.md). Cada una dice **qué es** la pieza,
**por qué existe**, **quién la usa** y **dónde se prueba**. El detalle de cada pieza está en
[la guía de detalle](../maintaining/pieces-in-detail.md), bajo el mismo título.

## guides/integrations/ado-queue-and-listings.md

**Qué es:** La guía con el porqué de las seis reglas del bloque de Azure DevOps de cada sesión.

**Por qué existe:** Un listado atrasado, vacío o fallido no es evidencia de lo que no muestra; las acciones con efectos se disparan por evidencia positiva. Explica cada regla con sus comandos.

**Quién la usa:** El agente y el dev cuando actúan sobre colas y corridas de Azure.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesintegrationsado-queue-and-listingsmd)

## guides/integrations/clockify-mcp.md

**Qué es:** La guía para instalar el MCP de la herramienta de horas en Claude Code (opcional).

**Por qué existe:** Permite el seguimiento de horas desde la sesión. Trae los scripts `.sh` y `.ps1` de su integración, instala a nivel de usuario y usa una clave personal por dev.

**Quién la usa:** Cada dev que quiere seguimiento de horas.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesintegrationsclockify-mcpmd)

## guides/integrations/clocki-tracking.md

**Qué es:** La guía del seguimiento automático de horas.

**Por qué existe:** Abre la entrada de tiempo al arrancar trabajo y la cierra al detectar más de 15 minutos de inactividad, con la hora de fin retroactiva. Asocia carpeta y proyecto solo.

**Quién la usa:** La skill de horas y sus hooks, en cada máquina que la instala.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesintegrationsclocki-trackingmd)

## guides/integrations/codegraph-mcp.md

**Qué es:** La guía para instalar CodeGraph como MCP (opcional).

**Por qué existe:** Es un índice del código en una base local para consultar símbolos, llamadores y dependencias sin escanear archivos. Los scripts autodetectan repo suelto o contenedor; un hook de arranque configura cada repo nuevo.

**Quién la usa:** Los agentes de la sesión y cada dev que lo instala.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesintegrationscodegraph-mcpmd)

## guides/signed-scope-guardrails.md

**Qué es:** La guía con cuatro mecanismos contra el corrimiento no autorizado de lo firmado por el cliente.

**Por qué existe:** Sin nada que cruce el plan con lo firmado, un corrimiento de sprint pasa días sin detectarse. Usa el frontmatter `signed_for_sprint`, un registro obligatorio de cambios, el validador VAL-C7 y una auditoría periódica.

**Quién la usa:** Quien arma el plan de sprints, el validador de stories y el advisor de alcance firmado.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidessigned-scope-guardrailsmd)

## guides/integrations/ado-projects.md

**Qué es:** La guía de la integración con Azure DevOps.

**Por qué existe:** Al crear una story se crea sola su work item. Cubre el hook `on-story-create.js`, la skill `tycon-story-work-item`, el esquema de `.tycon/work-items.yaml`, el tipo de work item por plantilla, el vínculo al Epic y el ciclo de vida.

**Quién la usa:** El hook de creación de stories y el dev que configura un repo.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesintegrationsado-projectsmd)

## guides/safety-guard.md

**Qué es:** La guía del freno de mano: un hook que bloquea comandos destructivos irreversibles en Bash y PowerShell.

**Por qué existe:** Frena `rm -rf /`, el push forzado a main, `curl|bash`, el borrado de bases de datos, `npm publish` o leer `.ssh`. Está prendido por defecto; se apaga con `TYCON_SAFETY_GUARD=0` y hay una salida de emergencia por comando, que la persona firma en su terminal.

**Quién la usa:** El hook `PreToolUse` en cada sesión.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidessafety-guardmd)

## guides/maintaining/context-budget.md

**Qué es:** La guía de la auditoría de tokens del arnés.

**Por qué existe:** Un script de Node mide cuántos tokens gasta el arnés (skills, agentes, MCPs, `CLAUDE.md`) al abrir cada sesión, señala los que más pesan y propone recortes ordenados por ahorro.

**Quién la usa:** Quien mantiene el arnés.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesmaintainingcontext-budgetmd)

## guides/maintaining/skill-scout.md

**Qué es:** La guía de la skill que se dispara antes de crear una skill, agente, guía o hook.

**Por qué existe:** Evita capas duplicadas que dividen el conocimiento. Busca en el catálogo local y ofrece tres caminos: usar lo que existe, extenderlo o crear algo nuevo. No busca en GitHub ni en la web.

**Quién la usa:** Quien va a crear una pieza nueva del arnés.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesmaintainingskill-scoutmd)

## guides/maintaining/rules-distill.md

**Qué es:** La guía de la auditoría del catálogo de reglas contra los revisores que las aplican.

**Por qué existe:** Un script de Node determinista detecta cinco clases de desajuste: referencias rotas, huérfanas, zombis, dueño equivocado y reglas aplicadas por hooks. El dueño de cada regla sale de `scripts/lib/rules-catalog.js`.

**Quién la usa:** Quien mantiene el catálogo de reglas.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesmaintainingrules-distillmd)

## guides/maintaining/harness-audit.md

**Qué es:** La guía del chequeo reproducible del arnés.

**Por qué existe:** Puntúa de 0 a 10 siete categorías (cobertura de revisores, eficiencia de contexto, controles de calidad, memoria, integridad del catálogo, guardas de seguridad, cableado del pipeline) y lista las cinco acciones prioritarias. Reemplaza la auditoría manual.

**Quién la usa:** Quien mantiene el arnés.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesmaintainingharness-auditmd)

## guides/integrations/instinct-mining.md

**Qué es:** La guía del grabador silencioso que propone reglas atómicas (instintos).

**Por qué existe:** La integración `integrations/instincts/` (la prende el perfil del equipo) graba de fondo llamadas de herramientas saneadas y avisa una vez qué se graba; la noche propone, filtra el ruido y recomienda en `recomendaciones.json`. El dev aprueba con `/tycon-instincts`. `scripts/instincts/instinct-dirs.js` dice dónde viven las propuestas.

**Quién la usa:** Los hooks de grabación y arranque, y el dev que revisa.

**Dónde se prueba:** `instinct-observe.test.js`, `instinct-dirs.test.js`, `instinct-outside-tree.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesintegrationsinstinct-miningmd)

## guides/harness-cost-tiering.md

**Qué es:** La guía para bajar el costo del pipeline: ejecutor barato para lo mecánico, modelo caro sólo para el juicio.

**Por qué existe:** Reparte el modelo por trabajo: baja un revisor de nivel, `pipeline.js advisors --cost-tier lean` pide Haiku como opción y el orquestador sugiere un esfuerzo de sesión según la complejidad de la story. Cada movimiento se revierte por separado.

**Quién la usa:** El orquestador del pipeline y quien elige el modelo de la sesión.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesharness-cost-tieringmd)
