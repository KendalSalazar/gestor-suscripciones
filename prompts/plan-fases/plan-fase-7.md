# Plan Fase 7 — Rediseño visual y organización del frontend

**Estado al 17 de noviembre de 2026: bloques 1 a 10 implementados; el bloque 10 queda pendiente de revisión visual del propietario. Suscripciones ya fue revisada; Pagos personal/familiar está disponible para revisión. Diseño aprobado con acento #CF7FFF. Bloques 11 a 18 pendientes.**
Alcance original en [07-fase.md](../07-fase.md). Una entrega por bloque, con
explicación, comprobación y parada. Crear este plan no ejecuta sus bloques.

## 0. Punto de partida contrastado

Se comprobaron carpeta de trabajo y raíz Git: ambas son
`E:\repos vsc\gestor-suscripciones`. Commit observado: `ca1aedf`,
«Fase 6 completada: notificaciones». Hay cambios previos en `AGENTS.md`, los
documentos de cierre de Fase 6 y el perfil `frontend-designer`; se conservan.

Se leyeron `AGENTS.md`, `frontend/AGENTS.md`, el cierre de Fase 6, el perfil
`.codex/agents/frontend-designer.toml`, la skill `frontend-design` y los archivos
de las pantallas. El diagnóstico inicial procede del código y de los comentarios
del propietario; no se presenta como una inspección visual en navegador.

Evidencia previa de Fase 6: 1092 pruebas backend con PostgreSQL, compilaciones,
lint y TypeScript aprobados; recorrido manual confirmado por el propietario.
No se volvieron a ejecutar para redactar este plan. El bloque 1 comprobará el
estado vigente y documentará las pantallas antes de modificarlas.

### Problemas concretos encontrados

| Evidencia en código | Consecuencia que debe resolver el diseño |
|---|---|
| `dashboard/page.tsx`: saludo, descripción, espacio, contador y navegación preceden al contenido | El título de la tarea y el contexto pierden protagonismo |
| Alta de suscripción siempre visible junto a la lista | El formulario compite con la consulta cotidiana |
| `family-groups-panel.tsx`: crear, renombrar, transferir, salir y miembros | Acciones de uso frecuente y delicadas al mismo nivel |
| `family-payments-panel.tsx`: partes propias, historial y pagos sin parte propia | Se puede confundir el importe propio con el importe del grupo |
| `notifications/page.tsx`: estructura y anchos distintos del dashboard | Cambiar de destino rompe la continuidad visual |
| `/invitations` existe, pero el propietario no encontró dónde introducir el código | Hace falta un acceso visible, también sin pertenecer a una familia |
| `layout.tsx` carga Geist y `globals.css` aplica Arial; modo oscuro automático parcial | Tipografía y contraste sin un criterio común |

Frontend actual: Next.js 16.3.3 App Router, React 19.2.8, Tailwind 4, TypeScript.
Sin dependencias de componentes ni infraestructura de pruebas de navegador
instaladas en `package.json`. Reutilizar las herramientas existentes.

### Bloque 1 — Inventario y comprobaciones base (15 de noviembre de 2026)

Carpeta y raíz Git verificadas otra vez. Se conservaron los cambios previos y
se delegó al perfil `frontend-designer` el inventario de solo lectura, aplicando
la skill `frontend-design`. Este registro procede de código, no de capturas.

| Pantalla / archivo bajo `frontend/src/app/` | Acciones vigentes y permiso | Estados que conservar |
|---|---|---|
| `/`, `page.tsx` | Ir al login o dashboard, público | Landing fuera del rediseño |
| `/login`, `login/page.tsx` | Iniciar sesión, envío a dashboard | Envío pendiente, error y credenciales; no existe formulario de registro ni botón de logout en la UI actual |
| `/dashboard`, `dashboard/page.tsx` | Seleccionar espacio y Suscripciones/Pagos/Familia; enlaces a inicio y Notificaciones | Sesión, grupos, carga/error, retorno al personal ante contexto inválido y recarga de vista |
| Suscripciones, `dashboard/page.tsx` | Consultar para miembro activo; crear, cambiar coste, activar/desactivar y eliminar para owner | Vacío, errores de consulta/acción, formulario/borrador, bloqueo durante envío; no hay edición general de nombre/proveedor/ciclo/fecha |
| Pagos personal, `dashboard/payments-panel.tsx` | Consultar pendientes e historial; confirmar importe u omitir como owner personal | Recargas independientes, formulario de confirmación, éxito/error y acción en curso |
| Pagos familiar, `dashboard/family-payments-panel.tsx` | Consultar partes propias, historial, pagos sin parte propia y desglose; confirmar solo parte propia; omitir conjunto intacto solo owner | Respuestas separadas por lista/desglose, expansión, borrador, límite miembro y excepción de owner; fallo de acceso actualiza grupos |
| Familia, `dashboard/family-groups-panel.tsx` | Crear familia; miembro activo consulta lista; owner renombra, transfiere y retira miembros; member puede salir | Carga/permisos, recarga/reintento, confirmación y bloqueo por obligaciones pendientes |
| Invitaciones owner, `dashboard/invitations-panel.tsx` | Crear por correo, copiar/ocultar código, listar historial y revocar; solo owner familiar | Código entregado una vez en memoria, errores de copia/red y operación pendiente |
| `/invitations`, `invitations/page.tsx` | Con sesión invitada, pegar código, revisar, aceptar/rechazar, usar otro código y volver al dashboard | Sin sesión, reintento, código inválido/no disponible/vencido/resuelto, envío y resultado; código se borra al ir a login |
| `/notifications`, `notifications/page.tsx` | Destinatario consulta, filtra grupo/lectura, actualiza, carga más, marca leído y abre pagos del grupo | Sesión/grupos/lista independientes, vacío/error, cursor/conteo, respuesta obsoleta cancelada y error por fila |

Riesgos de implementación localizados:

- `dashboard/page.tsx:612`, `:838` y `:857` usan `hidden` para conservar vistas
  montadas. Cambiar por renderizado condicional puede perder borradores; sus
  efectos también pueden seguir activos con la vista oculta.
- Las claves de paneles familiares incluyen grupo, owner y rol (`:846`, `:861`,
  `:873`); conservar su invalidación al cambiar permisos.
