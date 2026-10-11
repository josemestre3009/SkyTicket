<!-- markdownlint-disable MD013 -->

# Plan de producto y negocio: panel de revendedores SkyTicket

Documento previo a OpenSpec para validar el negocio, alcance y reglas antes de diseñar o implementar.

**Estado:** borrador para revisión  
**Fecha:** 10 de octubre de 2026  
**Dependencia:** [Ruijie Cloud API para bonos](./RUIJIE_CLOUD_API_BONOS.md)  
**Decisión requerida:** aprobar o corregir la sección 24 antes de generar la propuesta OpenSpec

## 1. Visión

SkyTicket será una plataforma B2B para vender bonos de acceso Wi-Fi administrados en Ruijie Cloud.

La plataforma tendrá:

- Un administrador que crea revendedores, asigna sitios, configura precios y acredita saldo.
- Varios revendedores aislados entre sí.
- Un monedero prepago por revendedor.
- Un catálogo de bonos autorizado por sitio y revendedor.
- Emisión de bonos descontando saldo de manera segura.
- Historial financiero y operativo completamente auditable.
- Sincronización de estados con Ruijie Cloud.

El revendedor cobra al cliente final por fuera de SkyTicket durante el MVP. SkyTicket cobra al revendedor mediante saldo cargado manualmente por el administrador.

## 2. Propuesta de valor

### Para el administrador

- Centralizar revendedores, saldo, catálogo, precios y emisiones.
- Controlar qué puede vender cada revendedor y a qué precio.
- Reducir errores mediante saldo prepago y reglas automáticas.
- Consultar ventas, movimientos e incidencias.
- Auditar quién cambió saldo, precio, permisos o datos.

### Para el revendedor

- Consultar saldo disponible en tiempo real.
- Acceder solo a los sitios y paquetes autorizados.
- Emitir uno o varios bonos desde móvil o escritorio.
- Entregar códigos o tickets al cliente.
- Consultar historial y estado de los bonos.
- Exportar operaciones para su control interno.

### Para el cliente final

- Recibir un código claro y utilizable.
- Conectarse al portal cautivo del establecimiento.
- Obtener un bono con duración, cuota y velocidad conocidas.

## 3. Supuestos del modelo

1. SkyTicket controla el dinero y Ruijie controla el acceso Wi-Fi.
2. El administrador carga saldo manualmente tras verificar efectivo, transferencia u otro acuerdo.
3. No habrá pasarela de recarga automática en el MVP.
4. El revendedor no tendrá crédito: solo podrá gastar saldo disponible.
5. Cada revendedor tendrá una moneda única en el MVP.
6. Los precios serán establecidos por el administrador.
7. Los paquetes técnicos se crearán inicialmente en Ruijie Cloud y SkyTicket los sincronizará en modo lectura.
8. Los bonos se generarán bajo demanda; no se mantendrá inventario previo en el MVP.
9. Los ingresos, costos, impuestos y comisiones se calcularán en SkyTicket, no en Ruijie.
10. Un bono emitido no puede revocarse mediante la API pública documentada.

## 4. Alcance del MVP

### Incluido

- Inicio de sesión seguro.
- Roles `Admin` y `Revendedor`.
- Creación, edición, activación y suspensión de revendedores.
- Un monedero prepago por revendedor.
- Recargas y ajustes manuales por administrador.
- Libro de movimientos inmutable.
- Asignación de sitios Ruijie a revendedores.
- Sincronización de paquetes disponibles.
- Precios definidos por paquete, sitio o revendedor.
- Compra/emisión individual y por lote.
- Reserva y descuento seguro de saldo.
- Historial de órdenes, bonos y movimientos.
- Ticket imprimible y exportación CSV.
- Sincronización periódica del estado de bonos.
- Auditoría de acciones sensibles.
- Gestión manual de operaciones inciertas.
- Alertas básicas de saldo bajo y fallos de emisión.
- Panel responsive, especialmente para revendedores móviles.

### Excluido

- Pagos online del revendedor.
- Cobro directo al huésped.
- Crédito o saldo negativo.
- Multi-moneda por monedero.
- Conversión de moneda.
- Facturación fiscal automática.
- Comisiones complejas o liquidaciones a terceros.
- Creación o edición de paquetes Ruijie por API.
- Revocación automática de bonos.
- Administración de subcuentas Ruijie.
- Uso de la API web interna `/webproxy/common/api`.
- Integración PMS/Hospo directa.
- Portal externo WISPr/WiFiDog.
- Aplicación móvil nativa.
- Emisión offline.

## 5. Actores y permisos

### 5.1 Administrador

Puede:

