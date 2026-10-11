# Tasks

## 1. Base del proyecto y Docker

- [x] 1.1 Seleccionar y documentar el stack minimo del monolito modular conforme a `design.md`, crear la estructura web/API/worker y verificar que build, lint y prueba base finalicen correctamente.
- [x] 1.2 Crear imagen reproducible y `.dockerignore` que excluya `.env` y secretos; verificar mediante inspeccion de capas que valores de prueba no queden incorporados.
- [x] 1.3 Crear `docker-compose.yml` con `db`, `migrate`, `web` y `worker`, volumen PostgreSQL nombrado, puertos minimos y dependencias saludables; verificar arranque limpio con `docker compose up --build`.
- [x] 1.4 Implementar healthchecks de PostgreSQL y aplicacion, y verificar que web/worker no inicien trabajo antes de DB healthy y migraciones exitosas.
- [x] 1.5 Completar `.env.example` con nombres no ambiguos para token manual Ruijie, sesiones, cifrado, email y DB, sin credenciales privadas; documentar arranque, migraciones y diagnostico local, y verificar cada comando en un entorno vacio.

## 2. Esquema persistente y primitivas operativas

- [x] 2.1 Crear migraciones para identidad, tenancy, catalogo, precios, monederos, ledger, holds, ordenes, bonos, auditoria, jobs, conciliacion y notificaciones; verificar migracion adelante sobre DB vacia y restricciones FK/unique criticas.
- [x] 2.2 Implementar repositorio de jobs PostgreSQL con claim atomico, lease, reintentos limitados y `run_after`; verificar con prueba de integracion que dos workers no reclamen el mismo job y uno caido sea recuperable.
- [x] 2.3 Implementar cifrado autenticado versionado para secretos, tokens y codigos; verificar round-trip, deteccion de manipulacion, nonce unico y ausencia de plaintext persistido.
- [x] 2.4 Implementar auditoria append-only con actor, tenant, accion, entidad, antes/despues, motivo, fecha, IP, sesion, correlacion y resultado; verificar eventos obligatorios y redaccion de secretos/codigos.

## 3. Identidad y acceso

- [x] 3.1 Implementar usuarios, hashing de password, sesiones server-side revocables y cookies seguras; verificar login valido, credenciales invalidas, rotacion de sesion, logout y expiracion.
- [x] 3.2 Implementar roles Administrador/Revendedor y autorizacion backend; verificar que cada operacion administrativa rechace al Revendedor sin efectos laterales.
- [x] 3.3 Retirar el 2FA administrativo del MVP y verificar que el acceso administrativo y las operaciones privilegiadas se autoricen solo con contrasena, sin TOTP, recovery codes ni segundo factor.
- [x] 3.4 Implementar CSRF y rate limits persistidos para login, reveal y emision; verificar solicitudes sin token, fuerza bruta y recuperacion tras ventana.
- [x] 3.5 Crear bootstrap idempotente del Administrador usando `ADMIN_EMAIL` y secreto suministrado en ejecucion; documentarlo y verificar dos ejecuciones sin duplicados.

## 4. Revendedores, sitios y aislamiento

- [x] 4.1 Implementar ciclo `pending`, `active`, `suspended`, `restricted` y `closed` para revendedores COP; verificar acceso/emision de cada estado, revocacion al suspender e historial administrativo al cerrar.
- [x] 4.2 Implementar conexiones Ruijie, sitios y asignacion muchos-a-muchos revendedor-sitio; verificar dos revendedores en un sitio con datos comerciales aislados.
- [x] 4.3 Aplicar tenant desde sesion en servicios y consultas, sin confiar en `reseller_id` o `groupId` del cliente; verificar matriz cross-tenant de endpoints con 403 y cero llamadas Ruijie.
- [x] 4.4 Construir vistas responsive de administracion de revendedores y asignaciones; verificar desktop/mobile, navegacion por teclado, objetivos tactiles de al menos 44px y estados de error/carga.
- [x] 4.5 Crear revendedor, monedero y usuario de acceso atomicamente, y permitir agregar acceso a revendedores existentes; verificar rollback por email duplicado y login solo al activar.
- [x] 4.6 Permitir al Administrador eliminar de forma segura un revendedor mediante archivado, revocando sesiones y conservando historial financiero/auditoria.

## 5. Monedero y ledger

