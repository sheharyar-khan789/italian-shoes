import { test } from "node:test";
import assert from "node:assert/strict";
import { signParams, deliveryUrls, CLOUDINARY_FOLDER } from "../../functions/services/cloudinary.js";
import { addCloudinaryImageInput, cloudinarySignatureInput, PRODUCT_PHOTO } from "../../shared/schemas/catalog.js";

test("the signature follows Cloudinary's rule: sorted name=value pairs joined with &, the secret appended, SHA-1 in hex", () => {
  // The worked example from Cloudinary's own documentation (secret "abcd").
  const params = { timestamp: 1315060510, public_id: "sample_image", eager: "w_400,h_300,c_pad|w_260,h_200,c_crop" };
  assert.equal(signParams(params, "abcd"), "bfd09f95f331f558cbd1320e67aa8d488770583e");
});

test("the file, the api_key, the signature itself and empty values are never part of what is signed", () => {
  const a = signParams({ public_id: "p", timestamp: 1 }, "s");
  const b = signParams({ public_id: "p", timestamp: 1, file: "bytes", api_key: "key", signature: "old", resource_type: "image", cloud_name: "c", empty: "" }, "s");
  assert.equal(a, b);
  assert.notEqual(a, signParams({ public_id: "p", timestamp: 2 }, "s"), "a different timestamp is a different signature");
  assert.notEqual(a, signParams({ public_id: "p", timestamp: 1 }, "other-secret"), "a different secret is a different signature");
  assert.notEqual(a, signParams({ public_id: "q", timestamp: 1 }, "s"), "a different public id is a different signature");
});

test("delivery addresses are permanent https URLs for three sizes of the one stored original", () => {
  const u = deliveryUrls("my-cloud", 1700000000, `${CLOUDINARY_FOLDER}/prod1/abc12345`);
  assert.deepEqual(Object.keys(u), ["400", "800", "1600"]);
  for (const [w, url] of Object.entries(u)) {
    assert.match(url, /^https:\/\/res\.cloudinary\.com\/my-cloud\/image\/upload\/c_limit,w_\d+,f_auto,q_auto\/v1700000000\/shoe-store\/products\/prod1\/abc12345$/);
    assert.ok(url.includes(`w_${w},`));
    assert.ok(!url.startsWith("blob:") && !url.startsWith("data:"), "never a temporary local address");
  }
});

test("only ids inside shoe-store/products/{product}/ are accepted from the browser", () => {
  const ok = { productId: "prod1", publicId: "shoe-store/products/prod1/0123456789abcdef0123" };
  assert.equal(addCloudinaryImageInput.safeParse(ok).success, true);
  for (const bad of ["other-folder/prod1/0123456789abcdef", "shoe-store/products/prod1/../../x/0123456789", "shoe-store/products//0123456789abcdef", "shoe-store/products/prod1/short", "shoe-store/products/prod1/0123456789abcdef.jpg", "https://res.cloudinary.com/x/y.jpg", "", "shoe-store/products/prod1/0123456789 abcdef"]) {
    assert.equal(addCloudinaryImageInput.safeParse({ productId: "prod1", publicId: bad }).success, false, bad);
  }
  assert.equal(cloudinarySignatureInput.safeParse({ productId: "prod1" }).success, true);
});

test("the photo limits are the ones asked for: JPEG, PNG, WebP, 5 MB", () => {
  assert.deepEqual(PRODUCT_PHOTO.types, ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(PRODUCT_PHOTO.maxBytes, 5 * 1024 * 1024);
});
