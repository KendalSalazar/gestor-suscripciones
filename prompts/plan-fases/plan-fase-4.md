# Plan Fase 4 — Pagos y generación programada

Guía de implementación para este proyecto individual de aprendizaje. Ejecutar **un bloque por vez** y detenerse después de explicar y verificar cada bloque. Este documento describe la fase completa; no autoriza adelantar la Fase 5 ni la Fase 6.

**Estado: Fase 4 cerrada el 24 de octubre de 2026.** La evidencia, el método de
las pruebas y sus límites están en [el informe de cierre](../../backend/docs/phase-4-verification.md).
El apartado siguiente conserva el punto de partida histórico de la fase.

## 0. Estado y alcance

El repositorio ya tiene migraciones 001–005, autenticación Bearer con refresh por cookie, grupos personales, memberships, CRUD de suscripciones y dashboard. La tabla subscriptions contiene expected_cost NUMERIC(12,2), billing_cycle, next_billing_date DATE y active. El backend usa Express 5, pg, Zod, Winston, SQL directo y un runner de migraciones por filename. El frontend usa Next.js App Router y fetch. Antes de implementar, contrastar este resumen con los archivos reales.

**Objetivo:** cada fecha de cobro vencida de una suscripción activa produce un pago pending con el importe esperado de ese momento. El owner puede confirmarlo con el importe pagado o marcarlo skipped. La comparación exacta de ambos importes determina price_changed. El dashboard muestra pendientes e historial del grupo personal.

**Fuera de alcance:** pasarelas de pago, pagos manuales sin suscripción, payment_shares, reparto familiar, invitaciones, notificaciones, centro de anomalías, corrección retroactiva de pagos resueltos y paginación. El job de pagos vencidos sin confirmar y las notificaciones son de Fase 6.

## 1. Decisiones de dominio

1. Un pago pertenece a una suscripción. El grupo se obtiene a través de subscriptions.group_id; no se duplica group_id en payments.
2. Un miembro activo del grupo puede listar pagos. Solo el owner activo puede confirmar u omitir. Invited, removed, grupo inexistente o grupo ajeno reciben 403, siguiendo la Fase 3. Un pago inexistente en un grupo autorizado recibe 404.
3. expected_amount es una copia del expected_cost al generar el pago. Cambiar el costo de la suscripción después no altera pagos existentes.
4. Confirmar sin actualAmount acepta expected_amount. Si se envía actualAmount, debe ser un string decimal no negativo, de hasta dos decimales y dentro de NUMERIC(12,2). El servicio compara NUMERIC con NUMERIC en PostgreSQL; price_changed es verdadero solo cuando difieren. No actualizar automáticamente subscriptions.expected_cost.
5. Un pago pending puede pasar a confirmed o skipped una sola vez. Repetir una resolución devuelve 409. No hay transición inversa en esta fase.
6. Desactivar una suscripción impide generar pagos nuevos, pero no oculta ni borra pagos ya generados. El DELETE de una suscripción con pagos devuelve 409 y sugiere desactivarla. Una suscripción sin pagos conserva el DELETE 204 de Fase 3.
7. La siguiente fecha se calcula desde next_billing_date y un billing_anchor_day (1–31). Para meses sin ese día, usar el último día del mes; en la próxima recurrencia volver a intentar el día de referencia. Ejemplos: 31 de enero → 28 de febrero → 31 de marzo; 29 de febrero de un año bisiesto → 28 de febrero → 28/29 según el año. Weekly suma siete días; monthly, quarterly y yearly avanzan 1, 3 y 12 meses.
8. La fecha de hoy para el job usa PAYMENT_TIME_ZONE; valor por defecto America/Costa_Rica. DATE se transporta como YYYY-MM-DD, sin convertirlo a una hora local. El intervalo del job es de una hora y también se ejecuta al arrancar. Si el servidor estuvo apagado, recupera fechas vencidas por lotes; no crea registros futuros.

## 2. Migración 006

Crear backend/src/db/migrations/006_create_payments.sql.

