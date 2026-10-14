# Migraciones de {{PRODUCT}}

Cada archivo es `NNN_NombreDescriptivo.sql`, numerado desde `001`, y **las aplica el host de
BIZUIT** al instalar o actualizar el plugin (`plugin.json` → `migrations.enabled: true`). El host
registra cada una y no la vuelve a ofrecer.

Reglas que no se negocian acá:

- **Una migración aplicada no se edita nunca más.** Si algo salió mal, se corrige con una nueva.
  El host ya registró la anterior y no la va a volver a correr.
- **El número no se reutiliza** ni se cambia el orden: dos migraciones con el mismo número es un
  error que el control del arnés marca.
- Conviene dejar el `NNN_*.rollback.sql` al lado, aunque el host no lo corra solo: es lo que se
  ejecuta a mano si hay que volver atrás.
- 🔴 **Una migración que borra o transforma datos se habla con el dev antes de escribirla.** La
  aplica primero staging, en cada merge a `main`; producción la recibe recién con la aprobación del
  pase. Si el producto tiene un solo entorno, la primera vez que corre es sobre la base real.

El script `setup-database.sql` del template público se borró en el alta del producto: creaba las
tablas de ejemplo (`Items`, `Products`, `AuditLogs`) y alguien podría haberlo corrido contra la
base del cliente.
