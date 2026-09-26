import type { LabConfiguration, Resource } from '../lab.js';
import type { Relationship } from '../scenario.js';
import type { AnalysisInput } from '../analysis.js';

export type AnalysisFinding = {
    id: string;
    category: 'security' | 'compatibility' | 'reliability' | 'performance';
    severity: 'critical' | 'warning' | 'info';
    title: string;
    explanation: string;
    recommendation: string;
    resourceIds: string[];
};

type Workload = AnalysisInput['workloadAssumptions'];
type FindingList = AnalysisFinding[];
type AwsResource = Extract<Resource, { type: 'awsResource' }>;

function addIf(condition: boolean, finding: AnalysisFinding | null): FindingList {
    return condition && finding ? [finding] : [];
}

function resourceName(configuration: LabConfiguration, id: string): string {
    const resource = configuration.resources.find((item) => item.id === id);
    return resource?.name || (resource?.type === 'awsResource' ? resource.service : resource?.type) || id;
}

function containsUnresolvedExpression(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(containsUnresolvedExpression);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(
        ([key, child]) => key === 'Ref' || key.startsWith('Fn::') || containsUnresolvedExpression(child),
    );
}

function publicBucketFindings(resources: Resource[]): FindingList {
    return resources
        .filter(
            (resource) =>
                (resource.type === 's3Bucket' && !resource.blockPublicAccess) ||
                (resource.type === 'awsResource' &&
                    resource.service === 's3' &&
                    (resource.settings.blockPublicAccess === false ||
                        (resource.settings.blockPublicAccess === undefined &&
                            !containsUnresolvedExpression(
                                resource.settings.publicAccessBlockConfiguration,
                            )))),
        )
        .map((bucket) => ({
            id: `public-${bucket.id}`,
            category: 'security',
            severity: 'critical',
            title: 'S3 bucket allows public access',
            explanation: `${bucket.name || 'This bucket'} does not block public access, so its objects may be exposed if a permissive policy is added.`,
            recommendation:
                'Enable all S3 Block Public Access controls and use a private CloudFront origin when public delivery is needed.',
            resourceIds: [bucket.id],
        }));
}

function administratorPolicyFinding(resource: Resource): AnalysisFinding | null {
    if (resource.type !== 'iamPolicy' || resource.accessLevel !== 'admin') return null;
    return {
        id: `admin-${resource.id}`,
        category: 'security',
        severity: 'critical',
        title: 'Workload has administrator access',
        explanation:
            'An administrator policy grants more permissions than the application needs and increases the impact of a compromised workload.',
        recommendation: 'Grant only the required actions on the specific resources this workload uses.',
        resourceIds: [resource.id, resource.lambdaId],
    };
}

function administratorRoleFinding(resource: AwsResource): AnalysisFinding | null {
    if (resource.service !== 'iam' || resource.settings.accessLevel !== 'admin') return null;
    return {
        id: `admin-role-${resource.id}`,
        category: 'security',
        severity: 'critical',
        title: 'Workload role has administrator access',
        explanation:
            'An administrator role grants more permissions than the application needs and increases the impact of a compromised workload.',
        recommendation: 'Grant only the required actions on the specific resources this workload uses.',
        resourceIds: [resource.id],
    };
}

function publicResourceFinding(resource: AwsResource): AnalysisFinding | null {
    const publicFlag = resource.settings.publiclyAccessible === true || resource.settings.public === true;
    const publicBucket = resource.service === 's3' && resource.settings.blockPublicAccess === false;
    if (!publicFlag && !publicBucket) return null;
    return {
        id: `public-resource-${resource.id}`,
        category: 'security',
        severity: 'critical',
        title: `${resource.service} is configured as public`,
        explanation: `${resource.name} is marked publicly accessible in its current configuration.`,
        recommendation: 'Keep data services private and expose only the intended application entry point.',
        resourceIds: [resource.id],
    };
}

