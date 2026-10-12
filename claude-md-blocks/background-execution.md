<!-- requires-profile: full -->
# ===================================================
# REGLA EJECUCIÓN EN SEGUNDO PLANO — pasos largos no bloquean la conversación (2026-07-30)
# ===================================================

**Por qué**: mientras una herramienta corre, los mensajes del dev esperan pegados al próximo
resultado — el agente no puede leerlos ni contestarlos hasta que termina. Un paso largo bloqueante
deja al dev minutos sin respuesta.

## Las 4 reglas

1. **Todo paso que se estime ≥2 minutos corre EN SEGUNDO PLANO** — con el mecanismo de ejecución en
   segundo plano de la herramienta (nombres exactos en la sección "Nombres por herramienta" al final
   de este archivo) — salvo que un gate necesite su exit code inmediato Y tarde
   menos que eso. La notificación de término llega sola; mientras tanto la conversación queda libre.
2. **Antes de lanzar cualquier paso ≥30 segundos: anunciar en UNA línea qué corre y cuánto se
   estima** ("suite completa, ~90s" / "pase adversarial, ~30 min"). El silencio esperado no es un
   misterio; el inesperado sí.
3. **Al volver de una espera, si el dev escribió algo en el medio, contestarle PRIMERO** — antes de
   encadenar el siguiente paso. El mensaje quedó esperando; el paso puede esperar 15 segundos más.
4. **Progreso visible sin preguntar**: usar los comandos de la herramienta que listan fan-outs y
   tareas de fondo (nombres exactos en la sección "Nombres por herramienta"). Son del harness, no
   del modelo — funcionan igual con cualquier modelo. Para sesiones largas, ofrecer aviso por
   Telegram al cierre de cada TANDA (nunca por agente — regla de avisos de progreso del bloque de
   estilo).

## Anti-patterns

- ❌ Correr bloqueante un paso de >2 min "por costumbre" cuando nada del turno actual depende de él.
- ❌ Volver de una espera larga y seguir encadenando pasos con un mensaje del dev sin contestar.
- ❌ Lanzar algo de 30 minutos sin decir cuánto tarda.

## Esto se MIDE, no se confía (cableado 2026-07-30, mismo día)

Hooks `blocking-meter.js` (Stop — mide la tool call bloqueante más larga del turno, excluyendo las
de fondo y las que esperan una respuesta del dev, y los mensajes del dev encolados durante la espera) + `blocking-notice.js`
(UserPromptSubmit — cobra el veredicto al turno siguiente). Nunca bloquean el cierre del turno
(misma decisión que el medidor de estilo: medir y cobrar después). Instalados por
`install-tycon-hooks.sh` en cada máquina del equipo.

- Estadística: `node <tcg>/scripts/hooks/blocking-meter.js --report [--all]`
- Umbral: `TYCON_BLOCKING_MAX_MS` (120000 = el corte de 2 min de la regla 1)
- Opt-out: `TYCON_BLOCKING_METER=0`
