# Plan Fase 8 — Registro desde la interfaz y renovación del inicio

**Estado al 19 de noviembre de 2026: bloques 1 y 2 completados; bloques 3 y 4 implementados con checks técnicos aprobados. El propietario confirmó el aspecto móvil del registro; la prueba manual del alta y de la sesión sigue pendiente. Bloques 5 a 9 pendientes.**
Alcance en [08-fase.md](../08-fase.md). Un bloque pequeño por entrega, con
explicación detallada y comprobación antes de avanzar.

## 0. Entrada contrastada con el repositorio

Carpeta de trabajo y raíz Git verificadas: `E:\repos vsc\gestor-suscripciones`.
Existen cambios previos de cierre de Fase 7 en documentación y pruebas backend;
se conservan. La Fase 7 registra cierre con 1.095 pruebas en 47 archivos,
lint/TypeScript/build y confirmación manual del propietario. Esa evidencia es
previa: redactar este plan no implica volver a ejecutar esas comprobaciones.

Se leyeron `AGENTS.md`, `frontend/AGENTS.md`, el cierre de Fase 7, los criterios
visuales y las skills de trabajo por bloques e integración. El diseño se consulta
con `frontend-designer` aplicando `frontend-design`. Para el bloque 1 se ejecutaron
`pnpm.cmd --dir frontend lint`, `pnpm.cmd --dir frontend exec tsc --noEmit` y
`pnpm.cmd --dir frontend build`; los tres pasaron con los archivos actuales.

| Archivo actual | Evidencia y consecuencia |
|---|---|
| `backend/src/modules/auth/auth.routes.ts` | Ya existe `POST /auth/register`; se reutiliza. |
| `auth.schemas.ts`, `auth.service.ts`, `auth.controller.ts` del mismo módulo | Validación, creación transaccional, conflicto de correo y sesión inicial ya implementados. |
| `frontend/src/app/login/page.tsx` | Usa `api`, guarda access token en memoria y entra con `router.replace('/dashboard')`; patrón de integración de referencia. |
| `frontend/src/lib/api.ts`, `session.ts` | `credentials: 'include'`, `ApiError`, refresh coordinado y token en memoria. |
| `frontend/src/app/page.tsx` | Portada estática anterior, con «Iniciar sesión» e «Ir al dashboard», sin registro. |
| `frontend/src/app/globals.css` | Tokens y controles de Fase 7 delimitados con `.app-design`; reutilizarlos sin cambios globales indiscriminados. |
| Rutas de `frontend/src/app/` | No existe `/register`; sí `/`, `/login`, `/dashboard`, `/invitations` y `/notifications`. |
| `frontend/package.json` | Next 16.3.3, React 19.2.8, sin librería de formularios ni runner frontend de tests; no añadirlos por rutina. |

Antes de escribir código del framework, consultar de nuevo la documentación
local pertinente bajo `frontend/node_modules/next/dist/docs/`, como exige
`frontend/AGENTS.md`: componentes servidor/cliente, navegación, `Link` y
`useRouter`. La portada puede seguir siendo un componente de servidor y el
registro requerirá interacción de cliente; no migrar a Server Actions ni crear
un proxy de autenticación sin una necesidad demostrada.

## 1. Recorridos de producto

### Persona nueva

`/` → «Crear cuenta» → `/register` → datos válidos → `POST /auth/register`
→ sesión en memoria/cookie → `/dashboard` con espacio Personal vacío.

El dashboard ya explica cómo añadir la primera suscripción. No crear otro paso
de bienvenida, una familia automática ni datos de ejemplo en la base.

### Persona con cuenta

Desde inicio o registro, «Iniciar sesión» lleva a `/login`. Desde login se añade
«Crear cuenta». Una cuenta ya autenticada que visite `/register` continúa al
dashboard, sin reemplazar su sesión mediante un registro accidental.

La portada se mantiene pública: no necesita consultar `/auth/me` para explicar
el producto ni bloquear su contenido esperando a la API.

### Persona invitada

Puede registrarse con el correo destinatario y después entrar en Familia para
introducir el código. No se guardan ni transportan códigos entre registro y login,
ni se acepta automáticamente una invitación al crear la cuenta.

## 2. Contrato existente y validaciones

