/**
 * Logging Utility for SwellDreams Backend
 * Provides leveled logging with prefix support
 */

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  TRACE: 4
};

// Get current log level from environment, default to INFO
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

/**
 * Create a logger instance with a specific prefix
 * @param {string} prefix - Logger prefix (e.g., 'Server', 'LLM', 'DeviceService')
 * @returns {Object} Logger instance with level methods
 */
function createLogger(prefix) {
  const formatMessage = (level, args) => {
    const timestamp = new Date().toISOString();
    return [`[${timestamp}] [${prefix}]`, ...args];
  };

  return {
    error: (...args) => {
      if (LOG_LEVELS.ERROR <= currentLevel) {
        console.error(...formatMessage('ERROR', args));
      }
    },

    warn: (...args) => {
      if (LOG_LEVELS.WARN <= currentLevel) {
        console.warn(...formatMessage('WARN', args));
      }
    },

    info: (...args) => {
      if (LOG_LEVELS.INFO <= currentLevel) {
        console.log(...formatMessage('INFO', args));
      }
    },

    debug: (...args) => {
      if (LOG_LEVELS.DEBUG <= currentLevel) {
        console.log(...formatMessage('DEBUG', args));
      }
    },

    trace: (...args) => {
      if (LOG_LEVELS.TRACE <= currentLevel) {
        console.log(...formatMessage('TRACE', args));
      }
    },

    // Log regardless of level (for critical startup/shutdown messages)
    always: (...args) => {
      console.log(...formatMessage('ALWAYS', args));
    }
  };
}

/**
 * Sanitize sensitive data for logging
 * @param {*} data - Data to sanitize
 * @param {number} maxLength - Maximum string length to show
 * @returns {string} Sanitized representation
 */
function sanitizeForLog(data, maxLength = 100) {
  if (data === null || data === undefined) {
    return '(empty)';
  }

  const str = typeof data === 'string' ? data : JSON.stringify(data);

  if (str.length <= maxLength) {
    return `[${str.length} chars]`;
  }

  return `[${str.length} chars - starts: "${str.substring(0, 50)}..."]`;
}

/**
 * Create a child logger with additional prefix
 * @param {Object} parentLogger - Parent logger instance
 * @param {string} childPrefix - Additional prefix
 * @returns {Object} Child logger instance
 */
function createChildLogger(parentLogger, childPrefix) {
  // Extract parent prefix from the logger's closure
  // This is a simplified version - just create a new logger with combined prefix
  return createLogger(`${childPrefix}`);
}

module.exports = {
  LOG_LEVELS,
  createLogger,
  sanitizeForLog,
  createChildLogger
};