- `dashboard/page.tsx:614` coloca el formulario de alta junto a la lista;
  `:773` edita solo coste. Las maquetas no deben prometer una edición más amplia.
- El desglose y las tres listas familiares no representan obligaciones nuevas;
  evitar acciones duplicadas o sumas de listas parciales.
- La sesión de `lib/api.ts` coordina refresh; las cabeceras nuevas serán
  presentacionales para no duplicar peticiones ni crear otro almacén de sesión.

Comprobaciones ejecutadas ahora:

- [x] `pnpm.cmd --dir frontend lint` y `pnpm.cmd --dir frontend exec tsc --noEmit`.
- [x] `pnpm.cmd --dir frontend build`: compiló y generó `/`, `/login`,
  `/dashboard`, `/invitations` y `/notifications`, además de la ruta de error.
  Primer intento falló por conexión a Google Fonts; repetido con acceso de red
  terminó correctamente, sin cambiar fuentes ni código.
- [x] Inventario de acciones/permisos y riesgos contrastado con los archivos.
- [x] Capturas base de 390 y 1440 px: completadas antes del CSS del bloque 3;
  [índice de las 16 capturas reales](../diseno/fase-7/estado-inicial/README.md).
  Limitación inicial del bloque 1: no había herramienta conectada de
  navegador ni sesión de prueba automatizada disponible. Se localizaron binarios
  de Chrome/Edge, pero no se lanzó una sesión autenticada ni se inspeccionó la
  interfaz. No se afirman contrastes, desbordes o comportamiento responsive verificados.

Se acepta el bloque con esta limitación explícita, según su criterio original.
Antes de cambiar estilos en el bloque 3, registrar las capturas base con sesión
de prueba en el bloque 2: escritorio/móvil, personal owner, familia owner/member,
Notificaciones e Invitación, sin códigos secretos visibles. Puede completarlo
el propietario desde su navegador o el agente con un entorno autorizado.
Las capturas de mockups futuros no reemplazan las del estado anterior.
En aquel inventario no se iniciaron servidores, jobs ni escrituras sobre cuentas
o pagos. Posteriormente se utilizó el frontend/API local y un perfil temporal de
Chrome con cuentas de prueba autorizadas para completar las capturas antes del
bloque 3. Login, refresh y logout usan la sesión normal; no se modificaron datos
de suscripciones, pagos, membresías, invitaciones ni lecturas de notificaciones.

### Bloque 2 — Propuesta visual (15 de noviembre de 2026)

Preparada por el perfil `frontend-designer` con la skill `frontend-design`.

- [x] [Maqueta navegable](../diseno/fase-7/propuesta.html) independiente, con datos
  sintéticos, sin API, sesión, almacenamiento persistente ni dependencias.
- [x] [Criterios visuales](../diseno/fase-7/criterios-visuales.md): tokens finales,
  tipografía, jerarquía, contrastes calculados y límites de la simulación.
- [x] Suscripciones, Pagos familiar y Familia, patrón de Notificaciones, formulario,
  vacío y alternancia responsable/miembro. El selector de rol superior pertenece
  solo a la maqueta; los permisos del producto seguirán viniendo del servidor.
- [x] Capturas Chrome con ancho CSS real de 1440/390 px: inspeccionadas en
  escritorio y móvil. Se comprobó que `scrollWidth` no supera el viewport de
  390 px en Suscripciones, Pagos miembro y vacío. Se verificaron título/escenario,
  rol, formulario abierto y vacío antes de capturar cada variante.
- [x] Revisión de código encontró foco perdido al leer, estado de confirmación
  retenido al cambiar rol y controles inferiores a 44 px; el diseñador los corrigió.
  No se presenta esta revisión como una prueba integral de teclado o de API.
- [x] Scripts y perfiles temporales del renderizado eliminados. Sin cambios en
  `frontend/src`, cuentas o base de datos. No se repitieron builds del producto
  porque solo se añadieron artefactos de diseño y documentación.
- [x] El propietario aceptó el diseño el 16 de noviembre y pidió dos ajustes:
  acento `#CF7FFF` y acceso al código solo dentro de Familia. No se adelanta bloque 3.
- [x] Capturas previas del producto autenticado registradas antes de cambiar
  estilos: [estado inicial](../diseno/fase-7/estado-inicial/README.md), con owner
  personal, owner/miembro en la misma familia, Notificaciones e Invitaciones de
  ambas cuentas, y landing, a 1440/390 px. Las imágenes de la galería siguiente
  siguen representando únicamente la propuesta.

Galería de la propuesta:

| Escenario | Imagen |
|---|---|
| Suscripciones escritorio | [1440 px](../diseno/fase-7/suscripciones-escritorio.png) |
| Pagos familiares escritorio | [1440 px](../diseno/fase-7/pagos-escritorio.png) |
| Familia escritorio | [1440 px](../diseno/fase-7/familia-escritorio.png) |
| Notificaciones escritorio | [1440 px](../diseno/fase-7/notificaciones-escritorio.png) |
| Formulario abierto | [1440 px](../diseno/fase-7/formulario-escritorio.png) |
| Suscripciones móvil | [390 px](../diseno/fase-7/suscripciones-movil.png) |
| Pagos miembro móvil | [390 px](../diseno/fase-7/pagos-movil.png) |
| Lista vacía móvil | [390 px](../diseno/fase-7/vacio-movil.png) |

Tokens elegidos por el diseñador: fondo `#F3F6FA`, superficie `#FFFFFF`, texto
`#1D2B3A`, secundario `#526375`, línea `#D6DFE8` y acento `#CF7FFF`.
Sobre el acento se utiliza texto oscuro; enlaces y foco usan un violeta oscuro
derivado para conservar contraste. La entrada al código queda dentro de Familia,
también cuando todavía no se pertenece a ninguna, sin enlace global duplicado.
Actualización inspeccionada el 16 de noviembre: las ocho capturas se regeneraron
con el nuevo color; el DOM confirma que no existe el enlace de código en la barra
global y los escenarios móviles conservan un ancho de contenido de 390 px.
Marca y fondos `#CF7FFF`, texto de botón `#111018` (7.32:1), enlaces/foco
`#78269E` y selección `#F7EBFD`. Perfiles y script temporal eliminados.
El prototipo usa fuente del sistema si Geist no está instalada; no descarga
fuentes. La implementación posterior reutilizará la fuente ya cargada por Next.

