import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "./db";
import config from "./config";
import logger from "./logger";
import type { User } from "./types";

type Variables = {
  userId: number;
};

export async function authMiddleware(
  c: Context<{ Variables: Variables }>,
  next: Next
) {
  const username = c.req.header("x-auth-user");
  const password = c.req.header("x-auth-key");
  const requestId = c.get("requestId");

  logger.debug({ requestId, username }, "Authentication attempt");

  if (!username || !password) {
    logger.warn({ requestId, username }, "Authentication failed: missing credentials");
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const user = db
    .prepare("SELECT id, username, password FROM users WHERE username = ?")
    .get(username) as User | null;

  const saltedPassword = password + config.password.salt;
  if (!user || !(await Bun.password.verify(saltedPassword, user.password))) {
    logger.warn({ requestId, username }, "Authentication failed: invalid credentials");
    throw new HTTPException(401, { message: "Invalid credentials" });
  }

  logger.info({ requestId, userId: user.id, username }, "Authentication successful");
  c.set("userId", user.id);
  await next();
}
