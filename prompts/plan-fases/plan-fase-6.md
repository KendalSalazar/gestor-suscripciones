# Plan Fase 6 — Notificaciones internas y anomalías

Plan para este proyecto individual de aprendizaje. **Un bloque pequeño por
entrega**, con explicación, comprobación y parada antes de avanzar. El alcance
está en [06-fase.md](../06-fase.md). No iniciar la Fase 7 durante estas entregas.

**Estado al 5 de noviembre de 2026: bloques 1 a 7 completados.** El generador
guarda avisos iniciales y las confirmaciones personal y familiar avisan de
importes diferentes. El detector de vencimientos está implementado, pero aún no
se ejecuta automáticamente; la CLI, el ciclo horario, la API y la interfaz siguen pendientes.

## 0. Entrada contrastada con el repositorio

Carpeta de trabajo y raíz Git: `E:\repos vsc\gestor-suscripciones`; árbol limpio
antes de redactar este plan, último commit `a0005e8`. Leídos AGENTS.md,
frontend/AGENTS.md, la skill desarrollo-por-bloques, el alcance original y los
planes de Fases 4 y 5. La Fase 5 tiene cierre registrado el 27 de octubre de 2026:
978 pruebas backend con PostgreSQL, comprobaciones de compilación y lint, y
recorrido manual confirmado por el propietario. Es evidencia previa; no se
volvieron a ejecutar esas pruebas para redactar el plan.

Al redactar el plan, el código confirmaba estos puntos de partida:

- Migraciones `001`–`008`; todavía no había tabla, módulo, API ni página de notificaciones.
- `runDuePayments(today, subscriptionId?)` bloquea primero grupos, luego
  suscripciones, crea pago/partes y avanza fechas en una transacción. Conserva
  los límites de 100 grupos, 100 suscripciones y 24 ciclos por suscripción.
- `resolvePayment` confirma pagos personales o permite omitir un conjunto
  familiar intacto. `confirmPaymentShare` confirma únicamente la parte propia
  y cierra el padre al completar todas. Ambos revalidan rol tras bloquear grupo.
- `price_changed` compara importes NUMERIC y significa diferencia, incluso
  disminución. En familia solo se fija al completar el padre.
- `startPaymentScheduler` ejecuta al inicio y cada hora, impide solapamientos
  locales y espera su corrida activa al detenerse. `server.ts` aplica migraciones
  antes de iniciarlo y cierra el pool después de detenerlo.
- El comando `payments:generate` ya puede limitarse por UUID de suscripción.
- El dashboard mantiene Suscripciones, Pagos y Familia; recarga al entrar a una
  vista y conserva borradores del mismo grupo/rol. Usa tokens en memoria y refresh
  coordinado por cookie. No hay infraestructura de pruebas de frontend instalada.

**Precondición del bloque 1:** contrastar otra vez estos archivos y el estado Git.
La lectura actual no inspeccionó una base en ejecución. Antes de aplicar 009 se
comprobarán migraciones y datos reales sin repararlos ni borrarlos.

El esquema de `notifications` de `01-fase.md` era orientativo. Este plan lo
concreta con referencia al pago, tipos específicos y fecha de creación. El grupo
y la suscripción se derivan del pago; no se añade `sent_at` porque no hay envío
externo ni se persisten mensajes que puedan desincronizar importes y nombres.

### Bloque 1 — Entrada y reglas revisadas (4 de noviembre de 2026)

- [x] Carpeta de trabajo y raíz Git coinciden. El commit actual es `a0005e8` y
  los dos documentos de Fase 6 están sin seguimiento en Git; se conservaron.
- [x] Leídos AGENTS.md, frontend/AGENTS.md, la skill desarrollo-por-bloques, el
  alcance de Fase 6 y este plan. El cierre de Fase 5 se consultó como evidencia
  previa, incluida la validación manual comunicada por el propietario.
- [x] En el código se localizaron las migraciones 001–008, el generador y su
  transacción, las confirmaciones personal y familiar, las comprobaciones de
  membresía, el programador horario y las tres vistas actuales del dashboard.
  No se encontró implementación de notificaciones en esas rutas o módulos.
- [x] Contrastado que `price_changed` expresa desigualdad de importes NUMERIC;
  una diferencia menor también lo activa. En familia se calcula al completarse
  todas las partes. Se mantiene el mensaje previsto de «importe diferente».
- [x] Revisados los destinatarios propios, el umbral propuesto de siete días
  naturales desde `expected_date`, la conservación del historial y la exclusión
  de miembros inactivos. Son reglas de diseño para los bloques posteriores.
- [x] `PAYMENT_TIME_ZONE`, el ciclo inicial/horario y el cierre del scheduler ya
  existen. El futuro detector se incorporará en su bloque sin asumir que ya funciona.

La comprobación de este bloque fue lectura del repositorio y documentación; no
se inspeccionó PostgreSQL ni se ejecutaron pruebas. Las 978 pruebas registradas
para Fase 5 son evidencia anterior. La comprobación de la base real y la migración
009 corresponden al bloque 2. Aquí solo se actualizó este plan.

### Bloque 2 — Datos de notificaciones comprobados (4 de noviembre de 2026)

- [x] Previo a la migración: PostgreSQL 16.15, base local `subscripciones_db`,
  esquema `public`; el runner de la aplicación apunta a la misma instancia.
  Estaban registradas 001–008 y no existían la tabla ni el tipo de notificaciones.
- [x] Creada [009_create_notifications.sql](../../backend/src/db/migrations/009_create_notifications.sql):
  tipo obligatorio, seis columnas, FK RESTRICT a usuario y pago, unicidad por
  usuario/pago/tipo e índices de listado y avisos no leídos. Las fechas usan
  precisión de milisegundos; no hay backfill ni modificaciones de pagos o partes.
- [x] Aplicado el runner compilado desde `backend`: registró 009 una sola vez;
  la segunda ejecución informó que no había migraciones pendientes. La
  idempotencia comprobada es la del runner, no la ejecución directa del SQL.
