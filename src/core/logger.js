const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const os = require('os');

// Redact credentials before either console or file formatting. Settings should
// log field names only; this also protects nested metadata from other callers.
const sensitiveField = name => /^(?:text|content|prompt|response|responsepreview|textpreview|fallbackresponse|transcription|transcript|notes|sources|materialcontext)$/.test(name) || /^(?:azurekey|azurespeechkey|geminikey|deepseekkey|qwenkey|authorization|cookie|setcookie|subscriptionkey)$/.test(name) ||
  /(?:apikey|subscriptionkey|authorization|password|passwd|secret|token)$/.test(name);
function redactMetadata(value, field = '', ancestors = new Set()) {
  if (sensitiveField(field.replace(/[^a-z0-9]/gi, '').toLowerCase())) return '[REDACTED]';
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[Circular]';
  if (value instanceof Date) return value.toISOString();
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map(item => redactMetadata(item, '', next));
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = redactMetadata(item, key, next);
  return result;
}

class Logger {
  constructor() {
    this.logDir = path.join(os.homedir(), '.screen-reader-util', 'logs');
    this.setupLogger();
  }

  setupLogger() {
    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format(info => {
        for (const key of Object.keys(info)) info[key] = redactMetadata(info[key], key);
        return info;
      })(),
      winston.format.printf(({ timestamp, level, message, stack, service, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        const serviceStr = service ? `[${service}]` : '';
        const stackStr = stack ? `\n${stack}` : '';
        return `${timestamp} ${level.toUpperCase()} ${serviceStr} ${message}${stackStr}${metaStr ? `\n${metaStr}` : ''}`;
      })
    );

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: logFormat,
      defaultMeta: { pid: process.pid },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            logFormat
          ),
          stderrLevels: ['error', 'warn']
        }),
        new DailyRotateFile({
          filename: path.join(this.logDir, 'application-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '14d',
          level: 'info'
        }),
        new DailyRotateFile({
          filename: path.join(this.logDir, 'error-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '30d',
          level: 'error'
        })
      ],
      exceptionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'exceptions.log')
        })
      ],
      rejectionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'rejections.log')
        })
      ]
    });
  }

  createServiceLogger(serviceName) {
    return {
      debug: (message, meta = {}) => this.logger.debug(message, { service: serviceName, ...meta }),
      info: (message, meta = {}) => this.logger.info(message, { service: serviceName, ...meta }),
      warn: (message, meta = {}) => this.logger.warn(message, { service: serviceName, ...meta }),
      error: (message, meta = {}) => this.logger.error(message, { service: serviceName, ...meta }),
      logPerformance: (operation, startTime, metadata = {}) => this.logPerformance(operation, startTime, { service: serviceName, ...metadata })
    };
  }

  getSystemMetrics() {
    return {
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      platform: process.platform,
      nodeVersion: process.version
    };
  }

  logPerformance(operation, startTime, metadata = {}) {
    const duration = Date.now() - startTime;
    this.logger.info(`Performance: ${operation} completed`, {
      service: 'PERFORMANCE',
      duration: `${duration}ms`,
      ...metadata
    });
    return duration;
  }
}

module.exports = new Logger();