import { z } from 'zod';
import { configurationSchema, type LabConfiguration } from './lab.js';

export const relationshipKindSchema = z.enum([
    'uses-origin',
    'invokes',
    'grants-to',
    'permits-on',
    'captures-logs',
    'monitors',
    'connects-to',
    'routes-to',
    'reads-from',
    'writes-to',
    'encrypts-with',
    'attached-to',
    'depends-on',
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
    workloadAssumptions: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .default({}),
    configuration: configurationSchema,
    relationships: z.array(relationshipSchema).max(160).optional(),
    cloudFormationSource: z.string().max(1_048_576).optional(),
});
export type ScenarioInput = z.infer<typeof scenarioInputSchema>;

type Resource = LabConfiguration['resources'][number];
const serviceByType: Record<Resource['type'], string> = {
    s3Bucket: 's3',
    cloudFrontDistribution: 'cloudfront',
    lambdaFunction: 'lambda',
    apiRoute: 'api-gateway',
    dynamoTable: 'dynamodb',
    iamPolicy: 'iam',
    cloudWatchLogGroup: 'cloudwatch',
    cloudWatchAlarm: 'cloudwatch',
    awsResource: '',
};
export function serviceFor(type: Resource['type'], resource?: Resource): string {
    if (type === 'awsResource' && resource?.type === 'awsResource') return resource.service;
    return serviceByType[type];
}

function derivedForResource(resource: Resource, resources: Map<string, Resource>): Relationship[] {
    const links: Relationship[] = [];
    const add = (
        sourceId: string,
        targetId: string,
        expected: Resource['type'],
        kind: Relationship['kind'],
    ) => {
        if (targetId && resources.get(targetId)?.type === expected) links.push({ sourceId, targetId, kind });
    };
    switch (resource.type) {
        case 'cloudFrontDistribution':
            add(resource.id, resource.originBucketId, 's3Bucket', 'uses-origin');
            break;
        case 'apiRoute':
            add(resource.id, resource.lambdaId, 'lambdaFunction', 'invokes');
            break;
        case 'iamPolicy':
            add(resource.id, resource.lambdaId, 'lambdaFunction', 'grants-to');
            add(resource.id, resource.tableId, 'dynamoTable', 'permits-on');
            break;
        case 'cloudWatchLogGroup':
            add(resource.id, resource.lambdaId, 'lambdaFunction', 'captures-logs');
            break;
        case 'cloudWatchAlarm':
            add(resource.id, resource.lambdaId, 'lambdaFunction', 'monitors');
            break;
        default:
            break;
    }
    return links;
}

function derivedAwsRelationships(
    resource: Extract<Resource, { type: 'awsResource' }>,
    resources: Map<string, Resource>,
): Relationship[] {
    const links: Relationship[] = [];
    for (const [key, value] of Object.entries(resource.settings)) {
        if (!key.endsWith('Id') || typeof value !== 'string' || !resources.has(value)) continue;
        links.push({
            sourceId: resource.id,
            targetId: value,
            kind: key.toLowerCase().includes('vpc') ? 'attached-to' : 'connects-to',
        });
    }
    return links;
}

function derivedResourceRelationships(resource: Resource, resources: Map<string, Resource>): Relationship[] {
    return resource.type === 'awsResource'
        ? derivedAwsRelationships(resource, resources)
        : derivedForResource(resource, resources);
}

export function derivedRelationships(configuration: LabConfiguration): Relationship[] {
    const resources = new Map(configuration.resources.map((resource) => [resource.id, resource]));
    return configuration.resources.flatMap((resource) => derivedResourceRelationships(resource, resources));
}

function indexResources(configuration: LabConfiguration): Map<string, Resource> {
    const resources = new Map<string, Resource>();
    for (const resource of configuration.resources) {
        if (resources.has(resource.id)) throw new Error('Resource IDs must be unique.');
        resources.set(resource.id, resource);
    }
    return resources;
}

function isFreeformEdge(source: Resource | undefined, target: Resource | undefined, kind: string): boolean {
    return (
        source?.type === 'awsResource' ||
        target?.type === 'awsResource' ||
        [
            'connects-to',
            'routes-to',
            'reads-from',
            'writes-to',
            'encrypts-with',
            'attached-to',
            'depends-on',
        ].includes(kind)
    );
}

function isInvalidLink(
    link: Relationship,
    resources: Map<string, Resource>,
    derivedKeys: Set<string>,
    provided: Set<string>,
): boolean {
    const key = `${link.sourceId}|${link.targetId}|${link.kind}`;
    const source = resources.get(link.sourceId);
    const target = resources.get(link.targetId);
    return (
        !source ||
        !target ||
        link.sourceId === link.targetId ||
        provided.has(key) ||
        (!derivedKeys.has(key) && !isFreeformEdge(source, target, link.kind))
    );
}

export function validateScenarioGraph(input: ScenarioInput): Relationship[] {
    const resources = indexResources(input.configuration);
    const derived = derivedRelationships(input.configuration);
    if (!input.relationships) return derived;
    const derivedKeys = new Set(derived.map((link) => `${link.sourceId}|${link.targetId}|${link.kind}`));
    const provided = new Set<string>(derivedKeys);
    for (const link of input.relationships) {
        const key = `${link.sourceId}|${link.targetId}|${link.kind}`;
        if (isInvalidLink(link, resources, derivedKeys, provided)) {
            throw new Error(
                'A relationship is duplicated, dangling, or inconsistent with resource settings.',
            );
        }
        provided.add(key);
    }
    return [
        ...derived,
        ...(input.relationships ?? []).filter(
            (link) => !derivedKeys.has(`${link.sourceId}|${link.targetId}|${link.kind}`),
        ),
    ];
}
