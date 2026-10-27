# Partes de pago — Fase 5, bloques 7 y 8

Estas rutas permiten consultar cuotas y progreso familiar, y confirmar la parte
propia. Requieren `Authorization: Bearer <accessToken>` y una membresía activa en
un grupo `family`. Owner y member tienen los mismos permisos de lectura y cada
uno confirma solo sus partes. Los importes son registros de los usuarios; la
aplicación no mueve dinero.

## Consultar las partes propias

`GET /groups/:groupId/payment-shares`

Devuelve `200 { "shares": [...] }`. Solo contiene partes cuyo userId coincide
con la cuenta autenticada y cuyo pago pertenece al grupo de la URL. No se acepta
un userId del cliente para elegir otra persona, tampoco para el owner.

El filtro opcional `?status=pending`, `?status=confirmed` o `?status=skipped`
filtra el estado de la **parte**, independientemente del estado del pago completo.
Otros campos de query, valores inválidos o repetidos devuelven 400.

Se devuelven hasta 100 partes, ordenadas por fecha esperada del pago DESC e id de
parte DESC. No hay paginación. Se incluyen pagos de suscripciones desactivadas.
Un miembro activo sin partes recibe `200 { "shares": [] }`; no se crean cuotas
retroactivas al incorporarse al grupo.

Cada elemento contiene los campos de la parte y añade payment con el
[contrato de pagos existente](payments.md), más summary con el progreso total.
Ejemplo de una parte confirmada mientras el pago del grupo sigue pendiente:

```json
{
  "shares": [
    {
      "id": "63da8815-7dcc-449d-a7c7-d27826b64d90",
      "paymentId": "c3f47c53-b125-4e3e-b04d-e2c9a6b31351",
      "userId": "a7e4dc62-0df7-4ff4-a54f-c670455d1151",
      "userName": "Persona",
      "shareAmount": "3.34",
      "sharePercentage": "33.3334",
      "actualAmount": "3.50",
      "status": "confirmed",
      "confirmedAt": "2026-10-26T12:00:00.000Z",
      "createdAt": "2026-10-25T12:00:00.000Z",
      "payment": {
        "id": "c3f47c53-b125-4e3e-b04d-e2c9a6b31351",
        "subscriptionId": "2140bd25-5d90-4c87-8c39-fcc2a3328ee8",
        "subscriptionName": "Plan familiar",
        "expectedDate": "2026-10-25",
        "expectedAmount": "10.00",
        "actualAmount": null,
        "status": "pending",
        "priceChanged": false,
        "resolvedAt": null,
        "createdAt": "2026-10-25T12:00:00.000Z"
      },
      "summary": {
        "totalShares": 3,
        "confirmedShares": 1,
        "confirmedAmount": "3.50"
      }
    }
  ]
}
```

La confirmación propia se describe a continuación. El pago completo se cierra
cuando todas sus partes están confirmadas.

## Consultar el reparto completo de un pago

`GET /groups/:groupId/payments/:paymentId/shares`

Devuelve `200 { "payment": ..., "shares": [...], "summary": ... }`.
payment conserva su contrato actual. Cada elemento de shares contiene únicamente
los campos de la parte mostrados arriba, sin repetir payment o summary.
El reparto se ordena por userId ASC.

Cualquier miembro activo del grupo puede consultarlo, incluso si entró después
de generar ese pago y no tiene parte propia. Se incluyen los participantes de
la foto original aunque después hayan sido retirados; su membresía actual no
elimina filas históricas. Una persona retirada ya no está autorizada a consultar.

Si el pago existe pero no tiene partes, devuelve shares vacío y summary con
totalShares 0, confirmedShares 0 y confirmedAmount `"0.00"`. La consulta no genera
ni repara repartos. Un pago inexistente o perteneciente a otro grupo devuelve 404
después de comprobar acceso al grupo de la URL.

## Confirmar la parte propia

`POST /groups/:groupId/payments/:paymentId/shares/:shareId/confirm`

Requiere una membresía activa en la familia y ser el usuario de esa parte. El
owner tampoco confirma por otra persona. Los tres identificadores deben ser UUID;
no se aceptan parámetros de query ni una identidad suministrada en el body.

Enviar `Content-Type: application/json` y `{}` para usar el shareAmount previsto.
Para registrar un importe diferente:

```json
{ "actualAmount": "3.50" }
```