- Crear y editar revendedores.
- Activar o suspender revendedores.
- Asignar sitios y paquetes.
- Cargar, retirar o ajustar saldo con motivo obligatorio.
- Definir precios y fechas de vigencia.
- Consultar todas las órdenes y bonos.
- Consultar auditoría y conciliación.
- Resolver operaciones inciertas.
- Exportar reportes administrativos.

No puede:

- Editar o borrar movimientos financieros ya publicados.
- Eliminar auditoría.
- Ver secretos Ruijie en texto claro.
- Reutilizar una referencia de recarga.

### 5.2 Revendedor

Puede:

- Ver su saldo disponible y reservado.
- Ver sus sitios y paquetes autorizados.
- Ver el precio que le corresponde.
- Emitir bonos si tiene saldo suficiente.
- Consultar sus órdenes, bonos y movimientos.
- Ver o exportar códigos según permiso.
- Descargar o imprimir tickets.
- Configurar una alerta de saldo bajo.

No puede:

- Ver otros revendedores.
- Cambiar precios.
- Acreditarse saldo.
- Elegir directamente un `groupId`, tenant o conexión Ruijie.
- Ver `appid`, `secret` o `access_token`.
- Emitir sobre sitios o paquetes no asignados.
- Modificar movimientos financieros.

### 5.3 Roles futuros

- `Super Admin`.
- `Admin Financiero` con aprobación de operaciones.
- `Soporte` con permisos limitados.
- `Revendedor Owner`.
- `Revendedor Cajero` limitado a sitios.
- `Revendedor Auditor` de solo lectura.

No son necesarios para el primer piloto. El modelo de autorización debe permitir agregarlos sin mezclar datos entre revendedores.

## 6. Modelo comercial

### 6.1 Relación económica

```text
Administrador acredita saldo al revendedor
             ↓
Revendedor compra/emite bono en SkyTicket
             ↓
SkyTicket descuenta precio mayorista del saldo
             ↓
Revendedor entrega y cobra al cliente final por su cuenta
```

SkyTicket no necesita conocer el precio final cobrado al huésped en el MVP. Puede permitirse registrarlo opcionalmente más adelante para calcular margen del revendedor.

### 6.2 Formas de cargar saldo

| Tipo | Significado | Evidencia requerida |
| --- | --- | --- |
| Transferencia | Dinero recibido en cuenta bancaria. | Referencia bancaria. |
| Efectivo | Dinero recibido físicamente. | Recibo o referencia interna. |
| Cortesía | Crédito promocional sin dinero recibido. | Motivo y autorización. |
| Ajuste | Corrección de una diferencia. | Motivo, evidencia y referencia. |

Una recarga no se edita ni elimina. Un error se corrige mediante un reverso.

El reverso no es una recarga. Solo puede aplicarse una vez al movimiento original. Si reduciría el saldo por debajo de cero, se bloquea y pasa a revisión administrativa; el MVP no crea deuda automática.

### 6.3 Reconocimiento del ingreso

Propuesta para el MVP: reconocer el ingreso cuando Ruijie confirma la emisión y SkyTicket guarda los bonos.

Alternativa: reconocer ingreso cuando el huésped usa el bono. Esta opción complica mucho la contabilidad, depende del polling y deja bonos sin usar como pasivo. Solo adoptarla si contabilidad o regulación lo exige.

## 7. Monedero y contabilidad

### 7.1 Principios

- Guardar dinero en unidades menores enteras: centavos, nunca `float`.
- Un monedero pertenece a un revendedor y una moneda.
- Diferenciar saldo disponible y saldo reservado.
- Registrar cada operación en un ledger inmutable.
- Usar claves idempotentes para evitar duplicados.
- Calcular el saldo desde movimientos; la columna de saldo es una proyección verificable.
- Tratar el saldo prepago como un pasivo de SkyTicket frente al revendedor, no como ingreso.

Contabilidad conceptual:

```text
Recarga con dinero recibido:
  aumenta Caja/Banco
  aumenta Pasivo: saldo del revendedor

Captura al emitir:
  reduce Pasivo: saldo reservado del revendedor
  reconoce Ingreso por venta de bonos

Cortesía:
  aumenta Gasto promocional
  aumenta Pasivo: saldo del revendedor
```

### 7.2 Saldos mostrados

| Saldo | Significado |
| --- | --- |
| Disponible | Puede gastarse inmediatamente. |
| Reservado | Apartado para emisiones en curso. |
| Total | Disponible + reservado. |

MVP:

```text
límite de crédito = 0
saldo disponible nunca menor que 0
```

### 7.3 Movimientos mínimos

| Movimiento | Efecto |
| --- | --- |
| Recarga | Aumenta disponible. |
| Reserva | Mueve disponible a reservado. |
| Captura | Convierte reservado en ingreso al emitir. |
| Liberación | Devuelve reservado a disponible. |
| Ajuste crédito | Aumenta disponible con autorización. |
| Ajuste débito | Reduce disponible con autorización. |
| Reverso | Invierte exactamente otro movimiento. |

