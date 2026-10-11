<!-- markdownlint-disable MD013 -->

# Ruijie/Reyee Cloud API para bonos hospitality

Guía técnica para construir un dashboard de revendedores que gestione bonos (vouchers) de acceso Wi-Fi en hoteles, restaurantes y otros negocios hospitality.

**Investigación verificada:** 10 de octubre de 2026  
**API:** Ruijie Cloud OpenAPI, también usada por productos Reyee  
**Estado:** documentación de integración; validar el contrato con credenciales sandbox antes de producción

## 1. Resumen ejecutivo

Ruijie Cloud ofrece una API REST pública para:

- Obtener un token mediante `appid` y `secret`.
- Consultar la cuenta, tenant, rol y árbol de redes/proyectos.
- Crear nuevas redes/proyectos.
- Consultar paquetes/perfiles de autenticación ya configurados.
- Generar hasta 500 bonos por solicitud.
- Crear bonos con código personalizado.
- Listar bonos, estado, consumo, límites y paquete.
- Gestionar cuentas de autenticación distintas de los bonos.
- Consultar clientes conectados e historial.
- Crear o modificar SSID Wi-Fi.

La API pública **no documenta** operaciones para:

- Crear, editar o eliminar paquetes de bonos.
- Revocar, eliminar o desactivar un bono.
- Desvincular el MAC de un bono.
- Imprimir tickets A4/POS o exportar reportes.
- Administrar subcuentas, revendedores, permisos o jerarquías MSP.
- Cobrar al huésped o liquidar comisiones al revendedor.
- Integrarse directamente con un PMS/Hospo.
- Recibir webhooks de cambios de estado.

Estas funciones deben resolverse en la interfaz Ruijie Cloud o en el sistema propio. No conviene automatizar la API web interna `/webproxy/common/api`: no es pública, usa cookies de sesión y puede cambiar sin aviso.

## 2. Fuentes y nivel de confianza

### 2.1 Fuentes oficiales primarias

