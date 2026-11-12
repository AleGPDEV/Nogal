# Nogal — Tienda online de muebles

Tienda online en un solo archivo (`index.html`), sin servidor. Incluye catálogo con filtros, ficha de producto con colores, carrito, cupones, cálculo de envío por departamento, checkout con validación y envío del pedido por WhatsApp.

## Editar productos y datos de la tienda

Todo está en **`data/tienda.json`**:

- `products`: cada mueble con `name`, `price`, `compare` (precio anterior, 0 si no hay oferta), `stock`, `material`, `dims`, `desc`, `colors` (nombre + color hex), `cat` (`living`, `comedor`, `dormitorio`, `oficina`, `almacenamiento`, `iluminacion`), `type` (ilustración), `featured` (aparece en inicio) y `active` (visible o no).
- `config`: nombre de la tienda, **`whatsapp` (obligatorio para recibir pedidos)**, teléfono, email, dirección, horario, datos bancarios (`bank`), costos de envío (`shipMvd`, `shipInt`, `freeFrom`), garantía, recargo por tarjeta (`cardFee`, en %), descuento por transferencia o efectivo (`cashDisc`, en %) y cupones.

Para cambiar algo, editá el archivo en GitHub y guardá los cambios (commit). El sitio se actualiza solo en uno o dos minutos.

## Publicar en Cloudflare Pages (gratis)

1. Entrá a dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Elegí este repositorio.
3. Framework preset: **None**. Build command: vacío. Output directory: `/`.
4. **Save and Deploy**. Queda en `https://<nombre>.pages.dev`.
5. Opcional: en **Custom domains** conectás el dominio propio.

## Cómo llegan los pedidos

Al confirmar, el cliente ve el resumen y un botón **Enviar pedido por WhatsApp** con todo el detalle (productos, total, datos de entrega y forma de pago). Los pedidos no se guardan en un servidor: se gestionan por WhatsApp.

## Próximos pasos posibles

- Panel de administración con base de datos (editar productos y ver pedidos desde la web).
- Cobro con tarjeta en línea a través de una pasarela (por ejemplo, Plexo).
