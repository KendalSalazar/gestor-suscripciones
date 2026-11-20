# Propuesta de diseño — Fase 8

Segunda propuesta para Inicio y Registro, preparada por el agente de diseño con
la skill frontend-design. El propietario aprobó la composición con el ajuste
del pie de la ilustración: ahora queda integrado dentro de la ventana de producto,
sin superposición ni tarjeta flotante.

Abre [propuesta.html](propuesta.html) directamente en Chrome o Edge. No necesita
servidor, conexión, paquetes ni una cuenta. Puedes entrar directamente al registro
con `propuesta.html#register`. Para ver los cambios, recarga el archivo si estaba
abierto en el navegador.

## Qué cambió respecto a la primera propuesta

La primera versión se limitaba a una introducción, tabla de servicios y tres
textos de capacidad. Esta revisión usa una composición más desarrollada: título
con carácter, muestra del producto con profundidad sutil y una sección editorial
con jerarquía propia. Las formas y la iconografía explican los espacios personal,
familiar y los avisos. No se añaden métricas, testimonios ni prestaciones ficticias.

En Inicio, el título «Todo lo que se repite. Todo bajo control.» y las acciones
aparecen junto a una ventana ilustrativa del producto. Sus botones Personal y
Familia cambian entre servicios propios y partes de un pago compartido. El aviso
ilustra los registros pendientes; su pie integrado explica la separación de
espacios. Todos los nombres, fechas e importes son de muestra y están rotulados.
La sección siguiente explica fechas, reparto y avisos mediante filas con iconos,
separadores y texto legible. El pie conserva la aclaración de pagos manuales.

Registro usa una composición asimétrica en escritorio: explicación y una
ilustración del espacio personal a la izquierda, formulario a la derecha. En
móvil se priorizan título y formulario, retirando la ilustración secundaria.
Nombre, correo, contraseña y confirmación mantienen una columna. Contraseñas
incluyen mostrar/ocultar; la ayuda refleja el límite de 8 a 72 caracteres.

La paleta conserva la identidad aprobada: marca #CF7FFF, acento/foco #78269E,
fondo #F3F6FA, texto #1D2B3A y secundario #526375. Los botones de marca usan texto
oscuro. No hay gradientes, fuentes descargadas ni imágenes externas. La maqueta
usa Segoe UI/Arial local; el producto seguirá usando Geist existente.

## Interacciones para revisar

1. Alternar Inicio y Registro con los controles grises de la parte superior.
   Esa barra pertenece a la revisión y no formará parte del producto.
2. En Inicio, pulsar Personal/Familia dentro de la muestra. La vista familiar
   distingue una parte confirmada y una pendiente; no permite registrar pagos.
3. Pulsar Crear cuenta para abrir Registro. Volver al inicio conserva la
   navegación local. Los enlaces de login abren una explicación del destino,
   porque la pantalla real de login ya existe y no se reproduce en esta maqueta.
4. En Registro, alternar Normal, Enviando y Error desde la barra gris. Enviando
   bloquea campos y botón; Error muestra el caso ficticio de correo duplicado.
   Normal permite volver a editar. Pulsar Crear cuenta solo activa la simulación
   Enviando: nunca llama a la API ni confirma una cuenta creada.
5. Probar Mostrar/Ocultar contraseña usando datos ficticios. No introducir
   credenciales reales: esta maqueta sirve exclusivamente para revisar diseño.
6. Revisar a 360, 390, 768 y 1440 px, con zoom 200 % y Tab. La composición cambia
   a una columna por debajo de 760 px; los elementos no dependen de animaciones.

El diálogo del destino login admite Escape y devuelve el foco al enlace que lo
abrió. Los mensajes de envío/error tienen semántica de estado/alerta. Los botones
indican la selección mediante aria-pressed. Las rutas son fragmentos locales;
no se serializan entradas del formulario en la URL ni se guardan en storage.

## Límites de esta entrega

No se modifican frontend de producto, backend, contratos HTTP ni datos. No hay
fetch, envío de formularios, almacenamiento persistente, cuentas creadas ni
conexión a una sesión. Los estados y las personas son ficticios. La gráfica de
espacio personal en Registro es una ilustración, no una carga real.

La inspección del código y estructura no sustituye la revisión en navegador.
Este agente no dispone de navegador conectado en esta entrega y no afirma haber
comprobado visualmente los anchos o la interacción. La aprobación fue concedida
por el propietario con el ajuste del pie. La inspección visual del producto real
sigue siendo una comprobación separada.