- [x] Inspección de `public`: seis columnas, cuatro constraints, cuatro índices
  contando PK y UNIQUE, tres valores del enum y cero notificaciones iniciales.
  Los conteos anteriores y posteriores coincidieron: 11 usuarios, 13 grupos,
  14 membresías, tres suscripciones, dos pagos, tres partes y dos invitaciones.
  La igualdad de conteos no demuestra por sí sola que cada fila sea idéntica.
- [x] [Pruebas de 009](../../backend/src/db/notifications-migration.int.test.ts):
  15 aprobadas con `RUN_DB_TESTS=1`, en esquema temporal exclusivo ya eliminado.
  Comprobaron snapshots de fixtures anteriores, ausencia de backfill, nulabilidad,
  unicidad, FK, restricciones de borrado, precisión/desempate del cursor y rollback.
- [x] Suite habitual sin el flag: 647 aprobadas y 346 omitidas de integración;
  el valor de `RUN_DB_TESTS` se conservó. Typecheck y build de backend correctos.
  Revisión independiente del SQL y las pruebas sin hallazgos pendientes.

La tabla aún no crea ni muestra avisos por sí sola: esas operaciones corresponden
a los bloques siguientes. Las pruebas con base real de este bloque fueron las 15
de migración; la suite completa de 978 registrada en Fase 5 no se repitió aquí.

### Bloque 3 — Tipos, mensajes e inserción interna (4 de noviembre de 2026)

- [x] Añadido `modules/notifications/notification.types.ts` con los tres tipos y
  el DTO previsto para el destinatario. Reutiliza los estados de pagos/partes y
  conserva importes y fechas como strings. La API sigue correspondiendo al bloque 10.
- [x] `notification-messages.ts` prepara textos controlados para los tres hechos;
  la diferencia de importe no afirma una subida del proveedor. Tres pruebas
  unitarias comprueban los mensajes sin consultar la base.
- [x] `notification-writer.ts` recibe un `PoolClient`, un pago, un tipo y los
  destinatarios internos. Inserta en lote con parámetros, UUID ordenados y
  deduplicados por PostgreSQL y `ON CONFLICT DO NOTHING`. Devuelve cuántas filas
  se insertaron; una lista vacía devuelve cero sin consultar la base.
- [x] La función no abre conexiones ni ejecuta BEGIN/COMMIT/ROLLBACK. El llamador
  debe aportar una transacción activa y seleccionar destinatarios autorizados;
  exigir `PoolClient` ayuda a evitar pasar el pool, pero no demuestra por sí solo
  que exista una transacción. Los errores de PostgreSQL se propagan.
- [x] Seis pruebas de integración con PostgreSQL en esquema temporal exclusivo:
  lote y UUID repetidos con distintas mayúsculas, lista vacía, repetición que
  conserva lectura, rollback compartido y error de FK. Una prueba deja una
  transacción abierta y confirma mediante `pg_blocking_pids` que otra espera
  antes de completar el reintento; no cubre todos los posibles interbloqueos.
- [x] Con `RUN_DB_TESTS=1`: nueve pruebas aprobadas en dos archivos. Sin el flag:
  tres aprobadas y seis omitidas. Typecheck y build de backend correctos. Se
  restauró el valor de la variable; el esquema temporal quedó eliminado y la
  tabla real continuó con cero avisos.
- [x] Revisión independiente cerrada tras exigir `PoolClient` completo y reforzar
  la sincronización de la prueba concurrente. No se conectó el auxiliar a pagos
  ni se añadieron rutas o pantallas en este bloque.

### Bloque 4 — Avisos iniciales al generar pagos (4 de noviembre de 2026)

- [x] El generador llama al auxiliar con el mismo cliente solo al insertar un
  pago nuevo. En personal verifica bajo el bloqueo del grupo la membresía activa
  de su owner; en familia reutiliza los participantes de la foto de partes.
- [x] Pago, partes familiares, avisos `payment_due` y avance de fecha se guardan
  en la misma transacción. Los pagos ya existentes no reciben avisos retroactivos;
  se conserva el resultado público y los límites previos del generador.
- [x] Las pruebas comprueban destinatarios, exclusión de miembros invitados o
  retirados, varios ciclos, repetición, lectura conservada y ausencia de backfill.
  También fuerzan un fallo al insertar avisos y verifican rollback en personal y
  familia, incluido el avance de fecha.
- [x] Suite dirigida con `RUN_DB_TESTS=1`: 66 pruebas aprobadas en cuatro archivos
  de generación y bajas de miembros, incluidas unitarias y PostgreSQL, sin
  omisiones. Typecheck y build de backend correctos; se restauró el flag.
- [x] Regresión completa posterior con `RUN_DB_TESTS=1`: 1012 pruebas aprobadas
  en 38 archivos, sin omisiones; el flag se restauró al terminar.
- [x] Comando CLI compilado comprobado dos veces con un único UUID en un esquema
  temporal: un pago familiar generó dos partes y dos avisos; repetir no duplicó
  registros y otra suscripción vencida quedó intacta. Se eliminó el esquema y el
  script temporal. No se inició el scheduler ni se ejecutó generación global.
- [x] Antes y después se observaron dos pagos, tres partes y cero notificaciones
  en `public`; no quedaron esquemas temporales de prueba. La prueba personal
  existente usa una fixture exclusiva en `public` y la limpia por UUID.
- [x] Revisión independiente del código y pruebas sin fallos funcionales;
  [payments.md](../../backend/docs/payments.md) actualizado con la atomicidad,
  destinatarios y un ejemplo de CLI sin ángulos en PowerShell.

Los avisos ya pueden guardarse al generar pagos nuevos. La consulta mediante API
y la visualización en el centro de notificaciones se implementarán en sus bloques.

### Bloque 5 — Diferencia de importe en pagos personales (4 de noviembre de 2026)

- [x] `payment.service.ts` inserta `amount_changed` para el owner personal activo
  cuando PostgreSQL devuelve `price_changed = true` al confirmar. La comparación
  sigue usando NUMERIC; se mantienen el contrato HTTP y el coste de la suscripción.
- [x] Un importe mayor o menor genera un aviso; el importe esperado, una
  representación decimal equivalente y la omisión no lo generan. La confirmación
  directa de pagos familiares sigue bloqueada y sus avisos son del bloque 6.
