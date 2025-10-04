import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { RequestIdVariables } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { db } from "./db";
import { authMiddleware } from "./auth";
import { loggingMiddleware, errorHandler } from "./middleware";
import logger from "./logger";
import type { RegisterRequest, ProgressUpdateRequest } from "./types";
import config from "./config";

type Variables = {
  userId: number;
} & RequestIdVariables;

const app = new Hono<{ Variables: Variables }>();

// Add secure headers middleware
app.use(
  "*",
  secureHeaders({
    // Disable X-Frame-Options for API endpoints (not needed for JSON API)
    xFrameOptions: false,
    // Keep X-XSS-Protection disabled (modern browsers handle this better)
    xXssProtection: false,
    // Set a more restrictive CSP for the HTML landing page
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  })
);

// Add request ID middleware
app.use("*", requestId());

// Add logging middleware
app.use("*", loggingMiddleware);

// Add error handler
app.onError(errorHandler);

// Register endpoint
app.post("/users/create", async (c) => {
  const body = await c.req.json<RegisterRequest>();
  const requestId = c.get("requestId");

  logger.info(
    { requestId, username: body.username },
    "User registration attempt"
  );

  if (!body.username || !body.password) {
    logger.warn(
      { requestId, username: body.username },
      "Registration failed: missing credentials"
    );
    throw new HTTPException(400, {
      message: "Username and password are required",
    });
  }

  try {
    const saltedPassword = body.password + config.password.salt;
    const hashedPassword = await Bun.password.hash(saltedPassword);
    db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(
      body.username,
      hashedPassword
    );

    logger.info(
      { requestId, username: body.username },
      "User registered successfully"
    );
    return c.json({ status: "success" }, 201);
  } catch (error) {
    logger.warn(
      {
        requestId,
        username: body.username,
        error: error instanceof Error ? error.message : String(error),
      },
      "Registration failed: username already exists"
    );
    return c.json({ error: "Username already exists" }, 402);
  }
});

// Auth endpoint
app.get("/users/auth", authMiddleware, (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");
  logger.info({ requestId, userId }, "User authentication successful");
  return c.json({ status: "authenticated" });
});

// Update progress endpoint
app.put("/syncs/progress", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");
  const body = await c.req.json<ProgressUpdateRequest>();

  const { document, progress, percentage, device, device_id } = body;

  logger.info(
    {
      requestId,
      userId,
      document,
      percentage,
      device,
      device_id,
    },
    "Progress update received"
  );

  if (
    !document ||
    !progress ||
    percentage === undefined ||
    !device ||
    !device_id
  ) {
    logger.warn(
      { requestId, userId, body },
      "Progress update failed: missing required fields"
    );
    throw new HTTPException(400, { message: "Missing required fields" });
  }

  const timestamp = Math.floor(Date.now() / 1000);

  try {
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

    logger.info(
      {
        requestId,
        userId,
        document,
        percentage,
        device,
        device_id,
      },
      "Progress updated successfully"
    );

    return c.json({ status: "success" }, 200);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        document,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to update progress"
    );
    throw error;
  }
});

// Get progress endpoint
app.get("/syncs/progress/:document", authMiddleware, (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");
  const document = c.req.param("document");

  logger.info({ requestId, userId, document }, "Progress retrieval requested");

  try {
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
      logger.info({ requestId, userId, document }, "Progress not found");
      return c.json({ status: "not found" }, 404);
    }

    logger.info(
      {
        requestId,
        userId,
        document,
        percentage: (progress as any).percentage,
        device: (progress as any).device,
      },
      "Progress retrieved successfully"
    );

    return c.json(progress);
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        document,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to retrieve progress"
    );
    throw error;
  }
});

app.get("/health", (c) => {
  const requestId = c.get("requestId");
  logger.debug({ requestId }, "Health check requested");
  return c.json({ status: "ok" });
});

