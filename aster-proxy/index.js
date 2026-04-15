const express = require("express");
const app = express();

const ASTER_TARGET = "https://fapi3.asterdex.com";
const PROXY_SECRET = process.env.PROXY_SECRET || "";

app.use(express.raw({ type: "*/*", limit: "1mb" }));

app.all("/proxy/*", async (req, res) => {
  if (PROXY_SECRET && req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const targetPath = req.params[0];
  const url = `${ASTER_TARGET}/${targetPath}${req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : ""}`;

  const headers = {};
  const forward = ["content-type", "aster-signature", "aster-nonce", "aster-address"];
  for (const h of forward) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  try {
    const fetchOpts = {
      method: req.method,
      headers,
    };
    if (req.method !== "GET" && req.method !== "HEAD" && req.body && req.body.length > 0) {
      fetchOpts.body = req.body;
    }

    const response = await fetch(url, fetchOpts);
    const body = await response.text();

    res.status(response.status);
    const ct = response.headers.get("content-type");
    if (ct) res.set("content-type", ct);
    res.send(body);
  } catch (err) {
    console.error("[PROXY] Error:", err.message);
    res.status(502).json({ error: "Proxy error", detail: err.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", target: ASTER_TARGET });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[ASTER-PROXY] Running on port ${PORT}, forwarding to ${ASTER_TARGET}`);
});
