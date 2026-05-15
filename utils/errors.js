/**
 * Custom Error Classes and Utilities for SwellDreams Backend
 */

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, field = null) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.field = field;
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

class TimeoutError extends AppError {
  constructor(operation = 'Operation') {
    super(`${operation} timed out`, 408, 'TIMEOUT');
    this.name = 'TimeoutError';
  }
}

class ExternalServiceError extends AppError {
  constructor(service, message) {
    super(`${service}: ${message}`, 502, 'EXTERNAL_SERVICE_ERROR');
    this.name = 'ExternalServiceError';
    this.service = service;
  }
}

/**
 * Safely parse JSON with error handling
 * @param {string} str - JSON string to parse
 * @param {*} fallback - Value to return on parse failure
 * @returns {{ success: boolean, data: *, error?: string }}
 */
function safeJsonParse(str, fallback = null) {
  if (!str || typeof str !== 'string') {
    return { success: false, error: 'Input is not a string', data: fallback };
  }

  const trimmed = str.trim();
  if (!trimmed) {
    return { success: false, error: 'Empty string', data: fallback };
  }

  try {
    return { success: true, data: JSON.parse(trimmed) };
  } catch (e) {
    return { success: false, error: e.message, data: fallback };
  }
}

/**
 * Extract JSON from potentially wrapped response (SSE, prefixed text, etc.)
 * @param {string} data - Raw response data
 * @returns {Object} Parsed JSON object
 * @throws {Error} If no valid JSON found
 */
function extractJsonFromResponse(data) {
  if (!data || typeof data !== 'string') {
    throw new Error('No data to parse');
  }

  const trimmed = data.trim();

  // Try direct parse first (most common case)
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to fallback strategies
  }

  // Handle SSE-wrapped response (data: {...})
  if (trimmed.startsWith('data:')) {
    const lines = trimmed.split('\n');
    for (const line of lines) {
      if (line.startsWith('data:') && !line.includes('[DONE]')) {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
      }
    }
  }

  // Find JSON object with balanced braces
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart >= 0) {
    let braceCount = 0;
    let jsonEnd = -1;

    for (let i = jsonStart; i < trimmed.length; i++) {
      if (trimmed[i] === '{') braceCount++;
      if (trimmed[i] === '}') braceCount--;
      if (braceCount === 0) {
        jsonEnd = i + 1;
        break;
      }
    }

    if (jsonEnd > jsonStart) {
      try {
        return JSON.parse(trimmed.substring(jsonStart, jsonEnd));
      } catch (e) {
        throw new Error(`Invalid JSON structure: ${e.message}`);
      }
    }
  }

  throw new Error('No valid JSON found in response');
}

/**
 * Async handler wrapper for Express routes
 * Catches async errors and passes to error middleware
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  TimeoutError,
  ExternalServiceError,
  safeJsonParse,
  extractJsonFromResponse,
  asyncHandler
};
