# Design

## Context

El repositorio es greenfield: solo existen el plan funcional, el estudio de la API Ruijie, la configuracion OpenSpec y `.env.example`. La OpenAPI de Ruijie es inconsistente, no ofrece idempotencia de creacion, webhooks, revocacion publica ni limites publicados. Los codigos de bono son credenciales y las operaciones monetarias requieren trazabilidad fuerte. Ver `proposal.md` y los specs por capacidad.

El piloto usa COP entero, 2 revendedores iniciales, hasta 20 en 12 meses y unas 200 emisiones diarias. Ese volumen no justifica microservicios, Redis ni una plataforma de colas separada. El entorno local debe operar completamente con Docker Compose y PostgreSQL.

## Goals / Non-Goals

**Goals:**

- Construir un monolito modular con fronteras claras entre identidad, ventas, dinero e integracion externa.
- Hacer que PostgreSQL sea la autoridad para identidad, autorizacion, precios, ledger, ordenes y estado de jobs.
- Garantizar que una solicitud repetida o concurrente no duplique cargos ni emisiones iniciadas localmente.
- Aislar el comportamiento incierto de Ruijie detras de un adaptador y procesos de conciliacion.
- Permitir desarrollo y operacion local reproducibles con una sola topologia Docker.

**Non-Goals:**

- Microservicios, event broker, Redis, Kubernetes o escalado multi-region.
- Consistencia distribuida instantanea con Ruijie; la integracion sera eventualmente consistente.
- Automatizar comportamientos no confirmados en sandbox, especialmente revocacion, busqueda por alias y resolucion de emisiones parciales.
- Crear una API publica para terceros durante el MVP.

## Decisions

### 1. Monolito modular con web/API y worker separados por proceso

Una unica base de codigo contendra interfaz responsive, API backend y modulos de dominio. Un proceso web atendera usuarios; un proceso worker ejecutara sync, conciliacion, recuperacion y notificaciones. Ambos compartiran PostgreSQL y codigo de dominio, pero nunca memoria como mecanismo de coordinacion.

Esto reduce despliegues y contratos internos frente a microservicios. Separar el worker como proceso evita que jobs largos bloqueen solicitudes y satisface la topologia Docker requerida. La seleccion concreta de framework queda condicionada a que soporte sesiones seguras, renderizado web responsive, transacciones PostgreSQL, migraciones y procesos CLI; no cambia los contratos de los specs.

Alternativas descartadas: SPA y API independientes agregan build, CORS y autenticacion duplicada sin necesidad; microservicios agregan fallos distribuidos para el volumen piloto.

### 2. PostgreSQL como autoridad, coordinador de jobs y limite transaccional

Las tablas se agruparan logicamente en:

- Identidad: users y sessions.
- Tenancy: resellers, sites, reseller_sites y ruijie_connections.
- Catalogo: packages, reseller_package_permissions, price_versions y price_rules.
- Dinero: wallets, ledger_entries y holds.
- Venta: voucher_orders, vouchers y order_events.
- Operacion: sync_cursors, jobs, reconciliation_cases, notifications, email_deliveries y audit_events.

IDs locales seran opacos. IDs Ruijie se guardaran aparte; `authProfileId` siempre texto. Restricciones unicas cubriran referencias idempotentes, UUID Ruijie y transiciones monetarias irrepetibles. Foreign keys incluiran el tenant donde ayuden a impedir referencias cruzadas.

Los jobs se reclamaran con filas PostgreSQL y locking no bloqueante; lease, intentos y `run_after` permitiran recuperar workers caidos. No se incorpora Redis. Si el volumen futuro demuestra contencion o latencia no resoluble, una cola externa sera una decision posterior medida.

### 3. Ledger append-only con proyeccion bloqueada

Cada monedero mantendra una proyeccion de disponible, reservado y total para lecturas rapidas, respaldada por entradas append-only. La transaccion de reserva bloqueara la fila del monedero, verificara saldo, insertara ledger+hold y actualizara proyeccion atomicamente. Captura, liberacion y reverso bloquearan el hold y usaran claves unicas por transicion.

No se permitiran UPDATE/DELETE de ledger desde la aplicacion. Correcciones son nuevas entradas referenciadas. Un job recalculara muestras o el conjunto completo y abrira incidencia ante diferencias; no autocorregira dinero.

Alternativa descartada: calcular saldo sumando el ledger en cada solicitud simplifica escritura, pero dificulta reservas concurrentes y degrada lecturas. La proyeccion se acepta porque es verificable y se actualiza en la misma transaccion.

### 4. Maquina de estados explicita para orden y hold

La orden seguira `draft`, `reserved`, `issuing`, `issued`, `partially_issued`, `needs_reconciliation`, `failed` y `canceled`. `partially_issued` solo se usara tras validar el contrato sandbox; hasta entonces una respuesta parcial entra en `needs_reconciliation`. El hold seguira `active`, `captured`, `expired` y `released`. Cada transicion validara estado origen, registrara evento y sera idempotente.

Flujo normal:

