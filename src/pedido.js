/**
 * POST /api/pedido — lo atiende src/worker.js (Cloudflare Worker).
 *
 * Recibe un pedido desde el checkout, verifica los precios contra data/tienda.json
 * y avisa a la empresa por email (Resend) y por WhatsApp (CallMeBot).
 *
 * Variables de entorno (Cloudflare → Worker → Settings → Variables and Secrets):
 *   RESEND_API_KEY     clave de resend.com (secreta)
 *   ORDER_EMAIL_TO     email de la empresa que recibe los pedidos (ej. ventas@empresa.com)
 *   ORDER_EMAIL_FROM   remitente; sin dominio propio verificado usar "Pedidos <onboarding@resend.dev>"
 *   CUSTOMER_COPY      "true" para mandar copia al cliente (requiere dominio verificado en Resend)
 *   CALLMEBOT_PHONE    celular de la empresa con código de país, ej. 59899123456
 *   CALLMEBOT_APIKEY   clave que CallMeBot envía por WhatsApp al activarlo (secreta)
 *   TEXTMEBOT_PHONE    alternativa a CallMeBot: celular que recibe, ej. +59897355233
 *   TEXTMEBOT_APIKEY   clave de textmebot.com (secreta)
 * Cualquier canal sin configurar se omite.
 */

