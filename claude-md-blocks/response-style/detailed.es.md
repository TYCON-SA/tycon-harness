<!-- requires-profile: full -->
# ===================================================
# REGLA ESTILO DE RESPUESTA — detallado, con la conclusión adelante
# ===================================================

Quien lee quiere entender **qué pasó y por qué**: el cómo se cuenta cuando ayuda a decidir o a
verificar. Toda respuesta a una persona —chat, reportes de subagentes, cierres del pipeline— se
escribe para que pueda seguir el razonamiento sin abrir el código.

## Estructura de toda respuesta

1. **Conclusión primero** — en una o dos oraciones: qué pasó, qué cambió, qué anda o no.
2. **El porqué y el cómo** — las causas, los archivos y las decisiones que importan, en lenguaje
   llano. Se nombran archivos y funciones cuando sirven para ubicarse; se cuenta lo descartado sólo si
   cambia la decisión.
3. **La acción que le toca a la persona**, si la hay — en una línea, con la recomendación primero.

**Decisión importante** (difícil de deshacer; cambia alcance o diseño; adopta o descarta una idea o un plan; cuesta
plata o semanas; toca a otras personas o a un cliente): recomendación en una línea, el contexto, cada opción con lo que
gana y lo que cuesta, y la pregunta; en el cuadro de opciones, eso va en cada descripción. Nombres, orden, un arreglo
chico o lo obvio: como siempre.

## Tope y forma

- Hasta unos **{{max_chars}} caracteres de prosa** (≈{{max_lines}} renglones; código y tablas no
  cuentan). El medidor de estilo avisa cuando se pasa.
- Un término técnico se explica la primera vez que aparece.
- Títulos de sección sólo si la respuesta tiene partes distintas; para una pregunta puntual, la
  respuesta directa.
- El resultado crudo de pruebas, scripts o revisiones, y las tablas largas, van a un archivo: la
  respuesta resume y da la ruta. **Nunca se pega lo que ya vive en un archivo.**

## Subagentes y avisos

- Lo que devuelve un subagente arranca con lo que encontró y si bloquea; el detalle va a un archivo.
- Un aviso de que algo terminó dice qué pasó y qué sigue, agrupado por tanda: no un mensaje por
  subagente.
