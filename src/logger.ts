import pino from "pino";

// Create logger instance
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

export default logger;