| Entrada | Regla real del servidor | Tratamiento de interfaz |
|---|---|---|
| `name` | string, `trim()`, de 1 a 100 caracteres | Etiqueta «Nombre»; rechazar solo espacios y exceso de longitud. |
| `email` | string, `trim().toLowerCase()`, email válido, máximo 255 | Etiqueta «Correo electrónico», `type=email`, `autocomplete=email`; normalizar para enviar. |
| `password` | string, de 8 a 72 caracteres según Zod actual | Etiqueta «Contraseña», `autocomplete=new-password`; explicar longitud; no recortar espacios ni cambiar mayúsculas. |
| Confirmación | No pertenece al contrato HTTP | Comparar exactamente en cliente y no enviarla al backend. |

La validación de cliente orienta; el servidor sigue siendo la autoridad. No
introducir reglas de símbolos/mayúsculas ni cambiar la política de contraseñas
en esta fase. El límite actual de Zod mide longitud de string, mientras bcrypt
tiene restricciones en bytes: no presentar esta fase como una revisión de esa
política ni corregirla silenciosamente dentro de un bloque visual. Si aparece
una incompatibilidad real, documentarla y delimitar un cambio por separado.

`POST /auth/register` envía solo `{ name, email, password }`. Respuestas:

| Resultado | Comportamiento esperado |
|---|---|
| `201 { user: { id, email, name }, accessToken }` y cookie de refresh | Guardar token únicamente con `session.setAccessToken`, limpiar credenciales del estado y `router.replace('/dashboard')`. No ejecutar un login adicional. |
| `400` | Mensaje en español para revisar los datos; errores locales asociados a sus campos cuando se conocen. No depender del texto interno de Zod para localizar un campo. |
| `409 Email already registered` | Explicar que ese correo ya tiene cuenta y ofrecer «Iniciar sesión», conforme al contrato actual. No modificar el error genérico del login. |
| Red/`5xx`/respuesta inesperada | Mensaje claro, desbloquear controles y permitir acción deliberada. No mostrar detalles internos ni una falsa confirmación. |

Usar `api`, no `apiWithSession`, para crear la cuenta: la mutación no necesita
refresh ni repetición automática. Bloquear doble envío con estado y una guarda
inmediata durante la petición. La creación debe producir una sola petición ante
doble clic o Enter repetido. No reintentar automáticamente un POST fallido: si el
servidor creó la cuenta y la respuesta se perdió, orientar también a iniciar
sesión; un `409` posterior es un conflicto real, no un error de validación local.

Después de un fallo recuperable, conservar nombre/correo en memoria y permitir
corregir los datos. La contraseña puede permanecer solo en el formulario en
memoria para un reintento deliberado; se limpia tras éxito o al abandonar la ruta.
Nunca copiarla a logs, notificaciones, URL, localStorage o sessionStorage.

### Visita a registro con sesión existente

Antes de habilitar el envío, resolver la sesión con los helpers existentes:
si hay token en memoria, consultar el perfil con `apiWithSession('/auth/me')`
para recuperar una sesión cuyo access token haya caducado. Si falta token,
usar primero `refreshSession` y comprobar el perfil. Habilitar el formulario
solo cuando la recuperación de sesión también confirma `401`, no ante el
primer rechazo de un access token caducado. Una sesión válida pide elegir entre
volver al dashboard o cerrar sesión para crear otra cuenta. Un fallo de
red/servidor muestra error con reintento; no se confunde con ausencia de sesión.
Cancelar/ignorar resultados al desmontar el componente y conservar el refresh
compartido. Para continuar al registro, usar el logout real y luego navegación
completa que limpie el estado en memoria. En el bloque 4 se implementa primero
esta guarda y después se habilita el POST real; si la entrega resulta demasiado
amplia, dividirla en 4a/4b y comprobar cada parte antes de avanzar.

## 3. Dirección visual a concretar y aprobar

Se continúa la identidad real de Fase 7: `#CF7FFF` como marca/fondo de acción con
texto oscuro; `#78269E` para enlaces y foco; fondo `#F3F6FA`, superficie blanca,
texto `#1D2B3A` y secundario `#526375`. Reutilizar Geist y controles actuales.
El blanco sobre el violeta claro no ofrece el contraste de texto necesario.

