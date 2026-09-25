# Architecture Lab API

Express and TypeScript API for a guided, simulated AWS architecture lab. The API serves the lesson, evaluates a visitor's choices, and saves signed-in learners' progress in Firestore. It never calls AWS or creates cloud resources.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
copy .env.example .env
npm run dev
```

The guest lab works without Firebase credentials. The API runs at `http://localhost:3000`; `GET /health` returns its status. The development server loads `.env` when it exists. To enable accounts locally, create a Firebase project, enable **Authentication → Email/Password**, create a Firestore database, and set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` in `.env`. Enabling Firestore in the project without creating its database may still leave the Cloud Firestore API unavailable to the Admin SDK.

For production, create a Firebase service account with Firestore access and set the same variables in the backend deployment environment. Keep the private key server-side; never use it in the frontend. The server accepts a key containing real newlines or literal `\n` sequences. Firebase emulators can be used by setting `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_EMULATOR_HOST`, and `FIRESTORE_EMULATOR_HOST` instead of a service account.

Apply the included `firestore.rules` to the Firebase project. They deny all direct client reads and writes because progress is handled by the API with the Admin SDK. You can publish them in the Firebase console or with `firebase deploy --only firestore:rules` after linking the project. Do not leave Firestore in test mode.

## API contract

| Method | Route | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/labs/serverless-web` | No | Lesson copy, steps, version, initial configuration |
| `POST` | `/labs/serverless-web/validate` | No | Evaluate `{ configuration }` and return checks, hints, and completion |
| `GET` | `/me/progress/serverless-web` | Firebase ID token | Return `{ progress }`, or `null` |
| `PUT` | `/me/progress/serverless-web` | Firebase ID token | Save `{ version, configuration, currentStep }` |

Protected routes take `Authorization: Bearer <Firebase ID token>`. The server verifies the token and uses its UID to select the Firestore document at `progress/{uid}/labs/serverless-web`. The client cannot select another user's document. The server recalculates completion on every save. A saved run from an older lab version returns `409 LAB_VERSION_MISMATCH` when read; writing the current version starts a new run.

The four-stage exercise covers private S3 delivery through CloudFront, API Gateway and Lambda, DynamoDB with restricted IAM access, and CloudWatch logs and alarms. Rules and learner-facing text are in `src/lab.ts`.

## Quality checks

```bash
npm run build
npm test
```

## Vercel deployment

Connect this repository as its own Vercel project. Vercel detects `src/index.ts` as an Express entry point and deploys it as a Function. Add the Firebase environment variables above, deploy, and note the resulting API URL. Use that URL as `VITE_API_BASE_URL` in the frontend project. Confirm `GET /health`, guest validation, and authenticated save/reload after deployment. The backend permits browser origins through CORS because all protected operations require a verified bearer token and no cookie credentials are used.
