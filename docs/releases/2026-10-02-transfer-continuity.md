# Traslados sin volver a marchar platos

El traslado individual crea una ronda en la mesa destino. Los tableros
usaban el ID de esa ronda para reconocer pedidos nuevos y su fecha recibía
el valor predeterminado actual. También se reiniciaba la hora de listo.
Eso producía un aviso de nueva comanda y hacía parecer recientes productos
que ya estaban en preparación o en el pase.

La detección de novedades de cocina y bar ahora usa el ID estable de cada
producto. Cambiarlo de mesa o ronda no vuelve a anunciarlo; un producto
nuevo sigue produciendo aviso, incluso dentro de una ronda existente.

La nueva ronda conserva fecha y autor del envío original y los tiempos
conocidos de preparación/listo. Los sellos desconocidos permanecen nulos.
El producto conserva su estado, inicio de preparación, historial de
preparación y entrega; los platos servidos no regresan al tablero.
La identidad de las rondas tampoco cambia al trasladar una cuenta completa.

No requiere migraciones ni cambios en datos existentes. Se mantienen las
comprobaciones de permisos, sección, pagos y bloqueo de órdenes.

La regresión se reproduce con pruebas de UI y de PostgreSQL local: traslado
repetido de pendientes, preparados, listos y servidos, sin nueva impresión,
sin cambiar importes ni reiniciar los tiempos de cocina/bar. Las pruebas
del componente también exigen que los nuevos productos sí se anuncien.

Verificación: 3.140 pruebas unitarias, 41 PostgreSQL (7 de esta regresión
y 34 de permisos/concurrencia/finanzas) y dos pruebas de navegador sobre
la compilación de producción. Las regresiones fallaron antes del arreglo.
TypeScript, compilación y revisión independiente aprobados; ESLint sin
errores nuevos. Los módulos de estado y sonido tienen 97,52% de cobertura
de líneas y 91,93% de ramas. El navegador usa audio simulado para verificar
la programación de pitidos; API, eventos y base de datos son reales locales.

Esta corrección forma parte de la versión conjunta `9d3a2aa0`. El propietario
confirmó expresamente el alcance completo para su publicación, incluidas
las mejoras anteriores y este arreglo. No se hicieron traslados ni cambios
de pedidos reales para verificarla.
