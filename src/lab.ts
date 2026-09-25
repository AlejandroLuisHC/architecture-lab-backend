import { z } from 'zod';

export const LAB_ID = 'serverless-web';
export const LAB_VERSION = 1;

export const configurationSchema = z.object({
  storage: z.object({
    bucketName: z.string().max(63),
    blockPublicAccess: z.boolean(),
    cloudFrontEnabled: z.boolean(),
    originAccessControl: z.boolean(),
  }),
  api: z.object({
    route: z.string().max(80),
    method: z.enum(['GET', 'POST', 'ANY']),
    lambdaConnected: z.boolean(),
  }),
  data: z.object({
    tableName: z.string().max(255),
    partitionKey: z.string().max(64),
    lambdaTableConnected: z.boolean(),
    permissions: z.enum(['none', 'read', 'read-write', 'admin']),
  }),
  observability: z.object({
    logsEnabled: z.boolean(),
    retentionDays: z.number().int().min(0).max(365),
    errorAlarmEnabled: z.boolean(),
  }),
});

export type LabConfiguration = z.infer<typeof configurationSchema>;

export const initialConfiguration: LabConfiguration = {
  storage: {
    bucketName: '',
    blockPublicAccess: false,
    cloudFrontEnabled: false,
    originAccessControl: false,
  },
  api: { route: '', method: 'GET', lambdaConnected: false },
  data: {
    tableName: '',
    partitionKey: '',
    lambdaTableConnected: false,
    permissions: 'none',
  },
  observability: {
    logsEnabled: false,
    retentionDays: 0,
    errorAlarmEnabled: false,
  },
};

export const lab = {
  id: LAB_ID,
  version: LAB_VERSION,
  title: 'Build a serverless web app',
  description:
    'Configure a secure static frontend, an API, data access, and observability in a simulated AWS environment.',
  duration: '25–35 min',
  level: 'Beginner',
  initialConfiguration,
  steps: [
    {
      id: 'delivery',
      number: '01',
      title: 'Deliver the frontend',
      services: ['Amazon S3', 'Amazon CloudFront'],
      goal: 'Store static assets privately and deliver them through a CDN.',
      concept:
        'S3 stores the site files. CloudFront serves them globally. Origin Access Control lets CloudFront read a private bucket.',
      instructions: [
        'Name the asset bucket.',
        'Block public access to the bucket.',
        'Enable CloudFront with Origin Access Control.',
      ],
    },
    {
      id: 'api',
      number: '02',
      title: 'Connect the API',
      services: ['Amazon API Gateway', 'AWS Lambda'],
      goal: 'Route requests from the frontend to serverless application code.',
      concept:
        'API Gateway exposes an HTTP route. Lambda runs your code only when requests arrive.',
      instructions: [
        'Create the /api/items route.',
        'Accept both reads and writes with the ANY method.',
        'Connect the route to a Lambda function.',
      ],
    },
    {
      id: 'data',
      number: '03',
      title: 'Store application data',
      services: ['Amazon DynamoDB', 'AWS IAM'],
      goal: 'Give the function only the data access it needs.',
      concept:
        'DynamoDB stores items by partition key. IAM limits what the Lambda function may do with the table.',
      instructions: [
        'Create a table with id as its partition key.',
        'Connect Lambda to the table.',
        'Grant read and write permissions without administrator access.',
      ],
    },
    {
      id: 'observe',
      number: '04',
      title: 'Observe the app',
      services: ['Amazon CloudWatch'],
      goal: 'Keep useful logs and notice function errors.',
      concept:
        'CloudWatch logs help diagnose requests. An error alarm makes failures visible before users report them.',
      instructions: [
        'Enable Lambda logs.',
        'Keep logs for at least seven days.',
        'Create an alarm for function errors.',
      ],
    },
  ],
} as const;

export type Check = {
  id: string;
  label: string;
  passed: boolean;
  hint: string;
};

export type StepEvaluation = {
  stepId: (typeof lab.steps)[number]['id'];
  passed: boolean;
  checks: Check[];
};

const bucketNamePattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const tableNamePattern = /^[A-Za-z0-9._-]{3,255}$/;

function check(id: string, label: string, passed: boolean, hint: string): Check {
  return { id, label, passed, hint };
}

export function evaluateConfiguration(configuration: LabConfiguration) {
  const stepChecks: Check[][] = [
    [
      check(
        'bucket-name',
        'The asset bucket has a valid name',
        bucketNamePattern.test(configuration.storage.bucketName),
        'Use 3–63 lowercase letters, numbers, dots, or hyphens; start and end with a letter or number.',
      ),
      check(
        'private-bucket',
        'Public access to S3 is blocked',
        configuration.storage.blockPublicAccess,
        'Keep the bucket private. CloudFront will be the public entry point.',
      ),
      check(
        'cloudfront',
        'CloudFront is enabled',
        configuration.storage.cloudFrontEnabled,
        'Enable CloudFront to deliver the static site through a CDN.',
      ),
      check(
        'oac',
        'CloudFront has Origin Access Control',
        configuration.storage.originAccessControl,
        'Enable Origin Access Control so the distribution can read the private bucket.',
      ),
    ],
    [
      check(
        'route',
        'The API route is /api/items',
        configuration.api.route.trim() === '/api/items',
        'Use /api/items as the route for this sample application.',
      ),
      check(
        'method',
        'The route handles reads and writes',
        configuration.api.method === 'ANY',
        'Choose ANY so the route can accept GET and POST requests.',
      ),
      check(
        'lambda',
        'The route invokes Lambda',
        configuration.api.lambdaConnected,
        'Connect the API Gateway route to the Lambda function.',
      ),
    ],
    [
      check(
        'table',
        'The DynamoDB table has a valid name',
        tableNamePattern.test(configuration.data.tableName),
        'Use at least three letters, numbers, dots, underscores, or hyphens.',
      ),
      check(
        'partition-key',
        'The partition key is id',
        configuration.data.partitionKey.trim() === 'id',
        'Set id as the partition key so each item has a unique identifier.',
      ),
      check(
        'table-link',
        'Lambda is connected to the table',
        configuration.data.lambdaTableConnected,
        'Select the table as the Lambda function’s data source.',
      ),
      check(
        'permissions',
        'Lambda has least-privilege read/write access',
        configuration.data.permissions === 'read-write',
        'Grant read and write access to this table, without administrator permissions.',
      ),
    ],
    [
      check(
        'logs',
        'Lambda logs are enabled',
        configuration.observability.logsEnabled,
        'Enable logs to inspect requests and diagnose failures.',
      ),
      check(
        'retention',
        'Logs are retained for at least seven days',
        configuration.observability.retentionDays >= 7,
        'Choose a retention period of at least seven days.',
      ),
      check(
        'alarm',
        'An error alarm is enabled',
        configuration.observability.errorAlarmEnabled,
        'Create an alarm for Lambda errors so failures are visible.',
      ),
    ],
  ];

  const steps: StepEvaluation[] = lab.steps.map((step, index) => ({
    stepId: step.id,
    passed: stepChecks[index].every((item) => item.passed),
    checks: stepChecks[index],
  }));
  const passedChecks = steps.reduce(
    (total, step) => total + step.checks.filter((item) => item.passed).length,
    0,
  );
  const totalChecks = steps.reduce((total, step) => total + step.checks.length, 0);

  return {
    steps,
    complete: steps.every((step) => step.passed),
    passedChecks,
    totalChecks,
  };
}
