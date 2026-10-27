# Plan Fase 5 — Modo familia, invitaciones y partes de pago

Plan de implementación para este proyecto individual de aprendizaje. **Un bloque
por entrega**, con explicación y comprobación antes de avanzar. El alcance
original está en [05-fase.md](../05-fase.md). Este documento recoge el diseño y
el avance contrastado de cada bloque.

## 0. Estado contrastado y requisito de entrada

Al redactar el plan, el árbol de Git está limpio. Se han inspeccionado:

- Migraciones `001` a `006`: grupos y membresías ya existen; no existen tablas de
  invitaciones ni `payment_shares`.
- `modules/subscriptions/membership.ts`: autorización por membresía activa y
  `assertOwner`; admite recibir el cliente de una transacción.
- `subscription.service.ts`: CRUD limitado por grupo, ancla de facturación y
  DELETE con historial convertido a `409`. Sus escrituras aún autorizan y
  consultan con el pool sin bloquear el grupo en una misma transacción.
- `payment-generation.service.ts`: hasta 100 suscripciones y 24 ciclos por
  suscripción, transacción, bloqueo de suscripciones, unicidad y comando manual.
- `payment.service.ts`: lista por grupo y resuelve pagos con bloqueo del pago.
  No bloquea todavía el grupo ni genera o resuelve partes.
- Scheduler inicial y horario, API Bearer con refresh por cookie y dashboard
  personal con pagos. `/auth/me` devuelve `personalGroupId`.

**Requisito previo cumplido:** el bloque 9 de la Fase 4 se cerró el 24 de octubre
de 2026 con restricciones, migración, procesos reales y documentación contrastados;
consultar [el informe de cierre](../../backend/docs/phase-4-verification.md).
Antes de implementar esta fase, comprobar que ese estado siga vigente. No convertir
casillas en aprobadas por inferencia ni repetir verificaciones válidas sin motivo.
Los bloques 1 a 13 están completados: revisión, datos de grupos e invitaciones,
datos de partes, reparto puro, escrituras coordinadas, generación familiar,
lectura de partes, confirmación propia, omisión familiar, API inicial de grupos,
listado de miembros, transferencia de ownership, salida y expulsión, y operaciones
de invitación del owner. La resolución por el destinatario y la interfaz familiar
siguen pendientes.

Las reglas existentes siguen vigentes: SQL parametrizado, Zod strict, errores
`{ error: { message, status } }`, dinero como strings, DATE `YYYY-MM-DD`, access
token en memoria y refresh httpOnly. `refresh_tokens.family_id` identifica una
cadena de sesiones; **no es un grupo familiar de negocio**.

Reutilizar Express 5, pg, Zod, Winston, React y Next.js de los package.json
actuales; node:crypto y BigInt no requieren instalar paquetes. No se prevén
dependencias, scripts ni variables de entorno nuevas. Los límites iniciales de
20 miembros y siete días se documentan como constantes del módulo, no secretos.

### Bloque 1 — Plan y entrada revisados (25 de octubre de 2026)

- [x] Carpeta de trabajo y raíz Git coincidentes; árbol limpio al comenzar,
  con base en el commit `37d97e1`.
- [x] Leídos AGENTS.md, la skill desarrollo-por-bloques, 05-fase.md, este plan
  y el informe de cierre de Fase 4.
- [x] Contrastados migraciones 001–006, registro y personalGroupId, membresía,
  CRUD de suscripciones, generación y resolución de pagos, montaje de rutas,
  scheduler y conexión del dashboard al grupo personal.
- [x] Revisadas las decisiones de reparto igual, foto al generar, permisos,
  confirmación propia, omisión conjunta e invitaciones con código de siete días;
  se mantienen las decisiones del plan, sin discrepancias que exijan rediseñarlo.
- [x] Confirmada la secuencia: preparar datos; coordinar escrituras y bloquear
  resolución directa familiar; adaptar generación y partes; habilitar después
  creación de familias e interfaz. No adelantar rutas familiares.

Se reutiliza la evidencia de cierre: 183 pruebas aprobadas con PostgreSQL,
typecheck/build de backend y las comprobaciones de frontend documentadas allí.
Son resultados previos, no pruebas ejecutadas de nuevo en este bloque. El commit
de cierre no modificó el código de producción; añadió pruebas y documentación.

Esta revisión contrasta archivos y evidencia; no vuelve a inspeccionar la base
en ejecución. Antes de aplicar 007, comprobar los datos reales de ownership y
posibles pagos familiares heredados según la precondición de esa migración.
Ese bloque fue exclusivamente documental: no incluyó SQL, código de producto
ni nuevas dependencias. Esa entrega modificó únicamente este plan.

### Bloque 2 — Datos de grupos e invitaciones comprobados (25 de octubre de 2026)

- [x] Inspección previa de PostgreSQL 16.15, base local `subscripciones_db`,
  esquema `public`: migraciones 001–006, diez grupos personales y ningún owner
  incoherente, duplicado o inactivo; sin familias ni pagos familiares heredados.
- [x] Creada y aplicada [007_family_groups_and_invitations.sql](../../backend/src/db/migrations/007_family_groups_and_invitations.sql).
  Su preflight bloquea escrituras mientras comprueba incompatibilidades y falla
  con conteos seguros; no repara ni elimina datos. Añade el índice de owner activo
  único, su CHECK y group_invitations con estados, FK RESTRICT, hashes y restricciones.
- [x] Runner existente ejecutado dos veces: primera aplicación de 007 y después
  ninguna migración pendiente; 007 registrada una sola vez. `pnpm.cmd migrate`
  falló al iniciar tsx por `uv_os_get_passwd`/ENOMEM en este entorno de Windows,
  antes de ejecutar SQL. Se usó el mismo runner compilado: desde backend,
  `pnpm.cmd build` y `node dist/db/migrate.js`, este último dos veces.
- [x] Inspección posterior de pg_constraint, pg_indexes y pg_enum: restricciones
  e índices previstos presentes; estados pending, accepted, declined, revoked y
  expired. Se conservaron los conteos: diez usuarios, grupos y membresías, una
  suscripción y cero pagos; group_invitations quedó vacía.
- [x] [Pruebas aisladas de 007](../../backend/src/db/family-groups-migration.int.test.ts):
  51 aprobadas, incluyendo estados, unicidad parcial, FK, normalización compatible
  con String.trim(), datos heredados incompatibles y rollback. Esquema temporal
  exclusivo eliminado y ausencia comprobada; no se ejecutó generación global.
- [x] Suite completa con RUN_DB_TESTS=1: 234 aprobadas en 14 archivos. Sin el flag:
  140 aprobadas y 94 omitidas. Flag restaurado; typecheck y build correctos.
- [x] Revisión independiente sin hallazgos pendientes tras corregir el tratamiento
  de espacios Unicode en email. No se añadieron dependencias ni rutas HTTP.

El índice garantiza **como máximo** un owner activo. La existencia de uno y su
coincidencia con groups.owner_id siguen siendo invariantes de los servicios
transaccionales previstos; este bloque no afirma haberlas implementado.
Al cerrar ese bloque, la migración 008, las partes, la API y la interfaz quedaron
pendientes para sus propias entregas.

### Bloque 3 — Datos de partes comprobados (25 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; conservados los cambios pendientes
  de los bloques anteriores. Inspección previa de `subscripciones_db/public`,
  PostgreSQL 16.15: migraciones 001–007 registradas, sin payment_shares ni familias.
- [x] Creada y aplicada [008_create_payment_shares.sql](../../backend/src/db/migrations/008_create_payment_shares.sql):
  enum y tabla de partes, unicidad por pago/usuario, FK RESTRICT, importes finitos,
  porcentaje entre 0 y 100 y coherencia de estados. Sin backfill ni cambios a payments.
- [x] Runner compilado existente ejecutado dos veces tras build: aplicó únicamente
  008 y después informó que no había pendientes; 008 registrada una sola vez.
  Se mantuvo la alternativa de ejecución del bloque 2, sin modificar el runner.
- [x] Inspección de esquema real: nueve columnas, ocho constraints, tres índices
  (PK, UNIQUE y usuario/estado/pago) y estados pending, confirmed, skipped.
  Verificados NUMERIC(12,2), NUMERIC(7,4), nulabilidad y ausencia de group_id duplicado.
- [x] [Pruebas aisladas de 008](../../backend/src/db/payment-shares-migration.int.test.ts):
  33 aprobadas. Tres pagos personales previos conservan todos sus campos y no
  reciben partes; insertar, confirmar y omitir pagos personales sigue siendo válido.
  Cubiertos estados, decimales string, cero/máximos, NaN/Infinity, unicidad, FK y rollback.
- [x] Suite completa con RUN_DB_TESTS=1: 267 aprobadas en 15 archivos. Sin el flag:
  140 aprobadas y 127 omitidas. Flag restaurado; typecheck y build correctos.
- [x] Esquema temporal exclusivo eliminado y ausencia comprobada. Conteos existentes
  conservados: diez usuarios, grupos y membresías, una suscripción y cero pagos;
  invitaciones y partes vacías. No se ejecutó generación global.
- [x] Revisión independiente de SQL y pruebas sin hallazgos pendientes.

