# Estilo de código — los comentarios dicen qué hace el código y por qué, en presente

Un comentario lo lee alguien que abre el archivo para entenderlo o para cambiarlo. Le sirve saber qué hace esa parte y
por qué está así. No le sirve cómo se llegó ahí: eso está en el historial de git y en las historias del equipo, que
alguien de afuera no ve.

## La regla

- **Qué hace y por qué**, en presente y corto. Una idea por comentario.
- **Sin referencias internas**: ni números de story, ni códigos de trabajo, ni fechas, ni casos del registro de
  incidentes, ni nombres de ramas, commits o corridas. Desde afuera no llevan a nada.
- **Sin historia**: nada de «antes era…», «hasta hoy…», «ahora…», «se encontró cuando…». Si el porqué es un error que
  pasó, se dice el error en presente («sin esto, X pasa en silencio»), no el relato.
- **Lo que el lector no ve en el código**: el motivo de una decisión que parece rara, el caso que cubre una rama, el
  límite conocido. Lo que el código ya dice no se repite.
- La prueba que cubre una parte se puede nombrar (`Casos: scripts/tests/<archivo>`): es una ruta del árbol, y lleva a algo.

Vale para el código y los guiones del arnés. Los controles del commit (`.githooks/pre-commit` y
`.githooks/pre-commit-checks`) la cumplen y una prueba lo mide (`scripts/tests/hook-comments.test.js`).

## Ejemplos

✅ Bien — dice qué hace y por qué, en presente:

```bash
# Lo que trae el commit, leído una vez y mirando el código de salida de git: `git diff | grep -q` con pipefail sale 141
# cuando grep se va antes de que git termine, y el control se saltea sin decirlo.
```

✅ Bien — nombra el límite conocido y la prueba:

```bash
# Limitación: check.js valida el árbol de trabajo, no el índice (con `git add -p` y seguir editando puede pasar una
# versión no mirada). Casos: scripts/tests/githook-livefire.test.sh
```

❌ Mal — cuenta la historia y nombra lo interno:

```bash
# 🔴 La lista se AMPLIÓ el <fecha> (<código del arreglo>). Antes era `^(adapters/|build/)`, y eso dejaba dos agujeros
# reproducidos en <el trabajo> de la story <N.M>.
```

Mejor: «Dispara también con los hooks, el instalador y este mismo archivo: una pieza nueva entra con sus casos, y
recortar esta lista corre el control.»

❌ Mal — repite el código y agrega una referencia que desde afuera no lleva a nada:

```js
// story <N.M>: suma 1 al contador (ver <el caso del registro de incidentes>)
count += 1;
```

Mejor: sin comentario, o el porqué si no se ve («cuenta también los salteados: un salteo no es un verde»).

## Relacionado

- Los nombres de lo que ejecuta la máquina: `guides/nombres-en-ingles.md`.
- La prosa que se publica (guías, portadas, skills, revisores) tiene su propio freno de historia interna, al commitear:
  `scripts/publishing/internal-history.js`.