**Registro:** una única columna de campos con ancho de lectura cómodo. Nombre,
correo, contraseña y confirmación; ayuda de longitud junto al campo; botón
«Crear cuenta»; enlace a login y regreso al inicio. En escritorio puede acompañar
una explicación breve sin competir con el formulario. En móvil, formulario
prioritario y sin desplazamiento horizontal; ancho de formulario de referencia
420–480 px en escritorio. Estado de envío «Creando cuenta…».
Mostrar/ocultar contraseña solo si la propuesta lo justifica, mediante botón
`type=button` accesible; no es requisito añadir adornos al formulario.

**Inicio:** cabecera breve de marca y entrada a login; titular claro sobre
controlar suscripciones personales y compartidas; CTA principal «Crear cuenta».
Una muestra compacta de la organización real de servicio/fecha/estado puede dar
identidad visual, siempre señalada como ejemplo y sin controles que aparenten
ejecutar operaciones. Explicar como máximo tres capacidades: suscripciones,
control de pagos y familia/avisos. Un cierre breve puede repetir la entrada a
registro; evitar sucesiones de secciones que repitan el mismo mensaje.

No usar cifras comerciales, testimonios inventados, tarifas, logotipos de
proveedores ni promesas de ahorro o cobro. Sin fotos, carruseles, nuevas fuentes,
dependencias o animación automática por defecto. El contenido se entiende con
la API apagada. «Tengo un código de invitación» continúa dentro de Familia.

Orientación del diseñador consultado: titular de referencia «Tus suscripciones,
claras y en un solo lugar», agenda de ejemplo al lado del texto en escritorio y
debajo en móvil, y explicación de tareas mediante lista con separadores en vez
de tarjetas repetidas. Incluir la aclaración «Los pagos se registran manualmente;
la aplicación no mueve dinero». Evitar bordes anidados. Esto orienta el bloque 2,
sin sustituir su propuesta visual ni la aprobación del propietario.

Un `h1` por página, etiquetas siempre visibles y `autocomplete=name`, `email`
y `new-password` según el campo. Texto de lectura inferior a 80 caracteres por
línea, campos de al menos 16 px y objetivos de al menos 44 px; foco contrastado,
orden Tab natural y errores anunciados. Probar preferencia oscura del navegador:
estas superficies siguen el tema claro deliberado de `.app-design`.

En el bloque 2, `frontend-designer` debe entregar una propuesta visual revisable
de inicio y registro en escritorio/móvil, junto con estado normal, envío y error
del formulario. Puede ser HTML local de demostración con datos ficticios en
`prompts/diseno/fase-8/`. No contiene peticiones, credenciales ni formularios que
creen cuentas. Registrar aprobación y ajustes antes de implementar: es requisito
de `AGENTS.md`. Los detalles de composición de esta sección son orientación
inicial, no una aprobación visual ya concedida.

## 4. Bloques y puntos de parada

Todos los bloques comienzan explicando qué se hará, por qué, archivos y concepto
de aprendizaje; terminan con resultado, comprobaciones reales, límites y parada.
No marcar un bloque completado por existir esta tabla.

