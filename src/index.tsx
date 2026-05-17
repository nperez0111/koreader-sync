import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { RequestIdVariables } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { db } from "./db";
import { authMiddleware } from "./auth";
import { loggingMiddleware, errorHandler } from "./middleware";
import { rateLimiter } from "./rate-limit";
import logger from "./logger";
import type {
  RegisterRequest,
  ProgressUpdateRequest,
  Progress,
} from "./types";
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

// Rate limit auth-related endpoints
const authRateLimit = rateLimiter({ windowMs: 60_000, max: 10 });
app.use("/users/*", authRateLimit);

// Register endpoint
app.post("/users/create", async (c) => {
  const requestId = c.get("requestId");

  let body: RegisterRequest;
  try {
    body = await c.req.json<RegisterRequest>();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  if (config.auth.disableUserRegistration) {
    logger.warn({ requestId }, "Registration disabled by configuration");
    throw new HTTPException(403, {
      message: "User registration is disabled",
    });
  }

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

  if (body.username.length > 255 || body.password.length > 255) {
    throw new HTTPException(400, {
      message: "Username and password must be 255 characters or fewer",
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
    return c.json({ username: body.username }, 201);
  } catch (error) {
    logger.warn(
      {
        requestId,
        username: body.username,
        error: error instanceof Error ? error.message : String(error),
      },
      "Registration failed: username already exists"
    );
    return c.json({ error: "Username already exists" }, 409);
  }
});

// Auth endpoint
app.get("/users/auth", authMiddleware, (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");
  logger.info({ requestId, userId }, "User authentication successful");
  return c.json({ authorized: "OK" });
});

// Update progress endpoint
app.put("/syncs/progress", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");

  let body: ProgressUpdateRequest;
  try {
    body = await c.req.json<ProgressUpdateRequest>();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const { document, progress, percentage, device, device_id, metadata } = body;

  logger.info(
    {
      requestId,
      userId,
      document,
      percentage,
      device,
      device_id,
      metadata,
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
  const filename = metadata?.filename ?? null;
  const title = metadata?.title ?? null;
  const authors = metadata?.authors ?? null;

  try {
    db.prepare(
      `
      INSERT INTO progress (
        user_id,
        document,
        progress,
        percentage,
        device,
        device_id,
        filename,
        title,
        authors,
        timestamp
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, document) DO UPDATE SET
        progress = excluded.progress,
        percentage = excluded.percentage,
        device = excluded.device,
        device_id = excluded.device_id,
        filename = COALESCE(excluded.filename, progress.filename),
        title = COALESCE(excluded.title, progress.title),
        authors = COALESCE(excluded.authors, progress.authors),
        timestamp = excluded.timestamp
    `
    ).run(
      userId as number,
      document,
      progress,
      percentage,
      device,
      device_id,
      filename,
      title,
      authors,
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
        metadata,
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
      .get(userId as number, document) as Pick<
      Progress,
      "progress" | "percentage" | "device" | "device_id" | "timestamp"
    > | null;

    if (!progress) {
      logger.info({ requestId, userId, document }, "Progress not found");
      return c.json({ status: "not found" }, 404);
    }

    logger.info(
      {
        requestId,
        userId,
        document,
        percentage: progress.percentage,
        device: progress.device,
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

// List all synced documents with metadata for the authenticated user
app.get("/syncs/documents", authMiddleware, (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");

  logger.info({ requestId, userId }, "Documents list requested");

  try {
    const documents = db
      .prepare(
        `
      SELECT document, progress, percentage, device, device_id,
             filename, title, authors, timestamp
      FROM progress
      WHERE user_id = ?
      ORDER BY timestamp DESC
    `
      )
      .all(userId as number);

    logger.info(
      { requestId, userId, count: documents.length },
      "Documents list retrieved"
    );

    return c.json({ documents });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to list documents"
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
        <meta
          name="description"
          content="Keep your reading progress in sync across all your KOReader devices."
        />
        <meta property="og:title" content="KOReader Sync Server" />
        <meta
          property="og:description"
          content="Keep your reading progress in sync across all your KOReader devices."
        />
        <meta property="og:image" content="/public/logo.jpg" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="KOReader Sync Server" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" />
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
        <style>{`
          :root {
            --color-bg: #ffffff;
            --color-text: #1f2937;
            --color-text-muted: #4b5563;
            --color-accent: #2563eb;
            --color-accent-hover: #1d4ed8;
            --color-surface: #f3f4f6;
            --color-surface-alt: #f0f9ff;
            --color-code-bg: #1e1e1e;
            --color-code-text: #d4d4d4;
            --color-border: rgba(0, 0, 0, 0.1);
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --color-bg: #111827;
              --color-text: #f3f4f6;
              --color-text-muted: #9ca3af;
              --color-accent: #60a5fa;
              --color-accent-hover: #93bbfd;
              --color-surface: #1f2937;
              --color-surface-alt: #1e293b;
              --color-code-bg: #0d1117;
              --color-code-text: #e6edf3;
              --color-border: rgba(255, 255, 255, 0.1);
            }
          }
          body {
            background-color: var(--color-bg);
            color: var(--color-text);
            margin: 0;
          }
          a { color: var(--color-accent); }
          a:hover { color: var(--color-accent-hover); }
          code {
            background-color: var(--color-surface);
            padding: 0.125rem 0.375rem;
            border-radius: 0.25rem;
            font-size: 0.9em;
          }
          h2 { color: var(--color-text); }
        `}</style>
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
                  color: "var(--color-accent)",
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
                  color: "var(--color-text-muted)",
                }}
              >
                Keep your reading progress in sync across all your KOReader
                devices.
              </p>

              <p
                style={{
                  marginBottom: "2rem",
                  padding: "0.75rem",
                  backgroundColor: "var(--color-surface-alt)",
                  borderRadius: "0.5rem",
                  display: "inline-block",
                }}
              >
                <a
                  href="https://github.com/nperez0111/koreader-sync"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "var(--color-accent)",
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
                    "0 4px 6px -1px var(--color-border), 0 2px 4px -2px var(--color-border)",
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
              backgroundColor: "var(--color-code-bg)",
              padding: "1rem",
              borderRadius: "0.5rem",
              overflow: "auto",
              marginBottom: "1rem",
            }}
          >
            <pre
              style={{
                color: "var(--color-code-text)",
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
      test: ["CMD", "wget" ,"--no-verbose", "--tries=1", "--spider", "http://localhost:3000/health"]
      interval: 5m
      timeout: 3s
    restart: unless-stopped
    volumes:
      - data:/app/data

volumes:
  data:`}
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
              backgroundColor: "var(--color-surface)",
              borderRadius: "0.5rem",
            }}
          >
            <strong>Note:</strong> This server allows registration by any
            username and password by default. Set
            <code> DISABLE_USER_REGISTRATION=true</code> to block new account
            creation.
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
    rewriteRequestPath: (path) => path.replace(/^\/public/, ""),
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
