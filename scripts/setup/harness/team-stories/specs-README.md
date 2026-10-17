# Historias de {{TEAM}}

Una historia por archivo `.md`, con frontmatter. **Todo lo que un dev necesita para implementarla
va acá**: contexto, alcance, archivos a crear y modificar, detalle de implementación con código,
criterios de aceptación numerados, pruebas con el nombre de cada una, y dependencias.

Formato completo y obligatorio: `story-format.md` del arnés.

## Lo que frena si falta

- **Frontmatter ilegible** → la historia se vuelve invisible: el validador, los scripts de estado
  y el portón de controles la **saltean en silencio**, sin dar error. El hook de pre-commit de
  este repo (`.githooks/pre-commit`) corre el lint justamente para eso. Caso real en otro
  equipo: 4 historias invisibles durante dos meses, una tapando una deuda de evidencia.
- **Cantidad de pruebas sin declarar** → cada historia dice CUÁNTAS pruebas y el NOMBRE de cada
  una. Después de escribirlas se verifica el número real contra el declarado.
- **Una historia que corrige o recalibra a otra** lleva `followup_of:` y su causa en
  `followup_reason:`. Sin eso el reproceso no se puede medir.

## Cómo se organiza

Una carpeta por tema (`.specs/<tema>/`), no un archivo suelto por historia en la raíz. El nombre
del tema es el que después agrupa las historias en el tablero del equipo.

El repo nace vacío el {{DATE}}: todavía no hay ninguna historia.