### Bloque 3 — Fundamentos (16 de noviembre de 2026)

Implementado por `frontend-designer` con la skill `frontend-design`, siguiendo
la propuesta aprobada. Revisado por `reviewer` sin hallazgos que requieran
corrección en este alcance. Evidencia visual y límites en
[comprobaciones del bloque 3](../diseno/fase-7/bloque-3/README.md).

- [x] `globals.css`: tokens y estilos bajo `.app-design`, con marca `#CF7FFF`,
  texto sobre marca `#111018`, foco `#78269E`, superficies, bordes y error.
  La muestra usa Geist y `color-scheme: light` dentro de su ámbito.
- [x] `dashboard/page.tsx`: solo 15 sustituciones de `className` en el alta
  existente. Se conservan handlers, etiquetas/IDs, validaciones, permisos,
  `disabled`, mensajes `role=alert`, `hidden` y borradores.
- [x] Sin dependencias ni componentes React nuevos: las clases compartidas
  resuelven la reutilización visual de esta muestra. No se adelantó el alta
  bajo demanda ni la reorganización de navegación/listas.
- [x] Capturas antes/después de la muestra a 1440/390 px inspeccionadas. Los
  campos y el botón miden al menos 44 px; sin desborde a 390 px.
- [x] Tab mueve el foco de Nombre a Proveedor y muestra contorno violeta de
  3 px; también se comprobó foco visible del botón. Formulario vacío conserva
  validación HTML. Borrador conservado al abrir Pagos y volver.
- [x] Fallo de conexión simulado solo en el navegador: el POST de alta se
  interceptó sin llegar al backend; botón bloqueado durante la espera, alerta
  visible, botón rehabilitado y borrador intacto tras el fallo. No se afirma
  haber probado un alta exitosa en este bloque.
- [x] Miembro de la misma familia: no aparece la muestra de alta ni acciones
  de administración de suscripciones. No se amplió la autorización existente.
- [x] Landing idéntica: comparación SHA-256 de las dos PNG antes/después con
  igual viewport, preferencia clara e indicador de desarrollo oculto solo en
  el navegador. No se cambiaron `:root`, `body`, `layout.tsx` ni la landing.
- [x] Frontend lint, `tsc --noEmit`, build y `git diff --check` aprobados.
- [x] Sesiones cerradas, cookies del perfil temporal borradas, navegador y
  perfiles cerrados/eliminados; script temporal eliminado. Sin credenciales
  guardadas en archivos del proyecto.

Límite visual: la muestra mantiene contraste con preferencia oscura; el fondo
oscuro y el contraste deficiente de partes todavía no migradas siguen siendo
visibles y se tratarán al migrar sus contenedores. No se presenta esta muestra
como el rediseño terminado ni como la regresión integral del bloque 17.

### Bloque 4 — Navegación y contexto (16 de noviembre de 2026)

Implementado por `frontend-designer` con `frontend-design`, partiendo de la
propuesta aprobada. Revisión de código por `reviewer` sin hallazgos nuevos en
este bloque. [Capturas y comprobaciones](../diseno/fase-7/bloque-4/README.md).

- [x] Nuevo `frontend/src/components/app-shell.tsx`: contenedor presentacional
  con slots de navegación/contexto y props de título, descripción, usuario y
  contenido. No incluye hooks, consultas, sesión ni estado de negocio.
- [x] Dashboard: navegación lateral en escritorio y cuadrícula en móvil, vista
  activa con `aria-pressed`, título de tarea, espacio/tipo/rol separado del
  contenido. `Responsable` representa el rol owner existente.
- [x] Notificaciones conserva `/notifications` a una activación. El filtro
  inicial continúa en todos los espacios; no hereda el grupo del dashboard.
- [x] Código solo dentro de Familia, accesible desde personal sin seleccionar
  familia, desde owner y desde miembro. Dos activaciones desde Suscripciones:
  Familia y «Tengo un código de invitación». Ambas cuentas abrieron `/invitations`
  con campo vacío, sin secretos en URL ni capturas.
- [x] Se conservan `changeView`, `changeSelectedGroup`, permisos, bloqueos,
  claves y paneles montados con `hidden`. Borrador comprobado al ir a Pagos y
  volver; cambio de grupo limpia el borrador conforme a la política anterior.
- [x] Recarga observada al cambiar de vista; la vuelta a Suscripciones consulta
  grupos y suscripciones. El contenedor nuevo no incorpora peticiones.
- [x] Enlace directo `groupId`/`view` a Pagos familiar, contexto inválido con
  retorno al personal y aviso, y atrás/adelante entre esos contextos comprobados.
- [x] Capturas de dashboard y Familia owner/miembro a 1440/390 px; foco por Tab
  en navegación, controles de navegación de al menos 44 px, ancho sin desborde
  en los escenarios medidos y dashboard claro con preferencia oscura.
- [x] Landing idéntica por SHA-256 de las PNG a 1440/390 px; estilos nuevos
  delimitados por `.app-design`, sin modificar `:root`, `body` o layout raíz.
- [x] Frontend lint, TypeScript, build y `git diff --check` aprobados.
- [x] Sin escrituras de producto: solo login/refresh/logout y consultas.
  Se levantó API Express temporal sin scheduler ni migraciones. Servidores
  temporales cerrados; navegador, perfil y script temporal eliminados.

Las páginas de Notificaciones e Invitaciones adoptarán el contenedor al llegar
a sus bloques 13 y 12; sus rutas ya funcionan. Las listas y formularios del
dashboard mantienen su composición hasta los bloques correspondientes.

Observación preexistente: React avisa de la misma key en los paneles hermanos
`FamilyGroupsPanel` e `InvitationsPanel` en Familia owner. Las expresiones ya
están en HEAD anterior y este bloque las conserva. Registrar su corrección y
comprobar la identidad/borradores al migrar Familia e Invitaciones (bloques
10–12), antes de la regresión final. El recorrido visual de este bloque pasó;
no se afirma que ese aviso previo esté resuelto.

### Bloque 5 — Consulta de suscripciones (16 de noviembre de 2026)