En esa entrega las restricciones validaron cada fila; el reparto, sus sumas, la
foto de miembros y la autorización quedaron para los bloques siguientes. No hubo
generación de partes, rutas nuevas ni cambios de interfaz. Al cerrar ese bloque,
el cálculo del reparto seguía pendiente.

### Bloque 4 — Reparto puro comprobado (25 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; conservados los cambios anteriores.
  Contrastados el plan, los contratos decimales y el patrón de funciones puras
  existente, sin modificar schemas ni servicios.
- [x] Creado [payment-sharing.ts](../../backend/src/modules/payments/payment-sharing.ts)
  con `splitPaymentEqually(expectedAmount, participantIds)`, que devuelve
  `PaymentShareAllocation[]`: userId canónico, shareAmount con dos decimales y
  sharePercentage con cuatro, todos strings.
- [x] Validados importe decimal string no negativo hasta 9999999999.99, entre
  uno y veinte participantes, UUID válidos y ausencia de duplicados tras normalizar
  mayúsculas. Se aceptan enteros, uno o dos decimales y ceros iniciales; los errores
  de entrada producen RangeError, siguiendo el patrón del cálculo de fechas.
- [x] Reparto de céntimos y de 1 000 000 unidades porcentuales con BigInt; restos
  asignados a los primeros UUID ordenados. Porcentajes independientes del redondeo
  de céntimos; salida serializable y array de entrada conservado.
- [x] [Pruebas unitarias](../../backend/src/modules/payments/payment-sharing.test.ts):
  54 aprobadas sin PostgreSQL. Casos 10.00/3, 0.01/3, resto de varios céntimos,
  cero y máximo; invariantes de suma y equilibrio para los veinte tamaños de grupo,
  permutaciones, normalización, validación, no mutación y JSON.
- [x] Suite habitual sin RUN_DB_TESTS: 194 aprobadas y 127 de integración omitidas
  en 16 archivos; flag restaurado. Typecheck y build correctos.
- [x] Revisión independiente de código y pruebas sin hallazgos pendientes.

No se repitió la integración con PostgreSQL: este bloque no consulta ni cambia
datos, migraciones o servicios. La evidencia de 267 pruebas con base real del
bloque 3 se conserva como resultado previo, no como una ejecución de este bloque.
Al cerrar ese bloque, la función no tenía consumidores de producción. Capturar
el reparto en el generador y comprobar sus transacciones quedó para el bloque 6;
la casilla de foto e historial permanecía pendiente. El bloque 5 estaba pendiente.

### Bloque 5 — Escrituras coordinadas y guardas comprobadas (25 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; conservados los cambios anteriores.
  Inspección previa de PostgreSQL 16.15, `subscripciones_db/public`: migraciones
  001–008 registradas; diez usuarios, grupos y membresías, una suscripción y cero
  pagos, invitaciones y partes.
- [x] Nuevo [group-lock.ts](../../backend/src/modules/groups/group-lock.ts):
  `lockGroupForWrite(client, groupId)` bloquea el grupo y devuelve su tipo; si
  falta conserva `403 Forbidden`. No crea otro pool ni infraestructura de transacciones.
- [x] Create/update/delete de [suscripciones](../../backend/src/modules/subscriptions/subscription.service.ts)
  y confirm/skip de [pagos](../../backend/src/modules/payments/payment.service.ts)
  usan un cliente desde BEGIN hasta COMMIT/ROLLBACK: membresía inicial, bloqueo de
  grupo, nueva lectura de membresía y assertOwner antes de escribir. Liberación
  del cliente incluso ante fallos; lecturas, ancla, strings, fechas y DELETE 409 conservados.
- [x] Grupo antes de pago en resolución. Al cerrar esa entrega, una vez localizado
  el pago dentro del grupo autorizado, confirm y skip familiares devolvían 409 sin modificar padre
  ni partes. Membresía/rol inválidos siguen dando 403; pago ausente o ajeno dentro
  del grupo autorizado da 404 antes de la guarda. Personal conserva su resolución.
- [x] Suites de suscripciones y HTTP de pagos: 41 y 54 pruebas aprobadas,
  respectivamente, con cliente único, revalidación, fallos de commit/rollback,
  guardas, errores y liberación de recursos.
- [x] [Integración de escrituras](../../backend/src/modules/groups/group-writes.int.test.ts):
  23 pruebas PostgreSQL aprobadas. Diez carreras observan espera real mediante
  pg_blocking_pids del holder propio y luego exigen 403 tras democión o baja;
  cinco operaciones por cada cambio, sin alterar suscripciones, pagos ni partes.
  Cubiertas guardas con cero partes, pendientes y confirmación parcial, aislamiento
  403/404 y rollback personal con NOWAIT y reintento.
- [x] Suite completa con RUN_DB_TESTS=1: 376 aprobadas en 17 archivos. Sin el flag:
  226 aprobadas y 150 omitidas. Flag restaurado; typecheck y build correctos.
- [x] Fixtures exclusivas eliminadas; conteos de datos existentes conservados.
  No se aplicó SQL de migración ni se ejecutó generación global.
- [x] [Documentación de suscripciones](../../backend/docs/subscriptions.md) y
  [pagos](../../backend/docs/payments.md) actualizada. Revisión independiente de
  servicios, pruebas y documentación sin hallazgos pendientes.

Las transferencias de las pruebas se simulan con SQL limitado a fixtures; no hay
API de transferencia nueva. Al cerrar ese bloque, el generador conservaba la lógica
de Fase 4 y su adaptación estaba pendiente del bloque 6. La confirmación directa
del padre familiar permanece prohibida; la omisión quedó bloqueada hasta el bloque 9.
Esa entrega no adelantó otros bloques ni la creación de familias por HTTP.

### Bloque 6 — Generación familiar comprobada (25 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; conservados los cambios anteriores.
  Inspección previa de PostgreSQL 16.15, `subscripciones_db/public`, con migraciones
  001–008 y sin familias ni partes existentes. Sin migraciones nuevas.
- [x] Adaptado [payment-generation.service.ts](../../backend/src/modules/payments/payment-generation.service.ts):
  primero hasta cien grupos disponibles ordenados por UUID con FOR UPDATE SKIP LOCKED,
  sin precupo de suscripciones; después hasta cien suscripciones en total dentro de
  esos grupos. UUID opcional aplicado en ambas selecciones y datos releídos tras locks.
- [x] Foto de uno a veinte miembros activos bajo bloqueo, con owner coherente.
  Pago nuevo con RETURNING id, reparto exacto y partes pending insertadas con UNNEST
  en el mismo cliente y transacción que avanza la fecha. Personal sigue sin partes;
  se conservan las métricas, el día de referencia, la zona y los 24 ciclos máximos.
- [x] Conflictos familiares validan las cuotas y porcentajes usando el importe y
  los UUID guardados; conservan estados e importes reales. Foto ausente o incoherente,
  owner inválido o exceso de miembros abortan sin reparar ni avanzar fechas.
- [x] [Unitarios del generador](../../backend/src/modules/payments/payment-generation.service.test.ts):
  ocho aprobados. Comprueban el SQL de selección, filtros y límites, relectura,
  continuidad de 24 ciclos y rollback/liberación. Las llamadas sin UUID usan solo
  un cliente simulado; no se ejecutó un lote global real para comprobar el cupo.
- [x] [Integración familiar](../../backend/src/modules/payments/payment-generation-family.int.test.ts):
  dieciocho pruebas aprobadas con un Pool PostgreSQL real en un esquema exclusivo.
  Cada generación recibió un UUID de fixture; otra suscripción vencida quedó intacta.
  Cubiertos personal, cero, céntimo, atrasos, reintentos con nuevos miembros/coste,
  resoluciones guardadas, corrupción y fallo real de INSERT por un CHECK solo local.
- [x] Carreras PostgreSQL: grupo ocupado por alta/baja se omite con SKIP LOCKED;
  una cadena con dos esperas observadas mediante pg_blocking_pids demuestra que
  el alta espera al generador y que ambos pagos conservan sus fotos completas.
- [x] Suite completa con RUN_DB_TESTS=1: 402 aprobadas en 19 archivos. Sin el flag:
  234 aprobadas y 168 omitidas. Flag restaurado; typecheck y build correctos.
- [x] Pools de prueba cerrados, esquema eliminado y ausencia comprobada. Conteos
  de public conservados: diez usuarios, grupos y membresías, una suscripción y cero
  pagos, partes e invitaciones. No se ejecutó generación global ni el servidor normal.
- [x] Documentación de pagos actualizada y revisión independiente de servicio,
  unitarios e integración sin hallazgos pendientes.

Se completó la comprobación limitada a UUID mediante llamadas reales al servicio;
no se presenta como una prueba manual del CLI. Al cerrar esa entrega no había
rutas de partes nuevas: la lectura quedó para el bloque 7, la confirmación para
el 8 y la omisión para el 9. Al cerrar ese bloque seguían activas las guardas
familiares del bloque 5.

### Bloque 7 — Lectura de partes comprobada (26 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; árbol Git limpio al comenzar desde
  `63731ea`. Inspección previa de PostgreSQL 16.15, `subscripciones_db/public`,
  con migraciones 001–008 y los datos de cierre del bloque anterior conservados.
