# Proposal

## Why

SkyTicket necesita un panel B2B para que revendedores autorizados compren y emitan bonos Wi-Fi de Ruijie Cloud sin compartir credenciales ni datos entre tenants. El piloto debe proteger el saldo prepago y tolerar respuestas inciertas de Ruijie antes de operar con 2 revendedores iniciales, crecer hasta 20 y soportar aproximadamente 200 emisiones diarias.

## What Changes

- Incorporar autenticacion propia, roles Administrador y Revendedor, sesiones revocables y aislamiento estricto por revendedor y sitio.
- Administrar revendedores, usuarios de acceso, estados, monedas COP sin centavos y asignaciones muchos-a-muchos entre revendedores y sitios Ruijie.
- Incorporar monederos prepagados sin credito, ledger inmutable, recargas y ajustes manuales, reservas, capturas, liberaciones y reversos idempotentes.
- Sincronizar sitios, paquetes y el inventario remoto de bonos creado en Ruijie; permitir al administrador consultar estados y autorizar catalogo y precios mayoristas.
- Emitir de 1 a 100 bonos por orden mediante reserva previa y captura posterior al guardado local; mostrar y copiar codigos, sin ticket, CSV, QR, email ni WhatsApp en el MVP.
- Integrar exclusivamente la OpenAPI publica de Ruijie desde backend, con secretos protegidos, tokens reutilizados, normalizacion defensiva, polling y tratamiento seguro de resultados inciertos.
- Conciliar estados financieros y bonos; recuperar ordenes estancadas sin reintentar ciegamente creaciones y ofrecer resolucion administrativa auditada.
- Auditar operaciones sensibles, cifrar codigos y secretos, enmascarar listados, y enviar alertas operativas por email sin bandeja visible en el MVP.
- Entregar entorno local Docker Compose con aplicacion, PostgreSQL persistente, migraciones controladas y worker, sin Redis.
- Mantener fuera del piloto pagos online, credito, impuestos, multi-moneda, precio al cliente final, revocacion automatica, creacion de paquetes Ruijie, datos personales del huesped y APIs privadas de Ruijie.

## Capabilities

### New Capabilities

- `identity-access`: Autenticacion, sesiones, roles y autorizacion aislada por revendedor.
- `reseller-management`: Ciclo de vida de revendedores, sitios y asignaciones autorizadas.
- `wallet-ledger`: Monedero prepago, ledger inmutable y transiciones monetarias idempotentes.
- `catalog-pricing`: Sincronizacion de paquetes, autorizacion de catalogo y precios mayoristas versionados.
- `voucher-ordering`: Creacion de ordenes y emision segura de hasta 100 bonos con entrega mostrar/copiar.
- `ruijie-integration`: Adaptador backend para autenticacion, OpenAPI publica, normalizacion y sincronizacion Ruijie.
- `reconciliation`: Conciliacion financiera y operativa automatica e interna (sin bandeja ni casos visibles en el MVP), recuperacion y resolucion de resultados inciertos.
- `audit-security`: Proteccion de secretos y codigos, auditoria, redaccion y controles de abuso.
- `notifications`: Entrega interna por email de alertas operativas, sin centro de avisos visible.
- `platform-infrastructure`: Entorno Docker Compose, PostgreSQL, migraciones, healthchecks y worker.

### Modified Capabilities

Ninguna. El proyecto no contiene especificaciones previas.

## Impact

- Nuevo sistema web responsive con API backend, interfaz administrativa e interfaz de revendedor.
- Nuevo modelo PostgreSQL para identidad, tenants, sitios, catalogo, precios, monederos, ledger, ordenes, bonos, auditoria, jobs y notificaciones.
- Nueva integracion saliente HTTPS con la OpenAPI publica regional de Ruijie Cloud; ninguna llamada directa desde navegador.
- Nuevos procesos asincronos de sincronizacion, conciliacion y recuperacion ejecutados por worker sobre PostgreSQL.
- Nueva configuracion mediante `.env`, incluyendo Ruijie, base de datos, cifrado, sesiones y bootstrap del administrador.
- Nuevo entorno Docker local iniciado con `docker compose up --build`; sin base de datos instalada en host ni Redis.