app.get("/", (c) => {
  return c.html(
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta property="og:title" content="KOReader Sync Server" />
        <meta
          property="og:description"
          content="A lightweight synchronization server for KOReader devices"
        />
        <meta property="og:image" content="/public/logo.jpg" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="KOReader Sync Server" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/public/apple-touch-icon.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/public/favicon-32x32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/public/favicon-16x16.png"
        />
        <link rel="manifest" href="/public/site.webmanifest" />
        <title>KOReader Sync Server</title>
      </head>
      <body>
        <div
          style={{
            fontFamily: "system-ui, -apple-system, sans-serif",
            maxWidth: "800px",
            margin: "0 auto",
            padding: "2rem",
            lineHeight: "1.6",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "2rem",
              marginBottom: "2rem",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1", minWidth: "300px" }}>
              <h1
                style={{
                  color: "#2563eb",
                  margin: 0,
                  fontSize: "2.5rem",
                  lineHeight: "1.2",
                }}
              >
                KOReader Sync Server
              </h1>
              <p
                style={{
                  fontSize: "1.125rem",
                  marginTop: "1rem",
                  color: "#4b5563",
                }}
              >
                A lightweight synchronization server for KOReader devices, built
                with Bun and Hono.
              </p>

              <p
                style={{
                  marginBottom: "2rem",
                  padding: "0.75rem",
                  backgroundColor: "#f0f9ff",
                  borderRadius: "0.5rem",
                  display: "inline-block",
                }}
              >
                <a
                  href="https://github.com/nperez0111/koreader-sync"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "#2563eb",
                    textDecoration: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  📦 View source code on GitHub
                </a>
              </p>
            </div>

            <div
              style={{
                flex: "0 0 auto",
                maxWidth: "250px",
                width: "100%",
              }}
            >
              <img
                src="/public/logo.jpg"
                alt="KOReader Sync Server"
                style={{
                  width: "100%",
                  height: "auto",
                  borderRadius: "8px",
                  boxShadow:
                    "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
                }}
              />
            </div>
          </div>

          <h2>Getting Started</h2>
          <p>To use this sync server with your KOReader device:</p>
          <ol>
            <li>
              Open a document on your KOReader device and navigate to Settings →
              Progress Sync → Custom sync server. Enter this server's URL.
            </li>
            <li>
              Select "Register / Login" to create an account or sign in with
              your credentials.
            </li>
            <li>
              Test the connection by selecting "Push progress from this device
              now". You'll receive a confirmation message.
            </li>
            <li>
              Enable automatic progress syncing in the settings if desired.
            </li>
          </ol>

          <h2>Self-Hosting Guide</h2>
          <p>Set up your own sync server easily using Docker Compose:</p>

          <div
            style={{
              backgroundColor: "#1e1e1e",
              padding: "1rem",
              borderRadius: "0.5rem",
              overflow: "auto",
              marginBottom: "1rem",
            }}
          >
            <pre
              style={{
                color: "#d4d4d4",
                margin: 0,
                fontFamily: "monospace",
              }}
            >
              {`services:
  kosync:
    image: ghcr.io/nperez0111/koreader-sync:latest
    container_name: kosync
    ports:
      - 3000:3000
    healthcheck:
      test: ["CMD", "wget" ,"--no-verbose", "--tries=1", "--spider", "http://localhost/health"]
      interval: 5m
      timeout: 3s
    restart: unless-stopped
    volumes:
      - data:/app/data`}
            </pre>
          </div>

          <ol style={{ marginBottom: "2rem" }}>
            <li>Create a new directory for your sync server</li>
            <li>
              Save the above configuration as <code>docker-compose.yml</code>
            </li>
            <li>
              Run <code>docker compose up -d</code> to start the server
            </li>
            <li>
              Your server will be available at{" "}
              <code>http://localhost:3000</code>
            </li>
            <li>
              The SQLite database will be automatically persisted in a Docker
              volume at <code>/app/data</code>
            </li>
          </ol>

          <p
            style={{
              marginTop: "2rem",
              padding: "1rem",
              backgroundColor: "#f3f4f6",
              borderRadius: "0.5rem",
            }}
          >
            <strong>Note:</strong> This server allows registration by any
            username and password. It does not require any authentication to
            access the sync server.
          </p>
        </div>
      </body>
    </html>
  );
});

app.use(
  "/public/*",
  serveStatic({
    root: "./public",
    rewriteRequestPath: (path) => path.replace(/^\/public/, "./"),
    mimes: {
      css: "text/css",
      svg: "image/svg+xml",
      jpg: "image/jpeg",
      mp4: "video/mp4",
      woff2: "font/woff2",
    },
  })
);

// Log startup
logger.info("KOReader Sync Server starting up");

export default app;
