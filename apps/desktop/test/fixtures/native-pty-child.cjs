const http = require('node:http');
const port = Number(process.argv[2]);
const server = http.createServer((_req, res) => res.end('owned-child'));
server.listen(port, '127.0.0.1', () => {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  console.log(
    'CHILD_READY:' +
      JSON.stringify({
        tty: [process.stdin.isTTY, process.stdout.isTTY],
        argv: process.argv.slice(3),
      }),
  );
});
let pending = '';
process.stdin.on('data', (chunk) => {
  for (const char of chunk.toString()) {
    if (char === '\x03') {
      server.close(() => process.exit(0));
      process.stdin.pause();
      return;
    }
    if (char === '\r' || char === '\n') {
      // Ask the terminal for its size now. process.stdout.columns is refreshed by
      // a SIGWINCH handler that can run after input sent after the resize.
      const [columns, rows] = process.stdout.getWindowSize();
      console.log('CHILD_REPLY:' + pending + ':SIZE:' + columns + ':' + rows);
      pending = '';
    } else pending += char;
  }
});