El reembolso de bonos emitidos queda fuera del MVP. Fallos confirmados y emisiones parciales liberan reservas; no son reembolsos.

En el MVP solo pueden reversarse recargas y ajustes. Una captura no se revierte porque el bono seguiría válido en Ruijie; cualquier excepción se trata como una capacidad futura de reembolso, no como reverso contable ordinario.

### 7.4 Invariantes

1. Ninguna operación puede gastar más que el saldo disponible.
2. Un movimiento publicado no admite `UPDATE` ni `DELETE`.
3. Cada operación tiene una clave idempotente única.
4. Cada reserva termina capturada o liberada.
5. Una emisión solo puede capturarse una vez.
6. Un reverso referencia el movimiento original.
7. El saldo recalculado debe coincidir con la proyección.
8. Precio e impuesto se copian en la orden y no cambian retroactivamente.
9. Reservar saldo usa bloqueo de fila o actualización atómica condicionada a saldo suficiente.
10. Un reverso nunca crea saldo negativo ni se aplica dos veces.

### 7.5 Recarga administrativa

Datos obligatorios:

- Revendedor.
- Monto.
- Moneda.
- Tipo de recarga.
- Referencia única.
- Motivo.
- Administrador que la ejecutó.
- Fecha efectiva.
- Evidencia opcional o requerida según tipo.

Para importes altos, una fase posterior puede exigir doble aprobación: una persona crea y otra aprueba.

## 8. Catálogo y precios

### 8.1 Catálogo técnico

Cada producto vendible relaciona:

```text
Sitio local
  → conexión Ruijie
  → groupId autorizado
  → userGroupId
  → authProfileId guardado como string
  → paquete visible
```

SkyTicket sincroniza desde Ruijie:

- Nombre del paquete.
- Duración.
- Cuota.
- Velocidad de subida y descarga.
- Dispositivos concurrentes.
- Bind MAC.

### 8.2 Precio

El administrador controla el precio mayorista que se descuenta al revendedor.

Precedencia propuesta:

```text
precio específico del revendedor y sitio
  > precio específico del revendedor
  > precio específico del sitio
  > precio base del paquete
```

La interfaz siempre debe mostrar cuál regla produjo el precio final.

### 8.3 Historial y vigencia

Los precios no se sobrescriben. Cada cambio crea una versión:

- Precio neto.
- Impuesto.
- Precio total.
- Moneda.
- Inicio de vigencia.
- Fin de vigencia opcional.
- Autor y motivo.

Una orden conserva el precio vigente al reservar saldo, aunque el administrador cambie el catálogo durante la emisión.

### 8.4 Impuestos

El MVP debe decidir si el precio configurado incluye impuestos.

Recomendación inicial: el administrador introduce el precio final que se descontará. SkyTicket guarda por separado neto e impuesto cuando la jurisdicción esté configurada.

## 9. Sitios y aislamiento

Un sitio representa un hotel, restaurante, local o proyecto Ruijie.

Relación segura:

```text
reseller_id + site_id
  → ruijie_connection_id
  → region
  → tenant_id
  → group_id
```

Reglas:

- El frontend envía `site_id`, nunca `groupId` libre.
- El backend verifica que el sitio está asignado al revendedor autenticado.
- El backend resuelve `groupId` y perfil.
- Cada consulta y emisión aplica el filtro del revendedor.
- Un cambio de asignación queda auditado.
- Suspender un revendedor impide nuevas emisiones, pero no invalida bonos ya emitidos.

## 10. Flujo de emisión

### 10.1 Flujo normal

1. El revendedor selecciona sitio, paquete y cantidad.
2. SkyTicket resuelve precio, impuesto y total.
3. SkyTicket verifica permisos y saldo.
4. Se crea una orden idempotente.
5. Se reserva el saldo.
6. Se marca la emisión como iniciada.
7. El backend llama a Ruijie.
8. Se validan `code` y `voucherData.code`.
9. Se guardan los bonos y la respuesta cruda.
10. Se captura el saldo reservado.
11. Se genera ticket o exportación.
12. Se entrega el resultado al revendedor.
13. El estado se actualiza posteriormente por polling.

### 10.2 Emisión por lote

- Ruijie admite hasta 500 bonos por solicitud API.
- Para reducir impacto de fallos, el producto puede limitar el piloto a 100 por orden.
- Cantidades superiores al límite del producto deben dividirse en órdenes independientes, no en una operación aparentemente atómica.

### 10.3 Idempotencia

Cada solicitud del revendedor incluye una referencia local única. Repetir la misma solicitud devuelve la orden existente.

