# Pagos — API, generación programada y dashboard (Fases 4 y 5)

Fase 4 cerrada el 24 de octubre de 2026. Ver
[evidencia y alcance de las comprobaciones](phase-4-verification.md).
El bloque 5 de Fase 5 coordina las escrituras por grupo y bloquea la confirmación
directa del pago familiar. El bloque 6 incorpora la generación familiar con
su reparto. Las acciones de partes siguen el [plan vigente](../../prompts/plan-fases/plan-fase-5.md).
Los bloques 7 y 8 permiten consultar [partes y reparto, y confirmar la parte propia](payment-shares.md),
con el cierre agregado del pago al completar todas sus partes. El bloque 9
permite omitir conjuntamente un pago familiar y sus partes pendientes.

## Listar pagos de un grupo

`GET /groups/:groupId/payments`

Requiere un access token válido en `Authorization: Bearer <accessToken>`.
`groupId` debe ser un UUID. El servicio comprueba la membresía activa antes de
consultar pagos y limita la consulta al grupo de la suscripción asociada.

| Membresía en el grupo | Resultado |
|---|---|
| Owner activo | `200` |
| Member activo | `200` |
| Invited, removed o sin membresía | `403 Forbidden` |

Un grupo inexistente devuelve el mismo `403` para no revelar su existencia.

El filtro opcional `?status=pending`, `?status=confirmed` o `?status=skipped`
limita el listado a ese estado. Sin filtro se incluyen todos los estados.
Otros parámetros, valores inválidos o un filtro repetido devuelven `400`.
No hay paginación: se devuelven como máximo 100 pagos, ordenados por
`expected_date DESC, id DESC`.

Respuesta `200`:

```json
{
  "payments": [
    {
      "id": "c3f47c53-b125-4e3e-b04d-e2c9a6b31351",
      "subscriptionId": "63da8815-7dcc-449d-a7c7-d27826b64d90",
      "subscriptionName": "Plan Premium",
      "expectedDate": "2026-10-01",
      "expectedAmount": "17.99",
      "actualAmount": null,
      "status": "pending",
      "priceChanged": false,
      "resolvedAt": null,
      "createdAt": "2026-10-01T06:00:00.000Z"
    }
  ]
}
```

Un grupo autorizado sin pagos devuelve `200 { "payments": [] }`.
Los importes se conservan como strings decimales; `expectedDate` conserva
`YYYY-MM-DD` y los timestamps se serializan como ISO. `subscriptionName`
es el nombre actual de la suscripción. Desactivarla no oculta sus pagos.
No se incluyen datos de usuarios, roles ni credenciales en la respuesta.

## Confirmar un pago pendiente

`POST /groups/:groupId/payments/:paymentId/confirm` — solo owner activo.

