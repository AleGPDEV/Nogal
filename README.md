# Nogal — Tienda online de muebles

Tienda online en un solo archivo (`index.html`), sin servidor. Incluye catálogo con filtros, ficha de producto con colores, carrito, cupones, cálculo de envío por departamento, checkout con validación y envío del pedido por WhatsApp.

## Editar productos y datos de la tienda

Todo está en **`data/tienda.json`**:

- `products`: cada mueble con `name`, `price`, `compare` (precio anterior, 0 si no hay oferta), `stock`, `material`, `dims`, `desc`, `colors` (nombre + color hex), `cat` (`dormitorio`, `cocina`, `comedor`, `living`), `type` (ilustración), `featured` (aparece en inicio) y `active` (visible o no).
- `config`: nombre de la tienda, **`whatsapp` (obligatorio para recibir pedidos)**, teléfono, email, dirección, horario, datos bancarios (`bank`), costos de envío (`shipMvd`, `shipInt`, `freeFrom`), garantía, recargo por tarjeta (`cardFee`, en %), descuento por transferencia o efectivo (`cashDisc`, en %) y cupones.

**Fotos:** subí la imagen a la carpeta `img/` y en el producto agregá `"image": "img/nombre.jpg"`. Sin foto, se muestra una ilustración.

Para cambiar algo, editá el archivo en GitHub y guardá los cambios (commit). El sitio se actualiza solo en uno o dos minutos.

## Publicar en Cloudflare Pages (gratis)

1. Entrá a dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Elegí este repositorio.
3. Framework preset: **None**. Build command: vacío. Output directory: `/`.
4. **Save and Deploy**. Queda en `https://<nombre>.pages.dev`.
5. Opcional: en **Custom domains** conectás el dominio propio.

## Cómo llegan los pedidos

Al confirmar, la página envía el pedido a `functions/api/pedido.js` (una función de Cloudflare Pages). La función verifica los precios contra `data/tienda.json` y avisa a la empresa:

- **Email** con el detalle del pedido, mediante [Resend](https://resend.com). Al responder ese email, le escribís directo al cliente.
- **WhatsApp** al celular de la empresa, mediante [CallMeBot](https://www.callmebot.com) (gratis, uso personal, con cupos limitados) o [TextMeBot](https://textmebot.com) (US$1/mes). Configurás uno de los dos.

Si la función no está configurada o falla, el cliente ve el botón **Enviar pedido por WhatsApp** como respaldo.

### Configurar los avisos (una sola vez)

1. **Email:** creá una cuenta gratis en resend.com **con el email que va a recibir los pedidos**. En *API Keys* creá una clave.
   Sin dominio propio, Resend solo deja enviar al email de esa cuenta; con un dominio verificado podés enviar a cualquier dirección y mandar copia al cliente.
2. **WhatsApp:** desde el celular que va a recibir los pedidos, seguí los pasos de callmebot.com → *WhatsApp* (agendás su número y le mandás el mensaje de activación). Te responde con tu `apikey`.
3. En Cloudflare: **Workers & Pages** → el proyecto → **Settings** → **Variables and Secrets** → agregá, en *Production*:

| Variable | Valor |
|---|---|
| `RESEND_API_KEY` | la clave de Resend (tipo *Secret*) |
| `ORDER_EMAIL_TO` | el email que recibe los pedidos |
| `ORDER_EMAIL_FROM` | `Pedidos <onboarding@resend.dev>` (o uno de tu dominio verificado) |
| `CALLMEBOT_PHONE` | celular con código de país, sin `+` ni espacios: `598` + el número sin el 0 |
| `CALLMEBOT_APIKEY` | la apikey de CallMeBot (tipo *Secret*) |
| `TEXTMEBOT_PHONE` | alternativa a CallMeBot: celular con `+` y código de país, ej. `+598...` |
| `TEXTMEBOT_APIKEY` | la apikey de textmebot.com (tipo *Secret*) |
| `CUSTOMER_COPY` | opcional: `true` para mandar copia al cliente (requiere dominio verificado) |

4. **Deployments** → en el último despliegue, **Retry deployment** para que tome las variables.

### Medios de pago

En `config.payMethods` de `data/tienda.json` elegís qué opciones ve el cliente: `transferencia`, `efectivo` y `tarjeta`. La tarjeta está oculta hasta integrar la pasarela de pago.

## Próximos pasos posibles

- Panel de administración con base de datos (editar productos y ver pedidos desde la web).
- Cobro con tarjeta en línea a través de una pasarela (por ejemplo, Plexo).
