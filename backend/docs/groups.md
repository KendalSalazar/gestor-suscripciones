# Grupos, miembros e invitaciones — Fase 5, bloques 10 a 13

Un usuario conserva su grupo personal y puede participar en varias familias.
Estas rutas permiten listar sus grupos activos, crear una familia, renombrarla,
consultar sus miembros activos, transferir su propiedad, gestionar bajas y crear
invitaciones para una familia.
El registro en `/auth/register` sigue creando el grupo personal con su owner.

Todas las rutas requieren `Authorization: Bearer <access-token>`. El usuario se
obtiene del token; el rol actual se consulta en `group_members`, no en el JWT.
No se admiten filtros query ni campos adicionales en los cuerpos. Los UUID de
ruta se validan antes de acceder a los datos.

## Representación pública

```json
{
  "id": "4aae0c01-115e-400e-953a-578cd03623ad",
  "name": "Familia",
  "type": "family",
  "ownerId": "a7e4dc62-0df7-4ff4-a54f-c670455d1151",
  "role": "owner",
  "createdAt": "2026-10-26T18:00:00.000Z"
}
```

`role` corresponde al solicitante y puede ser `owner` o `member`. `ownerId`
identifica al propietario del grupo. `createdAt` es un timestamp ISO.
La respuesta no incluye emails ni datos privados de las cuentas.

## Listar los grupos propios

`GET /groups` → `200 { "groups": [...] }`.

Devuelve todos los grupos en los que el usuario tiene membresía `active`. Las
membresías `invited` y `removed` quedan excluidas. El grupo personal aparece
primero; después se ordena por `createdAt` ascendente y UUID ascendente para
resolver empates. No hay paginación ni límite de 100 en este contrato.

Una lista vacía se representa como `{ "groups": [] }`. La petición admite
cuerpo ausente o `{}` y rechaza filtros como `?type=family`.
`/auth/me` mantiene su campo `personalGroupId`.

## Crear una familia

`POST /groups` con cuerpo:

```json
{ "name": "  Familia  " }
```

Devuelve `201 { "group": ... }`, con nombre `Familia`, tipo `family`,
`ownerId` del usuario autenticado y `role: "owner"`.

El nombre se recorta con `trim()` y debe contener entre 1 y 255 caracteres
después del recorte. No se aceptan `type`, `ownerId`, `role` u otros campos.
Dos grupos pueden compartir nombre; repetir un POST válido crea otra familia.

El grupo y su membresía `owner/active`, con `joined_at` informado, se insertan
en una misma transacción. Si falla cualquiera de esas escrituras, se revierten
las dos. El grupo personal y sus membresías se conservan.

## Renombrar una familia

`PATCH /groups/:groupId` con `{ "name": "Nuevo nombre" }` devuelve
`200 { "group": ... }`. Se aplica la misma validación del nombre que al crear.

Solo un owner activo puede renombrar una familia. Se comprueba primero la
membresía, se bloquea la fila del grupo y se vuelven a consultar la membresía
y el rol antes del UPDATE. Así, una petición que esperaba el bloqueo pierde
su permiso si entretanto el usuario dejó de ser owner activo.

La operación modifica únicamente el nombre: conserva el tipo, el propietario,
la fecha de creación y las membresías. Un owner de grupo personal recibe `409`.

## Listar miembros activos

`GET /groups/:groupId/members` → `200 { "members": [...] }`.

Requiere membresía activa en una familia; tanto owner como member pueden consultar
el listado. Devuelve solo miembros activos, primero el owner y después los demás
por `userId` ascendente. El resultado contiene como máximo 20 miembros.

Cada elemento tiene esta representación pública:

```json
{
  "userId": "a7e4dc62-0df7-4ff4-a54f-c670455d1151",
  "name": "Ana",
  "role": "owner",
  "status": "active",
  "joinedAt": "2026-10-26T18:00:00.000Z"
}
```