En un grupo familiar autorizado, un pago existente devuelve `409` con
`Family payments must be confirmed through individual shares`, sin modificar
el pago ni sus partes. La confirmación directa del pago completo queda reservada
al modo personal. En familia, cada persona confirma su parte mediante la
[ruta de confirmación propia](payment-shares.md#confirmar-la-parte-propia).

Enviar `Content-Type: application/json` y un objeto vacío `{}` para aceptar el
importe esperado del pago. Para corregirlo, enviar un string decimal:

```json
{ "actualAmount": "19.99" }
```

Se aceptan importes no negativos con hasta dos decimales y dentro de
`NUMERIC(12,2)`, hasta `9999999999.99`. No se aceptan números JSON, negativos,
notación exponencial ni campos adicionales. Ambos identificadores deben ser
UUID; esta acción no acepta parámetros de query.

Devuelve `200 { "payment": { ... } }`, con los mismos campos del listado:
`status: "confirmed"`, `actualAmount` como string y `resolvedAt` como timestamp
ISO. `priceChanged` indica si el importe confirmado difiere del esperado;
la comparación se hace con `NUMERIC` en PostgreSQL, por lo que `17.9` y `17.90`
son iguales. El costo de la suscripción y el importe esperado del pago se conservan.

## Omitir un pago pendiente

`POST /groups/:groupId/payments/:paymentId/skip` — solo owner activo.

En una familia, el owner puede omitir el pago completo si el padre está pending,
existe al menos una parte y todas las partes siguen pending. El pago y todas sus
partes pasan a skipped en una misma transacción. Se conservan los importes
previstos y el historial; actualAmount queda nulo. El pago registra resolvedAt,
y confirmedAt de las partes permanece nulo.

Si alguna parte ya fue confirmada u omitida, o el pago no tiene partes, la
acción devuelve `409` sin modificar el conjunto. También devuelve `409` si el
pago ya estaba resuelto. No se admite omitir una parte individual.

Los conflictos específicos son `Family payment has no shares` y
`Family payments can only be skipped while all shares are pending`. Si el pago
ya fue resuelto, se conserva el mensaje `Payment already resolved`.

Enviar sin cuerpo o con `{}`. No se aceptan campos ni parámetros de query.
Devuelve `200 { "payment": { ... } }` con `status: "skipped"`, `actualAmount: null`,
`priceChanged: false` y `resolvedAt` presente.

## Permisos y resolución única

Solo un owner activo puede confirmar u omitir. Un member activo puede leer,
pero las acciones devuelven `403`. Invitados, removidos, grupos ajenos e
inexistentes también reciben `403`.

Si el grupo está autorizado pero el pago no existe en él, se devuelve `404
Payment not found`. Un pago de otro grupo tampoco es accesible por conocer su UUID.
Un pago confirmado u omitido devuelve `409 Payment already resolved` ante una
nueva omisión. En el modo personal también se aplica a la confirmación repetida.
La confirmación directa de un padre familiar sigue bloqueada.

Cada acción usa un único cliente de transacción: comprueba la membresía, bloquea
primero el grupo con `FOR UPDATE`, vuelve a comprobar membresía activa y rol owner,
y bloquea después el pago con `FOR UPDATE OF p`. Al omitir una familia, bloquea
también sus partes por id antes de verificar y actualizar el conjunto. Si pierde
el permiso durante la
espera, devuelve `403` antes de leer o resolver el pago. Si el pago no está dentro
del grupo autorizado, devuelve `404` antes de aplicar la guarda familiar.
Si llegan dos resoluciones simultáneas, una espera y comprueba el estado actualizado.
Los errores hacen rollback y el cliente se devuelve al pool.

Una suscripción con pagos devuelve `409` al intentar borrarla, con el mensaje
`Subscription has payment history; deactivate it instead`. Puede desactivarse
con el PATCH existente; su historial se conserva y sigue siendo consultable.

## Errores

Formato: `{ "error": { "message": string, "status": number } }`.

| Estado | Significado |
|---|---|
| `400` | UUID, query o body inválidos; JSON mal formado |
| `401` | Bearer ausente, inválido o caducado |
| `403` | No existe membresía activa o la acción requiere owner |
| `404` | El pago no existe dentro del grupo autorizado |
| `409` | Pago resuelto, confirmación directa familiar, conjunto no apto para omitir o borrado con historial |
| `500` | Error interno |

## Generación familiar y recuperación de fechas (Fase 5, bloque 6)

El generador inicia una transacción y bloquea hasta 100 grupos disponibles con
suscripciones activas vencidas, ordenados por UUID. Usa `FOR UPDATE SKIP LOCKED`
para omitir grupos ocupados antes de consumir el cupo de suscripciones. Después
relee y bloquea hasta 100 suscripciones en total dentro de esos grupos, por fecha
e id. El filtro opcional `--subscription-id` se aplica en ambas selecciones.

En personal crea el pago sin partes. En familia comprueba que existan entre uno
y veinte miembros activos, incluido un único owner coincidente con groups.owner_id.
Con el grupo bloqueado, captura esos participantes y usa el reparto exacto para
insertar una parte pending por persona, con importe previsto y porcentaje como
decimales. El pago, las partes y el avance de next_billing_date se confirman juntos;
un fallo revierte todos esos cambios. Se mantienen el día de referencia y el
límite de 24 ciclos por suscripción y ejecución.

La foto corresponde a los miembros activos **al generar**, incluso al recuperar
cobros atrasados. Entrar o salir después no redistribuye pagos ya creados. Ante
un conflicto de unicidad por suscripción/fecha, se conserva el pago existente.
En familia se valida su reparto con el importe original y los UUID guardados,
sin usar el coste ni la membresía actuales; no se cambian estados ni importes reales.
Si falta una foto o sus cuotas son incoherentes, el lote falla sin repararla.

La confirmación directa del padre familiar sigue devolviendo 409: cada persona
confirma su propia parte. El owner puede omitir el conjunto mientras todas sus
partes sigan pendientes, como se describe en la sección de omisión.

Para una comprobación limitada, usar exclusivamente el UUID de una suscripción
de prueba desde la raíz:

```powershell
pnpm.cmd --dir backend payments:generate --subscription-id <uuid-de-prueba>
```

En el entorno Windows donde tsx no puede iniciar, el mismo comando compilado se
puede ejecutar desde backend después de `pnpm.cmd build`:

```powershell
node dist/modules/payments/generate-payments.cli.js --subscription-id <uuid-de-prueba>
```

Ambos comandos usan el día de PAYMENT_TIME_ZONE y el runner existente. El CLI
conserva su capacidad de procesar toda la base cuando se ejecuta sin filtro; las
pruebas con PostgreSQL de este bloque pasan siempre un UUID exclusivo de fixture.

`payment-generation-family.int.test.ts` comprueba el bloque con un Pool de
PostgreSQL real dirigido a un esquema temporal exclusivo. Sustituye únicamente
la conexión exportada, sin simular SQL. Sus 18 casos cubren cuotas, atrasos,
reintentos, corrupción, compatibilidad personal y rollback por un CHECK de prueba
instalado solo en ese esquema. También prueban SKIP LOCKED ante altas/bajas y una
cadena de dos esperas observadas con pg_blocking_pids: el generador espera por la
tabla de partes de prueba y una incorporación espera por el grupo del generador.
Al terminar se elimina el esquema temporal y se cierran los pools.

Los ocho unitarios de `payment-generation.service.test.ts` comprueban los filtros,
el SQL de selección y los límites sin PostgreSQL. Sus llamadas sin UUID usan un
cliente simulado; no ejecutan generación global sobre una base real.

## Generación programada (Fase 4, bloque 7)

El servidor inicia el scheduler después de comprobar la conexión y aplicar las
migraciones pendientes. Ejecuta una corrida inicial y vuelve a llamar al servicio
generador cada hora mediante `setInterval`, sin dependencias adicionales.

Cada corrida calcula la fecha actual con `Intl.DateTimeFormat` y
`PAYMENT_TIME_ZONE`, cuyo valor por defecto es `America/Costa_Rica`. La zona se
valida al cargar la configuración; una zona inválida impide el arranque. Las
fechas de los pagos siguen siendo `YYYY-MM-DD`.

Solo puede haber una corrida activa del scheduler por instancia del servidor.
Si llega otro intervalo mientras sigue trabajando, se omite ese intento. Un
fallo se captura y la siguiente corrida horaria vuelve a intentarlo sin detener
el servidor. Los logs del scheduler incluyen intervalo, zona y código de error;
el generador existente registra los conteos de cada corrida.

El temporizador funciona mientras el proceso está activo. Al reiniciar, el
generador recupera cobros vencidos con sus límites existentes: hasta 100
suscripciones y 24 ciclos por suscripción en cada corrida. Los atrasos restantes
continúan en las siguientes horas. PostgreSQL conserva sus garantías de bloqueo,
transacción y unicidad frente a otros procesos o al comando manual.

Al recibir `SIGINT` o `SIGTERM`, se cancela el intervalo y se dejan terminar
la corrida activa y las peticiones HTTP en curso antes de cerrar el pool.
Una segunda señal no repite el cierre. En Windows, `Ctrl+C` permite comprobar
el manejador de `SIGINT`; finalizar el proceso de forma forzada no garantiza
que se ejecute este apagado ordenado.

## Dashboard personal

El dashboard permite consultar pendientes e historial con carga, vacío, error y
reintento independientes del listado de suscripciones. Confirmar prellena el
importe esperado y permite corregirlo; omitir pide confirmación. Después de
resolver o recibir un conflicto 409, las listas vuelven a consultar la API.

El historial destaca importes diferentes al esperado. El coste de la suscripción
se edita explícitamente para pagos futuros; los anteriores conservan su captura.
Ante DELETE con historial, la interfaz explica que se puede desactivar. Los tokens
siguen en memoria y la cookie httpOnly permite recuperar sesión al recargar.

Consultar [el recorrido y los archivos del frontend](../../frontend/README.md#dashboard-personal--fase-4-bloque-8).

## Comprobación

Desde un cliente HTTP, enviar `GET http://localhost:3001/groups/<groupId>/payments?status=pending`
con el Bearer de una cuenta de prueba. Comprobar también el listado sin filtro,
un grupo ajeno (`403`), una petición sin Bearer (`401`) y `?status=paid` (`400`).
Los pagos de prueba se obtienen mediante el comando manual descrito arriba,
limitado al UUID de la suscripción de prueba.

`pnpm --dir backend test` comprueba el recorrido HTTP con autenticación real
y respuestas de PostgreSQL simuladas: validación, membresía, consulta
delimitada por grupo, serialización, acciones de owner, errores y cierre de
transacciones. Estas pruebas no conectan a PostgreSQL ni sustituyen una
comprobación HTTP contra la base local.

Las pruebas optativas de `payment-resolution.int.test.ts` requieren PostgreSQL
local con la migración 006 aplicada. Crean usuarios, grupos personales,
suscripciones y pagos exclusivos con prefijo `phase4-resolution-` y UUID;
al finalizar eliminan solo esos datos. No aplican migraciones ni ejecutan el
generador global. Comprueban importes reales, captura del importe esperado,
concurrencia, rollback, permisos, ancla y conservación del historial. Incluyen
también una prueba HTTP con la aplicación, Bearer y PostgreSQL reales; el servidor
usa un puerto local temporal y se cierra al finalizar.

Para ejecutarlas desde PowerShell:

```powershell
$env:RUN_DB_TESTS = '1'
try {
  pnpm.cmd --dir backend test src/modules/payments/payment-resolution.int.test.ts
} finally {
  Remove-Item Env:RUN_DB_TESTS
}
```

Punto de prueba manual del bloque 6 de Fase 4, con pagos personales distintos de una suscripción de prueba:

1. Confirmar uno con `{}`: el importe real debe coincidir con el esperado y `priceChanged` ser falso.
2. Confirmar otro con un importe diferente: debe devolver `priceChanged: true` sin cambiar el costo de la suscripción.
3. Omitir otro sin cuerpo: debe devolver `skipped` y el importe real nulo.
4. Repetir cada acción: debe devolver `409`. Con un member activo, debe devolver `403`.
5. Intentar borrar la suscripción: debe devolver `409`. Desactivarla y listar pagos: el historial debe seguir presente.

Comprobación ejecutada de los bloques 5 y 6: suite completa con `RUN_DB_TESTS=1`
aprobada (135 pruebas, sin omisiones), además de typecheck y build. La prueba
HTTP con PostgreSQL real cubre los cinco pasos anteriores; los datos exclusivos
se limpian al finalizar. La generación del bloque 4 también pasó sus cinco
pruebas de integración.

Para el bloque 7, `payment.scheduler.test.ts` usa un reloj simulado para comprobar
la corrida inicial, el intervalo de una hora, cambios de día, ausencia de
solapamientos, reintento y espera al detener. `server.test.ts` comprueba el orden
de arranque y cierre con dependencias simuladas. `config/env.test.ts` comprueba
la zona por defecto, otra zona válida y el rechazo de una inválida.

Para observar el comportamiento normal, arrancar con `pnpm --dir backend dev`:
la corrida inicial procesa las suscripciones vencidas de la base configurada.
Con `LOG_LEVEL=info`, revisar `Payment scheduler started` y los conteos del
generador; al pulsar `Ctrl+C`, revisar `Shutdown requested`,
`Payment scheduler stopped` y el cierre del pool. Las pruebas automatizadas
del scheduler no lanzan generación global sobre la base de desarrollo ni esperan
una hora real. El dashboard de pagos está implementado en el bloque 8.

Comprobación ejecutada del bloque 7: suite completa con `RUN_DB_TESTS=1`
aprobada (156 pruebas, sin omisiones), typecheck y build correctos, y revisión
sin hallazgos. Incluye 9 pruebas del scheduler y 12 de servidor/configuración.
El ciclo de vida se comprobó con reloj y dependencias simulados; las 16 pruebas
de integración de generación y resolución sí usaron PostgreSQL real con datos
exclusivos. En ese bloque no se arrancó un proceso normal del servidor para comprobar
su ciclo de vida; el bloque 9 completó la prueba con procesos reales y un esquema
aislado, según el [informe de cierre](phase-4-verification.md).

El cierre incorpora 27 pruebas de restricciones de migración 006: la suite completa
con `RUN_DB_TESTS=1` pasa con 183 pruebas, sin omisiones. Por defecto pasan 140 y
se omiten 43 de integración. El informe detalla backfill, idempotencia, arranque,
espera del generador al apagar y limpieza de los datos exclusivos.