- Añadir billing_anchor_day SMALLINT a subscriptions con CHECK entre 1 y 31. Rellenar filas existentes con el día de next_billing_date. Permitir NULL para que una versión anterior del backend pueda seguir insertando durante el cambio; el nuevo código siempre lo establecerá al crear o editar nextBillingDate. El job inicializará cualquier NULL con el día de la fecha que procese.
- Crear ENUM payment_status con pending, confirmed y skipped.
- Crear payments con id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT, expected_date DATE NOT NULL, expected_amount NUMERIC(12,2) NOT NULL, actual_amount NUMERIC(12,2), status payment_status NOT NULL DEFAULT pending, price_changed BOOLEAN NOT NULL DEFAULT FALSE, resolved_at TIMESTAMPTZ y created_at TIMESTAMPTZ NOT NULL DEFAULT NOW().
- Añadir UNIQUE (subscription_id, expected_date), CHECK expected_amount >= 0 y CHECK actual_amount IS NULL OR actual_amount >= 0.
- Añadir CHECK de coherencia: pending exige actual_amount y resolved_at nulos y price_changed falso; confirmed exige ambos presentes y price_changed igual a (actual_amount <> expected_amount); skipped exige actual_amount nulo, resolved_at presente y price_changed falso.
- Índices en (subscription_id, expected_date DESC) y (status, expected_date). No crear payment_shares ni notifications.

El runner aplica el archivo y registra su nombre en schema_migrations. Ejecutar migrate dos veces: la primera aplica 006 y la segunda informa que no hay migraciones pendientes. Inspeccionar constraints, índices y el backfill sin borrar datos de desarrollo.

## 3. Generación de pagos

Crear una función pura nextBillingDate(currentDate, billingCycle, anchorDay) que reciba y devuelva YYYY-MM-DD. Usar calendario UTC solo para aritmética de días y meses, sin convertir DATE a instantes para la API. Probar fin de mes, año bisiesto y los cuatro ciclos.

El servicio runDuePayments(today) recibe un YYYY-MM-DD explícito para poder probarlo. En una transacción:

1. Seleccionar hasta 100 subscriptions activas con next_billing_date <= today, ordenadas por fecha e id, usando FOR UPDATE SKIP LOCKED.
2. Por cada suscripción, procesar hasta 24 ciclos vencidos en esta ejecución. Insertar un pago pending por fecha con el expected_cost actual, usando ON CONFLICT (subscription_id, expected_date) DO NOTHING.
3. Avanzar next_billing_date con nextBillingDate y conservar billing_anchor_day. Si estaba NULL, fijarlo desde el primer día procesado.
4. Confirmar los INSERT y el avance juntos. Ante error, hacer ROLLBACK. El siguiente ciclo del job continuará cualquier atraso que supere los límites.

La restricción única evita duplicados, el bloqueo evita que dos procesos avancen la misma suscripción a la vez y la transacción evita que se avance la fecha sin crear el pago. Una ejecución repetida sin fechas vencidas no cambia nada. Registrar conteos y errores técnicos; no registrar tokens ni bodies completos.

Añadir un comando pnpm payments:generate que conecte a PostgreSQL, ejecute migraciones pendientes, invoque una corrida y cierre el pool. Sin argumentos procesa todas las suscripciones vencidas; --subscription-id <uuid> limita una comprobación manual a una sola suscripción. No exponer un endpoint HTTP para disparar el job.

## 4. API de pagos

Montar /groups/:groupId/payments detrás de requireAuth en app.ts. Reutilizar validate, AppError y getActiveMembership; mantener las comprobaciones de permisos en el servicio. Validar groupId y paymentId como UUID y query/body con Zod strict. Todas las consultas de un pago deben filtrar por el group_id de su suscripción.

| Método y ruta | Permiso | Contrato |
|---|---|---|
| GET /groups/:groupId/payments?status=pending\|confirmed\|skipped | owner o member activo | 200 { payments: [...] }; filtro opcional, máximo 100, expected_date DESC e id DESC |
| POST /groups/:groupId/payments/:paymentId/confirm | owner activo | Body {} o { "actualAmount": "17.99" }; 200 { payment } |
| POST /groups/:groupId/payments/:paymentId/skip | owner activo | Body vacío; 200 { payment } |

Cada payment de respuesta contiene id, subscriptionId, subscriptionName (nombre actual de la suscripción), expectedDate YYYY-MM-DD, expectedAmount string, actualAmount string o null, status, priceChanged, resolvedAt ISO o null y createdAt ISO. No incluir filas de usuarios, roles, hashes ni tokens.