function encryptionFinding(resource: AwsResource): AnalysisFinding | null {
    const legacyEncryptionDisabled =
        ['aurora', 'efs'].includes(resource.service) && resource.settings.encryptionEnabled === false;
    const encryptionDisabled = resource.service === 'efs' && resource.settings.encrypted === false;
    if (!legacyEncryptionDisabled && !encryptionDisabled) return null;
    return {
        id: `unencrypted-${resource.id}`,
        category: 'security',
        severity: 'warning',
        title: `${resource.service} encryption is disabled`,
        explanation: 'Stored data may be exposed if underlying media, snapshots, or backups are accessed.',
        recommendation: 'Enable encryption at rest and manage keys through a scoped KMS key.',
        resourceIds: [resource.id],
    };
}

function rotationFinding(resource: AwsResource): AnalysisFinding | null {
    if (
        resource.service === 'kms' &&
        (resource.settings.keyRotation === false || resource.settings.enableKeyRotation === false)
    ) {
        return {
            id: `key-rotation-${resource.id}`,
            category: 'security',
            severity: 'warning',
            title: 'KMS key rotation is disabled',
            explanation: 'Using one key version indefinitely can increase the impact of a key exposure.',
            recommendation:
                'Enable automatic rotation when supported by the key type and your key-management policy.',
            resourceIds: [resource.id],
        };
    }
    if (resource.service !== 'secretsManager' || resource.settings.automaticRotation !== false) return null;
    return {
        id: `secret-rotation-${resource.id}`,
        category: 'security',
        severity: 'warning',
        title: 'Secret rotation is disabled',
        explanation: 'Long-lived credentials remain valid until changed manually.',
        recommendation: 'Enable automatic rotation where the dependent service supports it.',
        resourceIds: [resource.id],
    };
}

function singleAzFinding(resource: AwsResource, workload: Workload): AnalysisFinding | null {
    if (
        resource.service !== 'aurora' ||
        resource.settings.multiAz === true ||
        workload.availabilityTarget < 99.9
    )
        return null;
    return {
        id: `single-az-${resource.id}`,
        category: 'reliability',
        severity: 'warning',
        title: 'Database has no configured failover',
        explanation: `The requested ${workload.availabilityTarget}% availability target is difficult to meet with a single-AZ database.`,
        recommendation: 'Enable a Multi-AZ deployment and test failover and backup recovery.',
        resourceIds: [resource.id],
    };
}

function singleInstanceFinding(resource: AwsResource, workload: Workload): AnalysisFinding | null {
    if (
        resource.service !== 'ec2' ||
        Number(resource.settings.instanceCount ?? 1) >= 2 ||
        workload.availabilityTarget < 99.9
    )
        return null;
    return {
        id: `single-instance-${resource.id}`,
        category: 'reliability',
        severity: 'warning',
        title: 'Single instance is a failure point',
        explanation: `One EC2 instance cannot maintain service during an instance or Availability Zone failure at a ${workload.availabilityTarget}% target.`,
        recommendation: 'Use at least two instances across Availability Zones behind a load balancer.',
        resourceIds: [resource.id],
    };
}

function cloudTrailFinding(resource: AwsResource): AnalysisFinding | null {
    if (
        resource.service !== 'cloudTrail' ||
        (resource.settings.multiRegion !== false && resource.settings.isMultiRegionTrail !== false)
    )
        return null;
    return {
        id: `trail-region-${resource.id}`,
        category: 'reliability',
        severity: 'warning',
        title: 'CloudTrail is limited to one region',
        explanation: 'Events in other enabled regions may be missing from the audit trail.',
        recommendation: 'Use a multi-region trail for account-wide activity visibility.',
        resourceIds: [resource.id],
    };
}