| Bloque | Entrega y responsable | Criterio medible y concepto |
|---|---|---|
| 1. Entrada y recorrido | Principal: revisar contrato, login, estilos y documentación local; registrar base en este plan. | Mapa `/`–registro–login–dashboard confirmado; frontend lint, TypeScript y build de base o limitación documentada. Aprender contrato frente a interfaz. |
| 2. Propuesta visual | `frontend-designer` con `frontend-design`: inicio y registro, en `prompts/diseno/fase-8/`. | Propuesta revisable a 390/1440 px, jerarquía/colores/estados definidos y aprobación explícita del propietario antes de código. Aprender diseño antes de implementar. |
| 3. Formulario y validación | `frontend`: nueva `frontend/src/app/register/page.tsx` y estilos delimitados. | Cuatro campos, etiquetas/autocomplete, coincidencia y límites, error asociado y teclado. Aún sin alta real: la entrega provisional no anuncia éxito ni simula creación, y no se promueve desde la portada. Aprender estado de formulario y validación local. |
| 4. Sesión previa, creación y entrada | `frontend`: implementar primero la guarda y luego conectar con `api`/`session`; dividir en 4a/4b si es necesario. | Sesión activa o recuperable ofrece elegir dashboard o cerrar sesión antes de registrar; ausencia confirmada permite un POST por envío; `201` entra a Personal vacío y recarga restaura sesión sin repetir alta. Envíos fallidos ya tienen error básico y desbloqueo. Explicar JSON, cookie y token en memoria. |
| 5. Errores y recuperación | `frontend`: completar mensajes específicos de `400`/`409`, red/servidor, respuesta inválida y reintento deliberado. | Fallo de comprobación de sesión ofrece reintento; conflictos dirigen a login; no doble petición ni redirección tras desmontar. Aprender diferencia entre autenticación, conflicto y conexión. |
| 6. Navegación pública | `frontend`: enlaces en login, registro y portada actual, al registro ya funcional. | Crear cuenta/localizar login/volver al inicio en una activación; no enlaces muertos; invitación continúa dentro de Familia. Aprender navegación y continuidad del recorrido. |
| 7. Inicio: cabecera y presentación | `frontend-designer`: `frontend/src/app/page.tsx` y estilos propios según propuesta aprobada. | Cabecera y primer bloque de presentación reemplazan el diseño anterior, CTA claros en 390/1440 px; portada pública funciona sin API. Aprender jerarquía y reutilización de tokens. |
| 8. Inicio: explicación y móvil | `frontend-designer`: completar contenido secundario y muestra visual aprobada, sin añadir negocio. | Funciones reales explicadas una vez; ejemplo identificado; 360/390/768/1440 px, sin desbordamiento ni controles de demostración confundidos con acciones reales. Aprender composición responsive. |
| 9. Revisión y cierre | `reviewer` tras disponer del diff; principal integra correcciones y registra regresión/manuales. | Sin hallazgos pendientes en accesibilidad, sesión e integración; matriz de comprobación completada y aceptación del propietario. Aprender evidencia de cierre. |

Un solo responsable escribe cada archivo en un momento dado. Bloques 3–5
dependen de la propuesta; 6 depende del registro funcional; 7–8 dependen de la
aprobación; 9 espera todos los cambios. No paralelizar tareas sobre `globals.css`
o páginas compartidas. El diseñador limita sus cambios a presentación; la
integración y la sesión corresponden a `frontend`.

## 5. Matriz de comprobación final

Usar cuentas exclusivamente de prueba con correos nuevos y sin registrar sus
contraseñas en documentos. Las pruebas que crean usuarios deben identificarse;
no limpiar datos mediante borrados globales ni añadir endpoints de limpieza.
No hace falta ejecutar el generador global de pagos para comprobar esta fase.

| Escenario | Resultado observable |
|---|---|
| Abrir `/` sin backend | Contenido y enlaces públicos visibles sin error ni espera de sesión. |
| Registro directo sin sesión | Formulario disponible después de resolver ausencia de sesión; sin bucles de refresh. |
| Nombre vacío/espacios, correo inválido, contraseña corta o larga, confirmación distinta | Mensaje específico; no POST con datos localmente inválidos. |
| Correo con espacios externos y mayúsculas | Alta normalizada y login posterior con el mismo correo. |
| Registro válido con email nuevo | `201`, dashboard Personal vacío y nombre correcto; no necesita login manual. |
| Doble clic/Enter repetido con red lenta | «Creando cuenta…», controles bloqueados y un único POST de registro. |
| Recargar dashboard tras registro | Sesión recuperada; no nuevo usuario/grupo ni alta repetida. |
| Cerrar sesión y volver a entrar | Login correcto; datos de la nueva cuenta aislados de la cuenta anterior. |
| Abrir registro con sesión válida | Diálogo permite dashboard, cerrar sesión para crear otra cuenta o volver al inicio. |
| Registrar correo existente tras cerrar sesión | Mensaje de conflicto y enlace a login; no acceso indebido a la cuenta existente. |
| Offline antes de enviar y recuperación | Error comprensible, datos de nombre/correo conservados y reintento deliberado con conexión. |
| `400`, `5xx` o respuesta inesperada | Mensaje y controles recuperados; sin falso éxito. Simular de forma local, sin cambiar API de producción ni copiar secretos. |
| Visitar registro con sesión válida; sesión no recuperable por red | Diálogo de opciones en primer caso; error/reintento en el segundo. |
| Access token caducado en memoria y cookie de refresh válida | Recuperar sesión y mostrar el diálogo de opciones; no habilitar el alta por el primer `401`. |
| Navegar fuera durante comprobación/envío | Sin actualizaciones tardías que redirijan desde otra pantalla; la petición enviada puede haber creado cuenta, por lo que no se repite automáticamente. |
| Familia e invitaciones después de crear cuenta | Personal inicial disponible; crear/unirse conserva permisos y códigos exclusivamente en Familia. |
| Móvil, zoom y teclado | Sin scroll horizontal a 360/390/768/1440 px, foco visible, zoom 200 %, labels, errores anunciados y botones alcanzables. |
| Seguridad de presentación | Ninguna contraseña/token en URL, almacenamiento persistente, consola o textos de error. |