El nombre procede de la cuenta y `joinedAt` es un timestamp ISO. Las membresías
`invited` o `removed` no aparecen. La respuesta no incluye emails, hashes ni
otros campos de `users` o `group_members`. Admite cuerpo ausente o `{}`;
rechaza filtros query y campos adicionales.

## Transferir la propiedad

`POST /groups/:groupId/transfer-ownership` con cuerpo:

```json
{ "newOwnerId": "fdcf5031-ab36-4627-bc43-90b95af46d3e" }
```

Solo el owner activo de una familia puede realizarla. `newOwnerId` debe ser el
UUID de otro miembro activo de esa misma familia. Un destinatario ajeno,
inactivo, inexistente o igual al owner actual produce `409`.

La respuesta es `200 { "group": ... }` con `ownerId` del nuevo propietario y
`role: "member"`: el rol de la respuesta corresponde a quien hizo la petición,
que acaba de dejar de ser owner. Un GET de grupos con la cuenta destinataria
muestra `role: "owner"`.

La transacción bloquea el grupo y vuelve a consultar la membresía y el rol del
solicitante. Después comprueba y bloquea la membresía destinataria. Las escrituras
siguen este orden:

1. Cambiar el rol del owner anterior a `member`.
2. Cambiar el rol del destinatario a `owner`.
3. Actualizar `groups.owner_id`.

Se confirma todo junto. El índice único de owner activo obliga a retirar primero
el rol anterior; si falla una escritura, el rollback restaura el conjunto.
No queda un cambio parcial confirmado. Las peticiones concurrentes se coordinan
mediante el mismo bloqueo del grupo usado por las otras escrituras.

Ambas personas conservan su membresía activa y su `joinedAt`. Se mantienen el
nombre y la fecha de creación del grupo, los grupos personales, las suscripciones,
los pagos y las partes históricas. Transferir no reasigna cuotas ni requiere
haber confirmado las partes pendientes.

El antiguo owner puede seguir leyendo el grupo como miembro activo y confirmando
sus propias partes. Acciones reservadas al owner, como renombrar o volver a
transferir, reciben `403` con su sesión. El nuevo owner obtiene esos permisos
sin cambiar el token: el servidor consulta el rol vigente en la base de datos.

## Salir o retirar a un miembro

`POST /groups/:groupId/leave` permite a un miembro activo salir de una familia.
`DELETE /groups/:groupId/members/:userId` permite al owner activo retirar a otro
miembro activo. Ambas peticiones admiten cuerpo ausente o `{}` y no aceptan
filtros query. Al completarse, devuelven `204` sin cuerpo.

La baja cambia `group_members.status` a `removed`; conserva la fila, el rol y
la fecha de incorporación. Las suscripciones, pagos y partes anteriores no se
borran ni se reparten de nuevo. La persona retirada pierde acceso al grupo y a
sus partes históricas; los miembros activos conservan acceso al historial.

La operación devuelve `409` si la persona tiene alguna **parte propia pending
de un pago pending del mismo grupo**. Por ejemplo, con un pago grupal pendiente:

- Si Ana todavía tiene su parte pendiente, no puede salir ni ser retirada.
- Si Ana confirmó su parte y Bruno todavía no confirmó la suya, Ana puede salir.
- Una parte pendiente que pertenezca a otro grupo no impide la baja de este grupo.

El owner no puede salir ni retirarse a sí mismo: debe transferir la propiedad
primero. Un owner autorizado recibe `404` al intentar retirar a una persona que
no tiene membresía activa en ese grupo, incluidas membresías invited o removed.
Un miembro que intenta retirar a otra persona recibe `403`.

La comprobación del permiso, la búsqueda de obligaciones y la baja se hacen en
una transacción. Se bloquea el grupo y se revalida el permiso antes de escribir.
El generador de pagos usa el mismo bloqueo: la foto de participantes y la baja
se ordenan entre sí. Si se genera primero una parte pendiente para la persona,
la baja recibe `409`; si la baja se confirma primero, los pagos generados después
no incluyen a ese miembro.