Ruijie no acepta una clave de idempotencia. SkyTicket enviará una referencia de orden única en `comment`, que aparece como `nameRef` al listar bonos.

Nunca se reintenta automáticamente `voucher/create` después de enviar la petición si el resultado es incierto, incluidos timeout, `code = 3`, `4`, `7`, `25` o una conexión interrumpida. Se renueva el token si corresponde, pero la orden pasa primero a conciliación.

## 11. Estados

### 11.1 Revendedor

| Estado | Comportamiento |
| --- | --- |
| `pending` | Creado, aún sin acceso. |
| `active` | Puede operar. |
| `suspended` | No inicia sesión ni emite. |
| `restricted` | Entra y consulta, pero no emite. |
| `closed` | Cerrado, histórico disponible para admin. |

### 11.2 Orden

| Estado | Significado |
| --- | --- |
| `draft` | Aún no reservada. |
| `reserved` | Saldo apartado. |
| `issuing` | Solicitud enviada a Ruijie. |
| `issued` | Todos los bonos guardados y saldo capturado. |
| `partially_issued` | Estado provisional sujeto a validación en sandbox. |
| `needs_reconciliation` | Resultado Ruijie desconocido. |
| `failed` | Fallo confirmado; saldo liberado. |
| `canceled` | Cancelada antes de emisión. |

### 11.3 Reserva

```text
active → captured
active → released
active → expired → released
```

Un worker detecta reservas vencidas y publica una liberación. Una reserva no desaparece ni cambia el saldo sin un movimiento del ledger. Las órdenes `needs_reconciliation` no expiran automáticamente: requieren resolución.

El worker tampoco libera reservas de órdenes `issuing`. Si una orden permanece `issuing` más que el timeout operativo, una tarea de recuperación la cambia atómicamente a `needs_reconciliation`; después conserva la reserva hasta resolución. Esto evita liberar saldo mientras Ruijie aún puede haber creado los bonos.

### 11.4 Bono

Guardar estado crudo y normalizado:

| Ruijie | Normalizado |
| --- | --- |
| `1` | `unused` |
| `2` | `in_use` |
| `3` | `expired` |

Estados locales adicionales: `issued`, `delivered`, `orphan`, `unknown`.

## 12. Fallos y compensación

### 12.1 Fallo confirmado antes de crear bonos

- Marcar orden `failed`.
- Liberar reserva.
- Mostrar error recuperable.
- Permitir nueva orden con referencia distinta.

### 12.2 Timeout o respuesta incierta

- No capturar ni liberar automáticamente.
- Marcar `needs_reconciliation`.
- No volver a llamar a creación.
- Buscar bonos paginando y comparar `nameRef` con la referencia de orden.
- Permitir resolución manual auditada.

### 12.3 Emisión parcial

Comportamiento provisional, sujeto a comprobar que Ruijie puede responder parcialmente:

- Guardar los bonos confirmados.
- Capturar solo la parte emitida.
- Liberar la parte no emitida.
- Marcar `partially_issued`.
- Mostrar resultado por unidad o lote.

Hasta validarlo en sandbox, `count < quantity` se trata como `needs_reconciliation`, sin capturar ni liberar automáticamente.

### 12.4 Caída de Ruijie

- Conservar la orden y reserva por tiempo limitado.
- Abrir circuito después de fallos repetidos.
- Evitar tormentas de reintentos.
- Degradar el panel a consulta local.
- Mostrar que la emisión está temporalmente no disponible.

## 13. Reembolsos y revocación

### 13.1 Restricción técnica

La API pública no documenta revocación, eliminación ni desactivación de bonos. Devolver saldo no invalida el código Ruijie.

### 13.2 Política MVP recomendada

- No permitir reembolsos de bonos emitidos.
- Un fallo confirmado libera la reserva porque no hubo venta.
- Una emisión parcial, si Ruijie confirma que puede ocurrir, captura solo lo emitido y libera el resto.
- Cualquier excepción requiere una operación administrativa externa al flujo normal y una revisión de riesgo.

La sección 24 permite cambiar esta política antes de OpenSpec. Si se habilitan reembolsos, será una capacidad nueva con controles para el riesgo de que el código siga válido.

## 14. Conciliación

### 14.1 Conciliación financiera

Job periódico:

- Recalcular saldos desde movimientos.
- Comparar contra la proyección del monedero.
- Crear alerta ante cualquier diferencia.
- No corregir diferencias silenciosamente.

### 14.2 Conciliación Ruijie

Por cada sitio:

- Paginar todos los bonos relevantes.
- Actualizar por `uuid`.
- Conservar JSON crudo.
- Detectar bonos locales ausentes en Ruijie.
- Detectar bonos Ruijie no conocidos localmente.
- Detectar estados o consumos diferentes.
- Crear casos de conciliación.

