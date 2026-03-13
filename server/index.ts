import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startAgentRunner } from "./agent-runner";
import { checkAndExecuteMilestones } from "./chaos-launch";

process.on("uncaughtException", (err) => {
  console.error("[CRASH] Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH] Unhandled rejection:", reason);
});
process.on("SIGTERM", () => console.log("[SIGNAL] SIGTERM received"));
process.on("SIGINT", () => console.log("[SIGNAL] SIGINT received"));
process.on("exit", (code) => console.log(`[EXIT] Process exiting with code ${code}`));

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.get("/", (_req, res, next) => {
  if (_req.headers["user-agent"]?.includes("health") || _req.headers["x-healthcheck"]) {
    return res.status(200).send("OK");
  }
  next();
});

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    log(`${req.method} ${req.path} ${res.statusCode} in ${duration}ms`);
  });
  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      if (process.env.NODE_ENV === "production" && process.env.AGENT_RUNNER_ENABLED === "true") {
        setTimeout(() => startAgentRunner(), 3000);
      } else if (process.env.NODE_ENV !== "production") {
        log("Agent runner skipped in development to save memory. Runs in production.");
      } else {
        log("Agent runner disabled — only real user-initiated actions allowed. Set AGENT_RUNNER_ENABLED=true to enable autonomous mode.");
      }

      const CHAOS_CHECK_INTERVAL = 60_000;
      setInterval(async () => {
        try {
          await checkAndExecuteMilestones();
        } catch (e: any) {
          log(`[ChaosLaunch] Milestone check error: ${e.message}`, "chaos");
        }
      }, CHAOS_CHECK_INTERVAL);
      log("Chaos milestone auto-executor started (checks every 60s)");
    },
  );
})();