function loadBalancerFinding(resource: AwsResource, hasVpc: boolean): AnalysisFinding | null {
    const internetFacing =
        resource.settings.internetFacing === true || resource.settings.scheme === 'internet-facing';
    if (resource.service !== 'loadBalancer' || !internetFacing || hasVpc) return null;
    return {
        id: `lb-no-vpc-${resource.id}`,
        category: 'compatibility',
        severity: 'warning',
        title: 'Load balancer has no modeled VPC',
        explanation:
            'The load balancer needs subnets and security groups in a VPC, but none are represented in this architecture.',
        recommendation: 'Add a VPC and connect the load balancer to public subnets.',
        resourceIds: [resource.id],
    };
}

function genericResourceFindings(resource: AwsResource, workload: Workload, hasVpc: boolean): FindingList {
    return [
        administratorRoleFinding(resource),
        publicResourceFinding(resource),
        encryptionFinding(resource),
        rotationFinding(resource),
        cloudTrailFinding(resource),
        singleAzFinding(resource, workload),
        singleInstanceFinding(resource, workload),
        loadBalancerFinding(resource, hasVpc),
    ].filter((finding): finding is AnalysisFinding => finding !== null);
}

function cloudFrontFindings(resources: Resource[]): FindingList {
    return resources.flatMap((distribution) => {
        if (distribution.type !== 'cloudFrontDistribution') return [];
        const hasS3Origin = resources.some(
            (resource) => resource.id === distribution.originBucketId && resource.type === 's3Bucket',
        );
        return [
            ...addIf(!hasS3Origin, {
                id: `origin-missing-${distribution.id}`,
                category: 'compatibility',
                severity: 'warning',
                title: 'CloudFront origin is missing',
                explanation: 'The distribution does not reference an S3 bucket in this architecture.',
                recommendation: 'Add a bucket and select it as the distribution origin.',
                resourceIds: [distribution.id],
            }),
            ...addIf(!distribution.originAccessControl, {
                id: `origin-control-${distribution.id}`,
                category: 'security',
                severity: 'warning',
                title: 'CloudFront origin is not protected',
                explanation:
                    'Without Origin Access Control, the storage origin may be reachable outside the intended delivery path.',
                recommendation: 'Enable Origin Access Control and keep the S3 bucket private.',
                resourceIds: [distribution.id, distribution.originBucketId],
            }),
            ...addIf(!distribution.enabled, {
                id: `disabled-distribution-${distribution.id}`,
                category: 'reliability',
                severity: 'warning',
                title: 'CloudFront distribution is disabled',
                explanation: 'The configured distribution cannot deliver content while it is disabled.',
                recommendation: 'Enable it before treating the architecture as available.',
                resourceIds: [distribution.id],
            }),
        ];
    });
}

function missingRouteTarget(resource: Resource, resources: Resource[]): AnalysisFinding | null {
    if (resource.type !== 'apiRoute') return null;
    const targetExists = resources.some(
        (target) => target.id === resource.lambdaId && target.type === 'lambdaFunction',
    );
    if (targetExists) return null;
    return {
        id: `route-target-${resource.id}`,
        category: 'compatibility',
        severity: 'warning',
        title: 'API route target is missing',
        explanation: `${resource.name || resource.path} refers to a Lambda function that is not in this architecture.`,
        recommendation: 'Add the function or select an existing integration target.',
        resourceIds: [resource.id],
    };
}

function unresolvedInputFinding(resources: Resource[]): AnalysisFinding | null {
    const unresolved = resources.filter(
        (resource) => resource.type === 'awsResource' && containsUnresolvedExpression(resource.settings),
    );
    if (!unresolved.length) return null;
    return {
        id: 'unresolved-cloudformation-inputs',
        category: 'compatibility',
        severity: 'info',
        title: 'Some CloudFormation inputs are unresolved',
        explanation:
            'Intrinsic expressions and parameter references are preserved, but their values are not evaluated by this sandbox analysis.',
        recommendation:
            'Set concrete parameter values in the template before relying on property-specific findings or cost estimates.',
        resourceIds: unresolved.map((resource) => resource.id),
    };
}

