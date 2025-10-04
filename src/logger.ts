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
    req: (req: Request) => ({
      method: req.method,
      url: req.url,
      headers: {
        "user-agent": req.headers["user-agent"],
        "content-type": req.headers["content-type"],
        authorization: req.headers["authorization"] ? "[REDACTED]" : undefined,
      },
    }),
    res: (res: Response) => ({
      statusCode: res.statusCode,
      headers: {
        "content-type": res.headers["content-type"],
      },
    }),
  },
});

export default logger;