- [x] Confirmación y aviso usan el mismo cliente y se guardan antes del COMMIT.
  Un error al insertar el aviso revierte la confirmación, sin alterar avisos
  previos. Repetir una confirmación resuelta conserva el 409 existente.
- [x] La prueba aislada cubre los importes, cero, omisión, confirmaciones
  concurrentes, permisos, bloqueo familiar y rollback forzado con CHECK limitado
  a su esquema temporal. La prueba anterior de resolución en `public` limpia
  primero los avisos de los pagos identificados por los UUID de su fixture.
- [x] Suite completa con `RUN_DB_TESTS=1`: 1025 pruebas aprobadas en 39 archivos,
  sin omisiones. Typecheck y build de backend correctos; se restauró el flag.
  La revisión independiente no encontró hallazgos.
- [x] Comprobados cero esquemas temporales restantes y los mismos conteos de
  `public` observados al comienzo: dos pagos, tres partes y cero notificaciones.
  [payments.md](../../backend/docs/payments.md) documenta el aviso y su rollback.

El aviso de diferencia familiar se implementará al completar las partes en el
bloque 6; la API y la pantalla de notificaciones siguen pendientes.

### Bloque 6 — Diferencia de importe en pagos familiares (4 de noviembre de 2026)

- [x] `payment-share.service.ts` crea `amount_changed` únicamente cuando la
  última parte confirma el pago y su total NUMERIC difiere del previsto. Las
  confirmaciones parciales y las diferencias que se compensan no generan aviso.
- [x] Tras bloquear el grupo, el servicio consulta al owner vigente y exige su
  membresía activa coincidente con `groups.owner_id`; puede no tener una parte
  del pago. Si se necesita el aviso y no hay owner coherente, se revierte el cierre.
- [x] Última parte, pago padre y aviso usan el mismo cliente y COMMIT. Las
  pruebas fuerzan un fallo de inserción y comprueban rollback, liberación de
  bloqueos y conservación de una notificación previa marcada como leída.
- [x] Las pruebas aisladas cubren totales mayores y menores, compensación,
  parcial, confirmaciones concurrentes y repetición con 409. Una transferencia
  observada mediante espera de bloqueo verifica que el aviso llega al nuevo owner
  aunque no tuviera parte en la foto original.
- [x] Regresión completa con `RUN_DB_TESTS=1`: 1032 pruebas aprobadas en 39
  archivos, sin omisiones; typecheck y build de backend correctos. Se restauró el
  flag. La revisión independiente no encontró hallazgos.
- [x] Los conteos de `public` coinciden con el comienzo: dos pagos, tres partes y
  cero notificaciones; no quedaron esquemas temporales. Se actualizaron
  [payment-shares.md](../../backend/docs/payment-shares.md) y payments.md.

La consulta y visualización de avisos aún corresponden a los bloques de API e
interfaz. El detector de pagos vencidos comienza en el bloque 7.

### Bloque 7 — Detector de avisos de vencimiento (5 de noviembre de 2026)

- [x] `runOverdueNotifications` recibe una fecha de calendario explícita y
  selecciona pagos pendientes cuya fecha prevista tiene al menos siete días.
  Incluye pagos pendientes de suscripciones desactivadas y de importe cero.
- [x] En grupos personales avisa al owner activo; en familia, a cada miembro
  activo con parte propia pendiente. Comprueba la ausencia del aviso por pago y
  destinatario, conserva los avisos leídos y permite completar destinatarios faltantes.
- [x] Procesa hasta 100 grupos y 200 pagos por ejecución; los avisos ya creados
  no consumen el límite de pagos. Bloquea grupos y pagos, omite los bloqueados
  y consulta nuevamente los destinatarios antes de insertar. Inserciones y
  comprobaciones comparten transacción; un error revierte el lote. No modifica
  pagos, partes ni suscripciones y registra solo conteos o códigos de error seguros.
- [x] Las 21 pruebas de integración cubren fechas límite, destinatarios,
  idempotencia, lotes, rollback y ejecuciones concurrentes. Una confirmación de
  parte con el grupo bloqueado se omite y se evalúa en el siguiente intento.
  La revisión independiente no encontró hallazgos.
- [x] Regresión con `RUN_DB_TESTS=1`: 1053 pruebas aprobadas en 40 archivos;
  typecheck y build correctos. Los conteos de las tablas de trabajo coincidieron
  con los iniciales y no quedaron esquemas temporales de prueba.

El detector aún no está conectado a una CLI ni al ciclo horario. La fecha local
según `PAYMENT_TIME_ZONE`, la API y la interfaz se completarán en bloques posteriores.

## 1. Comportamiento y decisiones de dominio

### 1.1 Tipos y destinatarios

| Tipo | Cuándo nace | Destinatario | Qué comunica |
|---|---|---|---|
| `payment_due` | Se inserta un pago nuevo y sus partes | Owner personal; cada titular de parte familiar | Se generó un registro para esa fecha; revisar su estado actual |
| `payment_overdue` | Obligación todavía pending con fecha de al menos siete días atrás | Owner personal; titular activo de cada parte familiar pending | Sigue sin registrarse la confirmación; no afirma un impago bancario |
| `amount_changed` | Pago confirmado con `price_changed = true` | Owner personal; owner familiar activo al cerrar el padre | El total registrado difiere del esperado, hacia arriba o hacia abajo |

Todos los destinatarios deben ser miembros activos al crear el aviso. En familia
el owner recibe su propio recordatorio si tiene una parte; no recibe una copia
por cada parte ajena pendiente. Quien entró después del reparto no recibe una
obligación retroactiva. No se crean avisos adicionales por confirmar cada parte.

El destinatario de `amount_changed` se decide con el grupo bloqueado en la
transacción del cierre; puede no tener parte en la foto original. Si después se
transfiere la propiedad, no se reenvía la anomalía al nuevo owner. El anterior
conserva su aviso mientras continúe siendo miembro activo.

Ejemplo familiar: previsto `10.00`, partes `5.00` y `5.00`. Owner registra `5.00`,
member registra `4.50`: el total `9.50` cierra con diferencia y el owner recibe
un aviso. No se deduce que el proveedor cambió su precio ni se cambia
`subscriptions.expected_cost`. Siguen vigentes el límite del member y la
excepción del owner sobre su propia cuota.

