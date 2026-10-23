# Estimar en tres niveles

Una estimación sirve si después se puede ver cuánto se erró. Por eso el arnés guarda cada versión de cada estimación, y
no sólo la última: la épica con un rango, el plan con un valor por historia y la historia que lo ajusta al escribirla.
Al cerrar cada historia se suman las horas del reloj y se ve el error de cada nivel.

## Dónde queda

En el repo de historias, en `.tycon/estimates.jsonl`: una línea por estimación, de sólo agregar. Nada se pisa ni se
borra. La versión que vale de cada cosa es la última línea que la nombra. El primer registro agrega
`.tycon/estimates.jsonl merge=union` a `.gitattributes`, para que dos ramas que suman líneas se junten sin conflicto en
un merge local. Un merge hecho por el servidor puede no respetar ese atributo: si dos pedidos chocan en el registro, se
resuelve con un merge local que deja las líneas de los dos.

Una línea que no se puede leer (un JSON roto, una versión que no se conoce, un campo roto) se cuenta y se informa, y el
resto se lee igual. El archivo nunca se reescribe.

## Los tres niveles

| Nivel | Cuándo | Comando |
|---|---|---|
| Épica | al escribirla: un rango con sus supuestos | `node scripts/lib/estimates.js epic --repo <repo> --epic 3 --min 40 --max 70 --assumptions "sin migración de datos"` |
| Plan | al partirla en historias: un valor por historia | `node scripts/lib/estimates.js plan --repo <repo> --story <id> --value 12` |
| Historia | al escribirla con detalle: el ajuste | lo hace `tycon-create-story`; a mano, `estimates.js story --repo <repo> --story <id> --value 16` |

La épica de una historia sale del `epic:` de su frontmatter. Si ese campo cambia, la historia cuenta en la épica nueva.

## Cómo se ve una épica

```bash
node scripts/lib/estimates.js report --repo <repo> --epic 3
```

Da el rango, la suma del plan, la suma vigente (la estimación de la historia si la hay; si no, la del plan) y si cae
dentro, debajo o encima del rango, y por cuánto. Con `--json` trae además cada historia con sus versiones.

## La propuesta

Al escribir una historia, `tycon-create-story` busca las historias cerradas más parecidas con sus horas reales
(`scripts/lib/similar-stories.js`), propone un valor en base a ellas y lo dice. La persona confirma, corrige u omite; el
registro guarda lo que propuso el modelo, lo que quedó, en qué historias se basó y quién lo confirmó. Omitir es válido:
una estimación que falta nunca frena la historia.

Al principio las propuestas salen vacías: hacen falta historias cerradas con horas reales, y esas horas se anotan al
cerrar. Mientras tanto estima la persona.

El parecido es un puntaje simple: misma épica, temas (`topics`) en común, archivos declarados en común y palabras del
título en común. Sólo entran historias en `done` con horas reales.

## La unidad

La elige la organización en `team-repos.json → estimates`: `unit` (`hours`, `days` o `points`),
`hours_per_day` (sin cargar, 8) y `hours_per_point` (sin cargar, ninguna). Sin la clave, horas. Cada línea guarda la
unidad con la que se escribió, así que cambiar la unidad no reescribe nada.

El informe compara en horas. Con días usa `hours_per_day`. Con puntos y sin `hours_per_point` no inventa una tasa: si
la épica mezcla unidades, muestra las sumas por unidad y no la marca dentro ni fuera de su rango, y la propuesta de la
historia no da un valor.

## Las salidas

`0` listo · `2` entrada inválida (un valor que no es un número mayor que 0, `--min` mayor que `--max`, una historia que
no existe o sin `epic:`): no escribe nada · `3` no se pudo leer la configuración de la organización o el registro.