function isCompute(resource: Resource): boolean {
    return (
        resource.type === 'lambdaFunction' ||
        (resource.type === 'awsResource' && ['ec2', 'ecs', 'lambda'].includes(resource.service))
    );
}

function isData(resource: Resource): boolean {
    return (
        resource.type === 's3Bucket' ||
        resource.type === 'dynamoTable' ||
        (resource.type === 'awsResource' && ['aurora', 'efs', 'dynamodb', 's3'].includes(resource.service))
    );
}

function routeCompatible(source: Resource, target: Resource): boolean {
    const isEntryPoint =
        source.type === 'apiRoute' ||
        (source.type === 'awsResource' && ['route53', 'loadBalancer'].includes(source.service));
    const isTarget =
        isCompute(target) || (target.type === 'awsResource' && target.service === 'loadBalancer');
    return isEntryPoint && isTarget;
}

function dataLinkCompatible(source: Resource, target: Resource): boolean {
    return isCompute(source) && isData(target);
}

function keyLinkCompatible(source: Resource, target: Resource): boolean {
    return isData(source) && target.type === 'awsResource' && target.service === 'kms';
}

function vpcLinkCompatible(source: Resource, target: Resource): boolean {
    return isCompute(source) && target.type === 'awsResource' && target.service === 'vpc';
}

function relationshipCompatible(link: Relationship, source: Resource, target: Resource): boolean {
    switch (link.kind) {
        case 'routes-to':
            return routeCompatible(source, target);
        case 'reads-from':
        case 'writes-to':
            return dataLinkCompatible(source, target);
        case 'encrypts-with':
            return keyLinkCompatible(source, target);
        case 'attached-to':
            return vpcLinkCompatible(source, target);
        default:
            return true;
    }
}

function incompatibleRelationshipFinding(
    link: Relationship,
    resources: Map<string, Resource>,
    configuration: LabConfiguration,
): AnalysisFinding | null {
    const source = resources.get(link.sourceId);
    const target = resources.get(link.targetId);
    if (!source || !target || relationshipCompatible(link, source, target)) return null;
    return {
        id: `incompatible-${link.sourceId}-${link.targetId}-${link.kind}`,
        category: 'compatibility',
        severity: 'warning',
        title: 'Connection does not match the selected service roles',
        explanation: `${resourceName(configuration, link.sourceId)} ${link.kind} ${resourceName(configuration, link.targetId)}, which is not a supported flow in this review.`,
        recommendation:
            'Connect compute to an API entry point or data service; attach networked resources to a VPC; and connect data resources to their KMS key.',
        resourceIds: [link.sourceId, link.targetId],
    };
}

function relationshipFindings(input: AnalysisInput): FindingList {
    const resources = new Map(input.configuration.resources.map((resource) => [resource.id, resource]));
    return (input.relationships ?? [])
        .map((link) => incompatibleRelationshipFinding(link, resources, input.configuration))
        .filter((finding): finding is AnalysisFinding => finding !== null);
}

function observabilityFindings(resources: Resource[]): FindingList {
    const compute = resources.filter(isCompute);
    const hasLogs = resources.some(
        (resource) =>
            resource.type === 'cloudWatchLogGroup' ||
            (resource.type === 'awsResource' && ['cloudTrail', 'cloudwatch'].includes(resource.service)),
    );
    const hasAlarms = resources.some(
        (resource) =>
            resource.type === 'cloudWatchAlarm' ||
            (resource.type === 'awsResource' && resource.service === 'cloudwatchAlarm'),
    );
    return [
        ...addIf(compute.length > 0 && !hasLogs, {
            id: 'missing-logs',
            category: 'reliability',
            severity: 'warning',
            title: 'No workload logging is modeled',
            explanation: 'Without retained logs, investigating errors and slow requests is harder.',
            recommendation:
                'Add a CloudWatch log group and choose a retention period that meets operational and compliance needs.',
            resourceIds: compute.map((resource) => resource.id),
        }),
        ...addIf(compute.length > 0 && !hasAlarms, {
            id: 'missing-alarms',
            category: 'reliability',
            severity: 'info',
            title: 'No failure alarm is modeled',
            explanation: 'The architecture has compute resources but no alarm to surface a rise in errors.',
            recommendation:
                'Add a CloudWatch alarm on errors or failed health checks and define who responds.',
            resourceIds: compute.map((resource) => resource.id),
        }),
    ];
}