## Crear invitaciones

`POST /groups/:groupId/invitations` requiere un owner activo de una familia y
este body:

```json
{ "email": "  Persona@Example.com  " }
```

El servidor recorta y convierte el email a minúsculas. Debe ser válido y tener
como máximo 254 caracteres. Devuelve `201 { "invitation": ..., "token": "..." }`.
El campo `token` contiene el secreto opaco una sola vez. La interfaz que se
construya en un bloque posterior puede mostrar el código para compartir como
`invitation.id + "." + token`.

La respuesta de invitación incluye `id`, `groupId`, `groupName`, `email`,
`invitedByName`, `status`, `createdAt` y `expiresAt`. No contiene el hash ni
otros datos de cuentas. La invitación vence siete días después de crearse.
No se envía correo automáticamente.

El secreto se genera con 32 bytes aleatorios y se almacena solo como SHA-256.
Crear otra invitación vigente para el mismo email y familia devuelve `409`.
Si la anterior ya venció, el servidor la marca `expired` dentro de la nueva
transacción antes de insertar otra; así se libera el índice único parcial.
Una invitación revocada es terminal y se puede sustituir por otra.

La respuesta es igual para una dirección sin cuenta y para una cuenta que no
sea miembro activo de esa familia. El owner puede invitar una cuenta existente
o futura. Invitar al email del owner actual o a un miembro activo del mismo
grupo devuelve `409`.

## Listar invitaciones

`GET /groups/:groupId/invitations` requiere owner activo y devuelve
`200 { "invitations": [...] }`, con hasta las últimas 100 por fecha de creación
descendente y UUID descendente. Incluye invitaciones anteriores al cambio de
owner. Ningún listado devuelve el secreto o su hash.

Una fila que siga `pending` en SQL pero tenga `expiresAt` vencido se representa
como `expired`. La consulta no necesita actualizarla; una nueva invitación al
mismo email es la que materializa `status = expired` en la base.

## Revocar una invitación

`POST /groups/:groupId/invitations/:invitationId/revoke` admite body ausente o
`{}` y devuelve `200 { "invitation": ... }` con estado `revoked`. Solo se puede
revocar una invitación que todavía esté pendiente y no haya vencido. Repetir
la petición o intentar revocar una invitación terminal o vencida devuelve `409`.
Si el UUID no existe en la familia autorizada, la
respuesta es `404`; un UUID que pertenece a otra familia no revela su presencia
y también produce `404`.

La creación y la revocación bloquean el grupo y vuelven a comprobar la membresía
y el rol del owner antes de escribir. Así, invitaciones creadas por un owner
anterior siguen siendo visibles y revocables para el nuevo owner. Si se pierde
el código secreto, hay que revocar y crear otra invitación; el GET no puede
recuperarlo.

## Errores

Se conserva el sobre `{ "error": { "message": "...", "status": 400 } }`.

| Estado | Condición |
|---|---|
| 400 | UUID, nombre, email, newOwnerId, body o query inválidos; campos adicionales |
| 401 | Bearer ausente, inválido o expirado |
| 403 | Sin membresía activa, grupo ajeno o inexistente; escritura reservada al owner solicitada por member |
| 404 | Miembro destinatario inexistente/no activo o invitación inexistente dentro del grupo autorizado |
| 409 | Operación familiar en grupo personal; email ya es miembro, invitación duplicada o vencida/no revocable, owner que intenta salir, parte propia pendiente, transferencia o estado incompatible |
| 500 | Fallo interno; los errores SQL de invitaciones se presentan como error genérico, sin detalles de base de datos ni del email |

