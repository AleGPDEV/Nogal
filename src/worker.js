import { handlePedido, json } from './pedido.js';

// Las páginas, fotos y data/tienda.json se sirven como archivos estáticos.
// Este Worker solo atiende /api/pedido.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/pedido') {
      if (request.method === 'GET') {
        // Diagnóstico: solo indica si cada variable existe, nunca su valor.
        const has = (k) => Boolean(env[k] && String(env[k]).trim());
        return json({
          worker: 'ok',
          email: { RESEND_API_KEY: has('RESEND_API_KEY'), ORDER_EMAIL_TO: has('ORDER_EMAIL_TO'), ORDER_EMAIL_FROM: has('ORDER_EMAIL_FROM') },
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