En confirm/skip, bloquear la fila del pago y consultar su suscripción dentro del grupo autorizado. Si no existe: 404. Si status no es pending: 409 Payment already resolved. Actualizar estado, importe, price_changed y resolved_at en la misma transacción. Comparar importes mediante NUMERIC de PostgreSQL. Errores: 400 validación, 401 autenticación, 403 grupo/rol, 404 pago, 409 transición o eliminación con historial, 500 error interno. Mantener { error: { message, status } }.

Actualizar el servicio de subscriptions para que create establezca billing_anchor_day y PATCH de nextBillingDate lo restablezca al día enviado. Al borrar, mapear exclusivamente la violación de la FK de payments a AppError(409, 'Subscription has payment history; deactivate it instead'); otros errores de base de datos conservan el manejo actual.

## 5. Programación y frontend

Tras assertDbConnection y runMigrations, iniciar un scheduler local con setInterval cada hora y ejecutar una corrida inicial. Calcular today con Intl.DateTimeFormat y PAYMENT_TIME_ZONE; validar la zona al cargar configuración. Impedir dos corridas simultáneas dentro del proceso y capturar errores para que el servidor siga activo; una próxima corrida reintentará. En SIGINT/SIGTERM, detener el intervalo, esperar la corrida activa y entonces cerrar el pool. No añadir dependencias.

Antes de modificar Next.js, leer frontend/AGENTS.md y la documentación local de Next correspondiente. Reutilizar api.ts y el access token en memoria. En el dashboard personal:

- Mostrar pendientes e historial, con carga, vacío y error independientes del listado de suscripciones.
- Para confirmar, prellenar el importe esperado y permitir corregirlo. Para omitir, pedir confirmación. Refrescar la lista tras cada respuesta.
- Destacar priceChanged cuando el pago confirmado difiere del esperado.
- Permitir editar explícitamente expectedCost con el PATCH de suscripciones existente. Los pagos anteriores conservan su importe esperado.
- Ante un 409 al borrar una suscripción con historial, explicar que puede desactivarla. No añadir interfaz de familia ni notificaciones.

## 6. Bloques y puntos de parada

| Bloque | Hacer | Verificar y aprender |
|---|---|---|
| 1. Plan y contexto | Crear 04-fase.md y este plan; dejar visibles los Markdown de prompts en Git | Revisar alcance, contratos y archivos que Git mostrará. **Parar para lectura del plan.** |
| 2. Datos | Migración 006 y backfill | migrate dos veces, revisar tabla, FK, UNIQUE y CHECK. **Parar para revisión del esquema.** |
| 3. Fechas | Función pura de recurrencia y tests | Casos de fin de mes, año bisiesto y cuatro ciclos. Explicar anchor day. |
| 4. Generación | Servicio transaccional y comando manual | Crear una suscripción vencida de prueba, generar, repetir sin duplicados, desactivar y comprobar que no genera. **Parar para prueba manual.** |
| 5. Lectura | GET y permisos | Owner/member activos leen; usuario ajeno e inactivos reciben 403. |
| 6. Resolución | Confirm, skip y protección de DELETE | Confirmar importes iguales/distintos, repetir para 409 y conservar historial. **Parar para prueba HTTP.** |
| 7. Scheduler | Ejecución inicial y horaria, apagado limpio | Comprobar corrida al iniciar, logs seguros y reintento tras error. |
| 8. Dashboard | Pendientes, historial y acciones | Probar login → pago pending → confirmación/cambio de precio, skip y recarga. **Parar para prueba en navegador.** |
| 9. Cierre | backend/docs/payments.md y checklist | Ejecutar verificaciones finales; no iniciar Fase 5. |

Después de **cada** bloque, explicar qué cambió, por qué, qué archivos participaron, qué concepto se practicó y cómo comprobarlo antes de avanzar. No implementar dos bloques en una sola entrega.

## 7. Pruebas y checklist final

Tests unitarios co-ubicados: fechas, schemas de importes, parámetros y estados. Tests de integración optativos con PostgreSQL local para transacciones, idempotencia, snapshots de costo, permisos, confirm/skip y protección de DELETE. Los datos de prueba deben tener un prefijo exclusivo y limpiarse solo por ese prefijo; pnpm test debe seguir funcionando sin Docker. Usar un flag RUN_DB_TESTS=1 para habilitar la integración local. Probar HTTP y navegador manualmente en los puntos indicados.

