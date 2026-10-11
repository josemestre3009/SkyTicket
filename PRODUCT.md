# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Administrador de SkyTicket: configura revendedores, sitios, catalogo, precios y saldos desde escritorio o movil.
- Revendedor: consulta saldo, compra bonos autorizados y revisa su historial desde una interfaz simple, frecuentemente movil.

## Product Purpose

SkyTicket permite vender bonos Wi-Fi de Ruijie Cloud mediante revendedores con saldo prepago, aislamiento por revendedor y trazabilidad financiera. El MVP debe hacer comprensibles las tareas comerciales sin exponer la complejidad tecnica de Ruijie ni del ledger.

## Positioning

SkyTicket separa la operacion comercial local de la infraestructura Ruijie: el administrador controla accesos, catalogo, precios y saldo; Ruijie conserva la autoridad sobre redes, paquetes y bonos.

## Operating Context

- El administrador crea revendedores con usuario y contraseña inicial.
- Los sitios y paquetes se sincronizan desde Ruijie.
- El administrador asigna sitios, autoriza paquetes y fija precios COP.
- El revendedor opera con saldo prepago y solo ve su catalogo autorizado.
- La emision real permanece deshabilitada hasta aprobar la validacion contractual de Ruijie.

## Capabilities and Constraints

- Moneda COP sin centavos, sin credito ni impuestos en el piloto.
- Varios revendedores pueden compartir un sitio, manteniendo aislamiento comercial.
- Los codigos de bonos son credenciales: cifrados, enmascarados y auditados.
- Docker Compose, PostgreSQL, web/API y worker; sin Redis.
- Conciliacion y recuperacion incierta permanecen internas, sin bandeja visible en el MVP.
- El alta rapida de revendedores es la tarea principal de su pantalla.
- La alerta de saldo bajo es opcional y se configura como opcion avanzada.
- El catalogo administrativo sigue el contexto Revendedor → Sitio → Paquetes.

## Brand Commitments

- Nombre: SkyTicket.
- Voz: directa, comercial y en español; evitar terminología técnica cuando exista una expresión operativa clara.
- Interfaz minimalista orientada a completar tareas, no a mostrar el modelo interno.
- Sistema visual fijado por decisión del usuario: **Apple Settings, tema claro permanente, densidad cómoda, sidebar vertical**. Superficies blancas agrupadas sobre `#F2F2F7`, acento `#0066CC`. No introducir dark mode ni gradientes decorativos.

## Evidence on Hand

- Documentacion funcional y de integracion en `Doc/`.
- Datos reales sincronizados desde la cuenta Ruijie configurada.
- Interfaz SSR existente en `views/` y sistema visual en `public/app.css`.

## Product Principles

1. Una tarea principal evidente por pantalla.
2. Complejidad tecnica oculta hasta que sea necesaria.
3. Estados y acciones expresados en lenguaje comercial.
4. Seguridad financiera invisible pero siempre activa.
5. Misma claridad en escritorio y movil.

## Accessibility & Inclusion

Navegacion por teclado, foco visible, objetivos tactiles de al menos 44 px, contraste WCAG AA y flujos principales utilizables sin tablas horizontales en movil.
