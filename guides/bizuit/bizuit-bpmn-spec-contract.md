# Specs de proceso BIZUIT BPMN — el contrato, y por qué no alcanza con conocerlo

Guía corta y con un solo mensaje: **cuando un agente escribe la spec de un proceso BPMN de BIZUIT, la
escribe con la tool del producto (`write_spec`), no con el editor de archivos.** Todo lo demás de esta
guía existe para explicar por qué eso no es una formalidad.

Aplica a cualquier agente que produzca esa spec — BMAD, un pipeline, un script, o vos a mano. No
aplica a las stories Mary+GOLD, que son otro artefacto y tienen su propio formato
(`story-format.md`).

---

## 1. El formato vive en el producto, no acá

La plantilla canónica es `mcp/skill/templates/spec-template.md` del repo del modelador de procesos (un repo del equipo), y se empaqueta
con el producto. **Esta guía no la copia a propósito**: dos copias del mismo formato se despegan al
primer cambio, y la que quede vieja va a hacer que un agente escriba specs que el producto rechaza sin
que nadie entienda por qué.

Si necesitás el formato, sale de ahí. Si el producto lo cambia, el cambio llega solo.

## 2. Lo que hay que saber del formato, en dos líneas

La spec tiene dos secciones que el producto **verifica mecánicamente** contra el proceso generado:

- `## Flujo del proceso` — los pasos, numerados (`1.`, `2.`, `4a.`…).
- `## Reglas del negocio` — una tabla: qué dice la regla, de qué **tipo** es (plazo, umbral, tope,
  requisito, derivación, cálculo, catálogo, tabla, ventana, acumulación), cuánto **vale**, y su
  **estado** (`confirmado` / `no relevado` / `no definido`).

Del tipo sale la forma que el proceso tiene que tener: un `plazo` exige un temporizador con ese
número, un `requisito` exige una condición. Eso es lo que se verifica — no un parecido de palabras.

## 3. 🔴 Por qué escribir el archivo directo es peor que escribirlo mal

Escribir el `.md` con el editor de archivos **no produce un error**. Produce silencio, que es peor:

| si el documento… | qué pasa |
|---|---|
| se escribe con `write_spec` y la tabla está mal | **te frena y te dice qué corregir** |
| se escribe con el editor y la tabla está mal | se escribe igual |
| se escribe con el editor y **no tiene tabla** | el control de reglas no dice nada — «0 hallazgos» |

Ese último caso es el peligroso: «0 hallazgos» se lee como «salió limpio», y significa «no había nada
que revisar». Un plazo de 48 horas que la persona mencionó al pasar desaparece, el proceso valida en
verde y nadie se entera hasta que el circuito real hace algo que nadie modeló.

## 4. No hace falta conocer el formato — hace falta entrar por la puerta

Éste es el punto que ahorra trabajo: **el control enseña**. `write_spec` rechaza con el motivo y la
corrección concreta, y el agente corrige y reintenta. Está medido: el 2026-08-01, un generador que no
sabía que tenía que etiquetar los pasos fue rechazado, leyó el motivo, corrigió y publicó — sin que
nadie le explicara el formato antes.

O sea: la obligación no es *documentar el formato en todos lados*. Es **usar la tool**.

## 5. La lección que hace que esto valga una guía

El 2026-08-01, en el mismo día, el mismo error apareció **tres veces** en tres lugares distintos:

1. El banco de evaluación corría sin darle las tools del producto al elicitador → `write_spec` tuvo
   **0 llamadas en 203 invocaciones**. El freno existía y no podía correr.
2. El paso del revisor externo estaba declarado «prendido por default» en la doctrina y era opt-in en
   el arnés → las cuatro corridas del día midieron el brazo peor.
3. Un agente cualquiera que escriba la spec por su cuenta saltea todos los controles sin recibir un
   solo error.

Los tres son el mismo patrón, y por eso conviene tenerlo escrito:

> **Un control que hay que acordarse de invocar es un control que no corre.**

La contramedida no es más documentación: es que el camino por default pase por el control. Cuando eso
no se puede (un agente externo que no controlamos), la contramedida mínima es que **el silencio no se
pueda confundir con un visto bueno** — que el producto avise «este documento no trae tabla de reglas,
así que no verifiqué ninguna» en vez de devolver cero hallazgos.

---

## Cuándo leer esto

- Vas a hacer que un agente, pipeline o script produzca la spec de un proceso BPMN de BIZUIT.
- Estás debuggeando por qué un proceso «pasó todos los controles» y aun así le faltaban reglas.
- Vas a integrar la generación de procesos BIZUIT con cualquier herramienta de afuera.

## Referencia

- Plantilla y doctrina: `mcp/skill/` de ese repo (`templates/spec-template.md`,
  `workflows/create/elicitation.md`, `workflows/create/generation.md`).
- El recorrido completo, con el caso real de punta a punta:
  `mcp/docs/cadena-de-custodia.html` (mismo repo).
