// Tiny HTTP server for tests + E2E. Listens on PORT (default 0 = random).
// Responds to every request with a JSON-ish body echoing the path.
import * as http from 'node:http';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const echo = JSON.stringify({ hello: 'world', method: req.method, path: req.url, body });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Hello': 'yes' });
    res.end(echo);
  });
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const addr = server.address();
  console.log(`HELLO_LISTENING ${addr.port}`);
});

server.on('error', (err) => {
  console.error(`HELLO_ERROR ${err.message}`);
  process.exit(1);
});
