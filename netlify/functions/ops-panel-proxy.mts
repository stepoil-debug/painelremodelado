import type { Config } from '@netlify/functions';

const DEFAULT_API_URL = 'https://qxmxtbjxkhecqilpnhgq.supabase.co/functions/v1/ops-panel-api';

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'Use POST.' }, {
      status: 405,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const backendSecret = Netlify.env.get('OPS_PANEL_BACKEND_SECRET')?.trim() || '';
  const apiUrl = Netlify.env.get('OPS_PANEL_API_URL')?.trim() || DEFAULT_API_URL;

  if (!backendSecret) {
    return Response.json({ ok: false, error: 'Proxy operacional sem credencial de backend.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const body = await request.text();
  const upstream = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-step-backend-key': backendSecret,
    },
    body,
    cache: 'no-store',
  });

  const responseBody = await upstream.text();
  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
};

export const config: Config = {
  path: '/api/ops-panel',
};
