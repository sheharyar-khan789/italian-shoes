# Owner setup — accounts and admin access

What the store owner (or whoever deploys the site) does once, in order. Nothing here is automated
on purpose: each step touches the live Firebase project and needs a person to approve it.

## 1. Firebase console (one-time)

1. **Authentication → Sign-in method** → enable **Email/Password**.
2. **Authentication → Settings**:
   - *User actions*: turn on **Email enumeration protection**.
   - *Password policy*: require at least **10 characters** with letters and numbers (matches the site's own rule).
   - *Authorized domains*: keep only `localhost`, `italianshoes.web.app`, `italianshoes.firebaseapp.com` and your own domain.
3. **Authentication → Templates**: set the sender name to *Italian Shoes* and check the password-reset and
   email-verification wording.
4. **Firestore Database**: create the database (production mode) in region **asia-south1 (Mumbai)**, or
   tell the developer which region you chose so the Functions region can match.
5. Upgrade the project to the **Blaze** plan and set a **budget alert** (Cloud Functions need Blaze).

## 2. Configure and deploy (developer, with your approval)

1. Create `functions/.env.italianshoes` (never committed) from `functions/.env.example` and set
   `OWNER_EMAIL=` to the owner's email address.
2. Run the database migrations against the live project (creates the four staff roles):
   `node functions/scripts/migrate.mjs --production --project italianshoes`
3. Deploy rules, functions and the site: `firebase deploy --project italianshoes`.

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
