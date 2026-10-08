// Tiny local static server for the page (no packages needed): node dev-server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'docs');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

http
  .createServer((req, res) => {
    const name = req.url.split('?')[0] === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
    const file = path.join(root, name);
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
      res.end(data);
    });
  })
  .listen(5174, () => console.log('http://localhost:5174'));
