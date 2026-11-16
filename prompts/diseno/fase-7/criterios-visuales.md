# Propuesta visual de Fase 7

Fecha: 15 de noviembre de 2026. Estado: propuesta para aprobación; no aplicada al producto.

Abrir [propuesta.html](propuesta.html) directamente en un navegador. No necesita
servidor, red, dependencias ni cuentas. Sus datos son ficticios. La barra superior
gris permite cambiar responsable/miembro y mostrar estados vacíos: son controles
de revisión de la maqueta, no funciones propuestas para la aplicación.

Escenarios directos para capturas: `propuesta.html#subscriptions`, `#payments`,
`#family`, `#notifications`, `#form` (alta abierta), `#empty` (Suscripciones vacía),
`#payments-member`, `#family-member` y `#notifications-read`. El fragmento solo
selecciona un escenario local y no contiene información de una cuenta real.

## Dirección y revisión del encargo

Una agenda de servicios compartidos: leer servicio, fecha y compromiso propio
en un orden constante. La propuesta cambia el peso de la información antes de
añadir decoración. Se descartó un mosaico de métricas y tarjetas equivalentes
porque repetiría el problema de secciones que compiten por atención. La lista
queda en primer plano y los formularios se abren cuando la persona los necesita.

El rasgo visual principal es el acento verde petróleo en selección, confirmación
y fechas. El resto se apoya en filas, separación y tipografía. No hay gradientes,
fotografías, gráficos ficticios ni animaciones automáticas. Las iniciales de los
servicios y personas son datos de demostración, no logotipos de proveedores.

## Tokens iniciales

| Uso | Valor |
|---|---|
| Fondo | `#F3F6FA` |
| Superficie | `#FFFFFF` |
| Texto principal | `#1D2B3A` |
| Texto secundario | `#526375` |
| Líneas | `#D6DFE8` |
| Acción y foco | `#006B75` |

Apoyos semánticos: selección `#E5F3F3`, éxito `#236546`, aviso `#76500C`,
error/peligro `#A12732`. Estado siempre con palabras, además de color. Los bordes
de campos son más oscuros (`#8295A7`) que los separadores decorativos para que los
controles sigan siendo identificables. Ratios calculados con luminancia relativa
sRGB, sin transparencia: texto principal/blanco 14.39:1, secundario/blanco 6.18:1,
blanco/acento 6.25:1, acento/fondo 5.77:1 y borde de campo/blanco 3.09:1.
Éxito/blanco 6.95:1, aviso/blanco 7.18:1 y peligro/blanco 7.36:1.
Son cálculos de pares de tokens; no sustituyen inspeccionar todos los estados
y colores compuestos reales al renderizar.

Geist si está instalada localmente, después Segoe UI/Arial/sans-serif. El HTML
no descarga fuentes. En el producto se puede reutilizar Geist ya cargada sin
introducir otra dependencia. Escala de referencia: título 32 px (28 móvil),
sección 20 px, cuerpo 15–16 px y apoyo 14 px; cifras con `tabular-nums`.
Espaciado regular de 4/8/12/16/20/24/32/48 px. Radio de 6 px en controles y
10 px en superficies principales. La lista no se divide en tarjetas por registro.

## Estructura propuesta

En escritorio, navegación lateral estable y área de trabajo amplia. Contexto de
espacio/rol sobre el contenido, separado de los destinos de navegación. Una
acción principal por vista. En móvil, destinos con nombre visible en dos columnas,
selector después de navegación, filas reorganizadas sin tablas que desborden.

- **Suscripciones:** servicio/proveedor/frecuencia, fecha, coste, estado.
  Alta bajo demanda. Las acciones de administración se agrupan en un disclosure.
  «Cambiar coste» conserva la capacidad real; no se promete edición general.
- **Pagos familiares:** «Tu confirmación pendiente» antes del historial.
  Cuota propia, importe registrado y estado de parte separados del total previsto,
  confirmado y estado del grupo. Reparto bajo expansión; no sumar listas parciales.