- [x] Nuevos tipos, schemas, servicio, controlador y router de partes en
  modules/payments/payment-share.*. Montaje autenticado en app.ts y ruta de
  desglose dentro del router de pagos, con mergeParams y validación strict.
- [x] GET /groups/:groupId/payment-shares devuelve únicamente partes de la cuenta
  autenticada, con status opcional, hasta cien por fecha del pago DESC e id de
  parte DESC. Cada una incluye payment y summary; las suscripciones inactivas
  conservan su historial y un miembro sin partes recibe shares vacío.
- [x] GET /groups/:groupId/payments/:paymentId/shares devuelve el pago, la foto
  completa ordenada por userId y su resumen. Incluye participantes históricos
  removed; un caller activo recién incorporado puede leer aunque no tenga cuota.
  Pago existente sin partes devuelve 200 con shares vacío y resumen cero.
- [x] Membresía activa de owner/member antes de consultar; personal autorizado 409,
  grupo ajeno/inexistente/invited/removed 403 y pago ausente/ajeno dentro del grupo
  autorizado 404. Consultas parametrizadas delimitadas por subscription.group_id
  y, en listado propio, user_id autenticado; no se admite elegir usuario por query.
- [x] Un SELECT de recursos obtiene padre, partes y resumen con LATERAL. COUNT
  devuelve enteros y SUM NUMERIC devuelve strings sobre todas las partes del pago,
  sin contaminarse por filtros propios o de estado. confirmedAmount cero es 0.00;
  DTOs explícitos conservan dinero, DATE y timestamps, sin emails ni datos de sesión.
- [x] [Pruebas HTTP](../../backend/src/modules/payments/payment-share.routes.test.ts):
  treinta aprobadas con servicio simulado, cubriendo Bearer, montaje, parámetros,
  filtros strict, contratos, errores y ausencia de mutaciones del bloque siguiente.
- [x] [Integración de lecturas](../../backend/src/modules/payments/payment-share-read.int.test.ts):
  trece pruebas PostgreSQL/HTTP reales aprobadas con UUID exclusivos. Cubren roles,
  históricos, cero partes, filtros, errores, 0.10 + 0.20 = 0.30, resumen independiente
  del caller/status y límite/orden de cien resultados con 101 partes nuevas.
  Ambos GET y regresión de health, pagos y suscripciones personales comprobados.
- [x] Suite completa con RUN_DB_TESTS=1: 445 aprobadas en 21 archivos. Sin el flag:
  264 aprobadas y 181 omitidas. Flag restaurado; typecheck y build correctos.
- [x] Fixtures eliminadas y ausencia comprobada; servidor HTTP temporal y pool
  cerrados. Conteos existentes conservados: diez usuarios, grupos y membresías,
  una suscripción, cero pagos, partes e invitaciones, ocho migraciones. Sin
  migraciones nuevas, generación global ni servidor normal.
- [x] [Contrato de lectura documentado](../../backend/docs/payment-shares.md), con
  enlace desde pagos. Revisión independiente sin hallazgos pendientes.

Las lecturas no adquieren FOR UPDATE ni escriben datos. Al cerrar ese bloque,
la confirmación propia del 8, la omisión del 9 y la interfaz quedaron pendientes.
Al cerrar ese bloque, ambas operaciones seguían bloqueadas; la confirmación
directa del padre familiar permanece prohibida.

### Bloque 8 — Confirmación propia comprobada (26 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; conservados los cambios pendientes
  del bloque 7. Inspección previa de PostgreSQL 16.15, `subscripciones_db/public`,
  migraciones 001–008 y conteos de datos habituales conservados.
- [x] POST /groups/:groupId/payments/:paymentId/shares/:shareId/confirm montado
  detrás de Bearer, con UUID strict, query vacía y body estricto. `{}` usa la
  cuota prevista; actualAmount opcional es decimal string dentro del rango de
  Fase 4. El nuevo schema rechaza también whitespace final, incluido newline,
  sin modificar el schema de pagos personales.
- [x] Servicio confirmPaymentShare con cliente único: membresía inicial, grupo
  bloqueado y membresía revalidada, padre y parte bloqueados dentro del grupo.
  No exige owner; solo el titular activo puede confirmar. Parte ajena da 403
  incluso al owner y antes de comprobar estados; IDs incompatibles dan 404.
  Grupo personal autorizado, padre o parte resueltos dan 409.
- [x] SUM NUMERIC de confirmados más el importe nuevo se compara con 9999999999.99
  antes de cada UPDATE, incluso sin ser la última parte. Exceso da 409 sin cambios.
  La parte confirmada conserva su cuota prevista, registra actualAmount y confirmedAt.
- [x] Padre parcial conserva pending, actualAmount/resolvedAt nulos y priceChanged
  falso. Cierra solo con N > 0 y todas las partes confirmed, con suma real exacta,
  resolvedAt y comparación NUMERIC contra expectedAmount. Partes skipped impiden
  un cierre por el mero hecho de no quedar pending. El coste de suscripción no cambia.
- [x] Respuesta `{ share, payment, summary }` construida leyendo las escrituras
  mediante el mismo cliente antes del commit; rollback y liberación ante fallos.
  GET y guardas de confirm/skip directo familiar conservados; no se añadió omisión.
- [x] [Pruebas HTTP de confirmación](../../backend/src/modules/payments/payment-share-confirm.routes.test.ts):
  47 aprobadas con servicio simulado; las treinta pruebas de lectura siguen pasando.
  Cubren identidad, parámetros/body/query, decimales, espacios, respuesta y errores.
- [x] [Integración de confirmación](../../backend/src/modules/payments/payment-share-confirm.int.test.ts):
  25 pruebas PostgreSQL/HTTP reales en esquema exclusivo, sin SQL simulado. Incluyen
  defaults, corregidos, cero, parcial y cierre, 0.10 + 0.20 = 0.30, permisos,
  scoping, estados, acumulado no final y concurrente, máximo más ceros, misma parte
  HTTP 200/409 y dos últimas partes distintas cerrando una sola vez.
- [x] Esperas reales observadas con pg_blocking_pids: una baja da 403 tras esperar;
  un owner que pasa a member activo conserva su confirmación propia. Fallo de UPDATE
  del padre mediante CHECK solo local demuestra rollback de la parte; NOWAIT de
  grupo/padre/parte y reintento comprueban liberación. Respuesta HTTP coincide con GET
  posterior al commit. Las transferencias o bajas son SQL de fixture, sin nuevas API.
- [x] Suite completa con RUN_DB_TESTS=1: 517 aprobadas en 23 archivos. Sin el flag:
  311 aprobadas y 206 omitidas. Flag restaurado; typecheck y build correctos.
- [x] Servidor temporal y pools cerrados; esquema exclusivo eliminado y ausencia
  comprobada. Conteos de public conservados: diez usuarios, grupos y membresías,
  una suscripción y cero pagos, partes e invitaciones, con ocho migraciones.
  No se aplicaron migraciones ni se ejecutó generación global o servidor normal.
- [x] Contratos de partes y pagos actualizados; revisión independiente sin hallazgos.

Al cerrar esa entrega, la confirmación propia estaba disponible y la omisión del
conjunto quedaba para el bloque 9. Las rutas de grupos/invitaciones y el frontend
quedan para sus bloques correspondientes, sin anticipar otras funciones.

### Bloque 9 — Omisión familiar comprobada (26 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; conservados los cambios anteriores.
  PostgreSQL 16.15, `subscripciones_db/public`, con migraciones 001–008 y los
  conteos existentes inspeccionados antes y después de las pruebas.
- [x] La omisión del padre familiar exige owner activo, pago pendiente y al menos
  una parte, todas pendientes. Bloquea grupo, pago y partes; actualiza el conjunto
  en una transacción y conserva los importes y porcentajes de la foto. La
  confirmación directa del padre sigue prohibida y el pago personal conserva su comportamiento.
- [x] Las 64 pruebas HTTP del módulo de pagos pasaron. Las 18 pruebas nuevas de
  [integración](../../backend/src/modules/payments/payment-family-skip.int.test.ts)
  comprobaron PostgreSQL y HTTP reales, permisos, conflictos, aislamiento,
  concurrencia, revalidación tras espera y rollback con liberación de bloqueos.
- [x] Suite completa con `RUN_DB_TESTS=1`: 545 pruebas aprobadas en 24 archivos.
  Sin el flag: 321 aprobadas y 224 omitidas. Variable restaurada; typecheck y build correctos.
- [x] Esquemas temporales eliminados y conteos existentes conservados. No se
  aplicaron migraciones ni se ejecutó generación global o servidor normal.
- [x] Contratos de [pagos](../../backend/docs/payments.md) y
  [partes](../../backend/docs/payment-shares.md) actualizados.

### Bloque 10 — API de grupos comprobada (26 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; conservados los cambios anteriores.
  Inspección de PostgreSQL 16.15, `subscripciones_db/public`: migraciones 001–008,
  diez usuarios, grupos y membresías, una suscripción y cero pagos, partes e invitaciones.
- [x] [Módulo de grupos](../../backend/src/modules/groups/group.service.ts) con
  tipos públicos, mapper de fila SQL, schemas strict, controlador y router.
  GET `/groups` devuelve todos los grupos propios con membresía activa, personal
  primero y luego createdAt/id ascendentes; incluye rol actual y no expone emails.
