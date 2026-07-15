import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { RequestIdVariables } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { Context, Next } from "hono";
import pino from "pino";

// =============================================================================
// Types
// =============================================================================

interface User {
  id: number;
  username: string;
  password: string;
  created_at: Date;
}

interface DocumentMetadata {
  filename?: string;
  title?: string;
  authors?: string;
}

interface Progress {
  id: number;
  user_id: number;
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
  filename: string | null;
  title: string | null;
  authors: string | null;
  timestamp: number;
}

interface RegisterRequest {
  username: string;
  password: string;
}

interface ProgressUpdateRequest {
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
  metadata?: DocumentMetadata;
}

// =============================================================================
// Config
// =============================================================================

interface Config {
  password: {
    salt: string;
  };
  auth: {
    disableUserRegistration: boolean;
  };
  server: {
    port: number;
    host: string;
  };
}

const config: Config = {
  password: {
    salt: process.env.PASSWORD_SALT || "default_salt_change_in_production",
  },
  auth: {
    disableUserRegistration:
      process.env.DISABLE_USER_REGISTRATION?.toLowerCase() === "true",
  },
  server: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "0.0.0.0",
  },
};

// =============================================================================
// Logger
// =============================================================================

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  serializers: {
    req: (req: any) => ({
      method: req.method,
      url: req.url,
      headers: req.headers
        ? {
            "user-agent": req.headers["user-agent"],
            "content-type": req.headers["content-type"],
            authorization: req.headers["authorization"]
              ? "[REDACTED]"
              : undefined,
          }
        : undefined,
    }),
    res: (res: any) => ({
      statusCode: res.statusCode,
      headers: res.headers
        ? {
            "content-type": res.headers["content-type"],
          }
        : undefined,
    }),
  },
});

// =============================================================================
// Database
// =============================================================================

const db = new Database("data/koreader-sync.db", {
  create: true,
});

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    document TEXT NOT NULL,
    progress TEXT NOT NULL,
    percentage REAL NOT NULL,
    device TEXT NOT NULL,
    device_id TEXT NOT NULL,
    filename TEXT,
    title TEXT,
    authors TEXT,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(user_id, document)
  )