1. Validar sesion, tenant, sitio, paquete, cantidad y precio.
2. Crear orden con snapshot y referencia unica.
3. Reservar saldo en transaccion.
4. Marcar `issuing` y persistir la intencion antes de la llamada externa.
5. Invocar una vez `voucher/create`, usando order ID en `comment` cuando el contrato lo permita; la referencia opcional del cliente queda local para no colisionar con idempotencia/conciliacion.
6. Guardar respuesta cruda y bonos cifrados en una transaccion.
7. Capturar el hold y marcar `issued` solo despues del guardado.

Timeouts, codigos 7/25, renovacion fallida o error local posterior a una posible emision llevan a `needs_reconciliation`; nunca vuelven automaticamente al paso 5. Antes de validar sandbox, una respuesta parcial tambien lleva a `needs_reconciliation` sin capturar ni liberar. Despues de validarla, una resolucion administrativa basada en evidencia puede marcar `partially_issued` y liquidar por unidad.

Alternativa descartada: reintentar create con backoff. Ruijie no acepta clave idempotente; podria duplicar bonos y cobros.

### 5. Adaptador Ruijie por conexion y region

El adaptador sera la unica capa que conozca rutas, query token, codigos, aliases y payloads Ruijie. Resolvera `reseller_id + site_id` a conexion y `groupId` autorizados en backend. Conservara JSON crudo con acceso restringido y producira modelos normalizados.

Tokens se reutilizaran por conexion y region, cifrados en reposo. La cache persistente permite compartirlos entre web y worker. Un lock por conexion evita renovaciones simultaneas. Codigos 3/4 permiten una renovacion y una repeticion solo cuando la operacion sea segura; en create, cualquier duda deriva a conciliacion.

Consultas GET usaran hasta tres intentos con backoff+jitter; 429 respetara `Retry-After`. Sync avanzara el offset por la cantidad realmente recibida hasta alcanzar `count` o recibir lista vacia, y hara upsert por claves Ruijie estables. Una pagina parcial no terminara la corrida si faltan elementos. Las cadencias iniciales seran configurables dentro de rangos conservadores del documento, sin prometer frescura menor que el polling.

Un circuito por conexion se abrira tras fallos recuperables repetidos. Mientras este abierto, create fallara antes de reservar saldo; consultas del panel usaran datos locales y mostraran la indisponibilidad. Pruebas controladas permitiran cerrar el circuito sin tormentas.

No se usara `/webproxy/common/api`, scraping, llamadas desde navegador ni endpoints no confirmados.

### 6. Cifrado de aplicacion y minimizacion

`APP_ENCRYPTION_KEY` cifrara codigos de bono, secretos Ruijie y tokens con cifrado autenticado y nonce unico. La clave no se guardara en DB ni imagen. Las respuestas API y logs utilizaran DTOs/redaccion allow-list para impedir filtraciones accidentales. Los codigos permaneceran enmascarados salvo reveal/copiar autorizado, evento que siempre se auditara.

Passwords usaran hashing adaptativo del framework. Sesiones usaran cookies Secure, HttpOnly y SameSite, rotacion al autenticar y revocacion server-side. El acceso administrativo se autorizara solo con contrasena, sin segundo factor en el MVP. CSRF protegera mutaciones basadas en cookie; rate limits persistidos cubriran login, reveal y emision.

No se almacenaran datos personales del huesped. Alias opcional tendra limite de longitud, normalizacion y tratamiento como texto no confiable.

### 7. RBAC y tenancy aplicados en servicio y consulta

La sesion aporta `user_id`, rol y `reseller_id`; el backend nunca acepta `reseller_id` como autoridad. Cada operacion carga recursos dentro del tenant o usa joins que incluyan asignacion activa. Las operaciones administrativas se autorizan explicitamente por rol. Un `site_id` ajeno falla antes del adaptador Ruijie y genera auditoria.

La DB no dependera unicamente de filtros UI. Restricciones y claves compuestas reduciran referencias cruzadas; pruebas de autorizacion cubriran cada endpoint tenant-scoped.

Alternativa descartada: una conexion Ruijie por revendedor. Ruijie no ofrece subcuentas adecuadas y varios revendedores pueden compartir sitio; el aislamiento pertenece a SkyTicket.

### 8. Precio versionado y snapshot de orden

Las reglas de precio tendran vigencia y alcance nullable controlado: base, sitio, revendedor o revendedor+sitio. Una consulta determinista aplicara la precedencia aprobada y exigira exactamente una regla vigente ganadora. La orden copia precio unitario, moneda, cantidad y total. No existe campo de impuesto ni precio final al huesped en el MVP.

La edicion crea nueva version en vez de reescribir historia. Paquetes desaparecidos de Ruijie se desactivan para nuevas ventas, sin borrar snapshots ni bonos previos.

### 9. Conciliacion basada en evidencia

El worker conciliara ledger/proyeccion, ordenes estancadas y bonos Ruijie. Cada caso guardara tipo, severidad, evidencia, intentos y resolucion. UUID es la clave preferida; `comment`/`nameRef` ayuda, pero no se tratara como garantia hasta validarlo. Si Ruijie no permite busqueda, se paginara `getList` con cursor conservador.

