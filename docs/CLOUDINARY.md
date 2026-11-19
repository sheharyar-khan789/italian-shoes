# Product photos on Cloudinary (free plan)

Firebase Storage is **not used** by this app (only an unused bucket name exists in the config), so nothing needs enabling or upgrading there.
Product photos are stored on Cloudinary when it is configured; if it is not, the older Vercel Blob route still works.

## One-time setup (owner)
1. Create a free account at cloudinary.com.
2. Dashboard -> **Programs / Product Environment -> API Keys**: copy **Cloud name**, **API Key**, **API Secret**.
3. Vercel -> Project -> Settings -> Environment Variables (Production): add
   `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. Redeploy.
4. Open `/api/healthCheck`: it should say `"cloudinary":"connected"` and `"photoStorage"` connected.
5. Optional hardening in Cloudinary Settings -> Security: restrict allowed upload formats to jpg/png/webp.

## How it works
- The admin picks a photo (JPEG/PNG/WebP, max 5 MB; checked in the browser and again by the server/Cloudinary).
- The browser asks the server for a **signed** upload (`cloudinarySignature`, needs `products.write`). The signature covers the folder
  (`shoe-store/products/{productId}/`), a random id, allowed formats and a timestamp. The API secret never leaves the server.
- The browser sends the file straight to Cloudinary (with a progress bar), then calls `addCloudinaryImage`.
  The server **verifies the asset with Cloudinary's Admin API** and only then saves it into the product document
  (`images[]`: `provider:"cloudinary"`, `publicId`, `paths{400,800,1600}` as permanent https URLs). A rejected or failed save deletes the stray upload.
- Replacing or deleting a photo deletes the old file at Cloudinary after the new one is saved. Existing products and Vercel Blob URLs keep working.
- If Cloudinary is not configured the app uses the Vercel Blob route automatically.

## Tests
`tests/unit/cloudinary.test.js`, `tests/emulator/cloudinary.test.js` and `tests/e2e/cloudinary-photos.e2e.js` use a **local stand-in** for
Cloudinary (`tests/e2e/cloudinaryStandIn.mjs`, independent signature check). They do not prove a real Cloudinary account accepts the upload;
do the manual test below once after setup.

## Manual test
Admin -> Products -> Add product (fill details, choose a photo, Save) -> wait for "saved" -> reload -> open the shop: same photo.
Try a .gif / text file / >5 MB file: a clear message appears and nothing is uploaded.
