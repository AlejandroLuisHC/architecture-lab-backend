import type { LabConfiguration, Resource } from './lab.js';

type Product = { product?: { attributes?: Record<string, string>; productFamily?: string }; sku?: string };
type Dimension = { unit?: string; pricePerUnit?: Record<string, string> };
type OfferFile = {
    publicationDate?: string;
    products?: Record<string, Product>;
    terms?: {
        OnDemand?: Record<
            string,
            Record<string, { effectiveDate?: string; priceDimensions?: Record<string, Dimension> }>
        >;
    };
};
type OfferCache = { loadedAt: number; file: OfferFile };
type Rate = { rate: number; effectiveAt: string | null };
type AwsResource = Extract<Resource, { type: 'awsResource' }>;
type UsageAssumptions = { requestsPerMonth: number; averageDurationMs: number; storageGb: number };
type CatalogEntry = PricingResult['catalog'][number];
type EstimateState = {
    catalog: CatalogEntry[];
    costLines: number[];
    pricedResourceCount: number;
    missingUsageRate: boolean;
    assumed: string[];
    latest: string | null;
};

const offerCache = new Map<string, OfferCache>();
const ONE_HOUR = 60 * 60 * 1000;
const regionName: Record<string, string> = {
    'us-east-1': 'US East (N. Virginia)',
    'us-east-2': 'US East (Ohio)',
    'us-west-1': 'US West (N. California)',
    'us-west-2': 'US West (Oregon)',
    'eu-west-1': 'Europe (Ireland)',
    'eu-west-2': 'Europe (London)',
    'eu-west-3': 'Europe (Paris)',
    'eu-central-1': 'Europe (Frankfurt)',
    'eu-south-1': 'Europe (Milan)',
    'eu-north-1': 'Europe (Stockholm)',
    'ap-southeast-1': 'Asia Pacific (Singapore)',
    'ap-southeast-2': 'Asia Pacific (Sydney)',
    'ap-northeast-1': 'Asia Pacific (Tokyo)',
    'ca-central-1': 'Canada (Central)',
    'sa-east-1': 'South America (Sao Paulo)',
};

