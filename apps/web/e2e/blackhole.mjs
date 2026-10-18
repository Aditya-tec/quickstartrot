// A stand-in for an API that is asleep: it accepts the connection and never answers, which is what a free Render instance does for the
// first 30 to 60 seconds. It counts the requests it receives (GET /__count answers, so a test can read the number), so a test can say not
// only "the page still loaded" but "the page never even asked". Test-only.
import { createServer } from 'node:http';

const PORT = Number(process.env.BLACKHOLE_PORT ?? 4011);
let attempts = 0;
createServer((req, res) => {
  if (req.url === '/__count') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ attempts }));
    return;
  }
  attempts += 1; // and never answer
}).listen(PORT, '127.0.0.1');
