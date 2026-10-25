# Cierre de Fase 4 — 24 de octubre de 2026

La Fase 4 queda cerrada con las comprobaciones siguientes. El alcance sigue
siendo registro y control de pagos: no hay movimientos de dinero, reparto
familiar, invitaciones, notificaciones ni nuevas dependencias.

## Esquema real y restricciones

Destino inspeccionado: PostgreSQL 16.15, base local `subscripciones_db`, esquema
`public`. Se consultaron `pg_constraint`, `pg_indexes`, `schema_migrations` y
`pg_tables`, sin leer ni mostrar credenciales.

- Migraciones registradas: 001 a 006.
- Tablas: users, groups, group_members, refresh_tokens, subscriptions, payments
  y schema_migrations. No existen payment_shares ni notifications.
- Verificados UNIQUE(subscription_id, expected_date), FK de payments con DELETE
  RESTRICT, CHECK de importes, coherencia de estados y rango del día de referencia.
- Presentes los índices de payments por suscripción/fecha y estado/fecha.
- Comparación de package.json con el estado anterior a 006: ninguna dependencia
  añadida; el cambio de scripts es el comando payments:generate previsto.

`payment-constraints.int.test.ts` añade 27 pruebas con PostgreSQL real. Comprueba
errores concretos 23505, 23503 y 23514, estados e importes válidos e inválidos,
anclas 0/32 rechazadas y 1/31/null admitidas. Usa UUID y prefijo
`phase4-constraints-`, suscripciones desactivadas y fechas futuras; no dispara el job.
Su limpieza comprueba cero registros restantes de esos identificadores.

## Migración y backfill sobre datos anteriores

Se creó un esquema temporal exclusivo `phase4_close_<uuid>` en la misma base.
Se preparó una fixture de versión anterior usando el SQL versionado 001 a 005
y sus registros de migración, con una suscripción existente del 31 de enero.

El runner compilado original, con search_path limitado a ese esquema, aplicó
006; billing_anchor_day quedó en 31. La segunda ejecución informó que no había
migraciones pendientes y 006 figuró una sola vez. Esto verifica idempotencia del
runner, no que el archivo SQL se pueda ejecutar arbitrariamente varias veces.

No se reaplicaron migraciones en public ni se modificaron sus suscripciones.
El esquema temporal y todas sus fixtures se eliminaron al terminar y se
comprobó su ausencia.

## Arranque y apagado de procesos reales

Se arrancaron dos procesos Node reales con `dist/server.js`, puertos temporales
y conexiones limitadas al esquema de prueba. El código del servidor, scheduler,
migraciones y generador se ejecutó sin simular esos módulos.

En la primera ejecución:

1. Una suscripción de prueba vencía en el día calculado por PAYMENT_TIME_ZONE.
2. Otra conexión mantuvo un bloqueo SHARE sobre la tabla payments del esquema
   temporal, haciendo esperar al INSERT de la ejecución inicial.
3. `/health` respondió 200 mientras el generador estaba activo; pg_stat_activity
   confirmó la espera por lock de las conexiones exclusivas de esa prueba.
4. Se pidió apagar mediante SIGTERM y después SIGINT. El proceso permaneció vivo
   y el pool abierto mientras el generador seguía esperando.
5. Al liberar el lock, el generador creó un solo pago pending, avanzó la fecha,
   terminó, se detuvo el scheduler y se cerró el pool, en ese orden. Salida 0.
   La segunda señal no duplicó el cierre.

El segundo proceso volvió a arrancar sin duplicar el pago y salió con código 0
mediante el manejador SIGINT.

**Método de señales en Windows:** el proceso padre envió mensajes IPC y el hijo
emitió SIGINT/SIGTERM dentro de su proceso Node real. Esto comprobó los
manejadores y los recursos reales; no se presenta como una prueba manual de
Ctrl+C ni como garantía frente a terminar un proceso de forma forzada.

La hora completa y los reintentos tras error siguen comprobados con el reloj
simulado de payment.scheduler.test.ts. No se esperó una hora real. La ejecución
real del generador quedó confinada al esquema de prueba.

## Fechas, API y navegador

- Las pruebas de billing-date cubren los cuatro ciclos, meses cortos, recuperación
  del día de referencia y años bisiestos. Las pruebas de integración verifican
  creación y edición del ancla, y transporte de DATE y decimales.
- Los bloques 6 y 8 ya comprobaron API y Chrome con PostgreSQL real: confirmar
  importes iguales/distintos, omitir, 409 repetido, permisos, conservación del
  historial, edición de coste y recarga de sesión.
- El bloque 8 comprobó también errores independientes de listados, 401 simultáneos
  con refresh compartido, ausencia de tokens en storage y ancho móvil. Las fixtures
  se limpiaron. El recorrido fue automatizado en navegador real; no se atribuye
  una aprobación manual al propietario.
- Se reutiliza esa evidencia: el código de frontend y de producción del backend
  no cambió al cerrar este bloque. Se añadió una suite de restricciones y documentación.

## Verificaciones y reproducción

Resultados del cierre:

- Backend typecheck y build: correctos.
- Suite completa con RUN_DB_TESTS=1: **183 pruebas aprobadas**, sin omisiones,
  en 13 archivos; incluye 43 pruebas de integración.
- Suite por defecto: **140 aprobadas y 43 omitidas**, manteniendo optativa la
  conexión a PostgreSQL. El flag se restauró al finalizar cada comando.
- Frontend lint, tsc --noEmit y build: evidencia aprobada del bloque 8, válida para
  el mismo código. Su build descargó las fuentes existentes de Google Fonts.
- Revisión de cierre y comprobación de Markdown/diff registradas en el plan.

Desde la raíz en PowerShell, para repetir únicamente la nueva suite de restricciones:

```powershell
$previousRunDbTests = $env:RUN_DB_TESTS
try {
  $env:RUN_DB_TESTS = '1'
  pnpm.cmd --dir backend test src/modules/payments/payment-constraints.int.test.ts
} finally {
  if ($null -eq $previousRunDbTests) {
    Remove-Item Env:RUN_DB_TESTS -ErrorAction SilentlyContinue
  } else {
    $env:RUN_DB_TESTS = $previousRunDbTests
  }
}
```

Para la suite completa, usar `pnpm.cmd --dir backend test` con el mismo flag.
Para observar el uso normal, arrancar el backend y seguir
[la documentación de pagos](payments.md) y
[el recorrido del dashboard](../../frontend/README.md#dashboard-personal--fase-4-bloque-8).
El uso normal del servidor procesa las suscripciones de la base configurada;
las pruebas de cierre utilizaron fixtures o el esquema aislado.
