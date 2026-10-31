# Contenido del centro de ayuda

Aquí vive el contenido de la ayuda de MESAPAY (`/operator/ayuda` y, para los
meseros, `/mesero/ayuda`). La interfaz del centro de ayuda (botones, títulos,
mensajes del buscador) va por i18n, en el namespace `help` de
`messages/{es,en,pt}.json`. Los **artículos** viven en esta carpeta y NO en
los catálogos: los catálogos se mandan enteros a todas las páginas, y los
artículos solo los necesita la ayuda.

El español es la fuente de verdad; inglés y portugués van completos.

## Archivos

| Archivo | Qué es | ¿Quién lo toca? |
|---|---|---|
| `categories.ts` | Orden, id e ícono de las 11 categorías. Los ids son definitivos. | Nadie (etapa 1). |
| `outline.ts` | Índice de TODOS los artículos planeados: slug, título de trabajo y qué cubrir. | Cada redactor, solo el bloque de su categoría. |
| `coverage.ts` | Cada pantalla (`page.tsx`) → los artículos que la explican, o `internal` con motivo. | Cada redactor, solo las líneas de sus pantallas. |
| `{es,en,pt}/<categoria>.json` | El contenido. Un archivo por categoría y por idioma. | El redactor de esa categoría. |
| `registry.ts` | Importa los 33 JSON. Ya están todos: no hay que tocarlo. | Nadie. |
| `types.ts` | Tipos del contenido. | Nadie. |
| `help.test.ts` | Los guardarraíles que corren en la CI (ver abajo). | Nadie. |

Los artículos con piezas que el markdown no permite (hoy, el botón de
descarga del agente de impresión) las agrega el código en
`src/components/help/articleExtras.tsx`.

## Forma de cada `<idioma>/<categoria>.json`

```json
{
  "title": "Cobro y caja",
  "description": "Una línea que dice qué hay en la categoría.",
  "articles": [
    {
      "slug": "abrir-y-cerrar-el-turno",
      "title": "Abre y cierra el turno del día",
      "summary": "Una o dos frases (máximo 260 caracteres).",
      "keywords": ["cierre de caja", "arqueo", "turno", "…"],
      "audience": ["operator"],
      "body": "markdown reducido",
      "links": [{ "label": "Ir a Cierre", "href": "/operator/reports" }],
      "updated": "2026-10-31"
    }
  ]
}
```

- **Una categoría con `"articles": []` está pendiente** y no se muestra.
  Cuando tenga artículos, tiene que tener **exactamente** los slugs que el
  outline le asigna, **en el mismo orden**, en los tres idiomas.
- `slug`: el del outline, en español y en kebab-case. Es igual en los tres
  idiomas y único en toda la ayuda.
- `title`: lo que la persona quiere lograr, en imperativo y con "tú":
  "Abre y cierra el turno del día", no "Turnos".
- `summary`: sale en las listas y en los resultados del buscador.
- `keywords`: al menos 3. Sinónimos y palabras que la gente escribe al
  buscar, incluidas las que NO aparecen en el texto ("datafono", "plata",
  "arqueo", "voucher"). Sin tildes ni mayúsculas no hace falta: el buscador
  normaliza.
- `audience` ⊆ `operator`, `mesero`, `cocina`, `comensal`, `admin`. Los
  artículos con `mesero` aparecen también en la ayuda de la app del mesero,
  donde **solo** quedan como enlace los `href` que empiezan con `/mesero`.
- `links`: accesos "Ir a…" al final del artículo. Solo rutas internas que
  empiezan con `/`. Puede haber ancla o consulta (`/operator/contabilidad?tab=chart`).
- `updated`: fecha ISO de cuando revisaste el artículo contra el producto.
  No puede ser futura.

## Markdown reducido del `body`

El renderizador es propio y seguro (no hay HTML: todo sale como texto). Solo
entiende esto:

| Escribes | Sale |
|---|---|
| Líneas seguidas, separadas por una línea en blanco | Párrafos |
| `## Subtítulo` | Subtítulo (entra en el índice "En este artículo") |
| `### Subtítulo` | Subtítulo menor |
| `- punto` | Lista con viñetas |
| `1. paso` | Pasos numerados |
| `**Guardar**` | Negrita: nombres de botones, menús y pantallas |
| `` `RESTAURAR` `` | Texto para escribir tal cual |
| ```` ``` ```` (bloque) | Comandos (p. ej. de Windows), con botón "Copiar" |
| `[Usuarios](/operator/settings/usuarios)` | Enlace interno |
| `> texto` | Aviso de consejo |
| `> ⚠ texto` | Aviso de advertencia |

- No se puede: `#` (título de nivel 1), `####`, `*` o `+` como viñeta, HTML,
  enlaces externos (`http…`, `mailto:`), listas anidadas.
