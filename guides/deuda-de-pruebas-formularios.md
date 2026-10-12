# Un formulario sin pruebas: cómo dejarlo así sin que el pipeline falle

## Qué pasó

En un producto del equipo, el formulario `ACME-PanelEntregas` no tiene pruebas. Estaba anotado en una lista de
excepciones, así que el pipeline lo dejaba pasar.

Un pull request lo sacó de esa lista sin agregarle pruebas. Al llegar a `main`, el pipeline vio
un formulario sin pruebas y sin excepción, y frenó. `main` está en rojo por eso.

## Cómo se arregla (el dev que quiera dejarlo sin pruebas)

1. Abrir el archivo `pruebas-pendientes.json` que está en la raíz del repo de formularios.

2. Dentro de la lista `sin_pruebas`, agregar esto:

```json
{
  "formulario": "ACME-PanelEntregas",
  "motivo": "Todavía no tiene pruebas. Las agrega la story <N.M>.",
  "fecha": "2026-09-05",
  "revision": "2026-12-01"
}
```

3. Commitear y abrir el pull request. Listo: el pipeline avisa en amarillo y sigue.

Los cuatro campos son obligatorios:

- `formulario`: el nombre de la carpeta.
- `motivo`: por qué no tiene pruebas.
- `fecha`: hoy.
- `revision`: hasta cuándo vale la excepción. Ese día vuelve a fallar, y hay que poner
  las pruebas o renovar la fecha.

## Cuando le pongan pruebas

Borrar la entrada de la lista **en el mismo pull request** que agrega las pruebas. Si quedan
las pruebas y la entrada, el pipeline también falla.
