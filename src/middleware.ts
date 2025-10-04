import { Context, Next } from "hono";
import logger from "./logger";

export const loggingMiddleware = async (c: Context, next: Next) => {
  const start = Date.now();
  const { method, url } = c.req;

  // Log incoming request
  logger.info(
    {
      req: {
        method,
        url,
        headers: c.req.raw.headers,
      },
    },
    "Incoming request"
  );

  try {
    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    // Log response
    logger.info(
      {
        res: {
          statusCode: status,
          headers: c.res.headers,
        },
        duration,
      },
      "Request completed"
    );
  } catch (error) {
    const duration = Date.now() - start;

    // Log error
    logger.error(
      {
        err: error,
        duration,
      },
      "Request failed"
    );

    throw error;
  }
};

export const errorHandler = (error: Error, c: Context) => {
  logger.error(
    {
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
