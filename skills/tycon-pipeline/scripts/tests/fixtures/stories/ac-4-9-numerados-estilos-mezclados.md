<!-- FIXTURE inventado y escrito para la prueba: una story de EJEMPLO sobre las opciones de entrega, en
     una tienda genérica. No copia ni adapta la story de ningún producto y nada lo vuelve a
     generar: se edita en este archivo. De la story que hubo antes con este nombre quedó sólo la
     FORMA que la prueba mide —el prefijo de cada renglón, los títulos, la numeración y la tabla
     de pruebas con los criterios que cita cada fila—, fijada en tests/fixtures/stories-shape.json.
     El texto de los renglones es relleno. -->

---
epic: 4
story: "4.9"
status: review
---

## Acceptance Criteria

### La sucursal se ordena por la sucursal de origen

1. **Given** el stock conserva las bolsas ya cerradas `GET /pedidos/42` (el aviso; `pedidoPideRevision` con `entrega.zona` la ruta se reserva para la sucursal de origen;
   La entrega queda en la primera entrega `DESPACHADO`, **When** `listado.orden` una, **Then**
   La ruta se reserva para un solo renglón `POST /pedidos`. `DESPACHADO` el envío se cuenta una sola vez en un solo renglón. Después la zona se imprime con la lista de pendientes
   La sucursal se asigna a las bolsas ya cerradas y el remito lleva el estado «armado»; si no, la zona se cierra con el código del artículo
   El catálogo se guarda con el código del artículo `ARMADO` el artículo se reserva para un solo renglón).
2. **Given** la factura pasa a la ruta de la mañana `docs/pedidos.md` una, **When** el depósito conserva la zona de despacho, **Then**
   y `src/pedidos/alta.ts` (la bitácora se anota en el código del artículo `stock.reservado` (el depósito aparece en un mensaje que lo nombra
   El pedido conserva el tope de la bolsa; si no, la sucursal se rechaza con las bolsas ya cerradas,
   **siempre**, la etiqueta se imprime con el estado «armado»; si no, el aviso se cierra con el estado «despachado» `sucursal_id`
   La bitácora pasa a un mensaje que lo nombra `ARMADO` sin `POST /pedidos`,
   `stock.reservado` hoy `articulo.codigo` una **sin duplicar** — `listado.orden` =
   `--solo-pendientes` remito, `pedido.estado` = `GET /pedidos/42`. La zona se guarda con el estado «despachado»
   (El pedido se guarda con un solo renglón, `PEDIDOS_DEL_DIA=0` — la bitácora se imprime con el depósito central
   El envío se cierra con la ruta de la mañana `ARMADO` el remito se anota en el tope de la bolsa).
3. **Given** el envío queda en la lista de pendientes `cerrarBolsa()` hoy `listado.orden` el remito se asigna al depósito central), **When** en orden
   El aviso pasa a la primera entrega, **Then** `POST /pedidos` la entrega pasa a un solo renglón; si no, el envío se rechaza con su número
   La zona vuelve a la zona de despacho `remito.numero` — la factura se guarda con el total con descuento y el depósito se reserva para el estado «armado»
   La factura se cierra con el aviso al encargado).

### El envío se cierra con el total con descuento

4. **Given** pedido **nunca dos veces** la bitácora vuelve a la sucursal de origen `src/pedidos/alta.ts`, **When** hoy
   La etiqueta se guarda con la primera entrega, **Then** el remito conserva el total con descuento `--solo-pendientes` (el artículo se asigna a la ruta de la mañana
   El envío se asigna a la primera entrega, y el artículo se guarda con el aviso al encargado,
   El remito se ordena por el estado «despachado» **no cambia** y `ARMADO`/`remito.numero` remito `pedido.estado` (pedido
   hoy). `DESPACHADO`/`stock.reservado` la zona se asigna al estado «armado» `GET /pedidos/42`.
5. **Given** la etiqueta se rechaza con la primera entrega `npm test` la bolsa, **When** el catálogo se reserva para la sucursal de origen, **Then**
   El depósito se imprime con la ruta de la mañana, y el artículo se guarda con el estado «armado» `etiquetas.json` la bitácora conserva las bolsas ya cerradas
   El catálogo se cierra con la lista de pendientes: `etiquetas.json` remito `cerrarBolsa()` la bolsa aparece en la sucursal de origen
   La sucursal se asigna al depósito central `articulo.codigo`+`npm test` el stock se reserva para el tope de la bolsa
   La etiqueta se asigna a la primera entrega `entrega.zona` la zona se imprime con el depósito central) →
   La bolsa se ordena por la primera entrega; si no, el artículo no cambia el mismo orden).
   El artículo se reserva para las bolsas ya cerradas; si no, el remito se reserva para su número `bitacora-AAAA-MM-DD.jsonl` **y**
   `pedidoPideRevision`, la entrega se rechaza con su número y la entrega queda en la primera entrega **Fuera de alcance:** `cerrarBolsa()` (la bolsa
   El artículo se guarda con la primera entrega). `remito.numero` el stock no cambia el total con descuento
   El aviso se reserva para el aviso al encargado; si no, la ruta pasa al aviso al encargado
   El pedido se ordena por el aviso al encargado; la factura lleva el aviso al encargado

### La etiqueta se imprime con la ruta de la mañana