- [x] POST `/groups` crea solo family y su membresía owner/active en una transacción.
  PATCH `/groups/:groupId` cambia solo el nombre, bloquea el grupo y revalida el
  rol antes de escribir; personal autorizado recibe 409 y falta de permiso 403 uniforme.
  Nombres recortados de 1 a 255 caracteres; type y owner no son entradas editables.
- [x] Montaje en `app.ts` detrás de requireAuth y antes de notFound, conservando
  las rutas anidadas de suscripciones, pagos y partes.
- [x] Las 61 [pruebas HTTP con pool simulado](../../backend/src/modules/groups/group.routes.test.ts)
  comprobaron validación, serialización, permisos, cliente único y errores.
  Las 14 [pruebas PostgreSQL/HTTP](../../backend/src/modules/groups/group-api.int.test.ts)
  comprobaron creación atómica, listado y orden, renombrado, aislamiento y
  regresión personal. Incluyen rollback al fallar membresía o renombrado,
  liberación de bloqueo con NOWAIT y revalidación tras democión/baja observando
  la espera real con pg_blocking_pids. Los cambios de rol son SQL de fixture,
  sin adelantar endpoints de transferencia o salida.
- [x] Suite completa con `RUN_DB_TESTS=1`: 620 pruebas aprobadas en 26 archivos.
  Sin el flag: 382 aprobadas y 238 omitidas. Variable restaurada; typecheck y build correctos.
- [x] Servidor temporal y pools cerrados, esquemas exclusivos eliminados y ausencia
  comprobada; conteos existentes y ocho migraciones conservados. No se aplicaron
  migraciones ni se ejecutó generación global o servidor normal.
- [x] Contrato y pasos de comprobación manual en [groups.md](../../backend/docs/groups.md).
  La evidencia de esta entrega es automatizada; la prueba manual del propietario
  y la interfaz familiar quedan para sus puntos de comprobación correspondientes.
- [x] Revisión independiente de módulo, montaje, pruebas y documentación cerrada
  sin hallazgos pendientes.

La API inicial permite crear familias, listarlas y renombrarlas. Al cerrar esa
entrega, miembros y ownership quedaron para el bloque 11; salida, invitaciones
y frontend permanecían pendientes.

### Bloque 11 — Miembros y ownership comprobados (26 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; conservados los cambios anteriores.
  PostgreSQL 16.15, `subscripciones_db/public`, con migraciones 001–008 y conteos
  existentes inspeccionados antes y después. Sin owners incoherentes o inactivos.
- [x] GET `/groups/:groupId/members` para miembros activos familiares: DTO con
  userId, name, role, status y joinedAt ISO, sin emails; solo activos, owner primero,
  después UUID ascendente y máximo 20. Params, query y body strict.
- [x] POST `/groups/:groupId/transfer-ownership` con UUID `newOwnerId`: owner
  revalidado después del bloqueo de grupo y destinatario distinto, member activo
  del mismo grupo, bloqueado antes de modificar. Democión, promoción y owner_id
  se actualizan juntos, en ese orden, comprobando el resultado de cada escritura.
  El solicitante recibe `{ group }` con su nuevo rol member. Personal autorizado
  devuelve 409; membresía/rol inválidos o grupo ajeno/inexistente conservan 403 uniforme.
- [x] [Servicio de miembros](../../backend/src/modules/groups/group-member.service.ts)
  separado del servicio de grupos. Conserva joined_at, estados, grupos personales,
  suscripciones, pagos, cuotas y confirmaciones históricas; no introduce bajas o invitaciones.
- [x] Las 53 [pruebas HTTP con pool simulado](../../backend/src/modules/groups/group-member.routes.test.ts)
  comprobaron contratos, permisos, filtros SQL, orden de escrituras, guardas de
  filas modificadas, commit/rollback, liberación del cliente y errores originales.
- [x] Las 20 [pruebas PostgreSQL/HTTP](../../backend/src/modules/groups/group-member.int.test.ts)
  comprobaron dos sesiones, permisos posteriores, owner único coincidente,
  conservación exacta de roles/datos no afectados e historial parcialmente confirmado.
  Fallos inducidos en promoción y owner_id revierten todo, liberan bloqueos (NOWAIT)
  y permiten reintento. Dos transferencias concurrentes producen 200/403.
  Una transferencia real bloqueada en el destinatario retiene el grupo y provoca
  que un renombrado antiguo en espera revalide y reciba 403; ambas esperas se
  observaron mediante pg_blocking_pids. Un destino retirado mientras se espera
  el grupo produce 409 sin cambios parciales.
- [x] Suite completa con `RUN_DB_TESTS=1`: 693 pruebas aprobadas en 28 archivos.
  Sin el flag: 435 aprobadas y 258 omitidas. Variable restaurada; typecheck y build correctos.
- [x] Servidor y pools de prueba cerrados, esquema exclusivo eliminado y ausencia
  comprobada. Public conserva diez usuarios, grupos y membresías, una suscripción,
  cero pagos/partes/invitaciones y ocho migraciones, con ownership coherente.
  No se aplicaron migraciones a public ni se ejecutó generación global o servidor normal.
- [x] Contrato y recorrido de dos cuentas documentados en [groups.md](../../backend/docs/groups.md).
  Las membresías iniciales y la baja concurrente son SQL limitado a fixtures;
  la evidencia de dos cuentas es automatizada con HTTP y PostgreSQL reales.
  La prueba manual del propietario no se presenta como ejecutada.
- [x] Revisión independiente de producto, pruebas y documentación cerrada sin
  hallazgos pendientes.

Al cerrar esa entrega, la salida y expulsión quedaron para el bloque 12;
invitaciones y frontend permanecían pendientes.

### Bloque 12 — Salida y expulsión comprobadas (26 de octubre de 2026)

- [x] Raíz y carpeta de trabajo coincidentes; conservados los cambios anteriores.
  PostgreSQL 16.15, `subscripciones_db/public`, con migraciones 001–008 y conteos
  inspeccionados antes y después; ownership coherente tras las pruebas.
- [x] POST `/groups/:groupId/leave` y DELETE `/groups/:groupId/members/:userId`
  devuelven 204 sin cuerpo, con params, query y body estrictos. Solo el owner
  activo puede retirar a otra persona; el owner no puede salir ni retirarse.
  Una membresía destino inexistente o no activa da 404 al owner autorizado.
- [x] [Servicio de miembros](../../backend/src/modules/groups/group-member.service.ts)
  comparte la baja lógica: autorización y revalidación tras bloqueo de grupo,
  bloqueo del miembro y comprobación de partes pending de pagos pending del
  mismo grupo y usuario. Una obligación propia pendiente da 409; las partes
  confirmadas, obligaciones ajenas y las de otros grupos no bloquean la baja.
- [x] Solo cambia `group_members.status` a removed. Se preservan rol, joined_at,
  suscripciones, pagos, partes y su historial; el usuario retirado pierde acceso
  al grupo y los miembros activos conservan la lectura histórica.
- [x] Las 62 [pruebas HTTP con pool simulado](../../backend/src/modules/groups/group-member-removal.routes.test.ts)
  comprobaron validación, permisos, owner, scope, obligaciones, errores,
  rollback y liberación del cliente. Las 25 [pruebas PostgreSQL/HTTP](../../backend/src/modules/groups/group-member-removal.int.test.ts)
  comprobaron también estado e historial exactos, pérdida de acceso, conflictos,
  dos fallos con rollback y NOWAIT, y revalidación de permisos tras la espera.
- [x] Cuatro carreras reales cubrieron salida y expulsión frente a generación,
  limitada al UUID de la suscripción de fixture. Con la baja reteniendo primero
  el grupo, SKIP LOCKED deja la suscripción sin procesar y el reintento crea partes
  solo para los miembros restantes. Si el generador retiene primero el grupo,
  crea la foto completa y la baja posterior recibe 409 por la nueva parte pendiente.
  Las esperas relevantes se observaron con pg_blocking_pids.
- [x] Suite completa con `RUN_DB_TESTS=1`: 780 pruebas aprobadas en 30 archivos.
  Sin el flag: 497 aprobadas y 283 omitidas. Variable restaurada; typecheck y build correctos.
- [x] Servidor y pools de prueba cerrados, esquemas exclusivos eliminados y ausencia
  comprobada. Public conserva diez usuarios, grupos y membresías, una suscripción,
  cero pagos/partes/invitaciones y ocho migraciones. No se aplicaron migraciones
  a public ni se ejecutó generación global o servidor normal.
- [x] Contrato y comprobación manual documentados en [groups.md](../../backend/docs/groups.md).
  La incorporación de miembros de prueba se preparó con SQL en un esquema temporal;
  la prueba manual del propietario no se presenta como ejecutada.
- [x] Revisión independiente de producto, pruebas y documentación cerrada sin
  hallazgos pendientes.

La resolución de invitaciones por el destinatario y el frontend siguen pendientes;
la Fase 5 continúa en desarrollo.

### Bloque 13 — Operaciones de invitación del owner comprobadas (26 de octubre de 2026)

- [x] Raíz y carpeta de trabajo verificadas como `E:\repos vsc\gestor-suscripciones`;
  se conservaron los cambios previos. Inspección de PostgreSQL 16.15 y del
  esquema `public` antes y después; sin migración nueva ni cambios a datos reales.