Clasificación:

| Estado | Significado |
| --- | --- |
| `matched` | Local y Ruijie coinciden. |
| `local_only` | Existe localmente, no aparece en Ruijie. |
| `ruijie_only` | Existe en Ruijie, no localmente. |
| `mismatch` | Existe en ambos con datos distintos. |
| `pending` | Aún no procesado. |
| `resolved` | Revisado y cerrado por operador. |

## 15. Seguridad

### 15.1 Secretos Ruijie

- Solo backend.
- Guardar en gestor de secretos.
- Nunca enviar al navegador.
- Redactar `appid`, `secret` y `access_token` de logs y trazas.
- Usar HTTPS.
- Rotar tras exposición.
- Mantener token por cuenta y región.

### 15.2 Códigos de bono

Los códigos son credenciales de acceso:

- Cifrar en reposo.
- Enmascarar en listados.
- Revelar solo con permiso específico.
- Auditar visualización completa, copia y exportación.
- No registrar códigos en logs.
- Establecer expiración de enlaces de descarga.

### 15.3 Cuentas de usuario

- Contraseñas con hash fuerte.
- 2FA obligatorio para administradores.
- Sesiones revocables.
- Rate limiting en login y emisión.
- Recuperación de cuenta segura.
- Protección CSRF si se usan cookies.
- Confirmación reforzada para saldo y suspensión.

### 15.4 Auditoría

Registrar:

- Actor.
- Acción.
- Entidad.
- Antes y después.
- Motivo.
- Fecha.
- IP y sesión.
- ID de correlación.
- Resultado.

Eventos obligatorios: recargas, ajustes, reversos, precios, permisos, asignación de sitios, suspensión, revelación/exportación de códigos y resolución de conciliaciones.

## 16. Experiencia del administrador

### Navegación del revendedor

1. Dashboard.
2. Revendedores.
3. Sitios.
4. Catálogo.
5. Precios.
6. Saldos y movimientos.
7. Órdenes y bonos.
8. Conciliación.
9. Auditoría.
10. Configuración.

### Pantallas críticas

#### Dashboard

- Saldo total en circulación.
- Emisiones del día.
- Ingresos del periodo.
- Revendedores activos y suspendidos.
- Saldos bajos.
- Operaciones inciertas.
- Fallos Ruijie.

#### Revendedores

- Lista con estado, saldo, sitios y última actividad.
- Alta y edición.
- Recarga rápida.
- Suspensión con motivo.
- Detalle con tabs: resumen, saldo, sitios, precios, bonos y auditoría.

#### Saldo

- Monto y moneda.
- Tipo y referencia.
- Motivo.
- Evidencia.
- Vista previa del saldo resultante.
- Confirmación explícita.
- Recibo con ID de operación.

#### Precios

- Precio base.
- Overrides vigentes.
- Simulación del precio final para un revendedor.
- Programación de vigencia.
- Historial antes/después.

#### Conciliación

- Cola priorizada.
- Evidencia local y Ruijie.
- Acciones permitidas y su impacto financiero.
- Motivo obligatorio de resolución.

## 17. Experiencia del revendedor

### Navegación

1. Inicio.
2. Emitir bonos.
3. Historial.
4. Saldo y movimientos.
5. Exportaciones.
6. Soporte.
7. Cuenta.

### Inicio

- Saldo disponible destacado.
- Saldo reservado secundario.
- Alerta de saldo bajo.
- Botón principal `Emitir bono`.
- Actividad reciente.
- Emisiones pendientes o inciertas.

### Pantalla de emisión

- Selección de sitio.
- Catálogo permitido.
- Detalles técnicos del bono.
- Precio unitario y total.
- Cantidad.
- Referencia opcional del cliente o habitación.
- Confirmación antes del descuento.
- Resultado individual por bono.

### Historial

- Filtros por fecha, sitio, paquete, estado y referencia.
- Código enmascarado por defecto.
- Detalle de orden.
- Descarga o impresión.
- Exportación CSV auditada.

### Mobile-first

El flujo de emisión debe funcionar completamente en móvil:

- Objetivos táctiles mínimos de 44 px.
- Inputs numéricos adecuados.
- Sin tablas horizontales para la operación principal.
- Confirmaciones claras.
- Estados de carga con skeleton.
- Conservar formulario ante error recuperable.

## 18. Notificaciones

### MVP

| Evento | Destinatario | Canal |
| --- | --- | --- |
| Saldo bajo | Revendedor | Panel + email. |
| Recarga realizada | Revendedor | Panel + email. |
| Emisión completada | Revendedor | Panel. |
| Emisión incierta | Admin + revendedor | Panel + email. |
| Revendedor suspendido | Revendedor | Email. |
| Fallo de sincronización | Admin | Panel + email. |