### 1.2 Fechas y vencimiento

Constante del módulo: `OVERDUE_AFTER_DAYS = 7`. Un pago es candidato si
`status = 'pending' AND expected_date <= today::date - 7` y queda al menos un
destinatario elegible sin su aviso. En familia también se exige la parte pending.

Con fecha prevista `2026-11-01`, el día 7 todavía no corresponde el aviso; el día
8 sí. Usar días de calendario, no horas transcurridas ni la zona del proceso.
`today` se calcula una vez por ciclo con `todayInTimeZone` y `PAYMENT_TIME_ZONE`;
el servicio recibe explícitamente `YYYY-MM-DD` para permitir pruebas deterministas.

Recuperar hoy un pago de hace dos meses puede hacerlo elegible inmediatamente.
No se exige que hayan pasado siete días desde su `created_at`. Suscripciones
desactivadas conservan sus pagos pendientes y deben seguir siendo consideradas.
Cero es un importe válido y no resuelve automáticamente la obligación.

### 1.3 Historial, lectura y ausencia de duplicados

- Unicidad por `(user_id, payment_id, type)`, respaldada por la base. Reintentos
  usan `ON CONFLICT DO NOTHING`; nunca vuelven a poner `read_at = NULL`.
- `read_at` indica que la persona marcó el aviso como leído. No confirma, omite
  ni altera el pago. Abrir la página tampoco marca automáticamente todos los avisos.
- Resolver un pago conserva sus avisos y su condición de lectura. La respuesta
  incluye el estado actual para mostrar que ya no requiere confirmación.
- No se eliminan avisos al salir de una familia: quedan ocultos por falta de
  membresía activa, incluido el conteo. Al reincorporarse reaparecen los propios,
  conservando sus fechas de lectura y sin crear copias.
- Los avisos iniciales y de diferencia solo nacen de operaciones nuevas después
  de integrar sus bloques. El detector sí puede avisar sobre pendientes antiguos.
  La migración no ejecuta backfill ni reconstruye destinatarios históricos.
- Recuperar varios ciclos puede producir varios avisos, uno por pago/tipo. Un
  pago antiguo recién generado puede tener aviso inicial y de vencimiento; no
  habrá un nuevo recordatorio cada día. El centro permite recorrerlos por páginas.

## 2. Persistencia — migración 009

Preparar `backend/src/db/migrations/009_create_notifications.sql`:

| Columna | Tipo y regla |
|---|---|
| `id` | UUID PK, `gen_random_uuid()` |
| `user_id` | UUID NOT NULL, FK users ON DELETE RESTRICT |
| `payment_id` | UUID NOT NULL, FK payments ON DELETE RESTRICT |
| `type` | ENUM notification_type NOT NULL: payment_due, payment_overdue, amount_changed |
| `created_at` | TIMESTAMPTZ(3) NOT NULL DEFAULT NOW() |
| `read_at` | TIMESTAMPTZ(3) NULL inicialmente |

Añadir UNIQUE `(user_id, payment_id, type)`, índice de recorrido
`(user_id, created_at DESC, id DESC)` e índice parcial con ese mismo orden
`WHERE read_at IS NULL`. La restricción única también apoya la deduplicación del
detector. No añadir triggers, tablas de anomalías, colas, JSON arbitrario ni flags
en payments: `price_changed` ya aporta el hecho que se quiere comunicar.

La precisión de milisegundos permite que el cursor conserve exactamente la fecha
de ordenación al serializarla como ISO con el cliente pg. El UUID desempata avisos
creados en el mismo instante. No duplicar group_id ni subscription_id: obtenerlos
con notifications → payments → subscriptions → groups.

Las FK conservan fuentes e historial; no deben introducir borrados en cascada.
La eliminación de suscripciones con pagos ya está bloqueada por su FK actual.
El borrado de usuarios y grupos sigue fuera del producto de esta fase.

Antes de aplicar: inspeccionar la base de desarrollo y las migraciones realmente
registradas. Aplicar con el runner existente; repetir y comprobar que no haya
pendientes y que 009 esté registrada una sola vez. Inspeccionar constraints e
índices sin modificar pagos, partes ni membresías. Las pruebas usan esquema aislado.

## 3. Escrituras ligadas a los pagos

### 3.1 Auxiliar de inserción

Crear `modules/notifications/notification-writer.ts` con una función interna
`insertPaymentNotifications(client, { paymentId, type, recipientIds })`.
Recibe el PoolClient de la transacción; no abre otra conexión, no hace COMMIT y
no expone un endpoint de creación. Insertar destinatarios en lote con SQL
parametrizado y `ON CONFLICT (user_id, payment_id, type) DO NOTHING`.

Los servicios de dominio determinan los destinatarios desde datos bloqueados;
el cliente HTTP nunca suministra esa lista. Mantener un orden estable de UUID
para inserciones concurrentes. No capturar el error para fingir éxito: un fallo
de persistencia revierte la operación de pago junto con su notificación.

### 3.2 Avisos iniciales

En `payment-generation.service.ts`, solo cuando el INSERT devuelve un pago
nuevo, crear los avisos después de insertar sus partes y antes del COMMIT.
Personal: owner activo del grupo. Comprobar que coincide con la membresía owner
activa; si falta un destinatario obligatorio válido, fallar y revertir en lugar
de comprometer un pago sin su aviso. Familia: participantes de la foto recién creada,
incluido owner, usando los mismos UUID del reparto. No recalcular esa foto mediante
otra conexión. Si el pago ya existía, conservar la validación familiar y no
reconstruir avisos usando la membresía actual.

El fallo al insertar un aviso debe revertir pago, partes y avance de fechas.
Conservar límites, bloqueos y resultado público de `runDuePayments`; no convertir
el generador en un job genérico ni añadir procesamiento de vencimientos aquí.

### 3.3 Diferencias de importe

En `payment.service.ts`, tras confirmar un pago personal y antes del COMMIT,
insertar `amount_changed` si el resultado de PostgreSQL tiene price_changed.
Igualdad, skip o error no generan ese aviso.

