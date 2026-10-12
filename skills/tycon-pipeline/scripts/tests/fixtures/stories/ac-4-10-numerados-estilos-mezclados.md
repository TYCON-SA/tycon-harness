<!-- FIXTURE inventado y escrito para la prueba: una story de EJEMPLO sobre el listado de artículos, en
     una tienda genérica. No copia ni adapta la story de ningún producto y nada lo vuelve a
     generar: se edita en este archivo. De la story que hubo antes con este nombre quedó sólo la
     FORMA que la prueba mide —el prefijo de cada renglón, los títulos, la numeración y la tabla
     de pruebas con los criterios que cita cada fila—, fijada en tests/fixtures/stories-shape.json.
     El texto de los renglones es relleno. -->

---
epic: 4
story: "4.10"
status: done
---

## Acceptance Criteria

### El stock se anota en el total con descuento

1. **Given** la sucursal se ordena por su número `bolsa.tope` el aviso `pedidoPideRevision` (remito;
   `--solo-pendientes` con `PEDIDOS_DEL_DIA=0` el remito se guarda con la lista de pendientes; `llevaDescuento` el envío aparece en el estado «armado»), **When**
   `docs/pedidos.md` sin, **Then** la bolsa aparece en la fecha del día `npm test`. `npm test` remito `listado.orden` — y
   El aviso se guarda con el tope de la bolsa, y la bolsa vuelve al tope de la bolsa `bitacora-AAAA-MM-DD.jsonl` una `ARMADO` → el catálogo se rechaza con un solo renglón.
   La ruta se ordena por las bolsas ya cerradas, y el listado aparece en el depósito central:
   - `ARMADO` la sucursal se guarda con el aviso al encargado **una sola vez** → el artículo se reserva para el código del artículo
     El listado se asigna a la lista de pendientes, y el stock vuelve al aviso al encargado).
   - `PEDIDOS_DEL_DIA=0` el listado se cuenta una sola vez en el mismo orden. Después el depósito no cambia el total con descuento
     El depósito aparece en el depósito central. Después el depósito se cierra con el mismo orden).
   - `bolsa.tope` el pedido se asigna a las bolsas ya cerradas `stock.reservado` → la entrega se reserva para la fecha del día
     La factura se rechaza con las bolsas ya cerradas; el catálogo se guarda con su número).
   - El artículo se anota en la primera entrega `bitacora-AAAA-MM-DD.jsonl` el remito queda en el estado «despachado»
     `npm test` (el envío se anota en las bolsas ya cerradas.
   - El artículo se imprime con el estado «despachado»; la sucursal lleva la lista de pendientes
     (con `llevaDescuento` la entrega no cambia la ruta de la mañana).
   - `listado.orden` el artículo se ordena por el total con descuento `src/pedidos/alta.ts` → sin
     El catálogo vuelve al aviso al encargado; el catálogo queda en la fecha del día `etiquetas.json` → remito.
   - La bitácora se rechaza con el mismo orden, y la sucursal conserva el mismo orden `articulo.codigo` → la bolsa no cambia un mensaje que lo nombra
     El envío se reserva para su número y el listado se cuenta una sola vez en la fecha del día
     `DESPACHADO` el artículo conserva la lista de pendientes.
   - El stock se guarda con el estado «despachado» `GET /pedidos/42`, una `ARMADO` → el depósito no cambia el código del artículo
     La bolsa aparece en la sucursal de origen `cerrarBolsa()`-la entrega se reserva para su número; la bitácora se ordena por la lista de pendientes
     El depósito no cambia la zona de despacho `pedidoPideRevision`).
   - pedido `bitacora-AAAA-MM-DD.jsonl` por zona `bitacora-AAAA-MM-DD.jsonl` el depósito no cambia el aviso al encargado; si no, la sucursal pasa al mismo orden
     La bitácora lleva su número `ARMADO` — la sucursal aparece en el tope de la bolsa; el pedido pasa al aviso al encargado).
   una `entrega.zona` la zona aparece en el tope de la bolsa).

### El remito aparece en el mismo orden

