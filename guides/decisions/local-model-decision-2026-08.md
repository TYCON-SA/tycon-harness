# Por qué el arnés NO usa un modelo local (decisión 2026-08-24)

**Decisión**: hoy el arnés no corre ninguna pieza sobre un modelo local (Ollama). El observador de
instintos quedó *preparado* para hacerlo (ejecutor `ollama` opt-in), pero el default es nube
(Haiku/gpt-5.4-mini). Esta nota justifica esa decisión con medición propia + el estado de la
industria, para no re-litigarla de memoria.

## Lo que mide la industria (feb–jul 2026)

- El motor de la adopción de modelos locales **no es el costo, es la privacidad/IP**: código que no
  puede salir de la red. El ahorro de plata solo cierra con **volumen alto + hardware propio**
  (break-even ~5 meses a 500 consultas/día en una GPU dedicada).
- El patrón que se está volviendo default es **ruteo híbrido**: tareas simples/repetitivas/de alto
  volumen → modelo local; razonamiento complejo → API de frontera en la nube.
- El salto de calidad está en los **24–30B** (dan 80–90% del flagship). Los 3B/7B siguen flojos para
  juicio.
- Caso canónico de local: **autocompletado** (latencia por tecla). No aplica: el arnés no autocompleta.

Fuentes: *State of Coding Agents Using Local LLMs* (medium, feb 2026) · *Local AI vs Cloud 2026*
(mindstudio) · *Best Local LLM for Coding 2026* (tembo.io).

## Por qué no nos conviene HOY (contraste con nuestro caso)

| Driver de la industria | Nuestro caso |
|---|---|
| Ahorro de costo | No aplica: estamos en **suscripción**, el costo marginal es ~$0 (Haiku y gpt-5.4-mini incluidos) |
| Privacidad/IP (código no sale de la red) | **Sí nos toca** (los advisors leen código de cliente) — pero lo bloquea el hardware, ver abajo |
| Modelos 24–30B con 80–90% del flagship | Necesitan **24–32 GB o GPU dedicada**. Las máquinas del equipo (M2/16 GB) solo corren 3B/7B |
| Autocompletado local | El arnés no autocompleta |

## Medición propia (2026-08-24, M2 8-core / 16 GB)

Prompt real del observador de instintos + un test de calidad (extraer 2 reglas reales de entre 3
ruidos). Detalle: `scratchpad` de la sesión (`modelos-chicos-veredicto.md`), resumido acá:

| Modelo | Sacó las 2 reglas | Tiempo | RAM |
|---|---|---|---|
| Haiku (nube, hoy) | **sí (2/2)** | ~21 s | 0 |
| llama3.2:3b (local) | sí (2/2) | ~177 s | 3,4 GB |
| qwen2.5:7b (local) | 1 de 2 | ~110 s | 6,3 GB |
| qwen2.5:3b (local) | **0 de 2** | ~33 s | 2,5 GB |

- **Con `num_ctx` acotado a 8K, un 3B/7B SÍ entra en 16 GB** (corrigió el diagnóstico inicial de
  "no entra"): el límite no es la RAM, es la **calidad de juicio**.
- Ningún local le gana a Haiku en calidad, y Haiku sale ~$0 y 8× más rápido.
- `grep` / `codegraph` **no usan modelo** (búsqueda de texto / índice AST): ya son locales y gratis.
  Ahí no hay nada que "pasar a local" — el modelo solo entra en *entender* lo que se encontró, que
  es justo donde el modelo chico es más flojo.

## Conclusión

Para nuestro setup —suscripción (costo ~$0), máquinas de 16 GB, y tareas que son o triviales-
mecánicas (sin modelo) o de juicio (donde el chico falla)— **un modelo local no aporta hoy**. Ya
aplicamos el patrón recomendado (ruteo híbrido) de forma conservadora: lo mecánico en Haiku, el
juicio en Sonnet/Opus.

## Qué cambiaría la decisión (revisar si pasa)

1. **Política de "el código del cliente no viaja a la nube"** (privacidad/IP dura). Ahí el movimiento
   NO es un 3B en la laptop: es un **servidor compartido con un modelo de código 30B** (Qwen3-Coder)
   donde correrían los 16 advisors. Es una inversión en hardware, no un fix — evaluar costo del box
   vs. el riesgo de mandar código de cliente a Anthropic/OpenAI.
2. **Hardware del equipo sube a 32 GB+ o GPU dedicada** → los 24–30B pasan a ser viables localmente.
3. **Un modelo local abierto alcanza la calidad de Haiku** en el juicio de clasificación → prender el
   ejecutor `ollama` del observador por privacidad, sin perder señal.

Mientras ninguna de las tres pase, el default nube se queda.