La conciliacion es **automatica e interna** en el MVP: no existe bandeja, listado de casos ni ruta de resolucion visibles en el panel. El worker detecta, alerta y abre el caso; la resolucion (cuando aplica) se ejecuta por el servicio de conciliacion con actor, motivo y referencia de evidencia, y queda auditada. El servicio aplica transiciones idempotentes; la UI no puede editar directamente ordenes, holds o ledger. Una superficie administrativa de casos queda fuera del alcance del MVP.

### 10. Notificaciones internas por email

Las alertas se persistiran y deduplicaran por tipo+recurso+ventana solo como soporte de entrega email. Un job enviara email segun la matriz del spec, con intentos limitados y registro de resultado; un fallo email nunca revertira la operacion de negocio. No existe centro de avisos visible en el MVP. SMS y WhatsApp quedan fuera.

### 11. Docker Compose y secuencia de arranque

Compose definira `db`, `migrate`, `web` y `worker`. PostgreSQL usara volumen nombrado y healthcheck. `migrate` esperara DB healthy, ejecutara migraciones una vez y terminara; web y worker dependeran de migracion exitosa. Web publicara healthcheck de vida y disponibilidad DB. Solo el puerto web se expondra al host por defecto.

Las imagenes se construiran sin `.env`; Compose inyectara variables en runtime. `.dockerignore` excluira `.env`, VCS y artefactos locales. El bootstrap administrativo sera un comando idempotente que usa `ADMIN_EMAIL` y un secreto inicial suministrado en ejecucion, nunca una password fija en Compose.

Alternativa descartada: ejecutar migraciones en cada replica web. Puede crear carreras y acopla disponibilidad con cambios de esquema.

### 12. Estrategia de pruebas y validacion Ruijie

La implementacion incluira pruebas unitarias de maquinas de estado, precios y normalizacion; integracion PostgreSQL real para locks, constraints, ledger y jobs; pruebas HTTP para RBAC/CSRF; y contratos del adaptador con fixtures sanitizados. Pruebas de concurrencia verificaran saldo no negativo y exactamente una reserva/captura.

Antes de habilitar emisiones reales, una fase sandbox validara host, permisos, token, payload create, parcialidad, timeout, paginacion, aliases, unidades, rate limit y codigo 25. Hallazgos que contradigan los contratos detendran activacion y requeriran actualizar estos artefactos, no parches silenciosos.

## Risks / Trade-offs

- [Ruijie no ofrece idempotencia de create] -> Persistir intencion antes de llamar, no reintentar resultados inciertos y conciliar manualmente.
- [No existe sandbox o busqueda por referencia] -> Mantener emision real deshabilitada hasta prueba controlada; paginar listados y escalar casos sin evidencia.
- [Semantica desconocida de emision parcial] -> Estado bloqueado y liquidacion solo con evidencia por unidad; validar antes del piloto.
- [Token y secretos viajan en URL/body] -> HTTPS, redaccion central, logs allow-list y cifrado persistente.
- [PostgreSQL como cola comparte recursos] -> Jobs pequenos, leases, indices y limites de concurrencia; medir antes de introducir infraestructura adicional.
- [Proyeccion de saldo puede desviarse] -> Actualizacion transaccional, reconciliacion y bloqueo ante discrepancia.
- [Polling crea desfase y consumo API] -> Cadencias configurables, backoff, cursores y metricas; respetar limite contractual cuando Ruijie lo informe.
- [Cifrado con una sola clave dificulta rotacion] -> Versionar ciphertext/key ID desde el inicio; procedimiento de re-cifrado antes de rotar.

## Migration Plan

1. Construir imagenes y levantar PostgreSQL sin datos de negocio.
2. Ejecutar migraciones y bootstrap idempotente del Administrador.
3. Configurar cifrado, sesiones y una conexion Ruijie de prueba.
4. Completar checklist sandbox y pruebas de contrato; mantener feature de emision deshabilitada hasta aprobar resultados.
5. Cargar sitios, asignaciones, paquetes, precios y saldos piloto mediante operaciones auditadas.
6. Habilitar primero consultas/sync, despues una emision controlada, luego los dos revendedores piloto.
7. Monitorizar conciliacion, latencia, errores, 429 y diferencias de ledger durante el piloto.

Rollback: detener web y worker, restaurar la version de aplicacion compatible y conservar PostgreSQL/ledger. Las migraciones destructivas quedan prohibidas durante el piloto; cambios de esquema seran expand/contract. Ordenes `issuing` o `needs_reconciliation` se concilian antes de cualquier liberacion de saldo.

## Open Questions

- Datos contractuales de Ruijie pendientes: existencia de sandbox, rate limits, retencion/orden de `getList`, busqueda por UUID/alias/codigo y significado exacto de codigo 25.
- Datos empiricos pendientes: formato de `expiryTime`, unidades de duracion/consumo/velocidad, respuesta parcial y comportamiento despues de timeout.
- Cadencias finales de polling y umbrales de saldo bajo se configuraran despues de medir sandbox; no cambian la arquitectura ni los contratos de seguridad.
