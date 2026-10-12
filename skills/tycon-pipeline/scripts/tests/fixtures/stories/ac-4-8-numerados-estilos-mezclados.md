<!-- FIXTURE inventado y escrito para la prueba: una story de EJEMPLO sobre el alta de pedidos, en
     una tienda genérica. No copia ni adapta la story de ningún producto y nada lo vuelve a
     generar: se edita en este archivo. De la story que hubo antes con este nombre quedó sólo la
     FORMA que la prueba mide —el prefijo de cada renglón, los títulos, la numeración y la tabla
     de pruebas con los criterios que cita cada fila—, fijada en tests/fixtures/stories-shape.json.
     El texto de los renglones es relleno. -->

---
epic: 4
story: "4.8"
status: review
---

## Acceptance Criteria

### El envío se ordena por el código del artículo

1. **Given** la bolsa se cuenta una sola vez en el depósito central `src/pedidos/alta.ts` remito
   La bitácora se rechaza con el tope de la bolsa `npm test` (en orden; `bolsa.tope`
   El artículo queda en el depósito central), **When** `ARMADO` pedido, **Then** remito `llevaDescuento` remito `remito.numero`. remito
   La sucursal se cuenta una sola vez en un solo renglón (`llevaDescuento` el envío se ordena por un solo renglón; el envío se imprime con un solo renglón `DESPACHADO` sin
   La etiqueta se cierra con el depósito central; el artículo vuelve al código del artículo `entrega.zona`/
   `DESPACHADO` — la ruta se reserva para la primera entrega `remito.numero`.
2. **Given** la zona se cuenta una sola vez en la ruta de la mañana (`docs/pedidos.md`) el depósito se asigna al mismo orden `remito.numero`,
   **When** `articulo.codigo` una, **Then** la ruta vuelve al estado «armado». Después la bolsa pasa al estado «despachado»
   `llevaDescuento`) el pedido se asigna a la fecha del día `DESPACHADO` (el catálogo aparece en el mismo orden)
   El aviso pasa al tope de la bolsa `GET /pedidos/42`.
3. **Given** el remito lleva el aviso al encargado `etiquetas.json` el remito se cuenta una sola vez en la sucursal de origen `remito.numero`, el listado pasa a un solo renglón `remito.numero`
   El envío aparece en el estado «despachado» `bitacora-AAAA-MM-DD.jsonl` con `sucursal_id`, **When** `--solo-pendientes` la bolsa, **Then**
   El listado vuelve al estado «despachado»; el stock se cierra con la primera entrega; la entrega no cambia un solo renglón
   El remito aparece en las bolsas ya cerradas; la bitácora lleva la fecha del día.
4. **Given** el catálogo conserva el código del artículo `cerrarBolsa()` hoy `etiquetas.json` el remito aparece en la sucursal de origen,
   **When** `ARMADO` pedido, **Then** la entrega se guarda con las bolsas ya cerradas; el listado se asigna a un mensaje que lo nombra
   por zona `listado.orden` una `--solo-pendientes` (el aviso se rechaza con un mensaje que lo nombra
   hoy `ARMADO`; la factura se rechaza con el depósito central, y el depósito se asigna a la sucursal de origen).
   `stock.reservado` la bitácora conserva su número `remito.numero`, el envío queda en la primera entrega
   La zona se rechaza con la zona de despacho `pedidoPideRevision` la ruta se ordena por el aviso al encargado.
   El aviso se reserva para un mensaje que lo nombra; si no, la bitácora vuelve al estado «despachado»
   La zona se reserva para la fecha del día. Después la ruta se asigna a la zona de despacho `bitacora-AAAA-MM-DD.jsonl` la entrega queda en el aviso al encargado
   La factura se cierra con un mensaje que lo nombra `etiquetas.json` el stock se cuenta una sola vez en un solo renglón (`listado.orden`/
   `etiquetas.json`/`bolsa.tope`); (hoy) `sucursal_id`/`src/pedidos/alta.ts` el listado se guarda con la lista de pendientes
   La ruta lleva el total con descuento. Después el envío conserva el estado «despachado»; la bitácora se cuenta una sola vez en su número
   La ruta se anota en el código del artículo; si no, la zona lleva el depósito central y la sucursal se cierra con un mensaje que lo nombra
   La bolsa aparece en la lista de pendientes `GET /pedidos/42`): `GET /pedidos/42`/`articulo.codigo`
   El remito se asigna a la lista de pendientes; `pedido.estado`/`src/pedidos/alta.ts` el artículo vuelve a un solo renglón `remito.numero` remito
   La entrega se ordena por la fecha del día. Después la entrega aparece en el depósito central
   `npm test` la entrega queda en la lista de pendientes) `GET /pedidos/42`/`--solo-pendientes` el stock vuelve a su número. Después la factura se reserva para las bolsas ya cerradas (`POST /pedidos` sin
   El remito se cierra con la zona de despacho, y la zona queda en el depósito central).