- [x] `POST /groups/:groupId/invitations` exige owner activo y grupo familiar,
  normaliza el email y rechaza self/member/duplicado. Genera 32 bytes aleatorios,
  devuelve el token solo en la creación y guarda únicamente SHA-256, con vigencia
  de siete días. No busca cuentas globalmente ni envía correo.
- [x] `GET /groups/:groupId/invitations` lista las últimas 100 del grupo, conserva
  las creadas por owners anteriores y presenta vencidas sin escribir. `POST .../revoke`
  solo revoca pending vigente; ausencia o grupo ajeno responde `404`, estado
  existente no revocable `409`.
- [x] Las escrituras bloquean el grupo y revalidan el owner. Comparaciones y
  timestamps usan `statement_timestamp()` tras obtener el bloqueo; creación fija
  `created_at` y `expires_at` juntos. Se cubrió la carrera en que la invitación
  vence durante la espera, evitando revocarla con el `NOW()` fijado al comenzar
  la transacción.
- [x] El logger redacta recursivamente token/hash/código de invitación. Errores
  SQL y de conexión en estos servicios se convierten en error genérico seguro;
  solo la colisión conocida del índice de pending se mapea a `409`.
- [x] 101 pruebas HTTP unitarias y 12 de redacción aprobadas. La integración
  HTTP/PostgreSQL aislada aprobó sus 22 casos, incluidos vencimiento durante
  bloqueo, 403/404/409, rollback y transferencia de ownership concurrente.
  Revisión independiente cerrada sin hallazgos.
- [x] Suite backend con PostgreSQL: 915 pruebas en 33 archivos. Sin
  `RUN_DB_TESTS=1`: 610 aprobadas, 305 omitidas. Variable restaurada. Typecheck
  y build correctos; el esquema temporal se eliminó y su ausencia se comprobó.
- [x] `public` conserva 10 usuarios, 10 grupos, 10 membresías, cero invitaciones,
  pagos y partes, ocho migraciones y cero esquemas `phase5_test_*`.
- [x] Contrato actualizado en [groups.md](../../backend/docs/groups.md); sin
  nuevos paquetes o migraciones. La vista previa/aceptación/rechazo del destinatario
  permanece en el bloque 14; no se adelantó interfaz ni se envió correo.

La API del owner ya permite preparar y administrar invitaciones mediante códigos
manuales. La cuenta invitada todavía no puede validar ni resolver el código; ese
ciclo corresponde al bloque 14.

## 1. Dominio y permisos

### Grupos y membresías

- El registro conserva su creación de grupo `personal` y owner activo. Las nuevas
  rutas crean exclusivamente grupos `family`; el cliente no elige `type` ni owner.
- Un grupo familiar tiene exactamente un owner activo, coincidente con
  `groups.owner_id`. El owner participa en el reparto como cualquier miembro activo.
- Un usuario puede pertenecer a varios grupos y siempre conserva su grupo personal.
- Límite inicial: 20 miembros activos por familia, para mantener acotado el trabajo
  de reparto. Comprobarlo bajo bloqueo al aceptar; una invitación no reserva plaza.
- Miembros activos leen grupo, miembros activos, suscripciones, pagos y repartos
  del grupo. Owner activo administra grupo, suscripciones, miembros e invitaciones.
- Las operaciones familiares sobre un grupo personal autorizado devuelven `409`.
  No convertir grupos ni mover suscripciones; `groupId` sigue siendo inmutable.
- Conservar `403` uniforme para grupo ajeno, inexistente, invited o removed.
  Un recurso inexistente dentro de un grupo autorizado recibe `404`.
- Las membresías existentes `invited` no otorgan acceso y no se activan al iniciar
  sesión. La aceptación válida de una invitación es la vía de incorporación.

### Entrar, salir y transferir

- Aceptar crea una membresía `member/active`, o reactiva una `invited/removed` como
  member, con `joined_at = NOW()`. Una membresía ya activa produce `409` sin cambiar
  su rol; un upsert no puede degradar a un owner.
- Salida y expulsión cambian `status` a removed; no borran filas ni partes.
- Impedir salida o expulsión si ese usuario tiene una parte pending de un pago
  pending del grupo. Una parte ya confirmada no impide salir aunque falten otras.
- El owner no se expulsa ni abandona: primero transfiere ownership a otro miembro
  activo. Si queda solo, conserva el grupo; borrarlo no forma parte de esta fase.
- Transferir conserva las partes, cambia ambos roles y `groups.owner_id` juntos.
  El owner anterior queda como member activo. Destino ajeno, inactivo o el propio
  owner actual produce conflicto, nunca una modificación parcial.
  Actualizar primero el rol del owner actual a member, después el del destino a
  owner y groups.owner_id, dentro de la misma transacción, para respetar el índice único.
- Removed pierde acceso posterior al grupo, incluso a partes históricas propias.
  El historial sigue visible para los miembros activos. No crear excepciones de
  autorización ni reasignar obligaciones antiguas al incorporar o retirar usuarios.

### Pagos personales y familiares

| Regla | Personal | Familiar |
|---|---|---|
| Generación | Un pago sin partes | Un pago con una parte por miembro activo |
| Confirmación del pago completo | Owner, como Fase 4 | Derivada de confirmar todas las partes |
| Confirmación de parte | No aplica | Solo su usuario, con membresía activa |
| Omisión del pago | Owner, como Fase 4 | Owner y todas las partes todavía pending |
| Importe real del pago | Importe confirmado por owner | Suma NUMERIC de las partes confirmadas, al cerrar todas |
| Cambio de precio | Comparación exacta existente | Comparación del total registrado con el total esperado |

`share_amount` y `share_percentage` son la cuota **prevista** capturada al generar.
`actual_amount` de cada parte registra lo declarado por esa persona. No modificar
el coste de la suscripción ni recalcular cuotas al confirmar.

Un pago familiar parcialmente confirmado continúa pending, con `actual_amount`
y `resolved_at` nulos y `price_changed = false`, respetando la migración 006.
Al confirmar la última parte, el padre pasa a confirmed con suma real,
`resolved_at` y comparación NUMERIC exacta. La marca representa una diferencia
del importe registrado; por sí sola no demuestra un cambio de tarifa del proveedor.

Solo se puede omitir el conjunto si padre y todas las partes están pending y hay
al menos una parte. Actualizar padre a skipped y todas las partes a skipped en
una transacción. Después de una confirmación parcial no se omite el conjunto;
reasignaciones, perdones y correcciones posteriores quedan fuera del alcance.

## 2. Migraciones previstas

Crear archivos nuevos; no editar migraciones aplicadas. Revisar `db/migrate.ts`
y los datos existentes antes de elegir el SQL definitivo. No ejecutar SQL al
redactar este plan.

### 007 — `007_family_groups_and_invitations.sql`

Antes de añadir constraints, detectar grupos cuyo owner no tenga membresía activa
de owner, varios owners y pagos familiares preexistentes sin reparto verificable.
Ante datos incompatibles, detenerse con diagnóstico; no borrar ni inventar historia.

- Índice único parcial sobre `group_members(group_id)` para
  `role = 'owner' AND status = 'active'`; CHECK que un rol owner esté activo.
  Esto impide múltiples owners, pero la coincidencia con `groups.owner_id` y la
  existencia de uno se mantienen mediante servicios transaccionales y pruebas.
- ENUM `group_invitation_status`: pending, accepted, declined, revoked, expired.
- Tabla `group_invitations` con id UUID, group_id FK groups RESTRICT,
  invited_by FK users RESTRICT, email TEXT normalizado, token_hash CHAR(64) UNIQUE,
  status pending por defecto, accepted_by UUID nullable FK users RESTRICT,
  created_at, expires_at y resolved_at TIMESTAMPTZ.
- CHECK de email normalizado con los espacios que elimina String.trim() y longitud
  de 1 a 254; hash hexadecimal SHA-256 de 64 caracteres en minúsculas;
  expires_at > created_at.
  Pending exige resolved_at nulo; los estados terminales exigen resolved_at.
  accepted_by presente únicamente para accepted.
- Único parcial `(group_id, email) WHERE status = 'pending'` e índices para
  listado por grupo/creación y búsqueda de pendientes por correo.
- El predicado del índice no usa `NOW()`: antes de crear otra invitación para el
  mismo grupo/email, materializar expired en la anterior vencida bajo bloqueo.

### 008 — `008_create_payment_shares.sql`

- ENUM `payment_share_status`: pending, confirmed, skipped.
- Tabla `payment_shares`: id UUID; payment_id UUID FK payments RESTRICT;
  user_id UUID FK users RESTRICT; share_amount NUMERIC(12,2) NOT NULL;
  share_percentage NUMERIC(7,4) NOT NULL; actual_amount NUMERIC(12,2) nullable;
  status pending; confirmed_at TIMESTAMPTZ nullable; created_at TIMESTAMPTZ.
- UNIQUE(payment_id, user_id); CHECK de importes finitos entre 0 y 9999999999.99
  (el máximo de NUMERIC(12,2)), y porcentaje entre 0 y 100. El límite superior
  también excluye NaN, que PostgreSQL considera mayor que los números finitos.
  Pending y skipped exigen actual_amount y confirmed_at nulos;
  confirmed exige ambos presentes.