function performanceFindings(resources: Resource[], workload: Workload): FindingList {
    const lambdaResources = resources.filter(
        (resource) =>
            resource.type === 'lambdaFunction' ||
            (resource.type === 'awsResource' && resource.service === 'lambda'),
    );
    return [
        ...addIf(workload.requestsPerMonth > 100_000_000 && lambdaResources.length > 0, {
            id: 'high-serverless-volume',
            category: 'performance',
            severity: 'info',
            title: 'Validate function concurrency at expected traffic',
            explanation: `${workload.requestsPerMonth.toLocaleString()} monthly requests can create burst concurrency that depends on request distribution and execution time.`,
            recommendation:
                'Estimate peak requests per second, check account concurrency limits, and load test downstream systems.',
            resourceIds: lambdaResources.map((resource) => resource.id),
        }),
        ...addIf(workload.averageDurationMs > 10_000, {
            id: 'long-runtime',
            category: 'performance',
            severity: 'warning',
            title: 'Average request runtime is high',
            explanation: `The assumed ${workload.averageDurationMs} ms execution time can increase latency and compute cost.`,
            recommendation:
                'Profile the slow path, set timeouts deliberately, and consider asynchronous processing for long tasks.',
            resourceIds: [],
        }),
    ];
}

function isolatedResourceFindings(input: AnalysisInput): FindingList {
    const relationships = input.relationships ?? [];
    const connected = new Set(relationships.flatMap((link) => [link.sourceId, link.targetId]));
    return input.configuration.resources
        .filter((resource) => input.configuration.resources.length > 1 && !connected.has(resource.id))
        .map((resource) => ({
            id: `isolated-${resource.id}`,
            category: 'compatibility',
            severity: 'info',
            title: `${resourceName(input.configuration, resource.id)} is not connected`,
            explanation:
                'This resource has no relationship to another resource, so it may not participate in the application flow.',
            recommendation: 'Connect it to the resource that invokes, uses, reads, writes, or secures it.',
            resourceIds: [resource.id],
        }));
}

export function collectArchitectureFindings(input: AnalysisInput): FindingList {
    const { configuration, workloadAssumptions: workload } = input;
    const resources = configuration.resources;
    const hasVpc = resources.some(
        (resource) => resource.type === 'awsResource' && resource.service === 'vpc',
    );
    const unresolved = unresolvedInputFinding(resources);
    const findings = [
        ...publicBucketFindings(resources),
        ...resources
            .map(administratorPolicyFinding)
            .filter((finding): finding is AnalysisFinding => finding !== null),
        ...cloudFrontFindings(resources),
        ...resources
            .filter((resource): resource is AwsResource => resource.type === 'awsResource')
            .flatMap((resource) => genericResourceFindings(resource, workload, hasVpc)),
        ...resources
            .map((resource) => missingRouteTarget(resource, resources))
            .filter((finding): finding is AnalysisFinding => finding !== null),
        ...addIf(unresolved !== null, unresolved),
        ...relationshipFindings(input),
        ...observabilityFindings(resources),
        ...performanceFindings(resources, workload),
        ...isolatedResourceFindings(input),
    ];
    if (findings.length) return findings;
    return [
        {
            id: 'baseline',
            category: 'reliability',
            severity: 'info',
            title: 'No common configuration issues detected',
            explanation:
                'The modeled rules found no immediate issues in the current architecture. This does not replace a design review or workload test.',
            recommendation:
                'Add more service detail and validate the design against real traffic, failure, and recovery requirements.',
            resourceIds: [],
        },
    ];
}