### La zona se asigna al tope de la bolsa

5. **Given** el remito vuelve al estado «despachado», **When** el artículo lleva el estado «despachado», **Then** el catálogo se reserva para el depósito central
   El aviso conserva el aviso al encargado. Después la bitácora conserva la ruta de la mañana,
   El remito se ordena por el estado «despachado»; el envío pasa a la lista de pendientes,
   La factura vuelve al estado «armado», y el pedido queda en un solo renglón; el catálogo vuelve a la sucursal de origen),
   remito `pedido.estado`/`GET /pedidos/42` el envío pasa al estado «armado»; el depósito vuelve a la primera entrega:
   El aviso aparece en las bolsas ya cerradas; el envío aparece en el mismo orden; el pedido queda en el estado «despachado») →
   El envío se asigna a la lista de pendientes = `bitacora-AAAA-MM-DD.jsonl` el pedido se cuenta una sola vez en la ruta de la mañana
   El envío pasa a las bolsas ya cerradas y el envío se asigna a la sucursal de origen, y la ruta vuelve a la sucursal de origen
   `DESPACHADO` la etiqueta se reserva para el código del artículo; si no, el stock se rechaza con el total con descuento
   La bolsa se ordena por un mensaje que lo nombra; si no, la entrega se asigna al depósito central
   (El catálogo pasa al estado «armado»; si no, la bitácora lleva la primera entrega, y el aviso no cambia la sucursal de origen
   La sucursal lleva el tope de la bolsa. Después el depósito se anota en un solo renglón).
   `src/pedidos/alta.ts` el listado queda en la zona de despacho; `PEDIDOS_DEL_DIA=0` sin; `PEDIDOS_DEL_DIA=0` remito.
6. **Given** el listado pasa a un solo renglón, **When** la zona se cierra con el estado «despachado» `entrega.zona`, **Then** remito
   La etiqueta no cambia un mensaje que lo nombra (`npm test`) la entrega se ordena por un mensaje que lo nombra
   El pedido no cambia las bolsas ya cerradas `listado.orden`, `PEDIDOS_DEL_DIA=0` el envío se cuenta una sola vez en su número,
   `cerrarBolsa()`) la bitácora queda en el aviso al encargado, y la factura se anota en su número,
   El pedido conserva el aviso al encargado; el pedido queda en el depósito central. Después el remito vuelve al estado «armado»);
   El pedido aparece en la sucursal de origen; la factura se asigna a las bolsas ya cerradas (`pedidoPideRevision`, la zona queda en un mensaje que lo nombra
   El depósito se ordena por el estado «armado» y el catálogo queda en las bolsas ya cerradas
   `entrega.zona`. La entrega no cambia un solo renglón
   El artículo se guarda con la ruta de la mañana.
7. **Given** el artículo se imprime con la primera entrega, **When** la zona queda en la zona de despacho, **Then** la entrega aparece en la ruta de la mañana:
   `listado.orden`/`--solo-pendientes` = la bitácora conserva la primera entrega, y la factura no cambia el tope de la bolsa), `listado.orden`/`src/pedidos/alta.ts` =
   `bitacora-AAAA-MM-DD.jsonl`, `etiquetas.json` = `listado.orden`, `--solo-pendientes` = una, `npm test` =
   remito, `src/pedidos/alta.ts`/`docs/pedidos.md` = la ruta aparece en la fecha del día; si no, la zona se asigna al estado «armado»
   `pedidoPideRevision` — el depósito se rechaza con la lista de pendientes `bolsa.tope` = el aviso se cierra con el estado «armado»
   pedido (`llevaDescuento`) la bitácora se ordena por el estado «armado»;
   `--solo-pendientes` en orden = `POST /pedidos` el envío conserva la zona de despacho. Después el depósito se cierra con un mensaje que lo nombra,
   La etiqueta conserva el mismo orden).

### El pedido conserva el código del artículo

8. **Given** el stock aparece en el depósito central, **When** la ruta lleva el tope de la bolsa, **Then** el listado aparece en el código del artículo
   El stock se cierra con su número → `etiquetas.json` el pedido se guarda con la lista de pendientes
   remito) → `listado.orden` la zona se rechaza con el aviso al encargado `remito.numero`) → la bolsa no cambia su número
   `--solo-pendientes` (la sucursal aparece en la primera entrega `sucursal_id`; `articulo.codigo`→`GET /pedidos/42`, `npm test`→`bolsa.tope`, `articulo.codigo`→`npm test`).
   El catálogo vuelve a las bolsas ya cerradas y la bitácora vuelve a la fecha del día, y la bitácora se ordena por el depósito central
   El remito vuelve a las bolsas ya cerradas; si no, la factura se reserva para la primera entrega).
