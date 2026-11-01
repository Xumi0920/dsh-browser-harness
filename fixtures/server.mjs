/**
 * Local scenario server for integration tests. Zero dependencies, port 0.
 *
 * Run directly to get a URL: node fixtures/server.mjs
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "site");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function cookieValue(request, name) {
  const header = request.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  response.end(body);
}

/** Start the fixture server; resolves with its base URL and a close handle. */
export async function startFixtureServer({ port = 0 } = {}) {
  const sessions = new Set();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = url.pathname;

      if (pathname === "/login" && request.method === "POST") {
        const body = await readBody(request);
        const form = new URLSearchParams(body);
        if (form.get("user") === "demo" && form.get("pass") === "demo") {
          const sid = randomUUID();
          sessions.add(sid);
          response.writeHead(302, { location: "/dashboard", "set-cookie": "sid=" + sid + "; Path=/; HttpOnly; SameSite=Lax" });
          response.end();
          return;
        }
        response.writeHead(302, { location: "/login?error=1" });
        response.end();
        return;
      }

      if (pathname === "/login") {
        const html = await readFile(join(SITE, "login.html"), "utf8");
        send(response, 200, html, { "content-type": MIME[".html"] });
        return;
      }

      if (pathname === "/dashboard") {
        const sid = cookieValue(request, "sid");
        if (!sid || !sessions.has(sid)) {
          response.writeHead(302, { location: "/login" });
          response.end();
          return;
        }
        const html = await readFile(join(SITE, "dashboard.html"), "utf8");
        send(response, 200, html, { "content-type": MIME[".html"] });
        return;
      }

      if (pathname === "/logout") {
        const sid = cookieValue(request, "sid");
        if (sid) sessions.delete(sid);
        response.writeHead(302, { location: "/login", "set-cookie": "sid=; Path=/; Max-Age=0" });
        response.end();
        return;
      }

      if (pathname === "/whoami") {
        const sid = cookieValue(request, "sid");
        send(response, sid && sessions.has(sid) ? 200 : 401, JSON.stringify({ user: sid && sessions.has(sid) ? "demo" : null }), { "content-type": MIME[".json"] });
        return;
      }

      if (pathname === "/api/items") {
        send(response, 200, JSON.stringify({ items: [
          { id: 1, name: "first" },
          { id: 2, name: "second" },
          { id: 3, name: "third" },
          { id: 4, name: "fourth" },
          { id: 5, name: "fifth" },
        ] }), { "content-type": MIME[".json"] });
        return;
      }

      if (pathname === "/api/slow") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        send(response, 200, JSON.stringify({ value: 42, items: [1, 2, 3] }), { "content-type": MIME[".json"] });
        return;
      }

      if (pathname === "/files/report.csv") {
        send(response, 200, "id,name\n1,alpha\n2,beta\n", {
          "content-type": MIME[".csv"],
          "content-disposition": 'attachment; filename="report.csv"',
        });
        return;
      }

      const relative = normalize(pathname.replace(/^\/+/, ""));
      const file = join(SITE, relative === "" ? "index.html" : relative);
      if (!file.startsWith(SITE + sep) && file !== join(SITE, "index.html")) {
        send(response, 403, "forbidden");
        return;
      }
      const candidates = [file];
      if (extname(file) === "" && !relative.endsWith("/")) candidates.push(file + ".html");
      for (const candidate of candidates) {
        const ext = extname(candidate).toLowerCase();
        if (!MIME[ext]) continue;
        try {
          const body = await readFile(candidate);
          response.writeHead(200, { "content-type": MIME[ext] });
          response.end(body);
          return;
        } catch {
          /* try the next candidate */
        }
      }
      send(response, 404, "not found");
    } catch (error) {
      send(response, 500, "server error: " + String(error && error.message ? error.message : error));
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const base = "http://127.0.0.1:" + address.port;
  return {
    url: base,
    port: address.port,
    sessions,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && process.argv[1].endsWith("server.mjs")) {
  const fixture = await startFixtureServer();
  console.log(JSON.stringify({ url: fixture.url, port: fixture.port }));
}