- [x] 5.1 Implementar ledger append-only y proyeccion disponible/reservado/total con COP entero; verificar que la suma reproducida coincida y que UPDATE/DELETE de aplicacion no existan.
- [x] 5.2 Implementar recargas y ajustes administrativos idempotentes con motivo, fecha efectiva y evidencia segun tipo; verificar referencia repetida, validacion de campos, reverso unico, auditoria y saldo nunca negativo.
- [x] 5.3 Implementar holds, captura, liberacion y liquidacion parcial con locks y constraints; verificar transiciones invalidas y repetidas sin dobles movimientos.
- [x] 5.4 Ejecutar pruebas concurrentes de reservas sobre PostgreSQL real; verificar que compras competidoras nunca excedan disponible ni produzcan saldo negativo.
- [x] 5.5 Implementar reconciliacion ledger-proyeccion y bloqueo ante diferencia; verificar deteccion, incidencia y ausencia de autocorreccion silenciosa.
- [x] 5.6 Construir vistas responsive de saldo, recargas y movimientos; verificar importes COP, trazabilidad, permisos y ausencia de acciones mutables para Revendedor.

## 6. Catalogo y precios

- [x] 6.1 Implementar almacenamiento/upsert de sitios y paquetes Ruijie con IDs largos como texto, JSON crudo y desactivacion no destructiva; verificar fixtures con cambios y recursos desaparecidos.
- [x] 6.2 Implementar permisos de paquete por revendedor/sitio; verificar que un paquete no autorizado no aparezca ni pueda comprarse por acceso directo.
- [x] 6.3 Implementar reglas de precio versionadas y precedencia revendedor+sitio, revendedor, sitio, base; verificar cada nivel, vigencias solapadas rechazadas y falta de precio.
- [x] 6.4 Implementar snapshot de precio COP en orden, sin impuestos ni precio al huesped; verificar que editar precios no altere ordenes existentes.
- [x] 6.5 Construir vistas responsive de catalogo, autorizacion y precios; verificar que Administrador pueda configurar y Revendedor solo vea ofertas vigentes propias.
- [x] 6.6 Conectar sincronizacion real de User Groups Ruijie por sitio, autorizar paquetes y mostrar solo paquetes con precio resoluble al Revendedor; verificar formatos reales y respuestas vacias.

## 7. Adaptador Ruijie y validacion contractual

- [x] 7.1 Implementar cliente HTTPS backend para token, refresh, cuenta, arbol de grupos, user groups, voucher create y getList, excluyendo `/webproxy/common/api`; verificar contratos con fixtures sanitizados.
- [x] 7.2 Implementar token persistente cifrado por conexion/region y lock de renovacion; verificar reutilizacion, codigo 3/4, una sola renovacion concurrente y redaccion total de URLs/logs.
- [x] 7.3 Implementar normalizacion defensiva de `authProfileId`, `expiryTime`, aliases de codigo/referencia/clientes y estados; verificar variantes documentadas sin perdida de precision.
- [x] 7.4 Implementar politica GET de tres intentos con backoff+jitter, 429 con `Retry-After` y errores no recuperables sin retry; verificar reloj simulado y conteo exacto de llamadas.
- [x] 7.5 Implementar sync paginado idempotente avanzando por cantidad recibida hasta `count` o lista vacia; verificar que una pagina parcial no corte la corrida, ademas de reproceso, UUID duplicado e interrupcion.
- [x] 7.6 Implementar circuito por conexion y degradacion a consultas locales; verificar apertura tras fallos, create rechazado antes de reserva, ausencia de tormenta y recuperacion controlada.
- [x] 7.6.1 Implementar inventario Ruijie de solo lectura con sincronizacion de sitios, paginacion de bonos, estados normalizados y codigos enmascarados; verificar contra fixtures y cuenta configurada.
- [ ] 7.7 Ejecutar checklist sandbox: host, permisos, token, create, parcialidad, timeout, paginacion, aliases, unidades, rate limit y codigo 25; registrar evidencia y mantener emision real deshabilitada ante cualquier contrato critico no confirmado.
- [ ] 7.8 Documentar contratos confirmados y actualizar artefactos OpenSpec si contradicen requisitos o diseno; verificar revision aprobada antes de habilitar emisiones reales.

## 8. Ordenes y emision