En `payment-share.service.ts`, insertarlo únicamente dentro de la rama que
actualiza el padre a confirmed, si su diferencia es verdadera. Leer el owner
activo con el grupo bloqueado y usar el mismo cliente. Una diferencia en una parte
no basta: dos diferencias podrían compensarse y dejar el total igual al previsto.

No modificar cómo se suman NUMERIC, el control de acumulado, la comprobación de
parte propia ni el orden grupo → pago → parte. Un fallo del aviso al cerrar el
pago familiar revierte también la última confirmación de parte.

## 4. Detector de pendientes vencidos

Crear `notification-generation.service.ts` con
`runOverdueNotifications(today, subscriptionId?)`. Esa función no genera pagos,
no cambia sus estados ni toma sus importes de la tarifa actual de la suscripción.

En una transacción con un cliente:

1. Buscar grupos con obligaciones vencidas y al menos un destinatario elegible
   que todavía no tenga `payment_overdue`. Limitar a 100 grupos, ordenar por UUID
   y adquirir `FOR UPDATE OF g SKIP LOCKED`.
2. Después de adquirir los grupos, volver a consultar los pagos y destinatarios
   elegibles en esos grupos. Aplicar el anti-join de notificación ausente **antes**
   del límite global de 200 pagos, ordenados por expected_date e id. Bloquear
   los padres seleccionados con `FOR UPDATE OF p SKIP LOCKED`.
3. Personal: owner con membresía activa y padre pending. Familia: titulares
   activos de partes pending de un padre pending. Revalidar fecha, estados,
   pertenencia a la suscripción opcional y ausencia del aviso bajo los bloqueos.
4. Insertar los avisos mediante el auxiliar. Hasta 20 destinatarios por pago
   familiar; no truncar arbitrariamente las partes de un padre seleccionado.
5. COMMIT de todo el lote; ante fallo ROLLBACK y liberar cliente. Registrar solo
   conteos y códigos de error seguros. La siguiente corrida vuelve a intentarlo.

Conservar el orden grupo → pago → notificación. La exclusión del grupo coordina
el detector con confirmación, skip, generación, transferencias y bajas. No
bloquear notificaciones antes que sus grupos. Mantener las transacciones cortas;
no hay llamadas de red ni esperas de temporizadores dentro de ellas.

Los pagos ya avisados no deben consumir siempre los primeros 200 puestos. Si
queda trabajo o hay grupos ocupados, una corrida posterior continuará con los
candidatos restantes. No utilizar OFFSET sobre un conjunto que se va reduciendo.
La unicidad de la tabla también protege frente a dos procesos concurrentes.

Resultado mínimo: `paymentsProcessed` y `notificationsCreated`. No afirmar
que una corrida agotó toda la base por haber completado su lote; los límites y
los grupos omitidos pueden dejar trabajo para después.

### 4.1 Comando de comprobación limitado

Añadir `notifications:scan` a backend/package.json y `scan-notifications.cli.ts`.
Aceptar **exactamente una** modalidad: `--subscription-id UUID` para una fixture
o `--all` para operación global deliberada. Sin argumentos, ambas modalidades
juntas, UUID inválido o argumentos desconocidos deben fallar antes de conectar.

Reutilizar carga de entorno, assertDbConnection, runner, cálculo de fecha actual
y cierre del pool del patrón CLI existente. Documentar que el comando aplica
migraciones pendientes antes de escanear y que escribe en la base configurada.
No permitir elegir destinatarios, importar mensajes ni generar avisos futuros
con una fecha suministrada por HTTP o CLI. La fecha inyectable es del servicio
para pruebas, no un control del producto.

## 5. Ciclo horario y apagado

Extender el ciclo de `payment.scheduler.ts` conservando su entrada pública:

1. Calcular today una sola vez.
2. Intentar `runDuePayments(today)` y capturar su fallo con un mensaje seguro.
3. Intentar `runOverdueNotifications(today)` aunque fallara la generación, para
   poder revisar obligaciones de corridas anteriores; capturar su fallo aparte.
4. Liberar la reserva local de corrida al finalizar ambos intentos.

Si falla el cálculo de fecha, no ejecutar ninguno y reintentar al siguiente ciclo.
No añadir otro intervalo, biblioteca cron, cola o infraestructura de workers.
La exclusión local debe cubrir ambos trabajos. `stop()` detiene nuevas corridas
y espera ambas tareas; `server.ts` mantiene el cierre del pool después de esa
espera. Revisar y adaptar las pruebas existentes de scheduler y servidor.

Un fallo del detector no revierte los pagos ya comprometidos por el generador;
sus avisos iniciales ya son atómicos con ellos y el vencimiento se reintentará.
La inserción del detector es idempotente entre procesos, aunque cada uno tenga
su propio intervalo. No introducir migraciones dentro de cada tick.

## 6. API privada del destinatario

Montar `/notifications` detrás de requireAuth y antes de notFound en app.ts.
Reutilizar validate, AppError, pool y el formato `{ error: { message, status } }`.
Todos los schemas Zod son strict; rechazar campos y parámetros adicionales.

| Método y ruta | Entrada | Respuesta |
|---|---|---|
| GET /notifications | status opcional all/unread/read; groupId UUID opcional; cursor opcional | 200 `{ notifications, nextCursor, unreadCount }` |
| POST /notifications/:notificationId/read | UUID; body `{}`; sin query | 200 `{ notification }`, idempotente |

No aceptar userId, no permitir crear avisos vía HTTP y no ofrecer acceso a los
avisos de otra persona al owner. La identidad procede exclusivamente del JWT.

### 6.1 Consulta y páginas

Cada consulta parte de `n.user_id = authenticatedUserId` y enlaza el pago y su
suscripción con `group_members` del mismo usuario y `status = 'active'`. Esa
condición se aplica en la propia consulta de datos y conteo, no solo en una
comprobación anterior. Los avisos de grupos abandonados quedan excluidos.

Si se proporciona groupId, comprobar acceso activo y devolver el mismo 403 para
grupo ajeno o inexistente. Sin groupId se incluyen todos los grupos activos del
destinatario. Status por defecto `all`; `unread` exige read_at NULL y `read` no NULL.