El propietario autorizó avanzar varios bloques hasta poder revisar un diseño
más establecido. Se delimitó la entrega a los bloques 5 y 6 y se detiene antes
de Pagos para revisar una primera vista completa. Implementación delegada a
`frontend-designer` con `frontend-design`; evidencia y galería en
[Suscripciones](../diseno/fase-7/bloques-5-6/README.md).

- [x] Una lista principal en una superficie, con filas y separación clara de
  servicio/proveedor/frecuencia, fecha, coste y estado escrito. Se elimina el
  título duplicado; encabezados de columna en escritorio y etiquetas `dt` en
  móvil. `<time>` conserva el valor DATE y costes siguen como string sin moneda
  inventada. Sin alterar el orden de los datos devueltos por la API.
- [x] Contexto, carga, vacío, error y reintento conservados; consulta de miembro
  sin controles owner. Estados con el mismo vocabulario visual y sin ocultar
  la causa del fallo o reemplazar datos de otro grupo.
- [x] Checkpoint 5 inspeccionado en navegador y aprobado por el principal antes
  de implementar el 6; lint, TypeScript y revisión de diff aprobados.

### Bloque 6 — Alta y edición (16 de noviembre de 2026)

- [x] Botón «Añadir suscripción» en la cabecera mediante slot opcional `actions`
  de `AppShell`. Alta montada con `hidden`, controles y semántica conservados;
  dos columnas en escritorio y una en móvil. Cancelar cierra sin enviar y
  conserva el borrador en el mismo grupo. Abrir enfoca Nombre; cancelar devuelve
  foco al botón. Navegación del mismo contexto conserva apertura y datos;
  cambio de grupo invalida apertura y limpia borrador.
- [x] Disclosures de administración por servicio exclusivos de owner. Cambiar
  coste mantiene la capacidad real de edición: mismo endpoint, validación,
  payload string y mensaje sobre pagos históricos. Eliminar y activar/desactivar
  mantienen handlers, confirmación, permisos y bloqueos.
- [x] Edición conserva borrador al colapsar/expandir y al cambiar de vista y
  volver; tras recarga reabre la fila que sigue en edición. Error mantiene
  borrador; cancelar/éxito devuelven foco al disclosure.
- [x] Estados de alta, edición, activación y eliminación comprobados con
  respuestas interceptadas solo en navegador, sin persistencia: bloqueo de envío
  repetido mientras espera, error y éxito de POST/PATCH, cancelar confirmación
  de DELETE sin petición, conflicto 409 y respuesta 204. La consulta posterior
  restaura las filas reales y sus importes originales.
- [x] Se encontró retorno de foco inconsistente tras éxito rápido del alta.
  Corregido con intención de foco en ref y efecto tras commit con botón
  habilitado; repetición de error rápido y éxito rápido pasó. La intención se
  cancela si cambia contexto, vista, sesión o permiso.
- [x] Owner y miembro reales: lista, alta abierta, editor y consulta en capturas
  1440/390 px. Medidas de consulta adicionales a 360/768 sin desborde. Tab al
  botón de alta con foco visible. Preferencia oscura mantiene ámbito claro.
  Landing idéntica por SHA-256 a las dos referencias anteriores.
- [x] Lint, TypeScript y build final aprobados; `reviewer` sin hallazgos nuevos,
  incluido el parche de foco; `git diff --check` aprobado. Sin dependencias,
  cambios backend, contratos ni escrituras de producto.
- [x] Sesiones cerradas, interceptores retirados, navegador/perfil y script
  temporal eliminados. Frontend y API de revisión permanecen disponibles para
  la revisión del propietario; API sin scheduler ni migraciones.

Las simulaciones verifican la interfaz ante respuestas del contrato; no se
presentan como nuevas pruebas de persistencia. La revisión integral de teclado,
zoom y todos los recorridos continúa en los bloques 16 y 17. La incidencia
previa de claves de Familia sigue registrada para el bloque 10. Se espera la
revisión visual de esta primera vista antes de extender el diseño a Pagos.

### Bloque 7 — Pagos personales (16 de noviembre de 2026)

Implementado por `frontend-designer` con la skill `frontend-design`. Evidencia
visual y comprobaciones: [galería de los bloques 7–9](../diseno/fase-7/bloques-7-9/README.md).

- [x] Pendientes primero e historial después; filas muestran servicio, importe
  previsto/registrado, fecha y estado, evitando repetir encabezados.
- [x] Se conservan consultas, validación, importe decimal como string, límites
  de lista, estados de carga/error, abortos, bloqueo de doble envío, cancelación
  de confirmación y los payloads existentes para confirmar/omitir.
- [x] Un importe inválido no envía; una respuesta de error mantiene el borrador;
  respuestas simuladas confirman el estado y permiten mostrar importes distintos
  y conflictos. El borrador sobrevive al cambio de vista.
- [x] Foco al abrir la confirmación y retorno al botón al cancelar, después de
  actualizar el DOM; Tab muestra foco visible. No se escribió ningún pago.
- [x] Datos reales de ambas cuentas en capturas 1440/390 px; fixtures de
  navegador para validación, error, conflicto y éxito. Landing idéntica a las
  referencias por SHA-256. Lint, TypeScript, build y revisión de diff aprobados.

### Bloque 8 — Mis partes familiares (16 de noviembre de 2026)

- [x] La parte propia aparece en una sección diferenciada del importe y progreso
  de grupo. El coste esperado, lo registrado, la fecha y el estado se presentan
  como datos separados; no se recalculan importes en la interfaz.
- [x] Se conserva el tope de miembro en su parte y la excepción existente para
  que owner registre un importe mayor en su parte. Pruebas de navegador con
  respuestas interceptadas cubrieron exceso, error, doble envío, éxito y
  persistencia del borrador entre vistas; ninguna petición de escritura llegó
  al backend.
- [x] Contexto real: parte esperada 5, importe propio registrado 4.50, grupo
  esperado 10 y registrado 9.50. Capturas y fixtures separados en la galería.
- [x] Sin cambios en servicios, permisos, reglas de dominio, API ni base de
  datos. La revisión del `reviewer` no encontró regresiones nuevas.

### Bloque 9 — Pago del grupo y desglose (16–17 de noviembre de 2026)

- [x] El progreso del pago del grupo y el desglose expandible identifican
  participantes, cuota/porcentaje previsto, importe registrado y estado.
