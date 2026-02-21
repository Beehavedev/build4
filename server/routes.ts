import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { registerWeb4Routes } from "./web4-routes";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  registerWeb4Routes(app);

  await storage.cleanFakeData();
  await storage.seedInferenceProviders();

  return httpServer;
}
