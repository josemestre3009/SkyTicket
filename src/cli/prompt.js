/**
 * Read a secret from the terminal without echoing it. Requires a TTY;
 * callers should fall back to ADMIN_PASSWORD when none is available.
 */
export function promptSecret(question = 'Password: ') {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (!input.isTTY) {
      reject(new Error('Cannot prompt securely without a TTY; set ADMIN_PASSWORD'));
      return;
    }

    output.write(question);
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';

    function cleanup() {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
    }

    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          output.write('\n');
          reject(new Error('Prompt aborted'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    input.on('data', onData);
  });
}