- [x] Pagos sin una parte propia se muestran en una sección aparte. Se conservan
  la clasificación protegida por carga de partes, la lista de IDs propios, los
  permisos owner para omitir el pago completo y la salvaguarda si falla el
  historial de partes. El desglose y el reintento mantienen sus estados de
  carga/error.
- [x] Lecturas reales y respuestas simuladas cubrieron desglose, error/reintento,
  clasificación segura, confirmación, omisión, conflicto y éxito. No se hicieron
  escrituras de producto ni cambios de datos.
- [x] Capturas 1440/390 px de owner/miembro, varias anchas de viewport y
  preferencia oscura; landing intacta. Lint, TypeScript, build y `git diff
  --check` aprobados; revisión `reviewer` sin hallazgos nuevos.
- [x] Sesiones cerradas, interceptores retirados, cookies borradas y navegador,
  perfil aislado y script temporal eliminados. API de revisión sin scheduler ni
  migraciones; servicios frontend/API disponibles para inspección visual.

La galería distingue datos reales de fixtures simuladas. Las capturas no
demuestran persistencia para los estados simulados. Después de este checkpoint,
el trabajo continuó con el bloque 10, documentado a continuación. La colisión
preexistente de keys React entre los paneles hermanos se resolvió allí al dar
una key propia a cada panel.

### Bloque 10 — Familia y miembros (17 de noviembre de 2026)

Implementado según la propuesta aprobada por el propietario, con `frontend-designer`
y la skill `frontend-design`. El `reviewer` no encontró hallazgos en este bloque.
La revisión visual del propietario sigue pendiente; no se registran capturas nuevas.

- [x] En Familia seleccionada, la lista continua de miembros aparece antes del
  panel administrativo. Cada fila muestra inicial violeta, nombre, fecha y rol;
  en móvil los datos se apilan sin columnas estrechas.
- [x] En Personal, la vista explica cómo crear una familia. La acción de crear
  está en la cabecera general de Familia y abre el formulario dentro de la vista;
  conserva el borrador al cerrar y lo limpia al cambiar de grupo o crearla.
- [x] «Administrar familia» está integrada con el nombre y rol del grupo actual;
  la lista de miembros conserva su jerarquía separada y queda antes del detalle.
- [x] El enlace de código de invitación continúa únicamente en Familia. El
  contenido y los handlers de administración e invitaciones se conservaron.
- [x] Las keys de `FamilyGroupsPanel` e `InvitationsPanel` ahora tienen prefijos
  distintos, eliminando la colisión preexistente entre paneles hermanos.
- [x] ESLint, `tsc --noEmit`, `git diff --check` y la ruta local del dashboard
  (HTTP 200) aprobados. Sin cambios de API, backend ni datos de producto.
- [ ] Revisión visual del propietario en escritorio y móvil.

### Bloque 11 — Administración familiar (17 de noviembre de 2026)

- [x] «Administrar familia» se integra con la tarjeta del grupo actual. Los
  controles de renombrado y transferencia quedan agrupados; retirar un miembro
  sigue junto a su fila, y salir conserva su zona de acción propia.
- [x] Confirmaciones, estados ocupados, permisos, llamadas y recuperación de
  contexto siguen en sus handlers existentes. Cambio de grupo, creación de
  familia y salida cierran el formulario de creación según el contexto.
- [x] Revisión estática de accesibilidad y reglas de rol. Se corrigió el
  `aria-controls` para que su destino permanezca montado y oculto al cerrar.
- [x] ESLint, TypeScript y `git diff --check` aprobados; no se cambiaron APIs,
  backend, persistencia ni reglas de producto. Revisión visual del propietario
  pendiente en escritorio y móvil.

### Bloque 12 — Invitaciones completas (17 de noviembre de 2026)

Implementación visual delegada a `frontend-designer` con la skill
`frontend-design`; revisión estática de `reviewer` sin hallazgos.

- [x] Owner: creación de invitaciones, aviso de código de un solo uso, acciones
  para copiar u ocultar y una lista de invitaciones con estados y vencimientos.
- [x] Receptor: formulario para ingresar el código, comprobación de sesión,
  revisión de familia/destinatario/vencimiento, aceptación o rechazo y resultado.
- [x] Se mantienen handlers, permisos, payloads y estados de error/carga; el
  código sigue solo en memoria y no se expone en URL, almacenamiento ni logs.
- [x] ESLint, `tsc --noEmit` y `git diff --check` aprobados. Sin cambios de API,
  backend ni persistencia. No hubo inspección de navegador; la revisión visual
  del propietario queda pendiente en escritorio y móvil.

## 1. Resultado deseado y límites

En cada pantalla se debe poder responder: «¿dónde estoy?», «¿para qué espacio?»
y «¿qué puedo hacer aquí?». El usuario ha elegido tres vistas para el dashboard;
se mantienen y se organizan mejor. No crear otra portada de estadísticas que
repita las mismas listas ni convertir toda la información en tarjetas iguales.

Incluye `/dashboard`, sus paneles, `/notifications`, `/invitations`, `/login`
y componentes de presentación pequeños. Conserva la landing `/` y su contenido;
los estilos nuevos deben quedar delimitados para no rediseñarla por accidente.

Fuera de alcance: backend, migraciones, jobs, nuevos endpoints, nuevas reglas de
pagos, registro de cuentas desde una nueva UI, perfil, búsqueda global, gráficos,
tema oscuro configurable, monedas, librerías UI y cambios de framework.
Si una pantalla necesita datos que la API no devuelve, se ajusta la propuesta
visual a lo disponible; cualquier ampliación de producto requiere otro alcance.

## 2. Organización de la información

| Destino | Información principal | Acción y contexto |
|---|---|---|
| Suscripciones | Servicios del espacio seleccionado, coste, frecuencia y próxima fecha | «Añadir suscripción» para owner; edición contextual; consulta para miembro |
| Pagos personal | Pendientes primero, historial después | Registrar el importe de un pago u omitir según permisos actuales |
| Pagos familiar | «Mis partes» primero; «Pago del grupo» como contexto separado | Confirmar únicamente la parte propia y consultar desglose |
| Familia | Miembros y rol, entrada/creación de familia y administración | Invitar, introducir código y acciones de gestión según permisos |
| Notificaciones | Eventos propios, lectura y obligación actual | Filtros, marcar leído, abrir pagos del grupo |
| Invitación | Introducir código, revisar familia y aceptar/rechazar | Acceso visible sin requerir una membresía familiar previa |
| Login | Acceso a la aplicación | Mantener flujo actual de sesión y errores |