- [x] 006 aplicada una vez e idempotente al repetir migrate.
- [x] Pagos únicos por suscripción y fecha; FK restrictiva y constraints de estado/importe, inspeccionados en public y comprobados con 27 pruebas nuevas de integración.
- [x] Ancla de facturación y recurrencia correcta en meses cortos y años bisiestos; tests de fechas aprobados y backfill real de 006 comprobado en esquema aislado.
- [x] Job transaccional, acotado e idempotente; ignora suscripciones inactivas y recupera atrasos (servicio, comando manual y programación horaria implementados y comprobados).
- [x] Bloque 5: GET de pagos y permisos implementados; validación, membresía, consulta delimitada por grupo y serialización comprobadas. Lectura del historial por HTTP con PostgreSQL local verificada en el bloque 6.
- [x] Bloque 6: confirm/skip de owner, transacción con bloqueo, comparación NUMERIC, DELETE con historial y ancla de suscripciones implementados y verificados. Backend typecheck y build correctos; 135 pruebas aprobadas con RUN_DB_TESTS=1, sin omisiones (11 de integración de resolución, incluida una HTTP con PostgreSQL real). Concurrencia, rollback y limpieza de fixtures comprobados; revisión sin hallazgos. El punto de prueba HTTP se comprobó mediante una prueba automatizada con Bearer y la base local subscripciones_db; detenerse para revisión antes del bloque 7.
- [x] Bloque 7: corrida inicial y horaria, exclusión de solapamientos, captura de fallos y reintento, apagado con espera de corrida activa y zona horaria documentada. Suite completa con RUN_DB_TESTS=1 aprobada (156 pruebas, sin omisiones), typecheck y build correctos; revisión sin hallazgos. Las 9 pruebas del scheduler usan reloj simulado y las 12 de servidor/configuración usan dependencias simuladas; no se ejecutó el ciclo de vida de un proceso real ni generación global para verificar. Detenerse para revisión antes del bloque 8.
- [x] Bloque 8: dashboard personal con pendientes e historial independientes, confirmación con importe editable, omisión con confirmación, diferencia de importe, edición explícita del coste y explicación de DELETE con historial. Frontend lint, tsc --noEmit y build aprobados; revisión sin hallazgos. Flujo comprobado en Chrome con frontend de producción, API y PostgreSQL reales usando datos exclusivos que se limpiaron: login, recarga con refresh, acciones, conflictos, errores independientes, refresh coordinado ante 401 y vista móvil. No se ejecutó el scheduler global para las pruebas. Detenerse para revisión antes del bloque 9.
- [x] Bloque 9: documentación final de pagos/dashboard e informe de cierre; esquema real inspeccionado, suite ampliada y procesos Node reales probados en esquema aislado. 183 pruebas aprobadas con RUN_DB_TESTS=1, sin omisiones; por defecto 140 aprobadas y 43 de integración omitidas. Backend typecheck/build correctos. El apagado esperó al generador real; señales emitidas por IPC dentro de los hijos Node en Windows, sin atribuir prueba manual de Ctrl+C. Fixtures y esquema temporal eliminados. Revisión final sin hallazgos pendientes; enlaces Markdown y diff comprobados.
- [x] Autenticación, membresía y rol correctos; aislamiento por grupo en cada consulta.
- [x] Confirmar/omitir una sola vez; importes string, priceChanged exacto, fechas YYYY-MM-DD.
- [x] DELETE conserva historial con 409; desactivar sigue disponible.
- [x] Dashboard muestra pendientes, historial, errores y acciones sin almacenar tokens en storage.
- [x] backend typecheck, test y build (bloque 7); frontend lint, typecheck y build (bloque 8).
- [x] Recorridos de API y navegador comprobados con HTTP y Chrome automatizado sobre API/PostgreSQL reales; método documentado, sin atribuir aprobación manual al propietario.
- [x] backend/docs/payments.md actualizado, enlazado al dashboard y al informe de cierre; sin tablas o implementación de payment_shares/notificaciones ni dependencias nuevas.
