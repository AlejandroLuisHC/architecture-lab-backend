import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { accountServices, authService, FirebaseUnavailableError } from './firebase.js';
import { ConflictError, createScenario, getProgress, getScenario, importLegacyProgress, LabVersionMismatchError, listRevisions, listScenarios, NotFoundError, saveProgress, updateScenario } from './store.js';
import { scenarioInputSchema, validateScenarioGraph } from './scenario.js';
import { DatabaseUnavailableError } from './database.js';
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
app.use(express.json({ limit: '256kb' }));

const progressSchema = z.object({
  version: z.literal(LAB_VERSION),
  configuration: configurationSchema,
  currentStep: z.number().int().min(0).max(lab.steps.length - 1),
});

type ProgressInput = z.infer<typeof progressSchema>;
type StoredProgress = ProgressInput & {
  unlockedThroughStep: number;
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
    const auth = authService();
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
    if (process.env.PROGRESS_STORE === 'postgres') {
      let progress = await getProgress(res.locals.uid);
      if (!progress && process.env.LEGACY_FIRESTORE_FALLBACK === 'true') {
        const sourcePath = `progress/${res.locals.uid}/labs/${LAB_ID}`;
        const legacyDocument = await accountServices().db.doc(sourcePath).get();
        if (legacyDocument.exists) {
          const result = await importLegacyProgress(res.locals.uid, sourcePath, legacyDocument.data() as StoredProgress);
          if (result === 'unsupported') throw new ConflictError('The older saved run needs manual migration before it can be opened.');
          progress = await getProgress(res.locals.uid);
        }
      }
      res.json({ progress });
      return;
    }
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

    if (process.env.PROGRESS_STORE === 'postgres') {
      try {
        validateScenarioGraph({ title: lab.title, region: 'us-east-1', workloadAssumptions: {}, configuration: parsed.data.configuration });
      } catch (error) {
        res.status(400).json({ code: 'INVALID_CONFIGURATION', message: (error as Error).message });
        return;
      }
      res.json({ progress: await saveProgress(res.locals.uid, parsed.data) });
      return;
    }

    const { db } = accountServices();
    const reference = db.doc(`progress/${res.locals.uid}/labs/${LAB_ID}`);
    const previous = (await reference.get()).data() as StoredProgress | undefined;
    const evaluation = evaluateConfiguration(parsed.data.configuration);
    const previousUnlock = previous?.version === LAB_VERSION ? previous.unlockedThroughStep : 0;
    let validatedUnlock = 0;
    for (let index = 0; index < evaluation.steps.length - 1; index += 1) {
      if (!evaluation.steps[index].passed) break;
      validatedUnlock = index + 1;
    }
    const unlockedThroughStep = Math.max(previousUnlock ?? 0, validatedUnlock);
    const complete = evaluation.complete;
    const progress: StoredProgress = {
      ...parsed.data,
      currentStep: Math.min(parsed.data.currentStep, unlockedThroughStep),
      unlockedThroughStep,
      updatedAt: new Date().toISOString(),
      completedAt: complete
        ? (previous?.version === LAB_VERSION ? previous.completedAt : null) ?? new Date().toISOString()
        : null,
    };
    await reference.set(progress);
    res.json({ progress });
  }),
);

app.get('/me/scenarios', authenticate, wrap(async (_req, res) => {
  res.json({ scenarios: await listScenarios(res.locals.uid) });
}));

app.post('/me/scenarios', authenticate, wrap(async (req, res) => {
  const parsed = scenarioInputSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ code: 'INVALID_SCENARIO', message: 'Scenario data is invalid.' }); return; }
  try { validateScenarioGraph(parsed.data); }
  catch (error) { res.status(400).json({ code: 'INVALID_RELATIONSHIPS', message: (error as Error).message }); return; }
  res.status(201).json({ scenario: await createScenario(res.locals.uid, parsed.data) });
}));

app.get('/me/scenarios/:id/revisions', authenticate, wrap(async (req, res) => {
  res.json({ revisions: await listRevisions(res.locals.uid, String(req.params.id)) });
}));

app.get('/me/scenarios/:id/revisions/:revision', authenticate, wrap(async (req, res) => {
  const revision = Number(req.params.revision);
  if (!Number.isInteger(revision) || revision < 1) { res.status(400).json({ code: 'INVALID_REVISION', message: 'Revision must be a positive integer.' }); return; }
  res.json({ scenario: await getScenario(res.locals.uid, String(req.params.id), revision) });
}));

app.get('/me/scenarios/:id', authenticate, wrap(async (req, res) => {
  res.json({ scenario: await getScenario(res.locals.uid, String(req.params.id)) });
}));

app.put('/me/scenarios/:id', authenticate, wrap(async (req, res) => {
  const parsed = scenarioInputSchema.extend({ expectedRevision: z.number().int().min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ code: 'INVALID_SCENARIO', message: 'Scenario data is invalid.' }); return; }
  try { validateScenarioGraph(parsed.data); }
  catch (error) { res.status(400).json({ code: 'INVALID_RELATIONSHIPS', message: (error as Error).message }); return; }
  res.json({ scenario: await updateScenario(res.locals.uid, String(req.params.id), parsed.data, parsed.data.expectedRevision) });
}));

app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found.' });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof NotFoundError) { res.status(404).json({ code: 'NOT_FOUND', message: error.message }); return; }
  if (error instanceof LabVersionMismatchError) { res.status(409).json({ code: 'LAB_VERSION_MISMATCH', message: error.message }); return; }
  if (error instanceof ConflictError) { res.status(409).json({ code: 'CONFLICT', message: error.message }); return; }
  if (error instanceof DatabaseUnavailableError) { res.status(503).json({ code: 'DATABASE_UNAVAILABLE', message: error.message }); return; }
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