Reglas de composición:

- Navegación estable con estado activo. En dashboard: Suscripciones, Pagos y
  Familia; enlace independiente a Notificaciones. El acceso «Tengo un código de
  invitación» queda únicamente dentro de Familia, lleva a `/invitations` y no
  depende de seleccionar una familia ni de ser owner.
- El selector de espacio es contexto de trabajo, separado de la navegación.
  Mostrar nombre, tipo y rol legible, sin exponer identificadores técnicos.
- Notificaciones mantiene su filtro propio «Todos los espacios» y el grupo
  elegido en ese centro. No hereda silenciosamente el espacio del dashboard al
  compartir la cabecera; solo un enlace explícito aplica contexto.
- Un título principal describe la tarea de la vista activa. Una acción primaria
  por ámbito; botones secundarios y peligrosos claramente diferenciados.
- Listas antes que formularios extensos. «Añadir» abre un formulario en línea
  que puede cerrarse; el estado del formulario conserva la política de borradores
  existente. Las acciones de cada fila pertenecen a esa fila.
- Información frecuente visible; detalle secundario expandible con etiqueta
  explícita. Los controles de transferencia/eliminación no compiten con lectura.
- No fusionar pagos ni notificaciones de tipos distintos para reducir filas:
  son eventos y obligaciones diferentes aunque compartan servicio o fecha.
- No inventar totales de gasto a partir de listas truncadas o páginas. Conservar
  límites visibles, filtros y paginación; no añadir sumas a esta fase.

## 3. Dirección visual aceptada, con ajustes del 16 de noviembre

Una agenda de servicios recurrentes: nombres, fechas y cantidades fáciles de
recorrer; ritmo de filas y espacio en blanco, con un acento de color reconocible.
El rasgo principal será la jerarquía entre servicio, próxima fecha y acción,
sin ilustraciones decorativas ni una cuadrícula de estadísticas ficticias.

Paleta inicial para los mockups:

| Token | Propuesta | Uso |
|---|---|---|
| Fondo | `#F5F7FA` | Superficie de la aplicación |
| Superficie | `#FFFFFF` | Contenido y formularios |
| Texto | `#18283B` | Títulos y lectura |
| Secundario | `#536276` | Información auxiliar |
| Acento | `#CF7FFF` | Marca y fondos de acción con texto oscuro; violeta oscuro derivado para texto/foco |
| Separador | `#D5DEE7` | Estructura entre grupos y filas |

Añadir colores semánticos para éxito, advertencia y peligro con contraste
medido en el bloque 2, sin depender únicamente del color. Geist Sans ya cargada
para títulos y cuerpo; cantidades con cifras tabulares, sin convertir toda la
interfaz a monoespaciado. Escala orientativa: 14/16/20/28/36 px; textos auxiliares
de al menos 14 px. Espaciado: 4/8/12/16/24/32/48 px. Alineación a la izquierda;
texto explicativo de hasta unas 75 letras por línea y controles con etiquetas.

El diseñador puede revisar estos valores al crear la propuesta; no son un diseño
aprobado. Usar bordes, radios y elevación por función, no una sombra y tarjeta
para cada dato. Mantener modo claro explícito en las superficies rediseñadas;
probar también con preferencia oscura del sistema para evitar herencias ilegibles.
No cambiar globalmente la landing al introducir tokens.

Boceto de organización, no maqueta aprobada:

```text
Escritorio
┌───────────────────┬──────────────────────────────────────────┐
│ Nombre aplicación │ Espacio: Personal / Familia    Rol       │
│ Suscripciones     ├──────────────────────────────────────────┤
│ Pagos             │ Suscripciones       [Añadir suscripción] │
│ Familia           │ Servicio      Próxima fecha      Coste   │
│ Notificaciones    │ ...                                      │
│                   │ [detalle o formulario solo al solicitar] │
└───────────────────┴──────────────────────────────────────────┘
Móvil
┌────────────────────────────────┐
│ Nombre aplicación              │
│ Suscripciones · Pagos · Familia │
│ Notificaciones                 │
│ Espacio y rol                  │
│ Suscripciones         [Añadir] │
│ Servicio, fecha, coste, acción  │
│ ...                            │
└────────────────────────────────┘
```

La propuesta del bloque 2 debe mostrar datos realistas en escritorio y móvil:
Suscripciones, Pagos familiar y Familia, además de un patrón de notificación,
un estado vacío y un formulario. En móvil se priorizan destinos con nombre
visible, sin depender de iconos ni de un menú oculto. Se presenta al propietario
y se espera aprobación antes de ejecutar el bloque 3, por instrucción de
`AGENTS.md` sobre rediseños importantes. Cambios de dirección posteriores
necesitan una propuesta visual actualizada antes de aplicarse.

## 4. Reglas para conservar el funcionamiento

1. Reutilizar `lib/api.ts` y `lib/session.ts`; tokens en memoria, cookie de refresh
   y coordinación existente. No crear un segundo proveedor global de sesión.
2. Conservar rutas, enlaces y parámetros `groupId`/`view`; validar el espacio
   contra membresías activas. Atrás/adelante y enlaces directos deben funcionar.
3. Mantener `hidden`, claves y estados de los paneles hasta comprobar su propósito.
   Un cambio de montaje no puede perder borradores del mismo contexto ni conservar
   datos de un grupo/rol anterior. No convertir la navegación en un cambio de rutas
   ni mover la lógica entre archivos dentro del mismo bloque visual.
4. Conservar recarga al entrar a cada vista, cancelaciones, descarte de respuestas
   antiguas y bloqueo de acciones pendientes. Una nueva envoltura visual no hará
   fetches duplicados ni activará nuevas escrituras.
5. Owner gestiona recursos según contratos actuales; miembro confirma su parte
   hasta la cuota prevista, owner puede superar la propia. Ninguno confirma por
   otra persona. No habilitar controles antes de conocer el permiso actual.
6. NUMERIC sigue como string y DATE como `YYYY-MM-DD`, sin cálculos flotantes ni
   desplazamiento horario. No anteponer un símbolo monetario no definido.