- Reutilizar el índice creado por UNIQUE(payment_id, user_id), sin duplicarlo;
  añadir `(user_id, status, payment_id)` para consultas de partes propias.
- No duplicar group_id: obtenerlo por payment → subscription → group.
  Personal no genera partes; familiar genera al menos una y como máximo 20.
- La suma entre filas no se confía a un CHECK ordinario: se garantiza en el
  servicio transaccional y las pruebas. Al omitir partes, la fecha de resolución
  común está en el padre; confirmed_at conserva su significado original.

El modelo inicial de `01-fase.md` era preliminar: aquí se añade actual_amount a
las partes para conservar previsto y registrado; skipped para omisión coherente
del conjunto, y una tabla independiente para invitaciones a cuentas aún no creadas.
No crear tablas de notificaciones ni exigir backfill de partes personales.

En cada bloque de datos: migrate dos veces, inspeccionar constraints e índices,
comprobar compatibilidad con los datos personales y detenerse para revisar esquema.

## 3. Reparto exacto y foto de participantes

Crear `payment-sharing.ts` con una función pura que reciba el importe decimal
string y UUID de participantes y devuelva cuotas como strings. Validar importe,
al menos un participante, máximo 20 y ausencia de UUID duplicados.

1. Ordenar UUID canónicos por su valor estable, sin depender de orden de consulta.
2. Convertir la cadena decimal a céntimos BigInt, sin pasar por Number.
3. Dividir por N; entregar un céntimo adicional a los primeros R UUID, donde R
   es el resto de la división. Formatear cada importe con dos decimales.
4. Para share_percentage usar 1 000 000 unidades enteras para representar
   100.0000%; aplicar el mismo reparto y devolver cuatro decimales. Es información
   de la proporción prevista, no la fórmula para redondear los céntimos.

El resultado público contiene strings decimales, no valores BigInt que JSON no
serializa directamente. Normalizar UUID antes de comprobar duplicados y ordenar.

Ejemplos: 10.00 entre tres → 3.34, 3.33, 3.33; 0.01 entre tres → 0.01, 0.00,
0.00. El porcentaje del primer caso será 33.3334, 33.3333, 33.3333. Permitir
partes de cero, que también requieren confirmación. Un solo owner recibe 100%.

La foto usa los miembros activos **al generar**, no al leer ni según la fecha
histórica del cobro. Al recuperar atrasos puede incluir a alguien incorporado
recientemente: no existe historial suficiente para reconstruir membresías de
fechas pasadas. Explicar esa regla en la interfaz de incorporación y documentación.
Unirse después de creado un pago no crea una parte retroactiva.

## 4. Transacciones, bloqueos y generación

### Autorización frente a cambios de rol

Reutilizar pool, getActiveMembership y assertOwner; introducir únicamente un
helper pequeño de bloqueo de grupo si evita repetir SQL. No crear otra capa de
autenticación, un ORM ni un framework genérico de transacciones.

Todas las escrituras sobre recursos de grupo deben usar un cliente entre BEGIN
y COMMIT/ROLLBACK: comprobar acceso, bloquear el grupo y **revalidar membresía y
rol después del bloqueo**, antes de mutar. Adaptar también las escrituras ya
existentes de subscriptions y resolución de payments; no dejar rutas antiguas
capaces de escribir con permisos obtenidos antes de una transferencia o baja.

Orden: grupo → suscripción, si se bloquea → pago → partes por UUID. Para
invitaciones: grupo → invitación → membresía. Cuando haya varios grupos, orden
UUID estable. Liberar siempre el cliente. Lecturas siguen autorizando en servicio
y filtrando por grupo; no necesitan bloqueo exclusivo de todo el grupo.

### Adaptación del generador existente

- Seleccionar grupos con suscripciones vencidas mediante FOR UPDATE SKIP LOCKED,
  sin consumir antes el cupo de 100 suscripciones con candidatos de grupos ocupados.
  Puede haber hasta 100 grupos candidatos bloqueados; después seleccionar como
  máximo 100 suscripciones en total dentro de ellos, por fecha e id, con su bloqueo.
- Aplicar `--subscription-id` tanto al descubrimiento de grupo como a la selección
  final, para que las pruebas nunca disparen generación global.
- Releer fecha, coste, active y miembros después del bloqueo; una lectura inicial
  de candidatos no es la foto definitiva. Conservar 24 ciclos por suscripción,
  zona horaria, ancla, transacción y avance de fechas de Fase 4.
- Personal: INSERT de pago, sin partes. Familiar: INSERT con RETURNING id, capturar
  miembros activos y crear cuotas; confirmar pago, cuotas y avance juntos.
- Ante ON CONFLICT no repartir de nuevo con miembros actuales. Conservar la foto
  previa. Si un pago familiar existente carece de partes o su reparto es incoherente,
  abortar el lote con error técnico seguro; no completar la historia por suposición.
- Detectar grupos familiares sin owner coherente, sin miembros o por encima del
  límite. No avanzar fechas ni crear pagos familiares sin reparto válido.

Crear familias por HTTP se habilita **después** de que generación, resolución y
autorización estén adaptadas. No dejar un bloque intermedio en el que el scheduler
pueda producir pagos familiares con la lógica personal de Fase 4.

Retrasar POST /groups no basta para proteger familias de fixtures o preexistentes.
En el bloque 5, una vez localizado el pago dentro del grupo autorizado, añadir
guardas por tipo que devuelvan 409 para confirm y skip del padre familiar.
La confirmación directa permanece bloqueada por la regla final de partes propias;
skip continúa bloqueado hasta incorporar su actualización atómica en el bloque 9.
Así, desde que el generador del bloque 6 puede crear partes, ninguna ruta antigua
puede resolver solo el padre. Probar esos estados intermedios y no habilitar antes
los handlers familiares. Los datos familiares previos se revisan según la precondición
de migración; nunca se reparan repartiendo con miembros actuales por suposición.

### Confirmación de una parte

Con el grupo bloqueado y la membresía revalidada, bloquear padre y parte dentro
del grupo. Comprobar ownership de la parte con el usuario autenticado, no con body.
Exigir padre y parte pending. Body `{}` usa share_amount; actualAmount opcional
usa el mismo contrato decimal string de Fase 4.

Antes de actualizar, comparar en PostgreSQL la suma ya confirmada más el nuevo
importe contra `9999999999.99`, incluso si no es la última parte. Ante exceso,
devolver `409` y rollback. Así no se acumulan importes irrevocables que después
desborden el NUMERIC del padre.

Actualizar parte y consultar cuántas existen y cuántas están confirmed. Cerrar
el padre únicamente si N > 0 y todas están confirmed; sumar actual_amount en
PostgreSQL y asignar price_changed con comparación exacta. No basta comprobar
que no quedan pending: también podría haber cero partes o partes skipped.

Dos confirmaciones o confirmación frente a skip se serializan por el padre.
Repetir una resolución devuelve `409`; cualquier fallo revierte parte y padre.

## 5. Invitaciones sin envío automático de correo

- Crear con email normalizado, sin buscar si existe una cuenta: la respuesta no
  cambia por estar registrada. Sí comprobar si ya es miembro activo del grupo
  y rechazar duplicados de invitaciones vigentes. Invitarse a sí mismo no procede.
- Generar 32 bytes aleatorios con node:crypto y codificar base64url. Guardar SHA-256
  como token_hash; usar helpers propios del módulo, sin reutilizar el pepper ni
  el significado de los refresh tokens. No añadir dependencias ni secretos env.
- Caducidad fija inicial de siete días desde NOW(), TIMESTAMPTZ; no depende del
  día de facturación. Verificar vencimiento al previsualizar y resolver.
- Devolver el token bruto **solo en la respuesta de creación al owner**. Mostrar
  una vez el código `invitationId.token` para copiar y compartir manualmente.
  No enviarlo por herramientas de mensajería, logs, URL/query, storage o analítica.
- Ampliar sensitiveKeys del logger para `token_hash`, `tokenhash`,
  `invitation_token`, `invitationtoken`, `invitation_code` e `invitationcode`;
  mantener la redacción existente de `token`. No registrar cuerpos completos ni
  errores que reproduzcan el código. Comprobarlo con valores ficticios en tests.
- Si se pierde el código, revocar y crear otra invitación; GET nunca recupera
  token ni hash. No reenviar ni regenerar silenciosamente una invitación vigente.
- La pantalla receptora pide iniciar sesión y pegar el código. Preview, aceptar
  y rechazar requieren UUID, token y correo actual de users coincidente. No basta
  el email del JWT ni saber el UUID. No crear un buzón que autorice por email solo.
- Antes del bloqueo puede leerse una invitación para descubrir su grupo, limitada
  por hash y destinatario. Después bloquear grupo y releer invitación con bloqueo;
  volver a comprobar hash, destinatario, estado y expiración. No adquirir locks
  en orden invitación → grupo, opuesto al de revocación.
- Aceptar valida capacidad, crea/reactiva únicamente membresía elegible y marca
  accepted con accepted_by y resolved_at en la misma transacción. Repetir devuelve
  `409`, sin modificar una membresía que ya sea activa.