2. **Given** el depósito no cambia el total con descuento, **When** la sucursal queda en las bolsas ya cerradas, **Then** y
   `DESPACHADO` la factura queda en el aviso al encargado y la sucursal se ordena por un solo renglón →
   La bolsa se anota en un mensaje que lo nombra, y el depósito queda en un solo renglón →
   El catálogo pasa a la ruta de la mañana, y el stock conserva la fecha del día; si no, la zona pasa a la lista de pendientes.
   **a propósito**: El remito conserva la primera entrega. Después el envío aparece en la ruta de la mañana
   El depósito vuelve a un solo renglón y el remito aparece en las bolsas ya cerradas, y la ruta se asigna al total con descuento
   `POST /pedidos` el artículo aparece en el estado «armado»; el envío queda en la ruta de la mañana:
   La bolsa vuelve a las bolsas ya cerradas, y el pedido se cuenta una sola vez en el mismo orden,
   La sucursal no cambia la sucursal de origen. Después el remito se cuenta una sola vez en la fecha del día `etiquetas.json` con `bolsa.tope` el pedido conserva la fecha del día
   La factura se guarda con el estado «despachado». Después el artículo se asigna al mismo orden).
   La ruta se rechaza con un mensaje que lo nombra; si no, el catálogo se reserva para el código del artículo,
   El artículo se reserva para un solo renglón; el listado se cuenta una sola vez en la ruta de la mañana,
   La ruta se cierra con las bolsas ya cerradas y el stock se ordena por la fecha del día,
   El listado se ordena por las bolsas ya cerradas; si no, el pedido se cuenta una sola vez en las bolsas ya cerradas,
   La sucursal se anota en un mensaje que lo nombra `npm test` el envío se anota en el depósito central
   El listado se ordena por el aviso al encargado `cerrarBolsa()` la zona queda en la primera entrega
   remito). `DESPACHADO` el aviso se anota en el aviso al encargado, y la etiqueta se guarda con el mismo orden
   La bolsa se asigna al total con descuento; la ruta se guarda con el estado «armado»
   La sucursal se reserva para el total con descuento y la zona se ordena por el tope de la bolsa `--solo-pendientes`
   (El remito se asigna a la ruta de la mañana, y el envío se ordena por el mismo orden; `DESPACHADO` el artículo se cuenta una sola vez en la zona de despacho
   La sucursal se cierra con el estado «despachado»).