### Futuro

- SMS.
- WhatsApp.
- Preferencias por evento.
- Horario de silencio.
- Webhooks propios para revendedores.

## 19. Modelo de datos conceptual

```text
users
roles
permissions
user_roles

resellers
reseller_users
wallets
journal_entries
journal_postings
wallet_holds

ruijie_connections
sites
reseller_sites
voucher_packages
package_prices

voucher_orders
vouchers
reconciliations
audit_events
notifications
```

Campos críticos:

```text
wallets
  reseller_id, currency, posted_minor, reserved_minor, version

journal_entries
  idempotency_key UNIQUE, type, currency, actor_id, reason,
  reversal_of_id, correlation_id, created_at

sites
  ruijie_connection_id, ruijie_group_id, timezone, status

voucher_packages
  site_id, ruijie_user_group_id, ruijie_profile_id STRING,
  technical_limits_json, status

package_prices
  package_id, reseller_id?, site_id?, currency, net_minor,
  tax_minor, gross_minor, effective_from, effective_to

voucher_orders
  reseller_id, site_id, client_reference,
  quantity, currency, unit_price_snapshot, total_snapshot,
  status, hold_id, correlation_id

vouchers
  order_id, ruijie_uuid UNIQUE, code_encrypted,
  raw_status, normalized_status, alias,
  raw_json, last_synced_at
```

## 20. Reglas de negocio esenciales

1. Solo el administrador acredita saldo.
2. Una recarga necesita referencia única y motivo.
3. Un revendedor suspendido no emite.
4. Un revendedor solo opera sus sitios asignados.
5. El precio se decide en backend.
6. El precio de la orden queda congelado al reservar.
7. El saldo se reserva antes de llamar a Ruijie.
8. El saldo se captura solo tras guardar bonos confirmados.
9. Ningún resultado incierto de creación provoca reintento automático.
10. Los bonos se identifican por `ruijie_uuid`, no solo por código o alias.
11. `authProfileId` se guarda como string.
12. Los códigos se cifran y enmascaran.
13. Toda exportación de códigos queda auditada.
14. No se edita ni elimina el ledger.
15. Los cambios financieros se compensan con reversos.
16. Las métricas monetarias provienen de SkyTicket, no de Ruijie.
17. La API interna de Ruijie queda prohibida.
18. Las operaciones no soportadas se muestran como manuales, no se simulan.
19. Las capturas no se reversan en el MVP; un bono emitido no recupera saldo automáticamente.
20. Una orden `issuing` estancada pasa a conciliación antes de cualquier liberación.

## 21. Casos límite

1. Dos emisiones simultáneas intentan gastar el último saldo.
2. El usuario pulsa dos veces el botón de emitir.
3. El navegador repite la petición.
4. Ruijie crea bonos y la conexión se corta antes de responder.
5. Ruijie devuelve menos bonos de los solicitados.
6. El token expira durante la emisión.
7. La API devuelve `code = 25` o timeout.
8. El revendedor se suspende con una emisión en curso.
9. El administrador cambia el precio durante una orden.
10. Se repite una referencia de recarga.
11. Se intenta reversar dos veces el mismo movimiento.
12. Se solicita una excepción de reembolso para un bono que sigue válido.
13. Aparece en Ruijie un bono creado fuera de SkyTicket.
14. Un bono local deja de aparecer en Ruijie.
15. `expiryTime` llega como fecha, número o `null`.
16. Un revendedor manipula el `site_id` de otro.
17. Una exportación contiene miles de credenciales.
18. El job de sincronización recibe HTTP 429.
19. Ruijie queda no disponible durante varias horas.
20. El saldo proyectado difiere del ledger.

Todos deben tener prueba o criterio de aceptación antes del lanzamiento.

## 22. Criterios de aceptación del MVP

### Revendedores y permisos

- El admin crea, activa y suspende revendedores.
- Un revendedor suspendido no puede emitir.
- Un revendedor nunca puede leer o mutar datos de otro.
- `site_id` ajeno devuelve 403 sin llamar a Ruijie.

### Criterios de saldo

- Una recarga aumenta saldo exactamente una vez.
- Repetir la referencia no duplica saldo.
- No puede emitirse con saldo insuficiente.
- Dos emisiones concurrentes no producen saldo negativo.
- La reserva usa control concurrente atómico sobre el monedero.
- Una reserva vencida genera una liberación auditable.
- Todo ajuste tiene actor, motivo y auditoría.
- El saldo recalculado coincide con el ledger.

### Criterios de precios

- El admin define precio base y override.
- El sistema muestra la regla aplicada.
- Cambiar precio no modifica órdenes existentes.
- El revendedor no puede enviar un precio desde el cliente.

### Criterios de emisión