`);

// Migrate existing databases to include metadata columns
const progressColumns = db
  .prepare(`PRAGMA table_info(progress)`)
  .all() as { name: string }[];
const existingColumnNames = new Set(progressColumns.map((c) => c.name));
for (const column of ["filename", "title", "authors"]) {
  if (!existingColumnNames.has(column)) {
    db.run(`ALTER TABLE progress ADD COLUMN ${column} TEXT`);
  }
}

db.run(
  `CREATE INDEX IF NOT EXISTS idx_progress_document ON progress(document)`
);
db.run(`CREATE INDEX IF NOT EXISTS idx_progress_user_id ON progress(user_id)`);

// =============================================================================
// Rate Limiter
// =============================================================================

interface RateLimitOptions {
  windowMs: number;
  max: number;
}

function rateLimiter({ windowMs, max }: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
  }, windowMs);

  return async (c: Context, next: Next) => {
    const key =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
      if (entry.count > max) {
        throw new HTTPException(429, { message: "Too many requests" });
      }
    }

    await next();
  };
}

// =============================================================================
// Middleware
// =============================================================================

const loggingMiddleware = async (c: Context, next: Next) => {
  const start = Date.now();
  const { method, url } = c.req;
  const requestId = c.get("requestId");

  logger.info(
    {
      requestId,
      req: {
        method,
        url,
      },
    },
    "Incoming request"
  );

  try {
    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    logger.info(
      {
        requestId,
        res: {
          statusCode: status,
        },
        duration,
      },
      "Request completed"
    );
  } catch (error) {
    const duration = Date.now() - start;
    const requestId = c.get("requestId");

    logger.error(
      {
        requestId,
        err: error,
        duration,
      },
      "Request failed"
    );

    throw error;
  }
};

const errorHandler = (error: Error, c: Context) => {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  const requestId = c.get("requestId");

  logger.error(
    {
      requestId,
      err: error,
      req: {
        method: c.req.method,
        url: c.req.url,
      },
    },
    "Unhandled error"
  );

  return c.json({ error: "Internal server error" }, 500);
};

// =============================================================================
// Auth
// =============================================================================

type AuthVariables = {
  userId: number;
};

async function authMiddleware(
  c: Context<{ Variables: AuthVariables }>,
  next: Next
) {
  const username = c.req.header("x-auth-user");
  const password = c.req.header("x-auth-key");
  const requestId = c.get("requestId");

  logger.debug({ requestId, username }, "Authentication attempt");

  if (!username || !password) {
    logger.warn(
      { requestId, username },
      "Authentication failed: missing credentials"
    );
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const user = db
    .prepare("SELECT id, username, password FROM users WHERE username = ?")
    .get(username) as User | null;

  const saltedPassword = password + config.password.salt;
  if (!user || !(await Bun.password.verify(saltedPassword, user.password))) {
    logger.warn(
      { requestId, username },
      "Authentication failed: invalid credentials"
    );
    throw new HTTPException(401, { message: "Invalid credentials" });
  }

  logger.info(
    { requestId, userId: user.id, username },
    "Authentication successful"
  );
  c.set("userId", user.id);
  await next();
}

// =============================================================================
// App
// =============================================================================

type Variables = {
  userId: number;
} & RequestIdVariables;

const app = new Hono<{ Variables: Variables }>();

// Add secure headers middleware
app.use(
  "*",
  secureHeaders({
    xFrameOptions: false,
    xXssProtection: false,
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

    return c.json({ document, ...progress });
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
          content="A self-hostable sync server for KOReader. Keeps reading progress in sync across all your devices."
        />
        <meta property="og:title" content="KOReader Sync Server" />
        <meta
          property="og:description"
          content="A self-hostable sync server for KOReader. Keeps reading progress in sync across all your devices."
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
                A self-hostable sync server for KOReader. Keeps reading progress
                in sync across all your devices.
              </p>

              <ul
                style={{
                  color: "var(--color-text-muted)",
                  paddingLeft: "1.25rem",
                  margin: "0.75rem 0",
                  lineHeight: "1.8",
                }}
              >
                <li>
                  Less than 1,000 lines of TypeScript in a single file
                </li>
                <li>SQLite database — no external services needed</li>
                <li>Runs on Docker — nothing else to install</li>
              </ul>

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
                  View source on GitHub
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

          <h2>Connecting KOReader</h2>
          <ol>
            <li>
              Open a document on your KOReader device and go to Settings →
              Progress Sync → Custom sync server
            </li>
            <li>Enter this server's URL</li>
            <li>
              Select "Register / Login" to create an account
            </li>
            <li>
              Test with "Push progress from this device now"
            </li>
            <li>
              Enable automatic progress syncing if desired
            </li>
          </ol>

          <h2>Self-Hosting</h2>
          <p>
            <strong>Requirements:</strong> Docker. That's it.
          </p>

          <h3 style={{ fontSize: "1.1rem" }}>Quick Start</h3>
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
              {`docker run -d -p 3000:3000 -v koreader-data:/app/data ghcr.io/nperez0111/koreader-sync:latest`}
            </pre>
          </div>
          <p>
            The server is now running at <code>http://localhost:3000</code>.
            The SQLite database is persisted in the{" "}
            <code>koreader-data</code> volume.
          </p>

          <h3 style={{ fontSize: "1.1rem" }}>Docker Compose</h3>
          <p>For a more permanent setup:</p>
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
    restart: unless-stopped
    volumes:
      - data:/app/data

volumes:
  data:`}
            </pre>
          </div>
          <p>
            Save as <code>docker-compose.yml</code> and run{" "}
            <code>docker compose up -d</code>.
          </p>

          <p
            style={{
              marginTop: "2rem",
              padding: "1rem",
              backgroundColor: "var(--color-surface)",
              borderRadius: "0.5rem",
            }}
          >
            <strong>Note:</strong> Registration is open by default. Set{" "}
            <code>DISABLE_USER_REGISTRATION=true</code> to block new
            accounts after you've registered.
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