1. [Ruijie Cloud API Document](https://cloud-as.ruijienetworks.com/help/#/ArticleList?id=7e875942927f4e3fb3e5736c8502c03c)
2. [Contenido JSON del manual oficial](https://work-msg-record-1301408934.cos.ap-nanjing.myqcloud.com/json/66f7bbeae61447ac9f56948dfe3ea7b4.json)
3. [Configuración oficial de Voucher](https://cloud-japan.ruijienetworks.com/wiki2/article/191)
4. [Ruijie Community: acceso a la API y propósito de integración](https://community.ruijie.com/forum.php?mod=viewthread&tid=10426)
5. [Ruijie Cloud Document Center](https://cloud-as.ruijienetworks.com/help/)

El JSON enlazado es el contenido servido por el Help Center oficial. El texto no incluye una etiqueta de versión inequívoca; referencias externas lo identifican como manual V2.0.3. Esta guía prioriza el contenido del snapshot oficial sobre copias PDF antiguas.

### 2.2 Fuentes secundarias útiles

- [Manual reflejado, edición 2024-08-20](https://pdfcoffee.com/ruijie-cloud-api-document-pdf-free.html)
- [SDK comunitario `pyruijie`](https://github.com/dannielperez/pyruijie), Apache-2.0.
- [Ejemplos comunitarios de ISP Cloud](https://github.com/jarisaizprua/ruijie-isp-cloud-api-test).

Las fuentes secundarias sirven para contrastar comportamiento. No sustituyen el contrato oficial.

## 3. Terminología

| Término | Significado |
| --- | --- |
| Ruijie Cloud | Plataforma cloud y API principal. |
| Reyee | Marca SMB de Ruijie; sus equipos pueden gestionarse desde Ruijie Cloud. |
| Tenant | Organización o cuenta raíz. |
| Group / Network | Nodo del árbol organizativo. Normalmente un cliente, hotel o proyecto. |
| `groupId` | ID numérico de una red/proyecto. Es la frontera operativa de bonos. |
| User Group | Grupo de usuarios asociado a un perfil de autenticación. |
| Package | Configuración comercial/técnica del bono visible en la UI. |
| Profile | Política técnica del paquete. La API usa `authProfileId` como `profile`. |
| Voucher / bono | Código que permite pasar el portal cautivo. |
| Account | Usuario y contraseña para portal; no es un voucher. |
| Register account | Cuenta creada mediante registro de usuario en el portal. |
| Captive Portal | Página de autenticación que recibe el código del huésped. |

La relación práctica es:

```text
Tenant
  └─ Group/Network (hotel o cliente)
       ├─ User Group
       │    └─ Profile/Package
       │         └─ Vouchers
       ├─ SSID + Captive Portal
       └─ Clientes conectados
```

## 4. Acceso a la API

### 4.1 Solicitud de credenciales

El acceso no es autoservicio. El personal de Ruijie indica solicitarlo en:

`service_rj@ruijienetworks.com`

Formato recomendado:

```text
Subject: Ruijie Cloud API access request - voucher management

Customer Name: <empresa>
Cloud Account / Email: <cuenta Ruijie Cloud>
Country: <país>
API Purpose: Reseller dashboard for hospitality voucher management
User Role: <VAD | SUB | SI>
Cloud Region: <región/host de la cuenta>
Required APIs: account, groups, user groups, voucher create/list
```

Solicitar explícitamente:

- `appid`.
- `secret`.
- Host regional asignado.
- Tenant o cuenta habilitada.
- Confirmación de permisos para las secciones 2.1, 2.2, 2.3 y 2.7.
- Entorno de prueba o proyecto sandbox.
- Límites de tasa aplicables a la cuenta.

### 4.2 Roles mencionados por Ruijie

| Rol | Interpretación operativa |
| --- | --- |
| `VAD` | Distribuidor de valor añadido. |
| `SUB` | Subdistribuidor o subcuenta comercial. |
| `SI` | Integrador de sistemas. |

El manual no define una API para crear estos roles ni garantiza el alcance exacto de cada uno. Ruijie debe confirmar los permisos concedidos.

## 5. Base URL y regiones

El manual usa `[CloudUrlPrefix]`. Ejemplo oficial:

```text
https://cloud-as.ruijienetworks.com
```

Hosts regionales observados en la plataforma, pero no enumerados por el manual API:

| Región | Base URL observada |
| --- | --- |
| Asia | `https://cloud-as.ruijienetworks.com` |
| Europa | `https://cloud-eu.ruijienetworks.com` |
| Estados Unidos | `https://cloud-us.ruijienetworks.com` |
| Latinoamérica | `https://cloud-la.ruijienetworks.com` |
| Oriente Medio | `https://cloud-me.ruijienetworks.com` |
| Australia/AP | `https://cloud-ap.ruijienetworks.com` |
| Reino Unido | `https://cloud-uk.ruijienetworks.com` |
| Rusia | `https://cloud-a1.ruijienetworks.com` |

No se debe elegir el host por geografía solamente. Debe usarse el host donde reside la cuenta Ruijie Cloud. Un token de una región puede no ser válido en otra.

Variable recomendada:

```text
RUIJIE_BASE_URL=https://cloud-as.ruijienetworks.com
```

## 6. Convenciones HTTP

- Codificación: UTF-8.
- Cuerpo: JSON.
- Header para cuerpos: `Content-Type: application/json`.
- Autenticación de llamadas: query parameter `access_token`.
- Métodos documentados: `GET`, `POST`, `PUT`, `DELETE`.
- Éxito lógico: `code: 0`.
- No confiar solo en HTTP 200: revisar siempre `code` y `msg`.
- Los ejemplos oficiales contienen erratas. Usar las tablas de contrato, no copiar literalmente URLs con `access_tokenaccess_token`.

Respuesta común:

```json
{
  "code": 0,
  "msg": "OK."
}
```

### 6.1 Seguridad importante

Ruijie envía `access_token` en la URL. Las URLs suelen quedar en logs de proxies, APM y servidores. Por tanto:

- Usar HTTPS siempre.
- Redactar `access_token`, `appid` y `secret` de logs. El endpoint de refresh envía los tres en la URL.
- Llamar a Ruijie solo desde backend; nunca desde navegador o app móvil.
- No guardar secretos en repositorio, `localStorage` ni APK.
- Usar un gestor de secretos.
- Restringir los permisos de la aplicación al mínimo.
- Rotar credenciales tras cualquier exposición.

## 7. Autenticación

### 7.1 Obtener access token

**Sección oficial:** 2.1.1  
**Método:** `POST`  
**Path:** `/service/api/oauth20/client/access_token`  
**Query requerida:** `token=d63dss0a81e4415a889ac5b78fsc904a`

El valor de `token` aparece como constante en el manual oficial. No es el `access_token` del tenant.

Body:

| Campo | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `appid` | string | Sí | Application ID entregado por Ruijie. |
| `secret` | string | Sí | Application Secret entregado por Ruijie. |

```bash
curl --request POST \
  "$RUIJIE_BASE_URL/service/api/oauth20/client/access_token?token=d63dss0a81e4415a889ac5b78fsc904a" \
  --header "Content-Type: application/json" \
  --data '{
    "appid": "YOUR_APP_ID",
    "secret": "YOUR_APP_SECRET"
  }'
```

Respuesta:

```json
{
  "code": 0,
  "msg": "OK.",
  "accessToken": "TOKEN_VALUE"
}
```

### 7.2 Duración del token

El manual actual declara:

- Vigencia máxima predeterminada: 30 días.
- Expiración por inactividad: 30 minutos desde el último acceso o actualización.
- `code = 4`: token expirado.

Versiones anteriores del manual mencionan 30 o 60 minutos como duración. La estrategia segura es no codificar una duración fija: reutilizar el token, refrescarlo periódicamente y recuperarse ante `code = 3` o `code = 4`.

### 7.3 Refrescar token

**Sección oficial:** 2.1.2  
**Método:** `GET`  
**Path:** `/service/api/token/refresh`

Query:

| Campo | Tipo | Requerido |
| --- | --- | --- |
| `appid` | string | Sí |
| `secret` | string | Sí |
| `access_token` | string | Sí |

```bash
curl --get "$RUIJIE_BASE_URL/service/api/token/refresh" \
  --data-urlencode "appid=YOUR_APP_ID" \
  --data-urlencode "secret=YOUR_APP_SECRET" \
  --data-urlencode "access_token=YOUR_ACCESS_TOKEN"
```

Respuesta: `accessToken` contiene el token nuevo.

### 7.4 Estrategia backend recomendada

1. Mantener un token por combinación de cuenta y región.
2. Compartirlo entre solicitudes del backend.
3. No solicitar un token por cada llamada.
4. Refrescar antes de una operación si lleva cerca de 30 minutos inactivo.
5. Ante `code = 3` o `4`, renovar una vez y repetir la llamada una vez.
6. Evitar reintentos ilimitados.

## 8. Cuenta y tenant

### 8.1 Consultar cuenta actual

**Sección:** 2.1.3  
**Método:** `GET`  
**Path:** `/service/api/org/account/info`

```bash
curl --get "$RUIJIE_BASE_URL/service/api/org/account/info" \
  --data-urlencode "access_token=YOUR_ACCESS_TOKEN"
```

Campos relevantes:

| Campo | Uso en dashboard |
| --- | --- |
| `accountId` | ID de cuenta autenticada. |
| `account` | Nombre/login. |
| `email` | Email observado en la respuesta; la tabla oficial lo describe ambiguamente como nombre del tenant. |
| `role` | Rol principal, por ejemplo `rootManager`. |
| `tenantRole` | Rol tenant, por ejemplo `TENANT_MANAGER`. |
| `userType` | Tipo, por ejemplo `ROOT`. |
| `defaultTenant` | Tenant predeterminado. |
| `timeZone` | Zona horaria de la cuenta. |
| `twoFactorCheck.enable` | Indicador de 2FA. |

Usar este endpoint durante onboarding para verificar que las credenciales pertenecen a la cuenta esperada.

## 9. Redes y proyectos

### 9.1 Obtener árbol de redes

**Sección:** 2.2.1  
**Método:** `GET`  
**Path:** `/service/api/group/single/tree`

Query:

| Campo | Tipo | Requerido | Valores |
| --- | --- | --- | --- |
| `depth` | string | Sí | `LOCATION`, `BUILDING`, `DEVICE` |
| `access_token` | string | Sí | Token actual. |

El manual contiene la errata `LOCATIOIN`; usar `LOCATION`.

```bash
curl --get "$RUIJIE_BASE_URL/service/api/group/single/tree" \
  --data-urlencode "depth=BUILDING" \
  --data-urlencode "access_token=YOUR_ACCESS_TOKEN"
```

Campos por nodo:

| Campo | Descripción |
| --- | --- |
| `groupId` | ID usado en todos los endpoints de bonos. |
| `name` | Nombre de cliente/proyecto. |
| `timezone` | Zona horaria. |
| `type` | `LOCATION`, `BUILDING` o `DEVICE`. |
| `businessType` | Categoría de negocio. |
| `sceneEnum` | Escenario configurado. |
| `subGroups` | Hijos recursivos. |

El manual dice expresamente que cada cliente puede verse como una red (`Group`) y que el voucher se crea sobre ese `groupId`.

### 9.2 Crear red/proyecto

**Sección:** 2.2.2  
**Método:** `POST`  
**Path:** `/service/api/open/v1/group`

Body:

| Campo | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `pGroupId` | integer | Sí | Grupo padre. |
| `name` | string | Sí | Máximo 32 caracteres; chino, letras inglesas, números y `_`. |
| `type` | string | Sí | `LOCATION`, `BUILDING` o `DEVICE`. |
| `description` | string | No | Máximo 64 caracteres. |
| `longitude` | number | No | Longitud. |
| `latitude` | number | No | Latitud. |
| `businessType` | string | No | `MARKET`, `TRAFFIC`, `AC` o `UNCERTAIN`; el ejemplo usa `ENET`, no listado. |
| `timezone` | string | No | ID IANA, por ejemplo `America/Santo_Domingo`. |

```bash
curl --request POST \
  "$RUIJIE_BASE_URL/service/api/open/v1/group?access_token=YOUR_ACCESS_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "pGroupId": 9391895,
    "name": "Hotel_Centro",
    "type": "BUILDING",
    "timezone": "America/Santo_Domingo",
    "description": "Hotel Centro"
  }'
```

Respuesta relevante: `group.groupId`, `name`, `type`, `createTime`, `description`.

## 10. Paquetes y perfiles

### 10.1 Consultar User Groups

**Sección:** 2.7.1  
**Método:** `GET`  
**Path:** `/service/api/intl/usergroup/list/{groupId}`

Query:

| Campo | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `pageIndex` | integer | Sí | Offset basado en cero, pese al nombre. |
| `pageSize` | integer | Sí | Tamaño; el manual sugiere 1000 para obtener todos. |
| `access_token` | string | Sí | Token actual. |

```bash
curl --get "$RUIJIE_BASE_URL/service/api/intl/usergroup/list/12345" \
  --data-urlencode "pageIndex=0" \
  --data-urlencode "pageSize=1000" \
  --data-urlencode "access_token=YOUR_ACCESS_TOKEN"
```

Campos de cada elemento:

| Campo | Tipo observado | Uso |
| --- | --- | --- |
| `id` | integer | Enviar como `userGroupId`. |
| `userGroupName` | string | Nombre visible del paquete/grupo. |
| `authProfileId` | string numérico | Enviar como `profile`. No convertir a número JS. |
| `createTime` | epoch ms | Fecha de creación. |
| `noOfDevice` | integer | Número actual de usuarios según la tabla oficial; el nombre del campo es ambiguo. |
| `bindMac` | integer | `1` ligado a MAC; `0` no ligado. |
| `timePeriod` | integer | Periodo, observado en minutos. |
| `quota` | number | MB; `0` significa ilimitado. |
| `downloadRateLimit` | integer | Límite de descarga; `0` ilimitado. Unidad no definida inequívocamente. |
| `uploadRateLimit` | integer | Límite de subida; `0` ilimitado. |
| `packageType` | string | Tipo de paquete. |
| `name` | string | Nombre alternativo observado. |
| `description` | string | Descripción del paquete. |
| `updateTime` | epoch ms | Última actualización observada. |

Campos de nivel respuesta, no de cada elemento:

| Campo | Tipo | Uso |
| --- | --- | --- |
| `count` | integer | Total devuelto. |
| `maxAllowNum` | integer | Máximo permitido por la cuenta/proyecto. |

**Importante:** `authProfileId` puede exceder el rango entero seguro de JavaScript. Guardarlo como string.

### 10.2 Crear paquetes

No existe un endpoint público documentado para crear o editar paquetes. Según la [guía UI oficial de Voucher](https://cloud-japan.ruijienetworks.com/wiki2/article/191), deben configurarse en Ruijie Cloud:

`Auth & Account > Voucher > Manage Package > Add Package`

Opciones confirmadas por la guía oficial:

| Opción | Valores/limitaciones |
| --- | --- |
| Nombre | Obligatorio, hasta 32 caracteres; números, letras y `_`. |
| Precio | Opcional, 2 decimales, máximo 100.000.000,00. |
| Dispositivos concurrentes | Ilimitado o 1-9; predeterminado 3. |
| Bind MAC | Desactivado por defecto. |
| Periodo | Ilimitado, 30 min, 1 h, 2 h, 1 d, 2 d, 1 sem, 2 sem, 30 d o personalizado. |
| Cuota | Ilimitada, 100M, 200M, 500M, 1G, 2G o personalizada. |
| Descarga/subida | Ilimitada, 256K, 512K, 1M, 2M, 5M, 10M o personalizada. |

El precio es informativo. La API no cobra ni liquida pagos.

## 11. Gestión de bonos

### 11.1 Generar bonos

**Sección:** 2.3.1  
**Método:** `POST`  
**Path:** `/service/api/open/auth/voucher/create/{groupId}`

Path:

| Campo | Tipo | Requerido |
| --- | --- | --- |
| `groupId` | integer | Sí |

Body:

| Campo | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `quantity` | integer | Sí | Cantidad; máximo 500. |
| `profile` | string | Sí | `authProfileId` obtenido en 2.7.1. |
| `userGroupId` | integer | Sí | `id` obtenido en 2.7.1. |
| `firstName` | string | No | Nombre del huésped. |
| `lastName` | string | No | Apellido. |
| `email` | string | No | Email. La tabla oficial lo escribe `Email`; el ejemplo usa `email`. Preferir `email`. |
| `phone` | string | No | Teléfono. |
| `comment` | string | No | Alias, referencia de venta, reserva o habitación. |

```bash
curl --request POST \
  "$RUIJIE_BASE_URL/service/api/open/auth/voucher/create/12345?access_token=YOUR_ACCESS_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "quantity": 2,
    "profile": "30113648274480073538014045592098",
    "userGroupId": 18067,
    "firstName": "Ana",
    "lastName": "Pérez",
    "email": "ana@example.com",
    "phone": "+18095550100",
    "comment": "Reserva HSP-1042, habitación 403"
  }'
```

Respuesta:

```json
{
  "code": 0,
  "msg": "Success.",
  "voucherData": {
    "code": 0,
    "msg": "OK.",
    "count": 2,
    "list": [
      {
        "uuid": "78eb665b70d44658937db776905676c9",
        "codeNo": "4zr45r",
        "status": "1",
        "profileId": "30113648274480073538014045592098",
        "expiryTime": "2121-09-01 22:48:10",
        "limitClients": 3,
        "qrcodeUrl": "www.ruijienetworks.com",
        "groupId": "1be31cf89904484d8b90fe1784261c06",
        "comment": "Reserva HSP-1042, habitación 403"
      }
    ]
  }
}
```

Validar tanto `code` externo como `voucherData.code` si está presente.

### 11.2 Crear código personalizado

**Sección:** 2.3.2  
**Método:** `POST`  
**Path:** `/service/api/open/auth/voucher/customerCreate/{groupId}/{code}`

Formato documentado de `code`:

```text
xxxx-xxxx
xxxx-xxxx-xxxx
```

Body:

| Campo | Tipo | Requerido |
| --- | --- | --- |
| `groupId` | string | Sí; duplica el path según el manual. |
| `profile` | string | Sí. |
| `userGroupId` | integer | Sí. |

```bash
curl --request POST \
  "$RUIJIE_BASE_URL/service/api/open/auth/voucher/customerCreate/12345/a7kx-9m2q?access_token=YOUR_ACCESS_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "groupId": "12345",
    "profile": "30113648274480073538014045592098",
    "userGroupId": 18067
  }'
```

El ejemplo oficial incluye `tenantId` no documentado y la errata `access_tokenaccess_token`. No incluirlos salvo confirmación de Ruijie para la cuenta.

La respuesta solo confirma `code` y `msg`. No devuelve el objeto creado. Después debe consultarse la lista para verificarlo.

### 11.3 Listar bonos

**Sección:** 2.3.3  
**Método:** `GET`  
**Path:** `/service/api/open/auth/voucher/getList/{groupId}`

Query:

| Campo | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `start` | integer | Sí | Offset basado en cero. |
| `pageSize` | integer | Sí | Entre 1 y 200. |
| `access_token` | string | Sí | Token actual. |

```bash
curl --get "$RUIJIE_BASE_URL/service/api/open/auth/voucher/getList/12345" \
  --data-urlencode "start=0" \
  --data-urlencode "pageSize=200" \
  --data-urlencode "access_token=YOUR_ACCESS_TOKEN"
```

Respuesta real documentada:

```json
{
  "code": 0,
  "msg": "OK.",
  "voucherData": {
    "code": 0,
    "msg": "OK.",
    "count": 13,
    "list": [
      {
        "uuid": "93a88786c5d44d8689fd634bf550ea11",
        "voucherCode": "h3mtkr",
        "nameRef": "Room403 Chan Tai Man",
        "timePeriod": 1440,
        "usedTime": 0,
        "createTime": 1531122313000,
        "maxClients": 3,
        "currentClients": 0,
        "quota": 100,
        "usedQuota": 0,
        "status": "1",
        "qrcodeUrl": "www.ruijienetworks.com",
        "downloadRateLimit": 0,
        "uploadRateLimit": 0,
        "bindMac": 0,
        "packageName": "1DayWiFi"
      }
    ]
  }
}
```

Campos útiles para el dashboard:

| Campo | Interpretación |
| --- | --- |
| `uuid` | ID técnico estable del bono. |
| `voucherCode` | Código entregado al huésped. Al crear se llama `codeNo`. |
| `nameRef` | Alias/referencia. Al crear se envía como `comment`. |
| `status` | `1` sin usar, `2` en uso, `3` expirado. |
| `timePeriod` | Duración, observada en minutos. |
| `usedTime` | Tiempo consumido; unidad no explicitada. |
| `createTime` | Epoch en milisegundos. |
| `maxClients` | Máximo de clientes concurrentes. |
| `currentClients` | Clientes actuales. |
| `quota` | Cuota; ejemplos y perfiles indican MB. |
| `usedQuota` | Cuota consumida. |
| `downloadRateLimit` | Límite de descarga; `0` ilimitado. |
| `uploadRateLimit` | Límite de subida; `0` ilimitado. |
| `bindMac` | Indicador de asociación MAC. |
| `packageName` | Nombre del paquete. |
| `qrcodeUrl` | URL asociada al QR; validar formato antes de usar. |

Paginación completa:

```text
start = 0
while start < voucherData.count:
    GET pageSize=200&start=<start>
    start += cantidad_recibida
```

No incrementar siempre 200 si la API devuelve menos elementos inesperadamente. Detenerse si la lista llega vacía para evitar bucles.

### 11.4 Estados y expiración

| Valor API | Estado de dominio sugerido |
| --- | --- |
| `1` | `unused` |
| `2` | `in_use` |
| `3` | `expired` |

La [guía UI oficial de Voucher](https://cloud-japan.ruijienetworks.com/wiki2/article/191) también menciona estados `activated` y `exhausted`. No están mapeados formalmente a los tres valores del API. Mantener el valor crudo y el normalizado.

La vigencia comienza al activar el bono, según la descripción oficial de `expiryTime`. Este campo es inconsistente: la tabla lo describe como epoch en milisegundos, pero el ejemplo de creación devuelve una fecha string. El listado no muestra `expiryTime` en su ejemplo. El cliente debe aceptar temporalmente `string | number | null` y registrar muestras reales del tenant.

### 11.5 Idempotencia y ventas

El endpoint de creación no acepta una clave de idempotencia. Una repetición por timeout puede crear bonos duplicados.

Flujo seguro para pagos:

1. Verificar el webhook del proveedor de pago.
2. Registrar una orden local única por ID de transacción.
3. Bloquear la orden o usar una restricción única en DB.
4. Marcar `voucher_creation_started` antes de llamar a Ruijie.
5. Enviar el ID de orden en `comment`.
6. Guardar todos los `uuid` y códigos recibidos en la misma transacción local.
7. Ante timeout incierto, buscar/paginar bonos y reconciliar por alias antes de repetir.
8. Entregar el código solo tras confirmar persistencia local.

La API no ofrece búsqueda por alias. La reconciliación exige recorrer páginas o mantener una copia local.

## 12. Funciones de UI relacionadas

La [guía UI oficial de Voucher](https://cloud-japan.ruijienetworks.com/wiki2/article/191) confirma que la interfaz permite:

- Imprimir un bono o lotes de hasta 100.
- Imprimir A4 en una columna o recibo POS.
- Reimprimir buscando código, alias, paquete o MAC.
- Desvincular MAC cuando el bono está activado o agotado.
- Borrar registros de impresión.

Estas acciones no tienen endpoints públicos documentados. El dashboard propio puede generar su propio ticket/QR con los datos obtenidos, pero debe probar qué contiene `qrcodeUrl` y cómo espera el portal el código.

## 13. Cuentas de autenticación

Son una alternativa al bono: usuario y contraseña persistentes.

| Operación | Método | Path |
| --- | --- | --- |
| Crear | `POST` | `/service/api/open/auth/account/create/{groupId}` |
| Eliminar | `DELETE` | `/service/api/open/auth/account/delete/{groupId}` |
| Listar | `GET` | `/service/api/open/auth/account/getList/{groupId}` |
| Actualizar | `POST` | `/service/api/open/auth/account/update/{groupId}` |
| Resetear | `POST` | `/service/api/open/auth/account/reset/{groupId}` |
| Resumen | `GET` | `/service/api/open/auth/account/getStatusSummary/{groupId}` |

### 13.1 Crear cuenta

Body:

```json
{
  "username": "guest-1042",
  "password": "CHANGE_ME",
  "profileId": "30113648274480073538014045592098",
  "userGroupId": 18067,
  "vpnEnable": false,
  "comment": "Reserva HSP-1042"
}
```

El manual tipa `comment` como `Double`, pero el ejemplo lo usa como string. Tratarlo como string.

### 13.2 Eliminar y resetear

El cuerpo es un array de nombres:

```json
["guest-1042", "guest-1043"]
```

El ejemplo de eliminación usa `POST` y ruta `samTransfer`, mientras el contrato declara `DELETE` y ruta `open/auth`. Confirmar estos endpoints en sandbox antes de implementarlos.

### 13.3 Listar cuentas

Filtros opcionales: `start`, `pageSize`, `createBegin`, `createEnd`, `status`, `name`.

Estados: `1` no activada, `2` activada, `3` expirada.

La respuesta puede incluir contraseña en claro según el ejemplo oficial. Nunca mostrarla en listados ni registrarla.

### 13.4 Resumen

`GET .../getStatusSummary/{groupId}` devuelve `total`, `used`, `expired`.

## 14. Cuentas registradas por portal

**Sección:** 3.2.1  
**Método:** `GET`  
**Path:** `/service/api/open/auth/register/getList/{groupId}`

Query:

| Campo | Requerido | Descripción |
| --- | --- | --- |
| `page` | Sí | Página inicial; ejemplo 1. |
| `size` | Sí | Tamaño. |
| `account` | No | Búsqueda por cuenta. |
| `access_token` | Sí | Token. |

La respuesta anida el resultado como `data.success` y `data.result`, con `total` y `list` dentro de `result`. Devuelve datos personales, MAC, IP, consumo, paquete, estado y fechas. Aplicar minimización de datos y control estricto de acceso.

## 15. Clientes conectados

### 15.1 Clientes actuales

**Método:** `GET`  
**Path:** `/service/api/open/v1/dev/user/current-user`

Query documentada:

- `group_id`: uno o varios IDs.
- `page_index`: página.
- `page_size`: tamaño.
- `access_token`: token.

Respuesta: `list` y `totalCount`, con MAC, IP, SSID, dispositivo, tráfico, tasas, RSSI, sistema operativo y fabricante.

### 15.2 Historial online/offline

**Sección:** 2.5.1  
**Método:** `POST`  
**Path:** `/logbizagent/logbiz/api/sta/sta_users`

Body:

```json
{
  "groupId": 12345,
  "pageSize": 100,
  "pageIndex": 0,
  "staType": "currentUser",
  "mac": "",
  "ssid": "",
  "sn": ""
}
```

`staType` acepta `currentUser` u `onofflineUserHistory`.

El dashboard puede usar clientes conectados como métrica operativa, pero el manual no proporciona una relación directa e inequívoca entre cliente y `voucher.uuid`.

## 16. SSID y portal cautivo

### 16.1 Crear o actualizar SSID

**Sección:** 2.8.1  
**Método:** `POST`  
**Path:** `/service/api/open/v1/wifi`

El body incluye `groupId`, `wifiGrpSsid`, `ssidId` opcional y `wirelessConfEntity`.

Campos principales:

- `ssidName`, `ssidEncode`, `relatedRadio`.
- `enable`, `ishidden`, `fowardType`, `vlanId`.
- `encryptionMode`, `password`.
- `authEnable`, `authEntity`.
- `isGuest`, `l2iso`, `preset`.
- Opciones de radio: `axMode`, `beMode`, `wm`, `mlo`, `ftEnable`, `okcEnable`.

Este contrato es amplio y contiene tipos string para booleanos. No usarlo para aprovisionamiento automático hasta capturar un SSID real del modelo de equipo objetivo. La API no documenta claramente cómo crear la plantilla visual del portal cautivo.

### 16.2 Flujo de portal requerido para vouchers

Configuración confirmada por la [guía UI oficial de Voucher](https://cloud-japan.ruijienetworks.com/wiki2/article/191):

1. Seleccionar proyecto.
2. Ir a `Device Config > Basic`.
3. Crear o editar SSID.
4. Habilitar autenticación.
5. Elegir `Captive Portal`.
6. Crear/seleccionar portal.
7. Incluir `Voucher` en `Login Options`.
8. Guardar y asociar el portal.

Sin este flujo, crear bonos por API no hará que el SSID los acepte.

## 17. Errores

Tabla oficial:

| Código | Mensaje | Acción sugerida |
| --- | --- | --- |
| `0` | Éxito | Continuar. |
| `1` | Appid inválido | Verificar credenciales/región. No reintentar automáticamente. |
| `2` | Parámetro inválido | Corregir solicitud. |
| `3` | Token inválido | Renovar una vez. |
| `4` | Token expirado | Renovar una vez. |
| `5` / `16.4` | API no autorizada | Solicitar permiso a Ruijie. |
| `7` | Timeout de ejecución | Reintento controlado; reconciliar si era creación. |
| `25` | En ejecución | Consultar después; no asumir fallo. |
| `-1002` | Error interno | Reintento con backoff; escalar si persiste. |
| `1009` | Login fallido | Revisar causa incluida en el mensaje. |

Política de reintentos:

- `GET`: máximo 3 intentos con backoff exponencial y jitter.
- Creación de bonos: no repetir ciegamente; puede duplicar bonos.
- `code 3/4`: una renovación y una repetición.
- `code 1/2/5/16.4/1009`: no reintentar sin intervención/corrección.
- HTTP `429`: respetar `Retry-After` si aparece.
- HTTP `5xx`: reintento limitado.

## 18. Rate limits, webhooks y sincronización

- Ruijie no publica límites numéricos de tasa en el manual consultado.
- No hay webhooks públicos documentados.
- La sincronización debe hacerse por polling.
- Reutilizar tokens y aplicar caché reduce llamadas.
- Pedir a Ruijie el límite contractual antes del lanzamiento.

Polling inicial sugerido, sujeto a aprobación:

| Recurso | Frecuencia sugerida |
| --- | --- |
| Árbol de redes | 15-60 min o bajo demanda. |
| Paquetes | 15 min o bajo demanda. |
| Bonos activos | 1-5 min. |
| Bonos históricos | 15-60 min. |
| Clientes online | 1-5 min solo en vista operativa. |

## 19. Arquitectura recomendada para el dashboard

```text
Browser reseller
      │ sesión propia
      ▼
SkyTicket Backend
  ├─ RBAC y aislamiento por reseller
  ├─ DB local: ventas, mappings, auditoría
  ├─ Token cache cifrado
  ├─ Ruijie adapter
  └─ Sync/reconciliation jobs
      │ HTTPS + access_token redactado
      ▼
Ruijie Cloud regional
```

No permitir que el frontend elija libremente un `groupId`. Resolverlo desde una relación local autorizada:

```text
reseller_id + site_id -> ruijie_region + tenant_id + group_id
```

Tablas mínimas sugeridas:

```text
ruijie_connections
  id, tenant_id, base_url, appid_secret_ref, token_secret_ref, token_last_used_at

sites
  id, reseller_id, ruijie_connection_id, ruijie_group_id, name, timezone

voucher_packages
  site_id, ruijie_user_group_id, ruijie_profile_id_string, name, limits_json

voucher_orders
  id, reseller_id, site_id, payment_reference_unique, status, requested_quantity

vouchers
  order_id, ruijie_uuid_unique, code_encrypted, raw_status, normalized_status,
  package_name, alias, created_at, last_synced_at, raw_json
```

Los códigos de bono funcionan como credenciales. Cifrarlos en reposo; ocultarlos parcialmente en listados; auditar cada visualización y exportación.

## 20. Flujo end-to-end del dashboard

### 20.1 Onboarding de conexión

1. Guardar región, `appid` y `secret` en gestor de secretos.
2. Obtener token.
3. Consultar `/org/account/info`.
4. Mostrar tenant/rol para confirmación administrativa.
5. Consultar árbol de grupos.
6. Asociar cada `groupId` a un reseller/site local.
7. Consultar User Groups de cada site.
8. Seleccionar qué paquetes puede vender cada revendedor.

### 20.2 Venta y emisión

1. Crear orden local.
2. Procesar pago.
3. Validar pago server-to-server.
4. Tomar bloqueo idempotente por referencia de pago.
5. Resolver `groupId`, `profile` y `userGroupId` autorizados.
6. Crear bonos en Ruijie.
7. Guardar respuesta íntegra y normalizada.
8. Generar ticket/QR propio.
9. Entregar al cliente.
10. Reconciliar estado por polling.

### 20.3 Dashboard del revendedor

Métricas posibles con la API pública:

- Bonos emitidos localmente.
- Bonos sin usar, en uso y expirados.
- Consumo de cuota reportado.
- Clientes actuales por bono, cuando el listado lo informa.
- Ventas, ingresos y comisiones desde DB propia.
- Estado de sincronización y errores.

Métricas no calculables únicamente con Ruijie:

- Cobros confirmados.
- Reembolsos.
- Comisión del revendedor.
- Caja/POS.
- Margen.
- Revocaciones fiables por API.

## 21. OpenAPI público frente a otras APIs Ruijie

No mezclar estas superficies:

| Superficie | Uso | Recomendación |
| --- | --- | --- |
| `/service/api/...` | OpenAPI oficial cloud. | Usar. |
| `/webproxy/common/api` | API interna de la interfaz web con cookies. | No usar en producción. |
| WISPr | Portal externo/hotspot en gateway. | Usar solo si se construirá portal propio. |
| WiFiDog | Portal externo para equipos compatibles. | Usar solo si se construirá portal propio. |
| ePortal campus | Login de redes campus. | No confundir con Cloud API. |
| eWeb | UI local del dispositivo. | No hay API pública localizada. |

Si la API de bonos resulta insuficiente para revocar o autorizar en tiempo real, una arquitectura de portal externo mediante WISPr/WiFiDog puede dar mayor control, pero es otro proyecto: requiere autenticación, accounting y seguridad propios.

## 22. Inconsistencias conocidas del manual

1. Usa `[CloudUriPrefix]`, `[CloudUrlPrefix]` y `[ApiUrlPrefix]` para conceptos parecidos.
2. La sección general muestra HTTP local; los endpoints cloud requieren HTTPS.
3. La duración del token cambió entre snapshots y contiene reglas de vigencia/inactividad.
4. Varios ejemplos escriben `access_tokenaccess_token` por error.
5. Algunos ejemplos añaden `tenantId` e `ishttps` no declarados.
6. Account APIs alternan rutas `open/auth` y `samTransfer`.
7. Delete Account declara `DELETE`, pero el ejemplo usa `POST`.
8. `expiryTime` se documenta como epoch ms, pero un ejemplo devuelve fecha string.
9. Creación devuelve `codeNo`; listado devuelve `voucherCode`.
10. `comment` de creación reaparece como `nameRef` en listado.
11. `authProfileId` está tipado como `Int`, pero el ejemplo es un string decimal de 32 dígitos; debe tratarse como string.
12. `businessType` enumera unos valores, pero el ejemplo usa `ENET`.
13. `pageIndex` de User Groups se describe como offset, no como número de página.
14. Creación usa `limitClients`; listado usa `maxClients` para el límite concurrente.

Estas inconsistencias justifican una capa adaptadora que conserve la respuesta cruda y normalice defensivamente.

## 23. Checklist de validación con sandbox

Antes de desarrollar todo el dashboard:

- [ ] Confirmar host regional.
- [ ] Obtener `appid` y `secret` de prueba.
- [ ] Confirmar permisos de voucher y user groups.
- [ ] Medir vigencia e inactividad real del token.
- [ ] Confirmar formato real de `expiryTime`.
- [ ] Confirmar unidades de `timePeriod`, `usedTime`, cuotas y rate limits.
- [ ] Confirmar `email` frente a `Email`.
- [ ] Confirmar que `customerCreate` exige `groupId` también en body.
- [ ] Confirmar si códigos personalizados distinguen mayúsculas/minúsculas.
- [ ] Confirmar respuesta ante código duplicado.
- [ ] Confirmar comportamiento de creación tras timeout.
- [ ] Confirmar paginación y orden estable de `getList`.
- [ ] Confirmar si existe filtro no documentado por código/alias.
- [ ] Confirmar qué representa y cómo usar `qrcodeUrl`.
- [ ] Confirmar si se puede revocar/deshabilitar un bono mediante endpoint adicional habilitado para la cuenta.
- [ ] Confirmar rate limit y concurrencia permitida.
- [ ] Confirmar retención de datos personales.
- [ ] Probar aislamiento: un revendedor no puede acceder a otro `groupId`.

## 24. Preguntas para Ruijie

Enviar estas preguntas junto con la solicitud técnica:

1. ¿Cuál es la versión vigente del API Reference y su changelog?
2. ¿Cuál es el host correcto para nuestra cuenta y países objetivo?
3. ¿Cuál es el rate limit por `appid`, tenant y endpoint?
4. ¿Existe sandbox?
5. ¿Existe endpoint público para crear/editar paquetes?
6. ¿Existe endpoint público para revocar/eliminar/desactivar voucher?
7. ¿Existe endpoint para unbind MAC?
8. ¿Existe búsqueda de voucher por código, alias, UUID o rango de fechas?
9. ¿Existe API oficial para subcuentas/revendedores y permisos?
10. ¿Existe webhook para activación, agotamiento o expiración?
11. ¿Cuál es la semántica y unidad exacta de cada campo de consumo?
12. ¿Las rutas `samTransfer` siguen vigentes o deben usarse las rutas `open/auth`?
13. ¿Cómo debe manejarse `code = 25`?
14. ¿Qué datos contiene `qrcodeUrl` y puede generarse un QR propio?
15. ¿Hay endpoints PMS/Hospo disponibles mediante acuerdo comercial?

## 25. Alcance recomendado para la primera versión

Implementar primero:

1. Conexión segura y prueba de cuenta.
2. Sincronización de redes y paquetes.
3. Emisión idempotente de bonos generados por Ruijie.
4. Listado y sincronización de estados.
5. Ticket/QR propio.
6. RBAC por revendedor y site.
7. Auditoría, cifrado y redacción de secretos.
8. Reconciliación manual de operaciones inciertas.

Dejar fuera hasta obtener confirmación oficial:

- Creación automática de paquetes.
- Revocación automática.
- Gestión de subcuentas Ruijie.
- API web interna.
- Aprovisionamiento completo de SSID/portal.
- Integración PMS directa.

## 26. Índice rápido de endpoints relevantes

| Área | Método | Endpoint | Confianza |
| --- | --- | --- | --- |
| Token | `POST` | `/service/api/oauth20/client/access_token` | Alta |
| Refresh | `GET` | `/service/api/token/refresh` | Alta |
| Cuenta | `GET` | `/service/api/org/account/info` | Alta |
| Redes | `GET` | `/service/api/group/single/tree` | Alta |
| Crear red | `POST` | `/service/api/open/v1/group` | Alta |
| Perfiles | `GET` | `/service/api/intl/usergroup/list/{groupId}` | Alta |
| Crear bonos | `POST` | `/service/api/open/auth/voucher/create/{groupId}` | Alta |
| Bono personalizado | `POST` | `/service/api/open/auth/voucher/customerCreate/{groupId}/{code}` | Alta, ejemplo defectuoso |
| Listar bonos | `GET` | `/service/api/open/auth/voucher/getList/{groupId}` | Alta |
| Crear cuenta | `POST` | `/service/api/open/auth/account/create/{groupId}` | Media, rutas inconsistentes |
| Eliminar cuenta | `DELETE` | `/service/api/open/auth/account/delete/{groupId}` | Media, método inconsistente |
| Listar cuentas | `GET` | `/service/api/open/auth/account/getList/{groupId}` | Media |
| Actualizar cuenta | `POST` | `/service/api/open/auth/account/update/{groupId}` | Media |
| Resetear cuenta | `POST` | `/service/api/open/auth/account/reset/{groupId}` | Media |
| Resumen cuentas | `GET` | `/service/api/open/auth/account/getStatusSummary/{groupId}` | Media |
| Registrados | `GET` | `/service/api/open/auth/register/getList/{groupId}` | Alta |
| Clientes actuales | `GET` | `/service/api/open/v1/dev/user/current-user` | Alta |
| Historial clientes | `POST` | `/logbizagent/logbiz/api/sta/sta_users` | Alta |
| Wi-Fi | `POST` | `/service/api/open/v1/wifi` | Alta, contrato complejo |

---

Esta guía documenta solo contratos localizados y verificables. Cualquier endpoint adicional observado en DevTools debe tratarse como privado hasta que Ruijie lo confirme por escrito como parte de OpenAPI.
