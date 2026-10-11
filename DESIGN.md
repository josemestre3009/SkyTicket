# Design

Sistema visual de SkyTicket. Documenta lo construido en `views/`, `public/app.css` y `public/app.js`. Contrato para pantallas nuevas, no propuesta.

## Dirección fijada

**Apple Settings, tema claro permanente, densidad cómoda, sidebar vertical.** Decidido por el usuario; no es negociable. Sin dark mode, sin gradientes decorativos. Superficies blancas agrupadas sobre fondo `#F2F2F7`. La marca vive en detalles precisos (tipografía SF, hairline separators, acento azul accesible), no en decoración.

## Modo: Operate

Superficie de tarea: el usuario completa algo (alta de revendedor, autorizar paquete, emitir bono). Priman escaneabilidad, consistencia y expectativas nativas sobre la expresión. Coherente con los Product Principles de `PRODUCT.md`.

## Principios

1. **Una acción primaria por pantalla.** Un solo `btn--primary` visible; secundarias en `btn--secondary`, destructivas en `btn--danger`.
2. **Complejidad oculta hasta necesitarla.** Opciones no esenciales dentro de `<details class="advanced">`.
3. **Estados en lenguaje comercial.** `helpers.statusLabel` / `badgeClass` traducen el modelo interno a etiquetas y colores.
4. **Contenido sobre cromo, agrupado.** Listas y superficies blancas sobre fondo agrupado; sin sombras genéricas, sin gradientes. Separación por hairline (`--separator`).
5. **SSR + mejora progresiva.** Todo funciona sin JS; `public/app.js` solo añade comodidad (drawer, auto-submit, confirmaciones, spinner, revelado, copiar).

## Tokens

Definidos en `:root` (`public/app.css:1`). Tema claro único; `color-scheme: light`.

| Token | Valor | Uso |
| --- | --- | --- |
| `--bg` | `#f2f2f7` | Fondo agrupado de la app |
| `--surface` | `#ffffff` | Tarjetas, celdas, sidebar, topbar |
| `--surface-2` | `#f2f2f7` | Secundarios, hover de nav, campos |
| `--surface-3` | `#e9e9ef` | Badge neutral, separadores de superficie |
| `--text` | `#1c1c1e` | Texto principal |
| `--text-2` | `#6e6e73` | Texto secundario, etiquetas |
| `--muted` | `#8e8e93` | Metadatos terciarios |
| `--border` | `rgba(60,60,67,.14)` | Bordes de superficie |
| `--separator` | `rgba(60,60,67,.20)` | Hairlines de listas y tablas |
| `--accent` | `#0066cc` | Marca, enlaces, primario (accesible AA) |
| `--accent-strong` | `#0050a3` | Hover de primario |
| `--accent-soft` | `rgba(0,102,204,.12)` | Nav activa, filas seleccionadas |
| `--accent-contrast` | `#ffffff` | Texto sobre accent |
| `--ok` / `--warn` / `--danger` | `#1f7a3d` / `#91540a` / `#c7251e` | Semánticos (texto accesible) |
| `--focus` | `#0066cc` | Anillo de foco |
| `--radius` / `--radius-sm` | `12px` / `10px` | Tarjetas / controles |
| `--target` | `44px` | Altura táctil mínima |
| `--sidebar-w` | `260px` | Ancho del sidebar en escritorio |

Tipografías: pila SF (`-apple-system`, `BlinkMacSystemFont`, `"SF Pro Text"`, `"Segoe UI"`, `system-ui`, Roboto) para UI; `ui-monospace` para códigos. Base `16px`/`1.47`.

Reglas: usar tokens, nunca hex literales fuera de `:root`. Sin `box-shadow` para elevación; la jerarquía se logra con fondo agrupado + hairlines.

## Layout (app shell)

- `body.app` es el shell. `body.app--shell` (cuando hay `user`) usa grid: `260px` sidebar + `minmax(0,1fr)` contenido.
- **Escritorio (≥ 1024px):** `.sidebar` fijo (`sticky`, `height: 100vh`), marca + nav vertical + bloque usuario/salir al pie. `.topbar` oculta. `.scrim` oculta.
- **Móvil:** `.topbar` blanca sticky con toggle + marca; `.sidebar` off-canvas (`translateX(-100%)`, `.is-open`); `.scrim` con click para cerrar; `body.nav-open` bloquea scroll.
- **Sin JS:** `html.no-js` deja el sidebar estático y oculta toggle/scrim (fallback progresivo).
- `main.main` centra el contenido con `max-width: 900px`. Sin `user`, `main.main--bare` (login/error) no monta sidebar.

Patrones de página:

