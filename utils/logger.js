const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const requestLogFile = path.join(logsDir, 'requests.log');

// Redact sensitive tokens from messages
function redact(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/ig, '$1[REDACTED]')
    .replace(/(token=)[^&\s]+/ig, '$1[REDACTED]')
    .replace(/(refresh_token[:=]\s*)[^\s,]+/ig, '$1[REDACTED]')
    .replace(/("id_token"\s*:\s*")[^\"]+"/ig, '$1[REDACTED]"');
}

function appendLine(line) {
  const safe = redact(line) + '\n';
  fs.appendFile(requestLogFile, safe, (err) => {
    if (err) console.error('Logger append failed:', err);
  });
}

module.exports = {
  logRequest: (line) => appendLine(`${new Date().toISOString()} ${line}`),
  logEvent: (msg) => appendLine(`${new Date().toISOString()} ${msg}`),
  logError: (err) => {
    if (err instanceof Error) {
      appendLine(`${new Date().toISOString()} ERROR ${err.stack.replace(/\n/g, ' | ')}`);
    } else {
      appendLine(`${new Date().toISOString()} ERROR ${String(err)}`);
    }
  }
};
