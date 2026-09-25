import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export class FirebaseUnavailableError extends Error {
  constructor() {
    super('Account features are not configured on this server.');
  }
}

function firebaseApp() {
  if (getApps().length > 0) return getApp();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new FirebaseUnavailableError();

  // Firebase emulators accept a project ID without a production service account.
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId });
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) throw new FirebaseUnavailableError();

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

export function accountServices() {
  const app = firebaseApp();
  return { auth: getAuth(app), db: getFirestore(app) };
}
