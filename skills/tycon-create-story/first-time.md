# Modo primera vez: la historia sin proyecto BMAD

Este repo no tiene proyecto BMAD (`_bmad/bmm/config.yaml`): lo dijo `story-without-bmad.js mode`, no vos. La historia
nace igual. No hay épica, sprint ni prioridad que elegir: eso lo completa el guion.

Le hablás a alguien que puede estar usando el arnés por primera vez. Escribí en castellano llano, decí «historia» (la
primera vez, «historia (story)») y «tu agente de código» cuando hables de vos. Sin jerga del arnés.

## 1. Las tres preguntas

Hacelas **una por vez**: esperá cada respuesta antes de la siguiente. Si la persona ya contestó alguna en su pedido
(«creá una historia para que el total del carrito sume el envío»), no la repitas: confirmala en una línea y seguí.

1. **¿Qué querés que haga?** Contalo como se lo contarías a alguien del equipo. Ejemplo: «que el total del carrito
   incluya el costo del envío».
2. **¿Cómo te das cuenta de que anda?** Lo que mirarías para decir «listo»: qué ves, qué número da, qué pasa cuando
   algo falta. Ejemplo: «con dos productos y envío de 500, el total es la suma más 500; con el carrito vacío, cero».
3. **¿Qué no tiene que tocar?** Lo que tiene que quedar como está. Se puede contestar «nada».

## 2. De las respuestas a criterios y pruebas

- Cada cosa que la persona mira en la respuesta 2 es un **criterio**: dado (el estado de partida), cuando (lo que
  hace), entonces (lo que se ve). Si la respuesta nombra qué pasa cuando algo falta o está vacío, ése es un criterio
  de falla (`failure: true`).
- Cada criterio lleva **al menos una prueba**, con un nombre como `Total_ConEnvio` (letras sin tilde, números y `_`),
  el escenario y el resultado esperado.
- La respuesta 3 va a «fuera de alcance» (`outOfScope`). Si contestó «nada», dejalo vacío.
- Si ves en el repo qué archivos se tocan, sumalos (`filesToCreate`, `filesToModify`); si no, dejalos vacíos.
- **Cómo se corren las pruebas** (`verify`): el comando que ves en el repo (por ejemplo el `test` de `package.json`,
  `pytest`, `dotnet test`), uno por renglón. Con un `package.json` que declara `test`, podés dejarlo afuera: el guion
  pone `npm test`. Si no lo ves, preguntale a la persona cómo corre las pruebas: no lo inventes.

## 3. Mostrar y esperar el «sí»

Mostrá en llano el título, los criterios, las pruebas y **con qué comando se corren** (lo que va en `verify`, o
`npm test` si lo pone el guion), en una lista corta. El comando queda escrito en la historia y lo corre después el
recorrido: la persona lo ve antes de aprobarlo. Preguntá «¿La escribo así?» y esperá el «sí» antes de escribir nada.
Si pide cambios, ajustá y volvé a mostrar.

## 4. Escribir la historia

Con el «sí», escribí las respuestas en un JSON en tu carpeta temporal (no en el repo) y corré:

```bash
node <esta skill>/scripts/story-without-bmad.js write --repo <repo> --answers <archivo.json>
```

Forma del JSON:

```json
{
  "title": "El total del carrito suma el envío",
  "asA": "quien compra en la tienda",
  "iWant": "ver el total con el envío incluido",
  "soThat": "no llevarme una sorpresa al pagar",
  "criteria": [
    { "given": "un carrito con dos productos y envío", "when": "abro el resumen", "then": "el total incluye el envío" },
    { "given": "un carrito vacío", "when": "abro el resumen", "then": "el total es cero", "failure": true }
  ],
  "tests": [
    { "name": "Total_ConEnvio", "criterion": 1, "level": "unit", "scenario": "envío de 500", "expected": "suma + 500" },
    { "name": "Total_CarritoVacio", "criterion": 2, "level": "unit", "scenario": "sin productos", "expected": "0" }
  ],
  "outOfScope": ["los impuestos"],
  "filesToCreate": [],
  "filesToModify": [],
  "verify": ["npm test"]
}
```

- **Sale 0**: el guion escribió la historia y devolvió su ruta.
- **Sale 2**: dice en llano qué falta o qué sobra y no escribió nada. Arreglá el JSON (o preguntale a la persona lo que
  falta) y volvé a correrlo. Nunca escribas la historia a mano: la marca de primera vez sólo vale si la escribe el guion.

No escribas el archivo de la historia con tus herramientas de edición, ni lo copies a otro lado: lo único que cambiás
a mano es el estado, en el paso que sigue.

## 4b. Validarla

El guion la deja con `status: draft`: un borrador que el pipeline no toma. Corré el validador de historias
(`tycon-story-validator`) sobre la ruta que devolvió el guion, nombrándola en el pedido. Si su reporte trae un CRITICAL,
arreglá la historia con la persona y volvé a correrlo. Cuando pase, cambiá con la tool Edit `status: draft` por
`status: ready-for-dev`, en el frontmatter y en el renglón `Status:` de abajo del título. Sin el validador, el arnés no
deja hacer ese cambio.

## 5. El cierre

Tu último mensaje es el campo `closing` del resultado del guion, tal cual, sin recortarlo ni resumirlo. Dice dónde
quedó y qué sigue:

> Listo, tu historia quedó en `<ruta>`. Para implementarla, pedime: «implementemos la story <ruta>». Si el repo no
> tiene git o estás en `main`, el recorrido lo prepara solo: crea la rama de trabajo y te lo dice.

La frase «implementemos la story <ruta>» es la que arranca el recorrido: sin ella, quien empieza no sabe cómo seguir.
