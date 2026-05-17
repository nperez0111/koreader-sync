import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import logger from "./logger";

export const loggingMiddleware = async (c: Context, next: Next) => {
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

export const errorHandler = (error: Error, c: Context) => {
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
