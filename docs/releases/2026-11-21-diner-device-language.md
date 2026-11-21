# Idioma del comensal al abrir el QR

La carta usa la elección de idioma guardada por el visitante. Si aún no eligió uno, usa el idioma principal comunicado por el navegador: español, inglés o portugués, incluidas sus variantes regionales. Cuando el principal no está disponible, abre en español aunque el navegador incluya inglés o portugués como preferencias secundarias.

La elección manual conserva la cookie existente `MESAPAY_LOCALE`, válida durante un año para las rutas del mismo origen. La detección automática no escribe esa preferencia, de modo que un visitante sin elección manual puede seguir el idioma del dispositivo en su próxima visita. La selección se resuelve en el servidor desde el primer HTML, incluido el regreso del acceso de invitado del QR.

El cambio se limita al resolvedor compartido `matchLocale`: prioriza los valores `q` válidos mayores que cero, conserva el orden en empates y valida los códigos antes de seleccionar el catálogo. La regla también se aplica a las otras pantallas cuando no existe una elección guardada. No necesita migraciones ni nuevas dependencias.

Validación: regresión reproducida antes de corregirla; 57 pruebas focales y 8.189 generales aprobadas, cobertura del 100% de líneas, ramas y funciones en detección, resolución de petición y persistencia. Compilación y TypeScript correctos; lint sin errores y con 30 avisos previos. Pruebas de navegador sobre la compilación local verifican los QR en Chrome y WebKit móvil, contenido traducido, idioma no disponible y última elección al recargar, abrir otra mesa y restaurar una sesión del navegador. Los datos usados son ficticios y se eliminan al terminar.
