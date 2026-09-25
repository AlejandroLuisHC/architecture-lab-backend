import { z } from 'zod';

export const LAB_ID = 'serverless-web';
export const LAB_VERSION = 2;

const resourceBase = { id: z.string().min(1).max(80) };

const resourceSchema = z.discriminatedUnion('type', [
  z.object({ ...resourceBase, type: z.literal('s3Bucket'), name: z.string().max(63), blockPublicAccess: z.boolean() }),
  z.object({ ...resourceBase, type: z.literal('cloudFrontDistribution'), name: z.string().max(128), originBucketId: z.string().max(80), enabled: z.boolean(), originAccessControl: z.boolean() }),
  z.object({ ...resourceBase, type: z.literal('lambdaFunction'), name: z.string().max(64) }),
  z.object({ ...resourceBase, type: z.literal('apiRoute'), name: z.string().max(64), path: z.string().max(80), method: z.enum(['GET', 'POST', 'ANY']), lambdaId: z.string().max(80) }),
  z.object({ ...resourceBase, type: z.literal('dynamoTable'), name: z.string().max(255), partitionKey: z.string().max(64) }),
  z.object({ ...resourceBase, type: z.literal('iamPolicy'), name: z.string().max(64), lambdaId: z.string().max(80), tableId: z.string().max(80), accessLevel: z.enum(['none', 'read', 'read-write', 'admin']) }),
  z.object({ ...resourceBase, type: z.literal('cloudWatchLogGroup'), name: z.string().max(128), lambdaId: z.string().max(80), retentionDays: z.number().int().min(0).max(365) }),
  z.object({ ...resourceBase, type: z.literal('cloudWatchAlarm'), name: z.string().max(128), lambdaId: z.string().max(80), metric: z.enum(['Errors', 'Invocations']) }),
]);

export const configurationSchema = z.object({ resources: z.array(resourceSchema).max(80) });
export type LabConfiguration = z.infer<typeof configurationSchema>;
type Resource = LabConfiguration['resources'][number];

export const initialConfiguration: LabConfiguration = { resources: [] };

export const lab = {
  id: LAB_ID,
  version: LAB_VERSION,
  title: 'Build a serverless web app',
  description: 'Explore how a static frontend, an API, serverless compute, data storage, and monitoring fit together in a guided cloud sandbox.',
  duration: '30–40 min',
  level: 'Beginner',
  initialConfiguration,
  serviceCatalog: [
    { category: 'Compute', services: [{ id: 'lambda', name: 'AWS Lambda', stepIndex: 1 }, { id: 'ec2', name: 'Amazon EC2', stepIndex: null }] },
    { category: 'Storage', services: [{ id: 's3', name: 'Amazon S3', stepIndex: 0 }, { id: 'efs', name: 'Amazon EFS', stepIndex: null }] },
    { category: 'Networking & delivery', services: [{ id: 'cloudfront', name: 'Amazon CloudFront', stepIndex: 0 }, { id: 'api-gateway', name: 'Amazon API Gateway', stepIndex: 1 }, { id: 'vpc', name: 'Amazon VPC', stepIndex: null }] },
    { category: 'Database', services: [{ id: 'dynamodb', name: 'Amazon DynamoDB', stepIndex: 2 }, { id: 'aurora', name: 'Amazon Aurora', stepIndex: null }] },
    { category: 'Security & identity', services: [{ id: 'iam', name: 'AWS IAM', stepIndex: 2 }, { id: 'cognito', name: 'Amazon Cognito', stepIndex: null }] },
    { category: 'Management & monitoring', services: [{ id: 'cloudwatch', name: 'Amazon CloudWatch', stepIndex: 3 }, { id: 'cloudtrail', name: 'AWS CloudTrail', stepIndex: null }] },
  ],
  steps: [
    {
      id: 'delivery', number: '01', title: 'Deliver the frontend', services: ['Amazon S3', 'Amazon CloudFront'],
      goal: 'Create a private asset bucket and a distribution that can read from it.',
      concept: 'S3 stores the site files. CloudFront serves them to visitors while Origin Access Control keeps the bucket private.',
      instructions: ['Create an S3 bucket and keep public access blocked.', 'Create a CloudFront distribution.', 'Choose the bucket as its origin and enable Origin Access Control.'],
    },
    {
      id: 'api', number: '02', title: 'Connect the API', services: ['Amazon API Gateway', 'AWS Lambda'],
      goal: 'Route application requests to a serverless function.',
      concept: 'API Gateway receives HTTP requests. Lambda runs your code when a request reaches its route.',
      instructions: ['Create a Lambda function.', 'Create the /api/items route using ANY.', 'Connect the route to the function.'],
    },
    {
      id: 'data', number: '03', title: 'Store application data', services: ['Amazon DynamoDB', 'AWS IAM'],
      goal: 'Connect a table to the function and grant only the access it needs.',
      concept: 'DynamoDB stores items using a partition key. IAM policies decide which actions a function can perform on a resource.',
      instructions: ['Create a DynamoDB table with id as its partition key.', 'Create an IAM policy for the function and table.', 'Choose read and write access without administrator access.'],
    },
    {
      id: 'observe', number: '04', title: 'Observe the app', services: ['Amazon CloudWatch'],
      goal: 'Keep function logs and make failures visible.',
      concept: 'CloudWatch log groups retain function output. An alarm can monitor the Errors metric and surface failures.',
      instructions: ['Create a log group for the Lambda function.', 'Set retention to at least seven days.', 'Create an alarm that monitors function errors.'],
    },
  ],
} as const;