Página fija de 50 elementos, orden `created_at DESC, id DESC`; consultar 51 para
saber si hay continuación. Cursor base64url de `{ createdAt, id }`, con límite
de longitud de 512 caracteres y validación de ISO/UUID tras decodificarlo. Es
posición, no autorización: siempre reaplicar usuario, membresía y filtros. Usar
comparación SQL por tupla, sin concatenar SQL del cliente. Cursor inválido → 400.
`nextCursor` se calcula desde la última fila devuelta, no desde la fila extra.

`unreadCount` cuenta todos los avisos propios visibles sin leer del grupo filtrado
o de todos los grupos activos; ignora status y cursor. Obtener lista y conteo en
una transacción de solo lectura REPEATABLE READ para que compartan snapshot.
Cambiar filtros reinicia cursor; no reutilizar el cursor de otro filtro en la UI.

DTO Notification:

```text
id, type, paymentId, subscriptionId, subscriptionName,
groupId, groupName, groupType,
expectedDate, expectedAmount, actualAmount,
paymentStatus, ownShareStatus, actionRequired,
message, createdAt, readAt
```

`ownShareStatus` es el estado actual de la parte del destinatario en familia o
null si no tiene parte; en personal es null. `actionRequired` es true únicamente
para due/overdue si aún se puede confirmar la obligación propia: padre pending y
owner personal, o parte propia pending en familia. Para amount_changed es false.

`message` se construye con plantillas controladas según el tipo; describe el
evento, y la interfaz añade el estado actual. Nombres se leen de sus filas
actuales, siguiendo el contrato de pagos. No almacenar ni renderizar HTML; React
presenta texto normal. No interpolar datos sensibles ni mensajes arbitrarios
recibidos del cliente. Importes siguen siendo strings y expectedDate YYYY-MM-DD;
createdAt/readAt son ISO, este último nullable. No exponer destinatarios ajenos,
emails, hashes, tokens ni filas completas de miembros.

### 6.2 Marcar como leído

Localizar sin bloquear una notificación propia y visible para derivar su grupo;
si no existe, responder 404 `Notification not found`. En una transacción,
bloquear primero el grupo con el auxiliar existente y después actualizar la
notificación, revalidando user_id y membresía activa en el SQL de actualización.
Si la persona salió mientras esperaba, devolver el mismo 404 y no actualizarla.

Usar `read_at = COALESCE(read_at, NOW())` y devolver el DTO. Dos pestañas o un
reintento devuelven éxito conservando la primera fecha de lectura. No tocar
payment, share, price_changed ni otros avisos. No adquirir primero un bloqueo de
notificación y después uno de grupo.

Errores comunes: 400 validación, 401 sesión, 403 filtro de grupo sin acceso,
404 aviso no visible, 500 interno. Un ID ajeno, inexistente o de un grupo del que
se salió tiene el mismo 404. Leer un aviso ya leído no produce 409.

## 7. Interfaz y navegación

Antes de modificar código de frontend, leer frontend/AGENTS.md y la documentación
local de Next.js indicada allí. Las versiones actuales son Next 16.3.3 y React
19.2.8; no aplicar patrones de otra versión por memoria.

Crear `frontend/src/app/notifications/page.tsx` como centro independiente,
reutilizando session, apiWithSession y refreshSession. Enlazar desde dashboard
sin apilar otra sección sobre las tres vistas existentes y conservar la landing.
Usar `/login` cuando falte sesión; no crear una ruta de registro inexistente.

- Filtros: Todos los espacios o un grupo activo; Todos, Sin leer y Leídos.
  Mostrar tipo, grupo, suscripción, fecha del registro, mensaje, estado actual y
  condición de lectura. El resumen de no leídos usa el conteo real de la API.
- Leer 50 avisos y ofrecer «Cargar más» con el cursor. Al cambiar filtros o pulsar
  «Actualizar», reiniciar páginas, cancelar lecturas anteriores y evitar mezclar
  grupos o resultados obsoletos. Deduplicar por id al añadir otra página.
- Marcar leído por fila, bloqueando envíos repetidos. Mostrar error local si falla
  y conservar el aviso. Tras éxito, recargar desde la primera página con los filtros
  actuales para que desaparezca correctamente de Sin leer y se actualice el conteo.
- Estados de carga, vacío, error y reintento independientes de la lista de grupos;
  distinguir «sin avisos» de «sin resultados para este filtro». Evitar conteos
  globales calculados sumando solo la página visible.
- 401 renueva sesión coordinadamente o lleva a login; 403 refresca grupos y limpia
  el filtro perdido; 404 al marcar provoca recarga con explicación. No mostrar
  datos de la cuenta anterior al salir y entrar con otra cuenta.
- Resolver un pago no marca automáticamente el aviso como leído. Mostrar
  «ya confirmado» o «omitido» cuando corresponda; no volver a ofrecer confirmar
  una parte propia resuelta porque el padre siga pending.
- No añadir polling, WebSocket ni un badge global que exija otro endpoint. Se
  consulta al entrar, cambiar filtros y actualizar; el detector puede tardar hasta
  la siguiente corrida, y más si existe una cola de lotes atrasados.

Cada aviso ofrece «Abrir pagos de este grupo», mediante
`/dashboard?groupId=UUID&view=payments`. Es un enlace al contexto, no la promesa de
enfocar una fila antigua que podría no estar entre los 100 pagos del dashboard.
El aviso muestra fecha, importes y estado para identificar ese pago.

El dashboard **actualmente ignora ese contexto**: la integración debe leerlo
tras cargar sesión y grupos, validar UUID/vista y seleccionar solo un grupo activo
devuelto por la API. Grupo inválido o perdido → volver al personal y explicar;
no conceder permisos a partir de la URL. Sin contexto se mantiene la entrada
habitual al personal y a Suscripciones. Considerar navegación con la página ya
montada y evitar que una respuesta vieja cambie el grupo después de otra elección.

Etiquetas, foco visible, botones por teclado y mensajes en español. Ancho móvil
sin desbordamiento. No usar localStorage para tokens, avisos o selección; los
códigos de invitación siguen fuera de URL y de este centro.

## 8. Archivos, dependencias y coordinación

Backend nuevo, bajo `src/modules/notifications/`:

- `notification.types.ts`, `notification.schemas.ts`, `notification-messages.ts`.
- `notification-writer.ts`: inserción con cliente del llamador.
- `notification-generation.service.ts`: detector transaccional.
- `notification.service.ts`, `.controller.ts` y `.routes.ts`: API del destinatario.
- `scan-notifications.cli.ts` y pruebas pertinentes junto a cada módulo.

Modificar en sus bloques: migración 009, payment-generation.service.ts,
payment.service.ts, payment-share.service.ts, payment.scheduler.ts, app.ts y
backend/package.json. Ajustar pruebas existentes cuando cambia el contrato
transaccional; evitar copiar toda la suite para el nuevo módulo.

Frontend: nueva página `/notifications` y cambios acotados en
`dashboard/page.tsx` para enlace y selección validada de contexto. Extraer un
componente local solo si permite entender la página; no reestructurar todo el
dashboard ni crear un nuevo sistema global de estado o autenticación.

Documentar en `backend/docs/notifications.md` y actualizar lo necesario en
payments.md/payment-shares.md y este plan. No modificar los contratos de
invitación para incluir notificaciones.

**Sin dependencias nuevas ni variables de entorno nuevas.** Reutilizar pg, Zod,
Winston, Node, React, Next y pnpm existentes. Nueva constante de siete días y
límites internos documentados; misma zona y mismo intervalo horario. Solo se
añade el script específico `notifications:scan` al llegar a su bloque.

La delegación sigue AGENTS.md: backend para servidor/persistencia, frontend para
interfaz y reviewer para revisión sin editar. Un escritor por archivo; principal
coordina los puntos compartidos. La revisión espera a que exista la entrega.
Subagentes no adelantan bloques, migraciones reales ni generación global.

## 9. Bloques y puntos de parada

Antes de cada fila: explicar resultado observable, por qué, archivos y concepto.
Después: resumir recorrido, verificaciones reales, límites y cómo comprobarlo.
**Detenerse al finalizar cada fila**, incluso si la funcionalidad espera otra.

| Bloque | Resultado y archivos principales | Aprendizaje y comprobación |
|---|---|---|
| 1. Entrada y reglas | Revisar 06-fase.md, este plan, cierre de Fase 5 y código vigente | Destinatario, diferencia frente a subida y siete días; resolver discrepancias. Parar para lectura sin implementar |
| 2. Datos | Preparar y aplicar 009 mediante runner en el momento autorizado | FK, unicidad y precisión del cursor; migrar dos veces, inspeccionar y probar en esquema aislado |
| 3. Tipos e inserción interna | Tipos, plantillas y notification-writer.ts | Cliente compartido, deduplicación y rollback; probar sin conectar aún pagos |
| 4. Aviso inicial | Integrar el auxiliar en payment-generation.service.ts | Pago, partes, avisos y fechas juntos; repetir y fallar para comprobar atomicidad. Prueba limitada a fixture |
| 5. Diferencia personal | Integrar en payment.service.ts | NUMERIC y evento tras confirmación; igualdad, mayor, menor, skip y rollback |
| 6. Diferencia familiar | Integrar en payment-share.service.ts | Solo total completo y owner vigente; parcial, compensación de diferencias, concurrencia y rollback de última parte |
| 7. Detector de vencidos | notification-generation.service.ts | Umbral, partes propias, locks y lotes sin inanición; fecha inyectada y pruebas PostgreSQL aisladas |
| 8. Comando limitado | CLI y script notifications:scan | Validar antes de conectar, UUID de fixture, repetición y cierre del pool; parar para prueba manual dirigida |
| 9. Ciclo horario | Extender scheduler y adaptar pruebas de ciclo de vida | Errores independientes, reserva de ambos trabajos y apagado; no ejecutar corrida global para probarlo |
| 10. Consulta propia | Schemas, servicio, DTO, GET y montaje app.ts | Identidad y membresía en SQL, cursor, estados y conteo consistente; owner no lee avisos ajenos |
| 11. Lectura persistida | POST read y pruebas | Transacción, baja concurrente e idempotencia; ninguna mutación financiera. Parar para comprobar API |
| 12. Centro consultable | Página /notifications con filtros y páginas | Sesión, estados, cancelación y carga incremental; enlace temporal directo para revisión |
| 13. Acciones del centro | Marcar leído, recarga y manejo de pérdida de acceso | Una acción por fila y cambio de filtro sin datos viejos; lint/typecheck y navegador |
| 14. Navegación contextual | Enlace dashboard ↔ centro; grupo/vista validados desde URL | Conservar las tres vistas, permisos y borradores; personal/familia y enlaces inválidos |
| 15. Recorrido real | Dos cuentas y fixtures identificadas | Confirmar pagos, diferencia y vencimiento, lectura, salida y recarga; registrar evidencia y resolver fallos |
| 16. Cierre | Contratos finales, checklist y comprobaciones pertinentes | Regresión personal/familiar y límites documentados. No iniciar Fase 7 |

No ejecutar los 16 bloques al aprobar este documento. Marcar cada bloque solo
cuando se disponga de evidencia. Si un bloque resulta demasiado grande al
inspeccionarlo, dividirlo y registrar el ajuste antes de ampliar alcance.

## 10. Comprobaciones necesarias

Unitarios co-ubicados para entradas, cursor, mensajes y frontera de fechas cuando
exista una función pura. No crear funciones o pruebas que solo repitan una cadena
de implementación; probar diferencias de comportamiento y condiciones límite.

Integración `RUN_DB_TESTS=1`, con esquemas o UUID exclusivos `phase6-test-`:

1. 009 conserva pagos, partes, grupos y lecturas previas de otras tablas; la
   unicidad rechaza duplicados, type rechaza NULL y las FK protegen las fuentes.
   Sin backfill.
2. Generar personal produce un aviso; generar familia produce uno por titular.
   Repetir no añade copias. Reparto y costes posteriores no alteran la foto.
3. Forzar fallo de notificación revierte pago/partes/avance, confirmación personal
   o última parte familiar según su punto de integración; comprobar con PostgreSQL.
4. Importe igual no genera anomalía; mayor y menor sí. Familiar parcial no; total
   distinto al cerrar sí. Diferencias compensadas no producen diferencia de total.
5. Transferencia contra última confirmación determina un único owner destinatario
   según orden de bloqueo. El member nunca puede eludir su límite mediante avisos.
