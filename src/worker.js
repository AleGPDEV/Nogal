import { handlePedido, handlePlexoCallback, handlePagoEstado, plexoReady, json } from './pedido.js';

// Las páginas, fotos y data/tienda.json se sirven como archivos estáticos.
// Este Worker atiende /api/pedido, el pago con Plexo y la vuelta desde la página de pago.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/plexo/callback' && request.method === 'POST') return handlePlexoCallback(request, env, ctx);
    if (url.pathname === '/api/pago' && request.method === 'GET') return handlePagoEstado(request, env);
    // Vuelta desde Plexo: se redirige a la tienda con un enlace limpio.
    const m = url.pathname.match(/^\/pago\/(ok|cancelado)\/?$/);
    if (m) {
      const pedido = String(url.searchParams.get('pedido') || '').replace(/[^A-Z0-9-]/gi, '').slice(0, 20);
      return Response.redirect(`${url.origin}/?pago=${m[1]}&pedido=${encodeURIComponent(pedido)}#pago`, 302);
    }
    if (url.pathname === '/api/pedido') {
      if (request.method === 'GET') {
        // Diagnóstico: solo indica si cada variable existe, nunca su valor.
        const has = (k) => Boolean(env[k] && String(env[k]).trim());
        return json({
          worker: 'ok',
          email: { RESEND_API_KEY: has('RESEND_API_KEY'), ORDER_EMAIL_TO: has('ORDER_EMAIL_TO'), ORDER_EMAIL_FROM: has('ORDER_EMAIL_FROM') },
          tarjeta: plexoReady(env), plexoEnv: plexoReady(env) ? (env.PLEXO_ENV === 'production' ? 'production' : 'testing') : null,
          whatsapp: { CALLMEBOT_PHONE: has('CALLMEBOT_PHONE'), CALLMEBOT_APIKEY: has('CALLMEBOT_APIKEY'), TEXTMEBOT_PHONE: has('TEXTMEBOT_PHONE'), TEXTMEBOT_APIKEY: has('TEXTMEBOT_APIKEY') },
        });
      }
      if (request.method !== 'POST') return json({ ok: false, error: 'Usá POST' }, 405);
      try { return await handlePedido(request, env); }
      catch (e) { console.log('pedido', e); return json({ ok: false, error: 'Error interno' }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
