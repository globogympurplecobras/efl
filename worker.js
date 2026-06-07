/**
 * Cloudflare Worker — football-data.org CORS proxy
 *
 * Deploy steps:
 *   1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. Paste this file, click Save & Deploy
 *   3. In the worker's Settings → Variables → add:
 *        FOOTBALL_DATA_KEY = <your football-data.org API key>
 *   4. Copy your worker URL (e.g. https://efl-proxy.your-subdomain.workers.dev)
 *      and paste it into match-prep.html as the PROXY_BASE value
 *
 * The worker forwards any /v4/... request to api.football-data.org,
 * injects the API key server-side, and adds CORS headers to the response.
 */

export default {
  async fetch(request, env) {
    // Only allow GET
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    // ── Route: /af/* → api-football (API-Sports) ──
    if (url.pathname.startsWith('/af/')) {
      const afPath = url.pathname.slice(3); // strip /af → e.g. /fixtures
      const target = 'https://v3.football.api-sports.io' + afPath + url.search;
      let upstream;
      try {
        upstream = await fetch(target, {
          headers: {
            'x-apisports-key': env.AF_KEY,
            'Accept': 'application/json',
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'AF upstream fetch failed', detail: String(err) }), {
          status: 502,
          headers: corsHeaders('application/json'),
        });
      }
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: corsHeaders('application/json'),
      });
    }

    // ── Route: /v4/* → football-data.org ──
    if (!url.pathname.startsWith('/v4/')) {
      return new Response('Not found', { status: 404 });
    }

    const target = 'https://api.football-data.org' + url.pathname + url.search;

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: {
          'X-Auth-Token': env.FOOTBALL_DATA_KEY,
          'Accept': 'application/json',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: String(err) }), {
        status: 502,
        headers: corsHeaders('application/json'),
      });
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: corsHeaders('application/json'),
    });
  },
};

function corsHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