- **Familia:** miembros primero, invitar para responsable, entrada con código
  siempre localizable. Gestión de nombre/propiedad/miembros en administración
  secundaria. Para miembro, salida separada con contexto de obligaciones.
- **Notificaciones:** nombre de servicio primero; evento y estado de lectura
  distinguibles. El aviso conserva el contexto y el enlace al pago. Filtro de
  espacios propio del centro, independiente del selector de trabajo del dashboard.
- **Invitación:** acceso directo visible. Solo se representa la entrada del código;
  revisión/aceptación/rechazo reales conservarán la página y contrato actuales.

La vista de miembro oculta acciones exclusivas de responsable, conservando la
confirmación de su propia parte. El selector de rol de la barra de revisión
cambia entre Alex y Sam; en la aplicación ese rol vendrá de las membresías.

## Interacciones incluidas y límites

La navegación, el estado vacío, la apertura/cancelación del alta, expansión del
reparto y las lecturas de notificaciones funcionan en memoria. Marcar leído en la
vista de Alex no marca el aviso en la vista de Sam. Recargar el archivo reinicia
la demostración. No hay fetch, SQL, almacenamiento persistente, tokens ni códigos
de invitación reales. Los botones de mutación muestran feedback de simulación.

El selector de espacio muestra Personal para señalar su ubicación futura, pero
esta maqueta solo desarrolla el contexto familiar: elegir Personal explica ese
límite y retorna al contexto familiar. Los pagos personales, login, historial
de invitaciones completo, errores de red y estados de carga no están simulados.
Se aplicarán por sus bloques posteriores conservando la lógica actual.

## Recorrido para revisar

1. A 1440 px, consultar Suscripciones; abrir alta, llenar datos ficticios y
   cancelar. La consulta debe seguir siendo la parte principal de la pantalla.
2. Visitar Pagos y expandir reparto: distinguir cuota propia de 5.00 y total de
   10.00 sin interpretarlos como dos pagos. Probar el formulario propio.
3. Cambiar a Miembro: desaparecen alta y administración owner; confirmar una
   cifra superior a 5.00 muestra límite. La maqueta no ejecuta confirmaciones.
4. En Familia, localizar miembros, rol y entrada con código sin depender de
   permisos owner. Las acciones sensibles tienen un nivel secundario.
5. En Notificaciones, marcar un aviso leído. Cambiar al otro rol y comprobar
   que sigue sin leer. Filtrar por lectura y por Personal para ver vacío filtrado.
6. Activar «Mostrar estado vacío» en las cuatro vistas, con ambos roles.
7. Repetir a 390 px, con teclado y zoom; revisar nombres largos y foco visible.

La maqueta incluye un `h1` por vista visible, etiquetas de campos, botones de
44 px, foco, mensajes `role=status`, `aria-current` y `aria-expanded` para los
formularios propios. Los disclosures nativos conservan su semántica de expansión.
La acción de lectura devuelve el foco a un control visible: enlace al pago si
la fila permanece o filtro de lectura si desaparece. Cambiar la identidad de
demostración reinicia el formulario de confirmación y su estado accesible.
La inspección visual y el comportamiento real en navegador se registran aparte
por el principal; no se afirman comprobados por escribir este HTML.

## Implementación posterior a aprobación

La propuesta orienta composición y jerarquía, no sustituye componentes ni hooks.
Conservar rutas, API/sesión actuales, `hidden`, claves de grupo/owner/rol,
cancelaciones, recargas, límites de listas y borradores. El contenedor compartido
será presentacional. Backend y contratos quedan fuera de estos cambios.

Antes del bloque 3: aprobación de esta dirección y capturas base autenticadas
pendientes del bloque 1. Las capturas de esta maqueta no reemplazan la evidencia
del producto antes de modificarlo. El diseñador no tomó capturas ni inició
servidores para preparar estos dos archivos.
