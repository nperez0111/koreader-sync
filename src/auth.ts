import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "./db";
import config from "./config";
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

  if (!username || !password) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const user = db
    .prepare("SELECT id, username, password FROM users WHERE username = ?")
    .get(username) as User | null;

  const saltedPassword = password + config.password.salt;
  if (!user || !(await Bun.password.verify(saltedPassword, user.password))) {
    throw new HTTPException(401, { message: "Invalid credentials" });
  }

  c.set("userId", user.id);
  await next();
}