El formulario vacío es el estado inicial, no requiere un aviso artificial de
«sin datos». Comprobar carga de sesión, operación en curso, error y recuperación
por separado. La portada estática no necesita skeleton ni estado vacío ficticio.

Comandos desde la raíz: `pnpm.cmd --dir frontend lint`,
`pnpm.cmd --dir frontend exec tsc --noEmit` y `pnpm.cmd --dir frontend build`.
El build utiliza Google Fonts existentes: si la descarga falla, registrar la
limitación y repetir al recuperar acceso, sin afirmar build aprobado.
Reutilizar pruebas backend de autenticación si hay una duda concreta; no correr
la suite de pagos ni crear una infraestructura de tests frontend por cambios de
copy. Las pruebas manuales de red/registro requieren navegador y se registran
como pendientes si no se dispone de él. Revisar además `git diff --check`.

Las capturas pueden ayudar a revisar la propuesta, pero no son requisito de
cierre: el propietario decidió omitir el archivo de capturas finales en Fase 7.
Registrar resultados manuales por escrito; una maqueta no acredita integración.

## 6. Documentación y checklist de cierre

### Bloque 1 — Entrada y recorrido (completado el 19 de noviembre de 2026)

- [x] Confirmado el contrato actual: Zod exige nombre de 1–100, email normalizado
  de hasta 255 y contraseña de 8–72 caracteres. El servidor crea usuario, grupo
  personal, owner y primera sesión en una transacción; devuelve `201`, usuario y
  access token, y establece la cookie httpOnly. Email duplicado devuelve `409`.
- [x] Recorrido previsto confirmado: la landing enlaza a login/dashboard, login
  ya implementa la entrada y conserva el access token en memoria; `/register`
  aún no existe. La UI reutilizará `api`, `session` y el patrón de navegación al
  dashboard. No se añade contrato backend.
- [x] Línea base frontend: lint, `tsc --noEmit` y build aprobados. El build
  reportó las rutas existentes `/`, `/dashboard`, `/invitations`, `/login` y
  `/notifications`; `/register` se incorporará en un bloque posterior.

Concepto practicado: el contrato fija qué datos y respuestas acepta el backend;
la interfaz debe representarlo sin duplicar reglas de negocio ni exponer tokens.

### Bloque 2 — Propuesta visual (aprobada con ajuste)

- [x] Maqueta local de Inicio y Registro creada en
  prompts/diseno/fase-8/propuesta.html, con guía en el README de su carpeta.
- El propietario rechazó la primera composición por resultar demasiado básica.
  La segunda versión fue escrita directamente por `frontend-designer` usando
  `frontend-design`: composición asimétrica, muestra interactiva Personal/Familia
  y registro con ilustración del espacio personal. El propietario aprobó esta
  versión con el ajuste de la nota bajo la ilustración.
- [x] La maqueta alterna vistas y estados de registro ficticios sin enviar datos.
  Incluye agenda de muestra, CTA de crear cuenta, campos previstos, accesibilidad
  base, paleta actual y adaptación CSS para móvil.
- [x] Revisión estática independiente sin defectos bloqueantes; documentados el
  límite de navegación a login y la fuente local de reserva. No se afirma
  inspección visual propia en navegador.
- [x] El propietario aprueba la composición y autoriza iniciar el bloque 3.
  Solicita rehacer o mover la nota bajo la muestra; se integra como pie discreto
  de la ventana ilustrativa, sin tarjeta flotante.

La aceptación visual corresponde a la revisión del propietario. No se presenta
la revisión estática como una inspección propia en navegador.

### Bloque 3 — Formulario y validación (implementado; revisión manual pendiente)

- [x] Nueva ruta `/register` con el diseño aprobado: cuatro campos, mostrar/
  ocultar contraseña, ilustración del espacio personal y enlaces a Inicio/Login.
  Estilos propios limitados a `.app-design.register-page` en `globals.css`.
