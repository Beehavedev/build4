const ASTER_TARGET = "https://fapi3.asterdex.com";
const PROXY_SECRET = "8b38ccf2b2971e4ee611c0167ebf44c2";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", target: ASTER_TARGET }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (!url.pathname.startsWith("/proxy/")) {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("x-proxy-secret") !== PROXY_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    const targetPath = url.pathname.replace("/proxy/", "");
    const targetUrl = `${ASTER_TARGET}/${targetPath}${url.search}`;

    const headers = new Headers();
    const forward = ["content-type", "aster-signature", "aster-nonce", "aster-address"];
    for (const h of forward) {
      const val = request.headers.get(h);
      if (val) headers.set(h, val);
    }

    try {
      const fetchOpts = {
        method: request.method,
        headers,
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOpts.body = await request.arrayBuffer();
      }

      const response = await fetch(targetUrl, fetchOpts);
      const body = await response.text();

      return new Response(body, {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") || "application/json",
          "access-control-allow-origin": "*",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Proxy error", detail: err.message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
