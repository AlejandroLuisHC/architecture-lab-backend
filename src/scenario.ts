import { z } from 'zod';
import { configurationSchema, type LabConfiguration } from './lab.js';

export const relationshipKindSchema = z.enum([
  'uses-origin', 'invokes', 'grants-to', 'permits-on', 'captures-logs', 'monitors',
]);
export const relationshipSchema = z.object({
  sourceId: z.string().min(1).max(80),
  targetId: z.string().min(1).max(80),
  kind: relationshipKindSchema,
});
export type Relationship = z.infer<typeof relationshipSchema>;

export const scenarioInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  workloadAssumptions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  configuration: configurationSchema,
  relationships: z.array(relationshipSchema).max(160).optional(),
});
export type ScenarioInput = z.infer<typeof scenarioInputSchema>;

type Resource = LabConfiguration['resources'][number];
const serviceByType: Record<Resource['type'], string> = {
  s3Bucket: 's3', cloudFrontDistribution: 'cloudfront', lambdaFunction: 'lambda',
  apiRoute: 'api-gateway', dynamoTable: 'dynamodb', iamPolicy: 'iam',
  cloudWatchLogGroup: 'cloudwatch', cloudWatchAlarm: 'cloudwatch',
};
export function serviceFor(type: Resource['type']): string { return serviceByType[type]; }

export function derivedRelationships(configuration: LabConfiguration): Relationship[] {
  const resources = new Map(configuration.resources.map((resource) => [resource.id, resource]));
  const links: Relationship[] = [];
  const add = (sourceId: string, targetId: string, expected: Resource['type'], kind: Relationship['kind']) => {
    if (targetId && resources.get(targetId)?.type === expected) links.push({ sourceId, targetId, kind });
  };
  for (const resource of configuration.resources) {
    switch (resource.type) {
      case 'cloudFrontDistribution': add(resource.id, resource.originBucketId, 's3Bucket', 'uses-origin'); break;
      case 'apiRoute': add(resource.id, resource.lambdaId, 'lambdaFunction', 'invokes'); break;
      case 'iamPolicy':
        add(resource.id, resource.lambdaId, 'lambdaFunction', 'grants-to');
        add(resource.id, resource.tableId, 'dynamoTable', 'permits-on');
        break;
      case 'cloudWatchLogGroup': add(resource.id, resource.lambdaId, 'lambdaFunction', 'captures-logs'); break;
      case 'cloudWatchAlarm': add(resource.id, resource.lambdaId, 'lambdaFunction', 'monitors'); break;
    }
  }
  return links;
}

export function validateScenarioGraph(input: ScenarioInput): Relationship[] {
  const resources = new Map<string, Resource>();
  for (const resource of input.configuration.resources) {
    if (resources.has(resource.id)) throw new Error('Resource IDs must be unique.');
    resources.set(resource.id, resource);
  }
  const derived = derivedRelationships(input.configuration);
  if (!input.relationships) return derived;
  const expected = new Set(derived.map((link) => `${link.sourceId}|${link.targetId}|${link.kind}`));
  const provided = new Set<string>();
  for (const link of input.relationships) {
    const key = `${link.sourceId}|${link.targetId}|${link.kind}`;
    if (!resources.has(link.sourceId) || !resources.has(link.targetId) || !expected.has(key) || provided.has(key)) {
      throw new Error('A relationship is duplicated, dangling, or inconsistent with resource settings.');
    }
    provided.add(key);
  }
  if (provided.size !== expected.size) throw new Error('Relationships must match the resource settings.');
  return derived;
}