- [x] Validación local de nombre, correo, longitud y coincidencia; nombre/correo
  normalizados, contraseña preservada exactamente. Errores asociados a campos
  y foco en el primero inválido. Autocomplete conforme a cada dato.
- [x] Entrega provisional sin peticiones: «Revisar datos» muestra «Los datos
  están listos.» si son válidos. No guarda credenciales ni simula cuenta creada.
  La conexión real y la guarda de sesión corresponden al bloque 4.
- [x] La nota de la maqueta se integró como pie discreto de la ventana ilustrativa.
- [x] Frontend lint, TypeScript y build aprobados; build incluye `/register`.
  Revisión independiente estática sin hallazgos bloqueantes y diff sin errores
  de espacios. Documentación local de componentes servidor/cliente y Link leída.
- [ ] Revisar `/register` en navegador: campos vacíos, correo inválido, contraseña
  corta, confirmación distinta, datos válidos, mostrar/ocultar, foco, teclado y
  adaptación móvil. No se afirma inspección propia en navegador.

Concepto practicado: los campos controlados mantienen los datos en memoria;
la validación local orienta y dirige el foco, pero no crea una cuenta ni sustituye
la validación posterior del servidor.

### Bloque 4 — Sesión previa, creación y entrada (implementado; manuales pendientes)

- [x] Ajuste pedido por el propietario: «Volver al inicio» al nivel superior del
  panel en escritorio, eliminando el padding superior de la columna izquierda.
  El propietario confirma que el diseño móvil del bloque 3 se ve bien.
- [x] Guarda de sesión con refresh compartido y perfil: una sesión válida o
  recuperable muestra confirmación de destino; solo `401` final habilita
  registro; fallo de red muestra reintento. Fieldset bloqueado mientras se
  comprueba sesión.
- [x] POST único mediante `api('/auth/register')`, con nombre/correo normalizados
  y contraseña intacta, sin confirmación en el body. Ref inmediata y bloqueo de
  formulario durante envío. Sin reintentos automáticos de alta.
- [x] Validación mínima de respuesta, token en memoria, limpieza de contraseñas
  y redirección al dashboard; se ignoran resultados tras desmontaje. Errores
  básicos en español, con enlace a login. Refinamiento de errores: bloque 5.
- [x] Frontend lint, TypeScript y build aprobados. No se crearon cuentas ni se
  modificaron backend o base de datos para estas verificaciones.
- [x] Revisión estática independiente completada: se reforzó la comprobación
  del perfil incluyendo `personalGroupId` válido antes de redirigir. No quedaron
  otros hallazgos en el alcance revisado.
- [ ] Comprobar en navegador: sesión existente, acceso anónimo, alta nueva,
  dashboard Personal vacío, recarga, logout/login y doble envío con red lenta.

Concepto practicado: comprobar una sesión es una lectura recuperable; registrar
es una mutación que no debe repetirse automáticamente. La cookie permite
recuperar el acceso después de recargar, mientras el token permanece en memoria.

### Ajustes autorizados tras el bloque 4 — Cerrar sesión y espera de registro

- El propietario detectó que faltaba una salida visible y que el registro
  aparecía brevemente mientras se comprobaba una sesión existente con Slow 4G.
- [x] `/register` solo monta el formulario y la ilustración en estado guest.
  Comprobación/redirección muestran marca y estado; error muestra reintento.
- [x] «Cerrar sesión» junto a la campana en Dashboard y Notificaciones mediante
  `components/logout-button.tsx` integrado en `AppShell`. Cuenta con estado
  pendiente, bloqueo de doble clic y error recuperable.
- [x] `logoutSession` reutiliza `POST /auth/logout`, espera refresh en curso y
  bloquea nuevas rotaciones. Tras éxito limpia el token en memoria y abre login
  mediante navegación completa para descartar estado de la cuenta.
- [x] Lint, TypeScript y build aprobados. Comprobación aislada con fetch simulado:
  orden refresh/logout, cierre compartido, bloqueo de refresh nuevo, limpieza
  tras éxito y liberación para reintento tras error. Sin red real ni fixtures.
- [x] Revisión independiente estática sin bloqueantes en el alcance. El cierre
  no cancela operaciones que ya estaban en curso antes de pulsar el botón.
