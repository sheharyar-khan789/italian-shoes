# Vercel + Firebase setup (free plans only)

The site runs on **Vercel Hobby** (website + server code in `api/`) and **Firebase Spark** (Authentication and Firestore only). No paid plan, no Cloud Functions, no Firebase Storage. Photos are stored in **Vercel Blob**.

## One-time checklist (you do these)

### 1. Create a server key (Firebase console)
1. Firebase console → project **italianshoes** → ⚙ **Project settings** → **Service accounts**.
2. Click **Generate new private key** → a `.json` file downloads. Keep it private.
3. From that file you need three values: `project_id`, `client_email`, `private_key`.
4. Never put the file in the project folder, in GitHub, in a chat or in an email. After you have pasted the values into Vercel (step 2), delete the file.
5. Delete the **old** key that was shared earlier: Google Cloud console → IAM & Admin → **Service accounts** → the `firebase-adminsdk` account → **Keys** → delete every key except the new one.

### 2. Add environment variables (Vercel)
Vercel → project **italian-shoes** → **Settings → Environment Variables**. Add each for **Production and Preview**, and leave "Sensitive" on:

| Name | Value |
| --- | --- |
| `FIREBASE_PROJECT_ID` | `italianshoes` (the `project_id` in the key file) |
| `FIREBASE_CLIENT_EMAIL` | the `client_email` from the key file |
| `FIREBASE_PRIVATE_KEY` | the `private_key` from the key file, the whole value, from its first line (the one that says BEGIN PRIVATE KEY) to its last line (END PRIVATE KEY); the `\n` signs may stay as they are |
| `OWNER_EMAIL` | `italianshoes@gmail.com` |

Do **not** add anything starting with `VITE_` for these: such names are published to every visitor.

### 3. Create the photo store (Vercel Blob)
Vercel → project → **Storage** → **Create** → **Blob** → name it `italian-shoes-photos` → **Connect to project** (Production + Preview). This adds `BLOB_READ_WRITE_TOKEN` automatically.

### 4. Firestore rules and indexes (your computer)
```bash
cd "C:\Users\sheharyar\OneDrive\Desktop\Footwear Hero"
npx firebase login
npx firebase deploy --only firestore:rules,firestore:indexes --project italianshoes
```
(`firestore.rules` and `firestore.indexes.json` are the files that get published. This is free.)

### 5. Authorized domain (Firebase console)
Authentication → Settings → **Authorized domains** → add `italian-shoes.vercel.app` (and your own domain later).

### 6. Redeploy (Vercel)
Environment variables only apply to **new** deployments. Vercel → **Deployments** → the latest one → **⋯ → Redeploy**. (A new `git push` to `main` also deploys.)

## How to test (in this order)
1. Open `https://italian-shoes.vercel.app/api/healthCheck`. You should see `{"ok":true,"firestore":"reachable"}`. If you see `"unreachable"`, the three `FIREBASE_*` values are wrong or missing (step 2) or the deployment wasn't redone (step 6).
2. Open `/admin` and sign in as the owner. The dashboard should open (sign out and in again if you were signed in before).
3. **Admin save:** Store settings → fill the store name and phone → Save. A "saved" message means the server accepted it. Reload: the values are still there.
4. **Photos:** Categories & Sizes → add a category, a colour and a size. Products → add a product → add a photo. It appears in a few seconds. A broken file or a very small photo should be refused with a reason.
5. Add sizes/colours with a price and some stock, add a delivery charge (Shipping), then **publish** the product. It now shows on the shop.
6. **Checkout:** sign in as a normal customer (a second account, not the owner), add the product to the bag, check out with Cash on Delivery. The order appears in Admin → Orders and the stock goes down by one.
7. **Admin order update:** open that order and move it to *Confirmed*. The customer's order page shows the new status.

## If something fails
- **"Please sign in" on every action:** your session is old: sign out and in.
- **"Something went wrong on our side":** Vercel → project → **Logs**. The line names the endpoint; secrets are never logged.
- **Photo upload fails immediately:** the Blob store isn't connected (step 3) or you haven't redeployed.
- **Anything on `/api/...` says "unreachable" or 500 right after you added variables:** redeploy (step 6).

## Limits of the free plans (good to know)
- Vercel Hobby: 10 s default time per request (set to 30 s for the photo step), 4.5 MB request size (that's why photos go straight to Blob), and it is for non-commercial use per Vercel's terms: check their current terms for a shop.
- Firebase Spark: Firestore has daily free read/write quotas, plenty for a small shop. If a quota is reached, the site stops until it resets.
- No App Check on the server (needs extra setup); the server protects itself with sign-in checks, permissions and rate limits.
