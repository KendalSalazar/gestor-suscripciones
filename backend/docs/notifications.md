# Avisos internos

## Revisión manual de pagos vencidos

El detector crea avisos internos `payment_overdue` para obligaciones que siguen
pendientes al menos siete días naturales después de su fecha prevista. No mueve
dinero ni comprueba transacciones bancarias. En un pago familiar solo avisa a
miembros activos con una parte propia pendiente; en uno personal, al owner activo.

Desde la raíz del repositorio, para revisar una única suscripción de prueba en
PowerShell, sustituye el UUID de ejemplo por el de esa suscripción:

```powershell
$subscriptionIdPrueba = '11111111-1111-4111-8111-111111111111'
pnpm.cmd --dir backend run notifications:scan --subscription-id $subscriptionIdPrueba
```

El comando también admite `--all` para revisar deliberadamente todas las
suscripciones. Debe indicarse exactamente una de las dos modalidades. Sin
argumentos, con ambas modalidades o con un UUID inválido, falla antes de conectar.
No acepta una fecha manual: utiliza la fecha actual en `PAYMENT_TIME_ZONE`.

**El comando escribe en la base configurada y aplica las migraciones pendientes
antes de revisar los pagos.** Cada ejecución procesa como máximo 100 grupos y
200 pagos; puede quedar trabajo pendiente para una ejecución posterior. Repetirla
no duplica avisos para el mismo pago y destinatario ni cambia su estado de lectura.
El detector no cambia pagos, partes ni suscripciones.

## Revisión programada

Al arrancar el servidor y después cada hora, el ciclo existente genera pagos y
revisa los vencidos usando la misma fecha local. Cada tarea maneja sus errores por
separado: si falla la generación, todavía se intenta la revisión de vencidos.
Si una tarea sigue activa al llegar el siguiente intervalo, se omite ese intento;
al apagar el servidor se espera a que termine el ciclo activo.

**Arrancar el servidor inicia una revisión global**, que puede crear avisos en
la base configurada. La ejecución manual limitada no inicia el ciclo horario.
La visualización de avisos corresponde a un bloque posterior.

## Consultar avisos propios

`GET /notifications` requiere `Authorization: Bearer <access-token>`. La identidad
se obtiene del token y solo se devuelven avisos propios de grupos con membresía
activa; ser owner no permite consultar los avisos de otras personas.

Parámetros opcionales:

- `status`: `all` (predeterminado), `unread` o `read`.
- `groupId`: UUID de un grupo donde la persona tenga membresía activa. Un grupo
  inexistente o sin acceso devuelve el mismo error 403.
- `cursor`: valor `nextCursor` de la página anterior con los mismos filtros.

La respuesta tiene la forma `{ notifications, nextCursor, unreadCount }`. Cada
página contiene hasta 50 avisos, ordenados por fecha de creación e identificador
descendentes; `nextCursor` es `null` al llegar al final. `unreadCount` cuenta los
avisos visibles sin leer de todos los grupos activos o del grupo solicitado,
independientemente del estado y la página solicitados. Al cambiar de filtro se
debe empezar sin cursor. Parámetros desconocidos o inválidos producen 400; sin
sesión válida se responde 401.

Cada aviso incluye datos actuales del pago y del grupo, un mensaje de texto y
`actionRequired`, que indica si aún hay una obligación propia por confirmar.
Los importes son strings y las fechas previstas conservan `YYYY-MM-DD`.

## Marcar un aviso como leído

`POST /notifications/:notificationId/read` requiere el access token del
destinatario y un cuerpo JSON vacío (`{}`), sin parámetros de consulta. Responde
con `{ notification }`, con el mismo formato de aviso que el listado y `readAt`
con la fecha de lectura. Repetir la petición conserva la primera fecha y devuelve
200; marcar como leído no confirma ni altera el pago ni sus partes.

La notificación debe pertenecer al usuario y a un grupo donde mantenga una
membresía activa. Un identificador inexistente, ajeno o que haya dejado de ser
visible devuelve 404 `Notification not found`. Parámetros o cuerpo inválidos
producen 400 y una sesión ausente o inválida produce 401.