async function loadOffer(serviceCode: string, region: string, refresh: boolean): Promise<OfferCache | null> {
    const key = `${serviceCode}:${region}`;
    const previous = offerCache.get(key);
    if (previous && !refresh && Date.now() - previous.loadedAt < ONE_HOUR) return previous;
    const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${encodeURIComponent(serviceCode)}/current/${encodeURIComponent(region)}/index.json`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(18_000) });
        if (!response.ok) return previous ?? null;
        const file = (await response.json()) as OfferFile;
        const next = { loadedAt: Date.now(), file };
        offerCache.set(key, next);
        return next;
    } catch {
        return previous ?? null;
    }
}

function locationMatches(attributes: Record<string, string>, region: string): boolean {
    return attributes.location === regionName[region] || attributes.regionCode === region;
}

function lowestDimensionRate(
    skuTerms: Record<string, { effectiveDate?: string; priceDimensions?: Record<string, Dimension> }>,
    file: OfferFile,
    unitMatches: (unit: string) => boolean,
): Rate | null {
    let lowest: Rate | null = null;
    for (const term of Object.values(skuTerms)) {
        const candidate = lowestRateInTerm(term, file, unitMatches);
        lowest = cheaperRate(lowest, candidate);
    }
    return lowest;
}

function lowestRateInTerm(
    term: { effectiveDate?: string; priceDimensions?: Record<string, Dimension> },
    file: OfferFile,
    unitMatches: (unit: string) => boolean,
): Rate | null {
    let lowest: Rate | null = null;
    for (const dimension of Object.values(term.priceDimensions ?? {})) {
        const candidate = rateForDimension(dimension, term, file, unitMatches);
        lowest = cheaperRate(lowest, candidate);
    }
    return lowest;
}

function rateForDimension(
    dimension: Dimension,
    term: { effectiveDate?: string },
    file: OfferFile,
    unitMatches: (unit: string) => boolean,
): Rate | null {
    const rate = Number(dimension.pricePerUnit?.USD);
    if (!unitMatches(dimension.unit ?? '') || !Number.isFinite(rate) || rate < 0) return null;
    return { rate, effectiveAt: term.effectiveDate ?? file.publicationDate ?? null };
}

function cheaperRate(current: Rate | null, candidate: Rate | null): Rate | null {
    if (!candidate) return current;
    return !current || candidate.rate < current.rate ? candidate : current;
}

function eligibleProduct(product: Product, region: string, matches: (product: Product) => boolean): boolean {
    const attributes = product.product?.attributes ?? {};
    return locationMatches(attributes, region) && matches(product);
}

function lowestRate(
    file: OfferFile,
    region: string,
    matches: (product: Product) => boolean,
    unitMatches: (unit: string) => boolean,
): Rate | null {
    let lowest: Rate | null = null;
    const terms = file.terms?.OnDemand ?? {};
    for (const [sku, product] of Object.entries(file.products ?? {})) {
        if (!eligibleProduct(product, region, matches)) continue;
        const rate = lowestDimensionRate(terms[sku] ?? {}, file, unitMatches);
        lowest = cheaperRate(lowest, rate);
    }
    return lowest;
}

export type PricingResult = {
    currency: string;
    monthlyLow: number | null;
    monthlyHigh: number | null;
    source: string;
    effectiveAt: string | null;
    coverage: string;
    assumptions: string[];
    catalog: { serviceCode: string; region: string; publicationDate: string | null; fetchedAt: string }[];
};

function createEstimateState(assumptions: UsageAssumptions): EstimateState {
    return {
        catalog: [],
        costLines: [],
        pricedResourceCount: 0,
        missingUsageRate: false,
        assumed: [
            `${assumptions.requestsPerMonth.toLocaleString()} requests/month`,
            `${assumptions.averageDurationMs} ms average compute duration`,
            `${assumptions.storageGb} GB stored (storage charges are outside current price coverage)`,
            '730 hours/month; On-Demand public rates; no free tier, discounts, data transfer, taxes, backups, or support included',
        ],
        latest: null,
    };
}

function catalogEntry(serviceCode: string, region: string, offer: OfferCache): CatalogEntry {
    return {
        serviceCode,
        region,
        publicationDate: offer.file.publicationDate ?? null,
        fetchedAt: new Date(offer.loadedAt).toISOString(),
    };
}

function recordRate(state: EstimateState, rate: Rate, amount: number): void {
    state.costLines.push(rate.rate * amount);
    state.latest = [state.latest, rate.effectiveAt].filter(Boolean).sort().at(-1) ?? state.latest;
}

function ec2Resources(configuration: LabConfiguration): AwsResource[] {
    return configuration.resources.filter(
        (resource): resource is AwsResource => resource.type === 'awsResource' && resource.service === 'ec2',
    );
}

function ec2UsageRate(offer: OfferCache, region: string, resource: AwsResource): Rate | null {
    const instanceType = String(resource.settings.instanceType ?? 't3.micro');
    return lowestRate(
        offer.file,
        region,
        (product) => {
            const attributes = product.product?.attributes ?? {};
            return (
                attributes.instanceType === instanceType &&
                (attributes.operatingSystem === 'Linux' || attributes.operatingSystem === 'Linux/UNIX') &&
                attributes.tenancy === 'Shared' &&
                (attributes.preInstalledSw === 'NA' || attributes.preInstalledSw === undefined) &&
                (attributes.capacitystatus === 'Used' || attributes.capacitystatus === undefined)
            );
        },
        (unit) => unit === 'Hrs',
    );
}

function priceEc2Resources(
    state: EstimateState,
    resources: AwsResource[],
    offer: OfferCache,
    region: string,
): void {
    for (const resource of resources) {
        const rate = ec2UsageRate(offer, region, resource);
        if (!rate) continue;
        recordRate(state, rate, 730 * Math.max(1, Number(resource.settings.instanceCount ?? 1)));
        state.pricedResourceCount += 1;
    }
}

function lambdaResources(configuration: LabConfiguration): Resource[] {
    return configuration.resources.filter(
        (resource) =>
            resource.type === 'lambdaFunction' ||
            (resource.type === 'awsResource' && resource.service === 'lambda'),
    );
}

function lambdaGroupMatcher(part: string): (product: Product) => boolean {
    return (product) => {
        const attributes = product.product?.attributes ?? {};
        const architecture = (
            attributes.processorArchitecture ??
            attributes.architecture ??
            ''
        ).toLowerCase();
        const group =
            `${attributes.group ?? ''} ${attributes.usagetype ?? ''} ${attributes.operation ?? ''}`.toLowerCase();
        return (!architecture || architecture.includes('x86')) && group.includes(part);
    };
}

function lambdaMemory(resource: Resource): number | null {
    if (resource.type === 'lambdaFunction') return resource.memoryMiB ?? 512;
    if (resource.type !== 'awsResource') return null;
    const memory = resource.settings.memorySize ?? resource.settings.memoryMiB ?? 512;
    return typeof memory === 'number' ? memory : null;
}

type LambdaResourcePrice = {
    state: EstimateState;
    resource: Resource;
    requestRate: Rate | null;
    durationRate: Rate | null;
    assumptions: UsageAssumptions;
};

function priceLambdaResource(options: LambdaResourcePrice): void {
    const { state, resource, requestRate, durationRate, assumptions } = options;
    let priced = false;
    if (requestRate) {
        recordRate(state, requestRate, assumptions.requestsPerMonth);
        priced = true;
    }
    const memory = lambdaMemory(resource);
    if (durationRate && memory !== null) {
        const gbSeconds =
            (assumptions.requestsPerMonth * assumptions.averageDurationMs * memory) / 1_000 / 1_024;
        recordRate(state, durationRate, gbSeconds);
        priced = true;
    } else if (durationRate) {
        state.missingUsageRate = true;
    }
    if (priced) state.pricedResourceCount += 1;
}

function priceLambdaResources(options: {
    state: EstimateState;
    resources: Resource[];
    offer: OfferCache;
    region: string;
    assumptions: UsageAssumptions;
}): void {
    const { state, resources, offer, region, assumptions } = options;
    const requestRate = lowestRate(offer.file, region, lambdaGroupMatcher('request'), (unit) =>
        /request/i.test(unit),
    );
    const durationRate = lowestRate(offer.file, region, lambdaGroupMatcher('duration'), (unit) =>
        /gb.?second/i.test(unit),
    );
    if (!requestRate || !durationRate) state.missingUsageRate = true;
    for (const resource of resources) {
        priceLambdaResource({ state, resource, requestRate, durationRate, assumptions });
    }
    if ((requestRate || durationRate) && resources.length) {
        state.assumed.push(
            'Each modeled Lambda function receives the full request volume and uses the configured memory size (512 MiB if unspecified); actual routing and function memory may differ.',
        );
    }
}

function coverageSummary(configuration: LabConfiguration, state: EstimateState): PricingResult {
    const covered = state.pricedResourceCount;
    const pricedServices = ['ec2', 'lambda'];
    const supported = configuration.resources.filter(
        (resource) =>
            (resource.type === 'awsResource' && pricedServices.includes(resource.service)) ||
            resource.type === 'lambdaFunction',
    );
    const unsupported = configuration.resources.length - supported.length;
    const partial = unsupported > 0 || supported.length > covered || state.missingUsageRate;
    const total = state.costLines.reduce((sum, value) => sum + value, 0);
    const coverage = covered
        ? `${covered} modeled compute resource${covered === 1 ? '' : 's'} priced${partial ? '; some resources, usage dimensions, and service charges are not included' : ''}`
        : 'Current rate coverage is unavailable for this architecture or region; no price was inferred.';
    return {
        currency: 'USD',
        monthlyLow: covered ? Number(total.toFixed(2)) : null,
        monthlyHigh: covered && !partial ? Number(total.toFixed(2)) : null,
        source: 'AWS Price List Bulk API · On-Demand public rates',
        effectiveAt: state.latest,
        coverage,
        assumptions: state.assumed,
        catalog: state.catalog,
    };
}

export async function estimateMonthlyCost(
    configuration: LabConfiguration,
    region: string,
    assumptions: UsageAssumptions,
    refresh = false,
): Promise<PricingResult> {
    const state = createEstimateState(assumptions);
    const compute = ec2Resources(configuration);
    if (compute.length) {
        const offer = await loadOffer('AmazonEC2', region, refresh);
        if (offer) {
            state.catalog.push(catalogEntry('AmazonEC2', region, offer));
            priceEc2Resources(state, compute, offer, region);
        }
    }
    const functions = lambdaResources(configuration);
    if (functions.length) {
        const offer = await loadOffer('AWSLambda', region, refresh);
        if (offer) {
            state.catalog.push(catalogEntry('AWSLambda', region, offer));
            priceLambdaResources({ state, resources: functions, offer, region, assumptions });
        }
    }
    return coverageSummary(configuration, state);
}