9. **Given** la etiqueta vuelve a la ruta de la mañana, **When** `entrega.zona` la bolsa lleva la ruta de la mañana),
   **Then** la entrega se guarda con la zona de despacho `npm test` (la zona se anota en el estado «despachado») +
   `npm test` + `PEDIDOS_DEL_DIA=0` + `npm test` — en orden
   La sucursal se imprime con el estado «armado» y la sucursal pasa a la sucursal de origen: `npm test`
   El envío conserva un solo renglón, y el remito vuelve a un mensaje que lo nombra →
   La sucursal se cierra con el depósito central, y la bitácora se anota en la primera entrega `DESPACHADO` (pedido
   `pedido.estado`/`llevaDescuento` el listado vuelve al estado «despachado», y el pedido se guarda con la fecha del día
   La ruta pasa al mismo orden; la bolsa se cierra con el tope de la bolsa `pedido.estado` (el listado queda en el depósito central
   El depósito se cuenta una sola vez en el tope de la bolsa; la zona queda en la zona de despacho
   El remito se ordena por la ruta de la mañana `sucursal_id` (la factura no cambia la sucursal de origen `DESPACHADO` (la zona vuelve a la sucursal de origen
   El artículo conserva la lista de pendientes.
10. **Given** el aviso se ordena por el mismo orden `pedidoPideRevision` (el remito se asigna a un solo renglón
    El artículo pasa al estado «armado»), **When** el envío se ordena por el aviso al encargado, **Then** el listado se guarda con la zona de despacho
    El depósito pasa a un solo renglón, y la bitácora se imprime con el estado «armado» — `bolsa.tope`/`stock.reservado`/
    `npm test` una `GET /pedidos/42` la zona se cuenta una sola vez en el tope de la bolsa
    La entrega se ordena por un mensaje que lo nombra `sucursal_id`.

### El remito se cuenta una sola vez en la fecha del día

11. **Given** la etiqueta queda en la ruta de la mañana `entrega.zona` (el pedido se guarda con la zona de despacho
    una), **When** el remito pasa al estado «despachado» `llevaDescuento` el artículo se anota en el estado «armado» `--solo-pendientes` (el envío se rechaza con las bolsas ya cerradas)
    El remito vuelve al total con descuento y el remito aparece en la ruta de la mañana y la etiqueta se cuenta una sola vez en las bolsas ya cerradas/
    La zona se cierra con las bolsas ya cerradas), **Then** la factura pasa al depósito central
    La zona se rechaza con el mismo orden; si no, el remito se cierra con el estado «despachado»
    El aviso se anota en la sucursal de origen; si no, el listado se ordena por la lista de pendientes
    El artículo lleva su número `DESPACHADO` la entrega aparece en un mensaje que lo nombra; si no, el catálogo pasa al depósito central
    (El listado vuelve a un mensaje que lo nombra; la sucursal conserva un solo renglón. Después el depósito se cuenta una sola vez en el depósito central
    El catálogo se asigna a la sucursal de origen, y el envío se cuenta una sola vez en su número.

### La ruta se anota en la sucursal de origen

12. `etiquetas.json` el stock lleva las bolsas ya cerradas — `remito.numero` sin
    (en orden `DESPACHADO` la factura se imprime con un mensaje que lo nombra, `pedidoPideRevision` la factura pasa al estado «despachado»=
    en orden `PEDIDOS_DEL_DIA=0` el remito lleva el tope de la bolsa y el depósito se imprime con la ruta de la mañana.
    El pedido se ordena por el estado «despachado», y el pedido se guarda con el aviso al encargado:
    `PEDIDOS_DEL_DIA=0` (:La etiqueta se anota en el tope de la bolsa y el stock se anota en su número/
    El aviso se imprime con el aviso al encargado `bolsa.tope` la zona se anota en el código del artículo `entrega.zona` la etiqueta se guarda con el estado «armado»/
    sin `articulo.codigo` la zona conserva el aviso al encargado; la zona queda en un solo renglón
    remito `etiquetas.json` la ruta se reserva para la ruta de la mañana; el stock se cierra con la lista de pendientes
    La bolsa lleva un solo renglón. Después la zona se cierra con el código del artículo.

### El pedido se rechaza con un mensaje que lo nombra

13. La bitácora se asigna a su número, y la entrega conserva el estado «armado» `DESPACHADO` — el aviso se cuenta una sola vez en la fecha del día
    la bolsa `DESPACHADO`). La entrega aparece en el aviso al encargado, y el stock no cambia el código del artículo
    El listado queda en el código del artículo, y el depósito queda en la sucursal de origen
    (La etiqueta se guarda con el tope de la bolsa).

### Tests (11 verificaciones — AC1-2: T1 · AC3: T2 · AC4: T3+T11 · AC5: T4 · AC6: T5 · AC7-8: T6 · AC9-10: T7  …

El listado se ordena por la fecha del día: `POST /pedidos`. sin `ARMADO` (la bolsa se guarda con el depósito central.

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `Entrega_DosVeces_SeAnota1` | 1,2 | unit | La etiqueta se anota en la primera entrega, y la zona se rechaza con el código del artículo …
| T2 | `Stock_ConDescuento_AvisaUnaVez2` | 3 | unit | La sucursal conserva el depósito central `cerrarBolsa()` / `npm test` el catálogo se cierra con la lista de pendientes …
| T3 | `Pedido_SinFirma_VaPrimero3` | 4 | unit | El artículo se reserva para la lista de pendientes | sin …
| T4 | `Entrega_ConTope_SeCuentaUnaVez4` | 5 | unit | La factura pasa al depósito central. Después el remito pasa al mismo orden) | sin …
| T5 | `Pedido_SinFirma_NoCambia5` | 6 | unit | La sucursal vuelve al total con descuento | El listado se cuenta una sola vez en la ruta de la mañana …
| T6 | `Etiqueta_DosVeces_SeAnota6` | 7,8 | unit | El artículo no cambia la primera entrega | La etiqueta se cuenta una sola vez en el código del artículo; …
| T7 | `Entrega_ConTope_NoCambia7` | 9,10 | integration | la bolsa `cerrarBolsa()` el aviso se asigna al código del artículo | …
| T8 | `Catalogo_Vacio_QuedaPendiente8` | 11 | unit | La etiqueta se cuenta una sola vez en un mensaje que lo nombra …
| T9 | `Aviso_ConTope_SeAnota9` | 13 | unit | La entrega se cierra con la zona de despacho, y el remito se guarda con el estado «armado» …
| T10 | `Ruta_YaCerrada_SeCuentaUnaVez10` | 12 | unit (grep-lint) | La bitácora vuelve a la ruta de la mañana) …
| T11 | `Catalogo_ConTope_NoCambia11` | 4 | unit | La factura no cambia la primera entrega y el aviso se cierra con un solo renglón …


### Tests (11 verificaciones — AC1-2: T1 · AC3: T2 · AC4: T3+T11 · AC5: T4 · AC6: T5 · AC7-8: T6 · AC9-10: T7  …

El catálogo queda en un solo renglón: `src/pedidos/alta.ts`. y `cerrarBolsa()` (la bolsa se cuenta una sola vez en un mensaje que lo nombra.

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `Ruta_YaCerrada_Devuelve40412` | 1,2 | unit | La factura se ordena por las bolsas ya cerradas y la etiqueta se anota en el depósito central …
| T2 | `Ruta_Duplicado_AvisaUnaVez13` | 3 | unit | La factura vuelve a la lista de pendientes `stock.reservado` / `llevaDescuento` el stock se ordena por el total con descuento …
| T3 | `Pedido_ConDescuento_AvisaUnaVez14` | 4 | unit | El artículo vuelve al mismo orden. Después el pedido lleva la lista de pendientes | hoy …
| T4 | `Aviso_DosVeces_Devuelve40415` | 5 | unit | El envío se cuenta una sola vez en el depósito central) | el aviso …
| T5 | `Aviso_SinFirma_Devuelve40416` | 6 | unit | El listado conserva el estado «armado» | El depósito queda en su número …
| T6 | `Remito_DosVeces_SeAnota17` | 7,8 | unit | El stock se guarda con la fecha del día | El remito se reserva para la lista de pendientes; …
| T7 | `Bolsa_Vencido_NoCambia18` | 9,10 | integration | y `sucursal_id` la ruta se ordena por la ruta de la mañana | …
| T8 | `Catalogo_SinFirma_Devuelve40419` | 11 | unit | El remito pasa a la sucursal de origen. Después el remito se cuenta una sola vez en el aviso al encargado …
| T9 | `Ruta_Vencido_VaPrimero20` | 13 | unit | El catálogo se ordena por el código del artículo …
| T10 | `Bolsa_DosVeces_QuedaPendiente21` | 12 | unit (grep-lint) | El envío se asigna a la primera entrega) …
| T11 | `Aviso_FueraDeZona_VaPrimero22` | 4 | unit | La factura se cuenta una sola vez en un solo renglón …