El `403 Forbidden` uniforme no distingue grupo inexistente de grupo ajeno.
El conflicto personal usa `Operation requires a family group`. La transferencia
con destinatario no elegible usa `New owner must be a different active member`.
Si una escritura no encuentra el estado de ownership esperado, se revierte la
transacción con `Group ownership could not be transferred`.
Una baja con obligaciones pendientes usa `Member has pending payment shares`;
el owner que intenta salir o retirarse recibe `Owner must transfer ownership before leaving`.
Si la membresía deja de cumplir las condiciones esperadas durante la escritura,
se revierte la baja con `Member could not be removed`.

## Comprobación y alcance

Las pruebas [HTTP con pool simulado](../src/modules/groups/group.routes.test.ts)
cubren validación, permisos y manejo de transacciones. La
[integración optativa](../src/modules/groups/group-api.int.test.ts), activada con
`RUN_DB_TESTS=1`, usa HTTP y PostgreSQL reales en un esquema temporal exclusivo.
Comprueba creación atómica, listado, aislamiento, renombrado, rollback y permisos
revalidados después de esperar un bloqueo. El esquema se elimina al terminar.

Para una comprobación manual con el backend iniciado: iniciar sesión, consultar
`GET /groups`, crear una familia con POST y volver a listar. Deben aparecer el
grupo personal y la familia. Renombrar la familia con PATCH debe cambiar su
nombre; intentar renombrar el grupo personal debe producir `409`.

Las pruebas [de miembros y transferencia con pool simulado](../src/modules/groups/group-member.routes.test.ts)
y su [integración PostgreSQL/HTTP](../src/modules/groups/group-member.int.test.ts)
comprueban los contratos del bloque 11. Las membresías iniciales de las cuentas
de prueba se preparan con SQL exclusivo del esquema temporal: no son endpoints
de incorporación. Se verifica la coherencia del owner, la conservación del
historial, el rollback y las carreras con otras escrituras.

Para comprobar manualmente la transferencia con dos cuentas que ya sean miembros
activos de una familia, consultar `/members` con ambas y usar el UUID del miembro
destinatario en el POST del owner. Después, GET `/groups` y `/members` deben
mostrar los roles intercambiados. Probar que el owner anterior recibe `403` al
renombrar y que el nuevo puede hacerlo. El acceso de nuevas cuentas mediante
invitaciones se implementará en sus bloques correspondientes; la prueba manual
del propietario no se considera ejecutada por pasar las pruebas automatizadas.

Las pruebas [de salida y expulsión con pool simulado](../src/modules/groups/group-member-removal.routes.test.ts)
y su [integración PostgreSQL/HTTP](../src/modules/groups/group-member-removal.int.test.ts)
comprueban permisos, obligaciones, historial y concurrencia con el generador.
Las membresías de prueba se preparan dentro de un esquema temporal; la generación
se limita al UUID de una suscripción de prueba.

Para comprobarlo manualmente se necesita una familia con otro miembro activo:
intentar retirarlo con una parte propia pendiente debe producir `409`. Después
de que confirme su parte, puede salir o el owner puede retirarlo. Comprobar que
ya no aparece en GET `/groups` de la cuenta retirada y que el owner sigue viendo
el historial. La prueba automatizada no sustituye una comprobación manual del propietario.

Las invitaciones del owner cuentan con [pruebas HTTP con pool simulado](../src/modules/groups/invitation.routes.test.ts)
y [pruebas de integración HTTP/PostgreSQL](../src/modules/groups/group-invitation.int.test.ts).
Cubren token aleatorio entregado una sola vez, persistencia del hash, normalización
de email, no enumeración de cuentas, límites por grupo, expiración, revocación y
rol revalidado tras bloqueo. La integración crea y elimina su propio esquema
temporal; no envía correo ni altera grupos del esquema `public`.

Las rutas de creación, listado y revocación de invitaciones están implementadas.
La vista previa y resolución de invitaciones por el destinatario corresponden
al bloque 14 del [plan](../../prompts/plan-fases/plan-fase-5.md); la gestión
visual del owner y las pantallas familiares también tienen sus propios bloques.
Las rutas de suscripciones, pagos y partes siguen sus contratos vigentes.
