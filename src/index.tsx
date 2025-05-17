import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "./db";
import { authMiddleware } from "./auth";
import { RegisterRequest, ProgressUpdateRequest } from "./types";
import config from "./config";

type Variables = {
  userId: number;
};

const app = new Hono<{ Variables: Variables }>();

// Helper function to hash password with salt
async function hashPasswordWithSalt(password: string): Promise<string> {
  const saltedPassword = password + config.password.salt;
  return await Bun.password.hash(saltedPassword);
}

// Register endpoint
app.post("/users/create", async (c) => {
  const body = await c.req.json<RegisterRequest>();

  if (!body.username || !body.password) {
    throw new HTTPException(400, {
      message: "Username and password are required",
    });
  }

  try {
    const hashedPassword = await hashPasswordWithSalt(body.password);
    db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(
      body.username,
      hashedPassword
    );

    return c.json({ status: "success" }, 201);
  } catch (error) {
    return c.json({ error: "Username already exists" }, 402);
  }
});

// Auth endpoint
app.get("/users/auth", authMiddleware, (c) => {
  return c.json({ status: "authenticated" });
});

// Update progress endpoint
app.put("/syncs/progress", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<ProgressUpdateRequest>();

  const { document, progress, percentage, device, device_id } = body;

  if (
    !document ||
    !progress ||
    percentage === undefined ||
    !device ||
    !device_id
  ) {
    throw new HTTPException(400, { message: "Missing required fields" });
  }

  const timestamp = Math.floor(Date.now() / 1000);

  db.prepare(
    `
    INSERT OR REPLACE INTO progress (
      user_id, 
      document, 
      progress, 
      percentage, 
      device, 
      device_id, 
      timestamp
    ) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    userId as number,
    document,
    progress,
    percentage,
    device,
    device_id,
    timestamp
  );

  return c.json({ status: "success" }, 200);
});

// Get progress endpoint
app.get("/syncs/progress/:document", authMiddleware, (c) => {
  const userId = c.get("userId");
  const document = c.req.param("document");

  const progress = db
    .prepare(
      `
    SELECT progress, percentage, device, device_id, timestamp
    FROM progress
    WHERE user_id = ? AND document = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `
    )
    .get(userId as number, document);

  if (!progress) {
    return c.json({ status: "not found" }, 404);
  }

  return c.json(progress);
});

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

app.get("/", (c) => {
  return c.html(
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: "800px",
        margin: "0 auto",
        padding: "2rem",
        lineHeight: "1.6",
      }}
    >
      <h1 style={{ color: "#2563eb" }}>KOReader Sync Server</h1>

      <p>
        Welcome to KOReader Sync Server! This is a lightweight synchronization
        server for KOReader devices, built with Bun and Hono.
      </p>

      <h2>Getting Started</h2>
      <p>To use this sync server with your KOReader device:</p>
      <ol>
        <li>Create a new user account by choosing any username and password</li>
        <li>
          On your KOReader device, go to Settings → Network → Sync → Add new
          sync account
        </li>
        <li>Select "Generic WebDAV/HTTP Sync Server"</li>
        <li>Enter this server's URL as the server address</li>
        <li>Use your chosen username and password for authentication</li>
      </ol>

      <p
        style={{
          marginTop: "2rem",
          padding: "1rem",
          backgroundColor: "#f3f4f6",
          borderRadius: "0.5rem",
        }}
      >
        <strong>Note:</strong> This server uses secure password hashing and
        follows KOReader's authentication protocol to ensure your reading data
        remains private and secure.
      </p>
    </div>
  );
});

export default app;