- [ ] Revisión manual de Slow 4G, cierre de sesión, fallo/reintento y regreso a
  `/register` después de salir.

### Ajuste móvil de cabecera solicitado por el propietario

- [x] La fila de cuenta (nombre, campana y cierre) se sitúa entre marca y
  navegación en móvil; el selector de espacio queda debajo a ancho completo.
  Escritorio conserva su ubicación junto al contexto.
- [x] Una única instancia de los controles cambia de ubicación mediante un
  contenedor de portal estable y matchMedia. Mantiene el estado de cierre y el
  orden real de tabulación; se retira el listener al desmontar.
- [x] Lint, TypeScript y build aprobados; revisión visual propia no realizada.
- [ ] Comprobar 360/390 px, nombre largo y cambio 767/768 px, incluido un error
  de cierre de sesión al redimensionar.

### Bloque 5 — Errores y recuperación (implementado el 19 de noviembre de 2026)

- [x] El envío distingue `400` (datos rechazados), `409` (correo existente),
  errores `5xx`, fallos de conexión y respuestas inesperadas. El enlace de login
  aparece cuando puede ayudar a recuperar una cuenta existente o confirmar una
  respuesta ambigua.
- [x] Los mensajes no exponen detalles internos del servidor. Se conservan
  nombre y correo, no se reintenta el POST automáticamente y el bloqueo contra
  doble envío se libera para un nuevo intento deliberado.
- [x] El reintento de la comprobación de sesión permanece disponible si falla
  la consulta; la protección existente evita redirigir después del desmontaje.
- [x] Frontend lint, TypeScript, build y `git diff --check` aprobados. No se
  añadieron ni ejecutaron pruebas automatizadas y no se usaron cuentas reales.
- [ ] Verificar manualmente errores de validación, conflicto 409, pérdida de
  conexión y reintento deliberado con una cuenta de prueba.

Concepto practicado: un error HTTP describe una respuesta del servidor, mientras
que un fallo de conexión puede dejar incierto si el servidor alcanzó a procesar
el registro. Por eso nunca se reenvía automáticamente una creación de cuenta.

### Bloque 6 — Navegación pública (implementado el 19 de noviembre de 2026)

- [x] La portada lleva a «Crear cuenta» como acción principal y a login como
  alternativa para quien ya tiene una cuenta; se retiró el acceso directo al
  dashboard de ese recorrido público.
- [x] Login ofrece crear cuenta y conserva su regreso a inicio. Registro ofrece
  login en cabecera/formulario y regreso a inicio.
- [x] No se añadieron enlaces para códigos de invitación fuera de Familia.
- [x] Frontend lint, TypeScript, build y `git diff --check` aprobados.
- [ ] Revisar manualmente inicio → registro → inicio/login y login → registro,
  en escritorio y móvil.

Concepto practicado: los enlaces públicos ayudan a elegir entre registrarse y
entrar con una cuenta existente sin exponer rutas de trabajo como llamada
principal antes de autenticar.

### Confirmación al abrir registro con sesión activa (ajuste solicitado)

- [x] El guard ya no redirige automáticamente: presenta un diálogo con acciones
  para ir al dashboard, cerrar sesión y crear otra cuenta, o volver al inicio.
- [x] Cerrar sesión usa `logoutSession` y el endpoint existente; después hace
  navegación completa a `/register` para limpiar el bloqueo compartido y el
  estado de autenticación en memoria. Si falla, conserva la sesión y permite
  reintentar.
- [x] Diálogo nativo con semántica modal, foco contenido, Escape vuelve al inicio,
  responsive y estilos acordes a Fase 7.
- [x] Lint, TypeScript y build aprobados tras implementar y centrar el diálogo.
- [ ] Revisión manual de las tres opciones, logout y posición centrada en varios
  tamaños de pantalla.

### Bloque 7 — Inicio: cabecera y presentación (implementado el 19 de noviembre de 2026)

- [x] La portada tiene cabecera de marca con acceso a login y un hero con el
  mensaje principal, explicación corta, Crear cuenta y Ya tengo una cuenta.
- [x] La muestra ilustra espacios Personal/Familia con datos ficticios y un
  control local para alternarlos; no hace peticiones ni ejecuta operaciones.
