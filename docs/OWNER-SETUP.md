# Owner setup — accounts and admin access

What the store owner (or whoever deploys the site) does once, in order. Nothing here is automated
on purpose: each step touches the live Firebase project and needs a person to approve it.

## 1. Firebase console (one-time)

1. **Authentication → Sign-in method** → enable **Email/Password**.
2. **Authentication → Settings**: turn on **Email enumeration protection**; set a **Password policy** (10+ characters, letters and numbers); under *Authorized domains* keep only `localhost`, `italianshoes.web.app`, `italianshoes.firebaseapp.com`, `italian-shoes.vercel.app` and your own domain.
3. **Authentication → Templates**: set the sender name to *Italian Shoes*.
4. **Firestore Database**: create it (production mode, region asia-south1). Stay on the free **Spark** plan: nothing here needs a paid plan.

## 2. Configure and deploy

Follow **`docs/VERCEL-SETUP.md`** (server key, Vercel environment variables, Blob store, Firestore rules, redeploy). The first Owner is set up with `node functions/scripts/grant-owner.mjs --email <owner email> --production --project italianshoes` (needs a Google login on the computer) or with the *Claim ownership* button on /admin (needs `OWNER_EMAIL` in Vercel and a verified email).

## 3. Become the Owner (the owner does this)

1. Open the website → **Sign in → Create an account** using exactly the `OWNER_EMAIL` address, with your own password.
2. Open the verification email and click the link.
3. Go to **/admin** → sign in → **"I'm the store owner, setting up for the first time" → Claim ownership**.
4. That works **once**. After that, the store has an Owner, and nobody else can claim it.

Staff accounts: a staff member first creates a normal account on the website; the Owner then opens
**Staff & Roles** in the admin, enters their email and ticks a role. See `docs/OWNER-GUIDE.md`.
Before going live, follow `docs/GO-LIVE.md`.

## If something goes wrong

- *"Owner setup isn't configured on the server yet"* → `OWNER_EMAIL` wasn't set before deploying.
- *"This account isn't the one set up as the store owner"* → you signed up with a different email.
- *"Please verify your email address first"* → click the link in the verification email, then reload /admin.
- *"This store already has an Owner"* → ownership was already claimed; ask the existing Owner.
