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
 *   PLEXO_CLIENT_ID, PLEXO_API_KEY, PLEXO_MERCHANT_ID  credenciales de Plexo (secretas): habilitan el pago con tarjeta
 *   PLEXO_ENV          "production" para cobrar de verdad; si no, usa el entorno de pruebas
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

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ---------------- Plexo ---------------- */
export const plexoReady = (env) => Boolean(env.PLEXO_CLIENT_ID && env.PLEXO_API_KEY && env.PLEXO_MERCHANT_ID);
const plexoBase = (env) => env.PLEXO_BASE_URL || (env.PLEXO_ENV === 'production' ? 'https://api.plexo.com.uy' : 'https://api.testing.plexo.com.uy');
async function plexo(env, method, path, body) {
  const r = await fetch(plexoBase(env) + path, {
    method,
    headers: { Authorization: 'Basic ' + btoa(`${env.PLEXO_CLIENT_ID}:${env.PLEXO_API_KEY}`), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); let data = null; try { data = JSON.parse(t); } catch { /* no JSON */ }
  if (!r.ok) throw new Error(`Plexo ${method} ${path} → ${r.status}: ${t.slice(0, 300)}`);
  return data;
}

async function createCheckout(env, o) {
  const suffix = Date.now().toString(36).toUpperCase();
  const [firstName, ...rest] = o.buyer.name.split(/\s+/);
  const session = await plexo(env, 'POST', '/v1/sessions', {
    merchantId: Number(env.PLEXO_MERCHANT_ID),
    referenceId: `${o.id}-${suffix}`,
    type: 'checkout',
    paymentRequest: {
      referenceId: o.id,
      invoiceNumber: `${o.id}-${suffix}`,
      installments: 1,
      amount: { total: o.total, currency: o.currency },
      buyer: { name: o.buyer.name, firstName, lastName: rest.join(' ') || undefined, email: o.buyer.email, phone: o.buyer.phone },
    },
    settings: {
      callbacks: { paymentCallbackUrl: o.callbackUrl },
      redirects: { defaultUrl: o.okUrl, cancelUrl: o.cancelUrl },
    },
  });
  const acts = (session && session.actions) || [];
  const a = acts.find((x) => String(x.method).toUpperCase() === 'REDIRECT') || acts.find((x) => x.href);
  if (!a || !a.href) throw new Error('Plexo no devolvió la URL de pago');
  return a.href;
}

const STATUS_ES = { approved: 'aprobado', authorized: 'autorizado', denied: 'rechazado', cancelled: 'cancelado', expired: 'vencido', failed: 'fallido', refunded: 'reembolsado', 'partially-refunded': 'reembolsado en parte' };

// Plexo avisa acá cuando cambia un pago. El aviso no viene firmado, así que el estado
// se vuelve a consultar a Plexo con nuestras credenciales antes de notificar.
export async function handlePlexoCallback(request, env, ctx) {
  if (!plexoReady(env)) return json({ ok: false }, 404);
  let body = null; try { body = await request.json(); } catch { /* vacío */ }
  const id = body && /^[0-9a-f]{32}$/i.test(String(body.id || '')) ? String(body.id) : '';
  if (!id) return json({ ok: false, error: 'Sin id de pago' }, 400);
  ctx.waitUntil((async () => {
    try {
      const p = await plexo(env, 'GET', `/v1/payments/${id}`);
      const mid = p && p.merchant && (p.merchant.id ?? p.merchant.merchantId);
      if (mid != null && String(mid) !== String(env.PLEXO_MERCHANT_ID)) return;
      const st = String(p.status || '');
      if (!STATUS_ES[st]) return; // created / pending: todavía no hay resultado
      // Evitar avisos repetidos si Plexo reintenta.
      const key = new Request(`https://avisos.nogal/plexo/${id}/${st}`);
      const cache = caches.default;
      if (await cache.match(key)) return;
      await cache.put(key, new Response('1', { headers: { 'cache-control': 'max-age=604800' } }));
      const ok = st === 'approved' || st === 'authorized';
      const amt = p.amount ? `${p.amount.currency === 'UYU' ? '$' : 'US$'} ${Number(p.amount.total).toLocaleString('es-UY', { maximumFractionDigits: 2 })}` : '';
      const card = p.paymentMethod && p.paymentMethod.card;
      const cardTxt = card ? ` (${[card.brand || card.issuer, card.last4 ? '•••• ' + card.last4 : ''].filter(Boolean).join(' ')})` : '';
      const title = `${ok ? '✅' : '❌'} Pago con tarjeta ${STATUS_ES[st]} — pedido ${p.referenceId || ''}`;
      const text = [title, `Monto: ${amt}${cardTxt}`, `Id de pago Plexo: ${id}`, ok ? 'Ya podés coordinar la entrega.' : 'El cliente puede reintentar o elegir otro medio de pago.'].join('\n');
      await notify(env, title, text);
    } catch (e) { console.log('Plexo callback', String(e)); }
  })());
  return json({ ok: true });
}

// La página consulta acá el estado del pago al volver de Plexo (solo devuelve el estado).
export async function handlePagoEstado(request, env) {
  if (!plexoReady(env)) return json({ status: 'unknown' });
  const ref = String(new URL(request.url).searchParams.get('pedido') || '').slice(0, 20);
  if (!/^NG-[A-Z0-9]{3,12}$/.test(ref)) return json({ status: 'unknown' }, 400);
  try {
    const q = await plexo(env, 'GET', `/v1/payments/query?ReferenceId=${encodeURIComponent(ref)}&MerchantId=${encodeURIComponent(env.PLEXO_MERCHANT_ID)}&Size=10`);
    const list = Array.isArray(q) ? q : (q && (q.data || q.items || q.payments || q.results || Object.values(q).find(Array.isArray))) || [];
    const mine = list.filter((x) => x && x.referenceId === ref);
    if (!mine.length) return json({ status: 'pending' });
    const rank = (s) => (s === 'approved' || s === 'authorized' ? 3 : s === 'pending' || s === 'created' ? 1 : 2);
    mine.sort((a, b) => rank(b.status) - rank(a.status) || String(b.createdAt).localeCompare(String(a.createdAt)));
    return json({ status: mine[0].status || 'pending' });
  } catch (e) { console.log('Plexo estado', String(e)); return json({ status: 'unknown' }); }
}

// Aviso corto a la empresa por los mismos canales que los pedidos.
async function notify(env, subject, text) {
  const tasks = [];
  if (env.RESEND_API_KEY && env.ORDER_EMAIL_TO) {
    tasks.push(fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.ORDER_EMAIL_FROM || 'Pedidos <onboarding@resend.dev>', to: env.ORDER_EMAIL_TO.split(',').map((x) => x.trim()).filter(Boolean), subject, text }),
    }).catch((e) => console.log('Resend', e)));
  }
  if (env.CALLMEBOT_PHONE && env.CALLMEBOT_APIKEY) {
    tasks.push(fetch('https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(env.CALLMEBOT_PHONE) + '&text=' + encodeURIComponent(text) + '&apikey=' + encodeURIComponent(env.CALLMEBOT_APIKEY)).catch(() => {}));
  }
  if (env.TEXTMEBOT_APIKEY && env.TEXTMEBOT_PHONE) {
    tasks.push(fetch('https://api.textmebot.com/send.php?recipient=' + encodeURIComponent(env.TEXTMEBOT_PHONE) + '&apikey=' + encodeURIComponent(env.TEXTMEBOT_APIKEY) + '&text=' + encodeURIComponent(text)).catch(() => {}));
  }
  await Promise.all(tasks);
}

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
  let catalog = null, cfg = {};
  try {
    const r = await env.ASSETS.fetch(new URL('/data/tienda.json', request.url));
    if (r.ok) { const d = await r.json(); catalog = d.products || null; cfg = d.config || {}; }
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
  sub = r2(sub);
  // Recalcular descuento, envío y recargo con la configuración publicada (igual que la página).
  if (catalog) {
    const cp = (cfg.coupons || []).find((x) => x.active !== false && String(x.code).toUpperCase() === order.coupon.toUpperCase());
    order.disc = !cp ? 0 : cp.type === 'pct' ? r2(sub * Math.min(100, Number(cp.value) || 0) / 100) : Math.min(sub, Number(cp.value) || 0);
    if (!cp) order.coupon = '';
    const after = sub - order.disc;
    if (order.delivery === 'retiro') { order.ship = 0; order.shipLabel = 'Retiro en showroom'; }
    else if (Number(cfg.freeFrom) > 0 && after >= Number(cfg.freeFrom)) { order.ship = 0; order.shipLabel = 'Envío gratis'; }
    else { order.ship = cu.dept === 'Montevideo' ? Number(cfg.shipMvd) || 0 : Number(cfg.shipInt) || 0; order.shipLabel = 'Envío a ' + (cu.dept || 'domicilio'); }
    const base = after + order.ship;
    order.adj = 0; order.adjLabel = '';
    if (order.pay === 'tarjeta' && Number(cfg.cardFee) > 0) { order.adj = r2(base * Number(cfg.cardFee) / 100); order.adjLabel = `Recargo tarjeta (${Number(cfg.cardFee)}%)`; }
    else if (order.pay !== 'tarjeta' && Number(cfg.cashDisc) > 0) { order.adj = -r2(base * Number(cfg.cashDisc) / 100); order.adjLabel = `Descuento ${order.pay} (${Number(cfg.cashDisc)}%)`; }
  }
  const total = r2(sub - order.disc + order.ship + order.adj);
  if (Math.abs(total - order.total) > 0.01) warnings.push(`El total enviado por la página (${money(order.total)}) no coincide con el calculado (${money(total)}). Vale el calculado.`);

  // Pago con tarjeta: crear la sesión de Plexo antes de avisar.
  let redirect = '';
  if (order.pay === 'tarjeta' && plexoReady(env)) {
    const origin = new URL(request.url).origin;
    try {
      redirect = await createCheckout(env, {
        id: order.id, total, currency: cfg.currency === 'UYU' ? 'UYU' : 'USD',
        buyer: { name: cu.name, email: cu.email, phone: cu.phone },
        okUrl: `${origin}/pago/ok?pedido=${encodeURIComponent(order.id)}`,
        cancelUrl: `${origin}/pago/cancelado?pedido=${encodeURIComponent(order.id)}`,
        callbackUrl: `${origin}/api/plexo/callback`,
      });
    } catch (e) {
      console.log('Plexo session', String(e));
      return json({ ok: false, error: 'No pudimos iniciar el pago con tarjeta. Probá de nuevo o elegí otro medio de pago.' }, 502);
    }
  }

  // Texto común.
  const entrega = order.delivery === 'retiro' ? 'Retiro en showroom' : `${cu.addr}, ${cu.city}, ${cu.dept}`;
  const txt = [
    `🛒 Nuevo pedido ${order.id}${redirect ? ' — esperando pago con tarjeta' : ''}`, '',
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
  let emailOk = false, waOk = false, emailError = '';

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
      subject: `Nuevo pedido ${order.id} — ${money(total)} — ${cu.name}${redirect ? ' (esperando pago con tarjeta)' : ''}`,
      html: html(`Nuevo pedido ${order.id}`, `Pago: ${esc(PAYS[order.pay])}.${redirect ? ' El cliente está pagando con tarjeta: te avisamos cuando Plexo confirme el pago.' : ''} Respondé este email para escribirle al cliente.`), text: txt,
    }).then((r) => { emailOk = r.ok; if (!r.ok) return r.text().then((t) => { console.log('Resend', r.status, t); let m = ''; try { m = JSON.parse(t).message || ''; } catch {} emailError = `Resend ${r.status}: ${String(m || t).slice(0, 200)}`; }); }).catch((e) => { console.log('Resend', e); emailError = 'Resend: ' + String(e).slice(0, 200); }));
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
  return json({ ok: emailOk || waOk || Boolean(redirect), ...(redirect ? { redirect } : {}), email: emailOk, whatsapp: waOk, ...(emailError ? { emailError } : {}), ...(!env.RESEND_API_KEY || !env.ORDER_EMAIL_TO ? { emailConfig: 'faltan RESEND_API_KEY u ORDER_EMAIL_TO' } : {}), id: order.id, total });
}

export { json };