- Repetir la misma referencia devuelve la misma orden.
- El saldo se reserva antes de llamar a Ruijie.
- La emisión confirmada guarda bonos antes de capturar saldo.
- Timeout o `code = 3`, `4`, `7` o `25` deja la orden en conciliación y no reintenta creación.
- Una emisión fallida confirmada libera el saldo.
- Los códigos nunca aparecen en logs.

### Seguridad

- Secretos Ruijie no llegan al frontend.
- Los códigos se almacenan cifrados.
- Listados muestran códigos enmascarados.
- Revelar o exportar códigos crea evento de auditoría.
- Admin usa 2FA.

### Sincronización

- Reprocesar una página no duplica bonos.
- La sincronización usa `uuid` como clave.
- Diferencias generan casos de conciliación.
- HTTP 429 respeta `Retry-After` si existe; en otro caso aplica backoff exponencial con jitter.
- Los estados activos cumplen la ventana de actualización acordada.

## 23. Fases

### Fase 0: validación comercial y sandbox

- Resolver decisiones de la sección 24.
- Obtener credenciales Ruijie.
- Verificar emisión, timeout, paginación y unidades.
- Definir moneda, impuestos y precios reales.
- Seleccionar 2-3 revendedores piloto.

### Fase 1: núcleo administrativo

- Autenticación y RBAC.
- Revendedores y sitios.
- Ledger y monederos.
- Recargas, ajustes y reversos.
- Catálogo y precios.
- Auditoría.

### Fase 2: emisión Ruijie

- Adaptador API.
- Token y secretos.
- Sincronización de grupos y paquetes.
- Órdenes, reservas e idempotencia.
- Emisión, tickets y exportaciones.
- Manejo de fallos.

### Fase 3: operación confiable

- Polling de estados.
- Conciliación financiera y Ruijie.
- Alertas y notificaciones.
- Panel de soporte.
- Observabilidad y runbooks.
- Pruebas de carga y seguridad.

### Fase 4: crecimiento

- Subusuarios y permisos configurables.
- Doble aprobación financiera.
- Pasarela de recargas.
- Facturación fiscal.
- Entrega por WhatsApp/SMS/email.
- API pública para revendedores.
- Multi-moneda.
- Portal propio WISPr/WiFiDog si el negocio exige revocación en tiempo real.

## 24. Decisiones que debes aprobar

### 24.1 Modelo de cobro

**Propuesta:** saldo prepago cargado manualmente por admin. Sin crédito.

- [x] Aprobado.
- [ ] Cambiar: ______________________________

### 24.2 Momento del descuento

**Propuesta:** reservar al confirmar compra; capturar al recibir y guardar los bonos.

- [x] Aprobado.
- [ ] Cambiar: ______________________________

### 24.3 Precio

**Propuesta:** admin define precio final mayorista. Overrides por revendedor y sitio.

- [x] Aprobado.
- [ ] Cambiar: ______________________________

### 24.4 Precio al cliente final

**Propuesta:** SkyTicket no controla cuánto cobra el revendedor al huésped durante el MVP.

- [x] Aprobado.
- [ ] El admin fijará también precio de venta al público.
- [ ] El admin fijará un mínimo/máximo.

### 24.5 Moneda

**Propuesta:** una moneda por revendedor y sin conversión.

Moneda inicial: COP, usando pesos enteros sin centavos.

- [x] Aprobado.
- [ ] Necesitamos multi-moneda desde MVP.

### 24.6 Impuestos

¿El precio configurado por admin incluye impuestos?

- [ ] Sí, precio final con impuestos incluidos.
- [ ] No, el impuesto se agrega al confirmar.
- [x] No se manejarán impuestos en el piloto.

### 24.7 Reembolsos

**Propuesta segura:** no reembolsar bonos emitidos, salvo fallo o emisión parcial, porque la API no los revoca.

- [x] Aprobado.
- [ ] Permitir reembolso manual de bonos sin usar, aceptando el riesgo.
- [ ] Otra política: ______________________________

### 24.8 Cantidad máxima

**Propuesta piloto:** máximo 100 bonos por orden, aunque Ruijie admite hasta 500.

- [x] Aprobado.
- [ ] Usar 500 desde el inicio.
- [ ] Otro límite: ______________________________

### 24.9 Sitios

¿Un sitio puede estar asignado a varios revendedores?

- [ ] No, un único revendedor por sitio.
- [x] Sí, varios revendedores pueden vender en el mismo sitio.

### 24.10 Paquetes

**Propuesta:** el admin crea paquetes en Ruijie y SkyTicket solo sincroniza y pone precio.

- [x] Aprobado.
- [ ] Necesitamos automatizar paquetes antes del MVP.

### 24.11 Entrega

MVP:

