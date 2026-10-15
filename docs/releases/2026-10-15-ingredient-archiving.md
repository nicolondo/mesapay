# Archivo de insumos — 15 de octubre de 2026

En Insumos, la vista inicial muestra sólo activos. Cada fila permite Archivar;
la pestaña Archivados permite consultar y Restaurar. Los insumos previamente
desactivados pasan a verse en esa misma pestaña. La operación conserva el ID,
las existencias, los movimientos y las referencias anteriores: no elimina datos
ni cambia si el insumo lleva inventario.

## Comportamiento

- Inventario oculta los archivados inicialmente. Si conservan existencias,
  ofrece Mostrar archivados y explica que los saldos siguen registrados.
  Los movimientos y conteos anteriores continúan visibles.
- Archivar retira la fila de la selección masiva. Cambiar entre Activos,
  Archivados y Todos limpia esa selección. Un fallo de red conserva la fila,
  muestra un error y permite reintentar la operación idempotente.
- Producción excluye los elaborados archivados del selector y los rechaza
  también en servidor. Se conservan los componentes archivados ya utilizados
  por recetas vigentes y su consumo de existencias.
- No se permiten nuevas asociaciones de proveedor con un insumo archivado.
  Las presentaciones anteriores siguen disponibles para consultar históricos.
- Una receta existente puede guardar cambios conservando sus componentes
  archivados. No puede agregar uno que no perteneciera ya a esa receta.
  Se valida también la pertenencia al comercio y los modificadores.
- PATCH y DELETE de insumos, producción, alta de presentaciones y escritura
  de recetas comparten el bloqueo transaccional de existencias por comercio.
  El DELETE sigue siendo archivo lógico, no eliminación física.
- Textos completos en español, inglés y portugués; acciones legibles en móvil.

## Validación

- 3.284 pruebas unitarias en 292 archivos.
- 22 pruebas específicas con PostgreSQL real: archivo/restauración,
  referencias existentes, aislamiento de comercio y carreras de escritura.
  La ejecución adicional de cobertura pasó 164 casos de integración y unidades.
- 14 E2E con autenticación y PostgreSQL locales: móvil WebKit y Chrome de
  escritorio, tres idiomas, persistencia tras recargar, conservación de saldos
  e historial, errores de red, permisos y selector de producción.
- Cobertura de las cuatro rutas/funciones de negocio evaluadas: 91,88 % de
  líneas, 76,69 % de ramas y 100 % de funciones. No es cobertura de toda la app.
- Lint sin errores (31 advertencias anteriores), compilación de producción
  y TypeScript correctos. Revisión independiente ECC sin bloqueadores.

No requiere migraciones. El despliegue no archiva insumos concretos de ningún
comercio; cada administrador elige cuáles archivar y puede restaurarlos.