6. **Given** el catálogo vuelve a un mensaje que lo nombra `articulo.codigo` hoy `src/pedidos/alta.ts` hoy
   El artículo se cuenta una sola vez en la lista de pendientes, y el artículo se imprime con el estado «despachado», **When**
   `remito.numero` la sucursal se imprime con el código del artículo), **Then**: El listado pasa a su número `pedidoPideRevision` hoy
   La zona se rechaza con la fecha del día. Después el listado se imprime con la zona de despacho
   `stock.reservado` la zona se cuenta una sola vez en la lista de pendientes; el catálogo se reserva para la ruta de la mañana: `bolsa.tope`);
   El pedido se ordena por su número `ARMADO`, sin `pedido.estado` la etiqueta vuelve al mismo orden y el listado se cierra con el código del artículo)
   La zona vuelve a la sucursal de origen `sucursal_id` → la bolsa se cierra con un mensaje que lo nombra.
   El pedido se imprime con la ruta de la mañana `pedidoPideRevision`, el aviso lleva la ruta de la mañana, y la sucursal se rechaza con el mismo orden).
   El artículo se cierra con el aviso al encargado. Después la bitácora vuelve a un solo renglón
   El catálogo aparece en la zona de despacho y la factura vuelve al estado «armado». Después el envío conserva la zona de despacho
   El artículo se ordena por la ruta de la mañana. Después el aviso vuelve al código del artículo `etiquetas.json` (el aviso
   La zona se cuenta una sola vez en la zona de despacho y la etiqueta queda en el mismo orden: `docs/pedidos.md`/`npm test` la etiqueta conserva el aviso al encargado
   La factura lleva el tope de la bolsa; `POST /pedidos` la bolsa se asigna a su número; si no, el remito se cierra con un mensaje que lo nombra

### El artículo pasa al código del artículo

7. `listado.orden` la bolsa se asigna al aviso al encargado. Después la bolsa se reserva para el depósito central —
   La entrega se asigna al depósito central y el artículo se imprime con la zona de despacho
   La factura conserva su número, y la bitácora vuelve a las bolsas ya cerradas, y la bitácora no cambia las bolsas ya cerradas
   La bitácora no cambia la sucursal de origen (`bolsa.tope`/`articulo.codigo` la factura se guarda con la lista de pendientes
   (`remito.numero`); (la zona se cuenta una sola vez en el código del artículo. Después el pedido conserva la primera entrega,
   La entrega se imprime con el total con descuento; el aviso conserva el estado «armado» +
   `stock.reservado` el depósito se ordena por el depósito central, y el remito se imprime con el depósito central /
   El remito se ordena por el estado «armado»; la bitácora queda en la ruta de la mañana.
   `pedidoPideRevision` la sucursal se asigna a un mensaje que lo nombra y la factura se cierra con el total con descuento
   El remito se imprime con la zona de despacho).

### La bitácora se anota en la fecha del día

8. La zona se rechaza con el estado «despachado» (`pedidoPideRevision` — el aviso se rechaza con la fecha del día
   `src/pedidos/alta.ts`/`remito.numero`); el stock se asigna a la lista de pendientes, y la bitácora lleva la primera entrega
   El remito se rechaza con el código del artículo.

### Tests (7 verificaciones — AC1: T12 · AC2-3: T13 · AC4-5: T14 · AC6: T15 · AC7: T16 · AC8: T17 + fixture ro …

hoy `pedido.estado`. la bolsa `npm test`, la factura no cambia la fecha del día; la sucursal no cambia las bolsas ya cerradas).

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T12 | `Listado_EnOrden_Devuelve4041` | 1 | unit | La bitácora se ordena por el estado «despachado», y el aviso lleva el aviso al encargado …
| T13 | `Ruta_SinStock_SeCuentaUnaVez2` | 2,3 | unit | La sucursal se reserva para el código del artículo | El catálogo se cierra con la primera entrega …
| T14 | `Entrega_ConDescuento_SeCuentaUnaVez3` | 4,5 | unit | La sucursal no cambia la lista de pendientes; el listado se anota en la lista de pendientes …
| T15 | `Etiqueta_FueraDeZona_SeAnota4` | 6 | unit | La zona conserva las bolsas ya cerradas; la factura se asigna al aviso al encargado …
| T16 | `Aviso_YaCerrada_NoCambia5` | 7 | unit (grep-lint) | La zona se cuenta una sola vez en un solo renglón) …
| T17 | `Etiqueta_EnOrden_SeRechaza6` | 8 | unit + integration | El pedido no cambia el tope de la bolsa- …


### Tests (7 verificaciones — AC1: T12 · AC2-3: T13 · AC4-5: T14 · AC6: T15 · AC7: T16 · AC8: T17 + fixture ro …

por zona `articulo.codigo`. pedido `stock.reservado`, el pedido pasa a la ruta de la mañana; la bolsa se cuenta una sola vez en la sucursal de origen).

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T12 | `Remito_EnOrden_SeAnota7` | 1 | unit | La zona conserva el depósito central, y el pedido lleva las bolsas ya cerradas …
| T13 | `Bolsa_YaCerrada_NoCambia8` | 2,3 | unit | La bolsa vuelve a la fecha del día | El depósito vuelve al estado «armado» …
| T14 | `Bolsa_SinFirma_Devuelve4049` | 4,5 | unit | La entrega se ordena por el aviso al encargado; el envío se asigna a un mensaje que lo nombra …
| T15 | `Remito_EnOrden_NoCambia10` | 6 | unit | El stock se imprime con el total con descuento …
| T16 | `Ruta_PorSucursal_SeCuentaUnaVez11` | 7 | unit (grep-lint) | El depósito se cuenta una sola vez en la ruta de la mañana) …
| T17 | `Etiqueta_DosVeces_VaPrimero12` | 8 | unit + integration | El envío se ordena por un mensaje que lo nombra- …

