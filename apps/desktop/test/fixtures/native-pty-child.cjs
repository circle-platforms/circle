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
      console.log(
        'CHILD_REPLY:' +
          pending +
          ':SIZE:' +
          process.stdout.columns +
          ':' +
          process.stdout.rows,
      );
      pending = '';
    } else pending += char;
  }
});
