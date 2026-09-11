/* tools/serve.mjs — static server for public/, on :8787.
   Everything drives the real files through this: npm run ui, screenshots, and
   playing it on a laptop. Module scripts need correct MIME types and will not
   load from file://, which is why this exists rather than opening index.html. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".txt": "text/plain", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}).listen(8787, () => console.log("http://localhost:8787"));