- Un punto de lista largo se puede seguir en la línea siguiente si empieza
  con dos espacios.
- **Enlaces a otros artículos**: `/operator/ayuda/<categoria>/<slug>`. Solo a
  artículos que ya tienen contenido en ese idioma (el test lo exige). En la
  etapa 2, enlaza a tu propia categoría y a `primeros-pasos` o
  `impresion-y-equipos`, que ya están publicadas.
- En JSON, los saltos de línea del `body` se escriben `\n`. Más cómodo:
  escribe el artículo en un `.md` aparte y conviértelo con un script.

## Estilo de los artículos

- **Español neutro y claro**, para un dueño de restaurante. **Sin voseo**:
  "tú" o impersonal ("toca", "escribe", "se guarda"; nunca "tocá",
  "escribí", "podés"). El test revisa el español fuera de las negritas.
- **Arranca con para qué sirve**: el primer bloque es un párrafo de una o dos
  frases (el test lo exige).
- Después, **los pasos numerados**, con los **nombres exactos** de botones,
  menús y pantallas, en negrita, tal como aparecen en la interfaz. Sácalos de
  `messages/es.json` (y de `en.json` / `pt.json` para las otras versiones),
  no de memoria. Si una etiqueta de la interfaz tiene voseo, se cita igual,
  en negrita.
- Al final, **casos frecuentes y errores**, cada uno con qué hacer. Cita el
  mensaje que ve la persona.
- **Nada de jerga técnica** ni nombres de archivos, componentes, rutas de
  código, módulos internos o tablas. "Configuración › Usuarios", no
  `/operator/settings/usuarios` en el texto (la ruta va en el enlace).
- **Nunca inventar funciones.** Si algo no existe en el código, no se
  describe. Si una función depende de algo que activa MESAPAY (módulos,
  medios de pago, modo de servicio), dilo: "Si no la ves, escríbenos a
  soporte".
- Un artículo = una tarea. Entre 250 y 700 palabras suele bastar: el índice
  del buscador lleva el texto completo de todos los artículos.
- **Inglés y portugués**: la misma información, con las etiquetas de
  `messages/en.json` y `messages/pt.json`. Si una pantalla todavía está solo
  en español (p. ej. las pestañas de la app del mesero, o la página del
  programa de impresión), cita el texto en español y pon la traducción entre
  paréntesis: **Salir** (sign out).

## Lo que revisa la CI (`help.test.ts`)

- Toda pantalla de `src/app/operator`, `src/app/mesero`, `src/app/t/[slug]`,
  `src/app/r`, `src/app/p` y `src/app/terminal` está en `coverage.ts`: una
  pantalla nueva sin ayuda rompe la CI hasta que alguien la mapee.
- Todo slug del mapa existe en el outline; los slugs son únicos.
- Los tres idiomas tienen los mismos archivos, las mismas categorías y los
  mismos slugs, en el mismo orden.
- Una categoría con artículos tiene exactamente los del outline.
- Cada artículo tiene todos sus campos y un markdown válido; el español no
  tiene voseo.
- Todo `links[].href` y todo enlace del markdown lleva a una ruta que existe
  en `src/app` (los segmentos dinámicos se resuelven), y los enlaces a otros
  artículos llevan a artículos publicados.

Correr: `npx vitest run src/content/help src/lib/help`.

## Etapa 2: cómo escribir una categoría

Cada redactor toma categorías enteras y solo toca **sus** archivos:
`src/content/help/{es,en,pt}/<su-categoria>.json`, más (si hace falta) el
bloque de su categoría en `outline.ts` y las líneas de sus pantallas en
`coverage.ts`. Los bloques están separados para que git combine sin
conflictos. Reparto sugerido (el mismo con el que se armó el outline):

1. `salon-y-pedidos` + `cobro-y-caja`
2. `app-del-mesero` + `experiencia-del-comensal`
3. `carta-y-produccion` + `facturacion`
4. `contabilidad-y-reportes` + `equipo-y-nomina` + `pagos-en-linea`

Para cada artículo:

1. Lee su entrada en `outline.ts` (`covers` dice qué cubrir; `legacy` trae
   el texto de la guía rápida anterior, si había) y busca en `coverage.ts`
   qué pantallas explica.
2. Lee el código de esas pantallas y sus etiquetas en `messages/es.json`.
   Verifica cada regla (permisos, módulos, límites, errores) en el código.
3. Escribe el español. Después inglés y portugués, con las etiquetas de sus
   catálogos.
4. Si descubres que falta un artículo o que uno sobra, ajusta el bloque de tu
   categoría en el outline (y el mapa de cobertura) en el mismo cambio.
5. Corre los tests y `npx eslint src/content/help`.

Una categoría se publica entera (los tres idiomas y todos sus slugs) o queda
con `"articles": []`.
