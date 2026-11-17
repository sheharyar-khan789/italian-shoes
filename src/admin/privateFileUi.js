/**
 * Private files in the admin: upload to the private Blob store, and open them only through /api/privateFile
 * (which checks who is asking). Records hold a path like "hr/<uid>/<file>"; a path alone opens nothing.
 */
import { esc } from "../lib/format.js";

export const MAX_PRIVATE_BYTES = 5 * 1024 * 1024;

/** @returns {Promise<{ uid: string, token: string }>} */
async function signedIn() {
  const { firebase } = await import("../app/firebase.js"); // loaded only when a file is used
  const { auth } = await firebase();
  const user = auth.currentUser;
  const token = await user?.getIdToken();
  if (!user || !token) throw new Error("Please sign in again.");
  return { uid: user.uid, token };
}

/**
 * Upload a PDF or image (up to 5 MB) to the private store. `folder` is "receipts", "hr" or "hrphoto".
 * @param {"receipts" | "hr" | "hrphoto"} folder @param {File} file
 * @returns {Promise<{ url: string, name: string, type: string, size: number }>} `url` is the private path
 */
export async function uploadPrivate(folder, file) {
  const { uid, token } = await signedIn();
  if (file.size > MAX_PRIVATE_BYTES) throw new Error("The file is larger than 5 MB.");
  const { upload } = await import("@vercel/blob/client");
  const blob = await upload(`${folder}/${uid}/${crypto.randomUUID().replace(/-/g, "")}`, file, { access: "private", contentType: file.type, handleUploadUrl: "/api/blobUpload", headers: { Authorization: `Bearer ${token}` } });
  return { url: blob.pathname, name: file.name.slice(0, 120), type: file.type, size: file.size };
}

/** Fetch a private file as a temporary local object URL. @param {string} path */
export async function fetchPrivateObjectUrl(path) {
  const { token } = await signedIn();
  const res = await fetch(`/api/privateFile?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let message = "You can't open this file.";
    try { message = (await res.json())?.error?.message ?? message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  return URL.createObjectURL(await res.blob());
}

/** Button that opens a private file in a new tab (use with wirePrivateFiles). @param {string} path @param {string} label */
export const privateFileButton = (path, label) => `<button type="button" class="text-btn" data-private-file="${esc(path)}">${esc(label)}</button>`;

/** An <img> whose picture is loaded privately (use with wirePrivateFiles). @param {string} path @param {string} cls */
export const privateImage = (path, cls = "") => (path ? `<img data-private-img="${esc(path)}" alt="" class="${esc(cls)}" />` : "");

/**
 * Make the buttons and images made by privateFileButton / privateImage work inside `root`.
 * @param {ParentNode} root @param {(message: string) => void} [onError]
 */
export function wirePrivateFiles(root, onError = (m) => window.alert(m)) {
  root.querySelectorAll("[data-private-file]").forEach((b) => b.addEventListener("click", async () => {
    const win = window.open("", "_blank");
    try {
      const url = await fetchPrivateObjectUrl(/** @type {HTMLElement} */ (b).dataset.privateFile ?? "");
      if (win) win.location.href = url;
      else window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      win?.close();
      onError(e instanceof Error ? e.message : "You can't open this file.");
    }
  }));
  root.querySelectorAll("img[data-private-img]").forEach(async (img) => {
    try { /** @type {HTMLImageElement} */ (img).src = await fetchPrivateObjectUrl(/** @type {HTMLElement} */ (img).dataset.privateImg ?? ""); } catch { img.remove(); }
  });
}
