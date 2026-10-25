# Pagos — API, generación programada y dashboard (Fase 4)

Fase 4 cerrada el 24 de octubre de 2026. Ver
[evidencia y alcance de las comprobaciones](phase-4-verification.md).

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

Enviar sin cuerpo o con `{}`. No se aceptan campos ni parámetros de query.
Devuelve `200 { "payment": { ... } }` con `status: "skipped"`, `actualAmount: null`,
`priceChanged: false` y `resolvedAt` presente.

## Permisos y resolución única

Solo un owner activo puede confirmar u omitir. Un member activo puede leer,
pero las acciones devuelven `403`. Invitados, removidos, grupos ajenos e
inexistentes también reciben `403`.

Si el grupo está autorizado pero el pago no existe en él, se devuelve `404
Payment not found`. Un pago de otro grupo tampoco es accesible por conocer su UUID.
Un pago confirmado u omitido devuelve `409 Payment already resolved` ante
cualquier nueva resolución. No hay transición inversa en esta fase.

Cada acción usa una transacción y un bloqueo `FOR UPDATE OF p`: si llegan dos
resoluciones simultáneas, una espera y después comprueba el estado actualizado.
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
| `409` | El pago ya está resuelto o se intenta borrar una suscripción con pagos |
| `500` | Error interno |

## Generación programada (bloque 7)

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
Los pagos existentes se obtienen mediante el generador manual del bloque 4.

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

Punto de prueba manual del bloque 6, con pagos distintos de una suscripción de prueba:

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