- [x] En escritorio el hero acompaña texto y muestra; en anchos móviles se
  apilan. Los estilos están delimitados a `.app-design.home-page`.
- [x] Revisión estática posterior al diseño: sin hallazgos pendientes. Se subió
  a 44 px la altura mínima de los controles Personal/Familia para cumplir el
  objetivo táctil del plan.
- [x] Frontend lint, TypeScript, build y `git diff --check` aprobados.
- [ ] Verificar la vista real en navegador a 390 y 1440 px, foco por teclado y
  alternancia Personal/Familia y sección explicativa.

Concepto practicado: la portada puede mostrar un ejemplo de la interfaz para
explicar el producto sin conectarse a la API, siempre identificando los datos
ficticios y evitando presentar la muestra como una operación real.

### Bloque 8 — Inicio: explicación y móvil (implementado el 19 de noviembre de 2026)

- [x] Se añadieron tres filas editoriales para fechas/costes, reparto de pagos
  grupales y avisos; las capacidades se describen sin prometer cobros reales.
- [x] Se incluyó la aclaración «Los pagos se registran manualmente; la aplicación
  no mueve dinero».
- [x] Filas y texto se reorganizan para móvil, con reglas específicas hasta 380 px.
  La muestra Personal/Familia continúa claramente marcada como ilustrativa y
  permanece local, sin llamadas API ni controles adicionales de negocio.
- [x] Revisión estática sin bloqueantes: sin duplicación estructural, afirmaciones
  engañosas ni desbordamiento obvio a 360/390/768/1440 px por inspección CSS.
- [x] Frontend lint, TypeScript, build y `git diff --check` aprobados.
- [ ] Verificar visualmente en navegador esos cuatro anchos, zoom/teclado,
  llamadas a registro/login y alternancia del ejemplo.

Concepto practicado: filas con separadores permiten explicar varias capacidades
reales con una sola jerarquía visual, sin convertir la portada en una colección
de tarjetas ni presentar la muestra como una pantalla operativa.

### Bloque 9 — Revisión y cierre técnico (revisión completada; aceptación pendiente)

- [x] Revisión independiente del registro, sesión, logout, rutas y landing:
  ningún hallazgo funcional o de accesibilidad bloqueante.
- [x] Corregida la fila de la tabla de bloques que aún describía la redirección
  automática de sesión activa; la matriz también refleja el diálogo actual.
- [x] `frontend/README.md` actualizado con rutas, límites, normalización, sesión,
  diálogo, errores, cierre y explicación de pagos manuales. No se afirma
  verificación de correo.
- [x] Frontend lint, TypeScript, build y `git diff --check` aprobados.
- [ ] Aceptación manual en navegador: los recorridos indicados en las matrices
  siguen pendientes; por ello no se declara cerrada la Fase 8.

Concepto practicado: una revisión estática puede encontrar contradicciones entre
documentación y código, pero no sustituye una comprobación real de interacciones,
responsive y efectos de sesión en el navegador.

Actualizar el avance en este plan después de cada bloque. Al terminar, documentar
en `frontend/README.md` las rutas y el recorrido de registro, campos, límites,
sesión automática, conflictos y comprobaciones reales. No afirmar que el correo
fue verificado. Evitar copiar el plan entero a `AGENTS.md`.

- [x] Contrato actual y comprobaciones de entrada registrados en bloque 1.
- [x] Propuesta de inicio/registro aceptada antes del rediseño, con ajuste de la nota.
- [ ] Registro accesible y validado sin duplicar la confirmación en la API.
- [ ] Alta real, entrada automática, recarga y login posterior comprobados.
- [ ] Sesión previa, errores y reintento comprobados sin altas automáticas repetidas.
- [x] Inicio/login/registro enlazados; códigos permanecen en Familia.
- [x] Portada alineada a Fase 7, pública, clara y sin funciones prometidas inexistentes.
- [ ] Móvil, teclado, zoom y estados revisados en navegador.
- [x] Revisión independiente y checks técnicos sin hallazgos pendientes.
- [ ] Documentación y aceptación manual del propietario registradas.
- [x] Sin dependencias nuevas, migraciones, cambios de contrato o secretos persistidos.

Preparar este documento no marca ninguna casilla como completada ni inicia el
bloque 1. Si aparece un cambio de contrato o un alcance de backend necesario,
explicarlo y ajustar el bloque antes de extender la implementación.