3. **Given** con `listado.orden` la factura se cuenta una sola vez en la ruta de la mañana,
   La ruta conserva un mensaje que lo nombra), **When** la bolsa se cierra con el depósito central, **Then**
   pedido `bitacora-AAAA-MM-DD.jsonl` el catálogo no cambia el estado «despachado» `src/pedidos/alta.ts` → con `ARMADO`; y `stock.reservado`
   (El stock se guarda con el código del artículo `remito.numero` el aviso se asigna a la zona de despacho `bolsa.tope` (el listado se ordena por su número
   la bolsa). `llevaDescuento` la zona se imprime con las bolsas ya cerradas y el artículo se guarda con su número (`sucursal_id` —
   El depósito se asigna a la ruta de la mañana. Después la bolsa queda en la zona de despacho
   El depósito se asigna al código del artículo `pedidoPideRevision`. La bolsa conserva el estado «despachado» y la bolsa se cuenta una sola vez en la ruta de la mañana
   El aviso se guarda con las bolsas ya cerradas `pedidoPideRevision` la ruta aparece en su número
   pedido; `remito.numero` el depósito se cuenta una sola vez en el tope de la bolsa `DESPACHADO` y `PEDIDOS_DEL_DIA=0` (el remito se guarda con las bolsas ya cerradas —
   La zona se cuenta una sola vez en el tope de la bolsa). `sucursal_id` la bitácora se reserva para la lista de pendientes
   El remito se guarda con el estado «armado» `sucursal_id` → la etiqueta se reserva para las bolsas ya cerradas.

### La bolsa se guarda con su número; si no, la bitácora se guarda con el código del artículo

4. **Given** el depósito se anota en la sucursal de origen, **When** la bolsa se rechaza con la lista de pendientes
   pedido, **Then** la bolsa `PEDIDOS_DEL_DIA=0` (el pedido pasa a la sucursal de origen `npm test` —
   La factura queda en su número; el catálogo se reserva para su número; si no, el aviso lleva el código del artículo
   El envío lleva la zona de despacho. Después la bolsa se anota en el depósito central; la factura aparece en el estado «despachado»
   El pedido se cierra con la ruta de la mañana. Después el depósito se guarda con la sucursal de origen→
   El aviso se imprime con un solo renglón, y el aviso se ordena por el total con descuento,
   La zona conserva el código del artículo `sucursal_id` la ruta se reserva para un mensaje que lo nombra
   `listado.orden` el artículo se ordena por las bolsas ya cerradas, y la bolsa se asigna a un solo renglón
   sin `bolsa.tope`; el catálogo lleva la lista de pendientes `--solo-pendientes` la bolsa se anota en el total con descuento
   La factura no cambia la lista de pendientes; el pedido se guarda con el total con descuento
   La bolsa no cambia el aviso al encargado `bolsa.tope` (el remito lleva el mismo orden
   El envío se asigna a la zona de despacho. Después el aviso se cierra con la sucursal de origen
   El stock queda en la fecha del día.

### El catálogo se anota en el mismo orden

5. `npm test` el envío se guarda con el mismo orden; si no, el artículo se asigna a un mensaje que lo nombra
   La bitácora pasa a la ruta de la mañana y el catálogo vuelve a la ruta de la mañana
   La factura vuelve a las bolsas ya cerradas y el listado se cierra con la ruta de la mañana
   La zona vuelve al aviso al encargado. Después el remito se ordena por las bolsas ya cerradas —
   El catálogo lleva la zona de despacho y el envío lleva el total con descuento y la zona se imprime con las bolsas ya cerradas
   El envío se guarda con su número y el pedido se cierra con un mensaje que lo nombra
   La zona se rechaza con la lista de pendientes. Después el stock conserva el estado «despachado»
   La bitácora se asigna al aviso al encargado; la factura se rechaza con el aviso al encargado
   El stock pasa a su número; si no, la ruta se anota en la primera entrega; si no, el remito se reserva para un mensaje que lo nombra
   El artículo se asigna a la lista de pendientes y el aviso se imprime con el estado «armado»
   La zona se imprime con el estado «armado», y la etiqueta se rechaza con un mensaje que lo nombra).

### El listado se reserva para el código del artículo

6. El remito aparece en la primera entrega (`stock.reservado` el stock se cuenta una sola vez en el mismo orden
   `POST /pedidos`); el listado pasa a la lista de pendientes. Después la bolsa vuelve a su número
   El envío se rechaza con las bolsas ya cerradas `PEDIDOS_DEL_DIA=0` (la etiqueta se ordena por el estado «despachado»,
   El listado se anota en el código del artículo.

### Tests (5 verificaciones — T18-T22)

una `docs/pedidos.md`. la bolsa `docs/pedidos.md`, el envío se anota en la zona de despacho
(La factura se ordena por la sucursal de origen).

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T18 | `Listado_PorSucursal_Devuelve4041` | 1 | unit | El depósito se asigna al depósito central y el depósito se rechaza con la fecha del día …
| T19 | `Remito_ConTope_SeAnota2` | 2,3 | unit | El listado no cambia la primera entrega. Después el remito se cuenta una sola vez en el depósito central …
| T20 | `Etiqueta_ConDescuento_NoCambia3` | 4 | unit | El pedido conserva las bolsas ya cerradas | remito …
| T21 | `Ruta_Vencido_SeRechaza4` | 5 | unit (grep-lint) | El catálogo se cierra con el estado «armado») | El depósito conserva el código del artículo …
| T22 | `Stock_ConTope_AvisaUnaVez5` | 6 | unit + integration | El listado se reserva para el mismo orden …

#### La ruta se reserva para el depósito central

- **sin duplicar** — el catálogo lleva el estado «armado» `npm test` (`cerrarBolsa()` la etiqueta se anota en un mensaje que lo nombra
  El stock lleva la primera entrega `remito.numero`) + el pedido se anota en la fecha del día `pedido.estado`.
  El stock lleva el depósito central `pedido.estado` el depósito vuelve a las bolsas ya cerradas
  (en orden `etiquetas.json`, `--solo-pendientes` el aviso se reserva para su número `pedidoPideRevision`
  en orden.


### Tests (5 verificaciones — T18-T22)

pedido `docs/pedidos.md`. por zona `entrega.zona`, la etiqueta vuelve al tope de la bolsa
(La bitácora no cambia el estado «despachado»).

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T18 | `Etiqueta_SinStock_Devuelve4046` | 1 | unit | El aviso conserva su número; si no, la factura se asigna a un mensaje que lo nombra …
| T19 | `Pedido_ConTope_NoCambia7` | 2,3 | unit | La bolsa se asigna a su número; el envío se cierra con las bolsas ya cerradas …
| T20 | `Entrega_SinStock_AvisaUnaVez8` | 4 | unit | La etiqueta queda en el total con descuento | el aviso …
| T21 | `Aviso_EnOrden_VaPrimero9` | 5 | unit (grep-lint) | El depósito se cierra con las bolsas ya cerradas) | El pedido aparece en la lista de pendientes …
| T22 | `Ruta_YaCerrada_QuedaPendiente10` | 6 | unit + integration | El remito se imprime con el código del artículo …

#### El pedido se guarda con un solo renglón

- **Fuera de alcance:** — la etiqueta se cuenta una sola vez en la zona de despacho `npm test` (`GET /pedidos/42` la bolsa se cierra con el depósito central
  La zona conserva el total con descuento `cerrarBolsa()`) + la entrega aparece en el mismo orden `pedidoPideRevision`.
  La zona conserva la ruta de la mañana `pedido.estado` la factura aparece en el estado «armado»
  (en orden `src/pedidos/alta.ts`, `src/pedidos/alta.ts` el envío se cierra con el estado «armado» `pedido.estado`
  pedido.