export type Check = { id: string; label: string; passed: boolean; hint: string };
export type StepEvaluation = { stepId: (typeof lab.steps)[number]['id']; passed: boolean; checks: Check[] };

const bucketNamePattern = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const tableNamePattern = /^[A-Za-z0-9._-]{3,255}$/;

function check(id: string, label: string, passed: boolean, hint: string): Check {
  return { id, label, passed, hint };
}

function findResources<T extends Resource['type']>(resources: Resource[], type: T): Extract<Resource, { type: T }>[] {
  return resources.filter((resource): resource is Extract<Resource, { type: T }> => resource.type === type);
}

export function evaluateConfiguration(configuration: LabConfiguration) {
  const resources = configuration.resources;
  const buckets = findResources(resources, 's3Bucket');
  const distributions = findResources(resources, 'cloudFrontDistribution');
  const functions = findResources(resources, 'lambdaFunction');
  const routes = findResources(resources, 'apiRoute');
  const tables = findResources(resources, 'dynamoTable');
  const policies = findResources(resources, 'iamPolicy');
  const logGroups = findResources(resources, 'cloudWatchLogGroup');
  const alarms = findResources(resources, 'cloudWatchAlarm');

  const validBucket = buckets.find((bucket) => bucketNamePattern.test(bucket.name));
  const connectedDistribution = distributions.find((distribution) =>
    distribution.enabled && distribution.originAccessControl && buckets.some((bucket) => bucket.id === distribution.originBucketId && bucket.blockPublicAccess));
  const validFunction = functions.find((fn) => /^[A-Za-z0-9_-]{1,64}$/.test(fn.name));
  const validTable = tables.find((table) => tableNamePattern.test(table.name) && table.partitionKey.trim() === 'id');
  const connectedPolicy = policies.find((policy) =>
    validFunction?.id === policy.lambdaId && tables.some((table) => table.id === policy.tableId));
  const correctPolicy = connectedPolicy?.accessLevel === 'read-write' ? connectedPolicy : undefined;
  const correctRoute = routes.find((route) =>
    route.path.trim() === '/api/items' && validFunction?.id === route.lambdaId);
  const correctLogGroup = logGroups.find((group) => group.retentionDays >= 7 && validFunction?.id === group.lambdaId);
  const correctAlarm = alarms.find((alarm) => alarm.metric === 'Errors' && validFunction?.id === alarm.lambdaId);

  const stepChecks: Check[][] = [
    [
      check('bucket-name', 'An S3 bucket has a valid name', Boolean(validBucket), 'Create a bucket with 3–63 lowercase letters, numbers, dots, or hyphens. Start and end with a letter or number.'),
      check('private-bucket', 'Public access is blocked', Boolean(validBucket?.blockPublicAccess), 'Edit the bucket and block all public access. CloudFront will be the public entry point.'),
      check('distribution', 'CloudFront can read the private origin', Boolean(connectedDistribution), 'Create an enabled distribution, select the private bucket as its origin, and enable Origin Access Control.'),
    ],
    [
      check('lambda', 'A named Lambda function exists', Boolean(validFunction), 'Create a function with a name that uses letters, numbers, hyphens, or underscores.'),
      check('route', 'The route is /api/items', Boolean(correctRoute), 'Create the /api/items route and connect it to an existing Lambda function.'),
      check('method', 'The route accepts reads and writes', Boolean(correctRoute && correctRoute.method === 'ANY'), 'Set the route method to ANY so it accepts both GET and POST requests.'),
    ],
    [
      check('table', 'A DynamoDB table uses the id partition key', Boolean(validTable), 'Create a table with a valid name and set id as its partition key.'),
      check('table-access', 'The function has access to the table', Boolean(connectedPolicy), 'Create an IAM policy that references an existing function and table.'),
      check('permissions', 'Access follows least privilege', Boolean(correctPolicy), 'Choose read and write access for this table; do not grant administrator access.'),
    ],
    [
      check('logs', 'A log group retains function output', Boolean(correctLogGroup), 'Create a log group linked to the Lambda function and retain logs for at least seven days.'),
      check('alarm', 'An alarm monitors function errors', Boolean(correctAlarm), 'Create a CloudWatch alarm linked to the function and choose the Errors metric.'),
    ],
  ];

  const steps: StepEvaluation[] = lab.steps.map((step, index) => ({
    stepId: step.id,
    passed: stepChecks[index].every((item) => item.passed),
    checks: stepChecks[index],
  }));
  const passedChecks = steps.reduce((total, step) => total + step.checks.filter((item) => item.passed).length, 0);
  const totalChecks = steps.reduce((total, step) => total + step.checks.length, 0);
  return { steps, complete: steps.every((step) => step.passed), passedChecks, totalChecks };
}
