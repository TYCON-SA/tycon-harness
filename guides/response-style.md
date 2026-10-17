# Estilo de respuesta — ejecutivo primero (el porqué del bloque)

> **Regla de oro** (la que se obedece sin leer esto — vive siempre cargada en `~/.claude/CLAUDE.md`,
> bloque `TYCON_BLOCK:response-style`, fuente `claude-md-blocks/response-style.md`): la conclusión
> primero, en castellano llano, con el detalle guardado en un archivo y OFRECIDO en vez de volcado — y
> lo mismo para lo que devuelve un subagente. Esta guía es el **por qué**: qué cierra cada parte de la
> regla, cómo se mide, y qué dice el bloque a
> propósito aunque parezca redundante. Se lee cuando hay que tocar la regla, el medidor o el formato de
> reporte de un agente — no en cada sesión. Dentro del bloque todo esto pesaba 17.034 bytes, el 36% del
> CLAUDE.md que se carga en cada sesión; con el porqué acá, el bloque pesa 6.270.

## 1. El problema

Las respuestas venían demasiado verbosas y técnicas. El detalle no sobra por existir — sobra por estar
ARRIBA, enterrando la conclusión. La regla no es "escribí menos": es **"poné la conclusión primero y el
detalle a pedido"**. Y quien lee es un **ejecutivo**: no quiere el cómo, quiere qué pasó, qué falta y qué
decide él. Un mensaje técnicamente impecable que el lector no puede usar para decidir es un mensaje
fallido — no es una preferencia de formato, es el requisito.

## 2. Qué cierra cada parte de la regla

Cada parte existe porque sin ella la regla se cumple en la letra y falla igual. Se lista para que nadie vuelva a
"descubrir" la falta que cada una cierra:

| Parte | Qué falla sin ella | Qué dice |
|---|---|---|
| Conclusión primero | Una regla que cubre sólo los mensajes que PIDEN una decisión deja afuera el cierre de una corrida, que sale como volcado técnico | "Conclusión primero, detalle a pedido", en todo mensaje y en el cierre del pipeline |
| Castellano llano | "Conclusión primero" no dice CON QUÉ PALABRAS ni EN CUÁNTAS LÍNEAS: se puede escribir un muro perfectamente ordenado que igual no se entiende | Nada sin traducir, tope ~10 líneas, sin `##` para una pregunta puntual, una decisión por vez, opciones descritas por lo que pasa |
| Avisos de progreso | Leída como si aplicara sólo DENTRO de un mensaje y no ENTRE mensajes: con 16 subagentes sale un aviso por cada uno; ninguno largo, todos juntos un muro | Cada aviso es una respuesta; se agrupa por tanda; se ofrece el detalle |
| El detalle tiene destino | Decir QUÉ NO HACER no alcanza: cuando una tarea produce material, el chat es el único lugar adonde puede ir, así que va | El detalle tiene un destino OBLIGATORIO (archivo ANTES de la respuesta) + el medidor `response-style-meter.js` |
| El reporte de un subagente | "Mis respuestas" se lee como sólo del agente principal; el volcado se acumula en los reportes de los subagentes (40 renglones con rule IDs, sin una línea que diga qué pasó) | El reporte de un subagente también es una respuesta: 1-3 bullets + acción + detalle aparte; deberes del orquestador |
| Sin alternativa | "Detalle abajo bajo `### Detalle`, **o** directamente ofrecido": esa "o" es la fuga; se cumple la letra y se pegan 30 renglones igual | El detalle va a un archivo y el reporte devuelve la ruta. Y mirar `tools:` antes de pedir el archivo |
| Quién lee | Con la regla escrita y el medidor activo, se incumple igual. El patrón no es olvidarse: es ABANDONARLA apenas hay material técnico interesante que contar | "Quién lee esto: un ejecutivo" + la regla madre (§3) |

## 3. La regla madre (gobierna todo lo demás)

**Toda comunicación del modelo hacia una persona —en cualquier canal— se escribe para que esa persona
ENTIENDA y pueda DECIDIR, no para demostrar el trabajo hecho.**

1. **Conclusión primero**, en palabras de negocio: qué pasó / qué se está haciendo / qué sigue.
2. **Cero tecnicismos sin traducir** la primera vez que aparecen.
3. **El detalle nunca viaja solo**: queda guardado en un archivo y se entrega únicamente si la persona
   lo pide.