7. Mantener la diferencia entre importe propio y total familiar, leído y resuelto,
   y diferencia de importe y subida de precio. No afirmar cargos bancarios reales.
8. Transferir, retirar miembro, salir, omitir y eliminar conservan validaciones,
   confirmaciones y mensajes actuales. Se mejora su presentación sin cambiar reglas.
9. Código de invitación solo en memoria, una vez para el owner; nunca en URL,
   almacenamiento persistente, logs o capturas compartidas. Conservar aceptación,
   rechazo, expiración y errores sin enumerar cuentas.
10. Nada de SQL, migraciones, inicio del scheduler o generación global para probar
    el diseño. Pruebas de escritura solo con fixtures identificadas y autorizadas.

## 5. Bloques y puntos de parada

Bloques 1 a 9 implementados y comprobados según los registros anteriores.
Suscripciones ya fue revisada; Pagos personal/familiar queda en revisión visual
del propietario. Filas 10 a 18 pendientes.
Antes: explicar alcance, archivos y concepto.
Después: mostrar resultado, evidencia y límite, actualizar solo su checklist y
detenerse. Si una fila exige cambios grandes de lógica, dividirla antes de editar.

| Bloque | Entrega acotada y archivos principales | Criterio medible para aceptarlo |
|---|---|---|
| 1. Inventario y base | Revisar rutas/paneles, capturas y mapa de acciones; registrar en este plan | Cada acción vigente tiene destino y permiso; capturas reales de 390 y 1440 px o limitación documentada; frontend lint/TypeScript/build como base |
| 2. Propuesta visual | `frontend-designer`: mockups de Suscripciones, Pagos familiar y Familia, patrón de notificación, móvil, vacío y formulario; artefactos enlazados al plan | 6 colores base, tipografía, estados y jerarquía definidos; propietario aprueba propuesta concreta antes de código |
| 3. Fundamentos | Tokens delimitados en `globals.css` y pocos controles en `src/components/ui/` si hay reutilización real | Botón, campo, estado y foco coherentes en una muestra de la vista; landing idéntica; no nuevas dependencias |
| 4. Navegación y contexto | Contenedor presentacional compartido; cabecera del dashboard y enlace a Notificaciones; código dentro de Familia | Destino activo inequívoco; Notificaciones en una activación y código en dos (Familia y entrada) desde dashboard; grupo/rol identificables; enlaces antiguos y borradores conservados |
| 5. Consulta de suscripciones | Lista y jerarquía de datos en `dashboard/page.tsx` | Servicio, coste, frecuencia, fecha y estado distinguibles; una sola lista principal; consulta de miembro sin controles owner |
| 6. Alta y edición | Formulario bajo demanda y acciones de fila en `dashboard/page.tsx` | Abrir, cancelar, validar, guardar y error conservan comportamiento; borrador sobrevive al cambio de vista en el mismo contexto; un envío por acción |
| 7. Pagos personales | Presentación de `payments-panel.tsx` | Pendientes antes de historial; confirmar/omitir igual que antes; estado e importe claros sin columnas ilegibles en móvil |
| 8. Mis partes familiares | Secciones propias en `family-payments-panel.tsx` | Cuota prevista, importe registrado y estado propio separados del total; límite member y excepción owner preservados |
| 9. Pago del grupo y desglose | Resto de `family-payments-panel.tsx` | Progreso y participantes visibles al expandir; no duplicar una obligación como dos pagos; conserva pagos sin parte propia y sus permisos |
| 10. Familia y miembros | Lista, creación y consulta en `family-groups-panel.tsx` | Miembros/roles claros; estado sin familia permite crear o introducir código; una familia se selecciona sin mezclar sus datos con otra |
| 11. Administración familiar | Presentación de renombrar, transferir, retirar y salir en el mismo panel | Acciones peligrosas separadas; confirmaciones y bloqueos intactos; cambio de owner/baja refresca permisos y limpia contexto ajeno |
| 12. Invitaciones completas | `invitations-panel.tsx` y `/invitations/page.tsx`, mismo flujo owner/receptor | Acceso por navegación visible; crear/copiar/ocultar código, revisar, aceptar/rechazar y estados de código inválido/vencido/revocado; sin perder secreto ni incluirlo en URL |
| 13. Notificaciones | `/notifications/page.tsx` con contenedor y patrón de lista aprobado | Mensaje breve, tipo, lectura y obligación diferenciados; filtros, conteo y cargar más funcionan; enlace contextual válido y errores por fila conservados |
| 14. Acceso | Presentación de `/login/page.tsx` | Aspecto coherente y formulario claro; errores, envío, refresh y salida por sesión vencida siguen operativos; no crear otro flujo de autenticación |
| 15. Estados y textos | Ajustes puntuales sobre las vistas ya migradas | Cada carga/vacío/error ofrece información y recuperación útil; términos consistentes; no borrar datos ni borradores por fallo de red |
| 16. Móvil y teclado | Ajustes de composición, foco y controles en componentes/pantallas afectadas | Recorridos a 360, 390, 768 y 1440 px; zoom 200 %; sin desborde horizontal de página ni controles inaccesibles; navegación completa por teclado |
| 17. Regresión de flujos | Matriz de sección 6 con dos cuentas y revisión `reviewer` | Todos los flujos críticos pasan, sin acciones duplicadas ni acceso ajeno; problemas encontrados se resuelven antes del cierre |
| 18. Cierre | Comparación antes/después y evidencia en el plan | Checklist final completo, comprobaciones finales aprobadas y aceptación visual del propietario; registrar mejoras y límites reales |

Dependencia secuencial por defecto. Un archivo tiene un único escritor; no
trabajar en paralelo los bloques 5/6, 8/9 o 10/11. El diseñador presenta y realiza
los cambios visuales autorizados; el principal integra y explica. Después de un
cambio significativo, `reviewer` revisa regresiones, accesibilidad e integración
sin editar. Los subagentes no adelantan bloques ni delegan por su cuenta.

## 6. Comprobaciones y evidencia

### En cada bloque de implementación

- Captura antes/después con datos equivalentes, al menos escritorio y móvil de
  la pantalla tocada. Usar fixtures sin secretos; registrar qué se inspeccionó.
