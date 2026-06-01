const winston = require("winston");
const morgan = require("morgan");
const admin = require("firebase-admin");

// ─── Winston Logger ───
const logLevel = process.env.LOG_LEVEL || "info";

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "grocery-server" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 1
            ? JSON.stringify(meta, null, 2)
            : "";
          return `${timestamp} [${level}]: ${message} ${metaStr}`;
        })
      ),
    }),
  ],
});

if (process.env.NODE_ENV === "production") {
  logger.add(
    new winston.transports.File({ filename: "logs/error.log", level: "error", maxsize: 5242880, maxFiles: 5 })
  );
  logger.add(
    new winston.transports.File({ filename: "logs/combined.log", maxsize: 5242880, maxFiles: 5 })
  );
}

// ─── Morgan HTTP logging via Winston ───
const morganMiddleware = morgan(
  (tokens, req, res) => {
    return [
      tokens.method(req, res),
      tokens.url(req, res),
      tokens.status(req, res),
      tokens["response-time"](req, res), "ms",
      "-",
      tokens.res(req, res, "content-length") || "0",
    ].join(" ");
  },
  {
    stream: {
      write: (message) => logger.info(message.trim()),
    },
  }
);

// ─── Firestore Error Logging ───
async function logErrorToFirestore(err, req = null) {
  try {
    const logEntry = {
      message: err.message,
      stack: err.stack?.substring(0, 2000) || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      code: err.code || null,
      status: err.status || null,
    };
    if (req) {
      logEntry.method = req.method;
      logEntry.path = req.path;
      logEntry.userAgent = req.get("user-agent") || null;
    }
    await admin.firestore().collection("errorLogs").add(logEntry);
  } catch (logErr) {
    logger.error("Failed to log error to Firestore", { error: logErr.message });
  }
}

// ─── Express Error Handler ───
function errorHandler(err, req, res, next) {
  logErrorToFirestore(err, req);
  logger.error("Unhandled error", { message: err.message, path: req.path });
  const statusCode = err.status || err.statusCode || 500;
  const message = statusCode >= 500 ? "Internal server error" : err.message;
  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
}

module.exports = { logger, morganMiddleware, errorHandler, logErrorToFirestore };