4. **Toda pregunta lleva contexto claro + pregunta clarita**, y una decisión por vez — si el lector no
   puede decidir con lo que le mandaste, el mensaje falló.

**Alcance**: toda superficie donde el modelo emite texto que una persona va a leer — el chat, los
reportes de advisors y subagentes, los checkpoints y cierres del pipeline, los avisos de tareas de fondo,
los mensajes por Telegram. Si la regla de un skill choca con esta, gana esta (excepciones: el mensaje de
commit y los artefactos que el dev tiene que leer enteros para aprobar).

**La forma que funciona** para contar estado: una **tabla de estado** (`cosa | Hecho / Corriendo / No`) y
dos líneas de cierre. Lo prohibido salvo pedido explícito: explicar el **cómo** (causas raíz, nombres
de archivo, rule IDs, el razonamiento del hallazgo) · repetir *"te aviso cuando…"* (si algo corre se dice
una vez, en una línea) · contar lo que se investigó, lo que se descartó, o por qué algo salió como salió.

**Plantilla de avance** (la forma preferida de contar estado de cualquier trabajo): (1) **qué se está
haciendo** — como se lo contaría al dueño del producto; (2) **qué resultado esperamos / dio** — 2-3
confirmaciones concretas numeradas; (3) **qué sigue** — bifurcado si aplica ("si sale bien → X · si
encuentra algo → eso es el próximo trabajo").

**Por qué el bloque abre nombrando el momento de la falla.** Con la regla ya escrita, y con
medidor automático incluido, se incumplía igual, repetidamente, en una misma sesión. El patrón de
falla no es olvidarse la regla: es **abandonarla apenas hay material técnico interesante que contar**.
De ahí la línea del bloque: si estás por explicar algo que te pareció valioso descubrir, ése es
exactamente el momento en que la regla aplica.

## 4. Por qué el detalle tiene un destino obligatorio

Decir **qué no hacer** no alcanza. El diagnóstico: cuando una tarea
produce mucho material —4 subagentes exploradores, el output de un script, una matriz de hallazgos—
**el chat es el único lugar donde ese material puede ir, así que va**. Pedir concisión sin dar un
destino alternativo es pedirle al modelo que tire trabajo recién hecho, y bajo esa presión gana el
volcado. La regla no se cumple por voluntad; se cumple por tener adónde escribir.

Por eso el bloque dice **"se escribe a un archivo ANTES de escribir la respuesta"** — el orden es la
regla, no un consejo. Destinos: el run dir del pipeline, el scratchpad de la sesión, un `.md` en el repo
si es entregable, o un Artifact si es visual. Y "nunca se pega algo que ya vive en un archivo": si está
en un artefacto se cita — el lector lo abre si quiere; duplicarlo en el chat es el anti-pattern, no un
servicio. Aplica en particular a: reportes de advisors · resultados de subagentes (los suyos NO se ven,
así que hay que relayarlos — pero relayar es resumir, no transcribir) · output crudo de scripts, tests o
linters · listados de archivos tocados · matrices y tablas de más de ~8 filas · transcripciones.

## 5. Subagentes: las dos capas, y la "o" que era la fuga

El usuario ve TAMBIÉN el bloque que devuelve cada subagente —advisor, hunter, juez, explorador—, y ahí
es donde se acumulaba el volcado: salida cruda, verbosa, sin resumen ejecutivo ni opción de ver el
detalle. La
regla del reporte es: 1-3 bullets llanos, una línea de acción, y el detalle aparte. Si además admite *"abajo, bajo un
`### Detalle`, **o** directamente ofrecido"*, esa **`o`** hace legal volcarlo, y volcarlo es lo que
pasa: los advisors arrancan con sus 3 bullets correctos y después pegan 30 renglones de rule IDs
igual. Cumplen la letra y el usuario sigue leyendo un muro. Por eso no hay alternativa: el detalle va a un
archivo y el reporte devuelve la ruta — la misma lógica que el §4 ya aplicaba al agente principal,
extendida al subagente.

**La instrucción imposible.** Un advisor vuelca su tabla
completa al chat si el prompt le pide escribir un archivo **que no puede crear**. Casi todos los
advisors TYCON son read-only (`tools: [Read, Grep, Glob]` — 15 de 16 al 2026-07-27; la única excepción
era `tycon-retrospective-capturer`). Pedirle a uno de ésos que escriba un `.md` es pedirle algo
imposible, y bajo esa contradicción el modelo hace lo único que le queda: volcar el detalle al chat. La
regla no se rompe por descuido — la rompe una instrucción que no se puede cumplir. De ahí el deber del
orquestador de mirar `tools:` antes de pedir el archivo, y la variante para agentes sin `Write`
(resumen + *"tengo el detalle, pedímelo"*, con tope y prohibición literal de pegarlo; el orquestador pide
el detalle con un mensaje de seguimiento y lo escribe él).

**Las dos capas son a propósito.** Además del deber del orquestador, cada `agents/tycon-*.md` cierra con
§"Cómo se devuelve un reporte" (16 de 16 al 2026-09-03). La del agente es la que **sobrevive a un prompt
mal escrito**. Los agentes que ya tienen un formato de salida propio (los advisors, con su tabla de
findings por rule ID) no lo pierden — lo escriben al archivo: la tabla sigue siendo la auditoría; el
resumen es lo único que se lee en el chat.

## 6. El medidor: qué mide, por qué caracteres, por qué no bloquea

Hooks `scripts/hooks/response-style-meter.js` (`Stop`: mide el mensaje final del turno) +
`response-style-notice.js` (`UserPromptSubmit`: cobra el veredicto al inicio del turno siguiente, una
vez por infracción, y re-inyecta la regla en compacto junto con la ruta del texto archivado). Instalados
por `install-tycon-hooks.sh` en cada máquina; casos en `scripts/controls-bench/cases/hooks/02-meters.json`.

- **Qué cuenta**: caracteres de prosa FUERA de bloques de código; las tablas y el código no cuentan (un
  artefacto que el user pidió no es verbosidad). También líneas de prosa y títulos de sección.
- **Umbrales**: `TYCON_RESPONSE_MAX_PROSE_CHARS` (el que gatea; sin la variable, `response.max_chars` del perfil del
  equipo o el tope del estilo elegido: **1300** ≈13 renglones en `executive`, el de TYCON) ·
  `TYCON_RESPONSE_MAX_LINES` (15) · `TYCON_RESPONSE_MAX_HEADERS` (1) ·
  `TYCON_RESPONSE_MAX_SENTENCE_WORDS` (35, la oración más larga del mensaje).
- **Largo de oración (2026-10-02)**: de ASD-STE100 (el inglés técnico simplificado, que no existe en
  castellano) se tomó sólo «una idea por oración». Medido sobre 6.500 mensajes finales de 30 días: la
  oración mediana tenía 12 palabras, pero el 56 % de los mensajes traía alguna de más de 25 y el 23 %,
  alguna de más de 35. El bloque pide ~20 (lo que el modelo apunta); el medidor cobra desde 35. Su
  vocabulario controlado se descartó: mezclar dos palabras para lo mismo en un mensaje pasaba entre el
  1 % y el 7 % de las veces, poco para pagar una regla cargada en cada sesión.
- **Opt-out**: `TYCON_RESPONSE_METER=0`. Se calla en el sandbox de evals (`TYCON_EVAL_SANDBOX=1`) para
  no sesgar las mediciones del banco.
- **Estadística de cumplimiento**: `node scripts/hooks/response-style-meter.js --report [--all]`.
- **Desagüe automático**: el texto que se pasó queda archivado en `~/.claude/response-style/long/` —
  lo que se fue de largo ya está guardado y se puede citar por ruta en vez de re-pegarlo.

**Dos números con roles distintos, a propósito**: el bloque dice *objetivo ~10 líneas* (lo que el modelo
apunta al escribir) y *el medidor gatea en 1300 caracteres ≈ 13 renglones* (el umbral que cobra). Si el
bloque dejara sólo el umbral, el objetivo subiría de 10 a 13 sin que nadie lo haya decidido — por
eso el aviso del hook sigue diciendo "~10 líneas".

🔴 **Se mide por caracteres, no por líneas**:
contar líneas de source no sirve, porque un párrafo largo sin cortes es UNA línea y seis renglones en
pantalla; un muro pasa el control con "3 líneas". El proxy correcto de lo que el lector ve es la
cantidad de caracteres. Referencia empírica: un mensaje ejecutivo correcto midió ~1180 caracteres de
prosa; el tope se fijó apenas arriba.

**Por qué un medidor y no más texto normativo**: esta regla era la única del arnés sin gate mecánico —
todo lo demás que se cumple (tests, advisors, lints, safety-guard) se cumple porque algo lo verifica.
**Por qué no bloquea el turno**: bloquear haría que el modelo escriba un segundo mensaje después del
muro ya leído, o sea más ruido. Mide, archiva y cobra en el turno siguiente. (El medidor de ejecución
en segundo plano, `blocking-meter.js`, copió este molde.)

## 7. Relación con el pipeline

- **COMM.i** (`tycon-pipeline/SKILL.md`, 2026-07-05): en todo checkpoint que pide una decisión, resumen
  llano → pregunta → detalle abajo. Es el antecedente de esta regla.
- **COMM.ii** (2026-07-25): el cierre de la corrida también es ejecutivo primero. Nació el mismo día que
  este bloque.
- **COMM.iii** (2026-07-30): pasos largos en segundo plano — bloque hermano `background-execution.md`.
- Si esta regla y el template de un skill chocan, gana esta salvo que el skill diga explícitamente "va
  completo al chat".
- Los steps del pipeline y un agente citan el bloque **por nombre de sección** ("regla madre",
  §"Lo que devuelve un SUBAGENTE"): `steps/step-01-validate-story.md`, `steps/step-05-advisors-parallel.md`,
  `agents/tycon-retrospective-capturer.md`. Esos dos nombres se conservaron en la poda a propósito;
  renombrarlos deja punteros muertos del otro lado.

## 8. Qué quedó en el bloque a propósito (para la próxima poda)

La poda del 2026-09-03 bajó el bloque de 17.034 a 6.270 bytes, y el `CLAUDE.md` completo de 46.706 a
≈35.942 (−23%). Varias frases se dejaron aunque parezcan redundantes, porque su fuerza viene de CÓMO
están dichas y resumidas se vuelven ignorables:

- La línea que nombra el momento de la falla ("no se rompe por olvido: se rompe cuando hay material
  técnico interesante que contar").
- "Sin destino, el volcado gana siempre; por eso el orden" — la mitad de la fuerza de la regla del
  archivo es saber por qué se escribe ANTES.
- La regla del subagente escrita sin "o" (una alternativa legal se usa).
- El deber de mirar `tools:` con su consecuencia explícita ("ante eso vuelcan al chat").
- El test "¿lo entendería alguien que no tocó el código?" — un criterio de una línea aplicable en el
  momento de mandar.
- La lista concreta de jerga y el par ✅/❌ de opciones — un ejemplo ata más que "sin jerga".
- "Se verifica exhaustivamente, no se narra exhaustivamente" — desactiva el choque con las reglas de
  verificación exhaustiva de los CLAUDE.md de proyecto.
- "Se mide por caracteres: un párrafo sin cortes es una línea y seis renglones" — el medidor lo
  garantiza DESPUÉS; el modelo escribe ANTES.
- "Limpio, 0 hallazgos es un reporte completo" — sin eso los reportes vacíos se inflan enumerando lo
  revisado, que es el modo más común de inflarlos.
- La forma positiva "tabla de estado + dos líneas" — es la única descripción de cómo SE VE un mensaje
  correcto; todo lo demás son prohibiciones.
- Cuatro que una poda tiende a sacar y hay que devolver: el objetivo de
  ~10 líneas (sin él, el único número era el umbral de 13), "avisar que algo terminó está bien y se
  espera" (sin eso, "agrupar por tanda" se lee como "avisá menos"), "preguntá la que desbloquea"
  (el único criterio para elegir cuál decisión va primero), y "todo lanzamiento cierra con esta
  instrucción de formato" (el ítem de checklist del orquestador).

Si en una próxima poda alguna de estas parece sobrar, este es el lugar para leer por qué está. Y si
`node scripts/hooks/response-style-meter.js --report` muestra que el cumplimiento cae en las semanas
siguientes a la poda, lo primero que se devuelve al bloque son estas frases — no la historia.

**Próximo candidato — PODADO el 2026-09-06**: tras esta poda el bloque más pesado del `CLAUDE.md`
pasó a ser el de ADO (`claude-md-blocks/ado-runs-list-lag.md`), con el mismo patrón que motivó ésta:
reglas que se acumulan por incidente, con su historia adentro. Se le aplicó la misma receta —
la regla se queda, la historia se va a `guides/ado-cola-y-listados.md`— y bajó de **9.979 a 4.134
bytes** sin perder una regla (verificado frase por frase contra la versión anterior). El `CLAUDE.md`
completo quedó en **31.035 bytes**. Desde el mismo día cada bloque tiene techo declarado en
`claude-md-blocks/budget.json` y el pre-commit frena al que se pasa, así que esta clase de
engorde ya no depende de que alguien se acuerde de mirar.