- [x] 8.1 Implementar maquina de estados de orden y eventos idempotentes; verificar todas las transiciones permitidas y rechazo de saltos o repeticiones invalidas.
- [x] 8.2 Implementar creacion de orden con referencia unica, sitio/paquete autorizados, cantidad 1-100 y snapshot; verificar replay compatible devuelve la misma orden y replay incompatible falla.
- [x] 8.3 Implementar flujo reservar, persistir intencion, llamar create una vez, guardar bonos y capturar; verificar orden temporal y atomicidad con spies y fallos inyectados.
- [x] 8.4 Implementar `needs_reconciliation` para timeout, codigos 3/4/7/25, respuesta parcial no validada y fallo local posterior a posible emision; verificar que ningun caso ambiguo repita create, capture o libere saldo.
- [x] 8.5 Implementar almacenamiento cifrado, listado enmascarado y reveal/copiar auditado; verificar autorizacion, redaccion de logs y ausencia de ticket, CSV, QR, email y WhatsApp.
- [x] 8.6 Construir flujo responsive de compra e historial; verificar mobile sin tabla horizontal, formulario preservado ante error, estados de carga y accesibilidad de copiar/revelar.
- [x] 8.7 Implementar pruebas end-to-end de emision exitosa, saldo insuficiente, replay, concurrencia, fallo confirmado e incertidumbre usando Ruijie simulado y PostgreSQL real.

## 9. Conciliacion y recuperacion

- [x] 9.1 Implementar deteccion worker de reservas vencidas y ordenes estancadas con umbrales configurables; verificar que solo fallos confirmados liberen saldo.
- [x] 9.2 Implementar conciliacion de bonos por UUID y referencias disponibles, clasificando faltantes, externos y cambios; verificar fixtures paginados sin atribucion cross-tenant.
- [ ] 9.3 Tras validar parcialidad en sandbox, implementar resolucion administrativa de emision parcial basada en evidencia; verificar reserva intacta antes de resolver, captura/liberacion exacta por unidad y replay seguro.
- [x] 9.4 Mantener la conciliacion como proceso automatico interno sin bandeja ni casos visibles en el MVP; exponer resolucion solo por el servicio con motivo/evidencia; verificar auditoria y que no pueda duplicar captura o reverso.
- [x] 9.5 Implementar metricas operativas, comerciales y de riesgo aprobadas, incluyendo emisiones, exito, latencia, ingresos, ventas, saldo circulante, accesos cruzados y diferencias; verificar agregados contra dataset conocido sin exponer codigos.
- [x] 9.6 Construir dashboard administrativo de negocio con ventas emitidas, recargas, saldo pendiente, tasa de exito y gasto por revendedor para los ultimos 30 dias.

## 10. Notificaciones y operacion

- [x] 10.1 Implementar notificaciones deduplicadas con matriz email-only para saldo bajo, recarga, emision incierta, suspension y fallo sync; verificar tipo+recurso+ventana, canales y destinatarios exactos. La emision completada no genera aviso en el MVP.
- [x] 10.2 Implementar entrega email asincrona con estado e intentos limitados; verificar que fallo/replay no revierta negocio ni duplique el evento.
- [x] 10.3 Retirar consulta, lectura y centro de avisos visible del MVP; verificar rutas 404 y ausencia en navegacion/dashboard.
- [x] 10.4 Mantener notificaciones solo como soporte interno de entrega email, sin enlaces ni contadores visibles.
- [x] 10.5 Construir dashboard, listado administrativo de ordenes/bonos, auditoria y configuracion; verificar filtros, permisos, metricas, detalle y trazabilidad en desktop/mobile.
- [x] 10.6 Documentar runbooks de fallo Ruijie, orden incierta, discrepancia de ledger, rotacion de claves y recuperacion de Administrador; verificar pasos en entorno local con datos de prueba.
- [x] 10.7 Permitir agregar saldo desde el dashboard usando el correo del Revendedor, resolviendo el tenant en backend y verificando CSRF, idempotencia y auditoria.

## 11. Validacion integrada del piloto

- [x] 11.1 Ejecutar suite completa en Docker desde DB vacia y verificar build, migraciones, pruebas unitarias, integracion, HTTP, concurrencia y end-to-end sin servicios instalados en host.
- [x] 11.2 Verificar criterios de seguridad: secretos fuera de imagen/logs/frontend, codigos cifrados/enmascarados, CSRF, rate limits y aislamiento cross-tenant.
- [x] 11.3 Ejecutar prueba de volumen superior a 200 emisiones diarias simuladas y jobs simultaneos; verificar ausencia de duplicados, saldo negativo, leases perdidos y atraso inaceptable.
- [ ] 11.4 Ejecutar aceptacion manual responsive para Administrador y Revendedor sobre desktop y movil; verificar dashboard, onboarding, saldo, catalogo, compra, copiar codigo, historial, ordenes/bonos, auditoria y configuracion (sin bandeja de conciliacion: es interna en el MVP).
- [ ] 11.5 Confirmar puerta de lanzamiento: checklist sandbox cerrado, credenciales rotadas, backups probados, healthchecks sanos, administrador creado y dos revendedores piloto configurados; documentar resultado antes de activar create real.