- Preview no consume; decline marca declined sin crear membresía. Owner puede
  revocar pending; un nuevo owner administra también invitaciones anteriores.
- Al crear otra para el mismo email, marcar expired la vencida dentro de esa
  transacción antes del INSERT. No confiar en un job de Fase 6. Un intento de
  aceptar algo vencido devuelve conflicto aunque la fila aún figure pending;
  no afirmar que se persistió expired si la transacción hizo rollback.

El correo de cuenta no está verificado mediante email en el producto actual.
La posesión del código compartido por el owner es una condición adicional real;
no inventar verificación de email ni entrega automática en este bloque.

## 6. Contratos HTTP previstos

Todas las rutas requieren Bearer, validate y Zod strict para params, query y body.
UUID en todos los identificadores. Listados acotados a 100 donde se indica y
orden estable por fecha DESC e id DESC. No hacer públicos hashes ni filas users.

### Grupos y miembros

| Método y ruta | Permiso | Entrada y respuesta |
|---|---|---|
| GET /groups | Autenticado | 200 `{ groups }`, todos sus grupos activos, personal primero y resto por createdAt/id; sin incluir invited/removed |
| POST /groups | Autenticado | `{ name }` trim, 1–255; 201 `{ group }` family con owner activo, creación atómica |
| PATCH /groups/:groupId | Owner activo familiar | `{ name }`; 200 `{ group }` |
| GET /groups/:groupId/members | Miembro activo familiar | 200 `{ members }`, solo activos, owner primero y resto UUID; máximo 20 |
| POST /groups/:groupId/transfer-ownership | Owner activo familiar | `{ newOwnerId }`; 200 `{ group }`, destino miembro activo |
| DELETE /groups/:groupId/members/:userId | Owner activo familiar | 204; no owner, no partes propias pending en padre pending |
| POST /groups/:groupId/leave | Miembro activo familiar | `{}`; 204, mismas restricciones sobre owner y partes pendientes |

Group: id, name, type, ownerId, role del solicitante, createdAt. Member: userId,
name, role, status y joinedAt. No incluir email de todos los miembros por defecto.
`/auth/me` conserva personalGroupId; no guardar grupo o rol dentro del JWT.
No exponer DELETE de grupos ni PATCH de type, owner_id, rol o status arbitrarios.

### Invitaciones

| Método y ruta | Permiso | Entrada y respuesta |
|---|---|---|
| POST /groups/:groupId/invitations | Owner activo familiar | `{ email }`; 201 `{ invitation, token }`, secreto una vez |
| GET /groups/:groupId/invitations | Owner activo familiar | 200 `{ invitations }`, últimas 100, sin token/hash |
| POST /groups/:groupId/invitations/:invitationId/revoke | Owner activo familiar | `{}`; 200 `{ invitation }` |
| POST /invitations/:invitationId/preview | Destinatario autenticado con código | `{ token }`; 200 `{ invitation }` y nombre de grupo/invitador |
| POST /invitations/:invitationId/accept | Destinatario autenticado con código | `{ token }`; 200 `{ group, membership }` |
| POST /invitations/:invitationId/decline | Destinatario autenticado con código | `{ token }`; 200 `{ invitation }` |

Respuesta invitation al owner/destinatario autorizado: id, groupId, groupName, email,
invitedByName, status, createdAt y expiresAt; sin accepted_by ni datos de otras
cuentas. Para la API, pending vencida se presenta expired aunque todavía no se
haya materializado ese estado en SQL. Preview solo revela estos datos después
de comprobar código y destinatario. Los otros miembros no listan invitaciones.

### Partes y compatibilidad de pagos

| Método y ruta | Permiso | Entrada y respuesta |
|---|---|---|
| GET /groups/:groupId/payment-shares?status=pending\|confirmed\|skipped | Miembro activo familiar | 200 `{ shares }`, solo partes propias, hasta 100 por expected_date/id DESC |
| GET /groups/:groupId/payments/:paymentId/shares | Miembro activo familiar | 200 `{ payment, shares, summary }`, reparto completo del pago |
| POST /groups/:groupId/payments/:paymentId/shares/:shareId/confirm | Usuario de esa parte y miembro activo | `{}` o `{ actualAmount: "3.34" }`; 200 `{ share, payment, summary }` |

Share: id, paymentId, userId, userName, shareAmount y sharePercentage como strings,
actualAmount string/null, status, confirmedAt ISO/null y createdAt ISO. El listado
propio añade el payment del contrato existente y summary para mostrar estado del
grupo. Summary: totalShares y confirmedShares como enteros, más confirmedAmount
decimal string. No sumar dinero en JavaScript para decidir estados.

Cada consulta de partes filtra payment → subscription.group_id y, cuando es propia,
también user_id autenticado. UUID de parte que no corresponde al pago/grupo: 404.
Parte ajena dentro de un pago autorizado: 403, incluido el owner.

Conservar GET de pagos y sus campos de Fase 4. Confirm del padre personal sigue
igual; en familiar, un owner recibe `409` con indicación de confirmar su propia
parte. Skip familiar usa la regla atómica del conjunto; personal conserva su ruta.
No añadir endpoint HTTP para disparar generación ni alterar expected_cost al pagar.

Errores: 400 validación; 401 sesión; 403 membresía/rol/parte ajena; 404 recurso
autorizado inexistente o invitación/código/destinatario no disponibles; 409 estado,
capacidad, partes pendientes, operación personal no permitida o total fuera de rango;
500 fallo interno. Mantener el mismo sobre JSON. Para códigos no válidos usar
`Invitation unavailable` sin distinguir UUID, token o destinatario incorrectos.
No mapear cualquier error SQL a conflicto: identificar constraint y operación.

## 7. Archivos y frontend

Reutilizar módulos existentes. Añadir `modules/groups/` para grupos/miembros e
invitaciones, con rutas/controlador/schemas/tipos/servicios pequeños; separar el
servicio de invitaciones del de miembros. Un archivo pequeño `group-lock.ts`
puede compartir el SQL de bloqueo sin mover todo el proyecto.

En `modules/payments/`: `payment-sharing.ts`, `payment-share.types.ts`,
`payment-share.schemas.ts`, `payment-share.service.ts` y handlers/rutas necesarios.
Conservar payment-generation.service, scheduler y comando actuales; extenderlos.
Modificar `app.ts` solo para montar los routers detrás de requireAuth y antes de
notFound. Añadir contextos de logger únicamente si no basta uno existente.
Los routers que hereden groupId conservan mergeParams; un router de grupos no
debe interceptar con un 404 local las rutas existentes de suscripciones y pagos.

Frontend: leer frontend/AGENTS.md y documentación local de su Next.js antes de
modificar APIs. Reutilizar apiWithSession, refresh coordinado y tokens en memoria.

- Mantener landing, login y experiencia personal. GET /groups aporta rol y type;
  seleccionar grupo en estado React y volver explícitamente al personal al recargar.
  No derivar permisos de un UUID recibido ni mantener datos del grupo anterior.
- Desmontar los paneles con key=groupId, cancelar lecturas/acciones y separar sus
  estados. Mientras se cambia de grupo, no mostrar recursos viejos bajo el nombre nuevo.
- Ante un 403, actualizar la lista de grupos y roles. Si el grupo ya no está
  disponible, desmontar sus datos y volver al personal con explicación; si sigue
  activo con otro rol, actualizar los controles sin mantener permisos visuales antiguos.
- Mantener payments-panel.tsx para personal. Añadir family-payments-panel.tsx para
  partes propias pendientes/historial, progreso global, reparto y estado del padre.
  Si el usuario entró después y no tiene parte, mostrarlo y no inventar una cuota.
- Distinguir «mi parte confirmada» de «pago del grupo confirmado». Todos los activos
  pueden consultar reparto; solo el dueño de la parte puede confirmarla. Owner
  puede intentar omitir el conjunto y debe entender un conflicto por pago parcial.
- Crear/renombrar familia y gestionar miembros con controles de owner. Para salir
  o retirar, pedir confirmación y explicar el 409 por obligaciones pendientes.
- Panel de invitaciones del owner: crear, listar estados, revocar y copiar código
  una vez. Página `/invitations`: iniciar sesión, pegar código en campo protegido,
  preview, aceptar o rechazar. Tras aceptar, actualizar grupos y permitir elegirlo.
- Código solo en memoria; no incluirlo en query, navegación a login ni storage.
  Si se navega a login, pedir pegarlo después. No registrar inputs secretos.
- Mantener importes string, DATE sin desplazamientos, mensajes en español, etiquetas,
  errores asociados, carga/vacío/error/reintento y bloqueo de envíos repetidos.

## 8. Bloques de implementación y paradas

Cada fila es una entrega independiente. Antes: explicar qué y por qué, archivos,
dependencias y concepto. Después: resultado, comprobaciones reales y limitaciones;
**detenerse después de cada bloque**. No ejecutar dos filas en una sola entrega.