6. Fecha prevista +6 días no avisa; +7 sí. Año/mes y cambio de día en la zona
   configurada no desplazan DATE. Recuperación tardía y coste cero son válidos.
7. En familia, parte propia confirmada no recibe overdue aunque otras sigan
   pendientes. No avisar a quien carece de parte ni a miembros inactive/invited/removed.
8. Suscripción desactivada sigue siendo elegible si tiene obligación pendiente.
   Padre confirmado o skipped nunca produce un nuevo overdue.
9. Dos detectores, confirmación contra detector, skip contra detector y baja contra
   detector respetan los bloqueos y no crean avisos basados en estados anteriores
   al bloqueo. Si el aviso se creó primero, persiste con el estado actual correcto.
10. Más de 200 pagos y grupos ocupados: varias corridas avanzan sin que candidatos
    ya notificados consuman el cupo. No perder destinatarios de un padre familiar.
11. Reintentar después de leer conserva created_at/read_at y una sola fila. Los
    avisos históricos quedan visibles con estado resuelto, sin acción pendiente.
12. HTTP: 401 sin sesión; validación 400; owner/member solo ven avisos propios;
    otro usuario y grupo no autorizado no filtran información. Conteo usa los
    mismos permisos y filtros de grupo que el listado.
13. Más de 50 avisos, fechas iguales, cursor límite/inválido y fin de páginas:
    recorrido estable sin saltos por pérdida de microsegundos. Conteo incluye
    no leídos fuera de la página visible.
14. POST read concurrente conserva la primera fecha; ID ajeno, inexistente o
    perdido tras baja da el mismo 404. Ningún pago o parte cambia por leer.
15. Salir y reincorporarse oculta/restituye avisos propios, con el conteo y las
    lecturas preservados. Cambio de owner no reenvía anomalías antiguas.
16. Scheduler: un job fallido no impide el otro, no hay solapamiento local y el
    pool se cierra tras terminar ambos. Simular reloj/dependencias para el ciclo.
17. Regresión: health, auth/refresh, generación/confirmación/skip personales,
    partes, invitaciones, bajas, transferencia y dashboard de tres vistas.

Para navegar: owner en ventana normal y member en ventana privada, con cuentas
de prueba. Crear una familia/suscripción exclusiva; fecha de siete días atrás,
ciclo mensual y coste `10.00` permiten generar un solo pago y escanearlo hoy sin
esperar siete días. Con weekly, ese intervalo podría generar más de un ciclo.

Secuencia manual: registrar el UUID de la fixture → generar solo su pago → ver
avisos propios con ambas cuentas → escanear solo ese UUID dos veces → comprobar
un overdue por obligación → marcar leído y recargar → confirmar owner `5.00` y
member `4.50` → comprobar que no se creó anomalía parcial, que al final llegó al
owner y que los recordatorios muestran estado resuelto → abrir pagos desde el
centro → transferir/salir y comprobar que el acceso perdido oculta avisos. Añadir
un pago personal igual/distinto y errores independientes, teclado y ancho móvil.

Desde raíz, al llegar a los bloques correspondientes, usando UUID literal sin
ángulos y sustituyendo el valor de ejemplo por el de la fixture:

```powershell
pnpm.cmd --dir backend run payments:generate --subscription-id 11111111-1111-4111-8111-111111111111
pnpm.cmd --dir backend run notifications:scan --subscription-id 11111111-1111-4111-8111-111111111111
```

No usar generación global ni `--all` como comprobación casual. Arrancar
`server.ts` activa la corrida global al inicio: para aislar un recorrido HTTP,
usar un arranque de app sin scheduler como en las comprobaciones anteriores y
anotar esa diferencia. No dejar procesos o puertos duplicados al terminar.

Limpiar solo fixtures identificadas y en orden FK: notifications → partes →
pagos → suscripciones; después invitaciones, membresías, grupos y sesiones/usuarios
de esas cuentas, si fueron creadas exclusivamente para la prueba. No borrar las
suscripciones existentes del propietario ni modificar registros históricos.
Un esquema temporal debe eliminarse y comprobarse ausente tras sus pruebas.

Comandos de comprobación por paquete: backend typecheck/test/build; frontend
lint, exec tsc --noEmit y build. Activar RUN_DB_TESTS solo cuando corresponda y
restaurarlo. No afirmar integración aprobada con tests omitidos o API simulada.
Repetir la suite completa en el cierre, no en cada edición documental.

## 11. Checklist final — pendiente

- [x] Entrada y reglas revisadas contra el código y el cierre documentado de Fase 5.
- [x] 009 aplicada una vez; repetición sin pendientes; constraints/índices comprobados.
- [x] Tipos, mensajes y auxiliar interno comprobados con cliente compartido y reintentos.
- [x] Avisos iniciales atómicos con pago, partes y avance; reintento sin copias.
- [x] Diferencia personal al confirmar, con destinatario y mensaje correctos.
- [x] Diferencia familiar al cerrar, con destinatario y mensaje correctos.
- [x] Detector de siete días con fecha explícita, suscripciones desactivadas y partes propias.
- [ ] Fecha local del ciclo horario calculada con `PAYMENT_TIME_ZONE` y comprobada.
- [x] Lotes avanzan, concurrencia revalida y no hay avisos diarios repetidos.
- [ ] CLI limitada por UUID y ciclo horario con errores independientes y apagado limpio.
- [ ] API solo del destinatario y con membresía activa en listado, conteo y acciones.
- [ ] Cursor y filtros permiten recorrer todo el centro sin truncamiento silencioso.
- [ ] Lectura idempotente, historial y pérdida/restitución de acceso comprobados.
- [ ] Centro y enlaces contextuales comprobados en navegador con dos cuentas reales.
- [ ] Estados, accesibilidad móvil/teclado, recarga y sesión conservados.
- [ ] Dinero string, DATE y reglas de owner/member de Fase 5 preservados.
- [ ] Pruebas pertinentes, integración real, typecheck/lint/build y regresión registradas.
- [ ] Contrato notifications.md actualizado, límites y evidencia manual documentados.
- [ ] Sin servicios externos, secretos expuestos, datos reales alterados ni trabajo de Fase 7.