const PAYS = { transferencia: 'Transferencia bancaria', efectivo: 'Efectivo al recibir / retirar', tarjeta: 'Tarjeta de crédito o débito' };
const MAX_BODY = 20000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const str = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const money = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return 'US$ ' + v.toLocaleString('es-UY', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function handlePedido(request, env) {

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'Pedido demasiado grande' }, 413);
  let o;
  try { o = JSON.parse(raw); } catch { return json({ ok: false, error: 'Formato inválido' }, 400); }

  // Campo trampa para bots: el formulario lo deja vacío.
  if (o && o.website) return json({ ok: true, email: false, whatsapp: false });

  const c = o && o.customer ? o.customer : {};
  const order = {
    id: str(o.id, 20) || 'NG-' + Date.now().toString(36).toUpperCase().slice(-6),
    pay: PAYS[o.pay] ? o.pay : 'efectivo',
    delivery: o.delivery === 'retiro' ? 'retiro' : 'envio',
    customer: {
      name: str(c.name, 80), email: str(c.email, 120), phone: str(c.phone, 30), doc: str(c.doc, 20),
      dept: str(c.dept, 40), city: str(c.city, 60), addr: str(c.addr, 160), notes: str(c.notes, 500),
    },
    items: Array.isArray(o.items) ? o.items.slice(0, 50) : [],
    coupon: str(o.coupon, 30), disc: Number(o.disc) || 0, ship: Number(o.ship) || 0, shipLabel: str(o.shipLabel, 60),
    adj: Number(o.adj) || 0, adjLabel: str(o.adjLabel, 60), sub: Number(o.sub) || 0, total: Number(o.total) || 0,
  };
  const cu = order.customer;
  if (!cu.name || !cu.phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cu.email) || !order.items.length)
    return json({ ok: false, error: 'Faltan datos del pedido' }, 400);

  // Verificar precios contra el catálogo publicado.
  let catalog = null;
  try {
    const r = await env.ASSETS.fetch(new URL('/data/tienda.json', request.url));
    if (r.ok) catalog = (await r.json()).products || null;
  } catch { /* sin catálogo: se informa tal cual */ }

  let sub = 0; const warnings = [];
  const lines = order.items.map((it) => {
    const qty = Math.max(1, Math.min(99, Math.round(Number(it.qty) || 1)));
    let name = str(it.name, 120), color = str(it.color, 40), price = Number(it.price) || 0;
    if (catalog) {
      const p = catalog.find((x) => x.id === it.id);
      if (!p || p.active === false) warnings.push(`Producto no encontrado en el catálogo: ${name}`);
      else {
        const v = (p.colors || []).find((x) => x.n === color) || (p.colors || [])[0];
        const real = Number((v && v.price) || p.price) || 0;
        if (Math.abs(real - price) > 0.01) warnings.push(`Precio de "${p.name}" modificado: ${money(price)} → ${money(real)} (se usa el del catálogo)`);
        name = p.name; price = real; if (v) color = v.n;
      }
    }
    sub += price * qty;
    return { name, color, qty, price };
  });
  sub = Math.round(sub * 100) / 100;
  if (Math.abs(sub - order.sub) > 0.01) warnings.push(`El subtotal enviado (${money(order.sub)}) no coincide con el catálogo (${money(sub)}). Revisar el total antes de confirmar.`);
  const total = Math.round((sub - order.disc + order.ship + order.adj) * 100) / 100;

  // Texto común.
  const entrega = order.delivery === 'retiro' ? 'Retiro en showroom' : `${cu.addr}, ${cu.city}, ${cu.dept}`;
  const txt = [
    `🛒 Nuevo pedido ${order.id}`, '',
    ...lines.map((l) => `• ${l.qty} × ${l.name} (${l.color}) — ${money(l.price * l.qty)}`), '',
    `Subtotal: ${money(sub)}`,
    ...(order.disc ? [`Descuento ${order.coupon}: −${money(order.disc)}`] : []),
    `${order.shipLabel || 'Envío'}: ${order.ship ? money(order.ship) : 'Gratis'}`,
    ...(order.adj ? [`${order.adjLabel}: ${order.adj < 0 ? '−' : '+'}${money(Math.abs(order.adj))}`] : []),
    `TOTAL: ${money(total)}`, '',
    `Pago: ${PAYS[order.pay]}`,
    `Entrega: ${entrega}`,
    `Cliente: ${cu.name}`, `Celular: ${cu.phone}`, `Email: ${cu.email}`,
    ...(cu.doc ? [`CI: ${cu.doc}`] : []),
    ...(cu.notes ? [`Notas: ${cu.notes}`] : []),
    ...(warnings.length ? ['', '⚠️ ' + warnings.join('\n⚠️ ')] : []),
  ].join('\n');

  const tasks = [];
  let emailOk = false, waOk = false;

  // Email a la empresa (y opcionalmente al cliente) con Resend.
  if (env.RESEND_API_KEY && env.ORDER_EMAIL_TO) {
    const from = env.ORDER_EMAIL_FROM || 'Pedidos <onboarding@resend.dev>';
    const rows = lines.map((l) => `<tr><td style="padding:6px 0">${l.qty} × ${esc(l.name)} <span style="color:#777">(${esc(l.color)})</span></td><td style="padding:6px 0;text-align:right">${money(l.price * l.qty)}</td></tr>`).join('');
    const html = (title, intro) => `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1a1a1a">
      <h2 style="margin:0 0 8px">${esc(title)}</h2><p style="margin:0 0 16px;color:#555">${intro}</p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #ddd">${rows}
      <tr><td style="padding:6px 0;border-top:1px solid #ddd">Subtotal</td><td style="text-align:right;border-top:1px solid #ddd">${money(sub)}</td></tr>
      ${order.disc ? `<tr><td>Descuento ${esc(order.coupon)}</td><td style="text-align:right">−${money(order.disc)}</td></tr>` : ''}
      <tr><td>${esc(order.shipLabel || 'Envío')}</td><td style="text-align:right">${order.ship ? money(order.ship) : 'Gratis'}</td></tr>
      ${order.adj ? `<tr><td>${esc(order.adjLabel)}</td><td style="text-align:right">${order.adj < 0 ? '−' : '+'}${money(Math.abs(order.adj))}</td></tr>` : ''}
      <tr><td style="padding:8px 0;font-weight:bold;border-top:1px solid #ddd">Total</td><td style="text-align:right;font-weight:bold;border-top:1px solid #ddd">${money(total)}</td></tr></table>
      <p style="margin:16px 0 4px"><b>Pago:</b> ${esc(PAYS[order.pay])}<br><b>Entrega:</b> ${esc(entrega)}</p>
      <p style="margin:0"><b>Cliente:</b> ${esc(cu.name)}<br><b>Celular:</b> ${esc(cu.phone)}<br><b>Email:</b> ${esc(cu.email)}${cu.doc ? `<br><b>CI:</b> ${esc(cu.doc)}` : ''}${cu.notes ? `<br><b>Notas:</b> ${esc(cu.notes)}` : ''}</p>
      ${warnings.length ? `<p style="background:#fff4e5;padding:10px;margin-top:16px">⚠️ ${warnings.map(esc).join('<br>⚠️ ')}</p>` : ''}</div>`;
    const send = (payload) => fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    tasks.push(send({
      from, to: env.ORDER_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean), reply_to: cu.email,
      subject: `Nuevo pedido ${order.id} — ${money(total)} — ${cu.name}`,
      html: html(`Nuevo pedido ${order.id}`, `Pago: ${esc(PAYS[order.pay])}. Respondé este email para escribirle al cliente.`), text: txt,
    }).then((r) => { emailOk = r.ok; if (!r.ok) return r.text().then((t) => console.log('Resend', r.status, t)); }).catch((e) => console.log('Resend', e)));
    if (env.CUSTOMER_COPY === 'true') {
      tasks.push(send({
        from, to: [cu.email], reply_to: env.ORDER_EMAIL_TO.split(',')[0].trim(),
        subject: `Recibimos tu pedido ${order.id}`,
        html: html(`¡Gracias, ${cu.name.split(' ')[0]}!`, `Recibimos tu pedido ${esc(order.id)}. Te contactamos al ${esc(cu.phone)} para coordinar ${order.delivery === 'retiro' ? 'el retiro' : 'la entrega'}.`),
      }).catch(() => {}));
    }
  }

  // WhatsApp a la empresa con CallMeBot.
  if (env.CALLMEBOT_PHONE && env.CALLMEBOT_APIKEY) {
    const u = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(env.CALLMEBOT_PHONE) +
      '&text=' + encodeURIComponent(txt) + '&apikey=' + encodeURIComponent(env.CALLMEBOT_APIKEY);
    tasks.push(fetch(u).then((r) => { waOk = waOk || r.ok; }).catch((e) => console.log('CallMeBot', e)));
  }

  // WhatsApp con TextMeBot (alternativa paga, US$1/mes para enviarte a vos mismo).
  if (env.TEXTMEBOT_APIKEY && env.TEXTMEBOT_PHONE) {
    const u = 'https://api.textmebot.com/send.php?recipient=' + encodeURIComponent(env.TEXTMEBOT_PHONE) +
      '&apikey=' + encodeURIComponent(env.TEXTMEBOT_APIKEY) + '&text=' + encodeURIComponent(txt);
    tasks.push(fetch(u).then((r) => { waOk = waOk || r.ok; }).catch((e) => console.log('TextMeBot', e)));
  }

  await Promise.all(tasks);
  return json({ ok: emailOk || waOk, email: emailOk, whatsapp: waOk, id: order.id, total });
}

export { json };
