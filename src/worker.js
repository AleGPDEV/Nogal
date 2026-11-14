import { handlePedido, json } from './pedido.js';

// Las páginas, fotos y data/tienda.json se sirven como archivos estáticos.
// Este Worker solo atiende /api/pedido.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/pedido') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Usá POST' }, 405);
      try { return await handlePedido(request, env); }
      catch (e) { console.log('pedido', e); return json({ ok: false, error: 'Error interno' }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