El importe es un string decimal no negativo, hasta dos decimales y máximo
9999999999.99. Cero es válido. No se aceptan números JSON, negativos, notación
exponencial, espacios alrededor del importe ni campos adicionales. La cuota
prevista y el coste de la suscripción se conservan.

Devuelve `200 { "share": ..., "payment": ..., "summary": ... }` con los mismos
campos de parte, pago y resumen definidos en las lecturas. La parte pasa a
confirmed, actualAmount contiene el importe registrado y confirmedAt un timestamp.

La operación usa un único cliente entre BEGIN y COMMIT/ROLLBACK: comprueba
membresía, bloquea el grupo, revalida la membresía y bloquea después el pago y
la parte dentro del grupo. Verifica titularidad antes de revisar sus estados.
Padre y parte deben estar pending; repetir una confirmación devuelve 409.

Antes de actualizar cada parte, PostgreSQL comprueba que la suma de importes ya
confirmados más el nuevo no supere 9999999999.99, también cuando todavía quedan
otras partes pendientes. Si lo supera, devuelve 409 y conserva la parte pendiente.
Todos los importes se suman y comparan como NUMERIC, sin conversiones a number.

Mientras falte alguna parte confirmada, el pago conserva pending, actualAmount y
resolvedAt nulos y priceChanged falso. Se cierra únicamente si tiene al menos
una parte y **todas** están confirmed; partes skipped no cuentan como confirmadas.
Al cerrar se asignan la suma real exacta, resolvedAt y priceChanged comparando el
total registrado con expectedAmount. Esa diferencia no actualiza la tarifa de
la suscripción ni demuestra por sí sola un cambio de precio del proveedor.

El bloqueo serializa confirmaciones simultáneas. Dos intentos sobre la misma
parte producen una confirmación y un conflicto; las últimas partes distintas
cierran el pago una sola vez. Cualquier fallo antes del commit revierte los
cambios de la parte y del padre, y el cliente se devuelve al pool.

## Resumen y representación de datos

Summary siempre cuenta **todas** las partes del pago: totalShares y
confirmedShares son enteros; confirmedAmount es la suma decimal string de los
actualAmount confirmados. Los filtros de usuario y estado del listado propio no
reducen ese resumen. Cero confirmado se representa como `"0.00"`.

Los agregados usan COUNT y SUM NUMERIC de PostgreSQL. En las rutas GET, cada SELECT
de recursos obtiene pago, partes y resumen en una misma lectura, sin sumar dinero
en JavaScript. Esas consultas no adquieren bloqueos FOR UPDATE ni modifican datos.

shareAmount y actualAmount se conservan como strings de dos decimales,
sharePercentage con cuatro; actualAmount y confirmedAt pueden ser null según
estado. createdAt y confirmedAt se serializan como timestamps ISO, mientras
payment.expectedDate conserva YYYY-MM-DD. userName es el nombre actual de la
cuenta; no se incluyen emails, secretos ni datos de sesión.

## Errores y alcance

El formato es `{ "error": { "message": string, "status": number } }`.

| Estado | Motivo |
|---|---|
| 400 | UUID, query o body inválidos; campos desconocidos o query repetida |
| 401 | Bearer ausente, inválido o caducado |
| 403 | Grupo inexistente, ajeno, membresía inactiva o intento de confirmar una parte ajena |
| 404 | El pago o la parte no existe dentro del grupo/pago autorizado |
| 409 | Grupo personal, pago/parte resueltos o acumulado fuera de rango |
| 500 | Error interno |

El 409 personal usa `Payment shares are only available for family groups`.
El owner no necesita un privilegio adicional para leer el reparto, y su listado
propio también se limita a sus cuotas.

Confirmar una parte ajena devuelve 403, incluso para el owner y aunque esa parte
ya esté resuelta. Un UUID de parte que corresponde a otro pago o grupo devuelve
404. El conflicto de acumulado usa
`Confirmed payment total would exceed the amount limit`.

La confirmación directa del padre familiar sigue bloqueada. El owner puede
[omitir el pago familiar completo](payments.md#omitir-un-pago-pendiente) junto
con sus partes cuando todas siguen pending. No hay acción para omitir una parte
individual ni interfaz familiar en esta entrega. El avance completo está en
[el plan de Fase 5](../../prompts/plan-fases/plan-fase-5.md).
