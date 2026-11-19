/**
 * A LOCAL STAND-IN for the parts of Cloudinary the app uses, so the browser tests can run without a real Cloudinary account.
 * It is NOT Cloudinary and a pass here does NOT prove a real Cloudinary upload works. What it does do honestly:
 *   - it checks the upload signature with its OWN, independent SHA-1 implementation of Cloudinary's rule (so a wrong signature
 *     from the app is refused, exactly as the real service would refuse it);
 *   - it really receives the multipart upload from the browser, sniffs the true image format, measures it and keeps the bytes;
 *   - it really serves the stored picture (resized when the address asks for w_400 etc.), the Admin-API lookup and the delete.
 * `POST /__fail?on=1` makes the next upload fail (to test error handling); `GET /__state` lists what is stored.
 */
import http from "node:http";
import { createHash } from "node:crypto";
import sharp from "sharp";

const NOT_SIGNED = new Set(["file", "api_key", "cloud_name", "resource_type", "signature"]);
const sha1 = (text) => createHash("sha1").update(text).digest("hex");
const sign = (fields, secret) => sha1(Object.keys(fields).filter((k) => !NOT_SIGNED.has(k) && fields[k] !== "").sort().map((k) => `${k}=${fields[k]}`).join("&") + secret);

export async function startCloudinaryStandIn({ cloudName, apiKey, apiSecret, port }) {
  const base = `http://localhost:${port}`;
  /** public_id → { buf, info } */
  const store = new Map();
  const state = { uploads: 0, rejected: 0, destroyed: [], failNext: false };

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => Buffer.concat(await req.toArray());

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (url.pathname === "/__state") return json(res, 200, { uploads: state.uploads, rejected: state.rejected, destroyed: state.destroyed, stored: [...store.keys()] });
      if (url.pathname === "/__fail") {
        state.failNext = url.searchParams.get("on") === "1";
        return json(res, 200, { failNext: state.failNext });
      }

      // Upload
      if (req.method === "POST" && url.pathname === `/v1_1/${cloudName}/image/upload`) {
        const body = await readBody(req);
        if (state.failNext) {
          state.failNext = false;
          state.rejected += 1;
          return json(res, 500, { error: { message: "Stand-in: simulated Cloudinary outage" } });
        }
        const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
        const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
        const file = form.get("file");
        if (fields.api_key !== apiKey) return json(res, 401, { error: { message: "Invalid api_key" } });
        if (fields.signature !== sign(fields, apiSecret)) {
          state.rejected += 1;
          return json(res, 401, { error: { message: "Invalid Signature" } });
        }
        if (Math.abs(Number(fields.timestamp) - Date.now() / 1000) > 3600) return json(res, 400, { error: { message: "Stale request" } });
        if (!fields.public_id || !file || typeof file === "string") return json(res, 400, { error: { message: "Missing file or public_id" } });
        const buf = Buffer.from(await file.arrayBuffer());
        let meta;
        try {
          meta = await sharp(buf).metadata();
        } catch {
          state.rejected += 1;
          return json(res, 400, { error: { message: "Invalid image file" } });
        }
        const format = meta.format === "jpeg" ? "jpg" : meta.format;
        if (!String(fields.allowed_formats ?? "").split(",").includes(format)) {
          state.rejected += 1;
          return json(res, 400, { error: { message: `Image format ${format} not allowed` } });
        }
        const version = Math.floor(Date.now() / 1000);
        const info = { public_id: fields.public_id, version, format, width: meta.width, height: meta.height, bytes: buf.length, type: "upload", resource_type: "image", secure_url: `${base}/${cloudName}/image/upload/v${version}/${fields.public_id}.${format}` };
        info.url = info.secure_url;
        store.set(fields.public_id, { buf, info });
        state.uploads += 1;
        return json(res, 200, info);
      }

      // Admin API: what is stored for an id
      const lookup = url.pathname.match(new RegExp(`^/v1_1/${cloudName}/resources/image/upload/(.+)$`));
      if (req.method === "GET" && lookup) {
        if (req.headers.authorization !== `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`) return json(res, 401, { error: { message: "Invalid credentials" } });
        const found = store.get(decodeURIComponent(lookup[1]));
        return found ? json(res, 200, found.info) : json(res, 404, { error: { message: "Resource not found" } });
      }

      // Delete
      if (req.method === "POST" && url.pathname === `/v1_1/${cloudName}/image/destroy`) {
        const fields = Object.fromEntries(new URLSearchParams((await readBody(req)).toString()));
        if (fields.api_key !== apiKey || fields.signature !== sign(fields, apiSecret)) return json(res, 401, { error: { message: "Invalid Signature" } });
        const had = store.delete(fields.public_id);
        if (had) state.destroyed.push(fields.public_id);
        return json(res, 200, { result: had ? "ok" : "not found" });
      }

      // Delivery: /{cloud}/image/upload/{transformation}/v{version}/{public_id}[.ext]
      const delivery = url.pathname.match(new RegExp(`^/${cloudName}/image/upload/(?:([^/]+)/)?v(\\d+)/(.+?)(?:\\.(?:jpg|png|webp))?$`));
      if (req.method === "GET" && delivery) {
        const found = store.get(decodeURIComponent(delivery[3]));
        if (!found) {
          res.writeHead(404, { "access-control-allow-origin": "*" });
          return res.end("not found");
        }
        const w = Number((delivery[1] ?? "").match(/w_(\d+)/)?.[1] ?? 0);
        const out = w ? await sharp(found.buf).resize({ width: w, withoutEnlargement: true }).toBuffer() : found.buf;
        res.writeHead(200, { "content-type": `image/${found.info.format === "jpg" ? "jpeg" : found.info.format}`, "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" });
        return res.end(out);
      }
      res.writeHead(404, { "access-control-allow-origin": "*" });
      res.end("not found");
    } catch (error) {
      json(res, 500, { error: { message: `Stand-in error: ${error.message}` } });
    }
  });
  await new Promise((resolve) => server.listen(Number(port), "127.0.0.1", () => resolve(undefined)));
  return { base, state, store, stop: () => server.close() };
}