| Bloque | Resultado y archivos principales | Concepto y comprobación |
|---|---|---|
| 1. Plan y entrada | Revisar 05-fase.md y este plan; contrastar cierre de Fase 4 | Revisar decisiones, discrepancias y checklist previo. Parar para lectura; sin código |
| 2. Grupos e invitaciones: datos | Migración 007 | Ownership, unicidad parcial, expiración y hash. migrate dos veces e inspección sin borrar datos |
| 3. Partes: datos | Migración 008 | FK restrictivas y coherencia de filas. Probar que pagos personales siguen válidos; parar para esquema |
| 4. Reparto puro | payment-sharing.ts y tests | BigInt, resto, porcentajes y orden estable; 10/3, 0.01/3, cero y límites sin Docker |
| 5. Escrituras coordinadas y guardas | group-lock.ts, subscription.service y payment.service | Mismo cliente y rol revalidado; confirm/skip del padre familiar bloqueados con 409 antes de generar partes; personal conservado |
| 6. Generación familiar | payment-generation.service y tests | Foto, partes y avance atómicos; fixture family, idempotencia, rollback y carreras con miembros. Parar para prueba limitada a un UUID |
| 7. Lectura de partes | Schemas/tipos/servicio/GET de partes | Scope por grupo/usuario y totales exactos; owner, member, ajeno e inactivo |
| 8. Confirmación propia | POST share confirm y agregado | Bloqueo de padre, cierre al completar y control del acumulado; 409 repetido y concurrencia |
| 9. Omisión familiar | Skip existente adaptado | Todo pending o conflicto; preservar confirmación parcial. Regresión de personal; parar para prueba HTTP |
| 10. Grupos: API | GET/POST/PATCH groups y montaje app.ts | Creación owner atómica; ahora generación/resolución ya soportan familia. Probar personal y family |
| 11. Miembros y ownership | GET members y transferencia | Dos representaciones de owner coherentes; destino activo y rollback. Parar para probar dos cuentas |
| 12. Salida y expulsión | Leave y DELETE member | Baja lógica, obligaciones y pérdida de acceso; carrera con generación |
| 13. Invitaciones del owner | Create/list/revoke y redacción logger | Código una vez, hash, expiry y cuenta inexistente sin enumeración. Probar duplicado y revocación |
| 14. Invitaciones del destinatario | Preview/accept/decline | Sesión+correo DB+código, capacidad y aceptación atómica. Probar registro posterior y dos aceptaciones concurrentes |
| 15. Panel familiar | family-payments-panel.tsx sin conectar selección todavía | Partes propias, progreso y permisos; lint/typecheck y revisión del recorrido |
| 16. Selección de grupo | dashboard/page.tsx y montaje de paneles | Contexto de grupo, cancelación y estados independientes; personal preservado. Parar para navegador |
| 17. Gestión familiar visible | Componentes de grupos/miembros del dashboard | Crear, renombrar, transferir, salir y retirar; comprobar owner/member y conflictos en navegador |
| 18. Invitaciones del owner visibles | invitations-panel.tsx | Copiar una vez, listar/revocar y mensajes; ninguna credencial en logs/storage |
| 19. Aceptación visible | app/invitations/page.tsx | Preview, aceptar/rechazar y actualizar grupos; flujo de dos cuentas y recarga. Parar para navegador |
| 20. Cierre | docs/groups.md, invitations.md, payment-shares.md y payments.md | Checklist, regresión y pruebas pertinentes; no iniciar Fase 6 |

La fase necesita más bloques que la anterior porque incorpora varios ciclos de
vida y permisos. Los agentes backend/frontend/reviewer pueden colaborar dentro
de una fila; la delegación no autoriza adelantar otra. Un escritor por archivo,
contratos claros y revisión después de disponer de implementación.

## 9. Comprobaciones concretas

Unitarios co-ubicados sin Docker: reparto, límites y rechazo de entradas, schemas
strict, permisos, códigos y errores de dominio. No introducir infraestructura de
test de frontend si navegador, lint y typecheck cubren el riesgo de ese bloque.

Integración optativa `RUN_DB_TESTS=1`, con prefijo `phase5-test-` y UUID exclusivos:

1. Crear familia produce owner coherente sin tocar su grupo personal.
2. Generar con tres miembros conserva sumas exactas; personal sigue sin partes.
3. Repetir generación conserva el reparto aun si la membresía cambió después.
4. Fallo al insertar una parte revierte pago, partes y avance de fecha.
5. Confirmar parte propia permite importe por defecto o corregido; parte ajena
   recibe 403; id/grupo/pago incompatibles reciben 404 sin filtrar datos.
6. Pago parcial permanece pending y compatible con CHECK de 006; la última parte
   fija total y price_changed. Dos últimas confirmaciones simultáneas cierran una vez.
7. Acumulado fuera de NUMERIC(12,2) da 409 y deja última parte pending.
8. Skip de todo pending conserva filas skipped; después de una confirmación
   parcial da 409 sin tocar nada. Confirmación contra skip no deja estados mixtos.
9. Alta/baja concurrente con generador produce una foto completa según el orden
   de bloqueo, nunca una mezcla. Salida bloqueada solo por sus obligaciones pendientes.
10. Transferencia contra escritura antigua revalida el rol; no quedan dos owners
    ni falta owner al commit. Owner de personal no puede convertirlo o abandonarlo.
11. Crear invitación para cuenta futura no filtra si existe. Token ausente,
    incorrecto, cuenta distinta, expiración y revocación impiden aceptación.
12. Dos aceptaciones, aceptación contra revocación y dos altas que ocupan la última
    plaza respetan unicidad y capacidad; upsert nunca degrada un owner activo.
13. Reinvitar tras expiración libera el índice parcial; ningún GET, error o log
    contiene token o hash. El código no aparece en URL, storage ni trazas del navegador.
14. Baja, reincorporación y transferencia conservan importes, usuarios y fotos
    antiguas; no conceden autoridad a una membresía legacy invited.
15. Regresión de /health, register/login/refresh/logout, suscripciones personales,
    confirm/skip personales, dashboard y recuperación de sesión.
16. Tras el bloque 5, confirm y skip del padre familiar están bloqueados. Tras
    generar partes en el bloque 6, esas rutas siguen sin poder resolver solo el
    padre; skip se habilita únicamente con su lógica completa del bloque 9.

Usar el generador con subscriptionId de fixture, no generación global. Limpiar
solo UUID creados por la prueba: partes → pagos → suscripciones; invitaciones;
membresías/grupos; refresh tokens/usuarios según sus FK. Si falta PostgreSQL,
documentar los casos omitidos; un mock no demuestra las garantías de bloqueo.

Navegador: dos cuentas de prueba, personal → crear familia → invitar por código →
aceptar → seleccionar grupo → generar pago limitado → confirmar cada parte →
comprobar cierre total, cambio de importe, historial y recarga. Añadir salida,
transferencia, conflicto parcial, API ajena y errores independientes. Conservar
la landing y comprobar ancho móvil y navegación por teclado relevante.

Comandos existentes, desde raíz: `pnpm --dir backend typecheck`, `test`, `build`;
`pnpm --dir frontend lint`, `pnpm --dir frontend exec tsc --noEmit` y `build`.
En PowerShell puede ser necesario `pnpm.cmd`. Activar RUN_DB_TESTS solo para la
comprobación pertinente y restaurar su valor después. No usar credenciales reales
en ejemplos ni leer .env; las herramientas de la aplicación cargan su configuración.

## 10. Checklist de cierre — implementación en curso

- [x] Requisito previo: cierre de Fase 4 contrastado el 24 de octubre de 2026; avance de Fase 5 registrado por bloque en la sección 0.
- [x] Migraciones 007 y 008 aplicadas mediante runner y segunda ejecución sin pendientes.
- [ ] Personal, autenticación, dinero y fechas conservan sus contratos.
- [ ] Un owner activo coherente; transferencia, bajas y límite de miembros atómicos.
- [x] Reparto exacto, estable y capturado una vez; sin redistribución histórica.
- [x] Generación, partes y avance de fecha juntos; grupos ocupados no consumen el cupo antes de SKIP LOCKED.
- [x] Solo se confirma la parte propia; padre familiar agregado y acumulado dentro de rango.
- [x] Skip global exclusivamente antes de confirmar partes; 409 preserva historia parcial.
- [ ] Invitaciones con secreto de un uso, caducidad, hash y destinatario actual comprobados.
- [ ] Aceptación no enumera cuentas, no degrada owners y no depende de correo verificado ficticio.
- [ ] Todos los endpoints limitados por grupo; roles revalidados después del bloqueo en escrituras.
- [ ] Selector, gestión de miembros y partes familiares comprobados en navegador con datos de prueba.
- [ ] Estados independientes, mensajes y confirmaciones comprensibles; sin tokens o códigos en storage/logs/URL.
- [ ] Pruebas apropiadas, integración real cuando disponible, lint/typecheck/build y límites documentados.
- [ ] Documentación HTTP actualizada y regresión personal comprobada.
- [ ] Sin gateway, envío automático, notificaciones, reparto ponderado ni cambios de Fase 6.

## Referencias técnicas para implementar

Los CHECK entre filas no sustituyen la lógica agregada del servicio: consultar
[constraints de PostgreSQL 16](https://www.postgresql.org/docs/16/ddl-constraints.html).
Los predicados de índices requieren expresiones inmutables, de ahí separar
unicidad de pending y validación temporal de invitaciones: consultar
[CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html).
Para el orden de adquisición y liberación de locks, consultar
[bloqueos explícitos](https://www.postgresql.org/docs/16/explicit-locking.html).
