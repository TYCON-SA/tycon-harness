# Probar un pipeline sin correrlo — las tres herramientas y qué compra cada una

**Por qué.** Probar un pipeline corriéndolo de verdad es lento: con pull requests en cola y pocos
carriles para toda la organización, cada prueba espera su turno. Hay formas más rápidas, y no hay
que inventarlas: ya existen. Lo que sigue es lo que hay,
medido, con lo que cada cosa **no** cubre — que es la parte que importa.

## La pirámide

| Herramienta | Qué contesta | Tarda | Qué NO cubre |
|---|---|---|---|
| **Vista previa de Azure** | ¿El YAML es válido para Azure? | ~1 s | Las expresiones: una condición mal escrita PASA |
| **Corredor local** | ¿Qué etapa corre y cuál se saltea? | segundos | Servicios externos, artefactos entre corridas, aprobaciones |
| **Casos con respuestas falsas** | ¿La lógica de un guion falla bien? | segundos | El cableado: que el pipeline lo llame de verdad |
| **Corrida real** | Todo lo demás | minutos, en cola | — |

La regla que sale de acá: **una corrida real al final, para confirmar** — no diez para descubrir.

## 1 · Vista previa (`scripts/ci/validate-pipeline-in-ado.sh`)

Azure acepta una "corrida en modo vista previa": toma un YAML —**incluso uno que no está
commiteado**— lo valida y devuelve el YAML final expandido, con identificador de corrida `-1`. No
ejecuta y **no consume uno de los dos carriles**.

Medido, un caso por clase: atrapa YAML mal indentado, clave duplicada, una tarea que no existe, un
`dependsOn` a una etapa inexistente y una plantilla que no está en el repo. Un pipeline de 1200
líneas: **1 segundo**.

🔴 **No atrapa expresiones**: `succeededd()` con dos "d" pasa la vista previa, porque las
expresiones se evalúan en tiempo de ejecución. Esto valida el esqueleto, no la conducta.

## 2 · Corredor local (`Runner.Client`, de la comunidad)

`dotnet tool install --global Runner.Client`, y después:

```bash
Runner.Client --event azpipelines -W azure-pipelines.yml            # sólo evalúa condiciones
Runner.Client --event azpipelines -W azure-pipelines.yml -P ubuntu-latest=-   # ejecuta en tu máquina
```

🔴 **El mapeo para ejecutar en local es `-P ubuntu-latest=-`** (un guion solo), no
`-self-hosted` como en GitHub Actions: medido el 2026-09-04, con `-self-hosted` el agente embebido
arranca pero ningún job lo toma —*"No agent is registered for the requested capabilities:
[self-hosted]"*— y cada job termina `Failed` como si no hubiera agente. Con `-` los pasos corren.

Es [runner.server](https://github.com/ChristopherHX/runner.server), **no oficial** y declarado
experimental sobre "un subconjunto" de Azure Pipelines. El subconjunto incluye justo lo que ninguna
otra herramienta cubría: **evalúa las condiciones y decide qué corre y qué se saltea**, imprimiendo
la evaluación paso por paso.

Medido contra el defecto real del día —un paso que commitea a la rama principal sin exigir que lo
anterior haya salido bien— lo reprodujo exactamente: el paso sin la cláusula **corrió** con la
construcción en rojo, y el que la tiene se salteó. Y corrido contra un pipeline real del equipo,
evaluó las condiciones de etapa con los resultados reales de cada dependencia y encadenó bien los
salteos.

🔴 **Lo que no hace**: sin agente no ejecuta los pasos (sólo evalúa condiciones de etapa y job);
con `-P ubuntu-latest=-` los ejecuta **en tu máquina**, así que todo lo que dependa del entorno del
agente de Azure —artefactos de otra corrida, conexiones de servicio, aprobaciones de entorno— falla
o se saltea. Sirve para la **lógica de corte**, no para el despliegue.

🔴 **Y sin agente sólo llega hasta la primera etapa que tiene pasos** (medido sobre URUTAU,
2026-09-04): un job sin agente que lo ejecute termina `Failed`, y todo lo que depende de él se
saltea **en cascada**. Simulando `main` abrió `TraerArnes` y `Pruebas` y saltó `Build` y `Deploy`
— no porque su condición esté mal, sino porque `Pruebas` "falló". O sea: sin agente verifica las
condiciones de las etapas que no dependen de un éxito previo (qué se abre en PR y qué en `main`);
para una condición de `Deploy` hace falta que las anteriores **terminen bien**, y eso es una copia
del YAML con los pasos vaciados corrida con `-P ubuntu-latest=-`. Esa copia la hace
`scripts/ci/stub-pipeline-steps.js`: conserva etapas, jobs, `dependsOn`, condiciones, el
`name` de cada paso y las variables que publicaba (con valor `true`, o el que se pase con
`--output`), y reemplaza cada paso por un `echo`; con `--fail <regex>` un paso falla a propósito,
para ver que corta lo que tiene que cortar (pruebas en rojo → el `Build` no arma). Medido sobre
los 12 pipelines del equipo la noche del 2026-09-04: la cadena entera de `main`, la de pull request
y la del corte se evalúan en ~35 segundos por escenario, sin tocar Azure. Casos:
`scripts/tests/stub-pipeline-steps.test.sh`.

🔴 **Cada corrida con `-P` deja un `Agent.Listener` huérfano** (medido: 80 procesos después de
36 corridas esa noche; el `Stopped Runner` del final no lo mata). No rompen nada, pero consumen
memoria y polling. Después de una tanda:
`ps -axo pid,ppid,command | grep "Agent.Listener run" | awk '$2==1{print $1}' | xargs kill`.

## 3 · Casos con respuestas falsas

El patrón que ya usa el arnés: se inyecta un `curl` falso por PATH y el guion cree que habla con el
servidor. Así se prueban estados que una corrida real **no puede provocar a voluntad**: una
migración que falla, un retroceso de base de datos, el modo degradado, la activación que se cae a
mitad. Ejemplo completo: `scripts/tests/deploy-plugin.test.sh`, 19 casos, todos de falla.

## Lo que NO existe

No hay simulador oficial de Azure DevOps. GitHub Actions tiene `act`; acá no hay equivalente de
Microsoft. Lo único que acorta la **corrida real** es un agente propio: la organización ya tiene
siete grupos que no son de Microsoft, y un pipeline apuntado a uno de ésos no compite por los dos
carriles compartidos. Eso cambia dónde corren los pipelines del equipo: es una decisión, no una
herramienta.