- `.page-head` + `.page-title` + `.muted` (encabezado, acción a la derecha).
- `.card` (+ `.card__head`, `.card__title`) para agrupar; `.section` + `.section__title` dentro de un detalle.
- `.split` (5fr/7fr ≥860px) para dos columnas formulario/lista.
- `.context-bar` para selectores de contexto (Revendedor → Sitio).
- `.breadcrumb` para jerarquía; `.metrics` para KPIs; `.grid-2` para pares.

## Componentes

- **Botones** `.btn`: `--primary`, `--secondary`, `--ghost`, `--danger`, `--block`. `data-loading` añade spinner (`.is-loading`) vía JS. Iconos SVG opcionales.
- **Badges** `.badge`: `--neutral`, `--ok`, `--warn`, `--danger`; siempre vía `helpers.badgeClass`.
- **Campos** `.field`: `label` + input/select/textarea a `--target`. `.field__control` para input con botón; `data-toggle-password`.
- **Formularios**: `.form` vertical; `.form--inline` horizontal; `<noscript>` con botón alterno cuando hay `data-auto-submit`.
- **Avanzado** `.advanced` (`<details>`): opciones y formularios secundarios.
- **Listas agrupadas**: `.reseller-list`/`.reseller-row`, `.row-list`/`.row-list__item`, `.package-rows`/`.package-row`, `.order-list`, `.movement-list`, `.voucher-list`, `.notification-list`. El contenedor es la superficie blanca redondeada; las filas se separan por hairline.
- **Catálogo revendedor**: `.package-grid` + `.package` (tarjeta con precio y CTA Emitir).
- **Detalle**: `.detail-list` (dl fila etiqueta/valor), `.timeline`.
- **Vouchers/códigos**: `.voucher-list`, `.code-block`, `data-reveal`/`data-copy`.
- **Alertas** `.alert`: `--ok`, `--warn`, `--error` (`role="alert"` para errores).
- **Skeleton** `.skeleton` para carga.
- **Iconos**: sprite SVG inline en `layout.ejs` (`#i-*`), trazo `currentColor`; nunca emoji/unicode.

## Copy

- Español directo y comercial; sin jerga Ruijie/ledger, con acentos correctos.
- Títulos de tarea en `.page-title`; una línea `.muted` explicando el "para qué".
- Estados vacíos accionables (`.empty`): dicen qué hacer.
- Botones = verbo de negocio ("Crear revendedor", "Autorizar", "Guardar precio", "Emitir").
- Advertencias de secretos explícitas.
- Documento `lang="es"`, marca "SkyTicket", panel B2B.

## Responsive

- Breakpoints: `1024px` (sidebar fijo), `860px` (`.split`), `760px` (`.grid-2`), `680px` (tablas responsivas), `640px` (`.package-row`, `.page-head__actions`), `480px` (`.reseller-row`).
- Tablas: `data-responsive` convierte filas en tarjetas usando `data-label` en cada `<td>`.
- Objetivos táctiles ≥ `--target` (44px). Sin desbordamiento horizontal: listas/filas colapsan acciones a ancho completo.

## Accesibilidad

- Skip link (`#main`), landmark `nav[aria-label="Principal"]`, `main#main`, `footer`.
- Drawer: `aria-expanded`/`aria-controls` en los toggles, focus trap mientras está abierto, cierre con Escape, click en scrim, resize a escritorio, bloqueo de scroll y restauración de foco.
- Foco visible global `:focus-visible` con `--focus`.
- `aria-current="page"` en nav activa; `aria-busy` en carga; `aria-pressed` en toggle de contraseña.
- `.sr-only` para etiquetas invisibles; `role="alert"` en errores.
- Contraste objetivo WCAG AA; `prefers-reduced-motion` desactiva animaciones; `color-scheme: light`.
- Flujos principales sin tablas horizontales en móvil.

## Reglas para pantallas nuevas

1. Elegir modo Operate; definir la única acción primaria antes de maquetar.
2. Reutilizar tokens y componentes existentes; no crear CSS ad-hoc ni nuevos colores.
3. Encabezado con `.page-head` (título + `.muted`), detalle con `.breadcrumb` cuando aplique.
4. Estado vacío siempre accionable; filtros con `.form--inline` + `data-auto-submit` + `<noscript>`.
5. Formularios con `csrfToken`, etiquetas `<label for>`, validación HTML y mensajes `.muted.small`.
6. Opciones no esenciales en `.advanced`; destructivas con `btn--danger` + `data-confirm`.
7. Nuevos enlaces de nav necesitan `icon` en `navFor` (`src/web/routes.js`) apuntando a un símbolo del sprite.
8. Añadir comportamiento en `public/app.js` solo como mejora progresiva; debe funcionar sin JS.