- Lint y TypeScript frontend; build si cambian estructura, imports, layout,
  rutas o APIs de Next. Leer antes la documentación local relevante en
  `frontend/node_modules/next/dist/docs/`, según `frontend/AGENTS.md`.
- Recorrido funcional de las acciones y estados afectados y revisión del diff
  para detectar cambios accidentales en handlers, payloads y permisos.
- Tras un cambio visual significativo, revisión `reviewer` antes de darlo por
  terminado. Un build correcto no demuestra que la vista se vea o funcione bien.

No instalar un framework de pruebas solo para esta fase. Usar navegador si está
disponible; si no, dejar la prueba visual pendiente y dar al propietario pasos
concretos para completarla. No marcarla aprobada por inspeccionar únicamente JSX.
Las pruebas automatizadas nuevas deben cubrir un riesgo concreto, como una
regresión de navegación o un cálculo existente, sin duplicar cadenas CSS.

### Matriz de regresión funcional

| Contexto | Recorrido y resultado que conservar |
|---|---|
| Sin sesión y sesión vencida | Login/refresh actual; no mostrar datos protegidos durante recuperación ni tras un 401 definitivo |
| Personal owner | Consultar, crear, cambiar coste/estado y eliminar suscripción; confirmar/omitir pagos; historial sin pérdida de datos |
| Familia owner/member | Consultar servicios; escritura solo owner; confirmar cuota propia y límites actuales; desglose y pagos sin parte propia |
| Familia administración | Crear/renombrar, invitar, aceptar/rechazar, transferir, retirar/salir; mantener bloqueos por obligaciones pendientes |
| Notificaciones | Solo propias; leer persiste por cuenta; conteo, filtros y páginas; acceso perdido oculta y reingreso restaura con lectura anterior |
| Navegación y borradores | Cambiar vistas recarga; atrás/adelante, enlaces directos y groupId inválido; mismo contexto conserva borradores, cambio de grupo/rol no filtra datos |
| Red lenta o caída | Estado de carga perceptible; reintento funcional; cancelación al cambiar contexto; ningún doble POST ni respuesta antigua sobrescribe el contexto actual |

Las escrituras del recorrido manual usan cuentas/familia/suscripción exclusivas
de prueba, no las suscripciones reales. Si se necesita generar un pago, preparar
primero la fixture y limitar el comando por su UUID; no iniciar un servidor con
scheduler global para hacer comprobaciones casuales. No limpiar datos ajenos.

### Criterios visuales comunes

- Un h1 por pantalla; títulos y nombres de controles consistentes y en español.
- Ubicación, espacio y rol se identifican sin abrir un formulario ni otro destino.
- Contraste medido: texto normal al menos 4.5:1; texto grande y controles 3:1.
  Foco visible, orden de tabulación lógico y estados con texto además de color.
- Controles táctiles de al menos 44 × 44 px; etiquetas asociadas a campos;
  errores asociados y avisos dinámicos anunciados sin duplicarse.
- Disclosure con `aria-expanded`; navegación con estado accesible. Evitar modales
  y menús complejos si un bloque en línea o enlaces visibles bastan. Si el diseño
  aprobado los necesita, incluir Escape, foco inicial, contención y retorno.
- Movimiento reducido respetado; ningún control oculto exclusivamente al hover.
- Nombres largos, listas vacías, múltiples grupos y cifras con decimales no rompen
  la composición. Estados e información importante no dependen de truncamientos.

En el cierre: `pnpm.cmd --dir frontend lint`, `pnpm.cmd --dir frontend exec tsc
--noEmit` y `pnpm.cmd --dir frontend build`. Backend typecheck/build y suite
`RUN_DB_TESTS=1 pnpm.cmd --dir backend test` como regresión final sobre esquemas
aislados; restaurar la variable tras su uso. Registrar conteos actuales, omisiones
y fallos. No reutilizar números de Fase 6 como si fueran una nueva ejecución.
Comprobar `git diff --check`; conservar archivos y cambios ajenos. No dejar
servidores, perfiles de navegador ni scripts temporales del recorrido.

## 7. Reversibilidad y control de alcance

- Cada bloque debe poder revisarse y revertirse de manera independiente con un
  diff pequeño. Sugerir un commit por bloque; no crearlo sin petición del usuario.
- Extraer un componente solo si elimina repetición real y mantiene claras sus
  props. No introducir un motor de formularios ni reescribir los paneles enteros.
- Tokens compartidos se activan gradualmente: revisar todas las vistas que los
  consumen. Separar modificaciones globales y reorganización de cada pantalla.
- Si una comprobación falla, corregir o revertir únicamente los cambios propios
  del bloque y repetir la prueba pertinente antes de avanzar. No usar resets ni
  restauraciones generales de archivos con trabajo ajeno.
- Aprobación visual y permisos de API son controles distintos: la apariencia no
  sustituye comprobaciones del servidor ni concede nuevas facultades.

## 8. Checklist final — pendiente

- [x] Inventario de código, comprobaciones base y capturas reales previas registrados.
- [x] Propuesta visual desktop/móvil aceptada por el propietario con ajustes de color y entrada de código en Familia.
- [x] Navegación y contexto de espacio en dashboard coherentes; introducir código fácil de encontrar. Integración visual de las otras rutas pendiente de sus bloques.
- [x] Suscripciones consultables sin formularios que compitan con la lista; revisada por el propietario.
- [x] Pagos personales y partes familiares claramente diferenciados; pendiente aceptación visual del propietario.
- [ ] Miembros, administración e invitaciones organizados según tarea y permiso.
- [ ] Notificaciones y login integrados en el mismo lenguaje visual.
- [ ] Sesión, borradores, recargas, enlaces y permisos conservados.
- [ ] Importes string, fechas DATE y límites de las listas conservados.
- [ ] Carga, vacío, error, móvil y teclado inspeccionados en navegador.
- [ ] Dos cuentas completaron los recorridos críticos con fixtures autorizadas.
- [ ] Revisión de cambios sin hallazgos pendientes; checks de cierre registrados.
- [ ] Landing, contratos backend y datos existentes conservados.
- [ ] Comparativa antes/después y aceptación visual del propietario registradas.
- [ ] Sin dependencias innecesarias, artefactos temporales ni trabajo de fases futuras.
