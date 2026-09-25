import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { accountServices, FirebaseUnavailableError } from './firebase.js';
import {
  configurationSchema,
  evaluateConfiguration,
  lab,
  LAB_ID,
  LAB_VERSION,
} from './lab.js';

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '32kb' }));

const progressSchema = z.object({
  version: z.literal(LAB_VERSION),
  configuration: configurationSchema,
  currentStep: z.number().int().min(0).max(lab.steps.length - 1),
});

type ProgressInput = z.infer<typeof progressSchema>;
type StoredProgress = ProgressInput & {
  updatedAt: string;
  completedAt: string | null;
};

const wrap =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };

function knownLab(req: Request, res: Response, next: NextFunction) {
  if (req.params.id !== LAB_ID && req.params.labId !== LAB_ID) {
    res.status(404).json({ code: 'LAB_NOT_FOUND', message: 'Lab not found.' });
    return;
  }
  next();
}

const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Sign in to save progress.' });
    return;
  }

  void (async () => {
    const { auth } = accountServices();
    const token = authorization.slice('Bearer '.length).trim();
    const decoded = await auth.verifyIdToken(token);
    res.locals.uid = decoded.uid;
    next();
  })().catch((error: unknown) => {
    if (error instanceof FirebaseUnavailableError) {
      next(error);
    } else {
      res.status(401).json({ code: 'INVALID_TOKEN', message: 'Your session has expired. Sign in again.' });
    }
  });
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/labs/:id', knownLab, (_req, res) => {
  res.json({ lab });
});

app.post('/labs/:id/validate', knownLab, (req, res) => {
  const parsed = z.object({ configuration: configurationSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_CONFIGURATION', message: 'The configuration is invalid.' });
    return;
  }
  res.json({ evaluation: evaluateConfiguration(parsed.data.configuration) });
});

app.get(
  '/me/progress/:labId',
  knownLab,
  authenticate,
  wrap(async (_req, res) => {
    const { db } = accountServices();
    const document = await db.doc(`progress/${res.locals.uid}/labs/${LAB_ID}`).get();
    if (!document.exists) {
      res.json({ progress: null });
      return;
    }
    const progress = document.data() as StoredProgress;
    if (progress.version !== LAB_VERSION) {
      res.status(409).json({
        code: 'LAB_VERSION_MISMATCH',
        message: 'This saved run belongs to an older lab version. Start a new run to continue.',
      });
      return;
    }
    res.json({ progress });
  }),
);

app.put(
  '/me/progress/:labId',
  knownLab,
  authenticate,
  wrap(async (req, res) => {
    const parsed = progressSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_PROGRESS', message: 'The progress data is invalid.' });
      return;
    }

    const { db } = accountServices();
    const reference = db.doc(`progress/${res.locals.uid}/labs/${LAB_ID}`);
    const previous = (await reference.get()).data() as StoredProgress | undefined;
    const complete = evaluateConfiguration(parsed.data.configuration).complete;
    const progress: StoredProgress = {
      ...parsed.data,
      updatedAt: new Date().toISOString(),
      completedAt: complete
        ? (previous?.version === LAB_VERSION ? previous.completedAt : null) ?? new Date().toISOString()
        : null,
    };
    await reference.set(progress);
    res.json({ progress });
  }),
);

app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found.' });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof FirebaseUnavailableError) {
    res.status(503).json({ code: 'ACCOUNT_UNAVAILABLE', message: error.message });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ code: 'INVALID_JSON', message: 'Request body must be valid JSON.' });
    return;
  }
  console.error(error);
  res.status(500).json({ code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
});

export default app;