- [x] Mostrar/copiar código.
- [ ] Ticket imprimible.
- [ ] CSV.
- [ ] QR propio generado desde el código; no depender de `qrcodeUrl` hasta validarlo.
- [ ] Email.
- [ ] WhatsApp.

### 24.12 Administración

¿Cuántas personas administrarán inicialmente?

Respuesta: 1

¿Se requiere doble aprobación para recargas altas?

- [x] No en MVP.
- [ ] Sí, desde: ______________________________

### 24.13 Revendedores piloto

Cantidad inicial: 2 revendedores piloto.

Cantidad esperada en 12 meses: 20 revendedores.

Emisiones diarias aproximadas: hasta 200 entre todos los revendedores.

### 24.14 Datos personales

¿Se guardarán nombre, teléfono o email del huésped?

- [x] No; solo referencia/alias opcional.
- [ ] Sí. Datos requeridos: ______________________________

Recomendación: no guardar datos personales del huésped en el MVP si no son necesarios.

## 25. Preguntas para validación con Ruijie

1. ¿Cuál es el rate limit contractual?
2. ¿Existe sandbox?
3. ¿Cómo responde creación parcial?
4. ¿Cómo confirmar una creación tras timeout?
5. ¿Existe búsqueda por UUID, alias o código?
6. ¿Existe endpoint privado contractual para revocar?
7. ¿Existe endpoint para unbind MAC?
8. ¿Puede un paquete usarse simultáneamente por varios revendedores?
9. ¿Cuál es la retención de bonos en `getList`?
10. ¿Cuál es el orden de paginación?
11. ¿Qué unidades usan duración, consumo y velocidad?
12. ¿Qué significa exactamente `code = 25`?

## 26. Métricas del negocio

### Operativas

- Bonos emitidos por día.
- Tasa de éxito de emisión.
- Tiempo medio de emisión.
- Órdenes en conciliación.
- Retraso de sincronización.
- Incidencias por 100 emisiones.

### Comerciales

- Ingresos por periodo.
- Ventas por revendedor.
- Ventas por sitio y paquete.
- Saldo total en circulación.
- Recargas por periodo.
- Revendedores activos.
- Margen bruto en una fase futura, cuando se configure el costo proveedor.

### Riesgo

- Reintentos bloqueados por idempotencia.
- Ajustes y reversos.
- Exportaciones de códigos.
- Intentos de acceso cruzado.
- Bonos reembolsados usados posteriormente.
- Diferencias de conciliación.

## 27. Condiciones para pasar a OpenSpec

No generar todavía una propuesta técnica definitiva hasta completar:

- [x] Sección 24 revisada.
- [x] Moneda definida: COP sin centavos.
- [x] Política de impuestos definida: fuera del piloto.
- [x] Política de reembolso definida: no se reembolsan bonos emitidos.
- [x] Regla de asignación definida: varios revendedores por sitio.
- [x] Canal de entrega definido: mostrar/copiar código.
- [x] Volumen esperado aproximado: 2 pilotos, 20 al año y hasta 200 emisiones diarias.
- [ ] Credenciales o respuesta inicial de Ruijie.

## 28. Entorno Docker requerido

La implementación debe incluir `docker-compose.yml` para levantar el entorno local completo sin instalar la base de datos directamente en el equipo.

Servicios mínimos:

- Aplicación web/API.
- PostgreSQL con volumen persistente.
- Ejecución controlada de migraciones.
- Worker para sincronización, conciliación y recuperación de órdenes estancadas, si el stack lo separa de la API.

Requisitos:

- Leer configuración desde `.env` sin copiar secretos dentro de imágenes.
- Exponer únicamente los puertos necesarios.
- Añadir healthchecks para aplicación y PostgreSQL.
- Esperar a que PostgreSQL esté saludable antes de migrar o iniciar la aplicación.
- Persistir datos de PostgreSQL en un volumen nombrado.
- Incluir `.env.example` sin credenciales privadas.
- Permitir inicio con un solo comando: `docker compose up --build`.
- Permitir ejecutar migraciones y crear el administrador inicial de forma documentada.
- No incluir herramientas adicionales como Redis hasta que una necesidad concreta lo justifique.

Después de aprobar este documento, el siguiente paso será crear un cambio OpenSpec con:

- `proposal.md`: problema, objetivos, alcance y no objetivos.
- `specs/`: requisitos verificables por capacidad.
- `design.md`: arquitectura, ledger, seguridad e integración Ruijie.
- `tasks.md`: implementación por fases con pruebas.

Capacidades sugeridas:

```text
identity-access
reseller-management
wallet-ledger
catalog-pricing
voucher-ordering
ruijie-integration
reconciliation
audit-security
notifications
```

No se implementará código durante la propuesta OpenSpec. La implementación comenzará solo después de revisar y aprobar sus artefactos.
